// **H3 / ADR-3** — `defineStore` and the four transfer branches.
//
// `.test.ts` → the **kernel** project (node). ADR-3's branches are exercised
// here against `transferPersistentState` directly, one branch per test;
// `kernel/hot-replace.test.ts` proves the same code runs on the real HMR
// path. Both matter: a branch table tested only end-to-end is a branch table
// where three of the four branches are never reached.

import { describe, expect, it, vi } from 'vitest';

import { PersistentTransferError } from '../errors';
import { provide } from '../provider';
import type { AnyProviderRecord } from '../provider';
import { createToken } from '../token';
import type { ErrorInfo } from '../types';
import { defineStore, transferPersistentState } from './persistent';
import type { Store } from './persistent';

// ---------------------------------------------------------------------------
// Fixtures — deliberately *differently* typed stores and tokens (AGENTS.md
// §9): a cart of records, a numeric counter, a class-based session, and a
// store whose state holds a closure (the branch-4 case that matters).
// ---------------------------------------------------------------------------

interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}
interface CartState {
  readonly lines: readonly CartLine[];
  readonly couponCode: string | undefined;
}
const CartStoreToken = createToken<Store<CartState>>('orders/CartStore');

const RetryCountToken = createToken<Store<number>>('orders/RetryCount');

interface DraftState {
  title: string;
  wordCount: number;
}
const DraftToken = createToken<DraftState>('editor/Draft');

/** A class instance: not a plain object, so branch 3 must refuse it. */
class SessionTracker {
  constructor(public visits: number) {}
}
const SessionTrackerToken = createToken<SessionTracker>('auth/SessionTracker');

/** A store whose state holds a callback — `structuredClone` cannot copy it. */
interface UploadState {
  readonly progress: number;
  readonly onDone: () => void;
}
const UploadStoreToken = createToken<Store<UploadState>>('uploads/UploadStore');

/** Collects what the F4 seam was handed. */
function collector() {
  const reports: { error: unknown; info: { moduleId?: string; phase: ErrorInfo['phase'] } }[] = [];
  return {
    reports,
    report: (error: unknown, info: { moduleId?: string; phase: ErrorInfo['phase'] }) => {
      reports.push({ error, info });
    },
  };
}

describe('defineStore (H3)', () => {
  it('H3: getState returns the initial state and setState replaces it', () => {
    const store = defineStore<CartState>({ lines: [], couponCode: undefined });
    expect(store.getState()).toEqual({ lines: [], couponCode: undefined });

    store.setState({ lines: [{ sku: 'ABC', quantity: 2 }], couponCode: 'SPRING' });
    expect(store.getState()).toEqual({ lines: [{ sku: 'ABC', quantity: 2 }], couponCode: 'SPRING' });
  });

  it('H3: setState accepts an updater over the previous state', () => {
    const store = defineStore(3);
    store.setState((previous) => previous + 4);
    expect(store.getState()).toBe(7);
  });

  it('H3: subscribe fires on every change, not on subscribe, and unsubscribes idempotently', () => {
    const store = defineStore(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    store.setState(1);
    store.setState(2);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    unsubscribe();
    store.setState(3);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toBe(3);
  });

  it('H3: two subscriptions from one function are two independent subscriptions', () => {
    const store = defineStore('idle');
    const listener = vi.fn();
    const first = store.subscribe(listener);
    store.subscribe(listener);

    store.setState('busy');
    expect(listener).toHaveBeenCalledTimes(2);

    first();
    store.setState('idle');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('H3: snapshot reads the state and restore adopts one, notifying subscribers', () => {
    const store = defineStore<CartState>({ lines: [{ sku: 'A', quantity: 1 }], couponCode: undefined });
    const snapshot = store.snapshot();

    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ lines: [], couponCode: 'X' });
    store.restore(snapshot);

    expect(store.getState()).toEqual({ lines: [{ sku: 'A', quantity: 1 }], couponCode: undefined });
    // Two notifications: one for setState, one for restore. `restore`
    // notifying is what makes a mounted component show the carried-over
    // state after an HMR cycle rather than the factory's initial value.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('transferPersistentState (ADR-3)', () => {
  it("ADR-3 branch 1: the provider's transfer hook is called and nothing else is", () => {
    const transfer = vi.fn((oldInstance: Store<number>, newInstance: Store<number>) => {
      newInstance.setState(oldInstance.getState() * 10);
    });
    const record: AnyProviderRecord = provide(RetryCountToken, {
      persistent: true,
      transfer,
      factory: () => defineStore(0),
    });

    const oldInstance = defineStore(4);
    const newInstance = defineStore(0);
    // Both also satisfy branch 2. Branch 1 must "call it and stop", so the
    // restore path must not run on top of the hook's own result.
    const restore = vi.spyOn(newInstance, 'restore');
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'orders', report: sink.report });

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith(oldInstance, newInstance);
    expect(newInstance.getState()).toBe(40);
    expect(restore).not.toHaveBeenCalled();
    expect(sink.reports).toEqual([]);
  });

  it('ADR-3 branch 2: snapshot() is structured-cloned into restore()', () => {
    const record: AnyProviderRecord = provide(CartStoreToken, {
      persistent: true,
      factory: () => defineStore<CartState>({ lines: [], couponCode: undefined }),
    });

    const lines: CartLine[] = [{ sku: 'DESK-1', quantity: 2 }];
    const oldInstance = defineStore<CartState>({ lines, couponCode: 'SPRING' });
    const newInstance = defineStore<CartState>({ lines: [], couponCode: undefined });
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'orders', report: sink.report });

    expect(newInstance.getState()).toEqual({ lines: [{ sku: 'DESK-1', quantity: 2 }], couponCode: 'SPRING' });
    expect(sink.reports).toEqual([]);
    // *Cloned*, not aliased: the new instance must not share mutable
    // structure with an object built by the previous generation of the
    // module's code.
    expect(newInstance.getState().lines).not.toBe(lines);
  });

  it('ADR-3 branch 3: own enumerable properties of two plain objects are cloned across', () => {
    const record: AnyProviderRecord = provide(DraftToken, {
      persistent: true,
      factory: (): DraftState => ({ title: '', wordCount: 0 }),
    });

    const oldInstance: DraftState = { title: 'Q3 retro', wordCount: 812 };
    const newInstance: DraftState = { title: '', wordCount: 0 };
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'editor', report: sink.report });

    expect(newInstance).toEqual({ title: 'Q3 retro', wordCount: 812 });
    expect(sink.reports).toEqual([]);
  });

  it('ADR-3 branch 4: a class instance is not a plain object — reported, fresh instance untouched', () => {
    const record: AnyProviderRecord = provide(SessionTrackerToken, {
      persistent: true,
      factory: () => new SessionTracker(0),
    });

    const oldInstance = new SessionTracker(17);
    const newInstance = new SessionTracker(0);
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'auth', report: sink.report });

    expect(newInstance.visits).toBe(0);
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0]?.info).toEqual({ moduleId: 'auth', phase: 'resolve' });
    const error = sink.reports[0]?.error;
    expect(error).toBeInstanceOf(PersistentTransferError);
    expect((error as PersistentTransferError).code).toBe('HMR_PERSISTENT_TRANSFER_FAILED');
    expect((error as PersistentTransferError).message).toBe(
      "Persistent state for 'auth/SessionTracker' (owned by 'auth') could not be carried across the HMR " +
        're-activation: it declares no transfer() hook, the old instance has no snapshot() paired with a ' +
        'restore() on the new one, and the two are not both plain objects. The freshly constructed instance ' +
        'keeps its initial state and nothing was thrown. Give the provider a transfer(oldInstance, ' +
        'newInstance) hook, or a snapshot()/restore() pair whose snapshot is structured-cloneable.',
    );
  });

  it('ADR-3 branch 4: a store holding a closure fails the clone rather than throwing', () => {
    const record: AnyProviderRecord = provide(UploadStoreToken, {
      persistent: true,
      factory: () => defineStore<UploadState>({ progress: 0, onDone: () => {} }),
    });

    // `structuredClone` throws DataCloneError on a function. ADR-3's
    // never-throw rule is the only thing between that and a dead HMR cycle.
    const oldInstance = defineStore<UploadState>({ progress: 62, onDone: () => {} });
    const newInstance = defineStore<UploadState>({ progress: 0, onDone: () => {} });
    const sink = collector();

    expect(() =>
      transferPersistentState({ record, oldInstance, newInstance, moduleId: 'uploads', report: sink.report }),
    ).not.toThrow();

    expect(newInstance.getState().progress).toBe(0);
    expect(sink.reports).toHaveLength(1);
    expect((sink.reports[0]?.error as PersistentTransferError).message).toBe(
      "Persistent state for 'uploads/UploadStore' (owned by 'uploads') could not be carried across the HMR " +
        're-activation: its snapshot() could not be cloned and restored. The freshly constructed instance ' +
        'keeps its initial state and nothing was thrown. Give the provider a transfer(oldInstance, ' +
        'newInstance) hook, or a snapshot()/restore() pair whose snapshot is structured-cloneable.',
    );
    // The DataCloneError is preserved, not swallowed.
    expect((sink.reports[0]?.error as PersistentTransferError).cause).toBeInstanceOf(Error);
  });

  it('ADR-3 branch 4: a transfer hook that throws is reported and never rethrown', () => {
    const record: AnyProviderRecord = provide(RetryCountToken, {
      persistent: true,
      transfer: () => {
        throw new Error('migration from v1 state shape failed');
      },
      factory: () => defineStore(0),
    });

    const oldInstance = defineStore(9);
    const newInstance = defineStore(0);
    const sink = collector();

    expect(() =>
      transferPersistentState({ record, oldInstance, newInstance, moduleId: 'orders', report: sink.report }),
    ).not.toThrow();

    expect(newInstance.getState()).toBe(0);
    expect((sink.reports[0]?.error as PersistentTransferError).message).toBe(
      "Persistent state for 'orders/RetryCount' (owned by 'orders') could not be carried across the HMR " +
        're-activation: its transfer(oldInstance, newInstance) hook threw. The freshly constructed instance ' +
        'keeps its initial state and nothing was thrown. Give the provider a transfer(oldInstance, ' +
        'newInstance) hook, or a snapshot()/restore() pair whose snapshot is structured-cloneable.',
    );
    expect(((sink.reports[0]?.error as PersistentTransferError).cause as Error).message).toBe(
      'migration from v1 state shape failed',
    );
  });

  it('ADR-3 branch 4: a failed branch-3 clone leaves the fresh instance untouched, not half-copied', () => {
    const record: AnyProviderRecord = provide(DraftToken, {
      persistent: true,
      factory: (): DraftState => ({ title: '', wordCount: 0 }),
    });

    // A plain object whose properties are not all cloneable. The clone runs
    // to completion (or not at all) before anything is assigned, so a
    // failure cannot leave `title` copied and `wordCount` stale.
    const oldInstance = { title: 'Q3 retro', wordCount: 812, format: () => 'md' };
    const newInstance: DraftState = { title: '', wordCount: 0 };
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'editor', report: sink.report });

    expect(newInstance).toEqual({ title: '', wordCount: 0 });
    expect((sink.reports[0]?.error as PersistentTransferError).message).toContain(
      'its own enumerable properties could not be structured-cloned',
    );
  });

  it('ADR-3: a snapshot() with no matching restore() falls through to the plain-object branch', () => {
    const record: AnyProviderRecord = provide(DraftToken, {
      persistent: true,
      factory: (): DraftState => ({ title: '', wordCount: 0 }),
    });

    // Branch 2 needs *both* halves: `snapshot` on the old instance and
    // `restore` on the new one. Half a pair is not a pair, so this falls
    // through to branch 3 — where the unpaired `snapshot` function is itself
    // an own enumerable property and is not cloneable, landing the whole
    // thing in branch 4. Pinned because it is the one case where the
    // branches interact, and because the outcome (report, fresh instance
    // untouched) is the one an author of a half-implemented store gets.
    const oldInstance = { title: 'Half a pair', wordCount: 3, snapshot: () => ({ title: 'ignored' }) };
    const newInstance: Record<string, unknown> = { title: '', wordCount: 0 };
    const sink = collector();

    transferPersistentState({ record, oldInstance, newInstance, moduleId: 'editor', report: sink.report });

    expect(newInstance).toEqual({ title: '', wordCount: 0 });
    expect((sink.reports[0]?.error as PersistentTransferError).message).toContain(
      'its own enumerable properties could not be structured-cloned',
    );
  });
});
