// `@ng-react/create-module` — spec §13 **B4**, the one blessed generator.
//
// Principle 5: there is a generator for a *module* and there is not going to
// be one for screens, services or hooks. A module is the only unit the kernel
// has an opinion about; everything else is ordinary code.

export { CreateModuleError } from './errors.js';
export { generateModule } from './generate.js';
export { RESERVED_MODULE_IDS, toCamelCase, toPascalCase, toRefName, validateModuleId } from './id.js';
export { run } from './cli.js';
