// `@app/payments/contract` — the module's public surface (spec §4).
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
//
// `payments` is **lazy** and depends on nothing. It is the module acceptance
// criterion 1 watches activate *transitively*, because `orders` lists it in
// `dependsOn` — the demo never calls `kernel.activate(PaymentsModule)`.

import { createToken, moduleRef } from '@ng-react/kernel';
import type { Store } from '@ng-react/kernel';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const PaymentsModule = moduleRef('payments');

/** Minor units in a single currency — enough arithmetic for a demo, no more. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: 'EUR' | 'USD';
}

/** A successful authorization, as the gateway reports it. */
export interface Authorization {
  readonly id: string;
  readonly amount: Money;
  readonly authorizedFor: string;
}

/**
 * The remote edge of the module — **the token acceptance criterion 5 deletes
 * and criterion 7 mocks**, so it is deliberately the one thing `orders`
 * resolves from here.
 */
export interface PaymentGateway {
  authorize(amount: Money, reference: string): Promise<Authorization>;
}

/** A not-yet-submitted payment. Durable across HMR — see `PaymentDraftStoreToken`. */
export interface PaymentDraft {
  readonly reference: string;
  readonly amount: Money;
}

/** **C1**: `moduleId/Name` labels (ADR-8); each call is a distinct identity. */
export const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
/**
 * **H3**: the demo's persistent state. Its provider is `persistent: true`, so
 * an HMR re-activation of `payments` carries the drafts onto the fresh
 * instance (**H4**, ADR-3) while `kernel.deactivate` discards them.
 */
export const PaymentDraftStoreToken =
  createToken<Store<readonly PaymentDraft[]>>('payments/PaymentDraftStore');
