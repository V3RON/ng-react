import { noCrossModuleDeepImport } from './no-cross-module-deep-import.js';
import { moduleEntryOnlyInCompositionRoot } from './module-entry-only-in-composition-root.js';
import { contractExportsAllowlist } from './contract-exports-allowlist.js';
import { noOverrideOutsideCompositionRoot } from './no-override-outside-composition-root.js';
import { noTransientInComponent } from './no-transient-in-component.js';

/** @type {Record<string, import('@typescript-eslint/utils').TSESLint.RuleModule<string, unknown[]>>} */
export const rules = {
  'no-cross-module-deep-import': noCrossModuleDeepImport,
  'module-entry-only-in-composition-root': moduleEntryOnlyInCompositionRoot,
  'contract-exports-allowlist': contractExportsAllowlist,
  'no-override-outside-composition-root': noOverrideOutsideCompositionRoot,
  'no-transient-in-component': noTransientInComponent,
};
