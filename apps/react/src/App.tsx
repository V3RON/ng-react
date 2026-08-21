// The demo's diagnostic surface — **acceptance criterion 1**, made visible.
//
// Deliberately plain: semantic HTML, one small stylesheet, no UI framework and
// no new dependencies. Every panel below exists to show one kernel guarantee
// that is otherwise invisible, and nothing here is decoration.
//
// **B1**: this file imports only `<pkg>/contract`. The descriptors live in
// `composition-root.ts` and nothing else in the app may name them.

import { useCallback, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { useKernel, useModule, useServiceAll, useServiceOptional } from '@ng-react/kernel';
import type { ModuleRef, Store } from '@ng-react/kernel';
import { AuthErrorLogToken, AuthModule, DiagnosticPanelToken } from '@app/auth/contract';
import type { AuthErrorEntry } from '@app/auth/contract';
import { DashboardModule } from '@app/dashboard/contract';
import { DebugModule } from '@app/debug/contract';
import { NavigatorToken, NavModule } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { AppMenu } from './shell/menu';
import type { LifecycleLog } from './lifecycle-log';
import './App.css';

/** Every module, in the order the composition root registers them. */
const MODULE_ROWS: readonly { readonly ref: ModuleRef; readonly note: string }[] = [
  { ref: AuthModule, note: 'eager, critical — owns the session and the F4 error sink' },
  { ref: DebugModule, note: 'eager, non-critical — init throws on purpose (F1/F3)' },
  { ref: PaymentsModule, note: 'lazy — activated transitively by orders (A1)' },
  { ref: OrdersModule, note: 'lazy — dependsOn [auth, payments]' },
  { ref: NavModule, note: 'eager — the PoC navigation module (criterion 10)' },
  { ref: DashboardModule, note: 'eager — owns the dashboard/DashboardCard collection (#52)' },
];

/** Subscribes to any `defineStore` (**H3**) the React way. */
function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** One row of the module table, driven by `useModule` (**R3**). */
function ModuleRow(props: { readonly moduleRef: ModuleRef; readonly note: string }): ReactElement {
  const { status, error, retry } = useModule(props.moduleRef);
  const message = error instanceof Object && 'message' in error ? String(error.message) : undefined;

  return (
    <tr data-testid={`module-${props.moduleRef.id}`} data-status={status}>
      <th scope="row">{props.moduleRef.id}</th>
      <td>
        <span className={`status status-${status}`}>{status}</span>
      </td>
      <td>{message ?? '—'}</td>
      <td className="note">{props.note}</td>
      <td>
        {/* **F3**: `retry` is only meaningful for a quarantined module. */}
        {status === 'failed' ? (
          <button type="button" onClick={retry}>
            Retry {props.moduleRef.id}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/** **C5/R3**: the reactive contribution collection, appearing and disappearing live. */
function ContributionPanel(): ReactElement {
  const panels = useServiceAll(DiagnosticPanelToken);
  return (
    <section aria-labelledby="contributions-heading">
      <h2 id="contributions-heading">Contributions — useServiceAll(auth/DiagnosticPanel)</h2>
      <p className="note">
        C5: one row per contributing module. Rows appear when a module activates and are withdrawn
        when it is disposed or quarantined — <code>debug</code> has no row for exactly that reason.
      </p>
      <ul data-testid="contribution-panels">
        {panels.map((panel) => (
          <li key={`${panel.moduleId}/${panel.label}`} data-testid={`panel-${panel.moduleId}`}>
            <strong>{panel.label}</strong> <em>({panel.moduleId})</em>: {panel.describe()}
          </li>
        ))}
      </ul>
      {panels.length === 0 ? <p>No contributions — nothing is active.</p> : null}
    </section>
  );
}

/** **F4**: what `auth`'s error sink recorded, with the kernel's attribution (**C9**). */
function ErrorLogPanel(props: { readonly store: Store<readonly AuthErrorEntry[]> }): ReactElement {
  const entries = useStore(props.store);
  return (
    <ol data-testid="error-log">
      {entries.map((entry, index) => (
        <li key={`${String(index)}-${entry.moduleId}`}>
          <code>{entry.moduleId}</code> failed during <code>{entry.phase}</code>: {entry.message}
        </li>
      ))}
    </ol>
  );
}

/** **A2/A4**: the kernel's own status transitions, in order. */
function LifecyclePanel(props: { readonly log: LifecycleLog }): ReactElement {
  const events = useStore(props.log);
  return (
    <section aria-labelledby="lifecycle-heading">
      <h2 id="lifecycle-heading">Lifecycle log — kernel.subscribeStatus</h2>
      <p className="note">
        A4: logout disposes dependents before the module they depend on. Read the order, not the
        membership — that is the whole guarantee.
      </p>
      <ol data-testid="lifecycle-log">
        {events.map((event) => (
          <li key={event.seq}>
            <code>{event.moduleId}</code> → {event.status}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * **R1**: rendered under a single `<AppKernel>`. The kernel comes from
 * context, never from an import of the composition root.
 */
export function App(props: { readonly log: LifecycleLog }): ReactElement {
  const kernel = useKernel();
  // **This subscription is load-bearing, not decoration.** `useServiceOptional`
  // decides "no provider" with `kernel.ownerOf`, and *nothing bumps an epoch on
  // plain activation* — a known gap, recorded in the day-2 handoff. So a
  // component that only called `useServiceOptional` would resolve `undefined`
  // on the first render (the eager pass is asynchronous, so `auth` is still
  // `registered` when React first paints) and would never re-render to try
  // again: the demo showed "auth is disposed" underneath a table saying `auth`
  // was `ready`. `useModule` re-renders on every status change, and
  // `useServiceOptional` recomputes its resolvability each render, so the two
  // together close the gap without a second mechanism.
  const authState = useModule(AuthModule);
  // **useServiceOptional, not useService.** After logout, `auth` is disposed
  // and its providers are withdrawn, so this token has no owner — the
  // optional hook yields `undefined` where `useService` would throw the C8
  // resolution error into the render. Losing the panel is the correct
  // rendering of "the module that owned it is gone".
  const errorLog = useServiceOptional(AuthErrorLogToken);
  // **Criterion 10, mounted.** The navigator is a value the navigation module
  // provides, resolved like any other service — spec §4 gives a module
  // package exactly two subpath exports and a React component is not one of
  // them, so this is how a screen crosses the boundary. `useModule(NavModule)`
  // is here for the same reason it is above for `auth`: `useServiceOptional`
  // does not re-render on plain activation (a known gap), and `nav` is still
  // `registered` on the first paint.
  const navState = useModule(NavModule);
  const Navigator = useServiceOptional(NavigatorToken);

  const activateOrders = useCallback(() => {
    // A rejection here is already reported to the F4 sinks and reflected in
    // `status`; rethrowing into an unhandled rejection would add nothing.
    void kernel.activate(OrdersModule).catch(() => {});
  }, [kernel]);

  const logout = useCallback(() => {
    void kernel.deactivate(AuthModule).catch(() => {});
  }, [kernel]);

  return (
    <main>
      <h1>ng-react kernel — acceptance criterion 1</h1>

      <section aria-labelledby="modules-heading">
        <h2 id="modules-heading">Modules — useModule(ref)</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">id</th>
              <th scope="col">status</th>
              <th scope="col">error</th>
              <th scope="col">what it demonstrates</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {MODULE_ROWS.map((row) => (
              <ModuleRow key={row.ref.id} moduleRef={row.ref} note={row.note} />
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="actions-heading">
        <h2 id="actions-heading">Actions</h2>
        <p>
          <button type="button" onClick={activateOrders}>
            Activate orders
          </button>{' '}
          <button type="button" onClick={logout}>
            Logout (deactivate auth)
          </button>
        </p>
        <p className="note">
          <strong>Activate orders</strong> pulls <code>payments</code> up with it (A1) — watch it go{' '}
          <code>registered → activating → ready</code> without being asked for directly.
        </p>
        <p className="note">
          <strong>Logout</strong> is <code>kernel.deactivate(AuthModule)</code>. A4 cascades to the
          modules that <em>depend on</em> <code>auth</code> — that is <code>orders</code>, and then{' '}
          <code>auth</code> itself. <code>payments</code> depends on nothing, so it stays{' '}
          <code>ready</code>: the cascade is by declared <code>dependsOn</code>, not by "everything
          that happens to be active". Spec §15 criterion 1 reads as though <code>payments</code>
          were disposed too; it is not, and the PR body records that as a spec defect rather than
          working around it here.
        </p>
      </section>

      {/* **Issue #52** — the menu is chrome, so it lives in the app and reads
          `nav`'s collection directly. It is gated on the same `Navigator`
          check below because both need `nav` to be active: without it
          `RouterToken` has no provider and `useService` would throw C8's
          resolution error into the render. */}
      {Navigator === undefined ? (
        <p data-testid="navigator-unavailable">
          <code>nav/Navigator</code> has no provider — <code>nav</code> is{' '}
          <code>{navState.status}</code>.
        </p>
      ) : (
        <>
          <AppMenu />
          <Navigator />
        </>
      )}

      <ContributionPanel />

      <section aria-labelledby="errors-heading">
        <h2 id="errors-heading">Error sinks — contribute(ErrorSinkToken) in auth</h2>
        <p className="note">
          F3/F4: the sink lives in <code>auth</code>, not in <code>debug</code>. A sink contributed
          by a quarantined module is withdrawn by the very failure it was meant to report.
        </p>
        {errorLog === undefined ? (
          <p data-testid="error-log-unavailable">
            <code>auth/ErrorLog</code> has no provider — <code>auth</code> is{' '}
            <code>{authState.status}</code>, so its registrations are not (or no longer) in the
            container. This is C8's "no provider" case rendered rather than thrown, which is what{' '}
            <code>useServiceOptional</code> buys over <code>useService</code>.
          </p>
        ) : (
          <ErrorLogPanel store={errorLog} />
        )}
      </section>

      <LifecyclePanel log={props.log} />
    </main>
  );
}
