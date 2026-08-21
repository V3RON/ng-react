// **H2 / ADR-5 — the HMR adapter.**
//
// ADR-5: "No kernel code may reference `import.meta.hot` or `module.hot`
// directly — only the adapter may." **This file is the only file in the
// package allowed to name a bundler's hot API**, and even here it does so
// only through a structural type: `createViteHmrAdapter` takes the `hot`
// object, it never reaches for `import.meta.hot` itself. That is what makes
// a plain object literal a valid test double, and it is why every HMR test
// in this package runs with no bundler in the path.
//
// **ADR-6 applies here too and is easy to get wrong.** `src/hmr/` is *not*
// `src/react/`: this file must never import `react`. The `node` test project
// (AGENTS.md §3) is the machine check.
//
// ---
//
// **H1 — and the component-level HMR handling that is deliberately absent.**
//
// This is the file where it would have been natural to also accept updates
// for screen and component chunks, keep a registry of mounted components,
// and re-render them on edit. There is none, and there must not be: H1 says
// "screens and ordinary components rely on React Fast Refresh untouched;
// the kernel does not interfere". React's own Fast Refresh runtime already
// preserves component state across edits and is installed by
// `@vitejs/plugin-react` / Metro's transformer. A second mechanism racing it
// would (a) be two ways to do one thing, and (b) actively break Fast
// Refresh's state preservation by remounting trees it was about to patch in
// place. The kernel's entire HMR surface is *module* re-activation plus the
// H6 epoch bump; a component picks the fresh instance up through
// `useService` without knowing an update happened.

/**
 * The bundler-agnostic HMR seam the kernel is written against (**H2**,
 * ADR-5).
 *
 * Three operations, and nothing else — anything a bundler offers beyond
 * these is not something the kernel is allowed to depend on:
 *
 *  - `accept(id, onUpdate)` — "when the chunk `id` is replaced, call
 *    `onUpdate`". The handler is what calls `kernel.hotReplace(ref, next)`.
 *  - `dispose(id, onDispose)` — "before the chunk `id` is replaced, call
 *    `onDispose`". For state the host owns and the kernel does not (ADR-3's
 *    `persistent: true` is the kernel's own answer for provider state).
 *  - `invalidate(id, reason)` — "I could not apply this update; escalate".
 *    Optional, because not every bundler has it, and because a host that
 *    would rather log than full-reload should be able to leave it out.
 *
 * `id` is opaque to the kernel: whatever string the *bundler* uses to name
 * the chunk being accepted (a module specifier under Vite, a numeric module
 * id under Metro). It is deliberately **not** a `ModuleRef` and deliberately
 * not a kernel module id — a kernel module id names a descriptor, and one
 * descriptor's implementation is spread over several chunks (`module.ts`,
 * `providers.ts`, `lifecycle.ts`), which is exactly the set H2 says to
 * accept updates for.
 */
export interface HmrAdapter {
  /** Registers `onUpdate` to run after the chunk `id` is hot-replaced. */
  accept(id: string, onUpdate: () => void): void;
  /** Registers `onDispose` to run before the chunk `id` is hot-replaced. */
  dispose(id: string, onDispose: () => void): void;
  /** Tells the bundler this update could not be applied in place. */
  invalidate?(id: string, reason?: string): void;
  /**
   * `false` in a production build, or when the host has no hot runtime. A
   * host guards its `accept` calls with this; the kernel guards its
   * `invalidate` calls with it, so a production kernel never asks a bundler
   * for anything.
   */
  readonly enabled: boolean;
}

/**
 * The shape of Vite's `import.meta.hot`, declared **structurally** so this
 * package has no dependency — not even a type-only one — on `vite`.
 *
 * A real `ImportMetaHot` is assignable to this: its `accept` is overloaded
 * and one of the overloads is `(dep: string, cb) => void`, its `dispose`
 * takes `(data: any) => void`, and its `invalidate(message?: string)`
 * satisfies the optional member here. So is a plain object literal in a
 * test, which is the point.
 */
export interface ViteHotContext {
  accept(dep: string, callback: (module: unknown) => void): void;
  dispose(callback: (data: unknown) => void): void;
  invalidate?(message?: string): void;
}

/**
 * ADR-5: the Vite implementation of `HmrAdapter`. `hot` is
 * `import.meta.hot` **passed in by the host** — this package never reads it.
 * `undefined` (a production build) yields the noop adapter, so a host can
 * write `createViteHmrAdapter(import.meta.hot)` unconditionally.
 *
 * Two mapping decisions worth stating, because Vite's API is not shaped
 * quite like `HmrAdapter`:
 *
 *  - `accept(id, onUpdate)` forwards to `hot.accept(id, cb)`, so `id` must
 *    be a specifier Vite can resolve from the accepting module — e.g.
 *    `'./providers'`. That is the same string the host already wrote in its
 *    `import`, which is why `HmrAdapter.accept` takes a bundler chunk id and
 *    not a kernel module id.
 *  - `dispose(id, onDispose)` cannot forward per-id: Vite's `hot.dispose` is
 *    per *hot context*, with no dep granularity. Handlers are therefore
 *    collected here and run together from a single `hot.dispose`
 *    registration, and `id` serves only to keep at most one handler per
 *    chunk (re-registering for the same id replaces the previous handler,
 *    which is what a re-evaluated module file does).
 *
 * **A Metro adapter is three lines against the same interface** and is
 * deliberately not shipped (principle 4 — no untested code):
 * `accept: (id, cb) => hot.accept(cb)` (Metro's `module.hot.accept` is
 * self-accepting and takes no dep), `dispose: (id, cb) => hot.dispose(cb)`,
 * and `enabled: hot !== undefined` — Metro's `module.hot` has no
 * `invalidate`, so that member is simply omitted.
 */
export function createViteHmrAdapter(hot: ViteHotContext | undefined): HmrAdapter {
  if (hot === undefined) {
    return createNoopHmrAdapter();
  }

  const disposeHandlers = new Map<string, () => void>();
  let disposeWired = false;

  return {
    enabled: true,
    accept(id: string, onUpdate: () => void): void {
      hot.accept(id, () => {
        onUpdate();
      });
    },
    dispose(id: string, onDispose: () => void): void {
      disposeHandlers.set(id, onDispose);
      if (disposeWired) {
        return;
      }
      disposeWired = true;
      hot.dispose(() => {
        // A copy: a handler that re-registers during the pass must not
        // change the pass in flight — the same rule every other
        // notification loop in this package follows.
        for (const handler of [...disposeHandlers.values()]) {
          handler();
        }
      });
    },
    invalidate(id: string, reason?: string): void {
      hot.invalidate?.(reason === undefined ? id : `${id}: ${reason}`);
    },
  };
}

/**
 * The `KernelOptions.hmr` default: an adapter that accepts nothing,
 * registers nothing and is `enabled: false`.
 *
 * It deliberately does **not** implement the optional `invalidate`. That
 * keeps the optional member genuinely optional — the kernel's call site is
 * `this.hmr.invalidate?.(…)`, and a noop that supplied a no-op `invalidate`
 * would mean nothing in the package ever exercised the absent case.
 */
export function createNoopHmrAdapter(): HmrAdapter {
  return {
    enabled: false,
    accept(): void {},
    dispose(): void {},
  };
}
