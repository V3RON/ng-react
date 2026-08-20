// @ng-react/eslint-config-modules — the ESLint flat-config preset that makes
// spec 01 §13's boundary rules (B1-B3) real (ADR-4: "Boundary rules B1/B3
// are implemented as an ESLint preset ..., not as Nx tags"; AGENTS.md
// principle 4: "A rule that only exists in documentation is considered
// unimplemented.").
//
// Prerequisite: the consumer must already configure `@typescript-eslint/parser`
// (or an equivalent TS-aware parser) for the files these configs apply to —
// this preset's rules inspect TSESTree nodes (TSTypeAliasDeclaration,
// TSInterfaceDeclaration, ...) but does not set `languageOptions.parser`
// itself, to avoid fighting whatever parser setup the consumer already has
// (this repo's root `eslint.config.js` sets it once, globally, via
// `tseslint.configs.recommended`).
//
// Plain JS, not TypeScript-source: this file (and everything under
// src/rules and src/utils) is `import`ed directly by Node when ESLint loads
// a flat config — there is no bundler in that path the way Vite fronts the
// kernel package's TS source for the rest of this repo. Type-checking still
// happens, via `tsc --noEmit --checkJs` against the JSDoc annotations
// (`package.json`'s `typecheck` script) — see the PR body for the fuller
// rationale and the alternative (a compiled-TS package) that was rejected.

import importXPlugin from 'eslint-plugin-import-x';
import { rules } from './rules/index.js';

const PLUGIN_NAME = 'ng-react-modules';

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.Plugin} */
const plugin = {
  meta: { name: '@ng-react/eslint-config-modules' },
  rules,
};

/**
 * @param {'error' | 'warn'} defaultSeverity
 * @returns {import('@typescript-eslint/utils').TSESLint.FlatConfig.Config[]}
 */
function buildConfig(defaultSeverity) {
  return [
    {
      name: '@ng-react/eslint-config-modules/boundaries',
      files: ['**/*.ts', '**/*.tsx'],
      plugins: {
        [PLUGIN_NAME]: plugin,
        'import-x': importXPlugin,
      },
      settings: {
        // import-x v4's *default* resolver settings (no `import-x/resolver*`
        // key at all) fall back to a legacy `eslint-import-resolver-node`
        // lookup that this preset does not depend on and that throws
        // ("node with invalid interface loaded as resolver") when that
        // package isn't installed. `createNodeResolver` is import-x's own
        // built-in replacement (backed by `unrs-resolver`, already a
        // transitive dependency) — this is the currently-recommended way to
        // get plain Node resolution under the new resolver API, not a
        // workaround. See the PR body for the accuracy caveat this still
        // leaves (no TS-path-aware resolver is configured here).
        'import-x/resolver-next': [importXPlugin.createNodeResolver()],
      },
      rules: {
        // B1
        [`${PLUGIN_NAME}/no-cross-module-deep-import`]: defaultSeverity,
        [`${PLUGIN_NAME}/module-entry-only-in-composition-root`]: defaultSeverity,
        // B2
        [`${PLUGIN_NAME}/contract-exports-allowlist`]: defaultSeverity,
        // B3 / C6
        [`${PLUGIN_NAME}/no-override-outside-composition-root`]: defaultSeverity,
        // R2 / B3 — always a warning regardless of tier: it is a same-file
        // heuristic (see the rule's docs) and is never meant to gate CI.
        [`${PLUGIN_NAME}/no-transient-in-component`]: 'warn',
        // B3: "import/no-cycle (or the Nx boundary equivalent) runs across
        // the workspace." Re-exported, not reimplemented.
        'import-x/no-cycle': defaultSeverity,
      },
    },
  ];
}

/**
 * Escalates the R2 heuristic rule to `error` on every config in `configs`,
 * leaving everything else untouched. Split out (instead of an inline
 * `.map()`) because TS otherwise infers the spread-plus-computed-key result
 * as just `{ [thatOneKey]: string }`, losing the rest of `Rules`.
 * @param {import('@typescript-eslint/utils').TSESLint.FlatConfig.Config[]} configs
 * @returns {import('@typescript-eslint/utils').TSESLint.FlatConfig.Config[]}
 */
function escalateTransientWarning(configs) {
  return configs.map((config) => {
    /** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.Rules} */
    const rules = { ...config.rules, [`${PLUGIN_NAME}/no-transient-in-component`]: 'error' };
    return { ...config, rules };
  });
}

export default {
  meta: plugin.meta,
  rules,
  configs: {
    /** Default tier: every B1-B3 rule as `error`, except the R2 heuristic (`warn`). */
    recommended: buildConfig('error'),
    /** Same as `recommended`, plus the R2 heuristic escalated to `error`. */
    strict: escalateTransientWarning(buildConfig('error')),
  },
};
