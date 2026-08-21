// The dashboard surface, in the running demo app — **issue #52**.
//
// Three things are proven here that cannot be proven anywhere else:
//
//  1. **The platform decision resolves** (issue #52 §3). `providers.ts`
//     imports `./screen`; the web build must pick `screen.web.tsx`. The
//     assertions below fail if `screen.native.tsx` were picked instead, and
//     they are only meaningful because that file exists — so its existence is
//     asserted too, from disk.
//  2. **F3 withdrawal, told apart from "never contributed".** `debug`
//     contributes a card and is quarantined. "The card is absent" is true of
//     both, so the test records what the collection's subscribers *saw*.
//  3. **Growth and shrinkage as sequences**, against the real composition
//     root, with no dashboard code involved in either.
//
// The whole app is rendered, through `createAppKernel()` and `<App>`, for the
// reason every acceptance test here does it: a test that mounted the
// dashboard by hand would pass while the composition root was wrong.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AppKernel } from '@ng-react/kernel';
import type { Kernel } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { DashboardCardToken } from '@app/dashboard/contract';
import { DebugModule } from '@app/debug/contract';
import { NavModule } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { App } from '../App';
import { createAppKernel } from '../composition-root';

/** Boots the real app, mounts it, and navigates to the dashboard route. */
async function mountDashboard(): Promise<Kernel> {
  const { kernel, log } = createAppKernel(undefined);
  await kernel.whenStartupComplete();
  // `nav` and `dashboard` are eager but **non-critical**, and A3 gates
  // `whenStartupComplete` on eager *critical* modules only — so awaiting it
  // and then asserting on either is racy (HANDOFF §5.13, issue #51).
  // `activate` is idempotent and single-flight, so these join the in-flight
  // eager activation rather than starting a second one.
  await kernel.activate(NavModule);
  render(
    <AppKernel kernel={kernel}>
      <App log={log} />
    </AppKernel>,
  );
  await screen.findByTestId('navigator');
  await act(async () => {
    screen.getByTestId('nav-link-/dashboard').click();
    await Promise.resolve();
  });
  await screen.findByTestId('dashboard');
  return kernel;
}

/** The card ids the dashboard is showing, **in rendered order**. */
function visibleCards(): readonly string[] {
  return [...screen.getByTestId('dashboard-cards').querySelectorAll('li')].map(
    (item) => item.getAttribute('data-testid')?.replace('dashboard-card-', '') ?? '',
  );
}

/**
 * Absolute path of a file in the workspace.
 *
 * Walks up from the working directory to the folder holding
 * `pnpm-workspace.yaml` rather than counting `..` segments off
 * `import.meta.url`: under the `demo` vitest project this file's
 * `import.meta.url` is not a `file:` URL at all (jsdom), so
 * `fileURLToPath` throws and — worse — a mistyped relative path just makes
 * `existsSync` return `false`, i.e. the guard below fails closed in a way
 * that looks exactly like the thing it is guarding against.
 */
function workspacePath(relative: string): string {
  let dir = process.cwd();
  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No pnpm-workspace.yaml above ${process.cwd()}.`);
    }
    dir = parent;
  }
  return path.join(dir, relative);
}

describe('#52 — the dashboard collection in the running app', () => {
  describe('the platform decision (issue #52 §3)', () => {
    it('every platform-split component ships both halves', () => {
      // **The guard that stops the resolution test below being vacuous.** If
      // the `.native.tsx` files were deleted, `./screen` would resolve to the
      // only remaining candidate and every assertion about "the web one was
      // picked" would pass while proving nothing about resolution at all.
      // This is #52's version of HANDOFF §5.2's weak-test pattern.
      for (const pkg of ['dashboard', 'orders', 'payments', 'debug']) {
        for (const platform of ['web', 'native']) {
          expect(
            fs.existsSync(workspacePath(`packages/${pkg}/src/screen.${platform}.tsx`)),
            `packages/${pkg}/src/screen.${platform}.tsx must exist`,
          ).toBe(true);
        }
      }
    });

    it('the web build resolves ./screen to screen.web.tsx, not screen.native.tsx', async () => {
      const kernel = await mountDashboard();

      // The dashboard's own screen — resolved through `@app/dashboard`'s
      // `providers.ts`, which imports `./screen` and nothing else.
      expect(screen.getByTestId('dashboard').getAttribute('data-platform')).toBe('web');

      // A contributed card needs its module running, so bring the lazy pair
      // up the way a user would.
      await act(async () => {
        await kernel.activate(OrdersModule);
      });
      await waitFor(() => {
        expect(visibleCards()).toContain('payments/drafts');
      });
      // …and a *contributed* component, which travelled across a module
      // boundary as the `component` field of one `contribute()` call. Both
      // markers are `native` in the `.native.tsx` siblings, so picking the
      // wrong file fails this line rather than merely looking different.
      expect(screen.getByTestId('payments-card').getAttribute('data-platform')).toBe('web');
      expect(screen.getByTestId('orders-card').getAttribute('data-platform')).toBe('web');
    });
  });

  it('C5: cards grow on activation and shrink on logout — as a sequence', async () => {
    const kernel = await mountDashboard();

    const seen: (readonly string[])[] = [];
    kernel.subscribeAll(DashboardCardToken, (cards) => {
      seen.push(cards.map((card) => card.id));
    });

    // At this point nothing lazy is active: no cards at all.
    expect(kernel.getAll(DashboardCardToken)).toEqual([]);
    expect(screen.getByTestId('dashboard-empty')).toBeDefined();

    // **The user gesture the issue asks for**: the demo's own "Activate
    // orders" button, not a direct `kernel.activate` — so what is asserted is
    // the app, not the kernel.
    // **Settled on `kernel.status`, not on a timer.** A `setTimeout(0)` inside
    // `act` is sometimes long enough for the two activations to land and
    // sometimes not, and when it is not the growth notifications interleave
    // with the logout below — the sequence then reads as a kernel ordering
    // bug rather than as the race it is. Observed while writing this file.
    await act(async () => {
      screen.getByRole('button', { name: 'Activate orders' }).click();
    });
    await waitFor(() => {
      expect(kernel.status(OrdersModule)).toBe('ready');
    });
    await waitFor(() => {
      expect(visibleCards()).toContain('orders/recent');
    });

    // …and logout, which is `kernel.deactivate(AuthModule)`: A4 cascades to
    // `orders` (its dependent) and then `auth`. `payments` depends on nothing
    // and stays `ready`, so its card stays — the difference between "the
    // collection is reactive" and "the collection is cleared".
    await act(async () => {
      await kernel.deactivate(AuthModule);
    });
    await waitFor(() => {
      expect(visibleCards()).not.toContain('orders/recent');
    });

    // **A sequence, not membership.** `payments` comes up transitively (A1)
    // before `orders` does, so the collection gains two cards in two separate
    // notifications and loses exactly one. A membership assertion would pass
    // against a collection that was rebuilt on every read and would not
    // notice a missing notification at all.
    expect(seen).toEqual([
      ['payments/drafts'],
      ['payments/drafts', 'orders/recent'],
      ['payments/drafts'],
    ]);
  });

  it('F3: debug\'s card is withdrawn by quarantine, not merely never contributed', async () => {
    // **The assertion "the card is absent" cannot make.** A module that never
    // contributed produces no notifications at all; `debug` produces two —
    // registered when its providers thunk ran, withdrawn when its `init`
    // threw and F3 quarantined it. The sequence is the only thing that tells
    // the two apart, so it is recorded from before startup.
    const seen: (readonly string[])[] = [];
    const { kernel, log } = createAppKernel(undefined);
    kernel.subscribeAll(DashboardCardToken, (cards) => {
      seen.push(cards.map((card) => card.id));
    });

    await kernel.whenStartupComplete();
    await waitFor(() => {
      expect(kernel.status(DebugModule)).toBe('failed');
    });

    expect(seen).toEqual([['debug/probe'], []]);
    expect(kernel.getAll(DashboardCardToken)).toEqual([]);

    // And the same fact from the kernel's side: the contribution row is gone
    // from `inspect()` too, so this is withdrawal and not a filtered read.
    expect(
      kernel.inspect().contributions.filter((row) => row.token === 'dashboard/DashboardCard'),
    ).toEqual([]);

    // Rendered: the dashboard shows no debug card, and the package that
    // renders it contains no code that knows `debug` exists.
    await kernel.activate(NavModule);
    render(
      <AppKernel kernel={kernel}>
        <App log={log} />
      </AppKernel>,
    );
    await screen.findByTestId('navigator');
    await act(async () => {
      screen.getByTestId('nav-link-/dashboard').click();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('dashboard-card-debug/probe')).toBeNull();
  });

  it('C9: cards are attributed by the kernel even when the sort reorders them', async () => {
    const kernel = await mountDashboard();
    await act(async () => {
      await kernel.activate(OrdersModule);
    });
    await waitFor(() => {
      expect(visibleCards()).toContain('orders/recent');
    });

    // **This is the case where pairing after the sort would be wrong.** C5's
    // order puts `payments` first (it activates transitively, before
    // `orders`); the `order` fields put `orders` first, because 10 < 20. So
    // the rendered order is the *reverse* of the owner order, and a screen
    // that indexed `owners[i]` after sorting would attribute each card to the
    // other module — while still rendering two cards with two owners.
    expect(kernel.getAll(DashboardCardToken).map((card) => card.id)).toEqual([
      'payments/drafts',
      'orders/recent',
    ]);
    expect(visibleCards()).toEqual(['orders/recent', 'payments/drafts']);

    const owners = Object.fromEntries(
      [...screen.getByTestId('dashboard-cards').querySelectorAll('li')].map((item) => [
        item.getAttribute('data-testid'),
        item.getAttribute('data-owner'),
      ]),
    );
    expect(owners).toEqual({
      'dashboard-card-orders/recent': 'orders',
      'dashboard-card-payments/drafts': 'payments',
    });
  });
});
