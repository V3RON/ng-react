// Regression tests that transcribe the spec's own worked examples literally.
//
// These exist because of a defect found in stage 2: stage 1's unit tests only
// ever used single-token cases or `Token<unknown>`, so nothing exercised a
// heterogeneous `providers` array of concretely-typed tokens — which is what
// every real module writes, and what §7.2's example shows. It did not compile.
//
// The rule this file encodes: if the spec prints a code block, that code block
// must compile and run here, verbatim in structure and with realistic types.
// A worked example that does not compile is a broken API, not a broken example.

import { describe, expect, it } from 'vitest';
import { createToken, MODULE_ID } from './token';
import { provide, contribute } from './provider';
import { defineModule } from './define-module';
import { moduleRef } from './module-ref';
import type { AnyProviderRecord } from './provider';

// --- §7.1 / §7.2 vocabulary, with distinct concrete value types ---
interface OrderDraft { sku: string }
type OrderId = string;
interface OrderService {
  place(draft: OrderDraft): Promise<OrderId>;
}
interface AnalyticsSink {
  track(event: string): void;
}
interface Http {
  get(url: string): Promise<unknown>;
}
interface StorageRoot {
  forModule(id: string): { key: string };
}

const OrderServiceToken = createToken<OrderService>('orders/OrderService');
const AnalyticsSinkToken = createToken<AnalyticsSink>('orders/AnalyticsSink');
const HttpToken = createToken<Http>('platform/Http');
const StorageRootToken = createToken<StorageRoot>('platform/StorageRoot');

const OrdersModule = moduleRef('orders');
const AuthModule = moduleRef('auth');
const PaymentsModule = moduleRef('payments');

const ordersAnalyticsSink: AnalyticsSink = { track: () => {} };
function createOrderService(_http: Http, _scope: { key: string }): OrderService {
  return { place: async () => 'order-1' };
}

describe('spec worked examples compile and behave', () => {
  it('§7.2: a heterogeneous providers array of concretely-typed tokens type-checks', () => {
    // Transcribed from spec §7.2, including the MODULE_ID dep (C4).
    const providers = [
      provide(OrderServiceToken, {
        scope: 'module',
        deps: [HttpToken, StorageRootToken, MODULE_ID],
        factory: (http, storage, moduleId) => createOrderService(http, storage.forModule(moduleId)),
      }),
      contribute(AnalyticsSinkToken, {
        deps: [],
        factory: () => ordersAnalyticsSink,
      }),
    ];

    // The assignment that used to fail: two differently-typed records in one
    // array, widened to the erased element type the container stores (ADR-10).
    const erased: AnyProviderRecord[] = providers;

    expect(erased).toHaveLength(2);
    expect(erased[0]?.kind).toBe('provide');
    expect(erased[0]?.scope).toBe('module');
    expect(erased[1]?.kind).toBe('contribute');
    expect(erased[1]?.token.label).toBe('orders/AnalyticsSink');
  });

  it('§5.2: the descriptor example accepts that providers array through its thunk', () => {
    // Transcribed from spec §5.2, in the ADR-7 ESM thunk form.
    const descriptor = defineModule({
      id: OrdersModule,
      dependsOn: [AuthModule, PaymentsModule],
      load: 'lazy',
      critical: false,
      providers: () => [
        provide(OrderServiceToken, {
          deps: [HttpToken],
          factory: (http) => createOrderService(http, { key: 'orders' }),
        }),
        contribute(AnalyticsSinkToken, { deps: [], factory: () => ordersAnalyticsSink }),
      ],
      init: () => {},
      dispose: () => {},
    });

    expect(descriptor.id).toBe(OrdersModule);
    expect(descriptor.dependsOn).toEqual([AuthModule, PaymentsModule]);
    expect(descriptor.load).toBe('lazy');

    // D1: the thunk is only evaluated when the kernel asks for it.
    const records = descriptor.providers?.();
    expect(records).toHaveLength(2);
  });

  it('§7.2: factory parameter types are still inferred from deps, not erased', () => {
    // ADR-10 erases records, never the declaration site. This must stay exact.
    const record = provide(OrderServiceToken, {
      deps: [HttpToken, StorageRootToken, MODULE_ID],
      factory: (http, storage, moduleId) => {
        // If inference regressed to `any`/`unknown`, these calls stop checking.
        void http.get('/orders');
        void storage.forModule(moduleId).key;
        return createOrderService(http, storage.forModule(moduleId));
      },
    });
    expect(record.deps).toHaveLength(3);
  });
});
