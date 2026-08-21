import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * **The Vitest half of issue #52 §3's platform decision** — see
 * `packages/dashboard/src/screen.web.tsx` for the decision itself.
 *
 * A module that owns a component writes `screen.web.tsx` and
 * `screen.native.tsx` and imports `./screen`; this is what makes the *web*
 * file the one every test in this workspace runs against. It is stated here
 * as well as in `apps/react/vite.config.ts` because **Vitest does not read the
 * app's Vite config**, and per project because a `projects` entry is its own
 * config rather than an override of this file's root options — a root
 * `resolve` here would be silently ignored by every project below, which is
 * exactly the shape of a check that passes while doing nothing.
 *
 * The tail of the list is Vite's default, restated because `extensions`
 * replaces the default rather than extending it.
 */
const platformResolve = {
  extensions: ['.web.tsx', '.web.ts', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
};

/**
 * **The *native* half of the same decision** — the mirror image of
 * `platformResolve`, used by the `native` project below and by nothing else.
 *
 * `.native.tsx`/`.native.ts` go first, so `providers.ts`'s `./screen` resolves
 * to `screen.native.tsx` exactly as Metro resolves it on device. The tail is
 * Vite's default, restated for the same reason: `extensions` replaces the
 * default rather than extending it.
 *
 * **The alias is the honest part of this and needs saying out loud.**
 * `react-native`'s entry point is Flow-typed JavaScript that Node cannot parse
 * and esbuild cannot strip, so the real package cannot be loaded outside Metro
 * at all. Issue #53 says "do not bolt on a second test runner without saying
 * so"; this is what was done instead of adding Jest with `react-native`'s
 * preset. The tests in that project assert collection contents, C5 sequences,
 * C9 attribution and the HMR adapter's shape — none of which touch a React
 * Native primitive, because a component is an opaque *value* to the kernel.
 * **Nothing renders**, and `apps/native/src/testing/react-native-stub.ts`
 * carries the full reasoning and the limits.
 */
const nativeResolve = {
  extensions: ['.native.tsx', '.native.ts', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  alias: [
    {
      // Anchored: `react-native-gesture-handler` and friends must not match.
      find: /^react-native$/,
      replacement: fileURLToPath(
        new URL('./apps/native/src/testing/react-native-stub.ts', import.meta.url),
      ),
    },
  ],
};

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
        resolve: platformResolve,
        test: {
          name: 'demo',
          root: './apps/react',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          globals: true,
        },
      },
      {
        // The Expo / React Navigation app (issue #53).
        //
        // **node env and `*.test.ts` only, deliberately.** There is no React
        // Native renderer in this workspace and adding one would mean a second
        // test runner; the logic worth testing here — the contribution
        // collections, the C5 sequences, C9 attribution, the composition root
        // and the HMR adapter's shape — needs no renderer at all. The
        // `.test.tsx` extension is therefore *not* included: the convention in
        // AGENTS.md §3 is that a `.tsx` test is one that needs a renderer, and
        // in this project there is none to be had. What is covered only by the
        // simulator run is listed in the PR body and in
        // `apps/native/src/testing/react-native-stub.ts`.
        resolve: nativeResolve,
        test: {
          name: 'native',
          root: './apps/native',
          environment: 'node',
          include: ['src/**/*.test.ts'],
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
        resolve: platformResolve,
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
