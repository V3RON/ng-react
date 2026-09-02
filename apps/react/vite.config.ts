import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ngReactHmr } from '@ng-react/vite-plugin';

export default defineConfig({
  // `ngReactHmr()` gives every `<pkg>/module.ts` module-level HMR out of the
  // box — no hand-written hot block in any module file, no per-module
  // `acceptHotUpdate` call here. See `packages/vite-plugin`. Order after
  // `react()` is not load-bearing (its `transform` hook only appends to the
  // string), but keeping the app's own JSX/Fast-Refresh transform first
  // reads more naturally.
  plugins: [react(), ngReactHmr()],
  // **The Vite half of issue #52 §3's platform decision.** `providers.ts`
  // imports `./screen`; this is what makes that `screen.web.tsx` rather than
  // an unresolved specifier. Metro does the equivalent for `.native.*` with no
  // configuration at all (issue #53), which is why the convention is borrowed
  // from it rather than invented here.
  //
  // The web suffixes go *first*: resolution takes the first extension that
  // matches, so a package that has only `screen.tsx` still resolves, and a
  // package that has both gets the web one. The remainder of the list is
  // Vite's own default, restated because supplying `extensions` replaces it
  // rather than extending it — dropping `.mjs` or `.json` here would break
  // dependency resolution in ways that look nothing like a platform bug.
  //
  // `vitest.config.ts` needs the same list: Vitest does not read this file.
  // `tsconfig.base.json` expresses the same decision as `moduleSuffixes`, and
  // `packages/eslint-config-modules/src/index.js` as resolver `extensions` —
  // four vocabularies, one decision. Change one, change all.
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  server: { port: 5173 },
});
