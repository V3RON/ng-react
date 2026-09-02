// `@app/payments` — the module's own test, against `createTestKernel` (**R4**).
//
// Runs in a plain node environment with no React renderer — acceptance
// criterion 7.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog } from '@ng-react/kernel';
import { DiagnosticPanelToken } from '@app/auth/contract';
import { PaymentDraftStoreToken, PaymentGatewayToken, PaymentsModule } from './contract';
import { module } from './module';

describe('payments module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(PaymentsModule)).toBe('registered');
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(PaymentsModule);

    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'payments/providers.ts',
      '<init>',
      'payments/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('R4/C4: the gateway authorizes on behalf of its requester and clears the draft', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(PaymentsModule);
    expect(kernel.status(PaymentsModule)).toBe('ready');

    // H3: `init` seeded the persistent store, and only because it was empty.
    const drafts = kernel.get(PaymentDraftStoreToken);
    expect(drafts.getState().map((draft) => draft.reference)).toEqual(['demo-basket']);

    // **C4/ADR-2**: this resolution was started by the test, i.e. outside any
    // module, so `MODULE_ID` is the reserved id `'app'` — visible in the
    // authorization id, which is the point of C4's "consumer-specialized
    // services" without anyone passing an id string.
    const gateway = kernel.get(PaymentGatewayToken);
    await expect(gateway.authorize({ amountMinor: 4200, currency: 'EUR' }, 'demo-basket')).resolves
      .toEqual({
        id: 'auth-app-1',
        amount: { amountMinor: 4200, currency: 'EUR' },
        authorizedFor: 'demo-basket',
      });
    expect(drafts.getState()).toEqual([]);

    // C9: every provider above is attributed to this module.
    expect([...new Set(kernel.inspect().providers.map((row) => row.owner))]).toEqual(['payments']);

    // C5: the row this module contributes to `auth`'s collection token. It is
    // resolvable without `auth` being registered at all — a contribution
    // token is a value identity (C1), not a link to its declaring package.
    expect(kernel.getAll(DiagnosticPanelToken).map((panel) => panel.label)).toEqual([
      'Payment drafts',
    ]);

    await kernel.dispose();
    expect(kernel.errors).toEqual([]);
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('C8: authorizing a non-positive amount fails with a message naming the reference', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(PaymentsModule);
    await expect(
      kernel.get(PaymentGatewayToken).authorize({ amountMinor: 0, currency: 'USD' }, 'empty'),
    ).rejects.toThrow("payments: cannot authorize 0 USD for 'empty'.");
    await kernel.dispose();
  });
});
