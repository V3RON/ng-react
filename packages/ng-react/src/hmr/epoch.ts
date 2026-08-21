import type { Unsubscribe } from '../types';

/**
 * One live `subscribeEpoch` registration.
 *
 * A per-subscription object rather than the bare callback, so that the same
 * function subscribing twice gets two independent subscriptions, and so that
 * `active` makes `unsubscribe` idempotent without removing an unrelated
 * subscription that shares the callback identity.
 */
interface EpochSubscription {
  readonly notify: () => void;
  active: boolean;
}

/**
 * Per-module resolution epochs: the counters that tell a consumer everything
 * it resolved on behalf of a module may now be stale.
 *
 * A module's epoch starts at `0` and increases by one on every
 * `bump(moduleId)`. A **global** epoch — the total number of bumps across
 * all modules — is reachable by passing `undefined` to `epochOf` and
 * `subscribe`, and is the fallback for a consumer that cannot name a single
 * owning module. It notifies a strict superset of what such a consumer
 * needs: it may fire once too often, never once too few.
 */
export class EpochStore {
  /** A module that was never bumped has no entry, and epoch `0`. */
  private readonly epochs = new Map<string, number>();
  private globalEpoch = 0;
  private readonly subscriptions = new Map<string, Set<EpochSubscription>>();
  private readonly globalSubscriptions = new Set<EpochSubscription>();

  /**
   * Returns the current epoch of `moduleId`, or the global epoch when
   * `moduleId` is `undefined`.
   *
   * Cheap and allocation-free: this is used directly as a
   * `useSyncExternalStore` `getSnapshot`, which runs on every render.
   */
  epochOf(moduleId?: string): number {
    if (moduleId === undefined) {
      return this.globalEpoch;
    }
    return this.epochs.get(moduleId) ?? 0;
  }

  /**
   * Increments `moduleId`'s epoch and the global epoch, then notifies that
   * module's subscribers and every global subscriber, synchronously.
   *
   * A throwing subscriber is not isolated: the failure propagates out of
   * `bump`.
   */
  bump(moduleId: string): void {
    this.epochs.set(moduleId, this.epochOf(moduleId) + 1);
    this.globalEpoch += 1;

    const perModule = this.subscriptions.get(moduleId);
    const pass = [...(perModule ?? []), ...this.globalSubscriptions];
    for (const subscription of pass) {
      if (subscription.active) {
        subscription.notify();
      }
    }
  }

  /**
   * Calls `callback` after every bump of `moduleId`, or after every bump of
   * any module when `moduleId` is `undefined`.
   *
   * Does not fire on subscribe — read the current value with `epochOf`. The
   * returned `Unsubscribe` is idempotent and removes exactly the
   * subscription it owns, so React StrictMode's mount/unmount/remount leaves
   * no listener behind and drops none.
   */
  subscribe(moduleId: string | undefined, callback: () => void): Unsubscribe {
    const subscription: EpochSubscription = { notify: callback, active: true };

    if (moduleId === undefined) {
      this.globalSubscriptions.add(subscription);
      return () => {
        if (!subscription.active) {
          return;
        }
        subscription.active = false;
        this.globalSubscriptions.delete(subscription);
      };
    }

    let subscribers = this.subscriptions.get(moduleId);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.subscriptions.set(moduleId, subscribers);
    }
    subscribers.add(subscription);

    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      const current = this.subscriptions.get(moduleId);
      if (current === undefined) {
        return;
      }
      current.delete(subscription);
      if (current.size === 0) {
        this.subscriptions.delete(moduleId);
      }
    };
  }
}
