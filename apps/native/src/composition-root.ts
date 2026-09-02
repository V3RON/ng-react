// **The native composition root** (spec §4, §6, **B1**) — the mirror of
// `apps/react/src/composition-root.ts`.
//
// This is the only file in `apps/native` that imports `<pkg>/module`. Every
// other file reaches a module through `<pkg>/contract`, and the root
// `eslint.config.js` points
// `ng-react-modules/module-entry-only-in-composition-root` at this file's
// path as well as the web one, so that is enforced rather than merely stated.
//
// **What is deliberately identical to the web root**, because that identity is
// the claim issue #53 exists to test: the descriptor list and the absence of
// any kernel instance at module scope. Six of the seven descriptors are the
// *same objects* the web app registers, imported from the same packages,
// unmodified. Neither root does any per-module HMR wiring: module-level hot
// replacement is provided out of the box by a bundler plugin — Vite's for
// the web app, a Metro Babel plugin for this one (`packages/babel-plugin`) —
// which injects the accept wiring into each module's own file at build time.
// See `packages/ng-react/src/hmr/hot-module.ts` for the shared mechanism both
// plugins call into.
//
// **What differs, and only this:**
//
//  1. the shell module is this app's own (`./shell/module`), because a shell
//     is by definition the host's — see that file;
//  2. the `HmrAdapter` is a hand-written `{}` rather than
//     `createViteHmrAdapter(import.meta.hot)`. See `nativeHmrAdapter` below,
//     which is where the one genuine kernel finding of this task is recorded.

import { createKernel } from '@ng-react/kernel';
import type { HmrAdapter, Kernel, ModuleDescriptor } from '@ng-react/kernel';
import { module as authModule } from '@app/auth/module';
import { module as dashboardModule } from '@app/dashboard/module';
import { module as debugModule } from '@app/debug/module';
import { module as navModule } from '@app/nav/module';
import { module as ordersModule } from '@app/orders/module';
import { module as paymentsModule } from '@app/payments/module';
// **Not a package, and deliberately a relative import.** B1 governs
// cross-*package* imports; an application's own folders are outside it, which
// is the same latitude `apps/react` takes for its shell.
import { module as shellModule } from './shell/module';

/**
 * **ADR-5 — the Metro adapter, which is `{}`.**
 *
 * `HmrAdapter` has only optional `invalidate`. Metro has no `invalidate`: its
 * hot runtime can accept an update or fall back to a full refresh, but it
 * exposes no "I could not apply this; escalate" call for a host to make.
 * Therefore its adapter is `{}`, exactly the shape
 * `createNoopHmrAdapter` returns. The kernel's call site is
 * `this.hmr.invalidate?.(…)` and an adapter that supplied a no-op would mean
 * nothing in the workspace ever exercised the absent one.
 *
 * This is written here rather than in the kernel because a Metro adapter with
 * no Metro app to run it would be untested code (principle 4). The companion
 * test pins the `{}` shape, so a later tidy-up cannot add a no-op invalidate.
 */
export const nativeHmrAdapter: HmrAdapter = {};

/**
 * The full descriptor list.
 *
 * Identical to `apps/react`'s but for the last entry, and in the same order —
 * which is a readability choice only, since the kernel topologically sorts
 * `dependsOn` itself (**G1/G3**) and a contribution creates no edge at all
 * (spec §17, M2).
 */
export const appModules: readonly ModuleDescriptor[] = [
  authModule,
  debugModule,
  paymentsModule,
  ordersModule,
  navModule,
  dashboardModule,
  shellModule,
];

/** What `createAppKernel` hands back. */
export interface AppRuntime {
  readonly kernel: Kernel;
}

/**
 * Builds the native application kernel.
 *
 * No per-module HMR wiring: see the header note above and
 * `packages/babel-plugin` for the mechanism that gives Metro edits to these
 * module files the same module-level hot replacement Vite gets, with no
 * hand-written code in the module or in this file.
 */
export function createAppKernel(): AppRuntime {
  const kernel = createKernel({
    modules: appModules,
    hmr: nativeHmrAdapter,
    // `StartupGate` renders the `whenStartupComplete()` rejection itself.
    // Suppress the default macrotask rethrow so React Native's LogBox does
    // not cover that deliberate failure screen.
    onFatal: () => {},
  });

  return { kernel };
}
