import { InvalidDescriptorError, ReservedModuleIdError } from './errors';

/**
 * Nominal brand key. Not exported, so no object built outside this file can
 * structurally satisfy `ModuleRef`.
 */
const MODULE_REF_BRAND = Symbol('ModuleRef');

/** Reserved for resolutions started outside any module. */
const RESERVED_MODULE_ID = 'app';

/**
 * A module's identity. Created only via `moduleRef()`.
 *
 * Refs compare by reference, never by `id` string — the `id` is for
 * diagnostics, graph serialization and dev tools. Export the ref itself and
 * import it wherever the module is named.
 */
export interface ModuleRef<Id extends string = string> {
  readonly id: Id;
  readonly [MODULE_REF_BRAND]: true;
}

/**
 * Creates a new, distinct module ref.
 *
 * Two calls with the same `id` produce two different refs, not the same one.
 * The clash surfaces later as `DuplicateModuleIdError` when the kernel finds
 * two registered descriptors sharing an `id`. Call this once per module and
 * export the result.
 *
 * @throws {ReservedModuleIdError} for the reserved id `'app'`.
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

/** Narrows `value` to a `ModuleRef`. */
export function isModuleRef(value: unknown): value is ModuleRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { [MODULE_REF_BRAND]?: unknown })[MODULE_REF_BRAND] === true;
}
