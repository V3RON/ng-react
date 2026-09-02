import { Container } from '../container/container';
import type { ModuleDescriptor } from '../define-module';
import {
  ActivationTimeoutError,
  DependencyActivationError,
  DuplicateModuleIdError,
  InvalidDescriptorError,
  KernelError,
  ModuleActivationError,
  ModuleDisposeTimeoutError,
} from '../errors';
import { createNoopHmrAdapter } from '../hmr/adapter';
import type { HmrAdapter } from '../hmr/adapter';
import { EpochStore } from '../hmr/epoch';
import { registerModuleDescriptor, registerModuleDescriptors } from '../hmr/hot-module';
import { LeakInvariantCheck } from '../hmr/leak-check';
import { ResolutionGraph } from '../hmr/resolution-graph';
import type { ResolutionEdge } from '../hmr/resolution-graph';
import type { ModuleRef } from '../module-ref';
import type { AnyProviderRecord } from '../provider';
import type { Token } from '../token';
import type { ErrorPhase, LoadStrategy, ModuleStatus, Scope, Unsubscribe } from '../types';
import type { LeakReport } from '../testing/leak-counters';
import { ModuleContextImpl } from './context';
import { ErrorRouter, ErrorSinkToken, raiseFatal } from './failure';
import { buildModuleGraph } from './graph';
import type { ModuleGraph } from './graph';

/** Default per-module `init` timeout, in milliseconds. */
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
/** Default awaited-disposal timeout, in milliseconds. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
/** The reserved requester id for resolutions started outside any module. */
const APP_REQUESTER = 'app';

/**
 * The default for `KernelOptions.dev`, read from `process.env.NODE_ENV`
 * through `globalThis` so the kernel also runs where `process` is undefined.
 */
const DEV_BY_DEFAULT: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] !== 'production';

/** Options accepted by `createKernel`. */
export interface KernelOptions {
  /** Every module descriptor in the application, from the composition root. */
  readonly modules: readonly ModuleDescriptor[];
  /**
   * Time budget for one module's `providers` thunk and `init`, in
   * milliseconds. Dependency activation is not covered: each dependency is
   * timed separately.
   *
   * @default 10_000
   */
  readonly initTimeoutMs?: number;
  /**
   * Time budget for one awaited disposal, in milliseconds.
   *
   * @default 2_000
   */
  readonly disposeTimeoutMs?: number;
  /**
   * Enables dev-mode diagnostics: console reporting of fatal startup
   * failures, the resolution graph in `inspect()`, and the leak invariant.
   *
   * @default process.env.NODE_ENV !== 'production'
   */
  readonly dev?: boolean;
  /**
   * Called when a `critical` module fails during the startup activation
   * pass. Startup stops there: no further eager module is activated and
   * `whenStartupComplete()` rejects.
   *
   * The failure also reaches the contributed error sinks; this handler
   * answers the separate question of what the host should do when the app
   * cannot come up. With no handler the failure is rethrown from a fresh
   * macrotask, so the host's global error reporting surfaces it.
   *
   * A host that renders the rejection itself — through `useKernelStartup()`,
   * `<KernelStartupGate>`, or its own `whenStartupComplete()` handling —
   * should provide a handler, even a no-op. Rendering a failure UI does not
   * disable the default rethrow; without a handler React Native's LogBox or a
   * browser error overlay may cover the UI the host deliberately rendered.
   *
   * @default rethrow from a macrotask
   */
  readonly onFatal?: (error: unknown) => void;
  /**
   * The bundler seam the kernel escalates to when a hot update cannot be
   * applied in place. The kernel never calls a bundler API directly.
   *
   * @default createNoopHmrAdapter()
   */
  readonly hmr?: HmrAdapter;
}

/** One module's row in `KernelInspection`. */
export interface ModuleInspection {
  readonly id: string;
  readonly status: ModuleStatus;
  readonly load: LoadStrategy;
  readonly critical: boolean;
  /** Ids this module depends on, sorted. */
  readonly dependsOn: readonly string[];
  /** The retained failure. Present only while the module is `failed`. */
  readonly error?: { readonly name: string; readonly message: string; readonly code: string };
}

/** One `dependsOn` edge, from the dependent module to its dependency. */
export interface EdgeInspection {
  readonly from: string;
  readonly to: string;
}

/** One registered provider or contribution, with its owning module. */
export interface ProviderInspection {
  readonly token: string;
  readonly kind: 'provide' | 'contribute';
  readonly scope: Scope;
  readonly owner: string;
  readonly override: boolean;
  /**
   * The module whose `override: true` registration superseded this one.
   *
   * Present only on a superseded row, which records what its module
   * registered but is never resolvable. For any one token the effective
   * provider is the row *without* this field.
   */
  readonly overriddenBy?: string;
}

/** One contribution's position within its token's collection. */
export interface ContributionInspection {
  readonly token: string;
  readonly owner: string;
  readonly index: number;
}

/**
 * The resolved graph as a plain, JSON-serialisable object.
 *
 * Deterministically ordered throughout: `modules` in topological order,
 * everything else sorted by its own fields. Registering the same set of
 * descriptors in a different order produces a byte-identical
 * `JSON.stringify` of this object.
 *
 * This is the one kernel surface that names modules by id string; every
 * other API takes a `ModuleRef`.
 */
export interface KernelInspection {
  readonly modules: readonly ModuleInspection[];
  readonly edges: readonly EdgeInspection[];
  readonly providers: readonly ProviderInspection[];
  readonly contributions: readonly ContributionInspection[];
  /**
   * Every `(consumer, owner, token)` the container actually resolved,
   * sorted by those three fields.
   *
   * The key is **omitted entirely** outside dev mode, where nothing is
   * recorded. Distinct from `edges`, which is the *declared* `dependsOn`
   * graph: a module that declares a dependency it never resolves has an
   * `edges` row and no `resolutionGraph` row.
   */
  readonly resolutionGraph?: readonly ResolutionEdge[];
}

/**
 * Registration, activation, status and resolution for one application.
 * Created with `createKernel`.
 */
export interface Kernel {
  /**
   * The current status of `ref`'s module.
   *
   * @throws {InvalidDescriptorError} if `ref` is not a `ModuleRef`, or names
   *   a module this kernel never registered.
   */
  status(ref: ModuleRef): ModuleStatus;
  /**
   * Calls `callback` on every status *transition* of `ref`'s module.
   *
   * Does not fire on subscribe: read the current value with `status(ref)`.
   * The returned `Unsubscribe` is idempotent.
   *
   * @throws {InvalidDescriptorError} if `ref` is not a registered module.
   */
  subscribeStatus(ref: ModuleRef, callback: (status: ModuleStatus) => void): Unsubscribe;
  /**
   * Resolves `token`.
   *
   * @param requester The module on whose behalf the resolution chain runs,
   *   which is what `MODULE_ID` yields inside every factory in it. Defaults
   *   to the reserved id `'app'`, meaning "from outside any module".
   * @throws {ResolutionError} if no module provides `token`.
   * @throws {CircularDependencyError} if resolving `token` re-enters itself.
   * @throws {ProviderFactoryError} if a factory in the chain throws.
   */
  get<T>(token: Token<T>, requester?: string): T;
  /** The full contribution collection for `token`, in module topological order. */
  getAll<T>(token: Token<T>): readonly T[];
  /**
   * Notifies `callback` whenever `token`'s contribution set changes — a
   * module registered contributions, or had them withdrawn by disposal or
   * quarantine.
   *
   * Does not fire on subscribe. The returned `Unsubscribe` is idempotent.
   */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe;
  /**
   * The module that `provide`d `token`, or `undefined` when nothing does.
   *
   * Also `undefined` for a *contribution* token: a collection has many
   * owners, so there is no single answer. Use `subscribeAll` for those.
   */
  ownerOf<T>(token: Token<T>): string | undefined;
  /**
   * The current resolution epoch of `moduleId`, or the total number of
   * bumps across all modules when `moduleId` is omitted.
   */
  epochOf(moduleId?: string): number;
  /**
   * Records that everything resolved on behalf of `moduleId` may be stale,
   * so subscribed components re-render and re-resolve.
   */
  bumpEpoch(moduleId: string): void;
  /**
   * Observes `bumpEpoch`. An omitted `moduleId` observes every module's
   * bumps. Does not fire on subscribe; the `Unsubscribe` is idempotent.
   */
  subscribeEpoch(moduleId: string | undefined, callback: () => void): Unsubscribe;
  /** The resolved graph as a plain, serialisable object. */
  inspect(): KernelInspection;
  /**
   * Activates `ref`, first activating its not-yet-active `dependsOn`
   * transitively in topological order.
   *
   * Idempotent and single-flight: concurrent calls await one activation and
   * see one result. A `failed` module is **not** re-attempted — the call
   * rejects with the retained failure; use `retry` instead.
   *
   * @throws {InvalidDescriptorError} (as a rejection) if `ref` is not a
   *   registered module.
   * @throws {DependencyActivationError} (as a rejection) if a `dependsOn`
   *   module could not be activated, with its failure as the `cause`.
   * @throws {ActivationTimeoutError} (as a rejection) if the module's
   *   `providers` thunk and `init` together exceed `initTimeoutMs`.
   * @throws {ModuleActivationError} (as a rejection) if the `providers`
   *   thunk or `init` throws.
   */
  activate(ref: ModuleRef): Promise<void>;
  /**
   * Resolves once every critical module in the startup activation closure is
   * `ready`, and rejects with the first such module's failure if one cannot
   * become ready. The closure contains every eager module and its transitive
   * dependencies, including dependencies whose own load strategy is `lazy`.
   *
   * Non-critical modules are not part of the condition. If the closure has no
   * critical module, this promise resolves immediately, before eager
   * non-critical activation necessarily finishes.
   */
  whenStartupComplete(): Promise<void>;
  /**
   * Disposes `ref`'s module and every active module that transitively
   * depends on it, in reverse topological order: dependents are disposed
   * first, the target last.
   *
   * A no-op for a module that is not `ready`. Single-flight: concurrent
   * calls for the same module await one cascade. A disposed module can be
   * activated again, and gets a fresh context and fresh module-scoped
   * instances; `persistent: true` store state is **discarded**, unlike a
   * hot update.
   *
   * @throws {InvalidDescriptorError} (as a rejection) if `ref` is not a
   *   registered module.
   */
  deactivate(ref: ModuleRef): Promise<void>;
  /**
   * Applies a hot update to `ref`'s module, replacing its descriptor with
   * `nextDescriptor`.
   *
   * Called from the module's own hot block with the re-evaluated
   * descriptor the bundler hands it. The accept call has to be written
   * literally in the module's own file for Vite's static scan to mark that
   * file self-accepting, and the replacement descriptor has to come from
   * the callback's namespace, because only the re-evaluated copy holds it:
   *
   * @example
   * ```ts
   * // <pkg>/module.ts — `OrdersModule` is this module's own ref
   * if (import.meta.hot) {
   *   import.meta.hot.accept((next) => {
   *     const replacement = next as { module?: ModuleDescriptor } | undefined;
   *     if (replacement?.module === undefined) return;
   *     void kernel.hotReplace(OrdersModule, replacement.module);
   *   });
   * }
   * ```
   *
   * On a `ready` module: the module and its active dependents are disposed
   * in reverse topological order, re-activated in topological order, and
   * each re-activated module's resolution epoch is bumped so mounted
   * components re-resolve. Provider instances are disposed regardless of
   * scope, `singleton` included; `persistent: true` store state is the sole
   * exception and is carried onto the replacement instance.
   *
   * On a `registered`, `disposed` or `failed` module only the registration
   * is refreshed: the descriptor is swapped and the graph re-validated, and
   * nothing is activated. Editing a file is not an activation trigger.
   *
   * If the replacement's `dependsOn` fails graph re-validation the update is
   * rejected whole — the old descriptor stays in force and the module keeps
   * running — the error goes to the error sinks and to `hmr.invalidate`, and
   * this promise still resolves. A bad edit does not crash the HMR cycle.
   *
   * Calls for one module are **serialised**, not single-flighted: two edits
   * in flight are two updates, and the later descriptor is never dropped.
   *
   * @throws {InvalidDescriptorError} (as a rejection) if `ref` is not a
   *   registered module, or if `nextDescriptor` is not a descriptor for that
   *   same module. Replacing a module's identity is never a hot update.
   */
  hotReplace(ref: ModuleRef, nextDescriptor?: ModuleDescriptor): Promise<void>;
  /**
   * Re-attempts activation of a `failed` module from a clean slate: fresh
   * context, fresh registration, fresh module-scoped instances.
   *
   * Per module, not a cascade. A dependent that failed because this module
   * was quarantined stays `failed` until its own `retry` is called, which
   * only succeeds once this one has.
   *
   * @throws {InvalidDescriptorError} (as a rejection) if `ref` is not a
   *   registered module.
   * @throws {ModuleActivationError} (as a rejection) if the retried
   *   activation fails again; the module stays `failed`.
   */
  retry(ref: ModuleRef): Promise<void>;
}

/** Options accepted by `KernelImpl.disposeModule`. */
interface DisposeOptions {
  /**
   * Holds `persistent: true` instances back instead of disposing them, so
   * the replacement instances can adopt their state. Set only by a hot
   * update; a real deactivation discards persistent state.
   */
  readonly preservePersistent?: boolean;
}

/**
 * A validated replacement descriptor waiting to be committed. `graph` is
 * present only when `dependsOn` changed and the graph had to be rebuilt.
 */
interface ValidatedReplacement {
  readonly descriptor: ModuleDescriptor;
  readonly graph?: ModuleGraph;
}

/** One live `subscribeStatus` registration. */
interface StatusSubscription {
  readonly notify: (status: ModuleStatus) => void;
  active: boolean;
}

/**
 * The one implementation of `Kernel`. Internal to `src/kernel/`:
 * `createKernel` is the public constructor.
 */
export class KernelImpl implements Kernel {
  /** The container this kernel owns and configures. */
  readonly container: Container;
  readonly initTimeoutMs: number;
  readonly disposeTimeoutMs: number;
  readonly dev: boolean;

  /**
   * This kernel's resolution epochs. Per-kernel, never module-level, so two
   * kernels in one test file cannot invalidate each other's components.
   */
  private readonly epochStore = new EpochStore();

  /**
   * The dev-only resolution graph, or `undefined` in production.
   *
   * The `undefined` is the production gate: with no graph there is no
   * recorder to hand the resolver, no `resolutionGraph` key in `inspect()`,
   * and `hotCascade` falls back to the declared `dependsOn` cascade.
   */
  private readonly resolutionGraph: ResolutionGraph | undefined;

  /**
   * The post-hot-update leak invariant, or `undefined` when nobody
   * installed leak counters for it to read. See `installLeakCheck`.
   */
  private leakCheck: LeakInvariantCheck | undefined;

  /**
   * Mutable: a `hotReplace` whose replacement changed `dependsOn` rebuilds
   * it, and only ever assigns an already-validated graph. Everything reads
   * `this.graph` at call time, so no collaborator can hold a stale one.
   */
  private graph: ModuleGraph;
  private readonly descriptors = new Map<string, ModuleDescriptor>();
  private readonly statuses = new Map<string, ModuleStatus>();
  private readonly statusSubscriptions = new Map<string, Set<StatusSubscription>>();
  /** The retained failure per module, surfaced by `inspect()`. */
  protected readonly failures = new Map<string, unknown>();
  /**
   * The in-flight activation promise per module id.
   *
   * The entry has to be written **synchronously** with starting the
   * activation. An `await` in between passes every sequential test and lets
   * two concurrent triggers each run the provider thunk once.
   */
  private readonly activations = new Map<string, Promise<void>>();
  /** The live `ModuleContext` per activated module, retained for teardown. */
  private readonly contexts = new Map<string, ModuleContextImpl>();
  /**
   * The in-flight deactivation cascade per module id. Kept separate from
   * `activations` so a caller awaiting `deactivate` is never handed an
   * activation's promise, or vice versa.
   */
  private readonly deactivations = new Map<string, Promise<void>>();
  /**
   * The tail of the serialised `hotReplace` chain per module id.
   *
   * A chain rather than single-flight: two concurrent calls are two
   * different edits, and joining the second onto the first would drop the
   * newer descriptor and leave the app running replaced code.
   */
  private readonly hotReplacements = new Map<string, Promise<void>>();
  /** The bundler seam. Never `undefined` — see `KernelOptions.hmr`. */
  private readonly hmr: HmrAdapter;
  /** The one route from a kernel-handled error to the error sinks. */
  private readonly errorRouter: ErrorRouter;
  private readonly onFatal: ((error: unknown) => void) | undefined;
  private readonly startupComplete: Promise<void>;
  private readonly resolveStartup: () => void;
  private readonly rejectStartup: (error: unknown) => void;
  /** Critical module ids in the startup activation closure that are not ready yet. */
  private readonly pendingCriticalStartup = new Set<string>();

  constructor(options: KernelOptions) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.modules)) {
      throw new InvalidDescriptorError('createKernel() requires an options object with a modules array.');
    }
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.dev = options.dev ?? DEV_BY_DEFAULT;
    this.onFatal = options.onFatal;
    this.hmr = options.hmr ?? createNoopHmrAdapter();
    this.errorRouter = new ErrorRouter({
      resolveSinks: (accept) => this.container.getAllWhere(ErrorSinkToken, accept),
      // A sink contributed by a quarantined or disposed module is skipped,
      // and `getAllWhere` applies this *before* constructing it.
      isModuleLive: (moduleId) => this.statuses.get(moduleId) === 'ready',
    });

    const modules = options.modules;
    const sourceById = new Map<string, string>();
    for (const [index, descriptor] of modules.entries()) {
      const source = `modules[${index}]`;
      const id = descriptor.id.id;
      // 'app' is the requester id every out-of-module resolution uses, so a
      // module answering to it would silently capture them.
      if (id === APP_REQUESTER) {
        throw new InvalidDescriptorError(
          `createKernel(): ${source} uses the reserved module id 'app'. ` +
            `'app' identifies resolutions started outside any module. Choose a different module id.`,
          id,
        );
      }
      const existing = sourceById.get(id);
      if (existing !== undefined) {
        // The composition-root position is the only locator available:
        // descriptors carry no package name, and the two ids are equal.
        throw new DuplicateModuleIdError(id, existing, source);
      }
      sourceById.set(id, source);
      this.descriptors.set(id, descriptor);
    }

    // **The bundler-plugin HMR registry (see `hmr/hot-module.ts`).**
    // Dev-only, and populated by descriptor *identity* — a production
    // build registers nothing, and two kernels registering a module with
    // the same id string still never see each other's descriptors, because
    // the registry is never keyed by that string.
    if (this.dev) {
      registerModuleDescriptors(this, this.descriptors.values());
    }

    this.graph = buildGraphOf(this.descriptors.values());

    // Set directly rather than through `setStatus`: nobody can hold a
    // subscription yet, since this constructor has not returned.
    for (const id of this.descriptors.keys()) {
      this.statuses.set(id, 'registered');
    }

    // Created before the container, which is handed the recorder that
    // writes to it.
    const resolutionGraph = this.dev ? new ResolutionGraph() : undefined;
    this.resolutionGraph = resolutionGraph;

    this.container = new Container({
      // Contribution collections are ordered by the kernel's topological
      // order. Without this the container's fallback returns 0 for every
      // module and collections degrade to registration order.
      getTopologicalIndex: (moduleId) => this.graph.topologicalIndex(moduleId),
      // `undefined` for a module the kernel does not know, which the
      // resolver treats as "no suggestion possible".
      getDependsOn: (moduleId) => (this.graph.has(moduleId) ? this.graph.dependenciesOf(moduleId) : undefined),
      disposeTimeoutMs: this.disposeTimeoutMs,
      // The container omits `moduleId` when no single module owns the
      // error; `'app'` is the reserved id for exactly that case.
      onError: (error, info) => {
        this.report(error, info.moduleId ?? APP_REQUESTER, info.phase);
      },
      // Spread rather than a conditional callback so that in production the
      // option is absent and the resolver never allocates an argument list
      // per resolution.
      ...(resolutionGraph === undefined
        ? {}
        : {
            recordResolution: (consumer: string, owner: string, token: string): void => {
              resolutionGraph.record(consumer, owner, token);
            },
          }),
    });
    this.refreshKnownModules();

    // Captured out of the executor, which runs synchronously.
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
      if (descriptor.load !== 'eager') {
        continue;
      }
      const startupModuleIds = [
        descriptor.id.id,
        ...this.graph.dependenciesOf(descriptor.id.id, { transitive: true }),
      ];
      for (const moduleId of startupModuleIds) {
        if (this.descriptors.get(moduleId)?.critical) {
          this.pendingCriticalStartup.add(moduleId);
        }
      }
    }
    if (this.pendingCriticalStartup.size === 0) {
      resolveStartup();
    }

    // Scheduled on a microtask rather than started here, so that status
    // transitions are observable: `createKernel` returns before this runs,
    // giving the composition root a synchronous window in which every
    // module is still `registered` and `subscribeStatus` can be attached.
    // It is also what keeps `createKernel` free of any implementation code.
    const startupPass = Promise.resolve().then(() => this.activateEagerModules());
    void startupPass.catch(() => {});
  }

  /**
   * The current status of `ref`'s module.
   *
   * @throws {InvalidDescriptorError} for a module this kernel never
   *   registered. An unregistered ref has no status, and a plausible-looking
   *   `'registered'` would hide the composition-root omission.
   */
  status(ref: ModuleRef): ModuleStatus {
    return this.statuses.get(this.requireRegistered(ref, 'status')) ?? 'registered';
  }

  /**
   * Calls `callback` on every status transition of `ref`'s module.
   *
   * Does not fire on subscribe; read the current value with `status(ref)`.
   * The returned `Unsubscribe` is idempotent. A subscriber added during a
   * notification pass does not receive that pass; one removed during it is
   * skipped.
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

  /**
   * Resolves `token`. See the `Kernel` interface for the contract.
   *
   * The `'app'` default is applied here rather than in the resolver, whose
   * `requester` is required so it can never invent a context of its own.
   * A failed resolution throws the container's error untouched.
   */
  get<T>(token: Token<T>, requester: string = APP_REQUESTER): T {
    return this.container.resolve(token, { requester });
  }

  /**
   * The full contribution collection for `token`.
   *
   * Takes no requester, unlike `get`: each contribution resolves on behalf
   * of **its own owner**, so a caller's identity cannot change what
   * `MODULE_ID` yields inside someone else's contribution factory.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.container.getAll(token);
  }

  /** See `Kernel.subscribeAll`. Delegates to the container. */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe {
    return this.container.subscribeAll(token, callback);
  }

  /** See `Kernel.ownerOf`. Delegates to the container. */
  ownerOf<T>(token: Token<T>): string | undefined {
    return this.container.ownerOf(token);
  }

  /** See `Kernel.epochOf`. */
  epochOf(moduleId?: string): number {
    return this.epochStore.epochOf(moduleId);
  }

  /** See `Kernel.bumpEpoch`. */
  bumpEpoch(moduleId: string): void {
    this.epochStore.bump(moduleId);
  }

  /** See `Kernel.subscribeEpoch`. */
  subscribeEpoch(moduleId: string | undefined, callback: () => void): Unsubscribe {
    return this.epochStore.subscribe(moduleId, callback);
  }

  /** See `KernelInspection`. */
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
    // carries both kinds.
    const snapshot = this.container.inspect();
    const providers: ProviderInspection[] = snapshot.providers.map((row) =>
      Object.freeze({
        token: row.tokenLabel,
        kind: row.kind,
        scope: row.scope,
        owner: row.owner,
        override: row.override,
        // Omitted rather than `undefined` on an effective row, so that
        // `JSON.stringify` and `toEqual` read "absent" as "live".
        ...(row.overriddenBy === undefined ? {} : { overriddenBy: row.overriddenBy }),
      }),
    );

    // `index` is the contribution's position within its token's collection
    // in module topological order. Declaration order *within* one module is
    // not recoverable from the registry snapshot, so several contributions
    // from one module to one token are numbered in snapshot order.
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
      // Omitted rather than `undefined` in production — see
      // `KernelInspection.resolutionGraph`. Already sorted by the graph.
      ...(this.resolutionGraph === undefined ? {} : { resolutionGraph: this.resolutionGraph.snapshot() }),
    });
  }

  /**
   * Activates `ref`. See the `Kernel` interface for the contract.
   *
   * Rejects rather than throwing synchronously for an unregistered ref, so
   * that `kernel.activate(ref).catch(report)` needs no surrounding `try`.
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

  /** See the `Kernel` interface. */
  whenStartupComplete(): Promise<void> {
    return this.startupComplete;
  }

  /**
   * Tears one module down. Internal to `src/kernel/`: `deactivate` is the
   * public door and owes callers the whole dependent cascade, of which this
   * is the per-module step.
   *
   * The sequence is:
   *
   *  1. `ctx` cleanups, in reverse registration order
   *  2. the optional `dispose(ctx)` handler, awaited under `disposeTimeoutMs`
   *  3. `container.disposeModuleInstances` — every instance this module
   *     owns, `module`-scoped and `singleton` alike
   *  4. `container.withdraw` — providers and contributions, which notifies
   *     the reactive collections
   *  5. the `ctx` is marked dead
   *  6. status → `disposed`
   *
   * Step 3 must precede step 4: `withdraw` notifies contribution
   * subscribers, so withdrawing first would show them a collection that has
   * already dropped a module whose objects are still running.
   *
   * A no-op for a module that has nothing to tear down (`registered`, or
   * already `disposed`).
   */
  async disposeModule(moduleId: string, options: DisposeOptions = {}): Promise<void> {
    const status = this.statuses.get(moduleId);
    if (!this.descriptors.has(moduleId) || status === undefined || status === 'registered' || status === 'disposed') {
      return;
    }
    await this.teardown(moduleId, {
      callDisposeHandler: true,
      preservePersistent: options.preservePersistent ?? false,
    });
    this.failures.delete(moduleId);
    this.setStatus(moduleId, 'disposed');
  }

  /**
   * Steps 1-5 of `disposeModule`'s sequence, shared with quarantine.
   *
   * The two callers disagree on exactly two things: the final status, which
   * quarantine has already set to `failed` and must keep along with its
   * retained error, and whether the descriptor's `dispose(ctx)` handler runs
   * at all. Quarantine does not run it — a hand-written `dispose` mirrors a
   * *completed* `init`, and quarantine tears down a module whose `init`
   * never completed. The cleanups `init` did register still run.
   */
  private async teardown(
    moduleId: string,
    options: { readonly callDisposeHandler: boolean; readonly preservePersistent?: boolean },
  ): Promise<void> {
    const descriptor = this.descriptors.get(moduleId);
    const ctx = this.contexts.get(moduleId);

    // 1 — reverse registration order; a throwing cleanup is reported and
    // does not abort the rest. On the quarantine path this is what runs the
    // effects a module registered before its `init` threw.
    ctx?.runCleanups();

    // 2 — runs after the cleanups and while the ctx is still alive, because
    // it is the one caller legitimately holding it.
    if (options.callDisposeHandler && descriptor?.dispose !== undefined && ctx !== undefined) {
      await this.runDisposeHandler(moduleId, descriptor.dispose, ctx);
    }

    // 3 before 4 — see `disposeModule`. Only a hot update passes
    // `preservePersistent`; deactivation and quarantine leave it `false`,
    // which is what makes "hotReplace preserves, deactivate discards" true.
    await this.container.disposeModuleInstances(moduleId, {
      preservePersistent: options.preservePersistent ?? false,
    });
    this.container.withdraw(moduleId);

    // `withdraw` above is what makes re-activation possible at all: the
    // registry rejects a second `register()` for a still-registered module
    // id, so a teardown that skipped it would turn every `retry` or
    // re-`activate` into a registration failure.
    ctx?.markDead();
    this.contexts.delete(moduleId);
    this.activations.delete(moduleId);

    // The module holds nothing any more, so every edge it was the *consumer*
    // of is stale. Left in place, the graph would only ever grow and the
    // next hot cascade would reach modules that no longer consume anything
    // from the edited one. Re-activation re-records what the new code
    // actually resolves.
    this.resolutionGraph?.forgetConsumer(moduleId);
  }

  /**
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
   * The deactivation cascade.
   *
   * `[moduleId, ...dependentsOf(moduleId, transitive)]` is already in
   * topological order, so reversing it *is* reverse topological order and
   * the target lands last. Only `ready` modules take part: a `registered`
   * one has nothing to tear down, and a `failed` one was already torn down
   * by quarantine and must keep its retained error rather than being
   * relabelled `disposed`.
   *
   * Disposal is sequential: a dependent must be gone before the module it
   * depends on starts disposing, or its `dispose(ctx)` can resolve a
   * service whose provider has already been withdrawn.
   */
  private async runDeactivation(moduleId: string): Promise<void> {
    try {
      // Never tear down a module mid-activation: that would race `init`
      // against its own cleanups. An in-flight activation's failure belongs
      // to that activation's own awaiters, so it is swallowed here.
      await this.activations.get(moduleId)?.catch(() => {});
      // Only the target's activation is awaited, not every dependent's. A
      // dependent that is still `activating` is not `ready` and so is not
      // part of the cascade; if it completes afterwards it fails to resolve
      // the withdrawn providers and quarantines itself.
      if (this.statuses.get(moduleId) !== 'ready') {
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
   * See the `Kernel` interface for the contract.
   *
   * Serialised per module through `hotReplacements` rather than
   * single-flighted: two edits are two updates, and the second one's
   * descriptor is the one the developer is looking at.
   */
  hotReplace(ref: ModuleRef, nextDescriptor?: ModuleDescriptor): Promise<void> {
    let moduleId: string;
    try {
      moduleId = this.requireRegistered(ref, 'hotReplace');
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.hotReplacements.get(moduleId) ?? Promise.resolve();
    // `.catch` before `.then`: a failed update must not wedge the chain, or
    // one bad edit would stop every later edit of that module from applying.
    const chained = previous.catch(() => {}).then(() => this.runHotReplace(moduleId, nextDescriptor));
    this.hotReplacements.set(moduleId, chained);
    const release = (): void => {
      if (this.hotReplacements.get(moduleId) === chained) {
        this.hotReplacements.delete(moduleId);
      }
    };
    chained.then(release, release);
    return chained;
  }

  /**
   * One hot update.
   *
   * Validation runs before anything is disposed. A replacement whose
   * `dependsOn` introduces a cycle or names an unregistered module is
   * rejected whole: the old descriptor and graph stay in force, nothing is
   * disposed, and the module keeps running. Were it disposed first, the
   * *fixing* edit would then arrive for an inactive module — which only
   * refreshes the registration — and the app would stay down until a manual
   * reload.
   *
   * While a rejected edit is in force the running code and the source on
   * disk disagree, and the sink message names the module that was skipped.
   */
  private async runHotReplace(moduleId: string, nextDescriptor?: ModuleDescriptor): Promise<void> {
    let replacement: ValidatedReplacement | undefined;
    if (nextDescriptor !== undefined) {
      replacement = this.validateReplacement(moduleId, nextDescriptor);
      if (replacement === undefined) {
        return;
      }
    }

    // Never tear down mid-activation — same reasoning, and the same
    // swallow, as `runDeactivation`.
    await this.activations.get(moduleId)?.catch(() => {});

    // `registered`, `disposed` and `failed` all take the registration-only
    // branch: editing a file is not an activation trigger, and a `failed`
    // module's way back is `retry`, which its owner decides, not the
    // bundler.
    const active = this.statuses.get(moduleId) === 'ready';

    // Read off the graphs that are still in force, deliberately: a module
    // has to be torn down along the edges it was *brought up* along.
    const cascade = active ? this.hotCascade(moduleId) : [];

    const leakBefore = this.leakCheck?.snapshot();

    // 1 — dispose, dependents first. Every provider instance goes,
    // `singleton` included, except `persistent: true` state, which is
    // parked for the replacement instance to adopt.
    for (const id of [...cascade].reverse()) {
      await this.disposeModule(id, { preservePersistent: true });
    }

    // Measured between disposal and re-activation, because that instant is
    // the invariant's whole content: everything the cascade registered
    // should have been released by now.
    const leakResidual = this.leakCheck?.snapshot();

    // 2 — the descriptor swap has to land between disposal and
    // re-activation: `teardown` calls `descriptor.dispose(ctx)`, and the
    // `dispose` that must run is the one paired with the `init` that
    // actually ran. Committing the replacement first would run the new
    // code's teardown against the old code's context.
    if (replacement !== undefined) {
      this.commitReplacement(moduleId, replacement);
    }
    if (!active) {
      return;
    }

    // 3 — re-evaluate the thunks by re-activating, in topological order.
    // The order determines the sequence of epoch bumps below, so a consumer
    // of two modules in this cascade sees them invalidated dependency-first.
    // (Activation order itself is already guaranteed by the dependency
    // recursion inside `activateById`.)
    for (const id of cascade) {
      try {
        await this.activateById(id);
      } catch {
        // Already retained, quarantined and reported. Rethrowing would abort
        // the rest of the cascade and leave modules that could still come
        // back `disposed`.
        this.hmr.invalidate?.(id, 'module could not be re-activated after a hot update');
      }
      // Bumped whether or not re-activation succeeded. A component holding
      // an instance of a module that failed to come back holds a disposed
      // object either way; re-rendering surfaces that as a resolution error
      // it can render, instead of as silently stale state.
      this.bumpEpoch(id);
    }

    // After the epoch bumps, so the counts include everything the new
    // `init` registered. `check` never throws, so a leak report cannot
    // break a hot update.
    if (this.leakCheck !== undefined && leakBefore !== undefined && leakResidual !== undefined) {
      this.leakCheck.check({
        cascade,
        before: leakBefore,
        residual: leakResidual,
        after: this.leakCheck.snapshot(),
      });
    }
  }

  /**
   * Which modules one hot update disposes and re-activates, in topological
   * order.
   *
   * In dev this is the *consumer* closure from the resolution graph — the
   * edited module plus every module that transitively resolved something
   * from it — rather than every declared `dependsOn` dependent. A module
   * that lists the edited one in `dependsOn` but never resolves any of its
   * tokens is left running. In production there is no resolution graph and
   * the fallback is the declared `dependsOn` cascade. `deactivate` always
   * cascades by `dependsOn`, in dev too.
   *
   * A true consumer that did not *declare* the dependency it resolves has
   * no ordering constraint in the module graph and may land anywhere among
   * its peers.
   */
  private hotCascade(moduleId: string): readonly string[] {
    const graph = this.resolutionGraph;
    const candidates =
      graph === undefined
        ? [moduleId, ...this.graph.dependentsOf(moduleId, { transitive: true })]
        : [...graph.consumerCascade(moduleId)].sort(
            (a, b) => this.sortIndexOf(a) - this.sortIndexOf(b) || a.localeCompare(b),
          );
    // Only `ready` modules take part, exactly as `runDeactivation` filters.
    return candidates.filter((id) => this.statuses.get(id) === 'ready');
  }

  /**
   * Installs the post-hot-update leak invariant, reading counts from `read`.
   *
   * Instrumentation, installed by whoever wrapped the module descriptors —
   * `createTestKernel` today. A no-op outside dev mode.
   */
  installLeakCheck(read: () => LeakReport): void {
    if (!this.dev) {
      return;
    }
    this.leakCheck = new LeakInvariantCheck({
      read,
      // Attributed to the leaking module in the `dispose` phase — the phase
      // whose job it was to release the registrations that survived.
      route: (error, moduleId) => {
        this.report(error, moduleId, 'dispose');
      },
    });
  }

  /**
   * Checks that `next` may replace `moduleId`'s descriptor, re-validating
   * the graph when `dependsOn` changed. Returns `undefined` when the update
   * is rejected.
   *
   * Nothing on `this` is mutated on any path, which is what lets
   * `runHotReplace` reject a bad edit before anything has been torn down.
   *
   * @throws {InvalidDescriptorError} when `next` describes a different
   *   module. That is a caller bug — a hot-update handler wired to the wrong
   *   ref — and routing it to the sinks would let a module be silently
   *   replaced by another one's code.
   */
  private validateReplacement(moduleId: string, next: ModuleDescriptor): ValidatedReplacement | undefined {
    if (next === null || typeof next !== 'object' || typeof next.id?.id !== 'string') {
      throw new InvalidDescriptorError(
        `kernel.hotReplace(): the replacement for module '${moduleId}' is not a descriptor created via ` +
          `defineModule().`,
        moduleId,
      );
    }
    if (next.id.id !== moduleId) {
      throw new InvalidDescriptorError(
        `kernel.hotReplace(): the replacement descriptor for module '${moduleId}' has id '${next.id.id}'. ` +
          `A hot update may replace a module's implementation, never its identity.`,
        moduleId,
      );
    }

    const current = this.descriptors.get(moduleId);
    const before = current?.dependsOn.map((ref) => ref.id) ?? [];
    const after = next.dependsOn.map((ref) => ref.id);
    // Set-compared, not array-compared: the graph sorts `dependsOn`, so a
    // reordered list is not a change and must not force a rebuild.
    if (sameIdSet(before, after)) {
      return { descriptor: next };
    }

    // Validated on a candidate built from a copy — nothing on `this` is
    // touched until the replacement is known to be valid.
    const candidates = new Map(this.descriptors);
    candidates.set(moduleId, next);
    try {
      return { descriptor: next, graph: buildGraphOf(candidates.values()) };
    } catch (error) {
      this.report(error, moduleId, 'activate');
      this.hmr.invalidate?.(
        moduleId,
        'the replacement descriptor failed graph validation; the previous descriptor is still in force',
      );
      return undefined;
    }
  }

  /** Applies an already-validated replacement. Cannot fail. */
  private commitReplacement(moduleId: string, replacement: ValidatedReplacement): void {
    this.descriptors.set(moduleId, replacement.descriptor);
    // The registry keeps covering this module id's descriptor across a
    // *chain* of edits: the replacement's own re-evaluated file closes over
    // this exact object as its `prevDescriptor` on the *next* edit, and only
    // a registered descriptor is found (`hmr/hot-module.ts`).
    if (this.dev) {
      registerModuleDescriptor(this, replacement.descriptor);
    }
    if (replacement.graph !== undefined) {
      this.graph = replacement.graph;
      this.refreshKnownModules();
    }
  }

  /**
   * See the `Kernel` interface for the contract.
   *
   * The clean slate is already in place: quarantine tore the module down
   * when it failed, so there is no stale context, registration or
   * module-scoped instance left to clear. Dropping the retained failure and
   * the `failed` status is the whole difference between this and `activate`,
   * which refuses to re-attempt so that a dependent cannot silently re-run a
   * broken module's `init` on every resolution.
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
   * Quarantines a module whose activation failed.
   *
   * Its providers and contributions are withdrawn, so the reactive
   * collections notify and consumers drop its contributions; its
   * module-scoped instances are disposed, the cleanups its partial `init`
   * registered are run, and its context is killed. The module keeps `failed`
   * and keeps its retained error; `retry` is the only way back.
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
   * Activates every `eager` module, one at a time, in topological order.
   *
   * An eager module may already be `ready` by the time the loop reaches it,
   * because an earlier eager module listing it in `dependsOn` activated it
   * first — which is also how a `lazy` module comes up at startup.
   *
   * A startup failure whose cause chain contains no pending critical module
   * does not stop the pass: the failed modules are quarantined and the rest
   * of the app comes up without them. A pending critical failure anywhere in
   * that chain stops the pass, rejects `whenStartupComplete()`, and raises the
   * fatal handler with that critical module's error.
   */
  private async activateEagerModules(): Promise<void> {
    for (const moduleId of this.graph.topologicalOrder()) {
      const descriptor = this.descriptors.get(moduleId);
      if (descriptor === undefined || descriptor.load !== 'eager') {
        continue;
      }
      try {
        await this.activateById(moduleId);
      } catch (error) {
        const fatalError = this.findPendingCriticalStartupFailure(error);
        if (fatalError !== undefined) {
          // Both halves fire: the promise rejects for a host that awaited
          // it, and `onFatal` (or its rethrowing default) fires for the host
          // that did not. Remaining eager modules are not activated.
          this.rejectStartup(fatalError);
          raiseFatal(fatalError, {
            dev: this.dev,
            ...(this.onFatal === undefined ? {} : { onFatal: this.onFatal }),
          });
          return;
        }
        // Already quarantined by `runActivation`; the rest of the app comes
        // up without it.
      }
    }
    // Reached only when no startup-critical module failed. Redundant when
    // `markCriticalStartupReady` already fired, and the one that matters
    // when there were no startup-critical modules at all.
    this.resolveStartup();
  }

  /** Finds the first still-pending critical module error in a dependency failure chain. */
  private findPendingCriticalStartupFailure(error: unknown): unknown | undefined {
    let current = error;
    while (current instanceof Error) {
      if (
        current instanceof KernelError &&
        current.moduleId !== undefined &&
        this.pendingCriticalStartup.has(current.moduleId)
      ) {
        return current;
      }
      current = current.cause;
    }
    return undefined;
  }

  /** Drops `moduleId` from the startup gate, resolving it once empty. */
  private markCriticalStartupReady(moduleId: string): void {
    if (this.pendingCriticalStartup.delete(moduleId) && this.pendingCriticalStartup.size === 0) {
      this.resolveStartup();
    }
  }

  /**
   * The single-flight entry point every activation goes through:
   * `activate(ref)`, the eager startup pass and the dependency recursion
   * alike, so exactly one place can start a module.
   *
   * The four cases, in order:
   *
   *  - `ready` → resolves immediately; activation is idempotent.
   *  - an in-flight activation → returns **that** promise, so concurrent
   *    triggers await one activation and see one result.
   *  - `failed` → rejects with the retained failure without re-attempting.
   *    Re-attempting is `retry`; silently retrying here would hide a
   *    quarantined module from the caller that depends on it.
   *  - anything else → starts one.
   *
   * The start must stay two statements with **no `await` between them**, so
   * the promise is recorded before control can leave this method.
   * `runActivation` does run synchronously up to its first `await`, during
   * which it may recurse here for a *dependency* — but never for `moduleId`
   * itself, because the graph is known to be acyclic.
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
   * One activation: dependencies, then the provider thunk and `init` under
   * one timeout, then `ready`.
   *
   * On any failure the module transitions to `failed` with the error
   * retained, and the error is rethrown to every awaiting trigger.
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
        // A `ctx.effect` cleanup that throws is reported to the error sinks,
        // attributed to this module in the `cleanup` phase.
        onError: (error) => {
          this.report(error, moduleId, 'cleanup');
        },
      });
      this.contexts.set(moduleId, ctx);
      await this.withActivationTimeout(moduleId, () => this.evaluateModule(moduleId, descriptor, ctx));
      this.setStatus(moduleId, 'ready');
      this.markCriticalStartupReady(moduleId);
      // This module may be the one that contributes the error sinks.
      // Anything buffered while no sink existed goes out now, in order.
      this.errorRouter.flush();
    } catch (error) {
      // Retained for `inspect()`.
      this.failures.set(moduleId, error);
      this.setStatus(moduleId, 'failed');
      // Quarantine before the error is reported or rethrown. The status is
      // already `failed`, so the sinks this module contributed are skipped
      // by the report below: a module that just failed to activate does not
      // get to handle the report about itself.
      await this.quarantine(moduleId);
      this.report(error, moduleId, 'activate');
      throw error;
    } finally {
      this.activations.delete(moduleId);
    }
  }

  /**
   * Activates every not-yet-active `dependsOn` before the module itself,
   * transitively.
   *
   * Direct dependencies are awaited one at a time, and the recursion
   * through `activateById` makes that transitive. By the time this returns
   * every dependency is `ready`, so a module can never observe a dependency
   * that is registered but not ready — neither from `init` nor through the
   * container, whose registry holds no non-activated module's providers.
   *
   * @throws {DependencyActivationError} naming the dependency that failed,
   *   with its own error as the `cause`.
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
   * The evaluation phase: the `providers` thunk, then `init(ctx)`. Either
   * may be synchronous or return a promise, so both are awaited.
   *
   * Provenance is assigned here, from the activating descriptor's own id:
   * a module hands over records and never says who it is.
   *
   * @throws {ModuleActivationError} wrapping whatever the `providers` thunk
   *   or `init` threw. Container registration errors (duplicate provider,
   *   provider/contribution kind conflict) propagate **unwrapped** — they
   *   already name both modules and the token.
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
   * Races `run()` against `initTimeoutMs`.
   *
   * The timeout covers the provider thunk and `init`, but not dependency
   * activation, which each dependency times out for itself.
   *
   * A timed-out module never comes back to life: if `run()` settles later
   * the `settled` latch drops the result, so a `failed` module cannot be
   * resurrected by its own late `init`. A late rejection is reported rather
   * than left as an unhandled rejection.
   *
   * @throws {ActivationTimeoutError} (as a rejection) when `run()` has not
   *   settled within `initTimeoutMs`.
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
            // The module is already `failed` by timeout; this is reported
            // only so the late error does not vanish. Phase `init` rather
            // than `activate`, because activation was already decided and
            // reported when the timeout fired.
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
   * Awaits the descriptor's `dispose(ctx)` under `disposeTimeoutMs`.
   *
   * Never rejects. Neither a throw nor a timeout aborts the teardown: the
   * module is marked `disposed` either way and the error is reported, which
   * is the same rule the container applies per instance.
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
   * The single door every kernel-side error report goes through.
   * `moduleId` is assigned from what the kernel was doing, never read off
   * the error or self-reported by the failing code.
   */
  private report(error: unknown, moduleId: string, phase: ErrorPhase): void {
    this.errorRouter.report(error, { moduleId, phase });
  }

  /**
   * Records a status transition and notifies subscribers.
   *
   * Notifies only on an actual change, and iterates a **copy** of the
   * subscriber set, so a subscriber added by another subscriber does not
   * join the in-flight pass. One cancelled mid-pass is skipped via its
   * `active` flag.
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
   * `topologicalIndex`, with an unknown module sorted last rather than
   * poisoning the comparator with `NaN`.
   */
  private sortIndexOf(moduleId: string): number {
    const index = this.graph.topologicalIndex(moduleId);
    return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Republishes the full set of module ids the container may name in a
   * resolution-failure suggestion. Re-run whenever a hot update changes
   * `dependsOn`, so a suggestion never describes a graph the kernel no
   * longer has.
   */
  private refreshKnownModules(): void {
    const known = new Set<string>(this.descriptors.keys());
    for (const descriptor of this.descriptors.values()) {
      for (const ref of descriptor.dependsOn) {
        known.add(ref.id);
      }
    }
    this.container.setKnownModules([...known].sort());
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

/**
 * Validates and sorts the dependency graph of a set of descriptors.
 *
 * A free function rather than a method, so `hotReplace` can build a
 * candidate graph from uncommitted descriptors and throw it away without
 * any of it having touched the kernel.
 *
 * @throws {UnknownModuleError} for a `dependsOn` id with no descriptor.
 * @throws {DependencyCycleError} for a cycle in `dependsOn`.
 */
function buildGraphOf(descriptors: Iterable<ModuleDescriptor>): ModuleGraph {
  return buildModuleGraph(
    [...descriptors].map((descriptor) => ({
      id: descriptor.id.id,
      dependsOn: descriptor.dependsOn.map((ref) => ref.id),
    })),
  );
}

/** Whether two `dependsOn` id lists describe the same dependency set. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** Renders a retained failure for `inspect()` as a JSON-safe object. */
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
 * Creates a kernel and registers every descriptor synchronously: refs are
 * validated, the dependency graph is built, validated and sorted, and every
 * module ends up `registered`.
 *
 * No `providers`, `init` or `dispose` thunk is evaluated by this call, so
 * every validation error surfaces before any module code has run. Eager
 * modules are activated afterwards, starting on a microtask — which leaves
 * the caller a synchronous window to attach `subscribeStatus` and observe
 * the full transition sequence.
 *
 * @throws {DuplicateModuleIdError} if two descriptors share an id.
 * @throws {UnknownModuleError} if a `dependsOn` names a module that is not
 *   in `modules`.
 * @throws {DependencyCycleError} if `dependsOn` contains a cycle.
 * @throws {InvalidDescriptorError} for malformed options, or a module using
 *   the reserved id `'app'`.
 */
export function createKernel(options: KernelOptions): Kernel {
  return new KernelImpl(options);
}
