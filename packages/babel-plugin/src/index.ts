// **`@ng-react/babel-plugin-hmr`** — module-level HMR for ng-react modules
// under Metro, out of the box, via a Babel plugin. Feasibility proof: no
// hand-written HMR code in any `<pkg>/module.ts`, and no per-module wiring
// in the composition root — the Metro mirror of `@ng-react/vite-plugin`.
//
// **The mechanism, read out of Metro's own runtime** (verified against
// `metro-runtime`'s `polyfills/require.js` — see `hmr-runtime.test.ts`, which
// loads that real file rather than assuming its behaviour):
//
//  - Every module Metro `__d`-defines gets one `module.hot` object,
//    created once and reused across every re-evaluation of that module's
//    factory (`mod.hot = createHotReloadingObject()` in `define()`, never
//    replaced afterwards).
//  - Editing a file makes Metro call `global.__accept(id, newFactory,
//    dependencyMap, inverseDependencies)`. Metro decides whether a module
//    "self-accepts" by reading `module.hot._didAccept` — true once
//    `module.hot.accept(cb)` has been called — and stops climbing the
//    dependency graph at the first ancestor for which that is true.
//  - For the module actually edited, Metro re-runs its factory *in place*,
//    under the same module id, then — synchronously, right after that
//    factory returns — calls whatever `module.hot.accept(cb)` callback
//    *that very re-run* just registered. No arguments are passed. Crucially,
//    Metro clears the *previous* evaluation's accept registration before
//    re-running the factory, so the callback that fires is always the
//    newest one, and the newest evaluation is the only one that can ever
//    observe what came immediately before it.
//  - That is why the descriptor this file's *previous* evaluation held has
//    to be stashed somewhere that survives the re-run: the shared
//    `module.hot` object itself. Each evaluation reads whatever the last one
//    stashed there (`undefined` on the very first run) before overwriting it
//    with its own descriptor and registering its own accept callback.
//
// **The Expo/CJS pitfall this plugin exists to route around.** A module file
// declares `export const module = defineModule(...)`. Under
// `babel-preset-expo`'s CommonJS transform the file is wrapped in Metro's
// factory signature, whose own parameter is *also* named `module` — the
// literal binding a hot block must read `module.hot` off. Babel's ESM->CJS
// transform therefore has to rename the local `module` binding to avoid a
// collision, and any hand-written `module.hot` reference risks resolving to
// the wrong one (or being caught in that rename outright). The fix applied
// here, before injecting anything: rewrite
//
//   export const module = X;
//
// into
//
//   const __ngReactModule = X;
//   export { __ngReactModule as module };
//
// so the package's public export is unaffected, but nothing above ever
// declares a *local* binding literally named `module` — which means the
// injected `module.hot` reference is unambiguous once the CJS transform
// wraps the file, because at that point `module` can only mean the wrapper's
// own parameter. `hmr-preset.test.ts` proves this against the real preset,
// not a guess about what it does.

import template from '@babel/template';
import * as t from '@babel/types';
import type { ConfigAPI, PluginObj } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type * as BabelTypes from '@babel/types';

/** The package the injected `hotReplaceModule` import comes from. */
const KERNEL_PACKAGE = '@ng-react/kernel';
/** The kernel export the injected code calls. */
const HOT_REPLACE_EXPORT = 'hotReplaceModule';
/** The local alias for the import — namespaced so it cannot collide with app code. */
const LOCAL_HOT_REPLACE = '__ngReactHotReplace';
/** The renamed local binding `export const module = X` becomes `const <this> = X`. */
const LOCAL_MODULE_BINDING = '__ngReactModule';
/** The custom key stashed on the shared `module.hot` object across re-evaluations. */
const PREV_STASH_KEY = '__ngReactPrevModule';
/** The local name the stashed previous descriptor is read into inside the guard. */
const LOCAL_PREV_BINDING = '__ngReactPrevModule';

const buildAcceptBlock = template.statement(`
  if (typeof module !== 'undefined' && module.hot) {
    const %%prev%% = module.hot.%%stashKey%%;
    module.hot.%%stashKey%% = %%moduleBinding%%;
    module.hot.accept(function () {
      %%hotReplace%%(%%prev%%, %%moduleBinding%%);
    });
  }
`);

/**
 * Finds the top-level `export const module = defineModule(...)` statement —
 * this repo's whole convention for a module entry file, mirrored exactly
 * from `@ng-react/vite-plugin`'s heuristic (`defineModule(` + `export const
 * module`) so the two plugins agree on what a module file is.
 */
function findModuleExport(
  body: readonly NodePath<BabelTypes.Statement>[],
): { readonly index: number; readonly init: BabelTypes.Expression } | undefined {
  for (const [index, stmt] of body.entries()) {
    if (!stmt.isExportNamedDeclaration()) {
      continue;
    }
    const decl = stmt.node.declaration;
    if (decl === null || decl === undefined || !t.isVariableDeclaration(decl) || decl.declarations.length !== 1) {
      continue;
    }
    const [declarator] = decl.declarations;
    if (declarator === undefined || !t.isIdentifier(declarator.id) || declarator.id.name !== 'module') {
      continue;
    }
    const init = declarator.init;
    if (init === null || init === undefined || !t.isCallExpression(init) || !t.isIdentifier(init.callee)) {
      continue;
    }
    if (init.callee.name !== 'defineModule') {
      continue;
    }
    return { index, init };
  }
  return undefined;
}

/**
 * The Babel plugin. Registered as a plain `plugins` entry (not folded into a
 * preset) in `apps/native/babel.config.js`, ahead of `babel-preset-expo` —
 * Babel always runs `plugins` before `presets` regardless of array order, so
 * this rewrites and injects while the file is still ESM, before the preset's
 * own CommonJS transform ever sees it.
 */
export default function ngReactHmrBabelPlugin(api: ConfigAPI): PluginObj {
  // **Skip injection in a production build.** `module.hot` does not exist
  // outside Metro's dev bundler, and a production bundle should not carry a
  // reference to the dev-only kernel registry `hotReplaceModule` reads.
  // `api.env('production')` is Babel's own env helper (`BABEL_ENV` falling
  // back to `NODE_ENV`); guarded for safety since a test can hand this
  // function a minimal `api` object that lacks it.
  const isProduction = typeof api.env === 'function' && api.env('production');
  if (isProduction) {
    return { name: '@ng-react/babel-plugin-hmr (noop: production)', visitor: {} };
  }

  return {
    name: '@ng-react/babel-plugin-hmr',
    visitor: {
      Program(path) {
        const body = path.get('body');
        const found = findModuleExport(body);
        if (found === undefined) {
          return;
        }

        const { index, init } = found;

        // `export const module = X;` -> `const __ngReactModule = X; export
        // { __ngReactModule as module };` — see the header comment for why.
        const constDecl = t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(LOCAL_MODULE_BINDING), init),
        ]);
        const reExport = t.exportNamedDeclaration(null, [
          t.exportSpecifier(t.identifier(LOCAL_MODULE_BINDING), t.identifier('module')),
        ]);
        const targetStmt = body[index];
        if (targetStmt === undefined) {
          return;
        }
        targetStmt.replaceWithMultiple([constDecl, reExport]);

        // The injected import, at the top — position is not load-bearing
        // (an `import` declaration is hoisted regardless of where it sits
        // at a module's top level) but matches how `@ng-react/vite-plugin`
        // writes the same shape for the reader's sake.
        path.unshiftContainer(
          'body',
          t.importDeclaration(
            [t.importSpecifier(t.identifier(LOCAL_HOT_REPLACE), t.identifier(HOT_REPLACE_EXPORT))],
            t.stringLiteral(KERNEL_PACKAGE),
          ),
        );

        // The guarded accept block, appended at the end — after the
        // rewritten declaration, so `__ngReactModule` is already
        // initialised by the time it runs (top-level statements execute in
        // source order).
        path.pushContainer(
          'body',
          buildAcceptBlock({
            prev: t.identifier(LOCAL_PREV_BINDING),
            stashKey: t.identifier(PREV_STASH_KEY),
            moduleBinding: t.identifier(LOCAL_MODULE_BINDING),
            hotReplace: t.identifier(LOCAL_HOT_REPLACE),
          }),
        );

        // **Load-bearing, and not cosmetic.** `replaceWithMultiple` above
        // removed the *only* local binding literally named `module` — but
        // Babel's scope info is a cache computed once per `Program` and is
        // not automatically rebuilt on a structural edit like this one.
        // Left alone, `path.scope.getBinding('module')` still finds a
        // binding for the declaration this pass just deleted.
        // `@babel/plugin-transform-modules-commonjs` runs later, in its own
        // `Program.exit`, and unconditionally calls
        // `path.scope.rename('module')` to keep the CJS wrapper's own
        // `module` parameter unambiguous. Called against that *stale*
        // binding, the rename walks every reference still resolving to it —
        // including the literal `module.hot` this plugin just injected —
        // and renames it to a fresh `_module`, which is never declared
        // anywhere in the output: a plain `ReferenceError` at runtime.
        // `hmr-preset.test.ts` pins this against the real preset; reverting
        // this one line reproduces it exactly.
        path.scope.crawl();
      },
    },
  };
}
