// `@app/orders` — the module's React components, **web implementation**
// (spec §12 **R2**).
//
// Implementation: unreachable from outside the package (spec §4). Both
// components below travel to their surface as the `component` field of a
// contribution this module makes — a `RouteConfig` for the screen, a
// `DashboardCard` for the card — which is the only way a component crosses a
// module boundary in this design. There is no screen registry and no
// manifest.
//
// **`.web.tsx`, and `providers.ts` imports `./screen`.** That is the platform
// decision of issue #52 §3; its rationale, the four resolvers it has to
// satisfy and the alternative that was rejected are all written up once, in
// `packages/dashboard/src/screen.web.tsx`. Do not re-argue it here — but do
// note the consequence that matters for *this* file: `providers.ts` is
// platform-agnostic and contains exactly one `contribute()` call per surface,
// on every platform.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { useService } from '@ng-react/kernel';
import { OrderServiceToken } from './contract';

/**
 * **R2**: resolves `orders`' own service through the container. Referential
 * stability is R2's guarantee for `singleton` and `module` scopes, so the
 * instance is the same across renders — and a *different* one after an HMR
 * re-activation, because **H6** bumps the epoch this hook subscribes to.
 * The component needs no HMR awareness of its own; that is H6's whole claim
 * and this screen is one of the places acceptance criterion 4 observes it.
 */
export function OrdersScreen(): ReactElement {
  const service = useService(OrderServiceToken);
  const [error, setError] = useState<string | undefined>(undefined);
  const [, setTick] = useState(0);

  const place = (): void => {
    void service
      .place(2500)
      .then(() => {
        setError(undefined);
        setTick((value) => value + 1);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <section data-testid="orders-screen">
      <h3>Orders</h3>
      <p data-testid="orders-placed">{String(service.placed().length)} order(s) placed</p>
      <p data-testid="orders-session-changes">
        {String(service.sessionChanges())} session change(s) seen by the init listener
      </p>
      <button type="button" onClick={place}>
        Place a 25.00 EUR order
      </button>
      {error === undefined ? null : <p data-testid="orders-error">{error}</p>}
    </section>
  );
}

/**
 * **The module's dashboard card** — the `component` half of `orders`'
 * `contribute(DashboardCardToken, …)`.
 *
 * It resolves `orders`' own service (**R2**), so it is present exactly while
 * `orders` is active: activating the module adds it to the collection and
 * logout (**A4**) withdraws it, with no dashboard code involved. `useService`
 * rather than `useServiceOptional` is safe here for the same reason it is in
 * the screen above — a card only renders while its contribution is in the
 * collection, and the contribution is withdrawn in the same turn its module
 * is disposed.
 */
export function OrdersCard(): ReactElement {
  const service = useService(OrderServiceToken);
  return (
    <p data-testid="orders-card" data-platform="web">
      {String(service.placed().length)} recent order(s)
    </p>
  );
}
