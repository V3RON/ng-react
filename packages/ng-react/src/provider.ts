import { InvalidDescriptorError } from './errors';
import { isAllOfDep, isOptionalDep, isToken } from './token';
import type { Dep, ResolvedDeps, Token } from './token';
import type { Scope } from './types';

/**
 * Nominal brand key. Not exported, so nothing outside
 * `provide()`/`contribute()` can fabricate a `ProviderRecord`.
 */
const PROVIDER_RECORD_BRAND = Symbol('ProviderRecord');

const VALID_SCOPES: readonly Scope[] = ['singleton', 'module', 'transient'];

/**
 * Options accepted by `provide()` and `contribute()`.
 *
 * @example
 * ```ts
 * provide(OrderServiceToken, {
 *   deps: [HttpToken, optional(CacheToken)],
 *   factory: (http, cache) => new OrderService(http, cache),
 * });
 * ```
 */
export interface ProviderOptions<T, D extends readonly unknown[] = readonly []> {
  /**
   * The lifetime of the instances this provider creates.
   *
   * @default 'singleton'
   */
  scope?: Scope;
  /**
   * The dependencies passed positionally to `factory`, in this order.
   *
   * @default []
   */
  deps?: D;
  /** Constructs the instance. Stored here and called on first resolution, never during declaration. */
  factory: (...args: ResolvedDeps<D>) => T;
  /**
   * Replaces an existing provider for this token instead of conflicting with
   * it. Intended for the composition root and tests.
   *
   * @default false
   */
  override?: boolean;
  /**
   * Tears the instance down when its scope ends, for instances that do not
   * implement `Disposable`. Not allowed on a `'transient'` provider.
   */
  onDispose?: (instance: T) => void | Promise<void>;
  /**
   * Carries the instance's state across an HMR re-activation of the owning
   * module. Not allowed on a `'transient'` provider.
   *
   * @default false
   */
  persistent?: boolean;
  /**
   * Replaces the default snapshot-based state transfer with a direct copy
   * from the old instance to the new one. Requires `persistent: true`.
   */
  transfer?: (oldInstance: T, newInstance: T) => void;
}

/**
 * The frozen, opaque record produced by `provide()` and `contribute()`.
 *
 * It carries no owner field: which module a provider belongs to is assigned
 * by the kernel at registration, never declared by the module itself.
 */
export interface ProviderRecord<T = unknown> {
  readonly token: Token<T>;
  readonly kind: 'provide' | 'contribute';
  readonly scope: Scope;
  readonly deps: readonly Dep[];
  readonly factory: (...args: readonly unknown[]) => T;
  readonly override: boolean;
  readonly onDispose?: (instance: T) => void | Promise<void>;
  readonly persistent: boolean;
  readonly transfer?: (oldInstance: T, newInstance: T) => void;
  readonly [PROVIDER_RECORD_BRAND]: true;
}

/**
 * A `ProviderRecord` with its value type erased — the element type of a
 * module's `providers` array.
 *
 * `ProviderRecord<T>` is invariant in `T`, so a mixed array of records has no
 * common supertype expressible with `unknown`. Nothing reads `T` back off a
 * record; the container re-derives it from the token passed to `resolve`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderRecord = ProviderRecord<any>;

/** Renders a value for an error message: `string 'storage'`, `number 42`, `null`, `array`, … */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `string '${value}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`;
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value; // 'object' | 'function' | 'symbol'
}

/**
 * Validates `deps` and returns it typed as `readonly Dep[]`.
 *
 * The type system cannot catch a non-`Dep` element — `deps: [HttpToken,
 * 'storage']` compiles and infers the corresponding `factory` parameter as
 * `never` — so this check is what turns that into an actionable error.
 */
function validateDeps(kind: 'provide' | 'contribute', label: string, deps: readonly unknown[]): readonly Dep[] {
  deps.forEach((dep, index) => {
    if (!isToken(dep) && !isOptionalDep(dep) && !isAllOfDep(dep)) {
      throw new InvalidDescriptorError(
        `${kind}(${label}): deps[${index}] is not a Token, optional() or allOf() wrapper, got ${describeValue(dep)}.`,
      );
    }
  });
  return deps as readonly Dep[];
}

/** Shared validation + assembly for `provide()` and `contribute()`. */
function buildProviderRecord<T, D extends readonly unknown[]>(
  kind: 'provide' | 'contribute',
  token: Token<T>,
  options: ProviderOptions<T, D>,
): ProviderRecord<T> {
  if (!isToken(token)) {
    throw new InvalidDescriptorError(
      `${kind}() requires a Token created via createToken() as its first argument, got ${describeValue(token)}.`,
    );
  }
  const label = token.label;

  if (typeof options !== 'object' || options === null) {
    throw new InvalidDescriptorError(`${kind}(${label}): options must be an object, got ${describeValue(options)}.`);
  }
  if (typeof options.factory !== 'function') {
    throw new InvalidDescriptorError(
      `${kind}(${label}): factory must be a function, got ${describeValue(options.factory)}.`,
    );
  }

  const scope: Scope = options.scope ?? 'singleton';
  if (!VALID_SCOPES.includes(scope)) {
    throw new InvalidDescriptorError(
      `${kind}(${label}): invalid scope ${describeValue(options.scope)}. ` +
        `Valid scopes are: ${VALID_SCOPES.map((s) => `'${s}'`).join(', ')}.`,
    );
  }

  const rawDeps: readonly unknown[] = options.deps ?? [];
  if (!Array.isArray(rawDeps)) {
    throw new InvalidDescriptorError(`${kind}(${label}): deps must be an array, got ${describeValue(rawDeps)}.`);
  }
  const deps = validateDeps(kind, label, rawDeps);

  // Catches a factory that requires more arguments than `deps` supplies, which
  // the type checker misses when `deps` is omitted or empty. The check is
  // one-sided: `Function.prototype.length` ignores parameters with defaults,
  // rest and destructured ones, so it can miss a real mismatch but never
  // reports a false one.
  const arity = options.factory.length;
  if (arity > deps.length) {
    const first = deps.length + 1;
    const range = first === arity ? `parameter ${arity}` : `parameters ${first}-${arity}`;
    const pronoun = arity - deps.length === 1 ? 'it' : 'them';
    throw new InvalidDescriptorError(
      `${kind}(${label}): factory declares ${arity} required parameter${arity === 1 ? '' : 's'} but deps has ` +
        `${deps.length} ${deps.length === 1 ? 'entry' : 'entries'}. The container calls factory with exactly ` +
        `one argument per dep, so ${range} would be undefined. Did you forget to list ${pronoun} in deps?`,
    );
  }

  const override = options.override ?? false;
  if (typeof override !== 'boolean') {
    throw new InvalidDescriptorError(
      `${kind}(${label}): override must be a boolean, got ${describeValue(options.override)}.`,
    );
  }

  if (options.onDispose !== undefined) {
    if (typeof options.onDispose !== 'function') {
      throw new InvalidDescriptorError(
        `${kind}(${label}): onDispose must be a function, got ${describeValue(options.onDispose)}.`,
      );
    }
    // The container never disposes transient instances, so onDispose would
    // never run.
    if (scope === 'transient') {
      throw new InvalidDescriptorError(
        `${kind}(${label}): onDispose is not allowed on a 'transient' provider — transient instances are ` +
          `never disposed by the container, so onDispose would never run. Acquire and release transient ` +
          `instances inside ctx.effect() instead.`,
      );
    }
  }

  const persistent = options.persistent ?? false;
  if (typeof persistent !== 'boolean') {
    throw new InvalidDescriptorError(
      `${kind}(${label}): persistent must be a boolean, got ${describeValue(options.persistent)}.`,
    );
  }
  if (persistent && scope === 'transient') {
    throw new InvalidDescriptorError(
      `${kind}(${label}): persistent is not allowed on a 'transient' provider — there is no instance ` +
        `for the container to carry across HMR re-activation. Use 'singleton' or 'module' scope instead.`,
    );
  }

  if (options.transfer !== undefined) {
    if (typeof options.transfer !== 'function') {
      throw new InvalidDescriptorError(
        `${kind}(${label}): transfer must be a function, got ${describeValue(options.transfer)}.`,
      );
    }
    if (!persistent) {
      throw new InvalidDescriptorError(
        `${kind}(${label}): transfer requires persistent: true — without persistent, there is no ` +
          `snapshot transfer for it to customize. Add persistent: true, or remove transfer.`,
      );
    }
  }

  const record: ProviderRecord<T> = {
    token,
    kind,
    scope,
    deps: Object.freeze(deps.slice()),
    factory: options.factory as (...args: readonly unknown[]) => T,
    override,
    onDispose: options.onDispose,
    persistent,
    transfer: options.transfer,
    [PROVIDER_RECORD_BRAND]: true,
  };
  return Object.freeze(record);
}

/**
 * Declares the single provider for `token`.
 *
 * Nothing is constructed here: `factory` runs on first resolution. Only one
 * module may `provide()` a given token, and a token that already has
 * `contribute()`d entries cannot be `provide()`d — both are reported by the
 * kernel at registration, not here.
 *
 * @throws {InvalidDescriptorError} for an invalid token, scope or `deps`
 *   element, a factory needing more arguments than `deps` supplies, or an
 *   option combination that could never take effect.
 */
export function provide<T, const D extends readonly unknown[] = readonly []>(
  token: Token<T>,
  options: ProviderOptions<T, D>,
): ProviderRecord<T> {
  return buildProviderRecord('provide', token, options);
}

/**
 * Declares one entry in the contribution collection for `token`. Any number
 * of modules may contribute to the same token; consumers read the collection
 * with `allOf(token)` or `ctx.getAll(token)`.
 *
 * Validation is identical to `provide`.
 *
 * @throws {InvalidDescriptorError} — see `provide`.
 */
export function contribute<T, const D extends readonly unknown[] = readonly []>(
  token: Token<T>,
  options: ProviderOptions<T, D>,
): ProviderRecord<T> {
  return buildProviderRecord('contribute', token, options);
}
