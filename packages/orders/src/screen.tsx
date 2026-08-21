// `@app/orders` — the module's screen (spec §12 **R2**).
//
// Implementation: unreachable from outside the package (spec §4). It travels
// to the navigator as the `component` field of a `RouteConfig` the module
// contributes, which is the only way a screen crosses a module boundary in
// this design — there is no screen registry and no route manifest.

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
