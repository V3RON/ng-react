import { InvalidDescriptorError } from './errors';

/**
 * Nominal brand key. Not exported, so nothing outside `createToken()` can
 * fabricate a `Token`.
 *
 * The brand is a function type rather than a plain `true` so that `T` sits in
 * both parameter and return position, which makes `Token<T>` invariant in
 * `T`.
 */
const TOKEN_BRAND = Symbol('Token');

/** Nominal brand key. Not exported — see `TOKEN_BRAND`. */
const OPTIONAL_DEP_BRAND = Symbol('OptionalDep');

/** Nominal brand key. Not exported — see `TOKEN_BRAND`. */
const ALL_OF_DEP_BRAND = Symbol('AllOfDep');

/**
 * A typed, unique key for an injectable value. Created only via
 * `createToken()`.
 *
 * `Token<T>` is invariant in `T`: a `Token<Cat>` is assignable to neither
 * `Token<Animal>` nor `Token<unknown>`. Declare the token at the widest type
 * consumers should see.
 *
 * `label` is diagnostic only, conventionally `moduleId/Name`. Two tokens may
 * share a label and still be distinct.
 */
export interface Token<T> {
  readonly label: string;
  readonly [TOKEN_BRAND]: (value: T) => T;
}

/** A dependency that resolves to `undefined` when nothing provides `token`. */
export interface OptionalDep<T> {
  readonly token: Token<T>;
  readonly [OPTIONAL_DEP_BRAND]: true;
}

/** A dependency that resolves to the full contribution collection for `token`. */
export interface AllOfDep<T> {
  readonly token: Token<T>;
  readonly [ALL_OF_DEP_BRAND]: true;
}

/**
 * A `Token` with its value type erased — the element type of any
 * heterogeneous token collection.
 *
 * Because `Token<T>` is invariant in `T`, a collection of differently-typed
 * tokens has no common supertype expressible with `unknown`. Consumers do not
 * meet this type: every public API that takes a token is generic in `T` and
 * recovers the precise type from its argument.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToken = Token<any>;

/** Anything that may appear in a provider's `deps` array. */
export type Dep<T = unknown> = Token<T> | OptionalDep<T> | AllOfDep<T>;

/**
 * Creates a new, distinct token.
 *
 * Two calls with the same `label` produce two different tokens that will
 * never resolve to each other. Call this once per capability and export the
 * result.
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

/** Narrows `value` to a `Token`. */
export function isToken(value: unknown): value is Token<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { [TOKEN_BRAND]?: unknown })[TOKEN_BRAND] === 'function';
}

/** Marks a dependency optional, so it resolves to `undefined` when unprovided. */
export function optional<T>(token: Token<T>): OptionalDep<T> {
  const dep = {
    token,
    [OPTIONAL_DEP_BRAND]: true as const,
  };
  return Object.freeze(dep);
}

/** Marks a dependency as the full contribution collection for `token`. */
export function allOf<T>(token: Token<T>): AllOfDep<T> {
  const dep = {
    token,
    [ALL_OF_DEP_BRAND]: true as const,
  };
  return Object.freeze(dep);
}

/** Narrows `value` to an `OptionalDep`. Internal: not exported from `index.ts`. */
export function isOptionalDep(value: unknown): value is OptionalDep<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [OPTIONAL_DEP_BRAND]?: unknown })[OPTIONAL_DEP_BRAND] === true;
}

/** Narrows `value` to an `AllOfDep`. Internal: not exported from `index.ts`. */
export function isAllOfDep(value: unknown): value is AllOfDep<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [ALL_OF_DEP_BRAND]?: unknown })[ALL_OF_DEP_BRAND] === true;
}

/**
 * Resolves to the id of the module on whose behalf the current resolution
 * chain was started, or `'app'` when it began outside any module.
 *
 * List it in `deps` like any other token; the kernel provides it.
 */
export const MODULE_ID: Token<string> = createToken<string>('kernel/MODULE_ID');

/** The type a single `Dep` resolves to. */
export type Resolved<D> =
  D extends AllOfDep<infer T>
    ? readonly T[]
    : D extends OptionalDep<infer T>
      ? T | undefined
      : D extends Token<infer T>
        ? T
        : never;

/**
 * Maps a `deps` tuple to the argument tuple its `factory` receives, keeping
 * order and arity.
 *
 * The constraint is `readonly unknown[]` rather than `readonly Dep[]`
 * because `Token<T>`'s invariance makes a heterogeneous tuple unassignable to
 * `readonly Dep<unknown>[]`. The consequence for callers: a non-`Dep` element
 * does not fail to compile — it maps to `never`, and `provide`/`contribute`
 * reject it at runtime instead.
 */
export type ResolvedDeps<D extends readonly unknown[]> = {
  [K in keyof D]: Resolved<D[K]>;
};
