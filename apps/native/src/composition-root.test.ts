// The native composition root, exercised with **no renderer** — which is
// acceptance criterion 7's environment ("the kernel and `createTestKernel`
// work in a plain Jest/Vitest environment with no React renderer") applied to
// an app that has no renderer available in the first place.
//
// **What is covered here and what is not, stated once.** Everything below is
// about the *collections* and the *kernel*: what the drawer and the dashboard
// would read, in what order, with which owners, as modules activate and are
// disposed. Nothing renders. Whether React Navigation puts those rows on a
// screen, and whether Metro picked `screen.native.tsx` to put in them, is
// verified by the simulator run recorded in the PR body and by
// `platform-split.test.ts` — not here. See `src/testing/react-native-stub.ts`
// for why that boundary is where it is.
//
// **Every wait settles on `kernel.status`, never on a timer.** `HANDOFF.md`
// §5.13 and #52's addendum to it: `whenStartupComplete()` gates on eager
// *critical* modules only, and a `setTimeout(0)` is *sometimes* long enough
// for a transitive activation pair to land — when it is not, the C5 growth
// notifications interleave with a later `deactivate` and the resulting
// sequence reads like a kernel ordering bug rather than a test race.

import { AuthModule } from '@app/auth/contract';
import { DashboardCardToken, DashboardModule } from '@app/dashboard/contract';
import { DebugModule } from '@app/debug/contract';
import { MenuEntryToken } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import type { Kernel, ModuleRef, ModuleStatus, Token, Unsubscribe } from '@ng-react/kernel';
import { appModules, createAppKernel, nativeHmrAdapter } from './composition-root';
import { ShellModule } from './shell/module';

/** Settles on a real status transition rather than on a timer (§5.13). */
async function waitForStatus(
  kernel: Kernel,
  ref: ModuleRef,
  status: ModuleStatus,
): Promise<void> {
  if (kernel.status(ref) === status) {
    return;
  }
  await new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribeStatus(ref, (next) => {
      if (next === status) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Settles on a **collection** notification rather than on a status or a timer.
 *
 * Needed because the two are not the same event and their order is not the one
 * a reader expects: a quarantined module's status reaches `failed` *before* its
 * contributions have been withdrawn from C5's collections, so a test that
 * settled on `status === 'failed'` and then read the collection would read it
 * one notification too early. That is a real ordering fact about the kernel,
 * not a race — it is reproducible — and it is why this helper exists instead of
 * a `setTimeout` (HANDOFF §5.13).
 */
async function waitForCollection<T>(
  kernel: Kernel,
  token: Token<T>,
  predicate: (values: readonly T[]) => boolean,
): Promise<void> {
  if (predicate(kernel.getAll(token))) {
    return;
  }
  await new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribeAll(token, (values) => {
      if (predicate(values)) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Records every notification a C5 collection delivered, as arrays of ids. */
function recordCollection<T extends { readonly id: string }>(
  kernel: Kernel,
  token: Token<T>,
): { readonly seen: readonly (readonly string[])[]; readonly stop: Unsubscribe } {
  const seen: (readonly string[])[] = [];
  const stop = kernel.subscribeAll(token, (values) => {
    seen.push(values.map((value) => value.id));
  });
  return { seen, stop };
}

describe('apps/native composition root', () => {
  it('registers the same six module packages the web root does, plus this host’s own shell', () => {
    // The claim issue #53 exists to test, expressed as an assertion: the
    // feature modules are reused, not re-declared. `shell` is the one
    // difference and it is app-owned on both hosts.
    expect(appModules.map((descriptor) => descriptor.id.id)).toEqual([
      'auth',
      'debug',
      'payments',
      'orders',
      'nav',
      'dashboard',
      'shell',
    ]);
  });

  it('ADR-5: the native HmrAdapter is {} because Metro cannot invalidate', () => {
    // `packages/ng-react/src/hmr/adapter.ts` predicts exactly this object for
    // Metro has no invalidation API, so it supplies the same `{}` shape as
    // the noop adapter. The optional member is the sole capability signal.
    //
    // Asserted with `Object.keys`, not with `adapter.invalidate === undefined`:
    // a no-op `invalidate` added by a later tidy-up would satisfy the second
    // and would silently stop exercising the absent-member call site
    // `this.hmr.invalidate?.(…)` guards.
    expect(Object.keys(nativeHmrAdapter)).toEqual([]);
  });

  it('H2: every module package is armed with this kernel through acceptHotUpdate', () => {
    // Without this test, deleting one of the six `acceptHotUpdate` lines would
    // break HMR for that module on any host that supplies a hot context, and
    // nothing in the workspace would notice — a rule documented and not
    // enforced (principle 4).
    const armed: string[] = [];
    const replaced: string[] = [];
    const callbacks = new Map<string, (next?: unknown) => void>();

    const { kernel } = createAppKernel((moduleId) => ({
      accept: (callback) => {
        armed.push(moduleId);
        callbacks.set(moduleId, callback);
      },
    }));

    // `nav` is armed like any other module package — criterion 10's PoC
    // navigation module has no privileges, and that includes no exemption from
    // H2. `shell` is absent because it is app source rather than a module
    // package; see the note in `composition-root.ts`.
    expect(armed).toEqual(['auth', 'debug', 'payments', 'orders', 'nav', 'dashboard']);

    // **Armed with the *kernel*, not merely armed.** Firing a module's callback
    // with a replacement descriptor has to reach *this* kernel's `hotReplace`.
    // A root that passed the wrong kernel — or a stale one from a previous
    // `createAppKernel` — would pass the assertion above and fail this one.
    const original = kernel.hotReplace.bind(kernel);
    kernel.hotReplace = async (ref, next) => {
      replaced.push(ref.id);
      await original(ref, next);
    };
    callbacks.get('payments')?.({ module: appModules[2] });
    expect(replaced).toEqual(['payments']);
  });

  it('C5: the drawer’s menu collection grows as modules activate — as a sequence, not a membership', async () => {
    const { kernel } = createAppKernel();
    const menu = recordCollection(kernel, MenuEntryToken);

    // `whenStartupComplete()` gates on eager **critical** modules only
    // (A3), so `dashboard`, `nav` and `shell` are settled on individually.
    await kernel.whenStartupComplete();
    await waitForStatus(kernel, DashboardModule, 'ready');
    await waitForStatus(kernel, ShellModule, 'ready');
    const atStartup = menu.seen.at(-1) ?? [];

    await kernel.activate(OrdersModule);
    await waitForStatus(kernel, OrdersModule, 'ready');
    const afterOrders = menu.seen.at(-1) ?? [];

    menu.stop();

    // **A1, transitive.** `payments` was never asked for; it comes up because
    // `orders` depends on it, and its menu row appears with it.
    expect(atStartup).not.toContain('orders/detail');
    expect(atStartup).not.toContain('payments/drafts');
    expect(afterOrders).toContain('orders/detail');
    expect(afterOrders).toContain('payments/drafts');

    // The rows that are there at the *first* paint are the eager ones —
    // `auth` is eager+critical, `dashboard` and this app's `shell` are eager.
    // A drawer whose only rows came from lazy modules would be empty at
    // startup and would prove nothing about the collection being live.
    expect(atStartup).toContain('auth/home');
    expect(atStartup).toContain('dashboard/overview');
    expect(atStartup).toContain('shell/orders');

    // The sequence grew monotonically until the activation: no notification
    // ever shrank the menu while modules were only coming up.
    const lengths = menu.seen.map((entry) => entry.length);
    expect(lengths).toEqual([...lengths].sort((left, right) => left - right));
  });

  it('C5/A4: logout withdraws the menu rows and cards of the disposed modules and nothing else', async () => {
    const { kernel } = createAppKernel();
    await kernel.whenStartupComplete();
    await waitForStatus(kernel, ShellModule, 'ready');
    await kernel.activate(OrdersModule);
    await waitForStatus(kernel, OrdersModule, 'ready');

    const menu = recordCollection(kernel, MenuEntryToken);
    const cards = recordCollection(kernel, DashboardCardToken);

    await kernel.deactivate(AuthModule);
    await waitForStatus(kernel, AuthModule, 'disposed');
    await waitForStatus(kernel, OrdersModule, 'disposed');

    menu.stop();
    cards.stop();

    const finalMenu = menu.seen.at(-1) ?? [];
    const finalCards = cards.seen.at(-1) ?? [];

    // **A4 cascades by declared `dependsOn`, not by "everything active".**
    // `orders` depends on `auth` and goes; `payments` depends on nothing and
    // stays, so its row and its card are still there. Spec §15 criterion 1
    // reads as though `payments` were disposed too — recorded as a spec defect
    // by #45 and not worked around here either.
    expect(finalMenu).not.toContain('auth/home');
    expect(finalMenu).not.toContain('orders/detail');
    expect(finalMenu).toContain('payments/drafts');
    expect(finalCards).not.toContain('orders/recent');
    expect(finalCards).toContain('payments/drafts');

    // The shell is app-owned and never disposed, so the drawer can never be
    // left with no way back — which is a property of *this* host rather than
    // of the kernel, and is why it is asserted here.
    expect(finalMenu).toContain('shell/home');
  });

  it('F3: debug’s card is withdrawn by quarantine, not merely never contributed', async () => {
    // **The load-bearing test of this file.** "The card is absent" and "the
    // card was never contributed" look identical from the outside, so the only
    // assertion that can tell them apart is the *sequence* the collection's
    // subscribers saw: `debug/probe` has to appear and then be withdrawn.
    // #52's mutation A — deleting `contribute(DashboardCardToken, …)` from
    // `@app/debug/src/providers.ts` — is what this is armed against, and it is
    // re-run against this file in the PR body.
    const { kernel } = createAppKernel();
    const cards = recordCollection(kernel, DashboardCardToken);

    await kernel.whenStartupComplete();
    await waitForStatus(kernel, DebugModule, 'failed');
    // Settled on the *collection*, not on the status: see `waitForCollection`.
    await waitForCollection(
      kernel,
      DashboardCardToken,
      (values) => !values.some((card) => card.id === 'debug/probe'),
    );
    cards.stop();

    // **Two notifications, and both of them are the assertion.** A module that
    // never contributed produces none at all; `debug` produces one when its
    // providers thunk registered the card and one when `init` threw and F3
    // quarantined it. No feature module is active at startup, so `debug/probe`
    // is the only card either notification can carry.
    expect(cards.seen).toEqual([['debug/probe'], []]);
    // And the withdrawal is caused by `debug`'s own quarantine (F1/F3), not by
    // the dashboard: `@app/dashboard` contains no code that names `debug`.
    expect(kernel.status(DebugModule)).toBe('failed');
  });
});
