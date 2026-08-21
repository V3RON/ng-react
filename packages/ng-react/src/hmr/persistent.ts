// **H3 / H4 / ADR-3 — persistent stores and the transfer that carries them
// across an HMR re-activation.**
//
// Two things live here, and they are deliberately not one thing:
//
//  1. `transferPersistentState` — ADR-3's four-branch resolution order,
//     called by the resolver the moment it constructs a fresh instance for a
//     `persistent: true` provider whose predecessor is still held.
//  2. `defineStore` — the blessed *pattern carrier* H3 names. It is not a
//     state library and must not grow into one; its whole job is to be the
//     smallest object that satisfies ADR-3 branch 2 and that stage 7's
//     generator can emit verbatim.
//
// ADR-6: `src/hmr/` is not `src/react/` — no `react` import here, not even a
// type. `defineStore`'s `subscribe` is shaped for `useSyncExternalStore`
// (subscribe + a referentially stable `getState`) without depending on it.

import { PersistentTransferError } from '../errors';
import type { AnyProviderRecord } from '../provider';
import type { ErrorReporter, Unsubscribe } from '../types';

/**
 * The minimal state carrier H3 blesses (`defineStore`'s return type).
 *
 * Five members, and the list is closed. `getState`/`setState`/`subscribe`
 * are what a consumer uses; `snapshot`/`restore` are what **ADR-3 branch 2**
 * duck-types against, which is the entire reason a store is preferable to a
 * bare object for durable state. There is no `reset`, no selector, no
 * middleware and no equality option — every one of those would be scope
 * creep in a file whose purpose is to make one pattern copyable.
 */
export interface Store<S> {
  /** The current state. Referentially stable until the next `setState`/`restore`. */
  getState(): S;
  /** Replaces the state, either outright or from the previous value, then notifies. */
  setState(next: S | ((previous: S) => S)): void;
  /**
   * Calls `listener` after every state change. Does not fire on subscribe —
   * the same rule as every other subscription in this package (C5, A2, H6):
   * read the current value with `getState`. The returned `Unsubscribe` is
   * idempotent.
   */
  subscribe(listener: () => void): Unsubscribe;
  /** **ADR-3 branch 2**: the state to carry across an HMR re-activation. */
  snapshot(): S;
  /** **ADR-3 branch 2**: adopts a snapshot taken before the re-activation, then notifies. */
  restore(snapshot: S): void;
}

/** One live `subscribe` registration — same shape, same reasons, as `epoch.ts`'s. */
interface StoreSubscription {
  readonly notify: () => void;
  active: boolean;
}

/**
 * **H3**: creates the blessed durable-state carrier.
 *
 * The pattern it exists to make copyable: durable state lives in a
 * `singleton`-scoped (or `persistent: true`) provider whose instance *is* a
 * store, never in a module closure. Spec §11 H3 is blunt about the
 * alternative — "closure state is lost on every edit by design".
 *
 * ```ts
 * provide(CartToken, { persistent: true, factory: () => defineStore({ items: [] as CartLine[] }) })
 * ```
 *
 * `restore` notifies exactly like `setState`, which is what makes a
 * component holding the store re-render with the carried-over state after an
 * HMR cycle rather than showing the factory's initial value until the next
 * unrelated update.
 */
export function defineStore<S>(initial: S): Store<S> {
  let state = initial;
  const subscriptions = new Set<StoreSubscription>();

  // Iterates a copy and honours `active`: a listener that subscribes or
  // unsubscribes in response must not affect the pass in flight.
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

/** Everything `transferPersistentState` needs, from the one caller that has it. */
export interface PersistentTransferOptions {
  /** The **new** record — `transfer` is read off the replacement provider, not the old one. */
  readonly record: AnyProviderRecord;
  /** The instance held back from the previous activation (H4's sole exception). */
  readonly oldInstance: unknown;
  /** The instance the factory just constructed. Mutated in place, or left alone. */
  readonly newInstance: unknown;
  /** C9: the module that owns the provider — kernel-assigned, for attribution. */
  readonly moduleId: string;
  /** F4: where branch 4's warning goes. Never throws back into this function. */
  readonly report: ErrorReporter;
}

/**
 * **ADR-3**: carries `oldInstance`'s state onto `newInstance`, trying four
 * strategies in order and **never throwing**.
 *
 *  1. `record.transfer(oldInstance, newInstance)`, if the provider declares
 *     one. Called and stopped on — a hand-written transfer is a migration
 *     between two shapes of state and no fallback can second-guess it.
 *  2. `oldInstance.snapshot()` structured-cloned into `newInstance.restore()`,
 *     if both members are functions. This is the branch `defineStore` exists
 *     to satisfy.
 *  3. A structured clone of `oldInstance`'s own enumerable properties
 *     assigned onto `newInstance`, if both are plain objects. "Plain" is
 *     `Object.prototype` or a null prototype: a class instance is excluded
 *     on purpose, because copying fields past a constructor's invariants is
 *     how you get an object that looks restored and behaves corrupted.
 *  4. Otherwise — and on *any* failure of 1-3 — a `PersistentTransferError`
 *     goes to the error sinks (F4) and `newInstance` is left exactly as its
 *     factory built it.
 *
 * **Why the clone is the failure point, and why that is fine.**
 * `structuredClone` throws on functions, on class instances with private
 * fields, on DOM nodes and on symbols. A store whose state holds a callback
 * therefore lands in branch 4 rather than exploding mid-HMR-cycle, which is
 * exactly ADR-3's "never throw — a failed transfer must not break the HMR
 * cycle". The clone is not decoration either: without it the fresh instance
 * would share mutable structure with an instance from the *previous*
 * generation of the module's code, which is the aliasing bug HMR is
 * infamous for.
 */
export function transferPersistentState(options: PersistentTransferOptions): void {
  const { record, oldInstance, newInstance, moduleId, report } = options;
  const tokenLabel = record.token.label;

  const fail = (reason: string, cause?: unknown): void => {
    // F4 phase `resolve`: the transfer runs inside a resolution, as part of
    // constructing the replacement instance. There is no `hmr` phase and
    // adding one would widen a public union for a dev-only diagnostic.
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

  // Branch 2 — snapshot()/restore(), the `defineStore` shape.
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
      // Cloned *before* anything is written, so a clone failure leaves
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
 * `structuredClone`, with a legible failure for the hosts that do not have
 * it. Node >= 22 and every current browser do; Hermes historically did not,
 * and the kernel has to run there (ADR-5's whole point). The caller treats a
 * throw here exactly like a clone failure — branch 4.
 */
function structuredCloneOrThrow<T>(value: T): T {
  const clone = (globalThis as { structuredClone?: (input: T) => T }).structuredClone;
  if (typeof clone !== 'function') {
    throw new TypeError('structuredClone is not available in this runtime');
  }
  return clone(value);
}
