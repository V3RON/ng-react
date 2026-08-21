// `@app/payments/module` — the kernel-facing descriptor (spec §5.2).
//
// **B1**: this entry point may be imported only by the application's
// composition root; every other importer uses `@app/payments/contract`.
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
import { PaymentsModule } from './contract';

export const module = defineModule({
  // **D2**: the module's own ref, imported from its own contract. The
  // descriptor never re-states the id string.
  id: PaymentsModule,
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
 * literal is then a valid test double, which is what makes `acceptHotUpdate`
 * testable with no bundler in the path.
 */
export interface ModuleHotContext {
  accept(callback: (next?: unknown) => void): void;
}

/** What a re-evaluated copy of *this* file exposes to the callback below. */
interface PaymentsModuleExports {
  readonly module?: ModuleDescriptor;
  readonly acceptHotUpdate?: (kernel: Kernel, hot?: ModuleHotContext) => void;
}

/** `import.meta` widened with the hot context a dev bundler puts on it. */
type HotImportMeta = ImportMeta & { hot?: ModuleHotContext };

/**
 * Callbacks subscribed through `selfAccept`, in subscription order. Empty in
 * a production build and under vitest, where nothing ever subscribes.
 */
const selfAcceptCallbacks: ((next?: unknown) => void)[] = [];

/**
 * The hot context `acceptHotUpdate` uses when the host passes none: a
 * `ModuleHotContext` backed by the literal self-accept below. `undefined`
 * wherever there is no `import.meta.hot` — a production build, vitest, and
 * Metro (see the portability note on `acceptHotUpdate`).
 */
let selfAccept: ModuleHotContext | undefined;

// **H2 — the literal self-accept, and why it is written exactly like this.**
//
// **Vite decides whether a module is self-accepting by lexically scanning
// this file's source for `import.meta.hot.accept`** during import analysis.
// It is a static scan, not a runtime observation, so a call reached through
// *any* indirection — a parameter, a local alias, an adapter — is invisible
// to it: the module is treated as non-self-accepting, the update propagates
// to this file's importers, and Vite falls back to a **full page reload**.
// That is what the first version of this block did, on every edit, for the
// whole of stage 7 (issue #46; spec §17).
//
// Hence: literal and top-level. Which means it runs
// at **module evaluation time**, long before the composition root exists to
// hand this module a kernel — so it cannot itself be the callback that does
// the work. What it registers is a *dispatcher*: one registration with Vite,
// forwarding to whatever has subscribed through `selfAccept` by the time an
// edit actually arrives. That keeps one mechanism rather than two, because
// `selfAccept` is an ordinary `ModuleHotContext` — the same shape a non-Vite
// host passes in — and `acceptHotUpdate` cannot tell the difference.
//
// **No ambient kernel** (issue #41's decision, unchanged): the dispatcher
// holds callbacks and never a kernel. A kernel reaches this file only by
// being handed to `acceptHotUpdate` explicitly, so two kernels in one process
// (R4's test kernels) subscribe two callbacks, each closing over its own
// kernel, and neither can observe the other.
//
// The `as` cast is what keeps the emitted call literal: `import.meta.hot` is
// not a member of `ImportMeta` in a package that owns no bundler types, and
// a `const hot = import.meta.hot` alias would erase to `hot.accept(…)` —
// precisely the indirection that caused #46. A type assertion erases to
// nothing, so what Vite scans is `import.meta.hot?.accept(…)`, and its lexer
// allows exactly that one optional `?` between `.hot` and `.accept`.
if ((import.meta as HotImportMeta).hot) {
  selfAccept = {
    accept: (callback) => {
      selfAcceptCallbacks.push(callback);
    },
  };
  (import.meta as HotImportMeta).hot?.accept((next) => {
    // A copy: a callback that subscribes during the pass — the re-arm below
    // does exactly that on the fresh copy — must not change the pass in
    // flight.
    for (const callback of [...selfAcceptCallbacks]) {
      callback(next);
    }
  });
}

/**
 * **H2 — arms this module's hot block with the kernel it belongs to.**
 *
 * Spec §11 H2 says "the kernel registers HMR acceptance for descriptor,
 * lifecycle and provider chunks". It cannot: a kernel module id (`'payments'`)
 * is not a bundler chunk id, only this file knows its own specifier, and only
 * a re-evaluated copy of this file holds the *new* descriptor. So `accept` is
 * called here, by the module, and calls `kernel.hotReplace(ref, next)`
 * (spec §17; `KernelOptions.hmr`).
 *
 * That leaves one problem, and this function is the answer to it: **a module
 * must not import the composition root** (B1), so this file has no way to
 * reach a kernel. It therefore takes one — the composition root, which owns
 * the kernel and already imports `@app/payments/module`, calls this once:
 *
 * ```ts
 * import { module as paymentsModule, acceptHotUpdate } from '@app/payments/module';
 * const kernel = createKernel({ modules: [paymentsModule, …] });
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
 * It forwards **the `hot` it was given, not the context it resolved**, and
 * the difference is load-bearing in both directions. An injected context
 * belongs to the *host*, not to a particular evaluation of this file, so
 * re-reading the default would drop an RN shim or a test double on the very
 * first edit — it is passed on. The Vite default must *not* be passed on:
 * `selfAccept` dispatches through the `import.meta.hot` registration made by
 * *this* evaluation, and Vite clears those callbacks when the fresh copy
 * registers its own. Forwarding it would re-arm the kernel into a dispatcher
 * nothing will ever call again — the second edit would then be accepted and
 * silently do nothing, which is worse than a reload. The fresh copy resolves
 * its own `selfAccept` instead, which is the one its literal block just wired.
 *
 * ---
 *
 * ### Portability: the block above is Vite-only. Read this before shipping to React Native.
 *
 * `import.meta.hot` is the Vite / Rollup convention. **Metro does not have
 * it.** Metro exposes a *per-module* `module.hot`, a CommonJS-era local
 * binding that a portable ESM file cannot name at all — and least of all this
 * one, whose own `module` export shadows the identifier. So under Metro
 * `selfAccept` is `undefined`, this whole block is a **silent no-op**, and
 * edits fall back to whatever Metro does with an unaccepted update: the
 * module still works, it just never hot-replaces.
 *
 * That is why `hot` is a parameter. An RN host supplies its own context:
 *
 * ```ts
 * // from a file that has `module` in scope, in a Metro build
 * acceptHotUpdate(kernel, { accept: (cb) => module.hot.accept(() => cb(freshExports)) });
 * ```
 *
 * and it has to do the `freshExports` part itself, because **Metro's
 * self-accepting callback receives no module namespace** — it is called after
 * the new copy has been evaluated, with no arguments. A shim that just
 * forwards `module.hot.accept(cb)` would hand `undefined` to the callback
 * below, which then takes the "no exports" branch and does nothing, silently.
 *
 * **Say plainly what that shim does and does not buy**, because the sentence
 * above is the whole of the RN story and it is weaker than it looks: the
 * shim's `module.hot` is *its own* chunk's, not this file's. It therefore
 * accepts updates for every module the shim's file imports, cannot tell which
 * of them changed, and must re-read the namespace itself. Per-module Metro
 * self-acceptance needs a Metro-side entry file per module, or a transform,
 * and this generator emits neither. **None of this is verified**: there is no
 * React Native app in this repo, so the paragraph above is reasoning, not
 * evidence — unlike the Vite half, which is measured (issue #46).
 *
 * ADR-5 forbids *kernel* code from naming a bundler's hot API. This is app
 * code, and `import.meta` is read through a cast so the package needs no
 * `vite/client` types.
 *
 * @param kernel the kernel this module is registered with.
 * @param hot the host's hot context. Defaults to the literal self-accept
 *   above; pass one explicitly on a bundler that is not Vite, or in a test.
 */
export function acceptHotUpdate(kernel: Kernel, hot?: ModuleHotContext): void {
  const context = hot ?? selfAccept;
  if (context === undefined) {
    return;
  }
  context.accept((next) => {
    const replacement = next as PaymentsModuleExports | undefined;
    // No exports means either a syntax error in the edited file or a host
    // whose accept callback does not pass a namespace (Metro — see above).
    // Returning leaves the old descriptor in force and the module running the
    // code it was running, which is the same outcome `hotReplace` chooses for
    // a replacement that fails graph re-validation (§17).
    if (replacement?.module === undefined) {
      return;
    }
    void kernel.hotReplace(PaymentsModule, replacement.module);
    replacement.acceptHotUpdate?.(kernel, hot);
  });
}
