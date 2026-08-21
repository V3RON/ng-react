// Module id validation and the name derivations every template placeholder is
// filled from.
//
// The id is load-bearing three times over: it is the package name after the
// scope (spec §4), the string inside `moduleRef()` (M1), and the prefix of
// every token label (C1, ADR-8). One shape has to satisfy all three, which is
// why the rule is narrow.

import { CreateModuleError } from './errors.js';

/**
 * ADR-2: `'app'` is the reserved id `MODULE_ID` resolves to for every
 * resolution started outside a module, and `moduleRef('app')` is a fatal
 * registration error. A module may not claim it.
 */
export const RESERVED_MODULE_IDS = Object.freeze(['app']);

/** Lowercase alphanumeric segments joined by single hyphens. No leading digit. */
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Throws unless `id` is a usable module id.
 *
 * @param {unknown} id
 * @param {string} [what] what the id came from, for the message — `'module id'`
 *   for the positional argument, `"--depends-on entry"` for a dependency.
 * @returns {string}
 */
export function validateModuleId(id, what = 'module id') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new CreateModuleError(
      `create-module: missing ${what}. Usage: create-module <id> [--scope @app] [--dir packages] ` +
        `[--load lazy|eager] [--critical] [--depends-on <id>,...] [--dry-run]`,
    );
  }
  if (RESERVED_MODULE_IDS.includes(id)) {
    throw new CreateModuleError(
      `create-module: '${id}' is a reserved ${what} (ADR-2). MODULE_ID resolves to 'app' for every ` +
        `resolution started outside a module, and moduleRef('app') is a fatal registration error, so no ` +
        `module may claim it. Name the module after its feature instead.`,
    );
  }
  if (!KEBAB_CASE.test(id)) {
    throw new CreateModuleError(
      `create-module: invalid ${what} '${id}'. A module id must be kebab-case — a lowercase letter followed ` +
        `by lowercase letters, digits and single hyphens, e.g. 'orders' or 'demo-thing' — because it is the ` +
        `package name after the scope (spec §4), the string inside moduleRef() (M1), and the prefix of every ` +
        `token label (C1, ADR-8).`,
    );
  }
  return id;
}

/**
 * `demo-thing` -> `DemoThing`.
 * @param {string} id
 */
export function toPascalCase(id) {
  return id
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

/**
 * `demo-thing` -> `demoThing`.
 * @param {string} id
 */
export function toCamelCase(id) {
  const pascal = toPascalCase(id);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * M1/ADR-8: a module's ref constant is `<Pascal>Module` — `demo-thing` ->
 * `DemoThingModule`. The same derivation names a dependency's ref, which is
 * what lets `--depends-on auth` emit `import { AuthModule } from
 * '@app/auth/contract'` without reading that package.
 * @param {string} id
 */
export function toRefName(id) {
  return `${toPascalCase(id)}Module`;
}
