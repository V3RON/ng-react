// `@app/orders` — the module's own test, against `createTestKernel` (**R4**).
//
// This is acceptance criterion 7 in this module's terms: "activate `orders`
// with a mocked `payments/PaymentGateway`, run an `init`-registered listener,
// dispose, and prove zero leaked listeners — in a plain Jest/Vitest
// environment with no React renderer".

import { describe, expect, it } from 'vitest';
import { createTestKernel, defineModule, evaluationLog, provide } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef } from '@ng-react/kernel';
import { AuthModule, DiagnosticPanelToken, SessionServiceToken } from '@app/auth/contract';
import type { Session, SessionService } from '@app/auth/contract';
import { PaymentGatewayToken, PaymentsModule } from '@app/payments/contract';
import { OrderServiceToken, OrdersModule } from './contract';
import { acceptHotUpdate, module } from './module';
import type { ModuleHotContext } from './module';

// **G2 + B1**: a `dependsOn` ref whose descriptor was never registered is a
// fatal registration error, and this package may not import the real one —
// `<pkg>/module` is reserved for the composition root. So each dependency is
// stood up here as an empty descriptor built from the ref its *contract*
// exports, which is the one thing this package is allowed to import (D3).
// Give a dependency real behaviour through `overrides` (C6), never by
// registering its actual descriptor: that would be testing it too.
const dependencyStubs: ModuleDescriptor[] = [
  defineModule({ id: AuthModule, dependsOn: [], load: 'lazy', critical: false }),
  defineModule({ id: PaymentsModule, dependsOn: [], load: 'lazy', critical: false }),
];

/** A `SessionService` double whose emitter half is drivable from a test. */
function fakeSessionService(): SessionService & { emit: () => void } {
  let session: Session | undefined = { userId: 'test-user', startedAt: 0 };
  const handlers = new Set<(next: Session | undefined) => void>();
  return {
    login: (userId) => (session = { userId, startedAt: 0 }),
    logout: () => {
      session = undefined;
    },
    current: () => session,
    on: (_event, handler) => {
      handlers.add(handler);
    },
    off: (_event, handler) => {
      handlers.delete(handler);
    },
    subscribe: () => () => {},
    emit: () => {
      for (const handler of [...handlers]) {
        handler(session);
      }
    },
  };
}

describe('orders module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    // The overrides are not incidental here: `orders`' `init` resolves its
    // own service, which resolves `payments/PaymentGateway`, and the stubs
    // provide nothing. Without them this test would measure a *failed*
    // activation's evaluation log, which is a different (and much weaker)
    // claim than the one it makes.
    const kernel = createTestKernel({
      modules: [...dependencyStubs, module],
      overrides: [
        provide(PaymentGatewayToken, {
          factory: () => ({
            authorize: async (
              amount: { amountMinor: number; currency: 'EUR' | 'USD' },
              reference: string,
            ) => ({ id: 'mock-authorization', amount, authorizedFor: reference }),
          }),
        }),
        provide(SessionServiceToken, { factory: () => fakeSessionService() }),
      ],
    });
    expect(kernel.status(OrdersModule)).toBe('registered');
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(OrdersModule);

    // **A1**: the two stubs activate first, in topological order, and neither
    // evaluates an implementation file of its own — so the log below is
    // `orders`' alone.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'orders/providers.ts',
      '<init>',
      'orders/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('criterion 7: activates with a mocked PaymentGateway, runs the init listener, disposes clean', async () => {
    const session = fakeSessionService();
    const kernel = createTestKernel({
      modules: [...dependencyStubs, module],
      // **C6**: `override: true`. The stubs provide nothing, so these are the
      // only records for these tokens — but R4 re-declares every override as
      // an override anyway, and §17 (#37) makes a plain `provide` that loses
      // to one *superseded* rather than fatal, which is why mocking a
      // dependency cannot kill the module that normally provides it.
      overrides: [
        provide(PaymentGatewayToken, {
          factory: () => ({
            authorize: async (amount: { amountMinor: number; currency: 'EUR' | 'USD' }, reference: string) => ({
              id: 'mock-authorization',
              amount,
              authorizedFor: reference,
            }),
          }),
        }),
        provide(SessionServiceToken, { factory: () => session }),
      ],
    });

    await kernel.activate(OrdersModule);
    expect(kernel.status(OrdersModule)).toBe('ready');

    const service = kernel.get(OrderServiceToken);
    await expect(service.place(2500)).resolves.toEqual({
      id: 'test-user-1',
      authorizationId: 'mock-authorization',
      placedBy: 'test-user',
    });

    // **L2**: the listener `init` registered with `ctx.on` is live.
    expect(service.sessionChanges()).toBe(0);
    session.emit();
    session.emit();
    expect(service.sessionChanges()).toBe(2);

    // C5: `orders` contributes one row, and it reports the live service.
    expect(kernel.getAll(DiagnosticPanelToken).map((panel) => panel.describe())).toEqual([
      '1 placed, 2 session change(s) seen',
    ]);

    await kernel.dispose();

    // **L3**: the listener is gone, so the emitter reaches nothing. Asserted
    // by driving the emitter *after* disposal rather than by counting
    // handlers — a handler that was removed from the set but still reachable
    // through a closure would pass the count and fail this.
    session.emit();
    expect(service.sessionChanges()).toBe(2);

    expect(kernel.errors).toEqual([]);
    // **H7**: zero leaked listeners and zero leaked effects, which is the
    // clause criterion 7 names explicitly.
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('C8: placing an order with no session fails with a message naming the requester', async () => {
    const session = fakeSessionService();
    session.logout();
    const kernel = createTestKernel({
      modules: [...dependencyStubs, module],
      overrides: [
        provide(PaymentGatewayToken, {
          factory: () => ({
            authorize: async () => ({
              id: 'mock-authorization',
              amount: { amountMinor: 0, currency: 'EUR' as const },
              authorizedFor: 'unused',
            }),
          }),
        }),
        provide(SessionServiceToken, { factory: () => session }),
      ],
    });
    await kernel.activate(OrdersModule);

    // **C4**: `'orders'`, because the chain that built the service was started
    // by this module's own `init`. Nothing passed that string anywhere.
    await expect(kernel.get(OrderServiceToken).place(100)).rejects.toThrow(
      "orders: cannot place an order for 'orders' with no session.",
    );

    await kernel.dispose();
  });

  // **H2**: the hot block, executed rather than read. `ModuleHotContext` is
  // structural for exactly this reason — a plain object literal is a valid
  // host, so the accept callback can be captured and driven by hand, with no
  // bundler in the path. Three branches, and each one is load-bearing: drop
  // the guard and the first fails, drop the `hotReplace` and the third fails,
  // drop the re-arm and the third fails too.
  describe('H2: acceptHotUpdate', () => {
    /** A `Kernel` whose `hotReplace` records instead of running. */
    function recordingKernel(into: { ref: string; next: string | undefined }[]): Kernel {
      const kernel = createTestKernel({ modules: [] });
      return {
        ...kernel,
        hotReplace: async (ref: ModuleRef, next?: ModuleDescriptor) => {
          into.push({ ref: ref.id, next: next?.id.id });
        },
      };
    }

    /** A hot context that captures the callback the module registers. */
    function fakeHost(): { hot: ModuleHotContext; fire: (next?: unknown) => void } {
      let accepted: ((next?: unknown) => void) | undefined;
      return {
        hot: {
          accept: (callback) => {
            accepted = callback;
          },
        },
        fire: (next) => {
          if (accepted === undefined) {
            throw new Error('acceptHotUpdate registered no callback');
          }
          accepted(next);
        },
      };
    }

    it('with no hot context (a production build, and React Native today) it is a no-op', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      // Also the default-parameter path: under vitest `import.meta.hot` is
      // undefined, so the one-argument call the composition root makes lands
      // here too. Without the guard this throws on `undefined.accept`.
      expect(() => acceptHotUpdate(recordingKernel(replaced))).not.toThrow();
      expect(() => acceptHotUpdate(recordingKernel(replaced), undefined)).not.toThrow();
      expect(replaced).toEqual([]);
    });

    it('an update carrying no descriptor leaves the old one in force', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      const host = fakeHost();
      acceptHotUpdate(recordingKernel(replaced), host.hot);

      // A syntax error in the edited file, or a host that passes no namespace.
      host.fire(undefined);
      host.fire({});

      expect(replaced).toEqual([]);
    });

    it('an update carrying a descriptor calls hotReplace and re-arms the fresh copy', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      const kernel = recordingKernel(replaced);
      const host = fakeHost();
      acceptHotUpdate(kernel, host.hot);

      const rearmed: { kernel: Kernel; hot: ModuleHotContext | undefined }[] = [];
      host.fire({
        module,
        acceptHotUpdate: (nextKernel: Kernel, nextHot?: ModuleHotContext) => {
          rearmed.push({ kernel: nextKernel, hot: nextHot });
        },
      });

      expect(replaced).toEqual([{ ref: 'orders', next: 'orders' }]);
      // Without this, the *second* edit falls through to a full reload: the
      // fresh copy never accepted, and the composition root is not re-run.
      expect(rearmed).toEqual([{ kernel, hot: host.hot }]);
    });
  });
});
