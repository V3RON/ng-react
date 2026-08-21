// `@app/orders/contract` — the module's public surface (spec §4).
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
//
// `orders` is the demo's **lazy** module and the one the UI activates by
// hand. Its `dependsOn` is `[auth, payments]`, so `kernel.activate(OrdersModule)`
// is what acceptance criterion 1 watches pull `payments` up transitively
// (**A1**) without anyone asking for it directly.

import { createToken, moduleRef } from '@ng-react/kernel';
import type { Store } from '@ng-react/kernel';

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

/** One line of the module's edit-surviving scratchpad. Plain data (**H3**). */
export interface OrderNote {
  readonly text: string;
}

/** **C1**: `moduleId/Name` labels (ADR-8). */
export const OrderServiceToken = createToken<OrderService>('orders/OrderService');

/**
 * **H3, and the reason this module owns a store at all.**
 *
 * Acceptance criterion 3 edits `orders/lifecycle.ts` and requires that
 * `persistent: true` store state is preserved across the re-activation
 * (**H3/H4**). Until #24 `orders` owned no persistent store — the demo's two
 * lived in `auth` and `payments` — and neither is in the cascade of an
 * `orders` edit, so any assertion about them would have passed without the
 * mechanism under test ever running. This store is what makes that clause
 * checkable rather than vacuous, and it is also the honest demonstration of
 * H3's own sentence: "durable state must not live in module closures".
 *
 * Deliberately `singleton`-scoped, complementing `payments`' `module`-scoped
 * draft store, so the demo exercises both halves of `persistent`.
 */
export const OrderNotesToken = createToken<Store<readonly OrderNote[]>>('orders/OrderNotes');
