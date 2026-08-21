// `@app/orders/contract` — the module's public surface (spec §4).
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
//
// `orders` is the demo's **lazy** module and the one the UI activates by
// hand. Its `dependsOn` is `[auth, payments]`, so `kernel.activate(OrdersModule)`
// is what acceptance criterion 1 watches pull `payments` up transitively
// (**A1**) without anyone asking for it directly.

import { createToken, moduleRef } from '@ng-react/kernel';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const OrdersModule = moduleRef('orders');

/** An order the demo has placed. */
export interface PlacedOrder {
  readonly id: string;
  readonly authorizationId: string;
  readonly placedBy: string;
}

/**
 * The module's own service. Its provider depends on `payments`' gateway,
 * `auth`'s session service and `MODULE_ID` — the three-way dependency spec
 * §7.2's worked example is built on.
 */
export interface OrderService {
  place(amountMinor: number): Promise<PlacedOrder>;
  placed(): readonly PlacedOrder[];
  /** How many session changes `init`'s `ctx.on` listener has seen (**L2**). */
  sessionChanges(): number;
  noteSessionChange(): void;
}

/** **C1**: `moduleId/Name` labels (ADR-8). */
export const OrderServiceToken = createToken<OrderService>('orders/OrderService');
