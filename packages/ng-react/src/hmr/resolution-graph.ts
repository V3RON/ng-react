// The dev-only resolution graph, recording which module actually resolved
// which token from which provider.
//
// A hot replace cascades over consumers recorded here; `kernel.deactivate`
// keeps cascading by declared `dependsOn`, so the two can legitimately
// disagree. Nothing outside `hotReplace` and `inspect()` may read this graph
// — it is an optimization and is never load-bearing for correctness.
//
// The kernel constructs one only in dev mode. With `dev: false` there is no
// graph, the resolver is handed no recorder, and `inspect()` has no
// `resolutionGraph` key.

/**
 * One recorded resolution: `consumer` resolved `token`, and the provider it
 * got came from `owner`.
 *
 * A plain, JSON-serialisable row carrying id strings and token labels, never
 * `ModuleRef`s, `Token`s or instances — holding a token would pin a
 * re-evaluated module's old chunk in memory across every hot replace.
 */
export interface ResolutionEdge {
  /** The module the resolution chain was started on behalf of, or `'app'`. */
  readonly consumer: string;
  /** The module that registered the provider that answered. */
  readonly owner: string;
  /** The resolved token's label (`moduleId/Name`). */
  readonly token: string;
}

/** The reserved requester id for resolutions started outside any module. */
const APP_CONSUMER = 'app';

/**
 * The resolution edges the container recorded, and the hot-replace cascade
 * they imply.
 */
export class ResolutionGraph {
  /** consumer id → owner id → the token labels it resolved from that owner. */
  private readonly byConsumer = new Map<string, Map<string, Set<string>>>();
  /** owner id → the consumer ids that resolved something from it. */
  private readonly consumersByOwner = new Map<string, Set<string>>();

  /**
   * Records that `consumer` resolved `token` from a provider owned by
   * `owner`. Idempotent.
   *
   * The resolver calls this before consulting the scope cache, so a
   * resolution that hits the cache still counts as consumption.
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
   * Drops every edge whose consumer is `moduleId`, which has just been
   * disposed and holds nothing any more. Re-activation re-records whatever
   * the new code resolves.
   *
   * Only outgoing edges are dropped. The incoming ones — where `moduleId` is
   * the owner — belong to consumers that may still be alive and still
   * holding instances; dropping those would under-cascade a later hot
   * replace.
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
   * Returns `moduleId` plus every module that transitively consumed a
   * resolved instance from it. Unordered — the kernel sorts the result into
   * its own topological order.
   *
   * Transitive by consumption, not by declaration: if `orders` resolved a
   * token from `payments` and `checkout` resolved a token from `orders`,
   * editing `payments` invalidates `checkout` too.
   *
   * `'app'` is never a member and is never traversed through. It owns no
   * providers, so it has no consumers of its own, and there is nothing to
   * dispose or re-activate.
   */
  consumerCascade(moduleId: string): readonly string[] {
    const seen = new Set<string>([moduleId]);
    const queue: string[] = [moduleId];
    while (queue.length > 0) {
      // `pop` on a non-empty array; the guard below is for
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
   * Returns every recorded edge, ordered by `(consumer, owner, token)`.
   *
   * Sorted explicitly because insertion order is resolution order, which
   * depends on which component rendered first — an input a snapshot test must
   * not be sensitive to.
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
