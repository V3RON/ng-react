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
