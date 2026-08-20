import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude/worktrees/` holds live agent worktrees — full checkouts of this
    // repo, with their own node_modules and possibly their own eslint plugins.
    // Linting into them makes a root `eslint .` depend on whatever an in-flight
    // agent happens to have installed. Always exclude them.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.claude/**'],
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
);
