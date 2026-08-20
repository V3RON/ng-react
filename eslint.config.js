import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// Relative, not `@ng-react/eslint-config-modules`: this file is loaded
// directly by Node when ESLint reads the flat config, and only packages
// listed as dependencies of *this* package.json get a node_modules symlink
// at the workspace root — adding one is outside this task's declared root
// edits (vitest.config.ts and eslint.config.js only, per AGENTS.md §7). The
// relative import needs no such change and resolves identically. This is
// also ADR-4 made concrete: B1/B3 land as this preset, not as Nx tags.
import ngReactModules from './packages/eslint-config-modules/src/index.js';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
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
