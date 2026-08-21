// `.test.ts`, so this runs in the **node** project (AGENTS.md §3): no DOM,
// no React renderer. That is the machine check for ADR-6 on this file —
// `src/hmr/epoch.ts` is not under `src/react/`, so it may not import
// `react`, and if it ever does, this suite stops loading.

import { describe, expect, it, vi } from 'vitest';
import { EpochStore } from './epoch';

describe('EpochStore (H6)', () => {
  it('H6: a module that was never bumped has epoch 0', () => {
    const store = new EpochStore();
    expect(store.epochOf('payments')).toBe(0);
    expect(store.epochOf()).toBe(0);
  });

  it('H6: bump increments only the named module, and the global epoch', () => {
    const store = new EpochStore();

    store.bump('payments');
    store.bump('payments');
    store.bump('orders');

    expect(store.epochOf('payments')).toBe(2);
    expect(store.epochOf('orders')).toBe(1);
    expect(store.epochOf('analytics')).toBe(0);
    expect(store.epochOf()).toBe(3);
  });

  it('H6: notifies the bumped module’s subscribers and nobody else’s', () => {
    const store = new EpochStore();
    const payments = vi.fn();
    const orders = vi.fn();
    store.subscribe('payments', payments);
    store.subscribe('orders', orders);

    store.bump('payments');

    expect(payments).toHaveBeenCalledTimes(1);
    expect(orders).not.toHaveBeenCalled();
  });

  it('H6: a subscriber with no module id observes every bump', () => {
    const store = new EpochStore();
    const anyModule = vi.fn();
    store.subscribe(undefined, anyModule);

    store.bump('payments');
    store.bump('orders');

    expect(anyModule).toHaveBeenCalledTimes(2);
  });

  it('H6: does not fire on subscribe — the caller reads epochOf', () => {
    const store = new EpochStore();
    const callback = vi.fn();
    store.subscribe('payments', callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('H6: unsubscribe is idempotent and removes exactly its own subscription', () => {
    const store = new EpochStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe('payments', first);
    store.subscribe('payments', second);

    unsubscribeFirst();
    unsubscribeFirst();
    store.bump('payments');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('H6: the same callback subscribed twice gets two independent subscriptions', () => {
    const store = new EpochStore();
    const callback = vi.fn();
    const unsubscribe = store.subscribe('payments', callback);
    store.subscribe('payments', callback);

    unsubscribe();
    store.bump('payments');

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('H6: a subscriber unsubscribing mid-pass does not fire, and the pass completes', () => {
    const store = new EpochStore();
    const later = vi.fn();
    let unsubscribeLater = (): void => {};
    const first = vi.fn(() => {
      unsubscribeLater();
    });
    store.subscribe('payments', first);
    unsubscribeLater = store.subscribe('payments', later);
    const third = vi.fn();
    store.subscribe('payments', third);

    store.bump('payments');

    expect(first).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('H6: subscribing during a pass does not affect the in-flight pass', () => {
    const store = new EpochStore();
    const added = vi.fn();
    store.subscribe('payments', () => {
      store.subscribe('payments', added);
    });

    store.bump('payments');

    expect(added).not.toHaveBeenCalled();
  });

  it('H6: two stores are independent — no module-level state', () => {
    const a = new EpochStore();
    const b = new EpochStore();
    const onB = vi.fn();
    b.subscribe('payments', onB);

    a.bump('payments');

    expect(a.epochOf('payments')).toBe(1);
    expect(b.epochOf('payments')).toBe(0);
    expect(onB).not.toHaveBeenCalled();
  });
});
