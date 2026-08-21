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
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
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
        // The resolver has to be TypeScript-aware or B3 is dead letter.
        // `createNodeResolver()` (import-x's built-in) applies Node's own
        // algorithm, which knows `.js`/`.mjs`/`.cjs`/`.json` and *not* `.ts`.
        // Every internal import in a repo shaped like this one is
        // extensionless TypeScript — `tsconfig.base.json` sets
        // `allowImportingTsExtensions: false`, so they cannot be written any
        // other way — so under the node resolver every internal import is
        // unresolved, `import-x/no-cycle` has no graph to walk, and it silently
        // passes everything (issue #43). That is not an accuracy caveat, it is
        // total loss of the rule: principle 4.
        //
        // `createTypeScriptImportResolver` is the maintained TS counterpart
        // import-x's own docs point at (`eslint-plugin-import-x` ships no TS
        // resolver of its own). It resolves `.ts`/`.tsx` extensionlessly, honours
        // `tsconfig` `paths`, and — the part B1 depends on — follows workspace
        // `exports` maps that point at `.ts` source, which is exactly how
        // `@ng-react/kernel` and every generated `@app/<id>/contract` are
        // published here.
        //
        // It is backed by the same `unrs-resolver` native binding as
        // `createNodeResolver`, so `pnpm-workspace.yaml`'s
        // `allowBuilds: unrs-resolver: true` remains load-bearing.
        'import-x/resolver-next': [
          createTypeScriptImportResolver({
            // Resolve `@types/*` for packages that ship no TS source, so
            // `no-unresolved` does not fire on type-only imports.
            alwaysTryTypes: true,
            // **Platform file extensions (issue #52 §3), and the reason this
            // list has to exist at all.**
            //
            // A module that owns a component writes `screen.web.tsx` and
            // `screen.native.tsx` and every other file in the package imports
            // the extensionless `./screen`. `tsconfig.base.json` teaches
            // `tsc` to find it with `moduleSuffixes: ['.web', '']` — and
            // **this resolver ignores `moduleSuffixes` entirely**. Measured,
            // not assumed: with `moduleSuffixes` set and `tsc` completely
            // green, `import-x/no-unresolved` still reported
            // "Unable to resolve path to module './screen'" for every such
            // import in the workspace. A resolver that reads `tsconfig` for
            // `paths` and `exports` does not read it for this.
            //
            // So the suffixes are restated in the resolver's own vocabulary.
            // The tail is the resolver's default list, restated because
            // supplying `extensions` replaces it — drop `.d.ts` or `.json`
            // and `no-unresolved` turns into workspace-wide noise.
            //
            // **`.web` only, deliberately.** The workspace's only application
            // is the web demo, so a `screen.native.tsx` with no `.web`
            // sibling *should* be an unresolved import here. Issue #53 adds a
            // native app; whoever does that decides whether lint gains a
            // second, platform-scoped config or whether `.native` joins this
            // list — and either way must say which files each one judges.
            extensions: [
              '.web.tsx',
              '.web.ts',
              '.tsx',
              '.ts',
              '.d.ts',
              '.jsx',
              '.js',
              '.mjs',
              '.cjs',
              '.json',
              '.node',
            ],
          }),
        ],
        // A TS-aware resolver alone is NOT enough to make `no-cycle` fire, and
        // this is the half issue #43 does not mention. There is a *second*,
        // independent gate: to walk past the first hop, `no-cycle` asks
        // `ExportMap.get()` to parse the imported file, and `ExportMap.for()`
        // bails with `null` for any path failing `hasValidExtension()` —
        // whose default allowlist is `['.js', '.mjs', '.cjs']`
        // (`eslint-plugin-import-x/lib/utils/ignore.js`). With only the
        // resolver swapped, `no-unresolved` goes green (resolution works) while
        // `no-cycle` stays just as silent as before, which is the most
        // misleading possible state. Both settings are load-bearing; verified
        // by removing each one independently.
        //
        // `.web.ts`/`.web.tsx` are in the list for the same reason every other
        // entry is: without them `ExportMap.for()` returns `null` for a
        // platform file and `no-cycle` stops walking at its door — so a cycle
        // routed through a `screen.web.tsx` would be invisible while the rule
        // reported nothing, which is #43's failure mode exactly. They are
        // *additional* entries and not replacements: `hasValidExtension` tests
        // the whole trailing string, and `screen.web.tsx` also ends in `.tsx`,
        // so this pair is belt-and-braces rather than load-bearing today. Kept
        // because the cheap version of #43 was believing that.
        'import-x/extensions': ['.ts', '.tsx', '.web.ts', '.web.tsx', '.js', '.jsx', '.mjs', '.cjs'],
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
        // Not a boundary rule of its own, but the honest check that the
        // resolver above actually resolves rather than merely being
        // configured: if it silently stops resolving, `no-cycle` goes quiet
        // again and nothing else notices, whereas `no-unresolved` turns the
        // whole workspace into the alarm. Free once a resolver works, and an
        // unresolved import is a real defect on its own terms.
        'import-x/no-unresolved': defaultSeverity,
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
