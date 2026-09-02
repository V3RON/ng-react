// **`@ng-react/vite-plugin`** — module-level HMR for ng-react modules, out of
// the box, via a Vite plugin. Feasibility proof: no hand-written HMR code in
// any `<pkg>/module.ts`, and no per-module wiring in the composition root.
//
// **Why a `transform` hook, and why the injected code has to look exactly
// like this.** Vite decides whether a module is self-accepting by *lexically
// scanning that module's own transformed source* for a literal
// `import.meta.hot.accept(` (an optional `?.` between `.hot` and `.accept`
// is also recognised) — it is a static scan run by the built-in
// `vite:import-analysis` plugin, not a runtime observation. Any indirection
// — a helper function, a re-exported accept, a call reached through an
// alias — is invisible to that scan, the module is treated as
// non-self-accepting, and Vite falls back to a full page reload on every
// edit. So this plugin's `transform` hook appends the literal call directly
// into each module entry file's own source. `transform` hooks registered by
// a normal-priority plugin (this one; no `enforce`) run before Vite's
// built-in `vite:import-analysis`, which is late in the pipeline — so the
// literal text is still there when the scan happens.
//
// **What the injected code does.** It imports `hotReplaceModule` from
// `@ng-react/kernel` — the dev-only descriptor->kernel registry described in
// `packages/ng-react/src/hmr/hot-module.ts` — and calls it with the module's
// own `module` export (the descriptor the *old* evaluation closed over) and
// the replacement's `module` export (from the *new* evaluation, handed to
// the accept callback as `next`). `hotReplaceModule` looks up which
// kernel(s) hold that exact descriptor object and drives `kernel.hotReplace`
// itself — so nothing in the composition root has to name this module, and
// nothing in the module file has to know a kernel exists.

import type { Plugin } from 'vite';

/**
 * The heuristic that identifies a module entry file (`<pkg>/module.ts`),
 * stated in the task and applied literally: the file calls `defineModule(`
 * and exports a binding literally named `module`. Cheap, no AST, and precise
 * enough for this repo's convention — `providers.ts` and `lifecycle.ts`
 * files call neither, so they never match.
 */
const CALLS_DEFINE_MODULE = /\bdefineModule\s*\(/;
const EXPORTS_MODULE_BINDING = /\bexport\s+const\s+module\s*=/;

/** Files this plugin will ever look at. Anything else is a cheap early-out. */
const CANDIDATE_FILE = /\.[cm]?tsx?$/;

/** Marks code this plugin already injected into, so a second pass is a no-op. */
const ALREADY_INJECTED = '__ngReactHotReplace';

/**
 * The injected block. `module` is not an import — it is deliberately the
 * file's own top-level `export const module` binding, read by ordinary
 * closure. That is *why* the injected `import` goes at the very top and the
 * accept block goes at the very bottom: by the time `import.meta.hot.accept`'s
 * callback can actually run, the module's own `const module = …` has long
 * since finished evaluating, so there is no temporal-dead-zone hazard in
 * reading it from the closure — only in referencing it textually earlier
 * than its declaration, which this placement avoids entirely.
 */
function buildInjection(): { readonly header: string; readonly footer: string } {
  return {
    header: `import { hotReplaceModule as ${ALREADY_INJECTED} } from '@ng-react/kernel';\n`,
    footer:
      `\nif (import.meta.hot) {\n` +
      `  import.meta.hot.accept((next) => {\n` +
      `    ${ALREADY_INJECTED}(module, next?.module);\n` +
      `  });\n` +
      `}\n`,
  };
}

/**
 * The Vite plugin. `apply: 'serve'` is load-bearing: `import.meta.hot` does
 * not exist in a production build, and this transform would be dead weight
 * — worse, it would ship a reference to a dev-only kernel registry into a
 * production bundle. Register it in `vite.config.ts`:
 *
 * ```ts
 * import { ngReactHmr } from '@ng-react/vite-plugin';
 * export default defineConfig({ plugins: [react(), ngReactHmr()] });
 * ```
 */
export function ngReactHmr(): Plugin {
  return {
    name: '@ng-react/vite-plugin',
    apply: 'serve',
    transform(code, id, options) {
      // SSR transforms have no `import.meta.hot` either way, and this app
      // has no SSR build — skip defensively rather than inject dead code.
      if (options?.ssr) {
        return;
      }
      const withoutQuery = id.split('?')[0] ?? id;
      if (id.includes('/node_modules/') || !CANDIDATE_FILE.test(withoutQuery)) {
        return;
      }
      if (code.includes(ALREADY_INJECTED)) {
        // Defensive only: `transform` always receives fresh source read from
        // disk, never a previous call's output, so this should not be
        // reachable in practice.
        return;
      }
      if (!CALLS_DEFINE_MODULE.test(code) || !EXPORTS_MODULE_BINDING.test(code)) {
        return;
      }

      const { header, footer } = buildInjection();
      return {
        code: `${header}${code}${footer}`,
        // No source map: this is a whole-file prepend/append with no
        // reflow of existing lines, so an unmapped file still points
        // browser devtools at roughly the right place. Good enough for a
        // feasibility proof; a real shipped version would emit a map.
        map: null,
      };
    },
  };
}

export default ngReactHmr;
