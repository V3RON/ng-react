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
);
