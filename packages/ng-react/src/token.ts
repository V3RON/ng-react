// Tokens — typed, unique keys for injectable capabilities (§7.1), plus the
// `optional()` / `allOf()` dependency-declaration wrappers used in provider
// `deps` arrays (§7.3) and the tuple type that maps a `deps` array to the
// argument types a `factory` receives.

import { InvalidDescriptorError } from './errors';

/**
 * Nominal brand key for `Token`. Not exported, for the same reason as
 * `MODULE_REF_BRAND` in `module-ref.ts`: nothing outside this module can
 * reference it, so nothing outside `createToken()` can fabricate a `Token`.
 *
 * The brand is a function type `(value: T) => T` rather than a plain
 * `true`: `T` appears in both contravariant (parameter) and covariant
 * (return) position, which under `strictFunctionTypes` makes `Token<T>`
 * invariant in `T` — `Token<Cat>` and `Token<Animal>` are mutually
 * non-assignable even though `Cat` is assignable to `Animal`.
 */
const TOKEN_BRAND = Symbol('Token');

/** Nominal brand key for `OptionalDep`. Not exported — see `TOKEN_BRAND`. */
const OPTIONAL_DEP_BRAND = Symbol('OptionalDep');

/** Nominal brand key for `AllOfDep`. Not exported — see `TOKEN_BRAND`. */
const ALL_OF_DEP_BRAND = Symbol('AllOfDep');

/**
 * A typed, unique identity for an injectable capability (C1). Created only
 * via `createToken()`. `label` is a diagnostic string, conventionally
 * `moduleId/Name` — two tokens may share a label; they remain distinct
 * values (collisions are impossible by construction).
 */
export interface Token<T> {
  readonly label: string;
  readonly [TOKEN_BRAND]: (value: T) => T;
}

/**
 * Marks a dependency as optional: resolves to `undefined` instead of
 * erroring when nothing provides `token` (§7.3 — no optional-by-default;
 * this wrapper is the explicit opt-in).
 */
export interface OptionalDep<T> {
  readonly token: Token<T>;
  readonly [OPTIONAL_DEP_BRAND]: true;
}

/**
 * Marks a dependency as "resolve the full reactive contribution collection"
 * (C5) rather than a single provider.
 */
export interface AllOfDep<T> {
  readonly token: Token<T>;
  readonly [ALL_OF_DEP_BRAND]: true;
}

/** Anything that may appear in a provider's `deps` array. */
export type Dep<T = unknown> = Token<T> | OptionalDep<T> | AllOfDep<T>;

/**
 * Creates a new, distinct `Token<T>` (C1). Two calls with the same `label`
 * still produce two different token values.
 *
 * @throws {InvalidDescriptorError} for an empty or whitespace-only label.
 */
export function createToken<T>(label: string): Token<T> {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new InvalidDescriptorError(
      `createToken() requires a non-empty, non-whitespace label, got: ${JSON.stringify(label)}.`,
    );
  }

  const displayLabel = `Token(${label})`;
  // See the comment on `moduleRef()`: no explicit `Token<T>` annotation
  // here so the extra diagnostic-only members (`toString`,
  // `Symbol.toStringTag`) can ride along past the assignability check on
  // `Object.freeze(token)` below without tripping excess-property checking.
  const token = {
    label,
    [TOKEN_BRAND]: ((value: T) => value) as (value: T) => T,
    toString(): string {
      return displayLabel;
    },
    [Symbol.toStringTag]: displayLabel,
  };
  return Object.freeze(token);
}

/** Narrows `value` to `Token<unknown>` by checking for the brand. */
export function isToken(value: unknown): value is Token<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { [TOKEN_BRAND]?: unknown })[TOKEN_BRAND] === 'function';
}

/** Wraps `token` so resolution yields `undefined` instead of erroring. */
export function optional<T>(token: Token<T>): OptionalDep<T> {
  const dep = {
    token,
    [OPTIONAL_DEP_BRAND]: true as const,
  };
  return Object.freeze(dep);
}

/** Wraps `token` so resolution yields the full contribution collection. */
export function allOf<T>(token: Token<T>): AllOfDep<T> {
  const dep = {
    token,
    [ALL_OF_DEP_BRAND]: true as const,
  };
  return Object.freeze(dep);
}

/**
 * Narrows `value` to `OptionalDep<unknown>`. Exported for the container
 * (stage 2) to branch on; not part of the public barrel.
 */
export function isOptionalDep(value: unknown): value is OptionalDep<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [OPTIONAL_DEP_BRAND]?: unknown })[OPTIONAL_DEP_BRAND] === true;
}

/**
 * Narrows `value` to `AllOfDep<unknown>`. Exported for the container
 * (stage 2) to branch on; not part of the public barrel.
 */
export function isAllOfDep(value: unknown): value is AllOfDep<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [ALL_OF_DEP_BRAND]?: unknown })[ALL_OF_DEP_BRAND] === true;
}

/**
 * C4: `MODULE_ID` is a kernel-supplied contextual token resolving to the id
 * of the module on whose behalf the current resolution chain was started.
 * Resolution semantics (including the ADR-2 `'app'` fallback) land in
 * stage 2 — here it is only the token identity, like any other.
 */
export const MODULE_ID: Token<string> = createToken<string>('kernel/MODULE_ID');

/** Maps a single `Dep<T>` to the type a resolved value for it has. */
export type Resolved<D> =
  D extends AllOfDep<infer T>
    ? readonly T[]
    : D extends OptionalDep<infer T>
      ? T | undefined
      : D extends Token<infer T>
        ? T
        : never;

/**
 * Maps a `deps` tuple to the tuple of resolved argument types a `factory`
 * receives — element order and arity preserved.
 *
 * The constraint is intentionally `readonly unknown[]`, not
 * `readonly Dep[]`: `Token<T>`'s brand is invariant in `T` (by design, see
 * above), and TypeScript checks a tuple-literal type against a generic
 * array constraint element-wise, so a heterogeneous tuple such as
 * `[Token<A>, OptionalDep<B>, AllOfDep<C>]` can never satisfy
 * `readonly Dep<unknown>[]` — `Token<A>`'s brand is not assignable to
 * `Token<unknown>`'s. Constraining by `unknown` sidesteps that and defers
 * to `Resolved<D[K]>`, which pattern-matches each element independently
 * and resolves to `never` for anything that is not a `Dep`.
 */
export type ResolvedDeps<D extends readonly unknown[]> = {
  [K in keyof D]: Resolved<D[K]>;
};
