// Provider declaration API (§7.2): `provide()` and `contribute()`.
//
// Declaration only. Nothing here constructs an instance or evaluates a
// factory — `factory` is stored verbatim and called later by the container
// (stage 2), which is what makes providers lazy (C3). All validation in this
// file runs once, synchronously, when `provide`/`contribute` is called.

import { InvalidDescriptorError } from './errors';
import { isAllOfDep, isOptionalDep, isToken } from './token';
import type { Dep, ResolvedDeps, Token } from './token';
import type { Scope } from './types';

/**
 * Nominal brand key for `ProviderRecord`. Not exported, for the same reason
 * as `TOKEN_BRAND` in `token.ts`: nothing outside this module can reference
 * it, so nothing outside `provide()`/`contribute()` can fabricate a
 * `ProviderRecord` by hand.
 */
const PROVIDER_RECORD_BRAND = Symbol('ProviderRecord');

const VALID_SCOPES: readonly Scope[] = ['singleton', 'module', 'transient'];

/**
 * Options accepted by `provide()`/`contribute()`.
 *
 * `D` is intentionally constrained by `readonly unknown[]`, not
 * `readonly Dep[]` — see the long comment on `ResolvedDeps` in `token.ts`.
 * `Token<T>`'s brand is invariant in `T`, so TypeScript's element-wise check
 * of a tuple literal against a generic `Dep<unknown>[]` constraint rejects
 * every realistic heterogeneous `deps` array (e.g.
 * `[HttpToken, StorageRootToken, MODULE_ID]`, three different `Token<T>`s) at
 * the call site — before `ResolvedDeps<D>` ever runs. Constraining by
 * `unknown` sidesteps that and defers per-element validity to
 * `ResolvedDeps<D>` at the type level and to the runtime check below (C2
 * task 1.1 handoff note): because the type system can no longer reject a
 * non-`Dep` element, `provide`/`contribute` must reject it at runtime.
 */
export interface ProviderOptions<T, D extends readonly unknown[] = readonly []> {
  /** C2: one of the three flat scopes. Default `'singleton'`. */
  scope?: Scope;
  /** The dependency tuple passed positionally to `factory`. Default `[]`. */
  deps?: D;
  /** C3: stored, never called here. Constructs the instance on first resolution. */
  factory: (...args: ResolvedDeps<D>) => T;
  /** C6: explicit opt-in to replace an existing provider for this token. */
  override?: boolean;
  /** C7: escape hatch for instances that don't implement `dispose()`. Not valid on `'transient'`. */
  onDispose?: (instance: T) => void | Promise<void>;
  /** H3/H4, ADR-3: survive HMR re-activation of the owning module by snapshot transfer. Not valid on `'transient'`. */
  persistent?: boolean;
  /** ADR-3: overrides the default snapshot transfer. Requires `persistent: true`. */
  transfer?: (oldInstance: T, newInstance: T) => void;
}

/**
 * The frozen, opaque record produced by `provide()`/`contribute()` (§7.2).
 * Deliberately carries **no** provenance/owner field: **C9** is explicit that
 * provenance (which module registered this) is kernel-assigned at
 * registration time, never passed by the module itself.
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
 * module's `providers` array and of every collection the container holds.
 *
 * ADR-10. `ProviderRecord<T>` is invariant in `T` twice over: `Token<T>`'s
 * brand is invariant, and `onDispose(instance: T)` / `transfer(old: T, new: T)`
 * put `T` in contravariant position. So the spec's own §7.2 worked example —
 * `[provide(OrderServiceToken, ...), contribute(AnalyticsSinkToken, ...)]` —
 * has type `(ProviderRecord<OrderService> | ProviderRecord<AnalyticsSink>)[]`
 * and is assignable to no `ProviderRecord<unknown>[]`. Erasing with `any` is
 * the containment: it is confined to this alias and `AnyToken`, and every
 * public API that consumes a record is generic in `T`, recovering the precise
 * type from the token it is handed.
 *
 * The known cost: an `AnyProviderRecord` can be re-narrowed to a concrete
 * `ProviderRecord<X>` without complaint. Acceptable, because records are
 * opaque values — nothing reads `T` off a record; the container always
 * re-derives it from the token passed to `resolve`.
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
 * Validates `deps` and returns it typed as `readonly Dep[]` for storage on
 * the `ProviderRecord`.
 *
 * C2 task-1.1 handoff note: because `ResolvedDeps`'s constraint is
 * `readonly unknown[]`, a typo like `deps: [HttpToken, 'storage']` infers the
 * corresponding `factory` parameter as `never` instead of failing to
 * compile — a confusing error, not an actionable one. This runtime check is
 * therefore the only thing standing between the author and that `never`.
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

  // C2: exactly three flat scopes, default 'singleton'.
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

  // C3 / principle 6: catch the case ResolvedDeps' `unknown[]` constraint cannot — a
  // `deps` array shorter than what `factory` actually requires. Explicit non-empty `deps`
  // already gets this from the type checker (ResolvedDeps<D> fixes factory's parameter
  // list), but `deps` omitted or `deps: []` type-checks against a niladic factory type
  // that TypeScript does not enforce strictly enough to reject extra required parameters
  // (see the PR discussion on task 1.2). `Function.prototype.length` counts exactly the
  // leading required positional parameters — defaults, rest, and destructuring all either
  // reduce or don't inflate it — so this check is one-sided: it can only false-negative
  // (miss a real mismatch hidden behind a default/rest/destructured parameter), never
  // false-positive. A factory whose required arity exceeds deps.length is unconditionally
  // a bug: the container calls factory with exactly one argument per dep, so the extra
  // parameters silently receive `undefined`.
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
    // C7: transient lifetime is the consumer's responsibility; the
    // container never calls onDispose for a transient instance.
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
  // ADR-3: persistent transfer only makes sense for state that survives its
  // own module's HMR re-activation; transient instances never do.
  if (persistent && scope === 'transient') {
    throw new InvalidDescriptorError(
      `${kind}(${label}): persistent is not allowed on a 'transient' provider (ADR-3) — there is no instance ` +
        `for the container to carry across HMR re-activation. Use 'singleton' or 'module' scope instead.`,
    );
  }

  if (options.transfer !== undefined) {
    if (typeof options.transfer !== 'function') {
      throw new InvalidDescriptorError(
        `${kind}(${label}): transfer must be a function, got ${describeValue(options.transfer)}.`,
      );
    }
    // ADR-3: transfer only makes sense as a customization of persistent
    // snapshot transfer.
    if (!persistent) {
      throw new InvalidDescriptorError(
        `${kind}(${label}): transfer requires persistent: true (ADR-3) — without persistent, there is no ` +
          `snapshot transfer for it to customize. Add persistent: true, or remove transfer.`,
      );
    }
  }

  const record: ProviderRecord<T> = {
    token,
    kind,
    scope,
    deps: Object.freeze(deps.slice()),
    // Erasing `D` here is safe: the container only ever invokes `factory`
    // with arguments it resolved from this same `deps` array, matching the
    // arity and types `ResolvedDeps<D>` gave the caller at declaration time.
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
 * Declares a single-value provider for `token` (§7.2). Nothing is
 * constructed here — `factory` is stored and called by the container on
 * first resolution (C3).
 *
 * `provide` on a token that already has `contribute`d entries is a
 * registration-time error (C5) — out of scope for this module; that check
 * happens when the kernel registers providers (stage 2).
 *
 * @throws {InvalidDescriptorError} for an invalid token, scope, deps
 *   element, or an ADR-3/C7 combination that can never take effect.
 */
export function provide<T, const D extends readonly unknown[] = readonly []>(
  token: Token<T>,
  options: ProviderOptions<T, D>,
): ProviderRecord<T> {
  return buildProviderRecord('provide', token, options);
}

/**
 * Declares a multi-provider (contribution) for `token` (C5). Identical
 * validation to `provide`; the only difference is the `kind` recorded on the
 * resulting `ProviderRecord`, which the container (stage 2) uses to route
 * registration into the reactive contribution collection instead of the
 * single-provider slot.
 *
 * @throws {InvalidDescriptorError} — see `provide`.
 */
export function contribute<T, const D extends readonly unknown[] = readonly []>(
  token: Token<T>,
  options: ProviderOptions<T, D>,
): ProviderRecord<T> {
  return buildProviderRecord('contribute', token, options);
}
