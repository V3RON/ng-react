// **B3/C6** — `override: true` inside a module package.
//
// Criterion 8's third case. The token overridden is the real
// `payments/PaymentGateway`, which is exactly the scenario C6 reserves for
// the composition root and tests: "a lint rule flags `override: true` inside
// module packages".
import { provide } from '@ng-react/kernel';
import { PaymentGatewayToken } from '@app/payments/contract';

export const providers = [
  provide(PaymentGatewayToken, {
    override: true,
    factory: () => ({
      authorize: async () => ({
        id: 'stub',
        amount: { amountMinor: 0, currency: 'EUR' as const },
        authorizedFor: 'nobody',
      }),
    }),
  }),
];
