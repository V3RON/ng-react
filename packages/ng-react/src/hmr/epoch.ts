// **H6 — resolution epochs.** The store only; the HMR driver that bumps it
// is stage 6 (#19).
//
// Spec §11 H6: "Each module re-activation bumps a kernel resolution epoch.
// `useService` subscribes to the epoch of the provider's module, so
// components holding a disposed instance re-render and resolve the fresh
// one. Components need no HMR awareness of their own."
//
// This file is the whole of that mechanism on the kernel side: a counter
// per module id, a bump, and a subscription. It deliberately knows nothing
// about React, about modules, or about the container — a bump is a bare
// "anything resolved on behalf of this module may be stale now" signal, and
// deciding what to do about it belongs to the consumer.
//
// **ADR-6 applies here and is easy to get wrong.** `src/hmr/` is *not*
// `src/react/`, so this file must never import `react` — not even
// `useSyncExternalStore`'s types. The `node` test project (AGENTS.md §3) is
// the machine check. The store is shaped for `useSyncExternalStore`
// (`subscribe` + a cheap, referentially stable `getSnapshot`, here a
// number) without depending on it.
//
// `EpochStore` is internal, like `Container` and `Resolver`: the kernel owns
// one and re-exposes it as `epochOf`/`bumpEpoch`/`subscribeEpoch`, which is
// the surface the React bindings and stage 6 use. It is not exported from
// `index.ts`.

import type { Unsubscribe } from '../types';

/**
 * One live `subscribeEpoch` registration. A per-subscription object rather
 * than the bare callback, for the same two reasons as `collections.ts`'s
 * `Subscription`: the same function may subscribe twice and get two
 * independent subscriptions, and `active` makes `unsubscribe` idempotent
 * without risking the removal of an unrelated subscription that shares the
 * callback identity.
 */
interface EpochSubscription {
  readonly notify: () => void;
  active: boolean;
}

/**
 * H6: per-module resolution epochs.
 *
 * A module's epoch starts at `0` and increases by one on every
 * `bump(moduleId)`. There is additionally a **global** epoch — the total
 * number of bumps across all modules — reachable by passing `undefined`
 * (or nothing) to `epochOf`/`subscribe`.
 *
 * The global epoch is not decoration: it is the honest answer for a
 * consumer that cannot name the module it depends on. `useServiceOptional`
 * on a token nothing provides yet has no owning module to watch, and
 * `Container.ownerOf` returns `undefined` for contribution tokens by
 * design (a collection has many owners). Such a consumer subscribes to the
 * global epoch, which is a strict superset of the notifications it needs:
 * it may re-render once too often after an unrelated module reloads, and it
 * can never miss a bump. Over-rendering in a dev-only HMR path is a much
 * cheaper failure than a component wedged on a disposed instance.
 */
export class EpochStore {
  /** Per-module counters. A module that was never bumped has no entry, and epoch `0`. */
  private readonly epochs = new Map<string, number>();
  /** The number of bumps across all modules — the `undefined` key of `epochOf`. */
  private globalEpoch = 0;
  /** Live subscriptions per module id. A module with no subscribers has no entry. */
  private readonly subscriptions = new Map<string, Set<EpochSubscription>>();
  /** Live subscriptions to *every* bump. */
  private readonly globalSubscriptions = new Set<EpochSubscription>();

  /**
   * The current epoch of `moduleId`, or the global epoch when `moduleId` is
   * `undefined`.
   *
   * Cheap and allocation-free on purpose: this is a `useSyncExternalStore`
   * `getSnapshot`, so it runs on every render of every subscribed
   * component and must return a referentially stable value. A number always
   * is; anything object-shaped here would be an infinite render loop.
   */
  epochOf(moduleId?: string): number {
    if (moduleId === undefined) {
      return this.globalEpoch;
    }
    return this.epochs.get(moduleId) ?? 0;
  }

  /**
   * H6: records that everything resolved on behalf of `moduleId` may now be
   * stale, and notifies that module's subscribers **and** every global
   * subscriber.
   *
   * Notification is synchronous and iterates over a copy of each subscriber
   * set, so a subscriber that subscribes or unsubscribes in response does
   * not affect the in-flight pass; a subscription removed mid-pass is
   * additionally skipped via `active`. A throwing subscriber is *not*
   * isolated here — unlike a contribution factory or an error sink, an
   * epoch subscriber is React's own `onStoreChange`, and swallowing its
   * failure would hide a renderer bug behind a silent no-op.
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
   * Calls `callback` after every bump of `moduleId` — or after **every**
   * bump when `moduleId` is `undefined` (see the class comment).
   *
   * Does not fire on subscribe, matching `Container.subscribeAll` (C5) and
   * `Kernel.subscribeStatus` (A2): the caller reads the current value with
   * `epochOf`. The returned `Unsubscribe` is idempotent, which is what makes
   * the store safe under React StrictMode's mount/unmount/remount
   * double-invocation — subscribing twice registers two subscriptions and
   * unsubscribing twice removes exactly the one it owns, so no listener is
   * ever left behind or dropped.
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
