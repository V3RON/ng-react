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
import { DashboardModule } from '@app/dashboard/contract';
import { DebugModule } from '@app/debug/contract';
import { NavModule } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { module as authModule } from '@app/auth/module';
import { module as dashboardModule } from '@app/dashboard/module';
import { module as debugModule } from '@app/debug/module';
import { module as ordersModule } from '@app/orders/module';
import { module as paymentsModule } from '@app/payments/module';
import { module as navModule } from '@app/nav/module';
// **Not a package, and deliberately imported by a relative path.** The app
// shell (spec §3: "a folder treated as one") owns the demo's top-level route
// table; see `shell/module.ts` for why a lazy module cannot contribute the
// route that activates it. B1 governs cross-*package* imports and has nothing
// to say about an application's own folders.
import { module as shellModule, ShellModule } from './shell/module';
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
  // **Criterion 10**: the PoC navigation module, registered exactly like a
  // feature module and with no privileges of any kind. `nav` is eager because
  // the navigator has to be able to render the route that triggers the first
  // lazy activation; `shell` is eager because it *owns* that route.
  navModule,
  // **Issue #52**: the dashboard, an ordinary module owning an ordinary
  // collection token. Eager for the same reason `nav` is — a surface has to be
  // running before anything can be contributed *to* it and seen — and with no
  // privileges of any kind. Registered after `nav` because it contributes a
  // route and a menu entry to `nav`'s tokens; that is a readability choice
  // only, since a contribution creates no `dependsOn` edge (spec §17, M2) and
  // the kernel would have accepted either order.
  dashboardModule,
  shellModule,
];

/** Every ref the lifecycle log watches, in declaration order. Not exported: the UI names refs through their contracts. */
const appModuleRefs: readonly ModuleRef[] = [
  AuthModule,
  DebugModule,
  PaymentsModule,
  OrdersModule,
  NavModule,
  DashboardModule,
  ShellModule,
];

/** What `createAppKernel` hands back: the kernel plus the surfaces the UI reads. */
export interface AppRuntime {
  readonly kernel: Kernel;
  readonly log: LifecycleLog;
}

/**
 * Builds the application kernel.
 *
 * **No per-module HMR wiring here, and none in any module file either.**
 * Module-level hot replacement is provided out of the box by
 * `@ng-react/vite-plugin` (registered in `apps/react/vite.config.ts`): its
 * `transform` hook injects the literal `import.meta.hot.accept(...)` Vite's
 * static scan requires into each module entry file, and the injected code
 * calls `hotReplaceModule` from `@ng-react/kernel`, which looks up the
 * kernel(s) a descriptor was registered with and drives `kernel.hotReplace`
 * itself. This composition root does nothing but list the descriptors —
 * see `packages/vite-plugin` and `packages/ng-react/src/hmr/hot-module.ts`.
 *
 * **`hot` is a parameter**, defaulted to `import.meta.hot`, so a test can
 * build the real app without a bundler in the path. ADR-5 forbids *kernel*
 * code from naming a bundler's hot API; this is app code, and the
 * composition root is where an app is allowed to know what it is bundled
 * with.
 *
 * @param hot the host's hot context for the *kernel's* adapter. Defaults to
 *   `import.meta.hot`, which is `undefined` in a production build and under
 *   vitest — in which case `createViteHmrAdapter` yields the noop adapter.
 */
export function createAppKernel(hot: ViteHotContext | undefined = import.meta.hot): AppRuntime {
  const kernel = createKernel({
    modules: appModules,
    // `AppRoot` renders the `whenStartupComplete()` rejection itself.
    // Suppress the default macrotask rethrow so the browser's error overlay
    // does not cover that deliberate failure screen.
    onFatal: () => {},
    // **ADR-5**: the kernel's own bundler seam. Its only optional member is
    // `invalidate` — the escalation path when a hot update could not be
    // applied in place. Accepting an update in the first place is the
    // Vite plugin's job (see above), not this adapter's.
    hmr: createViteHmrAdapter(hot),
  });

  const { log } = attachLifecycleLog(kernel, appModuleRefs);

  return { kernel, log };
}
