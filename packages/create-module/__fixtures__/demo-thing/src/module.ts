// `@app/demo-thing/module` — the kernel-facing descriptor (spec §5.2).
//
// **B1**: this entry point may be imported only by the application's
// composition root; every other importer uses `@app/demo-thing/contract`.
//
// **D1**: nothing below evaluates an implementation file. `providers` and
// `init` are thunks, and the kernel calls them only at activation — which is
// what makes `load: 'lazy'` mean anything and what acceptance criterion 9
// measures. **ADR-7**: this repo is ESM-only, so the blessed thunk form is
// `() => import('./x').then(m => m.y)`, not the spec's CommonJS `require`.
//
// **ADR-9**: the descriptor has exactly seven fields. `dispose` is absent on
// purpose (**D4**, spec §8) — see `lifecycle.ts`.

import { defineModule } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor } from '@ng-react/kernel';
import { DemoThingModule } from './contract';

export const module = defineModule({
  // **D2**: the module's own ref, imported from its own contract. The
  // descriptor never re-states the id string.
  id: DemoThingModule,
  // **D3**: the only inter-module ordering mechanism. Listing a ref does not
  // grant import access to that module's implementation — only its contract
  // is importable, and that is true with or without this list.
  dependsOn: [],
  load: 'lazy',
  critical: false,
  providers: () => import('./providers').then((m) => m.providers),
  init: (ctx) => import('./lifecycle').then((m) => m.init(ctx)),
});

/**
 * The **structural** shape of a hot context this module can accept updates
 * through. Declared here rather than imported so this package depends on no
 * bundler, not even for a type — and declared *structurally*, for the same
 * reason `ViteHotContext` is in the kernel's `hmr/adapter.ts`: a plain object
 * literal is then a valid test double, which is what makes the block below
 * testable at all.
 */
export interface ModuleHotContext {
  accept(callback: (next?: unknown) => void): void;
}

/** What a re-evaluated copy of *this* file exposes to the callback below. */
interface DemoThingModuleExports {
  readonly module?: ModuleDescriptor;
  readonly acceptHotUpdate?: (kernel: Kernel, hot?: ModuleHotContext) => void;
}

/**
 * **H2 — the module's own hot-update block.**
 *
 * Spec §11 H2 says "the kernel registers HMR acceptance for descriptor,
 * lifecycle and provider chunks". It cannot: a kernel module id (`'demo-thing'`)
 * is not a bundler chunk id, only this file knows its own specifier, and only
 * a re-evaluated copy of this file holds the *new* descriptor. So `accept` is
 * called here, by the module, and calls `kernel.hotReplace(ref, next)`
 * (spec §17; `KernelOptions.hmr`).
 *
 * That leaves one problem, and this function is the answer to it: **a module
 * must not import the composition root** (B1), so this file has no way to
 * reach a kernel. It therefore takes one — the composition root, which owns
 * the kernel and already imports `@app/demo-thing/module`, calls this once:
 *
 * ```ts
 * import { module as demoThingModule, acceptHotUpdate } from '@app/demo-thing/module';
 * const kernel = createKernel({ modules: [demoThingModule, …] });
 * acceptHotUpdate(kernel);
 * ```
 *
 * Explicit over implicit (principle 3): no module-level "current kernel", no
 * global registry, and two kernels in one process (R4's test kernels) stay
 * isolated because each is handed to the modules it actually runs.
 *
 * The self-accept re-arms itself: a bundler that hot-replaces this file
 * evaluates the new copy and hands its exports to the callback below, but
 * does **not** re-run the composition root — so the callback passes the same
 * kernel to the fresh copy's `acceptHotUpdate` before returning. Without that
 * line the second edit would fall through to a full reload. `module.test.ts`
 * covers all three branches; that line in particular is asserted, not just
 * written.
 *
 * It passes the same **hot context** along too, rather than letting the fresh
 * copy re-read the default. The context belongs to the *host*, not to a
 * particular evaluation of this file, so re-reading the default would drop an
 * injected one — an RN shim, or a test double — on the very first edit. Under
 * Vite the old and new contexts address the same module path, so registering
 * through either lands in the same place.
 *
 * ---
 *
 * ### Portability: this block is Vite-only today. Read this before shipping to React Native.
 *
 * The `hot` parameter defaults to `import.meta.hot`, which is the Vite /
 * Rollup convention. **Metro does not have it.** Metro exposes a *per-module*
 * `module.hot`, which is a CommonJS-era local binding and is simply not
 * reachable from a portable ESM file — so on React Native the default lookup
 * yields `undefined` and this block is a **silent no-op**: the module still
 * works, it just never hot-replaces, and edits fall back to whatever Metro
 * does with an unaccepted update.
 *
 * That is why `hot` is a parameter. An RN host supplies its own:
 *
 * ```ts
 * // in a Metro build, from a file that has `module` in scope
 * acceptHotUpdate(kernel, { accept: (cb) => module.hot.accept(() => cb(freshExports)) });
 * ```
 *
 * and it has to do the `freshExports` part itself, because **Metro's
 * self-accepting callback receives no module namespace** — it is called after
 * the new copy has been evaluated, with no arguments. A shim that just
 * forwards `module.hot.accept(cb)` would hand `undefined` to the callback
 * below, which then takes the "no exports" branch and does nothing, silently.
 * Passing the fresh exports is the whole job of the RN shim.
 *
 * ADR-5 forbids *kernel* code from naming a bundler's hot API. This is app
 * code, and `import.meta` is read through a cast so the package needs no
 * `vite/client` types.
 *
 * @param kernel the kernel this module is registered with.
 * @param hot the host's hot context. Defaults to `import.meta.hot`; pass one
 *   explicitly on a bundler that is not Vite, or in a test.
 */
export function acceptHotUpdate(
  kernel: Kernel,
  hot: ModuleHotContext | undefined = (import.meta as ImportMeta & { hot?: ModuleHotContext }).hot,
): void {
  if (hot === undefined) {
    return;
  }
  hot.accept((next) => {
    const replacement = next as DemoThingModuleExports | undefined;
    // No exports means either a syntax error in the edited file or a host
    // whose accept callback does not pass a namespace (Metro — see above).
    // Returning leaves the old descriptor in force and the module running the
    // code it was running, which is the same outcome `hotReplace` chooses for
    // a replacement that fails graph re-validation (§17).
    if (replacement?.module === undefined) {
      return;
    }
    void kernel.hotReplace(DemoThingModule, replacement.module);
    replacement.acceptHotUpdate?.(kernel, hot);
  });
}
