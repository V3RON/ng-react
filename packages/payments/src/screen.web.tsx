// `@app/payments` — the module's React components, **web implementation**
// (spec §12 **R2**).
//
// Implementation: unreachable from outside the package (spec §4); each
// component below reaches its surface only as the `component` field of a
// contribution this module makes.
//
// **`.web.tsx`, and `providers.ts` imports `./screen`** — issue #52 §3's
// platform decision, written up once in `packages/dashboard/src/screen.web.tsx`.
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

/**
 * **The module's dashboard card** — pending drafts, deliberately.
 *
 * The draft store is `payments`' `persistent: true` provider (**H3**, **H4**),
 * so this card is where an HMR edit is *visible*: the count survives an edit
 * to any file in this module and returns to its seeded value only on a real
 * `kernel.deactivate`. A card showing a value that was recomputed on every
 * render would demonstrate nothing.
 */
export function PaymentsCard(): ReactElement {
  const drafts = useService(PaymentDraftStoreToken);
  return (
    <p data-testid="payments-card" data-platform="web">
      {String(drafts.getState().length)} pending draft(s) — persistent: true
    </p>
  );
}
