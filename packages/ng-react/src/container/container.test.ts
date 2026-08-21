import { describe, expect, it, vi } from 'vitest';
import { ResolutionError } from '../errors';
import { provide } from '../provider';
import { createToken } from '../token';
import { Container } from './container';

// Container is a thin facade over ProviderRegistry + Resolver (task 2.2's
// own framing) — these tests exercise the wiring end to end rather than
// re-proving every scope/disposal rule already pinned in resolver.test.ts
// and registry.test.ts.
interface OrderService {
  place(): Promise<string>;
}
interface PaymentGateway {
  charge(cents: number): Promise<void>;
}

describe('Container', () => {
  it('registers, resolves, and disposes through one object', async () => {
    const onDispose = vi.fn();
    const token = createToken<OrderService>('orders/OrderService');
    const container = new Container();

    container.register('orders', [
      provide(token, { scope: 'module', factory: (): OrderService => ({ place: async () => 'order-1' }), onDispose }),
    ]);

    const instance = container.resolve(token, { requester: 'checkout' });
    expect(await instance.place()).toBe('order-1');
    expect(container.hasToken(token)).toBe(true);
    expect(container.ownerOf(token)).toBe('orders');

    await container.disposeModuleInstances('orders');
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('wires setKnownModules and getDependsOn through to the C8 suggestion', () => {
    const gatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
    const orderServiceToken = createToken<OrderService>('orders/OrderService');
    const container = new Container({ getDependsOn: (id) => (id === 'orders' ? [] : undefined) });
    container.setKnownModules(['orders', 'payments']);
    container.register('orders', [
      provide(orderServiceToken, { deps: [gatewayToken], factory: () => ({ place: async () => 'x' }) }),
    ]);

    let thrown: unknown;
    try {
      container.resolve(orderServiceToken, { requester: 'orders' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    expect((thrown as Error).message).toBe(
      "Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.",
    );
  });

  it('dispose() tears down singletons at container teardown', async () => {
    const onDispose = vi.fn();
    const token = createToken<OrderService>('orders/OrderService');
    const container = new Container();
    container.register('orders', [
      provide(token, { scope: 'singleton', factory: (): OrderService => ({ place: async () => 'order-1' }), onDispose }),
    ]);
    container.resolve(token, { requester: 'app' });

    await container.dispose();

    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('withdraw delegates to the registry without touching resolver caches (registration and resolution lifetimes are separate)', async () => {
    const onDispose = vi.fn();
    const token = createToken<OrderService>('orders/OrderService');
    const container = new Container();
    container.register('orders', [
      provide(token, { scope: 'module', factory: (): OrderService => ({ place: async () => 'order-1' }), onDispose }),
    ]);
    container.resolve(token, { requester: 'orders' });

    container.withdraw('orders');

    expect(container.hasToken(token)).toBe(false);
    expect(onDispose).not.toHaveBeenCalled();

    await container.disposeModuleInstances('orders');
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('inspect() reflects registered providers (G3)', () => {
    const token = createToken<OrderService>('orders/OrderService');
    const container = new Container();
    container.register('orders', [provide(token, { factory: () => ({ place: async () => 'x' }) })]);

    const snapshot = container.inspect();

    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]?.tokenLabel).toBe('orders/OrderService');
    expect(snapshot.providers[0]?.owner).toBe('orders');
  });
});
