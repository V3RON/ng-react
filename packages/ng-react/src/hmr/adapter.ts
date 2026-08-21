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
 * **One operation, and that is a finding rather than a design** (issue #42,
 * settled by the measurement in #46). This interface shipped with four
 * members — `accept`, `dispose`, `invalidate`, `enabled` — of which the
 * kernel ever called one. The other two were not merely unused; they are
 * **unusable**:
 *
 *  - `accept` cannot be the kernel's: a kernel module id (`payments`) is not
 *    a bundler chunk id, only a module's own files know their specifiers, and
 *    only the re-evaluated `module.ts` holds the *new* descriptor (§17).
 *  - `accept` cannot be the *module's* either, routed through here or through
 *    any other indirection: **Vite decides self-acceptance by lexically
 *    scanning a module's own source for `import.meta.hot.accept`**, so a call
 *    reached through an adapter is invisible to it and every edit becomes a
 *    full page reload. Measured on a real dev server (#46). No typing of
 *    `accept` survives a static scan, which makes this a fact and not a
 *    preference.
 *  - `dispose` had no call site and no candidate one: the kernel's own
 *    pre-replacement teardown is `hotReplace`, and ADR-3's `persistent: true`
 *    is its answer for provider state.
 *
 * So the seam is what the kernel actually needs from a bundler and nothing
 * else — `invalidate(id, reason)`: "I could not apply this update; escalate".
 * Optional, because not every bundler has it, and because a host that would
 * rather log than full-reload should be able to leave it out. The `accept`
 * half of HMR lives in each module's own hot block, which names
 * `import.meta.hot` literally; that is now the documented, blessed pattern
 * rather than a bypass of this interface.
 *
 * `id` is the **kernel** module id here, because the kernel is naming the
 * module it failed to re-activate; an adapter is free to map it onto
 * whatever its bundler calls that chunk.
 */
export interface HmrAdapter {
  /** Tells the bundler this update could not be applied in place. */
  invalidate?(id: string, reason?: string): void;
  /**
   * `false` in a production build, or when the host has no hot runtime. The
   * kernel guards its `invalidate` calls with it, so a production kernel
   * never asks a bundler for anything.
   */
  readonly enabled: boolean;
}

/**
 * The shape of Vite's `import.meta.hot`, declared **structurally** so this
 * package has no dependency — not even a type-only one — on `vite`.
 *
 * One member, for the same reason `HmrAdapter` has one: a real
 * `ImportMetaHot`'s `invalidate(message?: string)` satisfies it, and so does
 * a plain object literal in a test, which is the point. A host still writes
 * `createViteHmrAdapter(import.meta.hot)` unchanged — the narrower type takes
 * the same argument, it just stops claiming the kernel will call the rest
 * of it.
 */
export interface ViteHotContext {
  invalidate?(message?: string): void;
}

/**
 * ADR-5: the Vite implementation of `HmrAdapter`. `hot` is
 * `import.meta.hot` **passed in by the host** — this package never reads it.
 * `undefined` (a production build) yields the noop adapter, so a host can
 * write `createViteHmrAdapter(import.meta.hot)` unconditionally.
 *
 * One mapping decision, because Vite's `invalidate` takes a single message
 * while `HmrAdapter.invalidate` takes an id and a reason: they are joined
 * into one string, so the module id survives into whatever the bundler logs.
 *
 * **A Metro adapter is one line against the same interface** and is
 * deliberately not shipped (principle 4 — no untested code): Metro's
 * `module.hot` has no `invalidate` at all, so it is `{ enabled: true }` with
 * the optional member omitted — exactly the case `createNoopHmrAdapter`
 * keeps exercised.
 */
export function createViteHmrAdapter(hot: ViteHotContext | undefined): HmrAdapter {
  if (hot === undefined) {
    return createNoopHmrAdapter();
  }

  return {
    enabled: true,
    invalidate(id: string, reason?: string): void {
      hot.invalidate?.(reason === undefined ? id : `${id}: ${reason}`);
    },
  };
}

/**
 * The `KernelOptions.hmr` default: an adapter that escalates nothing and is
 * `enabled: false`.
 *
 * It deliberately does **not** implement the optional `invalidate`. That
 * keeps the optional member genuinely optional — the kernel's call site is
 * `this.hmr.invalidate?.(…)`, and a noop that supplied a no-op `invalidate`
 * would mean nothing in the package ever exercised the absent case.
 */
export function createNoopHmrAdapter(): HmrAdapter {
  return { enabled: false };
}
