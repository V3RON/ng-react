// **H5** — the resolution graph, unit level.
//
// `.test.ts` → the **kernel** project (node). `ResolutionGraph` is a plain
// data structure: no kernel, no container and no React anywhere in this
// file. The wiring — who records, who invalidates, who cascades — is pinned
// end to end in `src/kernel/resolution-cascade.test.ts`; what is proved here
// is the graph's own three guarantees, each of which the kernel-level tests
// would only cover incidentally: `'app'` exclusion, invalidation by
// consumer, and G3's deterministic ordering.

import { describe, expect, it } from 'vitest';

import { ResolutionGraph } from './resolution-graph';

describe('ResolutionGraph — H5', () => {
  it('H5: records an edge per (consumer, owner, token) and is idempotent', () => {
    const graph = new ResolutionGraph();
    graph.record('orders', 'payments', 'payments/PaymentGateway');
    graph.record('orders', 'payments', 'payments/PaymentGateway');
    graph.record('orders', 'payments', 'payments/RefundPolicy');

    expect(graph.snapshot()).toEqual([
      { consumer: 'orders', owner: 'payments', token: 'payments/PaymentGateway' },
      { consumer: 'orders', owner: 'payments', token: 'payments/RefundPolicy' },
    ]);
  });

  it('H5: consumerCascade is the transitive closure of consumers, seeded with the edited module', () => {
    const graph = new ResolutionGraph();
    // checkout → orders → payments → auth, by consumption.
    graph.record('orders', 'payments', 'payments/PaymentGateway');
    graph.record('checkout', 'orders', 'orders/OrderService');
    graph.record('payments', 'auth', 'auth/Session');
    // An unrelated pair that must not be dragged in.
    graph.record('search', 'catalog', 'catalog/Index');

    expect([...graph.consumerCascade('payments')].sort()).toEqual(['checkout', 'orders', 'payments']);
    expect([...graph.consumerCascade('auth')].sort()).toEqual(['auth', 'checkout', 'orders', 'payments']);
    // A module nothing consumes from cascades to itself alone.
    expect([...graph.consumerCascade('checkout')]).toEqual(['checkout']);
  });

  it("H5/ADR-2: an 'app'-attributed edge is recorded but never enters a cascade", () => {
    const graph = new ResolutionGraph();
    graph.record('app', 'payments', 'payments/PaymentGateway');
    graph.record('orders', 'payments', 'payments/PaymentGateway');

    // Recorded — it is real data and G3 shows it.
    expect(graph.snapshot()).toContainEqual({
      consumer: 'app',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });
    // But never cascaded: `'app'` is not a module and cannot be re-activated.
    // Components in that position are H6's business, not the cascade's.
    expect([...graph.consumerCascade('payments')].sort()).toEqual(['orders', 'payments']);
  });

  it("H5/ADR-2: a cascade is not traversed *through* 'app' either", () => {
    const graph = new ResolutionGraph();
    graph.record('app', 'payments', 'payments/PaymentGateway');
    // A nonsense edge that only a bug could produce — `'app'` owns no
    // providers. Asserted anyway: if `'app'` were merely filtered out of the
    // *result* instead of skipped during the walk, `billing` would be
    // dragged into the cascade of every module the composition root touches.
    graph.record('billing', 'app', 'app/Whatever');

    expect([...graph.consumerCascade('payments')]).toEqual(['payments']);
  });

  it("H5: forgetConsumer drops that module's outgoing edges and only those", () => {
    const graph = new ResolutionGraph();
    graph.record('orders', 'payments', 'payments/PaymentGateway');
    graph.record('checkout', 'payments', 'payments/PaymentGateway');
    graph.record('orders', 'auth', 'auth/Session');

    graph.forgetConsumer('orders');

    expect(graph.snapshot()).toEqual([
      { consumer: 'checkout', owner: 'payments', token: 'payments/PaymentGateway' },
    ]);
    // `orders` is gone from the cascade; `checkout`, which was never
    // disposed, is untouched.
    expect([...graph.consumerCascade('payments')].sort()).toEqual(['checkout', 'payments']);
    expect([...graph.consumerCascade('auth')]).toEqual(['auth']);
  });

  it('H5: forgetConsumer for a module with no edges is a no-op', () => {
    const graph = new ResolutionGraph();
    graph.record('orders', 'payments', 'payments/PaymentGateway');
    graph.forgetConsumer('nobody');
    expect(graph.snapshot()).toHaveLength(1);
  });

  it('G3: the snapshot is sorted by (consumer, owner, token), whatever the recording order', () => {
    const forwards = new ResolutionGraph();
    const backwards = new ResolutionGraph();
    const edges: readonly (readonly [string, string, string])[] = [
      ['orders', 'payments', 'payments/RefundPolicy'],
      ['app', 'auth', 'auth/Session'],
      ['orders', 'auth', 'auth/Session'],
      ['orders', 'payments', 'payments/PaymentGateway'],
      ['checkout', 'orders', 'orders/OrderService'],
    ];
    for (const [consumer, owner, token] of edges) {
      forwards.record(consumer, owner, token);
    }
    for (const [consumer, owner, token] of [...edges].reverse()) {
      backwards.record(consumer, owner, token);
    }

    const expected = [
      { consumer: 'app', owner: 'auth', token: 'auth/Session' },
      { consumer: 'checkout', owner: 'orders', token: 'orders/OrderService' },
      { consumer: 'orders', owner: 'auth', token: 'auth/Session' },
      { consumer: 'orders', owner: 'payments', token: 'payments/PaymentGateway' },
      { consumer: 'orders', owner: 'payments', token: 'payments/RefundPolicy' },
    ];
    expect(forwards.snapshot()).toEqual(expected);
    // The point of G3: resolution order is not observable in the snapshot,
    // so a graph snapshot test cannot flake on which component rendered
    // first.
    expect(JSON.stringify(backwards.snapshot())).toBe(JSON.stringify(forwards.snapshot()));
  });
});
