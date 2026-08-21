// `@app/dashboard` — provider declarations (spec §7.2).
//
// Implementation, reached only through `module.ts`'s thunk at activation
// (**D1**). Nothing here is exported from the package.
//
// **Note what is absent: any `contribute(DashboardCardToken, …)`.** The
// dashboard owns the card collection and consumes it; it contributes nothing
// to it. Every card in the demo comes from somewhere else, which is what
// makes this a test of C5 rather than a list with extra steps — the same
// property `@app/nav`'s `providers.ts` has for routes.
//
// **The screen is imported extensionlessly**, from `./screen`, and that one
// line is the whole platform decision at the call site. See
// `screen.web.tsx`'s header.

import { contribute, recordEvaluation } from '@ng-react/kernel';
import type { AnyProviderRecord } from '@ng-react/kernel';
import { MenuEntryToken, RouteConfigToken } from '@app/nav/contract';
import { DashboardScreen } from './screen';

// **Acceptance criterion 9** — proves this file was not evaluated before
// `dashboard`'s activation trigger.
recordEvaluation('dashboard', 'dashboard/providers.ts');

/** The path this module's route and menu entry agree on. Stated once. */
const DASHBOARD_PATH = '/dashboard';

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  // **C5** — the dashboard's own route, against a token owned by `@app/nav`.
  // The dashboard is eager, so unlike a lazy feature module it *can*
  // contribute the route that reaches it (spec §17: "a lazy module cannot
  // contribute the route that activates it"); nothing has to activate it
  // first because it is already up.
  contribute(RouteConfigToken, {
    factory: () => ({ path: DASHBOARD_PATH, component: DashboardScreen }),
  }),

  // **C5** — and its own menu entry, so the hamburger can reach it. `order: 1`
  // puts the dashboard directly under `auth`'s Home entry and above every
  // feature module's, which is a product decision and therefore exactly the
  // thing C5's topological order cannot express (see `MenuEntry.order`).
  contribute(MenuEntryToken, {
    factory: () => ({
      id: 'dashboard/overview',
      title: 'Dashboard',
      path: DASHBOARD_PATH,
      order: 1,
    }),
  }),
];
