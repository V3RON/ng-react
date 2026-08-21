// **H2 / ADR-5** — the HMR adapter.
//
// `.test.ts` → the **kernel** project (node, no DOM, no React renderer).
// `src/hmr/` is not `src/react/` (ADR-6), and this file proves the adapter
// needs neither a renderer nor a bundler: every `hot` context below is a
// plain object literal, which is exactly what "typed structurally" buys.

import { describe, expect, it } from 'vitest';

import { createNoopHmrAdapter, createViteHmrAdapter } from './adapter';
import type { HmrAdapter, ViteHotContext } from './adapter';

/**
 * A fake Vite hot context. Structurally typed against `ViteHotContext`, with
 * the escalations kept so a test can read them back — the whole point of
 * ADR-5's abstraction is that no bundler is needed here.
 */
function fakeHot(options: { readonly withInvalidate?: boolean } = {}) {
  const invalidations: (string | undefined)[] = [];

  const hot: ViteHotContext =
    options.withInvalidate === false
      ? {}
      : {
          invalidate(message?: string) {
            invalidations.push(message);
          },
        };

  return { hot, invalidations };
}

describe('createNoopHmrAdapter (H2)', () => {
  it('H2: is disabled and escalates nothing', () => {
    const adapter = createNoopHmrAdapter();
    expect(adapter.enabled).toBe(false);
    // #42: one member and one optional member. A seam that grew back an
    // `accept` or a `dispose` would be an interface nothing can call — see
    // the reasoning on `HmrAdapter` itself.
    expect(Object.keys(adapter)).toEqual(['enabled']);
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

  it('H2: invalidate forwards the chunk id and the reason as one message', () => {
    const bundler = fakeHot();
    const adapter = createViteHmrAdapter(bundler.hot);

    adapter.invalidate?.('payments', 'graph re-validation failed');
    adapter.invalidate?.('payments');

    expect(adapter.enabled).toBe(true);
    expect(bundler.invalidations).toEqual(['payments: graph re-validation failed', 'payments']);
  });

  it('H2: invalidate is a no-op against a hot context that has none', () => {
    const bundler = fakeHot({ withInvalidate: false });
    const adapter = createViteHmrAdapter(bundler.hot);
    expect(() => adapter.invalidate?.('payments', 'no invalidate here')).not.toThrow();
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
