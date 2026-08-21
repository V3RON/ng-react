// The kernel (task 3.1: the registration half).
//
// `createKernel(options)` performs spec §6's registration pass — and only
// that pass: validate refs (M3, ADR-2), build the graph (`graph.ts`),
// validate it (G2), topologically sort it (G1), and mark every module
// `registered` (A2). Activation, `init`/`dispose`, `ModuleContext` and the
// failure policy belong to tasks 3.2 and 3.3; the methods they own are
// present here as stubs that throw, so the `Kernel` interface does not have
// to change shape underneath consumers when they land.
//
// **D1 is the property this file exists to protect.** Registration must be
// cheap and must evaluate nothing implementation-side: no `providers`,
// `init` or `dispose` thunk is called anywhere below, and none may be —
// that is acceptance criterion 9, pinned by `kernel.test.ts`.
//
// ADR-6: no `react` import, here or anywhere else under `src/` outside
// `src/react/`.

import { Container } from '../container/container';
import type { ModuleDescriptor } from '../define-module';
import { DuplicateModuleIdError, InvalidDescriptorError } from '../errors';
import type { ModuleRef } from '../module-ref';
import type { Token } from '../token';
import type { LoadStrategy, ModuleStatus, Scope, Unsubscribe } from '../types';
import { buildModuleGraph } from './graph';
import type { ModuleGraph } from './graph';

/** A3: default per-module `init` timeout. */
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
/** ADR-1: default awaited-disposal timeout. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
/** ADR-2: the reserved requester id for resolutions started outside any module. */
const APP_REQUESTER = 'app';

/**
 * The default for `KernelOptions.dev`, computed once at import time (so a
 * bundler can constant-fold it and drop dev-only branches) and overridable
 * per kernel. Reads `process.env.NODE_ENV` through `globalThis` rather than
 * referencing `process` directly: the kernel has to run under React Native
 * and in a browser, where the identifier may not exist at all.
 */
const DEV_BY_DEFAULT: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] !== 'production';

/** Options accepted by `createKernel`. */
export interface KernelOptions {
  /** Every module descriptor in the application, from the composition root. */
  readonly modules: readonly ModuleDescriptor[];
  /** A3: per-module `init` timeout in milliseconds. Default `10_000`. */
  readonly initTimeoutMs?: number;
  /** ADR-1: awaited-disposal timeout in milliseconds. Default `2_000`. */
  readonly disposeTimeoutMs?: number;
  /** Dev-mode behaviour (F2 red screen, richer diagnostics). Defaults to `process.env.NODE_ENV !== 'production'`. */
  readonly dev?: boolean;
}

/** One row of `inspect()`'s module table (G3). */
export interface ModuleInspection {
  readonly id: string;
  readonly status: ModuleStatus;
  readonly load: LoadStrategy;
  readonly critical: boolean;
  /** Ids this module depends on, sorted. */
  readonly dependsOn: readonly string[];
  /** F1: the retained failure, when the module is `failed`. Populated by task 3.2. */
  readonly error?: { readonly name: string; readonly message: string; readonly code: string };
}

/** One `dependsOn` edge, from the dependent module to its dependency (G3). */
export interface EdgeInspection {
  readonly from: string;
  readonly to: string;
}

/** One provider or contribution, with kernel-assigned provenance (C9, G3). */
export interface ProviderInspection {
  readonly token: string;
  readonly kind: 'provide' | 'contribute';
  readonly scope: Scope;
  readonly owner: string;
  readonly override: boolean;
}

/** One contribution's position in its C5 collection (G3). */
export interface ContributionInspection {
  readonly token: string;
  readonly owner: string;
  readonly index: number;
}

/**
 * **G3**: the resolved graph as a plain, JSON-serialisable object — the data
 * source for dev tools (spec 06) and for graph snapshot tests.
 *
 * Deterministically ordered throughout: `modules` in topological order,
 * everything else sorted by its own fields. Registering the same set of
 * descriptors in a different order produces a byte-identical
 * `JSON.stringify` of this object.
 *
 * **M1**: this is the one diagnostic surface where modules are named by id
 * string. Every other kernel API takes a `ModuleRef`.
 */
export interface KernelInspection {
  readonly modules: readonly ModuleInspection[];
  readonly edges: readonly EdgeInspection[];
  readonly providers: readonly ProviderInspection[];
  readonly contributions: readonly ContributionInspection[];
}

/**
 * The kernel: registration, activation, status and resolution for one
 * application. Created with `createKernel`.
 */
export interface Kernel {
  /** A2: the current status of `ref`'s module. */
  status(ref: ModuleRef): ModuleStatus;
  /**
   * A2: observes `ref`'s status transitions. Like `subscribeAll` (C5), this
   * does **not** fire on subscribe — see `KernelImpl.subscribeStatus`.
   */
  subscribeStatus(ref: ModuleRef, callback: (status: ModuleStatus) => void): Unsubscribe;
  /** Resolves `token` from outside any module — requester `'app'` (ADR-2). */
  get<T>(token: Token<T>): T;
  /** C5: the full contribution collection for `token`, in module topological order. */
  getAll<T>(token: Token<T>): readonly T[];
  /** G3: the resolved graph as a plain, serialisable object. */
  inspect(): KernelInspection;
  /** §6: activates `ref` and its dependencies. Task 3.2. */
  activate(ref: ModuleRef): Promise<void>;
  /** A4: disposes `ref` and every active module that transitively depends on it. Task 3.3. */
  deactivate(ref: ModuleRef): Promise<void>;
  /** F3: re-attempts activation of a quarantined module. Task 3.3. */
  retry(ref: ModuleRef): Promise<void>;
}

/** One live `subscribeStatus` registration — same shape, and the same reasons, as `collections.ts`'s. */
interface StatusSubscription {
  readonly notify: (status: ModuleStatus) => void;
  active: boolean;
}

/**
 * The one implementation of `Kernel`. Exported from this file but **not**
 * from `index.ts`: `createKernel` is the public constructor, and the class
 * is visible only to the rest of `src/kernel/` (tasks 3.2 and 3.3 fill in
 * the stubs) and to the co-located tests.
 */
export class KernelImpl implements Kernel {
  /**
   * The container the kernel owns and configures. Public on this internal
   * class rather than private because task 3.2's `activate()` registers a
   * module's provider records here, and because the co-located tests drive
   * the three injected container callbacks through it — the kernel is still
   * its only owner, and it is unreachable from `index.ts`.
   */
  readonly container: Container;
  /** A3. Read by task 3.2's activation. */
  readonly initTimeoutMs: number;
  /** ADR-1. Also handed to the container, which owns awaited disposal. */
  readonly disposeTimeoutMs: number;
  /** F2 / diagnostics. Read by tasks 3.2 and 3.3. */
  readonly dev: boolean;

  private readonly graph: ModuleGraph;
  private readonly descriptors = new Map<string, ModuleDescriptor>();
  private readonly statuses = new Map<string, ModuleStatus>();
  private readonly statusSubscriptions = new Map<string, Set<StatusSubscription>>();
  /**
   * F1: the retained failure per module, surfaced by `inspect()`. Always
   * empty in this task — nothing can fail during registration, because a
   * registration failure is fatal and `createKernel` never returns. Task
   * 3.2 writes to it when an activation fails.
   */
  protected readonly failures = new Map<string, unknown>();

  constructor(options: KernelOptions) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.modules)) {
      throw new InvalidDescriptorError('createKernel() requires an options object with a modules array.');
    }
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.dev = options.dev ?? DEV_BY_DEFAULT;

    // §6 step 1 — validate refs (M3, ADR-2).
    const modules = options.modules;
    const sourceById = new Map<string, string>();
    for (const [index, descriptor] of modules.entries()) {
      const source = `modules[${index}]`;
      const id = descriptor.id.id;
      // ADR-2: `moduleRef('app')` already throws, so reaching this means a
      // hand-built ref. Rejected here rather than trusted, because 'app' is
      // the requester id every out-of-module resolution uses (C4) and a
      // module answering to it would silently capture them.
      if (id === APP_REQUESTER) {
        throw new InvalidDescriptorError(
          `createKernel(): ${source} uses the reserved module id 'app'. ` +
            `'app' is reserved for resolutions started outside any module (ADR-2).`,
          id,
        );
      }
      const existing = sourceById.get(id);
      if (existing !== undefined) {
        // M3 — names both descriptors. The composition-root position is the
        // only locator the kernel has: descriptors carry no package name,
        // and both refs are, by definition of this error, indistinguishable
        // by id.
        throw new DuplicateModuleIdError(id, existing, source);
      }
      sourceById.set(id, source);
      this.descriptors.set(id, descriptor);
    }

    // §6 steps 2-4 — build the graph, validate it (G2), sort it (G1).
    this.graph = buildModuleGraph(
      [...this.descriptors.values()].map((descriptor) => ({
        id: descriptor.id.id,
        dependsOn: descriptor.dependsOn.map((ref) => ref.id),
      })),
    );

    // §6 step 5 — every module is `registered` (A2). Set directly rather
    // than through `setStatus`: nobody can hold a subscription yet, since
    // this constructor has not returned.
    for (const id of this.descriptors.keys()) {
      this.statuses.set(id, 'registered');
    }

    this.container = new Container({
      // C5: contribution collections are ordered by the kernel's
      // topological order. Without this the container's documented
      // fallback returns 0 for every module and collections silently
      // degrade to registration order.
      getTopologicalIndex: (moduleId) => this.graph.topologicalIndex(moduleId),
      // C8: the other half of the "registered but not in dependsOn"
      // suggestion. `undefined` for a module the kernel does not know,
      // which the resolver treats as "no suggestion possible".
      getDependsOn: (moduleId) => (this.graph.has(moduleId) ? this.graph.dependenciesOf(moduleId) : undefined),
      disposeTimeoutMs: this.disposeTimeoutMs,
      // `onError` is deliberately left at its default no-op: routing
      // lifecycle errors to `ErrorSinkToken` (F4) is task 3.3's, and
      // inventing a second route now would be a second way to do it.
    });
    // C8: the full universe of module ids the kernel knows. Given G2 this
    // is exactly the registered set — a `dependsOn` id that is not
    // registered is already fatal above — but it is computed as the union
    // anyway so the C8 suggestion cannot quietly narrow if that ever
    // changes.
    const known = new Set<string>(this.descriptors.keys());
    for (const descriptor of this.descriptors.values()) {
      for (const ref of descriptor.dependsOn) {
        known.add(ref.id);
      }
    }
    this.container.setKnownModules([...known].sort());
  }

  /**
   * A2: the current status of `ref`'s module.
   *
   * Looked up by `ref.id`: M3 guarantees at most one registered descriptor
   * per id string, so an id identifies a registered module exactly as
   * precisely as its ref does.
   *
   * @throws {InvalidDescriptorError} for a module this kernel never
   *   registered — an unregistered ref has no status, and returning a
   *   plausible-looking `'registered'` for it would hide the composition
   *   root omission that G2 exists to surface.
   */
  status(ref: ModuleRef): ModuleStatus {
    return this.statuses.get(this.requireRegistered(ref, 'status')) ?? 'registered';
  }

  /**
   * A2: calls `callback` on every status *transition* of `ref`'s module.
   *
   * **Does not fire on subscribe**, matching `Container.subscribeAll` (C5,
   * #13): the caller reads the current value with `status(ref)`. The two
   * subscription APIs the kernel exposes answer this question the same way
   * on purpose — a consumer that has to remember which one replays and
   * which one does not is exactly the "two ways to do the same thing"
   * principle 5 rejects, and the alternative (both replay) makes every
   * `useModule`-style consumer either handle the initial value twice or
   * de-duplicate it.
   *
   * The returned `Unsubscribe` is idempotent, and a subscriber added or
   * removed during a notification pass does not affect the in-flight pass.
   */
  subscribeStatus(ref: ModuleRef, callback: (status: ModuleStatus) => void): Unsubscribe {
    const id = this.requireRegistered(ref, 'subscribeStatus');
    let subscribers = this.statusSubscriptions.get(id);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.statusSubscriptions.set(id, subscribers);
    }
    const subscription: StatusSubscription = { notify: callback, active: true };
    subscribers.add(subscription);

    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      const current = this.statusSubscriptions.get(id);
      if (current === undefined) {
        return;
      }
      current.delete(subscription);
      if (current.size === 0) {
        this.statusSubscriptions.delete(id);
      }
    };
  }

  /** ADR-2: resolutions started outside any module carry the reserved requester `'app'`. */
  get<T>(token: Token<T>): T {
    return this.container.resolve(token, { requester: APP_REQUESTER });
  }

  /**
   * C5: the full contribution collection for `token`.
   *
   * Takes no requester, unlike `get`. Each contribution is resolved on
   * behalf of **its own owner** (C9 provenance), never on behalf of the
   * caller, so that a caller's identity cannot change what `MODULE_ID`
   * resolves to inside someone else's contribution — see the C4 section of
   * `collections.ts`'s header. The task issue's `getAll(token)` "with
   * requester 'app'" is stale on this point; `Container.getAll` and
   * `ModuleContext.getAll` both already have this shape.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.container.getAll(token);
  }

  /** G3: see `KernelInspection`. */
  inspect(): KernelInspection {
    const modules: ModuleInspection[] = [];
    for (const id of this.graph.topologicalOrder()) {
      const descriptor = this.descriptors.get(id);
      if (descriptor === undefined) {
        continue;
      }
      const failure = describeFailure(this.failures.get(id));
      modules.push(
        Object.freeze({
          id,
          status: this.statuses.get(id) ?? 'registered',
          load: descriptor.load,
          critical: descriptor.critical,
          dependsOn: Object.freeze([...this.graph.dependenciesOf(id)]),
          ...(failure === undefined ? {} : { error: failure }),
        }),
      );
    }

    const edges: EdgeInspection[] = [];
    for (const id of [...this.descriptors.keys()].sort()) {
      for (const dependency of this.graph.dependenciesOf(id)) {
        edges.push(Object.freeze({ from: id, to: dependency }));
      }
    }
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    // The registry snapshot is already sorted by (tokenLabel, owner) and
    // carries both kinds; `providers` is that table verbatim, renamed to
    // the issue's field names.
    const snapshot = this.container.inspect();
    const providers: ProviderInspection[] = snapshot.providers.map((row) =>
      Object.freeze({
        token: row.tokenLabel,
        kind: row.kind,
        scope: row.scope,
        owner: row.owner,
        override: row.override,
      }),
    );

    // C5 positions, derived from the same snapshot. `index` is the
    // contribution's position within its token's collection in module
    // topological order. Declaration order *within* one module is not
    // recoverable from the registry snapshot (its rows carry no
    // registration index), so contributions from one module to one token
    // are numbered in snapshot order; making that exact would mean
    // changing `src/container/`, which is out of scope for this task.
    const contributions: ContributionInspection[] = [];
    const byToken = new Map<string, ProviderInspection[]>();
    for (const row of providers) {
      if (row.kind !== 'contribute') {
        continue;
      }
      const rows = byToken.get(row.token) ?? [];
      rows.push(row);
      byToken.set(row.token, rows);
    }
    for (const token of [...byToken.keys()].sort()) {
      const rows = [...(byToken.get(token) ?? [])].sort(
        (a, b) => this.sortIndexOf(a.owner) - this.sortIndexOf(b.owner) || a.owner.localeCompare(b.owner),
      );
      rows.forEach((row, index) => {
        contributions.push(Object.freeze({ token, owner: row.owner, index }));
      });
    }

    return Object.freeze({
      modules: Object.freeze(modules),
      edges: Object.freeze(edges),
      providers: Object.freeze(providers),
      contributions: Object.freeze(contributions),
    });
  }

  /** §6/A1/A2 — task 3.2. */
  activate(ref: ModuleRef): Promise<void> {
    return Promise.reject(notImplemented('activate', ref, '3.2'));
  }

  /** A4 — task 3.3. */
  deactivate(ref: ModuleRef): Promise<void> {
    return Promise.reject(notImplemented('deactivate', ref, '3.3'));
  }

  /** F3 — task 3.3. */
  retry(ref: ModuleRef): Promise<void> {
    return Promise.reject(notImplemented('retry', ref, '3.3'));
  }

  /**
   * A2: records a status transition and notifies subscribers. Private, and
   * unused by registration itself (every module is `registered` before this
   * class can be observed); tasks 3.2/3.3 drive every other transition
   * through it, which is what keeps notification in one place.
   *
   * Notifies only on an actual change, and iterates a **copy** of the
   * subscriber set so that a subscriber added or removed by another
   * subscriber does not affect the in-flight pass; a subscription cancelled
   * mid-pass is additionally skipped via its `active` flag.
   */
  protected setStatus(moduleId: string, status: ModuleStatus): void {
    if (this.statuses.get(moduleId) === status) {
      return;
    }
    this.statuses.set(moduleId, status);
    const subscribers = this.statusSubscriptions.get(moduleId);
    if (subscribers === undefined) {
      return;
    }
    for (const subscription of [...subscribers]) {
      if (subscription.active) {
        subscription.notify(status);
      }
    }
  }

  /**
   * `topologicalIndex` with the same unknown-module fallback
   * `orderContributions` uses — a non-finite index sorts last rather than
   * poisoning the comparator with `NaN`.
   */
  private sortIndexOf(moduleId: string): number {
    const index = this.graph.topologicalIndex(moduleId);
    return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
  }

  /** Resolves `ref` to a registered module id, or throws naming the calling API. */
  private requireRegistered(ref: ModuleRef, api: string): string {
    if (ref === null || typeof ref !== 'object' || typeof ref.id !== 'string') {
      throw new InvalidDescriptorError(`kernel.${api}() requires a ModuleRef created via moduleRef().`);
    }
    if (!this.descriptors.has(ref.id)) {
      throw new InvalidDescriptorError(
        `kernel.${api}(): module '${ref.id}' is not registered with this kernel. ` +
          `Add its descriptor to the composition root.`,
        ref.id,
      );
    }
    return ref.id;
  }
}

/** Builds the placeholder error for a lifecycle method a later task owns. */
function notImplemented(api: string, ref: ModuleRef, task: string): InvalidDescriptorError {
  return new InvalidDescriptorError(
    `kernel.${api}() is not implemented yet (task ${task}); this kernel only performs registration.`,
    typeof ref?.id === 'string' ? ref.id : undefined,
  );
}

/** F1/G3: renders a retained failure for `inspect()`, keeping the result JSON-safe. */
function describeFailure(
  failure: unknown,
): { readonly name: string; readonly message: string; readonly code: string } | undefined {
  if (failure === undefined) {
    return undefined;
  }
  const error = failure as { name?: unknown; message?: unknown; code?: unknown };
  return Object.freeze({
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(failure),
    code: typeof error.code === 'string' ? error.code : 'KERNEL_UNKNOWN',
  });
}

/**
 * Creates a kernel and performs spec §6's registration pass immediately:
 * every validation error (M3, G2, G1) is thrown from this call, before any
 * module has done anything.
 *
 * **D1**: no `providers`, `init` or `dispose` thunk is evaluated here.
 *
 * @throws {DuplicateModuleIdError} M3 — two descriptors sharing an id.
 * @throws {UnknownModuleError} G2 — a `dependsOn` whose descriptor is missing.
 * @throws {DependencyCycleError} G1 — a cycle in `dependsOn`.
 * @throws {InvalidDescriptorError} for malformed options or a reserved id.
 */
export function createKernel(options: KernelOptions): Kernel {
  return new KernelImpl(options);
}
