// `@app/orders` — provider declarations (spec §7.2).
//
// Implementation, reached only through `module.ts`'s thunk at activation
// (**D1**). Nothing here is exported from the package.
//
// **M2**: the imports below are the module graph. `orders` reaches `auth`
// and `payments` through their *contracts* and nothing else — `dependsOn`
// orders the activations, the contract imports carry the types, and there is
// no third mechanism.

import { contribute, MODULE_ID, provide, recordEvaluation } from '@ng-react/kernel';
import type { AnyProviderRecord } from '@ng-react/kernel';
import { DiagnosticPanelToken, SessionServiceToken } from '@app/auth/contract';
import type { SessionService } from '@app/auth/contract';
import { PaymentGatewayToken } from '@app/payments/contract';
import type { PaymentGateway } from '@app/payments/contract';
import { OrderServiceToken } from './contract';
import type { OrderService, PlacedOrder } from './contract';

// **Acceptance criterion 9** — proves this file was not evaluated before
// `kernel.activate(OrdersModule)`.
recordEvaluation('orders', 'orders/providers.ts');

function createOrderService(
  gateway: PaymentGateway,
  session: SessionService,
  requester: string,
): OrderService {
  const orders: PlacedOrder[] = [];
  let sessionChanges = 0;

  return {
    place: async (amountMinor) => {
      const current = session.current();
      if (current === undefined) {
        throw new Error(`orders: cannot place an order for '${requester}' with no session.`);
      }
      const reference = `${current.userId}-${String(orders.length + 1)}`;
      const authorization = await gateway.authorize(
        { amountMinor, currency: 'EUR' },
        reference,
      );
      const order: PlacedOrder = {
        id: reference,
        authorizationId: authorization.id,
        placedBy: current.userId,
      };
      orders.push(order);
      return order;
    },
    placed: () => [...orders],
    sessionChanges: () => sessionChanges,
    noteSessionChange: () => {
      sessionChanges += 1;
    },
  };
}

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  provide(OrderServiceToken, {
    // **C2 + §17 (#34)**: a module-owned `singleton` lives for this module's
    // *activation*. Logout disposes `orders` and the instance with it, so the
    // placed-order list below is genuinely gone — not quietly retained for a
    // later re-activation to find.
    scope: 'singleton',
    // **C4** and spec §7.2's worked shape: another module's service, another
    // module's gateway, and the contextual `MODULE_ID`. It resolves to
    // `'orders'` whenever this module's own `init` starts the chain.
    deps: [PaymentGatewayToken, SessionServiceToken, MODULE_ID],
    factory: (gateway, session, requester) => createOrderService(gateway, session, requester),
  }),

  // **C5**: `orders`' row in the panel, appearing on activation and
  // withdrawn on disposal.
  contribute(DiagnosticPanelToken, {
    deps: [MODULE_ID, OrderServiceToken],
    factory: (owner, service) => ({
      moduleId: owner,
      label: 'Orders',
      describe: () =>
        `${String(service.placed().length)} placed, ` +
        `${String(service.sessionChanges())} session change(s) seen`,
    }),
  }),
];
