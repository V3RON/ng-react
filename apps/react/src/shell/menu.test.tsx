// The hamburger menu, in the running demo app — **issue #52**.
//
// The menu is app chrome over a collection `@app/nav` owns (see `menu.tsx`),
// so everything here is asserted against the real composition root: a test
// that mounted `<AppMenu>` over a hand-built kernel would pass while the app
// was wrong.
//
// **Sequences, not membership**, throughout — HANDOFF §5.2's weak-test
// pattern is the failure mode these assertions are shaped to avoid.

import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AppKernel } from '@ng-react/kernel';
import type { Kernel } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { MenuEntryToken, NavModule } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { App } from '../App';
import { createAppKernel } from '../composition-root';

/** Boots the real app and mounts it, with `nav` (and therefore the menu) up. */
async function mountApp(): Promise<Kernel> {
  const { kernel, log } = createAppKernel(undefined);
  await kernel.whenStartupComplete();
  // A3 gates `whenStartupComplete` on startup-critical modules only, and
  // `nav` is non-critical — awaiting the former and then asserting on the
  // latter is the racy pattern of issue #51. `activate` is idempotent and
  // single-flight.
  await kernel.activate(NavModule);
  render(
    <AppKernel kernel={kernel}>
      <App log={log} />
    </AppKernel>,
  );
  await screen.findByTestId('app-menu');
  return kernel;
}

/** The menu item titles, **in rendered order**. */
function visibleMenu(): readonly string[] {
  return [...screen.getByTestId('app-menu-items').querySelectorAll('button')].map(
    (button) => button.textContent ?? '',
  );
}

describe('#52 — the menu collection in the running app', () => {
  it('an eager+critical module\'s entry is present at the first paint', async () => {
    await mountApp();
    // `auth` is eager and critical, so its entry needs no trigger; `dashboard`
    // is eager and non-critical and has caught up by the time the menu
    // renders. Nothing lazy has contributed yet, and that is the *contrast*
    // the next test needs — a menu whose rows all came from lazy modules
    // would be empty here and would prove nothing about the collection being
    // live rather than merely populated once.
    await waitFor(() => {
      expect(visibleMenu()).toEqual(['Home', 'Dashboard']);
    });
  });

  it('C5: the menu grows on activation and shrinks on logout — as a sequence', async () => {
    const kernel = await mountApp();
    await waitFor(() => {
      expect(visibleMenu()).toEqual(['Home', 'Dashboard']);
    });

    const seen: (readonly string[])[] = [];
    kernel.subscribeAll(MenuEntryToken, (entries) => {
      seen.push(entries.map((entry) => entry.id));
    });

    // The demo's own button, not a direct `kernel.activate` — what is under
    // test is the app.
    //
    // **Settled on `kernel.status`, not on a timer.** An `await new
    // Promise(setTimeout, 0)` inside `act` is *sometimes* long enough for the
    // two activations to land, and when it is not, the growth notifications
    // arrive interleaved with the logout below and the sequence assertion
    // reads as a kernel ordering bug rather than as the race it is. Measured
    // here, not guessed at: the same test written with a timer produced two
    // different orderings on two runs.
    await act(async () => {
      screen.getByRole('button', { name: 'Activate orders' }).click();
    });
    await waitFor(() => {
      expect(kernel.status(OrdersModule)).toBe('ready');
    });

    // **A1**, as a sequence: `payments` is pulled up transitively *first* and
    // notifies on its own, then `orders`. Two notifications, in that order —
    // membership would see one set and learn nothing about the cascade.
    expect(seen).toEqual([
      ['auth/home', 'dashboard/overview', 'payments/drafts'],
      ['auth/home', 'dashboard/overview', 'payments/drafts', 'orders/detail'],
    ]);

    await act(async () => {
      await kernel.deactivate(AuthModule);
    });

    // **A4, read as an order.** Logout disposes `orders` (a dependent of
    // `auth`) and then `auth` itself, so two entries leave in two separate
    // notifications and `payments` — which depends on nothing — keeps its
    // row. §15 criterion 1's wording says `payments` is disposed too; it is
    // not, and spec §17 already records that as a defect in the criterion.
    await waitFor(() => {
      expect(visibleMenu()).toEqual(['Dashboard', 'Payments']);
    });

    // **A4, read as an order rather than as membership.** `orders`' entry is
    // withdrawn first and `auth`'s second, which is the cascade the spec
    // specifies — dependents before the module they depend on — observed
    // through C5 rather than through the status log.
    expect(seen.slice(2)).toEqual([
      ['auth/home', 'dashboard/overview', 'payments/drafts'],
      ['dashboard/overview', 'payments/drafts'],
    ]);
  });

  it('the rendered order is (order ?? Infinity, C5 order), which C5 alone would not give', async () => {
    const kernel = await mountApp();
    await act(async () => {
      screen.getByRole('button', { name: 'Activate orders' }).click();
    });
    await waitFor(() => {
      expect(visibleMenu()).toHaveLength(4);
    });

    // **C5's own order and the rendered order genuinely differ**, which is
    // what makes this an assertion about the sort rather than about the
    // collection. C5 orders by module topological index: `payments` activates
    // transitively before `orders`, so its entry comes first. The `order`
    // fields put Orders above Payments, because 10 < 20.
    expect(kernel.getAll(MenuEntryToken).map((entry) => entry.id)).toEqual([
      'auth/home',
      'dashboard/overview',
      'payments/drafts',
      'orders/detail',
    ]);
    expect(visibleMenu()).toEqual(['Home', 'Dashboard', 'Orders', 'Payments']);
  });

  it('C9: each entry is attributed by the kernel, not by the entry', async () => {
    await mountApp();
    await act(async () => {
      screen.getByRole('button', { name: 'Activate orders' }).click();
    });
    await waitFor(() => {
      expect(visibleMenu()).toHaveLength(4);
    });

    // `MenuEntry` has no `owner` field — C9 forbids one. The menu pairs each
    // entry with `inspect()`'s row **before** sorting, and the sort above
    // genuinely reorders the list, so pairing after it would attribute
    // `Orders` to `payments` and vice versa while still rendering four rows
    // with four owners.
    const owners = Object.fromEntries(
      [...screen.getByTestId('app-menu-items').querySelectorAll('button')].map((button) => [
        button.textContent,
        button.getAttribute('data-owner'),
      ]),
    );
    expect(owners).toEqual({
      Home: 'auth',
      Dashboard: 'dashboard',
      Orders: 'orders',
      Payments: 'payments',
    });
  });

  it('a menu item navigates, and the route it names exists', async () => {
    await mountApp();
    await act(async () => {
      screen.getByTestId('menu-item-dashboard/overview').click();
      await Promise.resolve();
    });
    // The destination is a `RouteConfig.path` contributed by the same module,
    // so the menu can never offer a route that is not there.
    expect(screen.getByTestId('route-outlet').getAttribute('data-path')).toBe('/dashboard');
    expect(screen.getByTestId('dashboard')).toBeDefined();
  });
});
