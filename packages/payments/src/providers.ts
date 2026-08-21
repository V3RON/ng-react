// `@app/payments` — provider declarations (spec §7.2).
//
// Implementation, reached only through `module.ts`'s thunk at activation
// (**D1**). Nothing here is exported from the package.

import { contribute, defineStore, MODULE_ID, provide, recordEvaluation } from '@ng-react/kernel';
import type { AnyProviderRecord, Store } from '@ng-react/kernel';
import { DiagnosticPanelToken } from '@app/auth/contract';
import { DashboardCardToken } from '@app/dashboard/contract';
import { MenuEntryToken, RouteConfigToken } from '@app/nav/contract';
import { PaymentDraftStoreToken, PaymentGatewayToken } from './contract';
import type { Authorization, Money, PaymentDraft, PaymentGateway } from './contract';
// **Extensionless on purpose** — the bundler and `tsc` pick `screen.web.tsx`
// or `screen.native.tsx`. Issue #52 §3; see `packages/dashboard/src/screen.web.tsx`.
import { PaymentsCard, PaymentsScreen } from './screen';

// **Acceptance criterion 9** — proves this file was not evaluated before the
// activation trigger. `payments` is lazy, so the trigger is `orders`
// activating and pulling it in transitively (**A1**).
recordEvaluation('payments', 'payments/providers.ts');

/** This module's own route, named once and used by the route and the menu entry. */
const PAYMENTS_PATH = '/payments/drafts';

function createPaymentGateway(owner: string, drafts: Store<readonly PaymentDraft[]>): PaymentGateway {
  let sequence = 0;
  return {
    authorize: async (amount: Money, reference: string): Promise<Authorization> => {
      if (amount.amountMinor <= 0) {
        throw new Error(
          `payments: cannot authorize ${String(amount.amountMinor)} ${amount.currency} for '${reference}'.`,
        );
      }
      sequence += 1;
      drafts.setState((current) => current.filter((draft) => draft.reference !== reference));
      return { id: `auth-${owner}-${String(sequence)}`, amount, authorizedFor: reference };
    },
  };
}

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  provide(PaymentDraftStoreToken, {
    // **H3/H4 (ADR-3)**: the instance is held back across an HMR
    // re-activation of this module and its state transferred onto the fresh
    // one via `snapshot()`/`restore()`. `module` scope rather than
    // `singleton` on purpose: the drafts belong to this module's activation,
    // and #39 noted that the module-scoped half of `persistent` was the part
    // that went untested — the demo exercises it.
    scope: 'module',
    persistent: true,
    factory: () => defineStore<readonly PaymentDraft[]>([]),
  }),

  provide(PaymentGatewayToken, {
    // **C2 + §17 (#34)**: `singleton`, which for a module-owned provider
    // means one instance per *activation* of `payments` — deactivation
    // disposes it, and the next activation constructs exactly one new one.
    // C7's "app/kernel teardown" prose was written as if a module's providers
    // were registered for the life of the process, which A4 and H2 make
    // untrue, and H4 governs.
    //
    // **Named `singleton` rather than `module` because acceptance criterion 4
    // says `singleton` in so many words** ("editing a service implementation
    // behind a `singleton` provider of `payments`"). Since #34 the two scopes
    // are indistinguishable for a module-owned provider — same lifetime, same
    // disposal, and H4 discards both on a hot replace regardless — so this is
    // a naming change and not a behaviour change. The `module`-scoped half of
    // `persistent: true` that #39 left untested is still covered, by the draft
    // store above.
    scope: 'singleton',
    // **C4**: `MODULE_ID` is the module the resolution chain was started on
    // behalf of — `'orders'` when `orders`' own factory pulls the gateway in,
    // ADR-2's `'app'` when the composition root or a component outside any
    // `<ModuleScope>` does. It is what makes the authorization ids in the
    // demo UI show *who asked*, with no module ever passing its id as a
    // string.
    deps: [MODULE_ID, PaymentDraftStoreToken],
    factory: (requester, drafts) => createPaymentGateway(requester, drafts),
  }),

  // **C5**: a row in the panel declared by `@app/auth/contract`. It appears
  // when `payments` activates and disappears when it is disposed — which is
  // the reactivity C5 promises, observed through `useServiceAll` (**R3**).
  contribute(DiagnosticPanelToken, {
    deps: [MODULE_ID, PaymentDraftStoreToken],
    factory: (owner, drafts) => ({
      moduleId: owner,
      label: 'Payment drafts',
      describe: () => `${String(drafts.getState().length)} draft(s) held (persistent: true)`,
    }),
  }),

  // **C5**: this module's own route, contributed exactly like the diagnostic
  // panel row above and withdrawn by the same disposal. See the longer note
  // in `@app/orders`' providers for why a lazy module cannot contribute the
  // route that activates it.
  contribute(RouteConfigToken, {
    factory: () => ({ path: PAYMENTS_PATH, component: PaymentsScreen }),
  }),

  // **C5 — the menu entry.** Registered when `payments` activates, which in
  // the demo happens *transitively* (**A1**): nothing ever calls
  // `kernel.activate(PaymentsModule)`, so this row appearing in the hamburger
  // is itself evidence that activating `orders` pulled this module up. `order`
  // deliberately sits below `orders`' entry — see `MenuEntry.order` for why a
  // human-readable surface cannot take its order from the module graph.
  contribute(MenuEntryToken, {
    factory: () => ({ id: 'payments/drafts', title: 'Payments', path: PAYMENTS_PATH, order: 20 }),
  }),

  // **C5 — the dashboard card**, showing the `persistent: true` draft store,
  // which is what makes an HMR edit visible on the dashboard rather than
  // merely survivable.
  contribute(DashboardCardToken, {
    factory: () => ({
      id: 'payments/drafts',
      title: 'Pending drafts',
      order: 20,
      component: PaymentsCard,
    }),
  }),
];
