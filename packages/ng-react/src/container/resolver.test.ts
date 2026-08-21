import { describe, expect, it, vi } from 'vitest';
import { CircularDependencyError, DisposeTimeoutError, ProviderFactoryError, ResolutionError } from '../errors';
import { contribute, provide } from '../provider';
import { allOf, createToken, MODULE_ID, optional } from '../token';
import { ProviderRegistry } from './registry';
import { Resolver } from './resolver';
import type { ResolverOptions } from './resolver';

// Realistic, differently-typed domain shapes — deliberately not
// `Token<unknown>` everywhere (AGENTS.md §9 names that weakening as a
// reject reason: it is exactly what let the ADR-10 invariance defect
// survive stage 1). Each token below carries its own distinct interface.
interface OrderService {
  place(): Promise<string>;
}
interface PaymentGateway {
  charge(cents: number): Promise<void>;
}
interface Repo {
  find(id: string): unknown;
}
interface Http {
  get(url: string): Promise<unknown>;
}
interface Logger {
  log(msg: string): void;
}
interface AnalyticsSink {
  track(event: string): void;
}

function makeRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

function makeResolver(registry: ProviderRegistry, options?: ResolverOptions): Resolver {
  return new Resolver(registry, options);
}

describe('Resolver', () => {
  describe('C2: scopes', () => {
    it('singleton: referential stability across repeated resolutions, constructed once', () => {
      const registry = makeRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      const factory = vi.fn((): OrderService => ({ place: async () => 'order-1' }));
      registry.register('orders', [provide(token, { scope: 'singleton', factory })]);
      const resolver = makeResolver(registry);

      const a = resolver.resolve(token, { requester: 'app' });
      const b = resolver.resolve(token, { requester: 'checkout' });

      expect(a).toBe(b);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("module: keyed by the provider's OWNER, not the requester — two different consumers get the same instance", () => {
      const registry = makeRegistry();
      const token = createToken<Logger>('orders/Logger');
      const factory = vi.fn((): Logger => ({ log: () => {} }));
      // Owner is 'orders'. Two *different* requesters ('billing' and
      // 'checkout', neither of which is 'orders') resolve it below — this
      // is the single most likely misreading of the spec (task issue's own
      // words), so it gets its own dedicated, unambiguous test.
      registry.register('orders', [provide(token, { scope: 'module', factory })]);
      const resolver = makeResolver(registry);

      const forBilling = resolver.resolve(token, { requester: 'billing' });
      const forCheckout = resolver.resolve(token, { requester: 'checkout' });

      expect(forBilling).toBe(forCheckout);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('transient: a new instance is constructed on every resolution', () => {
      const registry = makeRegistry();
      const token = createToken<Repo>('orders/Repo');
      const factory = vi.fn((): Repo => ({ find: () => undefined }));
      registry.register('orders', [provide(token, { scope: 'transient', factory })]);
      const resolver = makeResolver(registry);

      const a = resolver.resolve(token, { requester: 'app' });
      const b = resolver.resolve(token, { requester: 'app' });

      expect(a).not.toBe(b);
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('concurrent resolution of the same singleton constructs once', () => {
      // No real concurrency in a single JS thread: two resolve() calls in
      // sequence are the faithful test, and — because caching happens
      // synchronously right after the factory call, before anything the
      // factory returns is awaited — this also covers a singleton backed
      // by an async factory (see the §7.3 "async factories" test below):
      // both resolutions see the exact same still-pending promise.
      const registry = makeRegistry();
      const token = createToken<Promise<OrderService>>('orders/OrderService');
      const factory = vi.fn((): Promise<OrderService> => Promise.resolve({ place: async () => 'order-1' }));
      registry.register('orders', [provide(token, { scope: 'singleton', factory })]);
      const resolver = makeResolver(registry);

      const a = resolver.resolve(token, { requester: 'app' });
      const b = resolver.resolve(token, { requester: 'app' });

      expect(a).toBe(b);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('C3: laziness', () => {
    it('registering providers constructs nothing', () => {
      const registry = makeRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      const factory = vi.fn((): OrderService => ({ place: async () => 'order-1' }));
      registry.register('orders', [provide(token, { factory })]);
      makeResolver(registry);

      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('C4: resolution context propagation', () => {
    it("MODULE_ID resolves to the requester, per ADR-2 the reserved id 'app' outside any module", () => {
      const registry = makeRegistry();
      const resolver = makeResolver(registry);

      expect(resolver.resolve(MODULE_ID, { requester: 'app' })).toBe('app');
      expect(resolver.resolve(MODULE_ID, { requester: 'orders' })).toBe('orders');
    });

    it('propagates the original requester unchanged through a 3-deep resolution chain', () => {
      const registry = makeRegistry();
      const level3 = createToken<string>('platform/Level3');
      const level2 = createToken<{ owner: string }>('payments/Level2');
      const level1 = createToken<{ owner: string }>('orders/Level1');

      // Deliberately owned by three *different* modules, none of which is
      // the requester: only the propagated requester id may leak through,
      // never an owning module's own id.
      registry.register('platform', [provide(level3, { deps: [MODULE_ID], factory: (id: string) => id })]);
      registry.register('payments', [
        provide(level2, { deps: [level3], factory: (owner: string) => ({ owner }) }),
      ]);
      registry.register('orders', [
        provide(level1, { deps: [level2], factory: (inner: { owner: string }) => ({ owner: inner.owner }) }),
      ]);
      const resolver = makeResolver(registry);

      const result = resolver.resolve(level1, { requester: 'checkout' });

      expect(result).toEqual({ owner: 'checkout' });
    });
  });

  describe('optional()', () => {
    it('resolves to undefined when there is no provider', () => {
      const registry = makeRegistry();
      const missing = createToken<PaymentGateway>('payments/PaymentGateway');
      const consumer = createToken<PaymentGateway | undefined>('orders/OptionalGateway');
      registry.register('orders', [
        provide(consumer, { deps: [optional(missing)], factory: (gateway) => gateway }),
      ]);
      const resolver = makeResolver(registry);

      expect(resolver.resolve(consumer, { requester: 'orders' })).toBeUndefined();
    });

    it('does not swallow an error thrown by a factory that WAS found', () => {
      const registry = makeRegistry();
      const boom = createToken<PaymentGateway>('payments/PaymentGateway');
      const consumer = createToken<PaymentGateway | undefined>('orders/OptionalGateway');
      registry.register('payments', [
        provide(boom, {
          factory: (): PaymentGateway => {
            throw new Error('payments offline');
          },
        }),
      ]);
      registry.register('orders', [
        provide(consumer, { deps: [optional(boom)], factory: (gateway) => gateway }),
      ]);
      const resolver = makeResolver(registry);

      expect(() => resolver.resolve(consumer, { requester: 'orders' })).toThrow(ProviderFactoryError);
    });
  });

  describe('allOf()', () => {
    it('C5: resolves every contribution to the token, in the order collections.ts defines (one shared ordering path)', () => {
      const registry = makeRegistry();
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const aggregatorToken = createToken<readonly AnalyticsSink[]>('analytics/AllSinks');
      const ordersSink: AnalyticsSink = { track: () => {} };
      const paymentsSink: AnalyticsSink = { track: () => {} };
      registry.register('orders', [contribute(sinkToken, { factory: () => ordersSink })]);
      registry.register('payments', [contribute(sinkToken, { factory: () => paymentsSink })]);
      registry.register('analytics', [
        provide(aggregatorToken, { deps: [allOf(sinkToken)], factory: (sinks) => sinks }),
      ]);
      const resolver = makeResolver(registry);

      const sinks = resolver.resolve(aggregatorToken, { requester: 'analytics' });

      expect(sinks).toEqual([ordersSink, paymentsSink]);
    });

    it('resolves to an empty array when the token has no contributions', () => {
      const registry = makeRegistry();
      const sinkToken = createToken<AnalyticsSink>('analytics/Sink');
      const aggregatorToken = createToken<readonly AnalyticsSink[]>('analytics/AllSinks');
      registry.register('analytics', [
        provide(aggregatorToken, { deps: [allOf(sinkToken)], factory: (sinks) => sinks }),
      ]);
      const resolver = makeResolver(registry);

      expect(resolver.resolve(aggregatorToken, { requester: 'analytics' })).toEqual([]);
    });
  });

  describe('§7.3: no circular resolution of any kind', () => {
    it('throws CircularDependencyError with the full cycle path — produced message pinned verbatim', () => {
      const registry = makeRegistry();
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const repoToken = createToken<Repo>('orders/Repo');
      registry.register('orders', [
        provide(orderServiceToken, {
          deps: [repoToken],
          factory: (): OrderService => ({ place: async () => 'x' }),
        }),
        provide(repoToken, {
          deps: [orderServiceToken],
          factory: (): Repo => ({ find: () => undefined }),
        }),
      ]);
      const resolver = makeResolver(registry);

      let thrown: unknown;
      try {
        resolver.resolve(orderServiceToken, { requester: 'orders' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CircularDependencyError);
      const message = (thrown as Error).message;
      // Pinned verbatim against the issue's own target message shape.
      expect(message).toBe(
        'Circular dependency while resolving orders/OrderService: orders/OrderService → orders/Repo → orders/OrderService.',
      );
    });

    it('no lazy proxies / forward refs: the thrown error carries the cyclePath data too', () => {
      const registry = makeRegistry();
      const a = createToken<Repo>('m/A');
      const b = createToken<Repo>('m/B');
      const c = createToken<Repo>('m/C');
      registry.register('m', [
        provide(a, { deps: [b], factory: (): Repo => ({ find: () => undefined }) }),
        provide(b, { deps: [c], factory: (): Repo => ({ find: () => undefined }) }),
        provide(c, { deps: [a], factory: (): Repo => ({ find: () => undefined }) }),
      ]);
      const resolver = makeResolver(registry);

      let thrown: unknown;
      try {
        resolver.resolve(a, { requester: 'm' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CircularDependencyError);
      expect((thrown as CircularDependencyError).cyclePath).toEqual(['m/A', 'm/B', 'm/C']);
    });
  });

  describe('C8: resolution failure diagnostic', () => {
    it('reports the full chain with the dependsOn suggestion when the missing token belongs to a known, un-depended-on module', () => {
      const registry = makeRegistry();
      registry.setKnownModules(['orders', 'payments']);
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
      // 'payments/PaymentGateway' is never registered — it is a known
      // module, but 'orders' does not depend on it.
      registry.register('orders', [provide(orderServiceToken, { deps: [gatewayToken], factory: () => ({ place: async () => 'x' }) })]);
      const resolver = makeResolver(registry, { getDependsOn: (id) => (id === 'orders' ? [] : undefined) });

      let thrown: unknown;
      try {
        resolver.resolve(orderServiceToken, { requester: 'orders' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ResolutionError);
      const message = (thrown as Error).message;
      // The issue's own target message, quoted verbatim.
      expect(message).toBe(
        "Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.",
      );
    });

    it('reports the chain with no suggestion when the missing token names an unknown module (or is already in dependsOn)', () => {
      const registry = makeRegistry();
      registry.setKnownModules(['orders']); // 'payments' deliberately not known
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
      registry.register('orders', [provide(orderServiceToken, { deps: [gatewayToken], factory: () => ({ place: async () => 'x' }) })]);
      const resolver = makeResolver(registry, { getDependsOn: () => [] });

      let thrown: unknown;
      try {
        resolver.resolve(orderServiceToken, { requester: 'orders' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ResolutionError);
      expect((thrown as Error).message).toBe('Cannot resolve orders/OrderService → payments/PaymentGateway: no provider.');
    });

    it('omits the suggestion when the missing module IS already in dependsOn (something else is wrong — no fix to suggest)', () => {
      const registry = makeRegistry();
      registry.setKnownModules(['orders', 'payments']);
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
      registry.register('orders', [provide(orderServiceToken, { deps: [gatewayToken], factory: () => ({ place: async () => 'x' }) })]);
      const resolver = makeResolver(registry, { getDependsOn: (id) => (id === 'orders' ? ['payments'] : undefined) });

      expect(() => resolver.resolve(orderServiceToken, { requester: 'orders' })).toThrow(
        'Cannot resolve orders/OrderService → payments/PaymentGateway: no provider.',
      );
    });

    it('a top-level token with no provider produces a single-element path (no arrow)', () => {
      const registry = makeRegistry();
      const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
      const resolver = makeResolver(registry);

      expect(() => resolver.resolve(gatewayToken, { requester: 'app' })).toThrow(
        'Cannot resolve payments/PaymentGateway: no provider.',
      );
    });

    it('a factory that throws surfaces the original error as `cause` while the message still shows the path', () => {
      const registry = makeRegistry();
      const httpToken = createToken<Http>('platform/Http');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const originalError = new Error('ECONNREFUSED');
      registry.register('platform', [
        provide(httpToken, {
          factory: (): Http => {
            throw originalError;
          },
        }),
      ]);
      registry.register('orders', [
        provide(orderServiceToken, { deps: [httpToken], factory: () => ({ place: async () => 'x' }) }),
      ]);
      const resolver = makeResolver(registry);

      let thrown: unknown;
      try {
        resolver.resolve(orderServiceToken, { requester: 'orders' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ProviderFactoryError);
      expect((thrown as Error).cause).toBe(originalError);
      expect((thrown as Error).message).toBe('Cannot resolve orders/OrderService → platform/Http: factory threw.');
    });
  });

  describe('§7.3: no property injection, no decorators — only explicit deps reach the factory', () => {
    it('factory receives exactly the resolved deps, positionally, and nothing else', () => {
      const registry = makeRegistry();
      const httpToken = createToken<Http>('platform/Http');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const http: Http = { get: async () => undefined };
      const factory = vi.fn((): OrderService => ({ place: async () => 'x' }));
      registry.register('platform', [provide(httpToken, { factory: () => http })]);
      registry.register('orders', [provide(orderServiceToken, { deps: [httpToken, MODULE_ID], factory })]);
      const resolver = makeResolver(registry);

      resolver.resolve(orderServiceToken, { requester: 'checkout' });

      expect(factory).toHaveBeenCalledWith(http, 'checkout');
      expect(factory.mock.calls[0]).toHaveLength(2);
    });
  });

  describe('§7.3: no optional-by-default', () => {
    it('a plain (unwrapped) dependency with no provider throws — only optional() opts out', () => {
      const registry = makeRegistry();
      const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      registry.register('orders', [
        provide(orderServiceToken, { deps: [gatewayToken], factory: () => ({ place: async () => 'x' }) }),
      ]);
      const resolver = makeResolver(registry);

      expect(() => resolver.resolve(orderServiceToken, { requester: 'orders' })).toThrow(ResolutionError);
    });
  });

  describe('§7.3: no async factories — a factory returning a promise is not awaited', () => {
    it('yields the promise itself as the resolved value', () => {
      const registry = makeRegistry();
      const token = createToken<Promise<OrderService>>('orders/OrderService');
      const pending = Promise.resolve({ place: async () => 'x' });
      registry.register('orders', [provide(token, { factory: () => pending })]);
      const resolver = makeResolver(registry);

      const result = resolver.resolve(token, { requester: 'orders' });

      // If this were awaited, `result` would be the resolved OrderService,
      // not a Promise — asserting the reference proves it was returned
      // as-is, synchronously, with no awaiting in between.
      expect(result).toBe(pending);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('C7: disposal', () => {
    it('disposeModuleScope disposes module-scoped instances owned by that module, in reverse construction order', async () => {
      const registry = makeRegistry();
      const order: string[] = [];
      const firstToken = createToken<Logger>('orders/First');
      const secondToken = createToken<Logger>('orders/Second');
      registry.register('orders', [
        provide(firstToken, {
          scope: 'module',
          factory: () => ({ log: () => {} }),
          onDispose: () => {
            order.push('first');
          },
        }),
        provide(secondToken, {
          scope: 'module',
          factory: () => ({ log: () => {} }),
          onDispose: () => {
            order.push('second');
          },
        }),
      ]);
      const resolver = makeResolver(registry);
      resolver.resolve(firstToken, { requester: 'orders' });
      resolver.resolve(secondToken, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(order).toEqual(['second', 'first']);
    });

    it('never disposes transient instances (they are never tracked)', async () => {
      // C7/provider.ts already reject `onDispose` on a 'transient' provider
      // at declaration time (transient lifetime is the consumer's
      // responsibility) — so the only way to prove the *container* never
      // disposes a transient is via the instance.dispose() fallback path.
      const registry = makeRegistry();
      const instanceDispose = vi.fn();
      const token = createToken<{ dispose(): void }>('orders/Transient');
      registry.register('orders', [
        provide(token, { scope: 'transient', factory: () => ({ dispose: instanceDispose }) }),
      ]);
      const resolver = makeResolver(registry);
      resolver.resolve(token, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');
      await resolver.dispose();

      expect(instanceDispose).not.toHaveBeenCalled();
    });

    it('calls provider.onDispose(instance) when declared, never instance.dispose() as well', async () => {
      const registry = makeRegistry();
      const onDispose = vi.fn();
      const instanceDispose = vi.fn();
      const token = createToken<Logger & { dispose(): void }>('orders/Logger');
      registry.register('orders', [
        provide(token, {
          scope: 'module',
          factory: () => ({ log: () => {}, dispose: instanceDispose }),
          onDispose,
        }),
      ]);
      const resolver = makeResolver(registry);
      resolver.resolve(token, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(onDispose).toHaveBeenCalledTimes(1);
      expect(instanceDispose).not.toHaveBeenCalled();
    });

    it('falls back to instance.dispose() when the provider declares no onDispose', async () => {
      const registry = makeRegistry();
      const instanceDispose = vi.fn();
      const token = createToken<{ dispose(): void }>('orders/Logger');
      registry.register('orders', [provide(token, { scope: 'module', factory: () => ({ dispose: instanceDispose }) })]);
      const resolver = makeResolver(registry);
      resolver.resolve(token, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(instanceDispose).toHaveBeenCalledTimes(1);
    });

    it('a disposal error does not abort remaining disposals (L3)', async () => {
      const registry = makeRegistry();
      const onError = vi.fn();
      const secondDisposed = vi.fn();
      const firstToken = createToken<Logger>('orders/First');
      const secondToken = createToken<Logger>('orders/Second');
      registry.register('orders', [
        provide(firstToken, {
          scope: 'module',
          factory: () => ({ log: () => {} }),
          onDispose: () => {
            throw new Error('dispose boom');
          },
        }),
        provide(secondToken, { scope: 'module', factory: () => ({ log: () => {} }), onDispose: secondDisposed }),
      ]);
      const resolver = makeResolver(registry, { onError });
      resolver.resolve(firstToken, { requester: 'orders' });
      resolver.resolve(secondToken, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(secondDisposed).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('dispose boom');
    });

    it('after a scope is disposed, resolving a module-scoped provider of that module constructs a fresh instance', async () => {
      const registry = makeRegistry();
      const token = createToken<Logger>('orders/Logger');
      const factory = vi.fn(() => ({ log: () => {} }));
      registry.register('orders', [provide(token, { scope: 'module', factory })]);
      const resolver = makeResolver(registry);
      const first = resolver.resolve(token, { requester: 'orders' });
      await resolver.disposeModuleScope('orders');

      const second = resolver.resolve(token, { requester: 'orders' });

      expect(second).not.toBe(first);
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('dispose() tears down singletons only, in reverse construction order', async () => {
      const registry = makeRegistry();
      const order: string[] = [];
      const moduleScopedDispose = vi.fn();
      const firstToken = createToken<Logger>('orders/First');
      const secondToken = createToken<Logger>('orders/Second');
      const moduleScopedToken = createToken<Logger>('orders/ModuleScoped');
      registry.register('orders', [
        provide(firstToken, {
          scope: 'singleton',
          factory: () => ({ log: () => {} }),
          onDispose: () => {
            order.push('first');
          },
        }),
        provide(secondToken, {
          scope: 'singleton',
          factory: () => ({ log: () => {} }),
          onDispose: () => {
            order.push('second');
          },
        }),
        provide(moduleScopedToken, { scope: 'module', factory: () => ({ log: () => {} }), onDispose: moduleScopedDispose }),
      ]);
      const resolver = makeResolver(registry);
      resolver.resolve(firstToken, { requester: 'app' });
      resolver.resolve(secondToken, { requester: 'app' });
      resolver.resolve(moduleScopedToken, { requester: 'orders' });

      await resolver.dispose();

      expect(order).toEqual(['second', 'first']);
      expect(moduleScopedDispose).not.toHaveBeenCalled();
    });

    it('ADR-1: awaits async disposal with a timeout; on timeout the instance is marked disposed and the timeout is reported', async () => {
      const registry = makeRegistry();
      const onError = vi.fn();
      const token = createToken<Logger>('orders/Logger');
      const factory = vi.fn(() => ({ log: () => {} }));
      registry.register('orders', [
        provide(token, {
          scope: 'module',
          factory,
          // Never settles — forces the timeout branch.
          onDispose: () => new Promise<void>(() => {}),
        }),
      ]);
      const resolver = makeResolver(registry, { onError, disposeTimeoutMs: 20 });
      resolver.resolve(token, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(DisposeTimeoutError);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
        "Disposing 'orders/Logger' (owned by 'orders') did not complete within 20ms. The instance is marked disposed regardless; the dispose call may still be running in the background.",
      );

      // "marked disposed anyway": the next resolution constructs fresh.
      resolver.resolve(token, { requester: 'orders' });
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('ADR-1: async disposal that settles before the timeout is not reported as a timeout', async () => {
      const registry = makeRegistry();
      const onError = vi.fn();
      const token = createToken<Logger>('orders/Logger');
      registry.register('orders', [
        provide(token, {
          scope: 'module',
          factory: () => ({ log: () => {} }),
          onDispose: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
        }),
      ]);
      const resolver = makeResolver(registry, { onError, disposeTimeoutMs: 2000 });
      resolver.resolve(token, { requester: 'orders' });

      await resolver.disposeModuleScope('orders');

      expect(onError).not.toHaveBeenCalled();
    });
  });
});
