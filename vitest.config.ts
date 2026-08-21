import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    // Projects legitimately start empty and fill in stage by stage.
    passWithNoTests: true,
    // Never pick up tests from live agent worktrees under .claude/worktrees/.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    projects: [
      {
        // Pure kernel tests: no DOM, no React renderer.
        // Enforces that the kernel + createTestKernel work in a plain Node env.
        test: {
          name: 'kernel',
          root: './packages/ng-react',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          globals: true,
        },
      },
      {
        // React binding tests. Convention: any test needing a renderer is a .tsx file.
        plugins: [react()],
        test: {
          name: 'kernel-dom',
          root: './packages/ng-react',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          globals: true,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'demo',
          root: './apps/react',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          globals: true,
        },
      },
      {
        // Generated application module packages — `@app/<id>` (spec §4).
        //
        // Added by task 8.1, and the reason is a finding rather than a
        // convenience: `pnpm create-module` emits an R4 `src/module.test.ts`
        // per package and its own next-steps tell you to run `pnpm verify`,
        // but every project above is rooted at a *named* directory, so the
        // emitted test matched no include glob and ran nowhere. Four modules
        // were generated and `pnpm test` still reported exactly the same 585
        // tests as before — the emitted suite passing was a claim nothing
        // checked. `exclude` names the three packages that own a project
        // above rather than `include` naming the four @app ones, so the next
        // generated module is covered the moment it is written.
        //
        // node env, no React: these are `createTestKernel` suites, and
        // acceptance criterion 7 requires them to run with no renderer.
        test: {
          name: 'app-modules',
          root: './packages',
          environment: 'node',
          include: ['*/src/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'ng-react/**',
            'create-module/**',
            'eslint-config-modules/**',
          ],
          globals: true,
        },
      },
      {
        // create-module generator tests (stage 7, task 7.2).
        //
        // Two include globs, and the second one is the point. `src/**` is the
        // generator's own suite; `__fixtures__/**` is the checked-in golden
        // tree, whose `module.test.ts` is *the emitted test itself*. Running
        // it here is the only way this repo can honestly claim "the emitted
        // package's test passes" — a test that merely diffs the emitted text
        // against a fixture proves the generator is deterministic, not that
        // what it emits works.
        test: {
          name: 'create-module',
          root: './packages/create-module',
          environment: 'node',
          include: ['src/**/*.test.ts', '__fixtures__/**/*.test.ts'],
          globals: true,
        },
      },
      {
        // @ng-react/eslint-config-modules rule tests (stage 7, task 7.1).
        // node env: these are ESLint RuleTester suites, no DOM involved.
        // `globals: true` is load-bearing here, not cosmetic: RuleTester
        // (from @typescript-eslint/rule-tester) defaults its test-framework
        // hooks to whatever `describe`/`it`/`afterAll` exist on globalThis
        // when it isn't told otherwise — that's the "Vitest adapter" this
        // task's issue asks for, not a separate integration shim.
        test: {
          name: 'eslint-config',
          root: './packages/eslint-config-modules',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/ng-react/src/**'],
    },
  },
});
