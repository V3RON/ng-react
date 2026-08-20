// Shared `RuleCreator` for every rule in this preset (issue #21: "Custom
// rules live in src/rules/, implemented with @typescript-eslint/utils'
// ESLintUtils.RuleCreator").
//
// Plain JS + JSDoc, not TypeScript: this package is consumed by plain Node
// (ESLint loads flat configs by `import`-ing them directly, and the root
// `eslint.config.js` reaches this package via a relative import — see the
// PR body for why a compiled-TS or source-TS package was rejected). Type
// safety instead comes from `tsc --noEmit --checkJs` against these JSDoc
// annotations (see `typecheck` in package.json).

import { ESLintUtils } from '@typescript-eslint/utils';

export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/V3RON/ng-react/blob/master/packages/eslint-config-modules/src/rules/${name}.js`,
);
