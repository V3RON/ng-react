// **The Metro half of the module-level HMR proof.** `apps/react`'s mirror is
// `vite.config.ts`'s `ngReactHmr()`. This file's whole job is one line:
// register `@ng-react/babel-plugin-hmr` as a `plugins` entry, ahead of
// `babel-preset-expo`.
//
// **`.mjs`, not `.js`.** `apps/native/package.json` has no `"type":
// "module"`, so a `.js` config here would load as CommonJS and need
// `require`/`module.exports` — `@babel/core` resolves `babel.config.mjs`
// exactly like `babel.config.js` (see its `ROOT_CONFIG_FILENAMES`), so this
// is a plain ESM file instead, consistent with the rest of the workspace.
//
// **Ordering is not this file's job to get right — Babel's is.** Babel
// always runs everything under `plugins` before anything under `presets`,
// regardless of array position, so the plugin below rewrites and injects
// into each module's AST while the file is still ESM, before
// `babel-preset-expo`'s own CommonJS transform (which is where the Expo/CJS
// pitfall the plugin works around actually lives — see
// `packages/babel-plugin/src/index.ts`'s header comment) ever sees it.
//
// No hand-written HMR code lives in any `<pkg>/module.ts`, and no
// per-module wiring lives in `composition-root.ts` — this file, plus the
// plugin it names, is the entire mechanism.
import ngReactHmrBabelPlugin from '@ng-react/babel-plugin-hmr';

export default function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [ngReactHmrBabelPlugin],
  };
}
