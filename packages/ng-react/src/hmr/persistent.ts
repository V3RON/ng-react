import { PersistentTransferError } from '../errors';
import type { AnyProviderRecord } from '../provider';
import type { ErrorReporter, Unsubscribe } from '../types';

/**
 * A minimal observable state container whose contents survive a hot reload.
 *
 * `getState`/`setState`/`subscribe` are the consumer surface;
 * `snapshot`/`restore` are what `transferPersistentState` duck-types against
 * to carry state onto the replacement instance.
 */
export interface Store<S> {
  /** Returns the current state. Referentially stable until the next `setState` or `restore`. */
  getState(): S;
  /** Replaces the state, either outright or from the previous value, then notifies. */
  setState(next: S | ((previous: S) => S)): void;
  /**
   * Calls `listener` after every state change.
   *
   * Does not fire on subscribe — read the current value with `getState`. The
   * returned `Unsubscribe` is idempotent.
   */
  subscribe(listener: () => void): Unsubscribe;
  /** Returns the state to carry across a hot reload. */
  snapshot(): S;
  /** Adopts a snapshot taken before a hot reload, then notifies. */
  restore(snapshot: S): void;
}

/** One live `subscribe` registration. */
interface StoreSubscription {
  readonly notify: () => void;
  active: boolean;
}

/**
 * Creates a `Store` holding `initial`.
 *
 * Put durable state in a provider whose instance is a store, not in a module
 * closure: closure state is discarded on every edit, while a
 * `persistent: true` provider's store survives one. `restore` notifies like
 * `setState`, so a component holding the store re-renders with the
 * carried-over state as soon as the reload completes.
 *
 * @example
 * ```ts
 * provide(CartToken, {
 *   persistent: true,
 *   factory: () => defineStore({ items: [] as CartLine[] }),
 * });
 * ```
 */
export function defineStore<S>(initial: S): Store<S> {
  let state = initial;
  const subscriptions = new Set<StoreSubscription>();

  const notify = (): void => {
    for (const subscription of [...subscriptions]) {
      if (subscription.active) {
        subscription.notify();
      }
    }
  };

  return {
    getState: () => state,
    setState: (next) => {
      state = typeof next === 'function' ? (next as (previous: S) => S)(state) : next;
      notify();
    },
    subscribe: (listener) => {
      const subscription: StoreSubscription = { notify: listener, active: true };
      subscriptions.add(subscription);
      return () => {
        if (!subscription.active) {
          return;
        }
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
    snapshot: () => state,
    restore: (snapshot) => {
      state = snapshot;
      notify();
    },
  };
}

/** Options for `transferPersistentState`. */
export interface PersistentTransferOptions {
  /** The **new** record — `transfer` is read off the replacement provider, not the old one. */
  readonly record: AnyProviderRecord;
  /** The instance held back from the previous activation. */
  readonly oldInstance: unknown;
  /** The instance the factory just constructed. Mutated in place, or left alone. */
  readonly newInstance: unknown;
  /** The module that owns the provider, for error attribution. */
  readonly moduleId: string;
  /** Where a failed transfer is reported. */
  readonly report: ErrorReporter;
}

/**
 * Carries `oldInstance`'s state onto `newInstance`, trying four strategies in
 * order. Never throws.
 *
 *  1. `record.transfer(oldInstance, newInstance)`, if the provider declares
 *     one. No fallback runs after it.
 *  2. `oldInstance.snapshot()` structured-cloned into
 *     `newInstance.restore()`, if both members are functions — the `Store`
 *     shape.
 *  3. A structured clone of `oldInstance`'s own enumerable properties
 *     assigned onto `newInstance`, if both have `Object.prototype` or a null
 *     prototype. Class instances are excluded: copying fields past a
 *     constructor's invariants produces an object that looks restored and
 *     behaves corrupted.
 *  4. Otherwise, and on any failure of 1-3, a `PersistentTransferError` goes
 *     to the error sinks and `newInstance` is left as its factory built it.
 *
 * The clone is what keeps the fresh instance from sharing mutable structure
 * with the previous generation of the module's code. It is also the usual
 * failure point: `structuredClone` rejects functions, class instances with
 * private fields, DOM nodes and symbols, so state holding any of those lands
 * in branch 4.
 */
export function transferPersistentState(options: PersistentTransferOptions): void {
  const { record, oldInstance, newInstance, moduleId, report } = options;
  const tokenLabel = record.token.label;

  const fail = (reason: string, cause?: unknown): void => {
    // Phase `resolve`: the transfer runs inside a resolution, as part of
    // constructing the replacement instance.
    report(new PersistentTransferError(moduleId, tokenLabel, reason, cause), {
      moduleId,
      phase: 'resolve',
    });
  };

  // Branch 1 — the provider's own hook wins outright.
  const transfer = record.transfer;
  if (transfer !== undefined) {
    try {
      transfer(oldInstance, newInstance);
    } catch (cause) {
      fail('its transfer(oldInstance, newInstance) hook threw', cause);
    }
    return;
  }

  // Branch 2 — snapshot()/restore(), the `Store` shape.
  const snapshot = readMethod(oldInstance, 'snapshot');
  const restore = readMethod(newInstance, 'restore');
  if (snapshot !== undefined && restore !== undefined) {
    try {
      restore.call(newInstance, structuredCloneOrThrow(snapshot.call(oldInstance)));
    } catch (cause) {
      fail('its snapshot() could not be cloned and restored', cause);
    }
    return;
  }

  // Branch 3 — own enumerable properties of two plain objects.
  if (isPlainObject(oldInstance) && isPlainObject(newInstance)) {
    try {
      // Cloned before anything is written, so a clone failure leaves
      // `newInstance` untouched rather than half-copied.
      const clone = structuredCloneOrThrow({ ...oldInstance });
      Object.assign(newInstance, clone);
    } catch (cause) {
      fail('its own enumerable properties could not be structured-cloned', cause);
    }
    return;
  }

  // Branch 4 — nothing applied.
  fail(
    'it declares no transfer() hook, the old instance has no snapshot() paired with a restore() on the new ' +
      'one, and the two are not both plain objects',
  );
}

/** Reads `name` off `value` only when it is callable. */
function readMethod(
  value: unknown,
  name: 'snapshot' | 'restore',
): ((this: unknown, ...args: readonly unknown[]) => unknown) | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  const member = (value as Record<string, unknown>)[name];
  return typeof member === 'function'
    ? (member as (this: unknown, ...args: readonly unknown[]) => unknown)
    : undefined;
}

/** `Object.prototype`-or-null prototype — deliberately excludes class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `structuredClone`, with a legible failure on hosts that do not have it
 * (older Hermes, for one). The caller treats that throw like any other clone
 * failure.
 */
function structuredCloneOrThrow<T>(value: T): T {
  const clone = (globalThis as { structuredClone?: (input: T) => T }).structuredClone;
  if (typeof clone !== 'function') {
    throw new TypeError('structuredClone is not available in this runtime');
  }
  return clone(value);
}
