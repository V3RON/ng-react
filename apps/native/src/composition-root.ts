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
// the claim issue #53 exists to test: the descriptor list, the six
// `acceptHotUpdate(kernel)` calls, and the absence of any kernel instance at
// module scope. Six of the seven descriptors are the *same objects* the web
// app registers, imported from the same packages, unmodified.
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
import { acceptHotUpdate as acceptAuthHotUpdate, module as authModule } from '@app/auth/module';
import type { ModuleHotContext } from '@app/auth/module';
import {
  acceptHotUpdate as acceptDashboardHotUpdate,
  module as dashboardModule,
} from '@app/dashboard/module';
import { acceptHotUpdate as acceptDebugHotUpdate, module as debugModule } from '@app/debug/module';
import { acceptHotUpdate as acceptNavHotUpdate, module as navModule } from '@app/nav/module';
import { acceptHotUpdate as acceptOrdersHotUpdate, module as ordersModule } from '@app/orders/module';
import {
  acceptHotUpdate as acceptPaymentsHotUpdate,
  module as paymentsModule,
} from '@app/payments/module';
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

/** Supplies a per-module hot context by id, or `undefined` to let the module read its own. */
export type HotContextSource = (moduleId: string) => ModuleHotContext | undefined;

/** What `createAppKernel` hands back. */
export interface AppRuntime {
  readonly kernel: Kernel;
}

/**
 * Builds the native application kernel.
 *
 * **`hotFor` exists for the same reason the web root's does**: without it,
 * deleting one of the six `acceptHotUpdate` lines below would break HMR for
 * that module and no test in the workspace would notice — a rule documented
 * and not enforced (principle 4). Production passes nothing.
 *
 * @param hotFor per-module hot contexts; production leaves this alone.
 */
export function createAppKernel(hotFor: HotContextSource = () => undefined): AppRuntime {
  const kernel = createKernel({
    modules: appModules,
    hmr: nativeHmrAdapter,
    // `StartupGate` renders the `whenStartupComplete()` rejection itself.
    // Suppress the default macrotask rethrow so React Native's LogBox does
    // not cover that deliberate failure screen.
    onFatal: () => {},
  });

  // **H2 — and under Metro this is a documented no-op, which is the point.**
  //
  // Each module's hot block is `if ((import.meta as HotImportMeta).hot) { … }`.
  // Metro has no `import.meta.hot`: it exposes a per-module CommonJS
  // `module.hot`, which a portable ESM file cannot name — and least of all
  // these files, whose own `module` export shadows the identifier. So
  // `selfAccept` is `undefined` in every one of them, `acceptHotUpdate`
  // returns immediately at its `context === undefined` guard, and editing a
  // module under Metro does not hot-replace it.
  //
  // These six lines are therefore *not* dead: they are the same lines the web
  // root runs, they are what a host supplying its own context would arm (the
  // `hotFor` seam, and `composition-root.test.ts` proves all six through it),
  // and issue #53 asks for the composition root to mirror the web one
  // "including calling each module's `acceptHotUpdate(kernel)`". Deleting
  // them because today's bundler ignores them would delete the seam that makes
  // an RN shim possible at all. The PR body records what was measured on
  // device rather than reasoned.
  //
  // One line per module and no loop, for the reason the web root gives: a
  // loop over a table hides which module was forgotten when one is.
  acceptAuthHotUpdate(kernel, hotFor('auth'));
  acceptDebugHotUpdate(kernel, hotFor('debug'));
  acceptPaymentsHotUpdate(kernel, hotFor('payments'));
  acceptOrdersHotUpdate(kernel, hotFor('orders'));
  acceptNavHotUpdate(kernel, hotFor('nav'));
  acceptDashboardHotUpdate(kernel, hotFor('dashboard'));
  // No `acceptHotUpdate` for the shell: it is app source rather than a module
  // package, exactly as on web.

  return { kernel };
}
