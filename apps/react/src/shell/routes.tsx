// The app shell's providers: the demo's top-level route table (**C5**).
//
// Implementation, reached only through `./module`'s thunk at activation
// (**D1**). See that file for why the entry routes for lazy modules live
// here and not in the modules themselves.
//
// **B1**: this file imports `<pkg>/contract` and nothing else. It never sees
// a feature module's screen — those travel to the navigator as
// `RouteConfig.component` values contributed by their own modules — so the
// shell knows the *refs* of the lazy modules and none of their code.

import type { ComponentType, ReactElement } from 'react';
import { contribute, recordEvaluation, useModule, useServiceAll } from '@ng-react/kernel';
import type { AnyProviderRecord, ModuleRef } from '@ng-react/kernel';
import { RouteConfigToken } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';

// **Acceptance criterion 9** — the shell is eager, so this fires during
// startup; the point of recording it is that `orders/providers.ts` and
// `payments/providers.ts` do *not*.
recordEvaluation('shell', 'shell/routes.tsx');

/** The demo's landing route. Owned by the shell, active for the app's whole life. */
function HomeScreen(): ReactElement {
  const routes = useServiceAll(RouteConfigToken);
  return (
    <section data-testid="home-screen">
      <h3>Home</h3>
      <p>
        {String(routes.length)} route(s) are registered right now. Navigate to{' '}
        <code>/orders</code> to watch a lazy module activate, then look for{' '}
        <code>/orders/detail</code> appearing in the list above — that route did not exist a
        moment ago, because the module that contributes it was not running.
      </p>
    </section>
  );
}

/**
 * Builds the shell-owned landing screen for a lazy module's section.
 *
 * A factory rather than one component per module: the only thing that varies
 * is the ref, and two hand-written copies of this would be two places to fix
 * the next time it changes (principle 5, in the small).
 *
 * The navigator has already activated `ref` by the time this renders — it
 * renders a route's component only once the named module is `ready` — so
 * `useModule` here is reporting, not driving. The child routes listed come
 * from the module's own contributions, so an empty list would mean the module
 * came up without registering any, which is worth being able to see.
 */
function moduleSection(ref: ModuleRef, title: string): ComponentType {
  function ModuleSection(): ReactElement {
    const { status } = useModule(ref);
    const children = useServiceAll(RouteConfigToken).filter((route) =>
      route.path.startsWith(`/${ref.id}/`),
    );
    return (
      <section data-testid={`section-${ref.id}`} data-status={status}>
        <h3>{title}</h3>
        <p>
          <code>{ref.id}</code> is <code>{status}</code>. It now contributes{' '}
          {String(children.length)} child route(s):{' '}
          {children.map((route) => route.path).join(', ') || 'none'}
        </p>
      </section>
    );
  }
  // Named for the React DevTools tree and for a failure message that says
  // which section broke.
  ModuleSection.displayName = `ModuleSection(${ref.id})`;
  return ModuleSection;
}

// Built once, at module scope, rather than inside the factories below. The
// contributions are `singleton`-scoped (the default, C2) so a factory runs
// once per activation anyway — but a component identity that could change
// under React is worth putting beyond doubt: a new identity is a remount,
// which would throw away the section's state on every unrelated re-resolution.
const OrdersSection = moduleSection(OrdersModule, 'Orders');
const PaymentsSection = moduleSection(PaymentsModule, 'Payments');

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  contribute(RouteConfigToken, {
    factory: () => ({ path: '/', component: HomeScreen }),
  }),

  // **Spec §6**: "the navigation module activates a module when a parent
  // route config maps a matched path to its ref". These two rows are that
  // parent route config, and `module` is the only thing that distinguishes
  // them from an ordinary route.
  contribute(RouteConfigToken, {
    factory: () => ({
      path: '/orders',
      module: OrdersModule,
      component: OrdersSection,
    }),
  }),
  contribute(RouteConfigToken, {
    factory: () => ({
      path: '/payments',
      module: PaymentsModule,
      component: PaymentsSection,
    }),
  }),
];
