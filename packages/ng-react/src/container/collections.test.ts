import { describe, expect, it, vi } from 'vitest';
import { ProviderKindConflictError } from '../errors';
import { contribute, provide } from '../provider';
import { allOf, createToken, MODULE_ID } from '../token';
import { Container } from './container';
import type { ContainerOptions } from './container';

// Realistic, *differently*-typed contribution shapes throughout (AGENTS.md
// §9): `Token<unknown>` everywhere and single-element arrays are named as a
// reject reason, and are how the stage-1 ADR-10 defect survived. Every
// multi-token test below uses at least two distinct interfaces, and every
// ordering test uses at least three contributions.
interface AnalyticsSink {
  readonly id: string;
  track(event: string): void;
}
interface RouteConfig {
  readonly path: string;
  readonly screen: string;
}
interface Interceptor {
  readonly name: string;
  intercept(url: string): string;
}
interface OrderService {
  place(): Promise<string>;
}

function sink(id: string): AnalyticsSink {
  return { id, track: () => {} };
}
function route(path: string): RouteConfig {
  return { path, screen: `${path}Screen` };
}

function makeContainer(options: ContainerOptions = {}): Container {
  return new Container(options);
}

/**
 * A `getTopologicalIndex` backed by an explicit activation order, i.e. what
 * the kernel supplies in stage 3.
 */
function topoOrder(...moduleIds: readonly string[]): (moduleId: string) => number {
  const index = new Map(moduleIds.map((id, i) => [id, i] as const));
  return (moduleId) => index.get(moduleId) ?? Number.NaN;
}

describe('ContributionCollections', () => {
  describe('C5: ordering', () => {
    it('C5: injectAll returns contributions in module topological order', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      // Activation order is core → orders → payments, but the modules are
      // *registered* in the reverse order, so registration order alone
      // would produce exactly the wrong answer.
      const container = makeContainer({ getTopologicalIndex: topoOrder('core', 'orders', 'payments') });
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      container.register('core', [contribute(sinkToken, { factory: () => sink('core') })]);

      const sinks = container.getAll(sinkToken);

      expect(sinks.map((s) => s.id)).toEqual(['core', 'orders', 'payments']);
    });

    it('C5: contributions from one module keep declaration order', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer();
      container.register('orders', [
        contribute(routeToken, { factory: () => route('/orders') }),
        contribute(routeToken, { factory: () => route('/orders/:id') }),
        contribute(routeToken, { factory: () => route('/orders/new') }),
      ]);

      expect(container.getAll(routeToken).map((r) => r.path)).toEqual([
        '/orders',
        '/orders/:id',
        '/orders/new',
      ]);
    });

    it('C5: a module registered last but topologically first keeps its own declaration order (composite sort key, not sort stability)', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      // 'core' activates first but registers last, and contributes three
      // routes. Sorting on the topological index alone would only put them
      // first *and* in declaration order by relying on Array#sort being
      // stable; the composite (topoIndex, registrationIndex) key states it.
      const container = makeContainer({ getTopologicalIndex: topoOrder('core', 'orders') });
      container.register('orders', [
        contribute(routeToken, { factory: () => route('/orders') }),
        contribute(routeToken, { factory: () => route('/orders/new') }),
      ]);
      container.register('core', [
        contribute(routeToken, { factory: () => route('/') }),
        contribute(routeToken, { factory: () => route('/login') }),
        contribute(routeToken, { factory: () => route('/settings') }),
      ]);

      expect(container.getAll(routeToken).map((r) => r.path)).toEqual([
        '/',
        '/login',
        '/settings',
        '/orders',
        '/orders/new',
      ]);
    });

    it('C5: with no kernel the documented fallback is registration (insertion) order', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer(); // no getTopologicalIndex
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      container.register('core', [contribute(sinkToken, { factory: () => sink('core') })]);

      expect(container.getAll(sinkToken).map((s) => s.id)).toEqual([
        'payments',
        'orders',
        'core',
      ]);
    });

    it('C5: a module the topological callback does not know sorts last, deterministically', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      // `topoOrder` returns NaN for an unknown module; without an explicit
      // guard NaN comparisons make the sort order implementation-defined.
      const container = makeContainer({ getTopologicalIndex: topoOrder('core', 'orders') });
      container.register('plugin-a', [contribute(sinkToken, { factory: () => sink('plugin-a') })]);
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      container.register('plugin-b', [contribute(sinkToken, { factory: () => sink('plugin-b') })]);
      container.register('core', [contribute(sinkToken, { factory: () => sink('core') })]);

      expect(container.getAll(sinkToken).map((s) => s.id)).toEqual([
        'core',
        'orders',
        'plugin-a',
        'plugin-b',
      ]);
    });

    it('C5: allOf() deps and getAll() share one ordering path — they cannot disagree', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const reportToken = createToken<readonly string[]>('analytics/SinkIds');
      const container = makeContainer({ getTopologicalIndex: topoOrder('core', 'orders', 'payments', 'analytics') });
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      container.register('core', [contribute(sinkToken, { factory: () => sink('core') })]);
      container.register('analytics', [
        provide(reportToken, {
          deps: [allOf(sinkToken)],
          factory: (sinks) => sinks.map((s) => s.id),
        }),
      ]);

      const viaDeps = container.resolve(reportToken, { requester: 'analytics' });
      const viaGetAll = container.getAll(sinkToken).map((s) => s.id);

      expect(viaDeps).toEqual(['core', 'orders', 'payments']);
      expect(viaGetAll).toEqual(viaDeps);
    });
  });

  describe('C3: laziness', () => {
    it('C3: contributions are constructed lazily, on first injectAll', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const ordersFactory = vi.fn(() => sink('orders'));
      const paymentsFactory = vi.fn(() => sink('payments'));
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { factory: ordersFactory })]);
      container.register('payments', [contribute(sinkToken, { factory: paymentsFactory })]);

      expect(ordersFactory).not.toHaveBeenCalled();
      expect(paymentsFactory).not.toHaveBeenCalled();

      container.getAll(sinkToken);

      expect(ordersFactory).toHaveBeenCalledTimes(1);
      expect(paymentsFactory).toHaveBeenCalledTimes(1);
    });

    it('C3: subscribing constructs nothing — the change signal is record identity, not instances', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const factory = vi.fn(() => sink('orders'));
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { factory })]);

      const unsubscribe = container.subscribeAll(sinkToken, () => {});

      expect(factory).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('C3: a mutation on a token nobody subscribes to constructs nothing', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const sinkFactory = vi.fn(() => sink('orders'));
      const container = makeContainer();
      container.subscribeAll(routeToken, () => {});

      container.register('orders', [
        contribute(sinkToken, { factory: sinkFactory }),
        contribute(routeToken, { factory: () => route('/orders') }),
      ]);

      expect(sinkFactory).not.toHaveBeenCalled();
    });

    it("C2/C3: each contribution respects its own scope — a 'module'-scoped contribution is constructed once", () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const moduleScoped = vi.fn(() => sink('orders'));
      const transientScoped = vi.fn(() => sink('payments'));
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { scope: 'module', factory: moduleScoped })]);
      container.register('payments', [contribute(sinkToken, { scope: 'transient', factory: transientScoped })]);

      const first = container.getAll(sinkToken);
      const second = container.getAll(sinkToken);

      expect(moduleScoped).toHaveBeenCalledTimes(1);
      expect(first[0]).toBe(second[0]);
      expect(transientScoped).toHaveBeenCalledTimes(2);
      expect(first[1]).not.toBe(second[1]);
    });
  });

  describe('C5: reactivity', () => {
    it('C5: subscribeAll notifies once per registry mutation, not once per contribution', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer();
      const observed = vi.fn();
      container.subscribeAll(routeToken, observed);

      container.register('orders', [
        contribute(routeToken, { factory: () => route('/orders') }),
        contribute(routeToken, { factory: () => route('/orders/:id') }),
        contribute(routeToken, { factory: () => route('/orders/new') }),
      ]);

      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0]?.[0]).toHaveLength(3);
    });

    it('C5: registering a second contributor notifies exactly once with a fresh array (pins the registry copy-on-write guarantee from #27)', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      const delivered: (readonly AnalyticsSink[])[] = [];
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      const first = container.getAll(sinkToken);
      container.subscribeAll(sinkToken, (values) => delivered.push(values));

      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);

      expect(delivered).toHaveLength(1);
      const second = delivered[0];
      expect(Object.is(second, first)).toBe(false);
      expect(second?.map((s) => s.id)).toEqual(['orders', 'payments']);
    });

    it('C5: subscribing does not fire immediately — the caller reads the current value with getAll', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      const observed = vi.fn();

      container.subscribeAll(sinkToken, observed);

      expect(observed).not.toHaveBeenCalled();
      expect(container.getAll(sinkToken).map((s) => s.id)).toEqual(['orders']);
    });

    it('C5: subscribeAll does not notify when the collection is value-equal (withdraw over-reports its affected tokens)', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const container = makeContainer();
      // 'orders' owns two tokens: a plain provide() and a contribution to
      // a *different* token. Withdrawing it reports BOTH tokens as
      // affected, but the analytics collection is untouched.
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      container.register('orders', [provide(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'o' }) })]);
      const observed = vi.fn();
      container.subscribeAll(sinkToken, observed);

      container.withdraw('orders');

      expect(observed).not.toHaveBeenCalled();
      expect(container.getAll(sinkToken).map((s) => s.id)).toEqual(['payments']);
    });

    it('C5: a no-op withdraw of a never-registered module notifies nobody', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      const observed = vi.fn();
      container.subscribeAll(sinkToken, observed);

      container.withdraw('never-registered');

      expect(observed).not.toHaveBeenCalled();
    });

    it("C5: an unchanged 'transient' contribution does not notify, even though its instances differ per resolution", () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const container = makeContainer();
      container.register('payments', [contribute(sinkToken, { scope: 'transient', factory: () => sink('payments') })]);
      container.register('orders', [provide(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'o' }) })]);
      const observed = vi.fn();
      container.subscribeAll(sinkToken, observed);

      // Withdrawing 'orders' reports orders/OrderService as affected but
      // leaves the sink collection alone. Reactivity is about the
      // contribution *set*, not per-resolution instance churn.
      container.withdraw('orders');

      expect(observed).not.toHaveBeenCalled();
      const a = container.getAll(sinkToken);
      const b = container.getAll(sinkToken);
      expect(a[0]).not.toBe(b[0]);
    });

    it('C5/F3: withdrawing a contributor notifies with the remaining collection, in order', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer({ getTopologicalIndex: topoOrder('core', 'orders', 'payments') });
      container.register('payments', [contribute(routeToken, { factory: () => route('/payments') })]);
      container.register('orders', [contribute(routeToken, { factory: () => route('/orders') })]);
      container.register('core', [contribute(routeToken, { factory: () => route('/') })]);
      const observed = vi.fn();
      container.subscribeAll(routeToken, observed);

      container.withdraw('orders');

      expect(observed).toHaveBeenCalledTimes(1);
      expect((observed.mock.calls[0]?.[0] as readonly RouteConfig[]).map((r) => r.path)).toEqual(['/', '/payments']);
    });

    it('C5: withdrawing the last contributor delivers an empty collection', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      const observed = vi.fn();
      container.subscribeAll(sinkToken, observed);

      container.withdraw('orders');

      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0]?.[0]).toEqual([]);
    });

    it('C5: a rejected register() batch notifies nobody (registration is atomic)', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const container = makeContainer();
      container.register('payments', [provide(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'o' }) })]);
      const observed = vi.fn();
      container.subscribeAll(sinkToken, observed);

      expect(() =>
        container.register('orders', [
          contribute(sinkToken, { factory: () => sink('orders') }),
          // C5: contribute() on a token another module provide()s — the
          // whole batch is rejected, including the legal first record.
          contribute(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'x' }) }),
        ]),
      ).toThrow(ProviderKindConflictError);

      expect(observed).not.toHaveBeenCalled();
      expect(container.getAll(sinkToken)).toEqual([]);
    });

    it('C5: contributions are withdrawn and instances disposed when the module is disposed', async () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const sequence: string[] = [];
      const container = makeContainer();
      container.register('orders', [
        contribute(sinkToken, {
          scope: 'module',
          factory: () => sink('orders'),
          onDispose: () => {
            sequence.push('disposed');
          },
        }),
      ]);
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      container.getAll(sinkToken);
      container.subscribeAll(sinkToken, (values) => {
        sequence.push(`notified:${values.map((s) => s.id).join(',')}`);
      });

      // C7 disposal of the module's own scope, then the registry mutation
      // that notifies. `withdraw` is sync and `disposeModuleInstances` async, so
      // the container cannot fold the two together — see container.ts and
      // the PR for #13.
      await container.disposeModuleInstances('orders');
      container.withdraw('orders');

      expect(sequence).toEqual(['disposed', 'notified:payments']);
    });
  });

  describe('C5: notification discipline', () => {
    it('C5: a subscriber added during a notification pass does not receive the in-flight notification', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      const lateSubscriber = vi.fn();
      container.subscribeAll(sinkToken, () => {
        container.subscribeAll(sinkToken, lateSubscriber);
      });

      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);

      expect(lateSubscriber).not.toHaveBeenCalled();

      // …and it is a normal subscriber from the next mutation on.
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);
      expect(lateSubscriber).toHaveBeenCalledTimes(1);
    });

    it('C5: a subscriber removed during a notification pass does not receive the in-flight notification', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer();
      const victim = vi.fn();
      const survivor = vi.fn();
      // Subscription order: remover, victim, survivor. The remover
      // unsubscribes the victim before the pass reaches it.
      let unsubscribeVictim = (): void => {};
      container.subscribeAll(routeToken, () => {
        unsubscribeVictim();
      });
      unsubscribeVictim = container.subscribeAll(routeToken, victim);
      container.subscribeAll(routeToken, survivor);

      container.register('orders', [contribute(routeToken, { factory: () => route('/orders') })]);

      expect(victim).not.toHaveBeenCalled();
      expect(survivor).toHaveBeenCalledTimes(1);
    });

    it('C5: a throwing subscriber does not prevent the others, and its error reaches onError', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const onError = vi.fn();
      const container = makeContainer({ onError });
      const boom = new Error('subscriber exploded');
      const before = vi.fn();
      const after = vi.fn();
      container.subscribeAll(sinkToken, before);
      container.subscribeAll(sinkToken, () => {
        throw boom;
      });
      container.subscribeAll(sinkToken, after);

      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);

      expect(before).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      // F4 (task 3.3): the second argument is the attribution the kernel
      // turns into an `ErrorInfo`. No `moduleId`: a subscriber belongs to
      // whoever registered it, which is often not a module at all.
      expect(onError).toHaveBeenCalledWith(boom, { phase: 'resolve' });
    });

    it('C5: a throwing contribution factory aborts only that token, reaches onError, and the change is redelivered on the next mutation', () => {
      const interceptorToken = createToken<Interceptor>('http/Interceptor');
      const onError = vi.fn();
      const container = makeContainer({ onError });
      const observed = vi.fn();
      container.subscribeAll(interceptorToken, observed);

      container.register('auth', [
        contribute(interceptorToken, {
          scope: 'transient',
          factory: (): Interceptor => {
            throw new Error('auth interceptor failed to construct');
          },
        }),
      ]);

      expect(observed).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
        'Cannot resolve http/Interceptor: factory threw.',
      );

      // The baseline was deliberately left untouched, so the (now larger)
      // change is still reported once the collection can be constructed.
      container.withdraw('auth');
      container.register('logging', [
        contribute(interceptorToken, { factory: (): Interceptor => ({ name: 'logging', intercept: (url) => url }) }),
      ]);

      expect(observed).toHaveBeenCalledTimes(1);
      expect((observed.mock.calls[0]?.[0] as readonly Interceptor[]).map((i) => i.name)).toEqual(['logging']);
    });

    it('C5: unsubscribe is idempotent', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const onError = vi.fn();
      const container = makeContainer({ onError });
      const observed = vi.fn();
      const unsubscribe = container.subscribeAll(sinkToken, observed);

      unsubscribe();
      unsubscribe();
      unsubscribe();

      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);

      expect(observed).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('C5: unsubscribing one of two identical callbacks leaves the other subscribed', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      const observed = vi.fn();
      const first = container.subscribeAll(sinkToken, observed);
      container.subscribeAll(sinkToken, observed);

      first();
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);

      expect(observed).toHaveBeenCalledTimes(1);
    });

    it('C5: re-subscribing after the last unsubscribe re-baselines against the current collection', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      const observed = vi.fn();
      const unsubscribe = container.subscribeAll(sinkToken, observed);
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      unsubscribe();
      container.register('payments', [contribute(sinkToken, { factory: () => sink('payments') })]);

      const second = vi.fn();
      container.subscribeAll(sinkToken, second);
      container.register('core', [contribute(sinkToken, { factory: () => sink('core') })]);

      expect(second).toHaveBeenCalledTimes(1);
      expect((second.mock.calls[0]?.[0] as readonly AnalyticsSink[]).map((s) => s.id)).toEqual([
        'orders',
        'payments',
        'core',
      ]);
    });

    it('C5: subscribers of different tokens are independent', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer();
      const sinkObserver = vi.fn();
      const routeObserver = vi.fn();
      container.subscribeAll(sinkToken, sinkObserver);
      container.subscribeAll(routeToken, routeObserver);

      container.register('orders', [
        contribute(sinkToken, { factory: () => sink('orders') }),
        contribute(routeToken, { factory: () => route('/orders') }),
      ]);

      expect(sinkObserver).toHaveBeenCalledTimes(1);
      expect(routeObserver).toHaveBeenCalledTimes(1);
      expect((sinkObserver.mock.calls[0]?.[0] as readonly AnalyticsSink[])[0]?.id).toBe('orders');
      expect((routeObserver.mock.calls[0]?.[0] as readonly RouteConfig[])[0]?.path).toBe('/orders');
    });
  });

  // The C4 question C4 itself does not answer: a contribution collection has
  // N producers and M consumers, and `MODULE_ID` inside a `contribute()`
  // factory has to mean one of them. It means the **owner** — see the
  // argument in collections.ts's header. These tests pin that across all
  // three scopes, and pin the property that motivated it: the answer does
  // not depend on who resolved first, or on whether anyone subscribed.
  describe('C4: MODULE_ID inside a contribution', () => {
    it("C4/C9: a 'singleton' contribution resolves MODULE_ID to its own owner, not to the caller", () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const container = makeContainer();
      container.register('orders', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);
      container.register('payments', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      expect(container.getAll(capabilityToken)).toEqual(['built-for:orders', 'built-for:payments']);
    });

    it("C4/C9: a 'module' contribution resolves MODULE_ID to its own owner — the same id C2 keys its scope cache by", () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const container = makeContainer();
      container.register('orders', [
        contribute(capabilityToken, { scope: 'module', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);
      container.register('payments', [
        contribute(capabilityToken, { scope: 'module', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      expect(container.getAll(capabilityToken)).toEqual(['built-for:orders', 'built-for:payments']);
    });

    it("C4/C9: a 'transient' contribution resolves MODULE_ID to its own owner on every construction", () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const container = makeContainer();
      container.register('orders', [
        contribute(capabilityToken, { scope: 'transient', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      expect(container.getAll(capabilityToken)).toEqual(['built-for:orders']);
      expect(container.getAll(capabilityToken)).toEqual(['built-for:orders']);
    });

    it('C4: the presence of a subscriber cannot change what MODULE_ID resolves to (a notification pass invents no resolution context)', () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      // The regression this pins: a notify pass used to resolve on behalf of
      // ADR-2's `'app'`, and because singleton/module scopes cache, that
      // fabricated context became the *only* context. Identical registration,
      // identical read — the only difference is whether anyone subscribed.
      const withoutSubscriber = makeContainer();
      withoutSubscriber.register('orders', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      const withSubscriber = makeContainer();
      withSubscriber.subscribeAll(capabilityToken, () => {});
      withSubscriber.register('orders', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      expect(withoutSubscriber.getAll(capabilityToken)).toEqual(['built-for:orders']);
      expect(withSubscriber.getAll(capabilityToken)).toEqual(['built-for:orders']);
      expect(withSubscriber.getAll(capabilityToken)).toEqual(withoutSubscriber.getAll(capabilityToken));
    });

    it('C4: the value delivered to a subscriber is the same instance a later getAll returns', () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const container = makeContainer();
      const delivered: (readonly AnalyticsSink[])[] = [];
      container.subscribeAll(sinkToken, (values) => delivered.push(values));
      container.register('orders', [
        contribute(sinkToken, { scope: 'singleton', factory: () => sink('orders') }),
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);

      expect(delivered[0]?.[0]).toBe(container.getAll(sinkToken)[0]);
      expect(container.getAll(capabilityToken)).toEqual(['built-for:orders']);
    });

    it('C4: allOf() deps see the owner too — the aggregating module does not stamp its id on other modules\' contributions', () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const reportToken = createToken<readonly string[]>('capabilities/Report');
      const container = makeContainer();
      container.register('orders', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);
      container.register('payments', [
        contribute(capabilityToken, { scope: 'singleton', deps: [MODULE_ID], factory: (id) => `built-for:${id}` }),
      ]);
      container.register('inventory', [
        provide(reportToken, { deps: [allOf(capabilityToken)], factory: (caps) => caps }),
      ]);

      expect(container.resolve(reportToken, { requester: 'inventory' })).toEqual([
        'built-for:orders',
        'built-for:payments',
      ]);
      expect(container.getAll(capabilityToken)).toEqual(container.resolve(reportToken, { requester: 'inventory' }));
    });

    it("C4: a contribution's own dependency chain still propagates that contribution's owner unchanged", () => {
      const capabilityToken = createToken<string>('capabilities/Capability');
      const taggerToken = createToken<string>('logging/Tag');
      const container = makeContainer();
      // `logging` owns the nested provider, but C4's propagation rule says
      // the chain's seed wins — and for a contribution the seed is the
      // contributing module, not the module that owns the nested provider
      // and not whoever asked for the collection.
      container.register('logging', [
        provide(taggerToken, { scope: 'transient', deps: [MODULE_ID], factory: (id) => `tag:${id}` }),
      ]);
      container.register('orders', [
        contribute(capabilityToken, { scope: 'transient', deps: [taggerToken], factory: (tag) => tag }),
      ]);

      expect(container.getAll(capabilityToken)).toEqual(['tag:orders']);
      // A single provider resolved directly still carries the real caller.
      expect(container.resolve(taggerToken, { requester: 'checkout' })).toBe('tag:checkout');
    });
  });

  describe('C5: empty and mixed-kind edges', () => {
    it('C5: an unknown token yields [] rather than an error', () => {
      const routeToken = createToken<RouteConfig>('navigation/RouteConfig');
      const container = makeContainer();

      expect(container.getAll(routeToken)).toEqual([]);
    });

    it('C5: a token with a single provide()d provider yields [] — provide and contribute never mix', () => {
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const container = makeContainer();
      container.register('orders', [
        provide(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'order-1' }) }),
      ]);

      expect(container.getAll(orderServiceToken)).toEqual([]);
      // …and the single provider still resolves normally.
      expect(container.resolve(orderServiceToken, { requester: 'checkout' })).toBeDefined();
    });

    it('C5: provide on a contributed token / contribute on a provided token is a registration error', () => {
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const container = makeContainer();
      container.register('orders', [contribute(sinkToken, { factory: () => sink('orders') })]);
      container.register('checkout', [
        provide(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'order-1' }) }),
      ]);

      expect(() =>
        container.register('analytics', [provide(sinkToken, { factory: () => sink('analytics') })]),
      ).toThrow(
        "Token 'analytics/Sink': 'orders' registered it via contribute(), but 'analytics' is trying to provide() it. provide() and contribute() cannot be mixed for the same token.",
      );
      expect(() =>
        container.register('audit', [
          contribute(orderServiceToken, { factory: (): OrderService => ({ place: async () => 'x' }) }),
        ]),
      ).toThrow(
        "Token 'orders/OrderService': 'checkout' registered it via provide(), but 'audit' is trying to contribute() it. provide() and contribute() cannot be mixed for the same token.",
      );
    });
  });
});
