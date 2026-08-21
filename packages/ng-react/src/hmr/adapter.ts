/**
 * The bundler-agnostic seam through which the kernel escalates a hot update
 * it could not apply.
 *
 * Escalation is the only direction: *accepting* an update is registered by
 * each module's own file, which names its bundler's hot API literally.
 * Bundlers decide self-acceptance by scanning a module's own source, so a
 * call routed through this interface would not be seen.
 */
export interface HmrAdapter {
  /**
   * Tells the bundler this update could not be applied in place.
   *
   * Optional — not every bundler has an equivalent, and a host that would
   * rather log than full-reload can leave it out.
   *
   * @param id The **kernel** module id the kernel failed to re-activate. An
   *   adapter may map it onto whatever its bundler calls that chunk.
   */
  invalidate?(id: string, reason?: string): void;
  /** Whether a hot runtime is present. `false` in a production build. */
  readonly enabled: boolean;
}

/**
 * The shape of Vite's `import.meta.hot`, declared structurally so this
 * package has no dependency on `vite`, not even a type-only one.
 *
 * A real `ImportMetaHot` satisfies it, and so does a plain object literal in
 * a test.
 */
export interface ViteHotContext {
  invalidate?(message?: string): void;
}

/**
 * Creates the Vite implementation of `HmrAdapter`.
 *
 * `id` and `reason` are joined into the single message Vite's `invalidate`
 * takes, so the module id survives into whatever the bundler logs.
 *
 * @param hot The host's own `import.meta.hot`. `undefined` — a production
 *   build — yields `createNoopHmrAdapter()`, so a host can call this
 *   unconditionally.
 *
 * @example
 * ```ts
 * const kernel = createKernel({ modules, hmr: createViteHmrAdapter(import.meta.hot) });
 * ```
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
 * Creates the `KernelOptions.hmr` default: an adapter that escalates nothing
 * and reports `enabled: false`. It omits `invalidate` rather than supplying
 * a no-op one.
 */
export function createNoopHmrAdapter(): HmrAdapter {
  return { enabled: false };
}
