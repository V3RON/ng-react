// The kernel: registration (task 3.1) and activation (task 3.2).
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
// Still stubs, owned by task 3.3: `deactivate` (A4's cascade), `retry`
// (F3), the quarantine half of the failure policy, and F4's `ErrorSinkToken`
// routing. Each has a `task 3.3` seam comment where it plugs in.
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
import type { LoadStrategy, ModuleStatus, Scope, Unsubscribe } from '../types';
import { ModuleContextImpl } from './context';
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
  /**
   * L3: reports a lifecycle error that must not abort the operation that
   * produced it — a `ctx` cleanup that threw, or a module `dispose(ctx)`
   * that threw or timed out (ADR-1).
   *
   * A temporary injection point. F4 makes error reporting a contribution
   * collection (`ErrorSinkToken`) owned by the kernel, and task 3.3 routes
   * these there; wiring it now would give the sinks two feeds, which
   * principle 5 rejects. Defaults to a no-op.
   */
  readonly onError?: (error: unknown) => void;
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
  /** L3 seam: see `KernelOptions.onError`. */
  private readonly onError: (error: unknown) => void;
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
    this.onError = options.onError ?? (() => {});

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
   * *cascade* (every active dependent first, in reverse topological order),
   * which task 3.3 owns. This is the per-module half that the cascade — and
   * F3's quarantine, and H2's HMR re-activation — will each call once per
   * module. Exposing it now keeps that sequence in one place instead of
   * three.
   *
   * The order below is load-bearing, and step 3 before step 4 especially:
   * `Container.disposeModuleScope` and `Container.withdraw` are separate
   * primitives and **neither calls the other** (a deliberate call in task
   * 2.2 — the container does not decide lifecycle ordering; the kernel
   * does). Withdrawing first removes the provider records that describe how
   * to dispose the instances, so every module-scoped instance leaks, with
   * no error and no failing test.
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
    const descriptor = this.descriptors.get(moduleId);
    const status = this.statuses.get(moduleId);
    if (descriptor === undefined || status === undefined || status === 'registered' || status === 'disposed') {
      return;
    }
    const ctx = this.contexts.get(moduleId);

    // 1 — L3: reverse registration order; a throwing cleanup is reported
    // and does not abort the rest.
    ctx?.runCleanups();

    // 2 — the optional hand-written handler, which §8 calls an anti-pattern
    // but does not forbid. It runs *after* the cleanups and while the ctx is
    // still alive, because it is the one caller legitimately holding it.
    if (descriptor.dispose !== undefined && ctx !== undefined) {
      await this.runDisposeHandler(moduleId, descriptor.dispose, ctx);
    }

    // 3 before 4 — see this method's doc comment.
    await this.container.disposeModuleScope(moduleId);
    this.container.withdraw(moduleId);

    // 5 and 6.
    ctx?.markDead();
    this.contexts.delete(moduleId);
    this.activations.delete(moduleId);
    this.failures.delete(moduleId);
    this.setStatus(moduleId, 'disposed');
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
          // F2 seam (task 3.3): fatal-handler / red-screen dispatch goes here.
          this.rejectStartup(error);
          return;
        }
        // F3 seam (task 3.3): quarantine this module and let startup continue.
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
        onError: this.onError,
      });
      this.contexts.set(moduleId, ctx);
      await this.withActivationTimeout(moduleId, () => this.evaluateModule(moduleId, descriptor, ctx));
      this.setStatus(moduleId, 'ready');
    } catch (error) {
      // F1: the failure is retained and surfaced by `inspect()`.
      this.failures.set(moduleId, error);
      this.setStatus(moduleId, 'failed');
      // F3 seam (task 3.3): quarantine — withdraw this module's providers
      // and contributions so the reactive collections drop them — plugs in
      // here, between retaining the failure and rethrowing it.
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
            // reported so it does not vanish.
            this.onError(error);
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
          this.onError(new ModuleDisposeTimeoutError(moduleId, timeoutMs));
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
            this.onError(error);
            resolve();
          },
        );
      });
    } catch (error) {
      this.onError(error);
    }
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
