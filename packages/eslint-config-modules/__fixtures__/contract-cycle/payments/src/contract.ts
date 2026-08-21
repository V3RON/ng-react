// Acceptance criterion 6, lint half — the other side of the deliberate
// contract import cycle. See `../../orders/src/contract.ts` for the full
// rationale.
import { moduleRef } from '@ng-react/kernel';
import { OrdersModule } from '../../orders/src/contract';

export const PaymentsModule = moduleRef('cycle-payments');

export type PaymentsDependencies = readonly [typeof OrdersModule];
