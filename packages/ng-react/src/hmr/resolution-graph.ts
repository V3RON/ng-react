// **H5 — the dev-only resolution graph.**
//
// Spec §11 H5: "In dev mode the container records the true resolution graph
// — which module actually resolved which token from which provider (a
// subset of `dependsOn`). The HMR cascade disposes and re-activates only
// modules that actually consumed a resolved instance from the edited
// module, not all `dependsOn` dependents. Production deactivation (A4)
// continues to cascade by declared `dependsOn`; **the resolution graph is a
// dev-only optimization and is never load-bearing for correctness.**"
//
// That last sentence is the design constraint this file is written against,
// and it has two consequences that are easy to lose:
//
//  1. **Nothing outside `hotReplace` may read this.** `kernel.deactivate`
//     keeps cascading by declared `dependsOn` (A4) even in dev, so a module
//     that declares a dependency it never resolves is torn down by
//     `deactivate` and *not* by `hotReplace`. That divergence is the whole
//     observable content of H5 and `kernel/resolution-cascade.test.ts` pins
//     it directly.
//  2. **This object may not exist at all.** The kernel constructs one only
//     when `dev` is on; with `dev: false` there is no graph, the resolver is
//     handed no recorder, and `inspect()` has no `resolutionGraph` key. The
//     production hot path pays one `!== undefined` check per resolution and
//     allocates nothing.
//
// ### `'app'` is recorded and never cascaded
//
// ADR-2 makes `'app'` the requester of every resolution started outside a
// module — `kernel.get()`, the composition root, and a `useService` rendered
// outside any `<ModuleScope>` (R2). Those are real consumers and their edges
// are real data, so they are recorded and they appear in `inspect()`. They
// are nevertheless never part of a cascade: `'app'` is not a registered
// module, it has no descriptor, no context and no providers, so there is
// nothing to dispose and nothing to re-activate. Components in that position
// are H6's business — the epoch bump re-renders them and they re-resolve.
// `consumerCascade` therefore drops `'app'` unconditionally rather than
// leaving it to the caller's status filter to do it by accident.
//
// ADR-6: no `react` import.

/**
 * One recorded resolution: `consumer` resolved `token`, and the provider it
 * got came from `owner` (C9 provenance).
 *
 * A **plain, JSON-serialisable** row, like every other `inspect()` row — this
 * is G3's dev-tools data source, so it carries id strings and token labels,
 * never `ModuleRef`s, `Token`s or instances. Holding a token here would also
 * pin a re-evaluated module's old contract chunk in memory across every HMR
 * cycle, which is the opposite of what an HMR-support structure should do.
 */
export interface ResolutionEdge {
  /** The module the resolution chain was started on behalf of (C4), or ADR-2's `'app'`. */
  readonly consumer: string;
  /** C9: the module that registered the provider that answered. */
  readonly owner: string;
  /** C1: the resolved token's label (`moduleId/Name`). */
  readonly token: string;
}

/** ADR-2's reserved requester id. Never a cascade member — see the file header. */
const APP_CONSUMER = 'app';

/**
 * H5: the edges the container recorded, and the cascade they imply.
 *
 * Two indexes over the same edge set, both maintained by `record`:
 * `byConsumer` (for invalidation and for the sorted snapshot) and
 * `consumersByOwner` (for the cascade walk). One index would do for either
 * job alone; keeping both means neither `forgetConsumer` nor
 * `consumerCascade` has to scan every edge, and an HMR cycle calls both.
 */
export class ResolutionGraph {
  /** consumer id → owner id → the token labels it resolved from that owner. */
  private readonly byConsumer = new Map<string, Map<string, Set<string>>>();
  /** owner id → the consumer ids that resolved something from it. */
  private readonly consumersByOwner = new Map<string, Set<string>>();

  /**
   * Records that `consumer` resolved `token` from a provider owned by
   * `owner`. Idempotent — an edge recorded twice is one edge.
   *
   * Called from the resolver **before** the scope cache is consulted, so a
   * second resolution that hits the cache still counts: a module holding a
   * cached instance is every bit as much a consumer as the one that caused
   * it to be constructed, and cascading only to first resolvers would leave
   * the rest holding disposed objects.
   */
  record(consumer: string, owner: string, token: string): void {
    let byOwner = this.byConsumer.get(consumer);
    if (byOwner === undefined) {
      byOwner = new Map();
      this.byConsumer.set(consumer, byOwner);
    }
    let tokens = byOwner.get(owner);
    if (tokens === undefined) {
      tokens = new Set();
      byOwner.set(owner, tokens);
    }
    tokens.add(token);

    let consumers = this.consumersByOwner.get(owner);
    if (consumers === undefined) {
      consumers = new Set();
      this.consumersByOwner.set(owner, consumers);
    }
    consumers.add(consumer);
  }

  /**
   * **Invalidation.** Drops every edge whose consumer is `moduleId`, because
   * that module has just been disposed and holds nothing any more.
   *
   * Called from `kernel.teardown`, so it covers all three ways a module goes
   * away (A4 deactivation, F3 quarantine, an HMR cycle's disposal step) with
   * one call site. Re-activation re-records whatever the new code actually
   * resolves.
   *
   * **Only the outgoing edges are dropped, and that is sufficient.** The
   * incoming ones — where `moduleId` is the *owner* — belong to its
   * consumers, and each of those is itself in the cascade being torn down,
   * so its own `forgetConsumer` removes them. Dropping them here as well
   * would additionally erase edges belonging to consumers that are still
   * alive and still holding instances, which is exactly the under-cascade
   * H5 must not produce.
   */
  forgetConsumer(moduleId: string): void {
    const byOwner = this.byConsumer.get(moduleId);
    if (byOwner === undefined) {
      return;
    }
    this.byConsumer.delete(moduleId);
    for (const owner of byOwner.keys()) {
      const consumers = this.consumersByOwner.get(owner);
      if (consumers === undefined) {
        continue;
      }
      consumers.delete(moduleId);
      if (consumers.size === 0) {
        this.consumersByOwner.delete(owner);
      }
    }
  }

  /**
   * **H5**: `moduleId` plus every module that transitively consumed a
   * resolved instance from it. Unordered — the kernel sorts the result into
   * its own topological order, which is the only order disposal and
   * re-activation may use (H2).
   *
   * Transitive by consumption, not by declaration: if `orders` resolved a
   * token from `payments` and `checkout` resolved a token from `orders`,
   * editing `payments` invalidates `checkout` too, because `checkout`'s
   * instance was built by a factory that ran against an instance that is
   * about to be discarded.
   *
   * `'app'` is never a member (file header), and is not traversed *through*
   * either: an edge `app → payments` says the composition root holds a
   * `payments` instance, not that anything downstream of `'app'` does —
   * `'app'` owns no providers, so it has no consumers of its own.
   */
  consumerCascade(moduleId: string): readonly string[] {
    const seen = new Set<string>([moduleId]);
    const queue: string[] = [moduleId];
    while (queue.length > 0) {
      // `pop` on a non-empty array; the `?? break` is for
      // `noUncheckedIndexedAccess`, not for a reachable case.
      const owner = queue.pop();
      if (owner === undefined) {
        break;
      }
      for (const consumer of this.consumersByOwner.get(owner) ?? []) {
        if (consumer === APP_CONSUMER || seen.has(consumer)) {
          continue;
        }
        seen.add(consumer);
        queue.push(consumer);
      }
    }
    return [...seen];
  }

  /**
   * **G3**: every recorded edge, deterministically ordered by
   * `(consumer, owner, token)`.
   *
   * Sorted explicitly for the same reason `kernel.inspect()` sorts its own
   * tables: the value of G3 is that a snapshot test of the graph does not
   * flake. Insertion order here is resolution order, which depends on which
   * component rendered first — the one input a test must never be sensitive
   * to.
   */
  snapshot(): readonly ResolutionEdge[] {
    const edges: ResolutionEdge[] = [];
    for (const consumer of [...this.byConsumer.keys()].sort()) {
      const byOwner = this.byConsumer.get(consumer);
      if (byOwner === undefined) {
        continue;
      }
      for (const owner of [...byOwner.keys()].sort()) {
        for (const token of [...(byOwner.get(owner) ?? [])].sort()) {
          edges.push(Object.freeze({ consumer, owner, token }));
        }
      }
    }
    return Object.freeze(edges);
  }
}
