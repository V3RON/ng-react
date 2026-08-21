// KernelError hierarchy + message builders.
//
// Errors are a feature (design principle 6): every subclass here produces a
// message with enough context to act on without opening the kernel source.
// Where the spec quotes a message verbatim (G1), it is reproduced exactly.

/** Options accepted by every `KernelError` subclass constructor. */
export interface KernelErrorOptions {
  readonly moduleId?: string;
  readonly cause?: unknown;
}

/**
 * Base class for every error the kernel throws. Never thrown directly —
 * always via a named subclass so callers can `instanceof`-narrow.
 */
export class KernelError extends Error {
  readonly code: string;
  readonly moduleId?: string;

  constructor(code: string, message: string, options?: KernelErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KernelError';
    this.code = code;
    this.moduleId = options?.moduleId;
    // Node/V8 only; guarded so this class stays usable in other engines
    // (JSC/Hermes on React Native, which do not implement it). `ES2022`
    // + `DOM` lib types have no declaration for it, so narrow through
    // `unknown` rather than reaching for `any`.
    const errorConstructor = Error as unknown as {
      captureStackTrace?: (targetObject: object, constructorOpt?: unknown) => void;
    };
    if (typeof errorConstructor.captureStackTrace === 'function') {
      errorConstructor.captureStackTrace(this, new.target);
    }
  }
}

/**
 * ADR-2: `'app'` is a reserved module id — `moduleRef('app')` throws this
 * immediately rather than returning a ref.
 */
export class ReservedModuleIdError extends KernelError {
  constructor(id: string) {
    super(
      'KERNEL_RESERVED_MODULE_ID',
      `Module id '${id}' is reserved and cannot be used with moduleRef(). ` +
        `'app' is reserved for resolutions started outside any module (ADR-2).`,
      { moduleId: id },
    );
    this.name = 'ReservedModuleIdError';
  }
}

/**
 * M3: registering two descriptors whose refs carry the same id string is a
 * fatal startup error naming both sources (guards against copy-paste of
 * `moduleRef('x')` across contracts).
 */
export class DuplicateModuleIdError extends KernelError {
  constructor(id: string, sourceA: string, sourceB: string) {
    super(
      'KERNEL_DUPLICATE_MODULE_ID',
      `Duplicate module id '${id}': registered by both '${sourceA}' and '${sourceB}'. ` +
        `Each moduleRef() call must use a unique id string.`,
      { moduleId: id },
    );
    this.name = 'DuplicateModuleIdError';
  }
}

/**
 * G1: cycles in `dependsOn` are fatal at registration. `cycle` is the
 * distinct modules in the cycle, in order; the message repeats the first
 * module at the end to show closure of the loop.
 *
 * Message is spec-mandated verbatim (§9, G1), e.g. for
 * `['orders', 'payments', 'risk']`:
 *
 *   Module dependency cycle: orders → payments → risk → orders. Break it by moving the shared surface into a contract.
 */
export class DependencyCycleError extends KernelError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    const first = cycle[0];
    if (first === undefined) {
      throw new Error('DependencyCycleError requires a non-empty cycle path');
    }
    const path = [...cycle, first].join(' → ');
    super(
      'KERNEL_DEPENDENCY_CYCLE',
      `Module dependency cycle: ${path}. Break it by moving the shared surface into a contract.`,
    );
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
}

/**
 * G2: a `dependsOn` ref whose descriptor was not registered with the kernel
 * is fatal at registration, naming the missing module id and the dependent.
 */
export class UnknownModuleError extends KernelError {
  constructor(missingId: string, dependentId: string) {
    super(
      'KERNEL_UNKNOWN_MODULE',
      `Module '${dependentId}' depends on '${missingId}', which was not registered with the kernel. ` +
        `Add its descriptor to the composition root.`,
      { moduleId: dependentId },
    );
    this.name = 'UnknownModuleError';
  }
}

/**
 * D1-D4: the module descriptor is malformed — e.g. a static field could not
 * be evaluated without touching implementation code, or a required field is
 * missing or the wrong shape. `reason` should be a complete, actionable
 * sentence; `moduleId` is included when the offending module is known.
 */
export class InvalidDescriptorError extends KernelError {
  constructor(reason: string, moduleId?: string) {
    super('KERNEL_INVALID_DESCRIPTOR', reason, { moduleId });
    this.name = 'InvalidDescriptorError';
  }
}

/**
 * L4: after dispose, the `ModuleContext` is dead — any use throws, naming
 * the module and noting the likely cause (a stale closure surviving HMR).
 */
export class DeadContextError extends KernelError {
  constructor(moduleId: string) {
    super(
      'KERNEL_DEAD_CONTEXT',
      `ModuleContext for '${moduleId}' is dead: the module has been disposed. ` +
        `This usually means code is holding a stale closure across HMR.`,
      { moduleId },
    );
    this.name = 'DeadContextError';
  }
}

/**
 * C6: two `provide()` calls for one token are a registration-time fatal
 * error naming both providing modules (via provenance, C9 — provenance is
 * never self-reported). `existingOwner` is the module that already holds the
 * token; `newOwner` is the module whose registration was rejected.
 *
 * Message is spec-mandated verbatim (issue #11, task 2.1):
 *
 *   Token 'orders/OrderService' is already provided by 'orders'; 'billing' cannot provide it again. Use provide(token, { override: true, ... }) in the composition root or a test if this is intentional.
 */
export class DuplicateProviderError extends KernelError {
  constructor(tokenLabel: string, existingOwner: string, newOwner: string) {
    super(
      'CONTAINER_DUPLICATE_PROVIDER',
      `Token '${tokenLabel}' is already provided by '${existingOwner}'; '${newOwner}' cannot provide it again. ` +
        `Use provide(token, { override: true, ... }) in the composition root or a test if this is intentional.`,
      { moduleId: newOwner },
    );
    this.name = 'DuplicateProviderError';
  }
}

/**
 * C5: `provide` on a token that already has contributions, or `contribute`
 * on a token that was `provide`d, is a registration-time error. Names the
 * token, every module already registered against it together with the kind
 * it used, and the module + kind of the new, conflicting registration.
 */
export class ProviderKindConflictError extends KernelError {
  constructor(
    tokenLabel: string,
    existingKind: 'provide' | 'contribute',
    existingOwners: readonly string[],
    newKind: 'provide' | 'contribute',
    newOwner: string,
  ) {
    const owners = existingOwners.map((owner) => `'${owner}'`).join(', ');
    super(
      'CONTAINER_PROVIDER_KIND_CONFLICT',
      `Token '${tokenLabel}': ${owners} registered it via ${existingKind}(), but '${newOwner}' is trying to ` +
        `${newKind}() it. provide() and contribute() cannot be mixed for the same token.`,
      { moduleId: newOwner },
    );
    this.name = 'ProviderKindConflictError';
  }
}

/**
 * Registering the same module id twice without an intervening
 * `ProviderRegistry.withdraw()` is an error: the kernel guarantees
 * single-flight activation (A2), so a second registration for a module id
 * that is still registered indicates a bug, not a legitimate re-activation.
 * HMR re-activation (H2) withdraws before it re-registers.
 */
export class DuplicateRegistrationError extends KernelError {
  constructor(moduleId: string) {
    super(
      'CONTAINER_DUPLICATE_REGISTRATION',
      `Module '${moduleId}' is already registered with the container. Call withdraw('${moduleId}') before ` +
        `registering it again — e.g. before an HMR re-activation.`,
      { moduleId },
    );
    this.name = 'DuplicateRegistrationError';
  }
}

/**
 * C8: a resolution failed because no provider is registered for a token
 * somewhere along the chain. `path` is every token label from the one the
 * requester originally asked for down to the one that failed, in order (a
 * single-element path means the top-level token itself had no provider).
 *
 * When the failing token's label prefix (before the first `/`) names a
 * module the registry knows about but that is missing from the requester's
 * `dependsOn`, `suggestion` carries that fact and is appended to the
 * message verbatim.
 *
 * Message is spec-mandated verbatim (§7.2, C8), e.g. for
 * `path = ['orders/OrderService', 'payments/PaymentGateway']` with a
 * suggestion of `{ missingModuleId: 'payments', requesterId: 'orders' }`:
 *
 *   Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.
 */
export class ResolutionError extends KernelError {
  readonly path: readonly string[];

  constructor(
    path: readonly string[],
    suggestion?: { readonly missingModuleId: string; readonly requesterId: string },
  ) {
    const base = `Cannot resolve ${path.join(' → ')}: no provider.`;
    const message =
      suggestion === undefined
        ? base
        : `${base} '${suggestion.missingModuleId}' is registered but not listed in dependsOn of ` +
          `'${suggestion.requesterId}'.`;
    super('CONTAINER_NO_PROVIDER', message, { moduleId: suggestion?.requesterId });
    this.name = 'ResolutionError';
    this.path = path;
  }
}

/**
 * §7.3: the container supports no circular resolution of any kind — no lazy
 * proxies, no forward refs. `cyclePath` is the distinct token labels
 * involved, in resolution order; the message repeats the first at the end
 * to show closure of the loop (same convention as `DependencyCycleError`,
 * G1).
 *
 * Message, e.g. for `cyclePath = ['orders/OrderService', 'orders/Repo']`:
 *
 *   Circular dependency while resolving orders/OrderService: orders/OrderService → orders/Repo → orders/OrderService.
 */
export class CircularDependencyError extends KernelError {
  readonly cyclePath: readonly string[];

  constructor(cyclePath: readonly string[]) {
    const first = cyclePath[0];
    if (first === undefined) {
      throw new Error('CircularDependencyError requires a non-empty cyclePath');
    }
    const path = [...cyclePath, first].join(' → ');
    super('CONTAINER_CIRCULAR_DEPENDENCY', `Circular dependency while resolving ${first}: ${path}.`);
    this.name = 'CircularDependencyError';
    this.cyclePath = cyclePath;
  }
}

/**
 * A provider factory threw while being constructed. The original error is
 * preserved as `cause` — never swallowed — while the message still carries
 * the full resolution path (same join format as `ResolutionError`/C8), so
 * the chain that led to the failing factory is never lost.
 */
export class ProviderFactoryError extends KernelError {
  readonly path: readonly string[];

  constructor(path: readonly string[], cause: unknown) {
    super('CONTAINER_FACTORY_THREW', `Cannot resolve ${path.join(' → ')}: factory threw.`, { cause });
    this.name = 'ProviderFactoryError';
    this.path = path;
  }
}

/**
 * ADR-1: async disposal (a `dispose()`/`onDispose()` that returns a
 * promise) is awaited with a timeout (default 2 s, `disposeTimeoutMs`). On
 * timeout the instance is still marked disposed and this error is handed to
 * the resolver's `onError` callback (routing to the kernel's error sinks,
 * F4, lands in stage 3) naming the owning module and the token whose
 * disposal did not complete in time.
 */
export class DisposeTimeoutError extends KernelError {
  constructor(moduleId: string, tokenLabel: string, timeoutMs: number) {
    super(
      'CONTAINER_DISPOSE_TIMEOUT',
      `Disposing '${tokenLabel}' (owned by '${moduleId}') did not complete within ${timeoutMs}ms. ` +
        `The instance is marked disposed regardless; the dispose call may still be running in the background.`,
      { moduleId },
    );
    this.name = 'DisposeTimeoutError';
  }
}

/**
 * A3: a module's activation did not complete within `initTimeoutMs`
 * (default 10 s, configurable per kernel).
 *
 * The timeout covers **both** halves of activation's evaluation phase — the
 * `providers` thunk and `init(ctx)` — because from the outside they are one
 * indivisible "not ready yet" window, and a slow `import()` behind a
 * provider thunk hangs startup exactly as thoroughly as a slow `init`.
 * Dependency activation is *not* covered: each dependency runs under its
 * own timeout, so a chain of ten modules cannot exhaust one budget and
 * blame the last one.
 *
 * The module transitions to `failed` and stays there. If the underlying
 * `init` later resolves, that result is discarded — a timed-out module is
 * never resurrected; `kernel.retry()` (F3, task 3.3) is the only way back.
 */
export class ActivationTimeoutError extends KernelError {
  constructor(moduleId: string, timeoutMs: number) {
    super(
      'KERNEL_ACTIVATION_TIMEOUT',
      `Activating module '${moduleId}' did not complete within ${timeoutMs}ms. The timeout covers the ` +
        `providers thunk and init(ctx). Raise it with createKernel({ initTimeoutMs }), or move the slow ` +
        `work out of init() and into the service that needs it.`,
      { moduleId },
    );
    this.name = 'ActivationTimeoutError';
  }
}

/**
 * F1: a module's own activation code threw — either its `providers` thunk
 * or its `init(ctx)`. The original error is attached as `cause`, so the
 * chain a module author reads starts at the module id and ends at their own
 * stack frame.
 *
 * Errors raised by the *container* while registering the returned records
 * (C6 duplicate provider, C5 kind conflict) are deliberately **not** wrapped
 * in this: they already name both modules and the token, and burying a
 * spec-quoted message one `cause` deeper makes it worse, not better.
 */
export class ModuleActivationError extends KernelError {
  /** Which half of the evaluation phase threw. */
  readonly phase: 'providers' | 'init';

  constructor(moduleId: string, phase: 'providers' | 'init', cause: unknown) {
    super(
      'KERNEL_ACTIVATION_FAILED',
      `Activating module '${moduleId}' failed in its ` +
        `${phase === 'providers' ? 'providers thunk' : 'init(ctx)'}: ${messageOf(cause)}`,
      { moduleId, cause },
    );
    this.name = 'ModuleActivationError';
    this.phase = phase;
  }
}

/**
 * F3: a module could not activate because one of its `dependsOn` modules
 * failed to activate. The message names the failed dependency — the module
 * that quarantine (task 3.3) will withdraw — and the dependency's own error
 * is the `cause`, so the chain reads dependent → dependency → root cause.
 */
export class DependencyActivationError extends KernelError {
  /** The dependency whose activation failed. */
  readonly dependencyId: string;

  constructor(moduleId: string, dependencyId: string, cause: unknown) {
    super(
      'KERNEL_DEPENDENCY_ACTIVATION_FAILED',
      `Module '${moduleId}' cannot activate: its dependency '${dependencyId}' failed to activate. ` +
        `Fix '${dependencyId}' and call kernel.retry() for it, or remove it from '${moduleId}'s dependsOn.`,
      { moduleId, cause },
    );
    this.name = 'DependencyActivationError';
    this.dependencyId = dependencyId;
  }
}

/**
 * ADR-1: a module's optional `dispose(ctx)` handler returned a promise that
 * did not settle within `disposeTimeoutMs` (default 2 s).
 *
 * The container raises `DisposeTimeoutError` for the same situation one
 * level down, per *instance*; this one is the module-level handler, which
 * has a module id but no token. Both are reported and neither aborts the
 * rest of the teardown (L3).
 */
export class ModuleDisposeTimeoutError extends KernelError {
  constructor(moduleId: string, timeoutMs: number) {
    super(
      'KERNEL_MODULE_DISPOSE_TIMEOUT',
      `dispose(ctx) for module '${moduleId}' did not complete within ${timeoutMs}ms. The module is marked ` +
        `disposed regardless; the dispose call may still be running in the background.`,
      { moduleId },
    );
    this.name = 'ModuleDisposeTimeoutError';
  }
}

/**
 * L2: `ctx.on(emitter, event, handler)` was handed something that is not
 * subscribe-shaped in any of the four supported ways.
 *
 * `ctx.on` duck-types deliberately: spec §8 L2 requires it to work against
 * the spec 02 event bus *without the bus being special-cased*, so there is
 * no interface to implement and no registry of blessed emitters — which
 * makes a precise error the only thing between a caller and a silently
 * missing subscription. The message therefore names what was passed *and*
 * enumerates every shape that would have worked (principle 6).
 */
export class UnsupportedEmitterError extends KernelError {
  constructor(moduleId: string, event: string, detail: string) {
    super(
      'KERNEL_UNSUPPORTED_EMITTER',
      `ctx.on('${event}') in module '${moduleId}': ${detail}. Supported emitter shapes are ` +
        `on(event, handler)/off(event, handler), addListener(event, handler)/removeListener(event, handler), ` +
        `addEventListener(event, handler)/removeEventListener(event, handler), or a subscribe function ` +
        `(event, handler) => unsubscribe.`,
      { moduleId },
    );
    this.name = 'UnsupportedEmitterError';
  }
}

/** Best-effort message extraction for a `cause` of unknown type. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
