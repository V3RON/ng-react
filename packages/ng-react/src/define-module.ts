// Module descriptor declaration API (§5.2): `defineModule`.
//
// Declaration only. Evaluating a descriptor must never evaluate any
// implementation file (D1): `providers`, `init`, and `dispose` are stored as
// thunks here and are never invoked. Registration-time concerns — cycle
// detection (G1), missing-dependency detection (G2), duplicate ids (M3),
// conflicting providers (C6) — belong to the kernel (stage 2+), not here.

import { InvalidDescriptorError } from './errors';
import { isModuleRef } from './module-ref';
import type { ModuleRef } from './module-ref';
import type { AnyProviderRecord } from './provider';
import type { LoadStrategy, ModuleContext } from './types';

const DEFAULT_LOAD: LoadStrategy = 'lazy';
const DEFAULT_CRITICAL = false;
const VALID_LOAD_STRATEGIES: readonly LoadStrategy[] = ['eager', 'lazy'];

/**
 * The complete kernel-facing surface of a module (§5.2), returned by
 * `defineModule`.
 *
 * A note on field count: §5.2's prose states the descriptor "has exactly six
 * fields", and this task's issue repeats that count — but both the spec's
 * own §5.2 worked example and the issue's own sketch of this interface list
 * **seven** distinct keys (`id`, `dependsOn`, `load`, `critical`,
 * `providers`, `init`, `dispose`). This implementation treats the concrete,
 * twice-repeated field list as the executable contract and the "six" in the
 * prose as a stale editorial artifact — plausibly left over from the
 * Revision 2 changelog, which records `capabilities` and `contributions`
 * being removed from an earlier draft of this same field list. Unknown-field
 * rejection below validates and names exactly these seven; adding an eighth
 * remains the rejected case AGENTS.md §9 describes.
 */
export interface ModuleDescriptor<Id extends string = string> {
  readonly id: ModuleRef<Id>;
  readonly dependsOn: readonly ModuleRef[];
  readonly load: LoadStrategy;
  readonly critical: boolean;
  readonly providers?: () => AnyProviderRecord[] | Promise<AnyProviderRecord[]>;
  readonly init?: (ctx: ModuleContext) => void | Promise<void>;
  readonly dispose?: (ctx: ModuleContext) => void | Promise<void>;
}

/** Input accepted by `defineModule`. Every field but `id` has a spec-given default. */
export interface DefineModuleInput<Id extends string = string> {
  readonly id: ModuleRef<Id>;
  readonly dependsOn?: readonly ModuleRef[];
  readonly load?: LoadStrategy;
  readonly critical?: boolean;
  readonly providers?: () => AnyProviderRecord[] | Promise<AnyProviderRecord[]>;
  readonly init?: (ctx: ModuleContext) => void | Promise<void>;
  readonly dispose?: (ctx: ModuleContext) => void | Promise<void>;
}

const VALID_FIELDS = ['id', 'dependsOn', 'load', 'critical', 'providers', 'init', 'dispose'] as const;

/** Renders a value for an error message: `string 'orders'`, `number 42`, `null`, `array`, … */
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
 * D3: validates every element is a `ModuleRef`, rejects self-dependency
 * (identity, matching M1 — refs are compared by reference, never by id
 * string) and rejects duplicate refs.
 */
function validateDependsOn(
  moduleId: string,
  ownRef: ModuleRef,
  dependsOn: readonly unknown[],
): readonly ModuleRef[] {
  const seen = new Set<ModuleRef>();
  for (const [index, dep] of dependsOn.entries()) {
    if (!isModuleRef(dep)) {
      throw new InvalidDescriptorError(
        `defineModule(${moduleId}): dependsOn[${index}] is not a ModuleRef, got ${describeValue(dep)}.`,
        moduleId,
      );
    }
    if (dep === ownRef) {
      throw new InvalidDescriptorError(
        `defineModule(${moduleId}): dependsOn[${index}] is the module's own ref ('${dep.id}'). ` +
          `A module cannot depend on itself.`,
        moduleId,
      );
    }
    if (seen.has(dep)) {
      throw new InvalidDescriptorError(
        `defineModule(${moduleId}): dependsOn[${index}] ('${dep.id}') is a duplicate — each dependency ` +
          `may be listed only once.`,
        moduleId,
      );
    }
    seen.add(dep);
  }
  return dependsOn as readonly ModuleRef[];
}

/**
 * Creates a frozen `ModuleDescriptor` (§5.2). Validates every field
 * synchronously and throws `InvalidDescriptorError` on the first problem
 * found; never calls `providers`, `init`, or `dispose` (D1) — they are
 * stored as-is and evaluated only by the kernel, at activation.
 *
 * @throws {InvalidDescriptorError} for an unknown field, a non-ref `id`, an
 *   invalid `dependsOn` entry (non-ref, self-dependency, duplicate), an
 *   invalid `load`/`critical` value, or a non-function `providers`/`init`/
 *   `dispose`.
 */
export function defineModule<const Id extends string>(input: DefineModuleInput<Id>): ModuleDescriptor<Id> {
  if (typeof input !== 'object' || input === null) {
    throw new InvalidDescriptorError(`defineModule() requires an options object, got ${describeValue(input)}.`);
  }

  const unknownFields = Object.keys(input).filter(
    (key) => !(VALID_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    throw new InvalidDescriptorError(
      `defineModule(): unknown field(s) ${unknownFields.map((f) => `'${f}'`).join(', ')}. ` +
        `Valid fields are: ${VALID_FIELDS.map((f) => `'${f}'`).join(', ')}.`,
    );
  }

  // D2: id is the module's own ref — never a string, never re-stated.
  if (!isModuleRef(input.id)) {
    throw new InvalidDescriptorError(
      `defineModule(): id must be a ModuleRef created via moduleRef(), got ${describeValue(input.id)}.`,
    );
  }
  const id = input.id as ModuleRef<Id>;
  const moduleId = id.id;

  const dependsOnInput: readonly unknown[] = input.dependsOn ?? [];
  if (!Array.isArray(dependsOnInput)) {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): dependsOn must be an array of ModuleRefs, got ${describeValue(dependsOnInput)}.`,
      moduleId,
    );
  }
  const dependsOn = Object.freeze([...validateDependsOn(moduleId, id, dependsOnInput)]);

  const load = input.load ?? DEFAULT_LOAD;
  if (!VALID_LOAD_STRATEGIES.includes(load)) {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): invalid load ${describeValue(load)}. Valid values are: 'eager', 'lazy'.`,
      moduleId,
    );
  }

  const critical = input.critical ?? DEFAULT_CRITICAL;
  if (typeof critical !== 'boolean') {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): critical must be a boolean, got ${describeValue(critical)}.`,
      moduleId,
    );
  }

  // D1: providers/init/dispose are thunks — validated as callable, never called.
  if (input.providers !== undefined && typeof input.providers !== 'function') {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): providers must be a thunk function, got ${describeValue(input.providers)}.`,
      moduleId,
    );
  }
  if (input.init !== undefined && typeof input.init !== 'function') {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): init must be a function, got ${describeValue(input.init)}.`,
      moduleId,
    );
  }
  if (input.dispose !== undefined && typeof input.dispose !== 'function') {
    throw new InvalidDescriptorError(
      `defineModule(${moduleId}): dispose must be a function, got ${describeValue(input.dispose)}.`,
      moduleId,
    );
  }

  const descriptor: ModuleDescriptor<Id> = {
    id,
    dependsOn,
    load,
    critical,
    providers: input.providers,
    init: input.init,
    dispose: input.dispose,
  };
  return Object.freeze(descriptor);
}
