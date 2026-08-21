// **H2 / ADR-5** — the HMR adapter.
//
// `.test.ts` → the **kernel** project (node, no DOM, no React renderer).
// `src/hmr/` is not `src/react/` (ADR-6), and this file proves the adapter
// needs neither a renderer nor a bundler: every `hot` context below is a
// plain object literal, which is exactly what "typed structurally" buys.

import { describe, expect, it, vi } from 'vitest';

import { createNoopHmrAdapter, createViteHmrAdapter } from './adapter';
import type { HmrAdapter, ViteHotContext } from './adapter';

/**
 * A fake Vite hot context. Structurally typed against `ViteHotContext`, with
 * the accepted callbacks kept so a test can *fire* an update — the whole
 * point of ADR-5's abstraction.
 */
function fakeHot(options: { readonly withInvalidate?: boolean } = {}) {
  const accepted = new Map<string, (module: unknown) => void>();
  const disposeHandlers: ((data: unknown) => void)[] = [];
  const invalidations: (string | undefined)[] = [];

  const hot: ViteHotContext = {
    accept(dep, callback) {
      accepted.set(dep, callback);
    },
    dispose(callback) {
      disposeHandlers.push(callback);
    },
    ...(options.withInvalidate === false
      ? {}
      : {
          invalidate(message?: string) {
            invalidations.push(message);
          },
        }),
  };

  return {
    hot,
    accepted,
    disposeHandlers,
    invalidations,
    /** Simulates the bundler replacing `dep`. */
    fireUpdate(dep: string): void {
      accepted.get(dep)?.({});
    },
    /** Simulates the bundler tearing the old chunk down. */
    fireDispose(): void {
      for (const handler of [...disposeHandlers]) {
        handler({});
      }
    },
  };
}

describe('createNoopHmrAdapter (H2)', () => {
  it('H2: is disabled and registers nothing', () => {
    const adapter = createNoopHmrAdapter();
    expect(adapter.enabled).toBe(false);
    expect(() => adapter.accept('./providers', () => {})).not.toThrow();
    expect(() => adapter.dispose('./providers', () => {})).not.toThrow();
  });

  it('H2: omits the optional invalidate, so the kernel exercises the absent case', () => {
    const adapter: HmrAdapter = createNoopHmrAdapter();
    expect(adapter.invalidate).toBeUndefined();
    // The kernel's own call shape. It must be a no-op, not a TypeError.
    expect(() => adapter.invalidate?.('payments', 'nope')).not.toThrow();
  });
});

describe('createViteHmrAdapter (H2, ADR-5)', () => {
  it('H2: an undefined hot context (a production build) yields the noop adapter', () => {
    const adapter = createViteHmrAdapter(undefined);
    expect(adapter.enabled).toBe(false);
    expect(adapter.invalidate).toBeUndefined();
  });

  it('H2: accept forwards the chunk id to hot.accept and runs onUpdate when it fires', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);
    const onUpdate = vi.fn();

    adapter.accept('./providers', onUpdate);
    expect(adapter.enabled).toBe(true);
    expect([...bundler.accepted.keys()]).toEqual(['./providers']);
    expect(onUpdate).not.toHaveBeenCalled();

    bundler.fireUpdate('./providers');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // The bundler's module object is not forwarded: `HmrAdapter.accept`'s
    // callback takes nothing, so a host cannot come to depend on a Vite
    // payload shape (ADR-5).
    expect(onUpdate).toHaveBeenCalledWith();
  });

  it('H2: accept registers one hot.accept per chunk id, independently fired', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);
    const onProviders = vi.fn();
    const onLifecycle = vi.fn();

    adapter.accept('./providers', onProviders);
    adapter.accept('./lifecycle', onLifecycle);

    bundler.fireUpdate('./lifecycle');
    expect(onProviders).not.toHaveBeenCalled();
    expect(onLifecycle).toHaveBeenCalledTimes(1);
  });

  it('H2: dispose wires hot.dispose exactly once and runs every registered handler', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);
    const first = vi.fn();
    const second = vi.fn();

    adapter.dispose('./providers', first);
    adapter.dispose('./lifecycle', second);
    // Vite's dispose is per hot context, not per dep: one registration, two
    // handlers behind it.
    expect(bundler.disposeHandlers).toHaveLength(1);

    bundler.fireDispose();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('H2: re-registering dispose for one chunk id replaces the previous handler', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);
    const stale = vi.fn();
    const fresh = vi.fn();

    adapter.dispose('./providers', stale);
    adapter.dispose('./providers', fresh);
    bundler.fireDispose();

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('H2: invalidate forwards the chunk id and the reason as one message', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);

    adapter.invalidate?.('./module', 'graph re-validation failed');
    adapter.invalidate?.('./module');

    expect(bundler.invalidations).toEqual(['./module: graph re-validation failed', './module']);
  });

  it('H2: invalidate is a no-op against a hot context that has none', () => {
    const bundler = fakeHot({ withInvalidate: false });
    const adapter = createViteHmrAdapter(bundler.hot);
    expect(() => adapter.invalidate?.('./module', 'no invalidate here')).not.toThrow();
    expect(bundler.invalidations).toEqual([]);
  });
});

// **ADR-5's exemption list is one file long**, and this file is where a
// machine check for it would have gone: walk `src/`, and assert that no
// source but `hmr/adapter.ts` contains the string `import.meta.hot` or
// `module.hot`. It is not here because it cannot be written in this package
// — `packages/ng-react/tsconfig.json` sets `types: ["vitest/globals"]`, under
// which `node:fs` has no type declarations (`TS2307`), and the tsconfig is
// out of scope for this task. See the PR body; the check belongs with the
// other workspace-wide rules in `@ng-react/eslint-config-modules`.
