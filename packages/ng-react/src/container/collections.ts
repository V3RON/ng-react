import type { AnyProviderRecord } from '../provider';
import type { AnyToken, Token } from '../token';
import type { ErrorReporter, Unsubscribe } from '../types';
import type { ProviderRegistry, RegisteredProvider } from './registry';

/**
 * Sort weight for a module whose topological index the injected callback cannot
 * supply, i.e. it returned a non-finite number.
 *
 * Such modules sort last, and among themselves by registration index, so the
 * order stays total and deterministic.
 */
const UNKNOWN_TOPOLOGICAL_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * Returns `entries` in module topological order, contributions from one module
 * keeping their declaration order. `entries` is not mutated.
 *
 * The sort key is the explicit composite `(topologicalIndex,
 * registrationIndex)`, so the order is a pure function of registration and does
 * not lean on sort stability for the second half of the contract.
 */
export function orderContributions<T>(
  entries: readonly RegisteredProvider<T>[],
  getTopologicalIndex: (moduleId: string) => number,
): readonly RegisteredProvider<T>[] {
  if (entries.length < 2) {
    return entries;
  }
  return entries
    .map((entry, registrationIndex) => {
      const index = getTopologicalIndex(entry.owner);
      return {
        entry,
        registrationIndex,
        topologicalIndex: Number.isFinite(index) ? index : UNKNOWN_TOPOLOGICAL_INDEX,
      };
    })
    .sort((a, b) => a.topologicalIndex - b.topologicalIndex || a.registrationIndex - b.registrationIndex)
    .map((keyed) => keyed.entry);
}

/** Constructor options for `ContributionCollections`. */
export interface ContributionCollectionsOptions {
  /**
   * The position of `moduleId` in the kernel's activation order, used to order
   * contribution collections.
   *
   * @default () => 0 — the composite sort key degrades to pure registration
   *   order, which is what a container driven without a kernel gets.
   */
  readonly getTopologicalIndex?: (moduleId: string) => number;
  /**
   * Receives an error thrown by a subscriber callback, or by a contribution
   * factory during a notification pass, so that neither aborts the remaining
   * subscribers.
   *
   * Both call sites report without a `moduleId`: a subscriber belongs to whoever
   * registered it, and a notification-pass construction spans every contributor
   * of the token at once, so neither has one honest owner.
   *
   * @default a no-op.
   */
  readonly onError?: ErrorReporter;
}

/**
 * One live `subscribeAll` registration.
 *
 * A per-subscription object rather than the bare callback, so the same function
 * may subscribe twice and get two independent subscriptions, and so
 * `unsubscribe` can be idempotent without removing an unrelated subscription
 * that shares the callback identity.
 */
interface Subscription {
  readonly notify: (values: readonly never[]) => void;
  active: boolean;
}

/**
 * Ordering and change notification for contribution collections.
 *
 * Change is detected from the ordered sequence of `ProviderRecord` identities,
 * without constructing anything: records are unique frozen objects per
 * `contribute()` call and cached instances are keyed by record plus owner, so
 * "same records, same order" implies "same instances, same order" for every
 * cached scope. Instances are resolved only after a change has been detected,
 * and only for tokens that have subscribers.
 *
 * A `transient` contribution constructs fresh on every resolution, so an
 * unchanged transient contribution still does not notify: the signal is a change
 * in the contribution set, not instance churn.
 */
export class ContributionCollections {
  private readonly getTopologicalIndex: (moduleId: string) => number;
  private readonly onError: ErrorReporter;

  /** Live subscriptions per token. A token with no subscribers has no entry. */
  private readonly subscriptions = new Map<AnyToken, Set<Subscription>>();
  /**
   * The ordered contribution entries most recently seen for a token that has
   * subscribers — the baseline the next mutation is compared against.
   *
   * Seeded when a token gains its first subscriber, so subscribing and then
   * applying a no-op mutation notifies nobody, and replaced on every pass that
   * detects a change and resolves it successfully. Dropped when the last
   * subscriber leaves, so a later
   * re-subscribe re-baselines against whatever is current then.
   */
  private readonly lastSeen = new Map<AnyToken, readonly RegisteredProvider[]>();

  constructor(
    private readonly registry: ProviderRegistry,
    /**
     * Constructs the full collection for a token, in this file's order.
     *
     * Injected as a callback rather than as a `Resolver` reference so the
     * dependency runs one way: `resolver.ts` imports the ordering function from
     * here, and nothing here imports `resolver.ts`.
     */
    private readonly resolveAll: (token: AnyToken) => readonly unknown[],
    options: ContributionCollectionsOptions = {},
  ) {
    this.getTopologicalIndex = options.getTopologicalIndex ?? (() => 0);
    this.onError = options.onError ?? (() => {});
  }

  /**
   * The full contribution collection for `token`, in module topological order,
   * constructed lazily on first call.
   *
   * Each contribution respects its own scope and is resolved on behalf of its
   * own owning module rather than the caller, which is why there is no requester
   * parameter: `MODULE_ID` inside a contribution is a pure function of that
   * contribution's provenance, independent of who resolved first or of whether
   * anyone subscribed.
   *
   * @returns the contributions, or `[]` for an unknown token and for a token
   *   that has a single `provide`d provider — never an error, since a subsystem
   *   subscribing before any contributor has activated is the normal case.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.resolveAll(token as AnyToken) as readonly T[];
  }

  /**
   * Subscribes to changes in `token`'s contribution set, caused by a module
   * registering contributions or being withdrawn.
   *
   * Subscribing does not fire the callback; read the current value with
   * `getAll`. The returned `Unsubscribe` is idempotent.
   */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe {
    const erased = token as AnyToken;
    let subscribers = this.subscriptions.get(erased);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.subscriptions.set(erased, subscribers);
      this.lastSeen.set(erased, this.orderedEntries(erased));
    }

    const subscription: Subscription = {
      notify: callback as (values: readonly never[]) => void,
      active: true,
    };
    subscribers.add(subscription);

    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      const current = this.subscriptions.get(erased);
      if (current === undefined) {
        return;
      }
      current.delete(subscription);
      if (current.size === 0) {
        this.subscriptions.delete(erased);
        this.lastSeen.delete(erased);
      }
    };
  }

  /**
   * Notifies subscribers of every token in `tokens` whose collection actually
   * changed, once per token.
   *
   * `tokens` may over-report — `withdraw` returns every token a module owned,
   * including `provide`-kind ones — because tokens without subscribers are
   * skipped and the record-sequence comparison collapses the rest.
   *
   * Within a pass: subscribers are iterated over a copy and an unsubscribed
   * subscription is additionally skipped, so mutating the subscriber set from a
   * callback does not affect the in-flight pass; a throwing subscriber is
   * isolated and the remaining subscribers still run; and a throwing
   * contribution factory aborts only this token's notification, leaving the
   * baseline untouched so a later mutation retries rather than swallowing the
   * change.
   *
   * @param tokens the tokens a registry mutation affected, after that mutation
   *   is fully applied.
   */
  notifyAffected(tokens: Iterable<AnyToken>): void {
    for (const token of tokens) {
      const subscribers = this.subscriptions.get(token);
      if (subscribers === undefined || subscribers.size === 0) {
        continue;
      }

      const next = this.orderedEntries(token);
      const previous = this.lastSeen.get(token);
      if (previous !== undefined && sameSequence(previous, next)) {
        continue;
      }

      let values: readonly unknown[];
      try {
        // A notification pass constructs exactly the instances a
        // consumer-initiated `getAll` would, so a subscriber's mere existence
        // cannot change what anyone else sees.
        values = this.resolveAll(token);
      } catch (error) {
        this.onError(error, { phase: 'resolve' });
        continue;
      }
      this.lastSeen.set(token, next);

      for (const subscription of [...subscribers]) {
        if (!subscription.active) {
          continue;
        }
        try {
          subscription.notify(values as readonly never[]);
        } catch (error) {
          this.onError(error, { phase: 'resolve' });
        }
      }
    }
  }

  /** The change-detection view of a token: ordered entries, nothing constructed. */
  private orderedEntries(token: AnyToken): readonly RegisteredProvider[] {
    return orderContributions(this.registry.getContributions(token), this.getTopologicalIndex);
  }
}

/**
 * Whether two ordered contribution sequences are the same collection: same
 * length, same `ProviderRecord` identities, same owners, same order.
 */
function sameSequence(a: readonly RegisteredProvider[], b: readonly RegisteredProvider[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if ((left.record as AnyProviderRecord) !== (right.record as AnyProviderRecord) || left.owner !== right.owner) {
      return false;
    }
  }
  return true;
}
