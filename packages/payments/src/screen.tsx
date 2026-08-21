// `@app/payments` — the module's screen (spec §12 **R2**).
//
// Implementation: unreachable from outside the package (spec §4); it reaches
// the navigator only as a `RouteConfig.component` this module contributes.
//
// **This screen is what acceptance criterion 4 watches.** It resolves the
// gateway behind `payments`' `singleton`-scoped provider through `useService`,
// so editing that provider disposes the instance it holds (**H4**) and the
// epoch bump (**H6**) makes this component re-render against the fresh one —
// with no HMR awareness anywhere in this file.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { useService } from '@ng-react/kernel';
import { PaymentDraftStoreToken, PaymentGatewayToken } from './contract';

export function PaymentsScreen(): ReactElement {
  const gateway = useService(PaymentGatewayToken);
  const drafts = useService(PaymentDraftStoreToken);
  const [lastAuthorization, setLastAuthorization] = useState<string | undefined>(undefined);

  const authorize = (): void => {
    void gateway
      .authorize({ amountMinor: 4200, currency: 'EUR' }, 'demo-basket')
      .then((authorization) => {
        setLastAuthorization(authorization.id);
      })
      .catch(() => {
        setLastAuthorization(undefined);
      });
  };

  return (
    <section data-testid="payments-screen">
      <h3>Payments</h3>
      {/* **H3**: the persistent store's contents survive an edit to this
          module and are discarded by a real `deactivate`. */}
      <p data-testid="payments-drafts">
        {String(drafts.getState().length)} draft(s) held (persistent: true)
      </p>
      {/* The authorization id embeds the `MODULE_ID` the gateway was built
          for (**C4**) — `'app'` here, because a component outside any
          `<ModuleScope>` resolves with ADR-2's reserved requester. */}
      <p data-testid="payments-authorization">{lastAuthorization ?? 'nothing authorized yet'}</p>
      <button type="button" onClick={authorize}>
        Authorize the demo basket
      </button>
    </section>
  );
}
