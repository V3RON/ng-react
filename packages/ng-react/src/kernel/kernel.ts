// The kernel: registration (task 3.1), activation (task 3.2), and
// deactivation plus the failure policy (task 3.3).
//
// `createKernel(options)` performs spec §6's registration pass
// synchronously — validate refs (M3, ADR-2), build the graph (`graph.ts`),
// validate it (G2), topologically sort it (G1), mark every module
// `registered` (A2) — and then schedules §6 step 2, activating every
// `eager` module in topological order. `lazy` modules wait for a trigger:
// `kernel.activate(ref)`, or another activating module listing the ref in
// `dependsOn`. The kernel has no other notion of an activation trigger, and
// per spec §6 must not grow one — route-, deep-link- and
// notification-driven activation are subsystem modules translating their
// own triggers into `kernel.activate(ref)`.
//
// **D1 is the property this file exists to protect.** Registration must be
// cheap and must evaluate nothing implementation-side: no `providers`,
// `init` or `dispose` thunk is called during the registration pass, and
// none may be — that is acceptance criterion 9, pinned by `kernel.test.ts`.
// A `lazy` module's thunks stay untouched until something triggers it.
//
// Teardown is A4's cascade (`deactivate`) driving one per-module sequence
// (`disposeModule` → `teardown`), which F3's quarantine shares. The delivery
// rules for F4's `ErrorSinkToken` live in `failure.ts`; this file decides
// *what* is reported and *who it is attributed to* (C9), which is the half
// no sink may be trusted with.
//
// ADR-6: no `react` import, here or anywhere else under `src/` outside
// `src/react/`.

import { Container } from '../container/container';
import type { ModuleDescriptor } from '../define-module';
import {
  ActivationTimeoutError,
  DependencyActivationError,
  DuplicateModuleIdError,
  InvalidDescriptorError,
  ModuleActivationError,
  ModuleDisposeTimeoutError,
} from '../errors';
import type { ModuleRef } from '../module-ref';
import type { AnyProviderRecord } from '../provider';
import type { Token } from '../token';
import type { ErrorPhase, LoadStrategy, ModuleStatus, Scope, Unsubscribe } from '../types';
import { ModuleContextImpl } from './context';
import { ErrorRouter, ErrorSinkToken, raiseFatal } from './failure';
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
  /** Dev-mode behaviour (F2's console diagnostics). Defaults to `process.env.NODE_ENV !== 'production'`. */
  readonly dev?: boolean;
  /**
   * **F2**: called when a `critical` module fails during the startup
   * activation pass. With no handler the failure is rethrown from a fresh
   * macrotask so the host's global error reporting surfaces it (a red
   * screen in dev — building that screen is the host's job, not the
   * kernel's). See `raiseFatal` in `failure.ts`.
   *
   * This is deliberately **not** an error-reporting hook: every other
   * error the kernel handles goes to the `ErrorSinkToken` collection (F4),
   * and so does this one, *in addition*. `onFatal` answers a different
   * question — "startup cannot continue, what should the host do?" — which
   * no contributed sink can answer, because the app it belongs to is the
   * one that failed to come up.
   */
  readonly onFatal?: (error: unknown) => void;
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
  /**
   * §6/A1/A2: activates `ref`, first activating its not-yet-active
   * `dependsOn` transitively in topological order. Idempotent and
   * single-flight — concurrent calls await one activation.
   */
  activate(ref: ModuleRef): Promise<void>;
  /**
   * A3 hook point: resolves once every **eager, critical** module is
   * `ready`, and rejects with the first such module's failure if one cannot
   * become ready (F2).
   *
   * Spec §6/A3 specifies the hook and defers its *use* — gating
   * splash-screen dismissal — to a startup orchestration service in spec
   * 05. The kernel therefore exposes the promise and nothing else: no
   * splash logic, no timeout of its own, no eager non-critical modules in
   * the condition (those must never hold the splash screen up).
   */
  whenStartupComplete(): Promise<void>;
  /**
   * **A4**: disposes `ref`'s module **and every active module that
   * transitively depends on it, in reverse topological order, before
   * disposing the module itself** — dependents die first, the target dies
   * last.
   *
   * A no-op for a module that is not `ready`. Single-flight like
   * activation: concurrent calls for the same module await one cascade. A
   * disposed module can be activated again and gets a fresh context and
   * fresh module-scoped instances.
   *
   * The kernel deliberately has no notion of *why* a module is being
   * deactivated. Spec §6 A4 names feature-flag kills, logout flows, tests
   * and HMR; every one of those is a subsystem or a host translating its
   * own trigger into this call, exactly as with `activate`.
   */
  deactivate(ref: ModuleRef): Promise<void>;
  /**
   * **F3**: re-attempts activation of a quarantined (`failed`) module from
   * a clean slate — fresh context, fresh registration, fresh
   * module-scoped instances.
   *
   * Per module, not a cascade: a dependent that failed because *this*
   * module was quarantined stays `failed`, and is retried by its own
   * `retry(ref)` once this one succeeds. Retrying the dependent first
   * simply fails again with the same cause chain, which is the honest
   * answer while the dependency is still broken.
   */
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
  /**
   * A2 single-flight: the in-flight activation promise per module id.
   *
   * The entry is written **synchronously** by `activateById`, in the same
   * statement that starts the activation — see the comment there. An
   * `await` between starting an activation and recording it is the classic
   * way to fake single-flight: it passes every sequential test and lets two
   * concurrent triggers each run the provider thunk once.
   */
  private readonly activations = new Map<string, Promise<void>>();
  /** The live `ModuleContext` per activated module, retained for L3/L4 teardown. */
  private readonly contexts = new Map<string, ModuleContextImpl>();
  /**
   * A4 single-flight: the in-flight *deactivation* cascade per module id,
   * kept separate from `activations` for the same reason the two APIs are
   * separate — a caller awaiting `deactivate` must not be handed an
   * activation's promise, and vice versa.
   */
  private readonly deactivations = new Map<string, Promise<void>>();
  /** **F4**: the one route from a kernel-handled error to the error sinks. */
  private readonly errorRouter: ErrorRouter;
  /** F2: see `KernelOptions.onFatal`. */
  private readonly onFatal: ((error: unknown) => void) | undefined;
  /** A3 hook point — see `Kernel.whenStartupComplete`. */
  private readonly startupComplete: Promise<void>;
  private readonly resolveStartup: () => void;
  private readonly rejectStartup: (error: unknown) => void;
  /** The eager, critical module ids `whenStartupComplete` is still waiting on. */
  private readonly pendingCriticalStartup = new Set<string>();

  constructor(options: KernelOptions) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.modules)) {
      throw new InvalidDescriptorError('createKernel() requires an options object with a modules array.');
    }
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.dev = options.dev ?? DEV_BY_DEFAULT;
    this.onFatal = options.onFatal;
    // F4: constructed before the container, because the container's own
    // error reporting is wired straight into it below. Both callbacks read
    // `this` lazily, so neither depends on construction order.
    this.errorRouter = new ErrorRouter({
      resolveSinks: (accept) => this.container.getAllWhere(ErrorSinkToken, accept),
      // F4: a sink contributed by a quarantined or disposed module is
      // skipped — and `getAllWhere` applies this *before* constructing it.
      isModuleLive: (moduleId) => this.statuses.get(moduleId) === 'ready',
    });

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
      // **F4**: the container's disposal errors (including ADR-1's
      // `DisposeTimeoutError`) and its C5 notification errors now reach the
      // error sinks. This callback was a no-op from task 2.2 until now, so
      // every one of those errors was silently dropped.
      //
      // ADR-2: the container omits `moduleId` when no single module owns
      // the error; `'app'` is the reserved id for exactly that case.
      onError: (error, info) => {
        this.report(error, info.moduleId ?? APP_REQUESTER, info.phase);
      },
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

    // A3 hook point. Captured out of the executor, which runs synchronously.
    let resolveStartup!: () => void;
    let rejectStartup!: (error: unknown) => void;
    this.startupComplete = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    this.resolveStartup = resolveStartup;
    this.rejectStartup = rejectStartup;
    // Nobody is obliged to call `whenStartupComplete()`, and an unobserved
    // rejection must not take the process down. The real promise is still
    // handed out unchanged; this only marks it handled.
    void this.startupComplete.catch(() => {});
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.load === 'eager' && descriptor.critical) {
        this.pendingCriticalStartup.add(descriptor.id.id);
      }
    }
    if (this.pendingCriticalStartup.size === 0) {
      resolveStartup();
    }

    // §6 step 2 — activate every eager module, in topological order.
    //
    // Scheduled on a microtask rather than started here, for one reason:
    // **A2's status transitions have to be observable.** `createKernel`
    // returns before this runs, so the composition root gets a synchronous
    // window in which every module is still `registered` and
    // `subscribeStatus` can be attached — a subscriber then sees the full
    // `registered → activating → ready` sequence for eager modules instead
    // of joining after the first transition already happened.
    //
    // It also keeps the registration pass exactly what §6 step 1 says it
    // is: `createKernel` returns having evaluated no implementation code at
    // all, eager modules included (D1).
    const startupPass = Promise.resolve().then(() => this.activateEagerModules());
    void startupPass.catch(() => {});
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

  /**
   * §6/A1/A2: activates `ref`.
   *
   * Rejects rather than throwing synchronously for an unregistered ref, so
   * that every failure mode of this method is observable in one place — a
   * caller doing `kernel.activate(ref).catch(report)` should not also need
   * a `try`.
   */
  activate(ref: ModuleRef): Promise<void> {
    let moduleId: string;
    try {
      moduleId = this.requireRegistered(ref, 'activate');
    } catch (error) {
      return Promise.reject(error);
    }
    return this.activateById(moduleId);
  }

  /** A3 hook point — see the `Kernel` interface. */
  whenStartupComplete(): Promise<void> {
    return this.startupComplete;
  }

  /**
   * L3 + L4: tears one module down, in the order spec §8 L3 and §6 A4
   * require.
   *
   * Public on this internal class but **not** on the `Kernel` interface:
   * `kernel.deactivate(ref)` is the public door and it owes callers A4's
   * *cascade* (every active dependent first, in reverse topological order).
   * This is the per-module half the cascade calls once per module, and it
   * is the only implementation of that sequence — `quarantine` (F3) and
   * H2's HMR re-activation go through `teardown` below rather than
   * repeating it.
   *
   * The order below is load-bearing, and step 3 before step 4 especially:
   * `Container.disposeModuleScope` and `Container.withdraw` are separate
   * primitives and **neither calls the other** (a deliberate call in task
   * 2.2 — the container does not decide lifecycle ordering; the kernel
   * does).
   *
   * **Why that order, precisely.** Not because withdrawing first leaks the
   * instances: it does not, and the earlier claim that it did (issue #16's
   * first sequencing note) was disproved on the merged container in #32.
   * `Resolver` keys its module-scoped cache by owner and each cached entry
   * carries its own `record`, so `disposeModuleScope` never consults the
   * registry and an earlier `withdraw` cannot starve it. The real reason is
   * **C5's visible-state rule**: `withdraw` notifies contribution
   * subscribers, and withdrawing first notifies them while this module's
   * instances are still live — a subscriber would observe a collection that
   * has already dropped the module whose objects are still running. Dispose
   * first and the notification tells the truth.
   *
   *  1. `ctx` cleanups, in reverse registration order (L3)
   *  2. the optional `dispose(ctx)` handler, awaited under ADR-1's timeout
   *  3. `container.disposeModuleScope` — module-scoped instances (C7)
   *  4. `container.withdraw` — providers and contributions, which notifies
   *     the reactive collections (C5)
   *  5. the `ctx` is marked dead (L4)
   *  6. status → `disposed`
   *
   * A no-op for a module that has nothing to tear down (`registered`, or
   * already `disposed`).
   */
  async disposeModule(moduleId: string): Promise<void> {
    const status = this.statuses.get(moduleId);
    if (!this.descriptors.has(moduleId) || status === undefined || status === 'registered' || status === 'disposed') {
      return;
    }
    await this.teardown(moduleId, { callDisposeHandler: true });
    this.failures.delete(moduleId);
    this.setStatus(moduleId, 'disposed');
  }

  /**
   * Steps 1-5 of `disposeModule`'s sequence, shared with F3's quarantine.
   *
   * Split out so that "how a module is torn down" has exactly one
   * implementation (principle 5) while the two callers keep the two things
   * they legitimately disagree about: the final status (`disposed` vs
   * `failed`, which quarantine has already set and must keep, along with
   * its retained error, F1), and whether the descriptor's `dispose(ctx)`
   * handler runs at all.
   *
   * **Quarantine does not call `dispose(ctx)`**: it tears down a module
   * whose `init` never completed, and a hand-written `dispose` mirrors a
   * *completed* `init` — spec §8 calls writing one an anti-pattern
   * precisely because it duplicates state the ctx already tracks. Running
   * it against a half-built module would hand it exactly the inconsistent
   * state it was never written for. The cleanups `init` did register still
   * run (step 1), which is what actually prevents the leak F3 calls out.
   */
  private async teardown(moduleId: string, options: { readonly callDisposeHandler: boolean }): Promise<void> {
    const descriptor = this.descriptors.get(moduleId);
    const ctx = this.contexts.get(moduleId);

    // 1 — L3: reverse registration order; a throwing cleanup is reported
    // and does not abort the rest. **F3**: this is the step that runs the
    // effects a module registered before its `init` threw.
    ctx?.runCleanups();

    // 2 — the optional hand-written handler, which §8 calls an anti-pattern
    // but does not forbid. It runs *after* the cleanups and while the ctx is
    // still alive, because it is the one caller legitimately holding it.
    if (options.callDisposeHandler && descriptor?.dispose !== undefined && ctx !== undefined) {
      await this.runDisposeHandler(moduleId, descriptor.dispose, ctx);
    }

    // 3 before 4 — see `disposeModule`'s doc comment.
    await this.container.disposeModuleScope(moduleId);
    this.container.withdraw(moduleId);

    // 5. `withdraw` is what makes re-activation possible at all: the
    // registry rejects a second `register()` for a still-registered module
    // id (`DuplicateRegistrationError`), so a teardown that skipped it
    // would turn every `retry`/re-`activate` into a registration failure.
    ctx?.markDead();
    this.contexts.delete(moduleId);
    this.activations.delete(moduleId);
  }

  /**
   * **A4**: disposes `ref`'s module and every active module that
   * transitively depends on it, in reverse topological order, before
   * disposing the module itself.
   *
   * See the `Kernel` interface for the contract. Rejects rather than
   * throwing synchronously for an unregistered ref, matching `activate`.
   */
  deactivate(ref: ModuleRef): Promise<void> {
    let moduleId: string;
    try {
      moduleId = this.requireRegistered(ref, 'deactivate');
    } catch (error) {
      return Promise.reject(error);
    }
    const inFlight = this.deactivations.get(moduleId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const cascade = this.runDeactivation(moduleId);
    this.deactivations.set(moduleId, cascade);
    return cascade;
  }

  /**
   * A4's cascade. Two decisions worth stating:
   *
   * **Which modules.** `[moduleId, ...dependentsOf(moduleId, transitive)]`
   * is already in topological order — every dependent sits after the
   * module it depends on, by definition — so reversing it *is* reverse
   * topological order, and the target lands last. Only `ready` modules take
   * part: a `registered` one has nothing to tear down, and a `failed` one
   * has already been torn down by quarantine (F3) and must keep its
   * retained error rather than being quietly relabelled `disposed`.
   *
   * **Sequential, never `Promise.all`.** A4 specifies an *order*, and a
   * dependent must be gone before the module it depends on begins
   * disposing — otherwise its `dispose(ctx)` can resolve a service whose
   * provider has already been withdrawn.
   */
  private async runDeactivation(moduleId: string): Promise<void> {
    try {
      // A2/A4: never tear down a module mid-activation — that would race
      // `init` against its own cleanups. The failure of an in-flight
      // activation is not this caller's to observe (the activation's own
      // awaiters get it, F1), so it is swallowed here.
      await this.activations.get(moduleId)?.catch(() => {});
      // Only the target's activation is awaited, not every dependent's. A
      // dependent that is still `activating` is not `ready`, so it is not
      // part of the cascade; if it completes afterwards it will simply fail
      // to resolve the withdrawn providers and quarantine itself (F3),
      // which is the correct outcome and needs no special case here.
      if (this.statuses.get(moduleId) !== 'ready') {
        // A4: deactivating an inactive module is a no-op.
        return;
      }
      const cascade = [moduleId, ...this.graph.dependentsOf(moduleId, { transitive: true })]
        .filter((id) => this.statuses.get(id) === 'ready')
        .reverse();
      for (const id of cascade) {
        await this.disposeModule(id);
      }
    } finally {
      this.deactivations.delete(moduleId);
    }
  }

  /**
   * **F3**: re-attempts activation of a quarantined module from a clean
   * slate. See the `Kernel` interface for the contract.
   *
   * "Clean slate" is already true by the time this runs: quarantine tore
   * the module down when it failed, so there is no stale context, no
   * lingering registration and no module-scoped instance to clear here.
   * Dropping the retained failure and the `failed` status is the whole
   * difference between this and `activate`, which deliberately refuses to
   * re-attempt (a dependent must not silently re-run a broken module's
   * `init` on every resolution attempt).
   */
  retry(ref: ModuleRef): Promise<void> {
    let moduleId: string;
    try {
      moduleId = this.requireRegistered(ref, 'retry');
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.statuses.get(moduleId) === 'failed') {
      this.failures.delete(moduleId);
      this.setStatus(moduleId, 'registered');
    }
    return this.activateById(moduleId);
  }

  /**
   * **F3**: quarantines a module whose activation failed.
   *
   * Its providers and contributions are withdrawn — so the reactive
   * collections (C5) notify and a subsystem module drops the failed
   * module's contributions automatically — its module-scoped instances are
   * disposed, the cleanups its partial `init` registered are run, and its
   * context is killed (L4). The module keeps `failed` and keeps its
   * retained error (F1); `retry` is the only way back.
   *
   * Never throws: it runs from `runActivation`'s `catch`, where a throw
   * would replace the module's real failure with a teardown detail.
   */
  private async quarantine(moduleId: string): Promise<void> {
    try {
      await this.teardown(moduleId, { callDisposeHandler: false });
    } catch (error) {
      this.report(error, moduleId, 'dispose');
    }
  }

  /**
   * §6 step 2: activates every `eager` module in topological order.
   *
   * Sequential, so the order is exactly `topologicalOrder()` and not
   * whatever the scheduler makes of N concurrent activations. An eager
   * module may already be `ready` by the time the loop reaches it — an
   * earlier eager module listing it in `dependsOn` activates it first (A1),
   * which is also how a `lazy` module gets activated at startup.
   *
   * A **non-critical** eager failure does not stop the pass: F3 quarantines
   * that module and the rest of the app comes up without it. A **critical**
   * one does stop it and rejects `whenStartupComplete()` — F2's "startup
   * fails visibly". The visible part (dev red screen, prod fatal handler) is
   * task 3.3's; this is the signal it hangs off.
   */
  private async activateEagerModules(): Promise<void> {
    for (const moduleId of this.graph.topologicalOrder()) {
      const descriptor = this.descriptors.get(moduleId);
      if (descriptor === undefined || descriptor.load !== 'eager') {
        continue;
      }
      try {
        await this.activateById(moduleId);
        this.markCriticalStartupReady(moduleId);
      } catch (error) {
        if (descriptor.critical) {
          // **F2**: startup fails visibly. Both halves fire — the promise
          // rejects for a host that awaited it, and `onFatal` (or its
          // rethrowing default) fires for the host that did not. The
          // remaining eager modules are not activated: startup is over.
          this.rejectStartup(error);
          raiseFatal(error, { dev: this.dev, ...(this.onFatal === undefined ? {} : { onFatal: this.onFatal }) });
          return;
        }
        // **F3**: this module is already quarantined by `runActivation`;
        // the rest of the app comes up without it.
      }
    }
    // Reached only when no critical eager module failed; a redundant
    // resolve when `markCriticalStartupReady` already fired, and the one
    // that matters when there were no eager critical modules at all.
    this.resolveStartup();
  }

  /** A3 hook point: drops `moduleId` from the startup gate, resolving it when empty. */
  private markCriticalStartupReady(moduleId: string): void {
    if (this.pendingCriticalStartup.delete(moduleId) && this.pendingCriticalStartup.size === 0) {
      this.resolveStartup();
    }
  }

  /**
   * **A2**: the single-flight entry point every activation goes through —
   * `activate(ref)`, the eager startup pass, and A1's dependency recursion
   * alike, so there is exactly one place that can start a module.
   *
   * The four cases, in order:
   *
   *  - `ready` → resolves immediately. Activation is idempotent.
   *  - an in-flight activation → returns **that** promise. Concurrent
   *    triggers await one activation and see one result.
   *  - `failed` → rejects with the retained failure (F1) without
   *    re-attempting. Re-attempting is `kernel.retry(ref)` (F3, task 3.3);
   *    making `activate` silently retry as well would be two ways to do one
   *    thing, and would hide a quarantined module from the caller that
   *    depends on it.
   *  - anything else → starts one.
   *
   * The start is deliberately written as two statements with **no `await`
   * between them**: `runActivation` is called, and the promise it returns
   * is recorded before control can leave this method. `runActivation`'s own
   * body does run synchronously up to its first `await` — during which it
   * may recurse into this method for a *dependency* — but never for
   * `moduleId` itself, because G1 has already proved the graph acyclic.
   */
  private activateById(moduleId: string): Promise<void> {
    const status = this.statuses.get(moduleId);
    if (status === 'ready') {
      return Promise.resolve();
    }
    const inFlight = this.activations.get(moduleId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    if (status === 'failed') {
      return Promise.reject(this.failures.get(moduleId) ?? new ModuleActivationError(moduleId, 'init', 'unknown failure'));
    }
    const activation = this.runActivation(moduleId);
    this.activations.set(moduleId, activation);
    return activation;
  }

  /**
   * One activation, in spec §6's order: dependencies (A1), then the
   * provider thunk and `init` under one timeout (A3), then `ready`.
   *
   * On any failure the module transitions to `failed` with the error
   * retained (F1) and the error is rethrown to every awaiting trigger.
   */
  private async runActivation(moduleId: string): Promise<void> {
    const descriptor = this.descriptors.get(moduleId);
    if (descriptor === undefined) {
      this.activations.delete(moduleId);
      throw new InvalidDescriptorError(
        `kernel.activate(): module '${moduleId}' is not registered with this kernel. ` +
          `Add its descriptor to the composition root.`,
        moduleId,
      );
    }
    this.setStatus(moduleId, 'activating');
    try {
      await this.activateDependencies(moduleId);
      const ctx = new ModuleContextImpl({
        moduleId,
        container: this.container,
        // **L3/F4**: a `ctx.effect` cleanup that throws is reported to the
        // error sinks, attributed to this module in the `cleanup` phase.
        // This callback was a no-op from task 3.2 until now.
        onError: (error) => {
          this.report(error, moduleId, 'cleanup');
        },
      });
      this.contexts.set(moduleId, ctx);
      await this.withActivationTimeout(moduleId, () => this.evaluateModule(moduleId, descriptor, ctx));
      this.setStatus(moduleId, 'ready');
      // F4: this module may be the one that contributes the error sinks.
      // Anything buffered while no sink existed goes out now, in order.
      this.errorRouter.flush();
    } catch (error) {
      // F1: the failure is retained and surfaced by `inspect()`.
      this.failures.set(moduleId, error);
      this.setStatus(moduleId, 'failed');
      // F3: quarantine, *before* the error is reported or rethrown. The
      // status is already `failed`, so the sinks this module contributed
      // are skipped by the report below — which is the point: a module that
      // just failed to activate does not get to handle the report about
      // itself.
      await this.quarantine(moduleId);
      this.report(error, moduleId, 'activate');
      throw error;
    } finally {
      this.activations.delete(moduleId);
    }
  }

  /**
   * **A1**: activates every not-yet-active `dependsOn` before the module
   * itself, transitively and in topological order.
   *
   * Direct dependencies come back from the graph in topological order and
   * are awaited one at a time; the recursion through `activateById` makes
   * that transitive. Sequential rather than `Promise.all` on purpose — A1
   * specifies an *order*, and concurrency would only make it the
   * scheduler's business which of two independent dependencies lands first.
   *
   * The consequence A1 actually cares about: by the time this returns,
   * every dependency is `ready`, so a module can never observe a dependency
   * that is registered but not ready — not from `init`, and not through the
   * container, whose registry does not hold a non-activated module's
   * providers at all.
   *
   * **F3**: a dependency that fails becomes a `DependencyActivationError`
   * naming it, with its own error as the `cause`.
   */
  private async activateDependencies(moduleId: string): Promise<void> {
    for (const dependencyId of this.graph.dependenciesOf(moduleId)) {
      try {
        await this.activateById(dependencyId);
      } catch (cause) {
        throw new DependencyActivationError(moduleId, dependencyId, cause);
      }
    }
  }

  /**
   * The evaluation phase: the `providers` thunk, then `init(ctx)`.
   *
   * ADR-7: both may be synchronous or return a promise, so both are
   * `await`ed unconditionally.
   *
   * **C9**: provenance is assigned here, from the activating descriptor's
   * own id — the module hands over records and never says who it is.
   *
   * Container registration errors (C6 duplicate provider, C5 kind conflict)
   * propagate **unwrapped**. They already name both modules and the token,
   * and `ModuleActivationError` would only push a spec-quoted message one
   * `cause` deeper.
   */
  private async evaluateModule(
    moduleId: string,
    descriptor: ModuleDescriptor,
    ctx: ModuleContextImpl,
  ): Promise<void> {
    if (descriptor.providers !== undefined) {
      let records: readonly AnyProviderRecord[];
      try {
        records = await descriptor.providers();
      } catch (cause) {
        throw new ModuleActivationError(moduleId, 'providers', cause);
      }
      this.container.register(moduleId, records);
    }
    if (descriptor.init !== undefined) {
      try {
        await descriptor.init(ctx);
      } catch (cause) {
        throw new ModuleActivationError(moduleId, 'init', cause);
      }
    }
  }

  /**
   * **A3**: races `run()` against `initTimeoutMs`.
   *
   * The timeout covers the provider thunk *and* `init` — `run()` is the
   * whole evaluation phase — but deliberately **not** dependency
   * activation, which each dependency times out for itself.
   *
   * A timed-out module never comes back to life. If `run()` resolves later,
   * the result is dropped on the floor: the `settled` latch means the
   * `ready` transition after this call is simply never reached, so a
   * `failed` module cannot be resurrected by its own late `init`. A late
   * *rejection* is handed to `onError` instead of becoming an unhandled
   * rejection.
   */
  private withActivationTimeout(moduleId: string, run: () => Promise<void>): Promise<void> {
    const timeoutMs = this.initTimeoutMs;
    const work = run();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new ActivationTimeoutError(moduleId, timeoutMs));
      }, timeoutMs);
      work.then(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          if (settled) {
            // The module is already `failed` by timeout; this is only
            // reported so it does not vanish. Phase `init` rather than
            // `activate`: activation was already decided (and reported)
            // when the timeout fired.
            this.report(error, moduleId, 'init');
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * ADR-1: awaits the descriptor's `dispose(ctx)` with `disposeTimeoutMs`.
   *
   * Neither a throw nor a timeout aborts the teardown (L3): the module is
   * marked `disposed` either way and the error is reported. Deliberately
   * mirrors what the container already does per *instance* — same timeout
   * option, same "report and carry on" rule — so there is one disposal
   * story rather than two.
   */
  private async runDisposeHandler(
    moduleId: string,
    dispose: (ctx: ModuleContextImpl) => void | Promise<void>,
    ctx: ModuleContextImpl,
  ): Promise<void> {
    const timeoutMs = this.disposeTimeoutMs;
    try {
      const result = dispose(ctx);
      if (result === undefined) {
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          this.report(new ModuleDisposeTimeoutError(moduleId, timeoutMs), moduleId, 'dispose');
          resolve();
        }, timeoutMs);
        result.then(
          () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
            }
            this.report(error, moduleId, 'dispose');
            resolve();
          },
        );
      });
    } catch (error) {
      this.report(error, moduleId, 'dispose');
    }
  }

  /**
   * **F4/C9**: the single door every kernel-side error report goes
   * through — `moduleId` is assigned here, from what the kernel was doing,
   * never read off the error or reported by the failing code.
   */
  private report(error: unknown, moduleId: string, phase: ErrorPhase): void {
    this.errorRouter.report(error, { moduleId, phase });
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
