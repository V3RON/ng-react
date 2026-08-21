// Reactive contribution collections (task 2.3): the C5 primitive that
// `contribute()` feeds and that subsystem modules (navigation, slots) are
// built on. Two responsibilities live here and nowhere else:
//
//  1. **Ordering.** `orderContributions` is the single implementation of
//     C5's "module topological order, declaration order within a module".
//     `Resolver.resolveAllOf` calls it, and so does the change detection
//     below, so `deps: [allOf(Token)]` and `container.getAll(Token)` can
//     never disagree about order (principle 5 — two orderings for one
//     concept would be two ways to do the same thing).
//  2. **Reactivity.** `subscribeAll` + `notifyAffected`, driven by the
//     affected-token set `ProviderRegistry.withdraw` returns and by the
//     contribution tokens of each `register` batch.
//
// ---
//
// **Laziness (C3) versus the "do not notify when value-equal" rule.**
//
// These are in tension: deciding whether the *instances* changed means
// constructing them, and C3 says nothing is constructed until it is
// resolved. This file resolves the tension one way and only one way:
//
// > The change signal is the **ordered sequence of `ProviderRecord`
// > identities**, compared without constructing anything. Instances are
// > resolved only after that comparison has already reported a change, and
// > only for tokens that actually have subscribers.
//
// This is sound because of two properties the layers below guarantee:
//
//  - A `ProviderRecord` is a frozen, unique object per `contribute()` call
//    (`provider.ts`), and the resolver caches `singleton`/`module`-scoped
//    instances keyed by exactly that record plus its owner. So "same
//    records, same order" implies "same instances, same order" for every
//    cached scope — which is what the requirement is really asking about.
//  - `ProviderRegistry.getContributions` is copy-on-write (see #27): a
//    stable reference while unchanged, a fresh one the instant a
//    contribution is added or removed. Record-identity comparison over its
//    result therefore never reports "unchanged" across a real mutation.
//
// The rejected alternative was to treat a subscriber as a consumer and
// construct the whole collection on every registry mutation just to compare
// it. That would make a single `subscribeAll` call eagerly construct every
// contribution on every unrelated activation, which is precisely the
// eagerness C3 forbids. It is not implemented; there is no second path.
//
// The one honest consequence, documented on `notifyAffected` and pinned by
// a test: a `transient`-scoped contribution constructs a fresh instance per
// resolution, so "same instances" can never hold for it. Under the rule
// above an unchanged transient contribution does **not** notify — correct,
// because C5's reactivity is about the contribution *set* changing, not
// about instance churn a consumer causes itself.
//
// ---
//
// **C4 inside a contribution: the owner, not the consumer.**
//
// `Resolver.resolveAllOf` resolves each contribution on behalf of its own
// **owner** (C9 provenance), not on behalf of whoever asked for the
// collection, and `notifyAffected` therefore has no requester to invent.
// This is a deliberate reading of a case C4 does not cover, and it is worth
// spelling out because the obvious alternative is a live defect:
//
// C4 was written for a single provider — "the module owning the resolving
// `init`/provider" — where there is one consumer and the answer is
// unambiguous. A contribution collection has **N producers and M
// consumers**, and that breaks the assumption two ways at once:
//
//  - *It is not specialization.* C4's stated purpose is
//    "consumer-specialized services (namespaced storage, tagged loggers,
//    module-scoped analytics)". Propagating the consumer's id would build
//    every contributor's sink with `storage.forModule('analytics')` — one
//    shared namespace for contributions from a dozen modules, which is the
//    opposite of what the C4 use cases want. The module that wants its own
//    id in `storage.forModule(moduleId)` is the one that wrote the
//    `contribute()` call.
//  - *It is not even deterministic.* `singleton` and `module` scopes cache,
//    so the first resolution's context becomes the only context, for the
//    life of the instance. Under a propagated requester, the value baked
//    into a contribution depends on which consumer happened to resolve
//    first — and, once `subscribeAll` exists, on whether anyone had
//    subscribed at all, since a notification pass is a resolution with no
//    consumer behind it. Two runs of the same app with the same modules
//    could differ.
//
// Resolving on behalf of the owner removes the question rather than
// answering it carefully: `MODULE_ID` inside a contribution becomes a pure
// function of the contribution's provenance. No race, no first-resolver
// -wins, no dependence on subscription order, and nothing for a notify pass
// to fabricate. It also lines up with C2, whose `module`-scope cache is
// already keyed by the owner: a `module`-scoped contribution is one
// instance per owning module's activation, and now it is built *for* that
// same module.
//
// C4's propagation rule is untouched — within each contribution's chain the
// seed still flows unchanged to every nested dependency. What changes is
// only the *seed*: `injectAll` is not one resolution chain, it is N
// independent chains, one per contributor.
//
// This also changes the pre-existing consumer-initiated `deps: [allOf(T)]`
// path, which previously stamped the aggregating module's id onto every
// contributor's instance. That is called out in the PR, not smuggled in.
//
// ---
//
// `ContributionCollections` is internal, like `ProviderRegistry` and
// `Resolver` — see the note on the public helpers in `container.ts`.

import type { AnyProviderRecord } from '../provider';
import type { AnyToken, Token } from '../token';
import type { ErrorReporter, Unsubscribe } from '../types';
import type { ProviderRegistry, RegisteredProvider } from './registry';

/**
 * Sort weight for a module whose topological index the injected callback
 * cannot supply (it returned a non-finite number — e.g. the kernel's graph
 * no longer knows the module). Such modules sort *last*, and among
 * themselves by registration index, so ordering stays total and
 * deterministic instead of depending on `NaN` comparison behaviour.
 */
const UNKNOWN_TOPOLOGICAL_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * C5 ordering: returns `entries` in module topological order, contributions
 * from one module keeping their declaration order.
 *
 * The sort key is the **explicit composite** `(topologicalIndex,
 * registrationIndex)`, never `topologicalIndex` alone. `getContributions`
 * hands back cross-module registration order, so sorting on the module
 * index alone would preserve same-module declaration order only by leaning
 * on `Array.prototype.sort`'s stability — an accidental guarantee for a
 * contract C5 states outright. `registrationIndex` is the entry's position
 * in the registry's own array, which *is* its registration order, so the
 * composite key makes the second half of the contract explicit.
 *
 * `entries` is not mutated.
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
   * C5 ordering: the position of `moduleId` in the kernel's activation
   * (topological) order. Injected because the container does not own the
   * dependency graph — the kernel supplies it in stage 3.
   *
   * **Documented fallback:** the default returns `0` for every module, so
   * the composite sort key degrades to pure registration (insertion) order.
   * That is the right degradation for a container exercised standalone with
   * no kernel, which is stage 2's definition of done.
   */
  readonly getTopologicalIndex?: (moduleId: string) => number;
  /**
   * Receives an error thrown by a subscriber callback, or by a contribution
   * factory during a notification pass, so neither aborts the remaining
   * subscribers. Wired by the kernel to F4's `ErrorSinkToken` routing (task
   * 3.3). Defaults to a no-op.
   *
   * Both call sites report **without** a `moduleId`: a `subscribeAll`
   * subscriber belongs to whoever registered it (often the composition
   * root, not a module) and a notification-pass construction spans every
   * contributor of the token at once, so neither has one honest owner. The
   * kernel substitutes ADR-2's reserved `'app'` — see `ErrorReporter`.
   */
  readonly onError?: ErrorReporter;
}

/**
 * One live `subscribeAll` registration. A per-subscription object rather
 * than the bare callback so that (a) the same function may subscribe twice
 * and get two independent subscriptions, and (b) `unsubscribe` is
 * idempotent via `active` without risking the removal of an unrelated
 * subscription that happens to share the callback identity.
 */
interface Subscription {
  readonly notify: (values: readonly never[]) => void;
  active: boolean;
}

export class ContributionCollections {
  private readonly getTopologicalIndex: (moduleId: string) => number;
  private readonly onError: ErrorReporter;

  /** Live subscriptions per token. A token with no subscribers has no entry. */
  private readonly subscriptions = new Map<AnyToken, Set<Subscription>>();
  /**
   * The ordered contribution entries most recently *seen* for a token that
   * has subscribers — the baseline the next mutation is compared against.
   * Seeded when a token gains its first subscriber (so that subscribing and
   * then applying a no-op mutation notifies nobody) and replaced on every
   * pass that does notify. Dropped when the last subscriber leaves, so a
   * later re-subscribe re-baselines against whatever is current then.
   */
  private readonly lastSeen = new Map<AnyToken, readonly RegisteredProvider[]>();

  constructor(
    private readonly registry: ProviderRegistry,
    /**
     * Constructs the full collection for a token, in this file's order.
     * Injected as a callback rather than as a `Resolver` reference so the
     * dependency runs one way only: `resolver.ts` imports the ordering
     * function from here, and nothing here imports `resolver.ts`.
     *
     * Takes no requester: see the C4 section of the file header — each
     * contribution is resolved on behalf of its own owner, so there is no
     * caller context to thread through and none for a notification pass to
     * invent.
     */
    private readonly resolveAll: (token: AnyToken) => readonly unknown[],
    options: ContributionCollectionsOptions = {},
  ) {
    this.getTopologicalIndex = options.getTopologicalIndex ?? (() => 0);
    this.onError = options.onError ?? (() => {});
  }

  /**
   * C5's `injectAll`: the full contribution collection for `token`, in
   * module topological order.
   *
   * C3: nothing is constructed until this is called. Each contribution
   * respects its own scope, exactly as a single provider would, and each is
   * resolved on behalf of its own owner (C4 — see the file header), which
   * is why this takes no requester.
   *
   * An unknown token yields `[]` rather than throwing — a subsystem module
   * that subscribes before any contributor has activated is the normal
   * case, not an error. So does a token that has a single `provide`d
   * provider: `provide` and `contribute` can never both apply to one token
   * (the registry rejects the mix, C5), so a provided token has no
   * contribution collection to speak of, and `[]` is its honest answer.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.resolveAll(token as AnyToken) as readonly T[];
  }

  /**
   * C5's `subscribeAll`: `callback` runs whenever `token`'s contribution
   * set changes because a module registered contributions or was
   * withdrawn (disposal, or F3 quarantine).
   *
   * Subscribing does **not** fire the callback immediately. The caller
   * reads the current value with `getAll`; a subscription reports
   * *changes*, and firing on subscribe would make every consumer either
   * receive the initial value twice or have to de-duplicate it.
   *
   * The returned `Unsubscribe` is idempotent: calling it more than once has
   * no further effect.
   */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe {
    const erased = token as AnyToken;
    let subscribers = this.subscriptions.get(erased);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.subscriptions.set(erased, subscribers);
      // Baseline without constructing anything (see the file header).
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
   * Notifies subscribers of every token in `tokens` whose collection
   * actually changed. Called by `Container` **after** a registry mutation
   * is fully applied, once per mutation — a module contributing three items
   * to one token fires one notification, because `tokens` is a set and the
   * comparison below runs once per token.
   *
   * `tokens` is deliberately allowed to over-report. `withdraw` returns
   * every token the module owned, including `provide`-kind tokens and
   * contribution tokens whose *effective* collection did not change; tokens
   * with no subscribers are skipped outright and the record-sequence
   * comparison collapses the rest.
   *
   * Guarantees during a pass, in order of the failure they prevent:
   *
   *  - Subscribers are iterated over a **copy**, so a subscriber added or
   *    removed by another subscriber does not affect the in-flight pass. A
   *    subscription removed mid-pass is additionally skipped via its
   *    `active` flag — an unsubscribed callback must not fire, copy or not.
   *  - A **throwing subscriber** is isolated: its error goes to `onError`
   *    and the remaining subscribers still run.
   *  - A **throwing contribution factory** aborts only this token's
   *    notification (there is no collection to hand out); the error goes to
   *    `onError` and the baseline is left untouched, so a later mutation
   *    retries rather than silently swallowing the change.
   *
   * Note on `transient` contributions: see the file header — an unchanged
   * transient contribution does not notify.
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
        // C3: construction happens here and only here — after a real
        // change has already been detected without constructing anything.
        // C4: no requester is passed, and none is invented — a
        // notification pass constructs exactly the same instances a
        // consumer-initiated `getAll` would, so a subscriber's mere
        // existence cannot change what anyone else sees.
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
 * length, same `ProviderRecord` identities, same owners, same order. See
 * the file header for why record identity is the sound stand-in for
 * instance identity here.
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
