// **The composition root** (spec §4, §6, **B1**).
//
// This is the only file in the workspace that imports `<pkg>/module`. Every
// other file — components, tests, the modules themselves — reaches a module
// through `<pkg>/contract`. That is B1, and it is enforced here rather than
// merely stated: the root `eslint.config.js` points
// `ng-react-modules/module-entry-only-in-composition-root` at *this file's
// path*, so an `import … from '@app/auth/module'` anywhere else is a lint
// error. The PR body carries the verbatim message from a probe that did it.
//
// Two things are deliberately *not* here:
//
//  - **No kernel instance at module scope.** `createAppKernel()` builds one on
//    call, so importing this file has no side effects and a test can stand up
//    its own isolated app (**R1**: exactly one `<AppKernel>` per kernel, and
//    two kernels never share state).
//  - **No providers.** The root has no `override: true` of its own; the demo
//    has nothing to mock in production. C6's escape hatch is available here
//    and used only by tests, which is what the lint rule's `testGlobs`
//    exemption is for.

import { createKernel, createViteHmrAdapter } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef, ViteHotContext } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { DebugModule } from '@app/debug/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { acceptHotUpdate as acceptAuthHotUpdate, module as authModule } from '@app/auth/module';
import type { ModuleHotContext } from '@app/auth/module';
import { acceptHotUpdate as acceptDebugHotUpdate, module as debugModule } from '@app/debug/module';
import { acceptHotUpdate as acceptOrdersHotUpdate, module as ordersModule } from '@app/orders/module';
import {
  acceptHotUpdate as acceptPaymentsHotUpdate,
  module as paymentsModule,
} from '@app/payments/module';
import { attachLifecycleLog } from './lifecycle-log';
import type { LifecycleLog } from './lifecycle-log';

/**
 * The full descriptor list (spec §6: "the composition root passes the full
 * descriptor list to the kernel").
 *
 * Order is declaration order, not activation order — the kernel topologically
 * sorts `dependsOn` itself (**G1/G3**) and activates the eager ones in that
 * order. `debug` sits second precisely to make that visible: it is listed
 * before the two lazy modules and still never delays them, because it is
 * quarantined rather than awaited (**F3**).
 */
export const appModules: readonly ModuleDescriptor[] = [
  authModule,
  debugModule,
  paymentsModule,
  ordersModule,
];

/** Every ref the lifecycle log watches, in declaration order. Not exported: the UI names refs through their contracts. */
const appModuleRefs: readonly ModuleRef[] = [
  AuthModule,
  DebugModule,
  PaymentsModule,
  OrdersModule,
];

/**
 * Supplies the hot context each module's `acceptHotUpdate` should register
 * through, by module id — or `undefined` to let the module read its own.
 *
 * **Production always returns `undefined`, and that is not a fallback.** Under
 * Vite, `import.meta.hot` in *this* file addresses *this* file: a self-accept
 * registered through it would accept updates to the composition root, not to
 * `@app/auth/module`. Only a module's own file can accept its own updates, so
 * the right production call is `acceptAuthHotUpdate(kernel)` with no context —
 * and passing an explicit `undefined` is identical to omitting the argument,
 * because that is what a default parameter means.
 *
 * The seam exists so the four calls below are *testable*: without it, deleting
 * one of them would break HMR for that module and no test in the workspace
 * would notice — a rule documented and not enforced (principle 4).
 */
export type HotContextSource = (moduleId: string) => ModuleHotContext | undefined;

/** What `createAppKernel` hands back: the kernel plus the surfaces the UI reads. */
export interface AppRuntime {
  readonly kernel: Kernel;
  readonly log: LifecycleLog;
}

/**
 * Builds the application kernel.
 *
 * **`hot` is a parameter**, defaulted to `import.meta.hot`, for the same
 * reason the generated modules' `acceptHotUpdate` does it: a test must be able
 * to build the real app without a bundler in the path, and a non-Vite host
 * must be able to pass its own. ADR-5 forbids *kernel* code from naming a
 * bundler's hot API; this is app code, and the composition root is where an
 * app is allowed to know what it is bundled with.
 *
 * @param hot the host's hot context for the *kernel's* adapter. Defaults to
 *   `import.meta.hot`, which is `undefined` in a production build and under
 *   vitest — in which case `createViteHmrAdapter` yields the noop adapter
 *   (H2's "a production kernel never asks a bundler for anything").
 * @param hotFor per-module hot contexts. See `HotContextSource`: production
 *   leaves this alone, and a test uses it to prove every module was armed.
 */
export function createAppKernel(
  hot: ViteHotContext | undefined = import.meta.hot,
  hotFor: HotContextSource = () => undefined,
): AppRuntime {
  const kernel = createKernel({
    modules: appModules,
    // **ADR-5**: the kernel's own bundler seam. Worth being precise about
    // what this buys today, because issue #42 is open on exactly this: of
    // `HmrAdapter`'s four members the kernel calls only `invalidate` — the
    // escalation path when a hot update could not be applied in place. The
    // `accept` half of HMR is wired by the four `acceptHotUpdate` calls
    // below, which reach `import.meta.hot` directly from each module's own
    // file, because only that file knows its own specifier and only its
    // re-evaluated copy holds the new descriptor (§17). So this line is not
    // what makes editing a module work; it is what makes a *failed* hot
    // update fall back to a reload instead of leaving a half-dead app.
    hmr: createViteHmrAdapter(hot),
  });

  // **H2 — the obligation the kernel cannot discharge for itself.** Each
  // module exports `acceptHotUpdate(kernel)` alongside its descriptor, and a
  // module may not import the composition root (B1), so the root hands each
  // one the kernel. Without these four lines the hot blocks are armed
  // nowhere and every edit falls through to a full page reload.
  //
  // One line per module, and no loop: the pairing of a descriptor with its
  // own accept function is a fact about each package, and a loop over a table
  // would only hide which module was forgotten when one is.
  acceptAuthHotUpdate(kernel, hotFor('auth'));
  acceptDebugHotUpdate(kernel, hotFor('debug'));
  acceptPaymentsHotUpdate(kernel, hotFor('payments'));
  acceptOrdersHotUpdate(kernel, hotFor('orders'));

  const { log } = attachLifecycleLog(kernel, appModuleRefs);

  return { kernel, log };
}
