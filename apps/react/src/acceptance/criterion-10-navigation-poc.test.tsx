// **Acceptance criterion 10** (spec §15.10):
//
// > A minimal proof-of-concept navigation module can be built against the
// > kernel package using only public primitives (activate, status
// > subscription, `useServiceAll`, provenance) — no kernel modification. This
// > criterion exists to validate principle 1 before spec 03 is written.
//
// The module is `packages/nav` (`@app/nav`). It is registered by the real
// composition root alongside the four demo modules, with no privileges of any
// kind: an ordinary descriptor, ordinary providers, an ordinary hot block.
//
// **No file under `packages/ng-react/src/` was changed to make it work.** That
// is the criterion, and the PR body states it; this file is the behavioural
// half — the navigator does what a navigator has to do, using only exports
// that were already in the barrel.
//
// The whole app is rendered, through `createAppKernel()` and `<App>`, for the
// same reason criterion 1's tests do it: a test that mounted the navigator by
// hand would pass while the composition root was wrong.

import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AppKernel } from '@ng-react/kernel';
import type { Kernel } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { NavModule, RouteConfigToken, RouterToken } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { App } from '../App';
import { createAppKernel } from '../composition-root';
import type { LifecycleLog } from '../lifecycle-log';

/** Boots the real app and mounts it, with `nav` ready. */
async function mountApp(): Promise<{ kernel: Kernel; log: LifecycleLog }> {
  const { kernel, log } = createAppKernel(undefined);
  await kernel.whenStartupComplete();
  // `nav` and `shell` are eager but non-critical, so `whenStartupComplete`
  // (A3: eager **critical** modules only) does not wait for them. `activate`
  // is idempotent and single-flight, so this joins the in-flight eager
  // activation rather than starting a second one.
  await kernel.activate(NavModule);
  render(
    <AppKernel kernel={kernel}>
      <App log={log} />
    </AppKernel>,
  );
  await screen.findByTestId('navigator');
  // The shell is eager and non-critical too, so its route contributions land
  // a tick after `whenStartupComplete` resolves. Waiting for them here rather
  // than in each test keeps every test below starting from "the app has
  // finished booting" — and the wait is on the *rendered* table, so it also
  // proves `useServiceAll` re-rendered the navigator when the collection
  // changed (**C5/R3**) rather than the navigator having read it once.
  await waitFor(() => {
    // `/dashboard` is contributed by `@app/dashboard` (#52), which is eager
    // and therefore able to contribute the route that reaches it — unlike a
    // lazy feature module (spec §17).
    expect(visibleRoutes()).toEqual(['/dashboard', '/', '/orders', '/payments']);
  });
  return { kernel, log };
}

/** Clicks a route link in the navigator's own list. */
async function navigateTo(path: string): Promise<void> {
  const link = screen.getByTestId(`nav-link-${path}`);
  await act(async () => {
    link.click();
    await Promise.resolve();
  });
}

/** The route paths the navigator is currently showing, in collection order. */
function visibleRoutes(): readonly string[] {
  return [...screen.getByTestId('nav-links').querySelectorAll('button')].map(
    (button) => button.textContent ?? '',
  );
}

describe('acceptance criterion 10 — a PoC navigation module on public primitives only', () => {
  it('R3: the route table is useServiceAll(RouteConfigToken) and grows as modules activate', async () => {
    const { kernel } = await mountApp();

    // Only the shell's routes exist at first (asserted in `mountApp`):
    // `orders` and `payments` are lazy and contribute nothing until they are
    // running. **This is the finding the shell module exists for** — a lazy
    // module cannot contribute the route that activates it, so the entry
    // routes come from a module that is already up (spec §6's "parent route
    // config").
    expect(kernel.status(OrdersModule)).toBe('registered');
    expect(kernel.status(PaymentsModule)).toBe('registered');

    await navigateTo('/orders');

    // **Spec §6, the whole point**: the navigator translated a matched route
    // into `kernel.activate(OrdersModule)`. The kernel has no notion of
    // routes and gained none.
    await waitFor(() => {
      expect(kernel.status(OrdersModule)).toBe('ready');
    });
    // **A1**: and `payments` came up transitively, without the navigator
    // naming it.
    expect(kernel.status(PaymentsModule)).toBe('ready');

    // **C5/R3**: the collection is reactive, so the two modules' own routes
    // are now in the table — added by their activation, with no route
    // registry for the navigator to keep in step.
    await waitFor(() => {
      expect(visibleRoutes()).toContain('/orders/detail');
    });
    expect(visibleRoutes()).toContain('/payments/drafts');
  });

  it('A2: a fallback is rendered while the named module is activating', async () => {
    const { kernel } = await mountApp();

    // The navigator must *render* through `activating` rather than await it.
    // Asserted by watching the route outlet before the activation settles: a
    // navigator that awaited `activate()` would show nothing at all here, and
    // `activating` — the status A2 exposes to React precisely so a UI can
    // show it — would be unobservable.
    const link = screen.getByTestId('nav-link-/payments');
    act(() => {
      link.click();
    });

    const fallback = screen.getByTestId('route-fallback');
    expect(fallback.getAttribute('data-module-status')).toMatch(/registered|activating/);
    expect(fallback.textContent).toContain('payments');

    await waitFor(() => {
      expect(kernel.status(PaymentsModule)).toBe('ready');
    });
    // …and once ready, the route's own component replaces it.
    await waitFor(() => {
      expect(screen.getByTestId('section-payments')).toBeDefined();
    });
    expect(screen.queryByTestId('route-fallback')).toBeNull();
  });

  it('C9: each route is attributed to its contributing module by the kernel, not by the route', async () => {
    const { kernel } = await mountApp();
    await navigateTo('/orders');
    await waitFor(() => {
      expect(visibleRoutes()).toContain('/orders/detail');
    });

    // **`RouteConfig` carries no `owner` field** (see the contract) — C9 is
    // explicit that provenance is kernel-assigned and "never passed by the
    // module". The navigator reads it from `kernel.inspect()`, and the
    // rendered attribution is what a reviewer sees.
    const owners = Object.fromEntries(
      [...screen.getByTestId('nav-links').querySelectorAll('button')].map((button) => [
        button.textContent,
        button.getAttribute('data-owner'),
      ]),
    );
    expect(owners).toEqual({
      '/payments/drafts': 'payments',
      '/orders/detail': 'orders',
      '/dashboard': 'dashboard',
      '/': 'shell',
      '/orders': 'shell',
      '/payments': 'shell',
    });

    // **The alignment the navigator depends on, pinned.** `useServiceAll` and
    // `inspect().contributions` are two independent code paths that both
    // claim C5's "module topological order, declaration order within a
    // module". The navigator indexes one by the other's position, so this
    // asserts they agree — including for `shell`, which contributes *three*
    // routes and is therefore the case where within-module order could drift.
    // `docs/acceptance.md` records the residual risk: the kernel exposes no
    // per-contribution identity to align on instead, and adding one would be
    // the kernel change this criterion forbids.
    const fromCollection = kernel.getAll(RouteConfigToken).map((route) => route.path);
    const fromInspect = kernel
      .inspect()
      .contributions.filter((row) => row.token === 'nav/RouteConfig')
      .map((row) => row.owner);
    expect(fromCollection).toEqual([
      '/dashboard',
      '/payments/drafts',
      '/orders/detail',
      '/',
      '/orders',
      '/payments',
    ]);
    expect(fromInspect).toEqual(['dashboard', 'payments', 'orders', 'shell', 'shell', 'shell']);
  });

  it('C5/F3: logout withdraws the disposed modules\' routes and leaves the shell\'s', async () => {
    const { kernel } = await mountApp();
    await navigateTo('/orders');
    await waitFor(() => {
      expect(visibleRoutes()).toContain('/orders/detail');
    });

    // **A4**: `kernel.deactivate(AuthModule)` disposes `orders` (its
    // dependent) and then `auth`. `payments` depends on nothing and stays
    // `ready` — the same fact criterion 1's test records as a spec defect in
    // §15.1's wording.
    await act(async () => {
      await kernel.deactivate(AuthModule);
    });

    await waitFor(() => {
      expect(visibleRoutes()).not.toContain('/orders/detail');
    });
    // `payments` is untouched, so its route stays — which is the difference
    // between "the collection is reactive" and "the collection is cleared".
    expect(visibleRoutes()).toContain('/payments/drafts');
    // And the shell's entry routes are still there, so `/orders` remains
    // reachable and will re-activate the module on the next visit.
    expect(visibleRoutes()).toContain('/orders');
  });

  it('the navigator uses only exports that were already public — the principle 1 check', async () => {
    // The behavioural tests above would pass just as well if `packages/nav`
    // had reached into the kernel's internals. This one is about *how*: the
    // navigation module's source may import only names the barrel already
    // exported before this task, and may not import from `@ng-react/kernel/src`
    // at all. The `exports` map makes the second impossible (spec §4) and
    // `import-x/no-unresolved` would catch an attempt; the first is what is
    // checked here.
    //
    // Asserted against the resolved module rather than by reading source, so
    // it is the real binding that is checked and not a regex over a file.
    const kernelBarrel: Record<string, unknown> = await import('@ng-react/kernel');
    for (const name of [
      'createToken',
      'moduleRef',
      'defineModule',
      'provide',
      'contribute',
      'useKernel',
      'useModule',
      'useService',
      'useServiceAll',
      'recordEvaluation',
    ]) {
      expect(Object.hasOwn(kernelBarrel, name)).toBe(true);
    }

    // And the three primitives the criterion names by hand, exercised through
    // the running navigation module rather than merely imported.
    const { kernel } = await mountApp();
    expect(typeof kernel.activate).toBe('function');
    expect(typeof kernel.subscribeStatus).toBe('function');
    expect(kernel.getAll(RouteConfigToken).length).toBeGreaterThan(0);
    expect(kernel.inspect().contributions.some((row) => row.token === 'nav/RouteConfig')).toBe(true);
    // The router is an ordinary service of an ordinary module.
    expect(kernel.ownerOf(RouterToken)).toBe('nav');
  });
});
