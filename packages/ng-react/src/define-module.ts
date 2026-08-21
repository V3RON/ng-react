import { InvalidDescriptorError } from './errors';
import { isModuleRef } from './module-ref';
import type { ModuleRef } from './module-ref';
import type { AnyProviderRecord } from './provider';
import type { LoadStrategy, ModuleContext } from './types';

const DEFAULT_LOAD: LoadStrategy = 'lazy';
const DEFAULT_CRITICAL = false;
const VALID_LOAD_STRATEGIES: readonly LoadStrategy[] = ['eager', 'lazy'];

/**
 * Everything the kernel knows about a module: what it is called, what it
 * depends on, when it activates, and the three thunks that make up its
 * lifecycle. Frozen, and produced only by `defineModule`.
 */
export interface ModuleDescriptor<Id extends string = string> {
  /** The module's own ref. */
  readonly id: ModuleRef<Id>;
  /** The modules that must be active before this one activates. */
  readonly dependsOn: readonly ModuleRef[];
  /** Whether the module activates at startup or on first use. */
  readonly load: LoadStrategy;
  /** Whether this module failing to activate at startup fails startup as a whole. */
  readonly critical: boolean;
  /** Returns the module's providers. Called once, at activation. */
  readonly providers?: () => AnyProviderRecord[] | Promise<AnyProviderRecord[]>;
  /** Runs after the module's providers are registered. */
  readonly init?: (ctx: ModuleContext) => void | Promise<void>;
  /** Runs when the module is torn down, before its context goes dead. */
  readonly dispose?: (ctx: ModuleContext) => void | Promise<void>;
}

/**
 * The input `defineModule` accepts. Only `id` is required; an unrecognised
 * field is an error rather than being ignored.
 */
export interface DefineModuleInput<Id extends string = string> {
  /** The module's own ref, from `moduleRef()`. */
  readonly id: ModuleRef<Id>;
  /**
   * The modules that must be active before this one activates. Activating
   * this module activates them first, in dependency order.
   *
   * @default []
   */
  readonly dependsOn?: readonly ModuleRef[];
  /**
   * Whether the module activates at startup or on first use.
   *
   * @default 'lazy'
   */
  readonly load?: LoadStrategy;
  /**
   * Whether this module failing to activate at startup fails startup as a
   * whole. A non-critical module is quarantined instead and the rest of the
   * application comes up without it.
   *
   * @default false
   */
  readonly critical?: boolean;
  /**
   * Returns the module's providers. Called once, at activation, so a dynamic
   * `import()` here keeps the implementation out of the startup bundle.
   */
  readonly providers?: () => AnyProviderRecord[] | Promise<AnyProviderRecord[]>;
  /** Runs after the module's providers are registered. */
  readonly init?: (ctx: ModuleContext) => void | Promise<void>;
  /** Runs when the module is torn down, before its context goes dead. */
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
 * Checks every element is a `ModuleRef` and rejects self-dependency and
 * duplicates. Refs are compared by reference, never by id string.
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
 * Creates a frozen module descriptor, validating every field synchronously
 * and throwing on the first problem found.
 *
 * `providers`, `init` and `dispose` are stored as given and never called
 * here, so evaluating a descriptor never reaches the module's implementation
 * code. Nothing about the graph is checked at this point — cycles, unknown
 * dependencies and duplicate module ids are the kernel's business, at
 * registration.
 *
 * @throws {InvalidDescriptorError} for an unknown field, a non-ref `id`, an
 *   invalid `dependsOn` entry (non-ref, self-dependency, duplicate), an
 *   invalid `load` or `critical` value, or a non-function `providers`,
 *   `init` or `dispose`.
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
