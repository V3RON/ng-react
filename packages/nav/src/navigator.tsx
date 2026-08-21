// `@app/nav` — the root navigator (spec §12 **R3**, spec §6, **C9**).
//
// Implementation: not exported from the package (spec §4 gives a module
// package exactly two subpath exports), reached only through `providers.ts`'s
// `NavigatorToken` and therefore only after `nav` has activated (**D1**).
//
// **Everything in this file is a public kernel primitive.** The imports from
// `@ng-react/kernel` below are `useKernel`, `useService`, `useServiceAll` and
// `useModule` — four of the seven React bindings — plus `kernel.activate`,
// `kernel.status` (through `useModule`) and `kernel.inspect()`. That list is
// exactly the one spec §15 criterion 10 names, and this file exists to prove
// it is sufficient: **no file under `packages/ng-react/src/` was changed to
// make this work.**

import { useEffect, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { useKernel, useModule, useService, useServiceAll } from '@ng-react/kernel';
import type { Kernel, ModuleRef } from '@ng-react/kernel';
import { RouteConfigToken, RouterToken } from './contract';
import type { RouteConfig } from './contract';

/**
 * **C9 — who contributed each route, asked of the kernel rather than of the
 * route.**
 *
 * `RouteConfig` carries no owner (see the contract), so attribution comes
 * from `kernel.inspect().contributions`, which C9 requires be derived from
 * the activating descriptor. The rows for one token are in the same order
 * `useServiceAll` returns its values in — C5's "module topological order,
 * declaration order within a module" — so position `i` of one aligns with
 * position `i` of the other.
 *
 * That alignment is a *documented* property of two independent code paths
 * rather than a single shared one, so it is pinned by an explicit test
 * (`criterion-10-navigation-poc.test.tsx`, "C9: each route is attributed …") with a
 * module that contributes several routes, which is the case where it could
 * plausibly drift. `docs/acceptance.md` records the residual risk: the
 * kernel exposes no per-contribution identity, so there is nothing stronger
 * to align on without a kernel change — and a kernel change is the one thing
 * criterion 10 forbids.
 */
function routeOwners(kernel: Kernel): readonly string[] {
  return kernel
    .inspect()
    .contributions.filter((row) => row.token === RouteConfigToken.label)
    .map((row) => row.owner);
}

/**
 * **Spec §6** — route-driven activation, translated into `kernel.activate`.
 *
 * "The kernel itself has no notion of route-, deep-link-, or
 * notification-driven activation. Subsystem modules built on the kernel
 * translate their own triggers into `kernel.activate(ref)`." This component
 * is that translation, and it is the whole of it: nine lines and one public
 * call.
 *
 * **It renders a fallback rather than awaiting activation**, which is the
 * point rather than a detail. A navigator that awaited `activate()` before
 * rendering anything would hide `activating` — the one status **A2** exposes
 * to React precisely so a UI can show it — and would make a slow `init` look
 * like a frozen app.
 */
function ModuleRoute(props: {
  readonly moduleRef: ModuleRef;
  readonly component: RouteConfig['component'];
}): ReactElement {
  const kernel = useKernel();
  // **A2/R3**: re-renders on every status transition, which is what turns
  // `activating → ready` into a repaint with no polling and no subscription
  // of our own.
  const { status, error, retry } = useModule(props.moduleRef);

  useEffect(() => {
    // **A2**: `activate` is idempotent and single-flight, so this is safe to
    // call from an effect that may run twice (StrictMode) and safe to call
    // for a module that is already `activating`. `disposed` is included
    // because logout (**A4**) leaves a routed-to module exactly there, and a
    // route that could never come back would be a dead screen.
    if (status === 'registered' || status === 'disposed') {
      // The failure is already retained on the module (**F1**) and surfaced
      // below; rethrowing into an unhandled rejection would add nothing.
      void kernel.activate(props.moduleRef).catch(() => {});
    }
  }, [kernel, props.moduleRef, status]);

  if (status === 'ready') {
    const Screen = props.component;
    return <Screen />;
  }

  if (status === 'failed') {
    // **F3**: the module is quarantined and `retry` re-attempts it. Spec §10
    // F4 defers per-screen *error boundaries* to spec 03; this is the
    // status-driven half, which needs no boundary because nothing rendered.
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return (
      <section data-testid="route-failed">
        <h3>
          <code>{props.moduleRef.id}</code> could not be activated
        </h3>
        <p>{message}</p>
        <button type="button" onClick={retry}>
          Retry {props.moduleRef.id}
        </button>
      </section>
    );
  }

  return (
    <p data-testid="route-fallback" data-module-status={status}>
      Activating <code>{props.moduleRef.id}</code> — status <code>{status}</code>.
    </p>
  );
}

/**
 * **R3 — "the navigation module's root navigator is, at its core,
 * `useServiceAll(RouteConfigToken)`."**
 *
 * Spec §12 R3 says that in those words, and this component is written so the
 * sentence is literally true of it: the route table is one `useServiceAll`
 * call and nothing else. Because the collection is reactive (**C5**), a
 * module activating adds its routes and a module being disposed or
 * quarantined (**F3**) withdraws them, with no route-registry of our own to
 * keep in step — which is the property that makes navigation implementable
 * as an ordinary module at all.
 *
 * Matching is exact-path and deliberately dumb: patterns, params, guards and
 * nested outlets are spec 03's job, and adding them here would be scope creep
 * into a spec that is not written yet.
 */
export function RootNavigator(): ReactElement {
  const kernel = useKernel();
  const router = useService(RouterToken);
  // **R3/C5** — the whole route table.
  const routes = useServiceAll(RouteConfigToken);
  const path = useSyncExternalStore(router.subscribe, router.current, router.current);

  const owners = routeOwners(kernel);
  const index = routes.findIndex((route) => route.path === path);
  const match = index === -1 ? undefined : routes[index];
  const owner = index === -1 ? undefined : owners[index];

  return (
    <section aria-labelledby="nav-heading" data-testid="navigator">
      <h2 id="nav-heading">Navigation — a PoC module on public primitives (criterion 10)</h2>
      <p className="note">
        The route table is <code>useServiceAll(nav/RouteConfig)</code> (R3). Rows appear and
        disappear as modules activate and are disposed (C5), and a route naming a module is
        translated into <code>kernel.activate(ref)</code> by this module, never by the kernel
        (spec §6). Attribution comes from <code>kernel.inspect()</code> (C9), never from the route.
      </p>

      <nav aria-label="Routes">
        <ul data-testid="nav-links">
          {routes.map((route, position) => (
            <li key={route.path}>
              <button
                type="button"
                data-testid={`nav-link-${route.path}`}
                data-owner={owners[position] ?? 'unknown'}
                aria-current={route.path === path ? 'page' : undefined}
                onClick={() => {
                  router.navigate(route.path);
                }}
              >
                {route.path}
              </button>{' '}
              <small>
                contributed by <code>{owners[position] ?? 'unknown'}</code>
                {route.module === undefined ? null : (
                  <>
                    {' '}
                    · activates <code>{route.module.id}</code>
                  </>
                )}
              </small>
            </li>
          ))}
        </ul>
      </nav>

      <div data-testid="route-outlet" data-path={path} data-owner={owner ?? 'unknown'}>
        {match === undefined ? (
          <p data-testid="route-not-found">
            No route matches <code>{path}</code>. The table holds {String(routes.length)} route(s);
            a module that is not active contributes none.
          </p>
        ) : match.module === undefined ? (
          <match.component />
        ) : (
          <ModuleRoute moduleRef={match.module} component={match.component} />
        )}
      </div>
    </section>
  );
}
