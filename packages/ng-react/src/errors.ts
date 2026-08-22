// Every error the kernel raises. Messages are part of the contract: each one
// carries enough context to act on without reading the kernel source.

/** Options accepted by every `KernelError` subclass constructor. */
export interface KernelErrorOptions {
  readonly moduleId?: string;
  readonly cause?: unknown;
}

/**
 * Base class for every error the kernel raises. Always thrown as one of the
 * named subclasses, so callers can narrow with `instanceof`, or branch on the
 * stable `code` string without importing the subclass.
 */
export class KernelError extends Error {
  readonly code: string;
  readonly moduleId?: string;

  constructor(code: string, message: string, options?: KernelErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KernelError';
    this.code = code;
    this.moduleId = options?.moduleId;
    // Absent on JSC and Hermes, so the call is guarded rather than assumed.
    const errorConstructor = Error as unknown as {
      captureStackTrace?: (targetObject: object, constructorOpt?: unknown) => void;
    };
    if (typeof errorConstructor.captureStackTrace === 'function') {
      errorConstructor.captureStackTrace(this, new.target);
    }
  }
}

/** Thrown by `moduleRef()` for the reserved module id `'app'`. */
export class ReservedModuleIdError extends KernelError {
  constructor(id: string) {
    super(
      'KERNEL_RESERVED_MODULE_ID',
      `Module id '${id}' is reserved and cannot be used with moduleRef(). ` +
        `'app' identifies resolutions started outside any module. Choose a different module id.`,
      { moduleId: id },
    );
    this.name = 'ReservedModuleIdError';
  }
}

/**
 * Thrown at registration when two registered descriptors carry the same
 * module id string. The message names both sources.
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
 * Thrown at registration when `dependsOn` forms a cycle.
 *
 * `cycle` holds the distinct modules in the cycle, in order; the message
 * repeats the first at the end to show the loop closing.
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
 * Thrown at registration when a `dependsOn` ref names a module whose
 * descriptor was never registered with the kernel.
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
 * Thrown when a declaration is malformed: a bad module descriptor, provider
 * options, token label, or module ref.
 *
 * @param reason A complete, actionable sentence used as the message verbatim.
 */
export class InvalidDescriptorError extends KernelError {
  constructor(reason: string, moduleId?: string) {
    super('KERNEL_INVALID_DESCRIPTOR', reason, { moduleId });
    this.name = 'InvalidDescriptorError';
  }
}

/**
 * Thrown by any member of a `ModuleContext` used after its module was
 * disposed. Usually means code is holding a stale closure across HMR.
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
 * Thrown at registration when two modules `provide()` the same token.
 * `provide(token, { override: true })` is the explicit way to replace one.
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
 * Thrown at registration when `provide()` and `contribute()` are mixed for
 * one token. The message names every module already registered against the
 * token and the kind each used.
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
 * Thrown when a module id is registered with the container while a previous
 * registration for it is still live. Withdraw first — an HMR re-activation
 * does exactly that.
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
 * Thrown when no provider is registered for a token somewhere along a
 * resolution chain.
 *
 * `path` runs from the token the caller asked for down to the one that
 * failed; a single-element path means the requested token itself had no
 * provider. `suggestion` is present when the failing token's label names a
 * module the kernel knows about but that is missing from the requester's
 * `dependsOn`, which is the usual cause.
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
 * Thrown when resolving a token re-enters itself. There is no lazy proxy or
 * forward-ref escape hatch; the cycle must be broken in the design.
 *
 * `cyclePath` holds the distinct token labels in resolution order; the
 * message repeats the first at the end to show the loop closing.
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
 * Thrown when a provider factory throws while constructing an instance. The
 * factory's own error is the `cause`; `path` is the resolution chain that
 * led to it.
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
 * Reported when a provider instance's `dispose()` or `onDispose()` returns a
 * promise that does not settle within `disposeTimeoutMs`.
 *
 * Routed to the error sinks, not thrown. The instance is marked disposed
 * regardless and the rest of the teardown continues, so the underlying call
 * may still be running afterwards.
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
 * Raised when a module's activation does not complete within
 * `initTimeoutMs`.
 *
 * The budget covers the `providers` thunk and `init(ctx)` together, but not
 * the activation of dependencies — each of those runs under its own timeout.
 *
 * The module moves to `failed` and stays there. If the underlying `init`
 * later resolves, that result is discarded; `kernel.retry()` is the only way
 * back.
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
 * Raised when a module's own activation code throws — its `providers` thunk
 * or its `init(ctx)`. The original error is the `cause`.
 *
 * Registration errors the container raises for the returned records
 * (`DuplicateProviderError`, `ProviderKindConflictError`) surface unwrapped
 * instead: they already name both modules and the token.
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
 * Raised when a module cannot activate because one of its `dependsOn`
 * modules failed to activate. The dependency's own error is the `cause`, so
 * the chain reads dependent to dependency to root cause.
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
 * Reported when a module's `dispose(ctx)` handler returns a promise that does
 * not settle within `disposeTimeoutMs`. The per-instance equivalent is
 * `DisposeTimeoutError`.
 *
 * Routed to the error sinks, not thrown, and the rest of the teardown
 * continues.
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
 * Reported when `persistent: true` state could not be carried across an HMR
 * re-activation of its owning module.
 *
 * Routed to the error sinks, never thrown: a failed transfer must not break
 * the HMR cycle. The new instance is left exactly as its factory built it,
 * so the app keeps running with reset state rather than half-restored state.
 *
 * Not exported from `index.ts`; sinks that need to branch on it can match
 * `error.code === 'HMR_PERSISTENT_TRANSFER_FAILED'`.
 */
export class PersistentTransferError extends KernelError {
  /** The token whose persistent instance could not be transferred. */
  readonly tokenLabel: string;

  constructor(moduleId: string, tokenLabel: string, reason: string, cause?: unknown) {
    super(
      'HMR_PERSISTENT_TRANSFER_FAILED',
      `Persistent state for '${tokenLabel}' (owned by '${moduleId}') could not be carried across the HMR ` +
        `re-activation: ${reason}. The freshly constructed instance keeps its initial state and nothing was ` +
        `thrown. Give the provider a transfer(oldInstance, newInstance) hook, or a snapshot()/restore() pair ` +
        `whose snapshot is structured-cloneable.`,
      { moduleId, cause },
    );
    this.name = 'PersistentTransferError';
    this.tokenLabel = tokenLabel;
  }
}

/**
 * Thrown by `ctx.on` when the emitter matches none of the four supported
 * subscribe/unsubscribe shapes. The message names what was passed and lists
 * every shape that would have worked.
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
