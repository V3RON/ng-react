import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// Imported by package name, not by relative path, so this dogfoods the exact
// resolution path real consumers use: the workspace `exports` map. Tasks 7.2
// (generator) and 8.1 (demo modules) wire the preset in by name, and a broken
// exports map would otherwise not surface until then.
import ngReactModules from '@ng-react/eslint-config-modules';

export default tseslint.config(
  {
    // `.claude/worktrees/` holds live agent worktrees — full checkouts of this
    // repo, with their own node_modules and possibly their own eslint plugins.
    // Linting into them makes a root `eslint .` depend on whatever an in-flight
    // agent happens to have installed. Always exclude them.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.claude/**',
      // Issue #43's regression fixture: a deliberate two-file dependency
      // cycle that `import-x/no-cycle` (spec §13 B3) MUST reject. It is
      // ignored here for the obvious reason — a root `eslint .` that always
      // failed would be useless — and lint is still what judges it:
      // `packages/eslint-config-modules/src/no-cycle.test.ts` runs ESLint
      // over this directory *with this very config file*, with ignores
      // disabled, and asserts the cycle is reported. Do not delete the
      // fixture without deleting that test; do not delete that test.
      'packages/eslint-config-modules/__fixtures__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Spec §13 B1-B3, ADR-4: module-boundary rules as a lint preset. The
  // kernel package (packages/ng-react) is not a "module package" in the
  // spec's sense (no contract.ts/module.ts split yet — that arrives with
  // spec 03's module packages), so this is expected to be near-silent
  // against today's tree; see the PR body for the real-world check.
  ...ngReactModules.configs.recommended,
  {
    // **B1/C6 — `compositionRoot` is an option, not a convention.**
    //
    // **Two entries since issue #53**, and the plural is the point: a workspace
    // has one composition root *per application*, not one in total. `apps/native`
    // is a second host for the same six module packages, so it has a second
    // root, and it is the only file in that app allowed to import
    // `<pkg>/module`. Adding it here is what makes B1 enforced in the new app
    // rather than merely observed by convention — before this line every
    // `@app/*/module` import in `apps/native/src/composition-root.ts` was a
    // lint error, which is the rule working exactly as intended.
    //
    // Both rules below default to `['**/composition-root.{ts,tsx}',
    // '**/main.tsx']`, which is a sensible default and *not* this workspace's
    // answer: `apps/react/src/main.tsx` is the entry point, not the
    // composition root, and it must be held to the same rule as a component.
    // Pointing the glob at the one real file is what turns B1 from a
    // configured rule into an enforced one — see the PR body for the verbatim
    // error a probe import produced.
    //
    // `testGlobs` is deliberately left at its default on the second rule:
    // C6 names "the composition root and tests" together, and `createTestKernel`
    // overrides are exactly the sanctioned use.
    name: 'ng-react/composition-root',
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'ng-react-modules/module-entry-only-in-composition-root': [
        'error',
        {
          compositionRoot: [
            '**/apps/react/src/composition-root.ts',
            '**/apps/native/src/composition-root.ts',
          ],
        },
      ],
      'ng-react-modules/no-override-outside-composition-root': [
        'error',
        {
          compositionRoot: [
            '**/apps/react/src/composition-root.ts',
            '**/apps/native/src/composition-root.ts',
          ],
        },
      ],
    },
  },
);
