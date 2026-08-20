// Module refs — the sanctioned way to name a module in code (§5.1).

import { InvalidDescriptorError, ReservedModuleIdError } from './errors';

/**
 * Nominal brand key for `ModuleRef`. Deliberately not exported: because
 * nothing outside this module can reference this symbol, no externally
 * constructed object — however it is shaped — can structurally satisfy
 * `ModuleRef`. Combined with `moduleRef()` being the only place that sets
 * it, this makes "is this actually a ref" a real guarantee, not a
 * convention.
 */
const MODULE_REF_BRAND = Symbol('ModuleRef');

/** ADR-2: `'app'` is reserved for resolutions started outside any module. */
const RESERVED_MODULE_ID = 'app';

/**
 * A unique value identity for a module (M1). Created only via `moduleRef()`.
 * The `id` string exists for diagnostics, graph serialization, and dev
 * tools — identity is always by reference, never by comparing `id` strings
 * (two `moduleRef()` calls with the same `id` are two different refs).
 */
export interface ModuleRef<Id extends string = string> {
  readonly id: Id;
  readonly [MODULE_REF_BRAND]: true;
}

/**
 * Creates a new, distinct `ModuleRef` (M1). Two calls with the same `id`
 * string produce two different ref values by design — `DuplicateModuleIdError`
 * (M3) is raised later, at registration time, when the kernel notices two
 * registered descriptors share an `id` string.
 *
 * @throws {ReservedModuleIdError} for the reserved id `'app'` (ADR-2).
 * @throws {InvalidDescriptorError} for an empty, whitespace-only, or
 *   non-string id.
 */
export function moduleRef<const Id extends string>(id: Id): ModuleRef<Id> {
  if (typeof id !== 'string') {
    throw new InvalidDescriptorError(`moduleRef() requires a string id, got: ${typeof id}.`);
  }
  if (id.trim().length === 0) {
    throw new InvalidDescriptorError(
      `moduleRef() requires a non-empty, non-whitespace id, got: ${JSON.stringify(id)}.`,
    );
  }
  if (id === RESERVED_MODULE_ID) {
    throw new ReservedModuleIdError(id);
  }

  const label = `ModuleRef(${id})`;
  // No explicit type annotation here: `ref` carries extra diagnostic-only
  // members (`toString`, `Symbol.toStringTag`) not declared on `ModuleRef`.
  // Assigning the frozen result to the `ModuleRef<Id>` return type below is
  // a normal (non-literal) assignability check, so the extra members are
  // allowed to ride along without tripping excess-property checking.
  const ref = {
    id,
    [MODULE_REF_BRAND]: true as const,
    toString(): string {
      return label;
    },
    [Symbol.toStringTag]: label,
  };
  return Object.freeze(ref);
}

/** Narrows `value` to `ModuleRef` by checking for the brand. */
export function isModuleRef(value: unknown): value is ModuleRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [MODULE_REF_BRAND]?: unknown })[MODULE_REF_BRAND] === true;
}
