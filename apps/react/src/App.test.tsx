// **Acceptance criterion 1**, as four tests over the real demo app.
//
// These run against the *actual* composition root — `createAppKernel()` with
// the real four descriptors — not against a hand-assembled kernel. A test
// that rebuilt the module list would pass while the composition root was
// wrong, which is precisely the thing criterion 1 exists to check.
//
// `createAppKernel(undefined)` passes no hot context, so `createViteHmrAdapter`
// yields the noop adapter and each module's `acceptHotUpdate` no-ops on its
// `undefined` guard. HMR behaviour itself is covered at the unit level in the
// kernel package; what is asserted here is that the wiring exists and is
// harmless without a bundler.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppKernel } from '@ng-react/kernel';
import type { Kernel, ModuleRef, ModuleStatus } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { DebugModule } from '@app/debug/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { App } from './App';
import { appModules, createAppKernel } from './composition-root';
import { sequenceOf } from './lifecycle-log';

/** `debug`'s deliberate failure, duplicated rather than imported — see `debug/src/lifecycle.ts`. */
const DEBUG_INIT_FAILURE =
  "debug: init failed on purpose so the demo can show F3's quarantine. " +
  'The app must still start, and every other module must still be ready.';

/**
 * Who has contributed a row to `auth/DiagnosticPanel`, in C5 topological
 * order. Filtered by token because `auth` also contributes an `ErrorSinkToken`
 * sink, and an unfiltered list would count it — the kind of near-miss that
 * makes an assertion pass for the wrong reason.
 */
function panelOwners(kernel: Kernel): readonly string[] {
  return kernel
    .inspect()
    .contributions.filter((row) => row.token === 'auth/DiagnosticPanel')
    .map((row) => row.owner);
}

/** Waits for the kernel's own view of a module, not for a rendered consequence of it. */
async function waitForStatus(
  kernel: Kernel,
  ref: ModuleRef,
  status: ModuleStatus,
): Promise<void> {
  await vi.waitFor(() => {
    expect(kernel.status(ref)).toBe(status);
  });
}

describe('demo app', () => {
  it('criterion 1: kernel.activate(OrdersModule) transitively activates payments', async () => {
    const { kernel, log } = createAppKernel(undefined);
    await kernel.whenStartupComplete();

    // The premise. `payments` is `lazy` and nothing has asked for it, so it
    // must still be `registered` — if it were already `ready` here the rest of
    // this test would prove nothing at all.
    expect(kernel.status(PaymentsModule)).toBe('registered');
    expect(kernel.status(OrdersModule)).toBe('registered');

    // **A1**: activating `orders` first activates its not-yet-active
    // `dependsOn`, transitively, in topological order. Nothing in this test
    // names `PaymentsModule` as an activation target.
    await kernel.activate(OrdersModule);

    expect(kernel.status(PaymentsModule)).toBe('ready');
    expect(kernel.status(OrdersModule)).toBe('ready');

    // And in that **order** — `payments` reached `ready` before `orders` did.
    // A1's real content is "a lazy module being activated must never observe a
    // dependency that is registered but not ready", which is an ordering
    // claim; asserting the set would leave it untested.
    //
    // Filtered to the three modules this claim is about. Since #24 the app
    // also registers `nav` and `shell`, both eager and non-critical, and
    // `whenStartupComplete` deliberately does *not* wait for those (A3 gates
    // on eager **critical** modules only) — so their `ready` transitions
    // interleave with the lazy pair's in a way that is real and irrelevant
    // here. Filtering keeps the assertion an *ordering* claim about A1
    // instead of a snapshot of startup timing.
    expect(
      sequenceOf(log, 'ready').filter((id) => ['auth', 'payments', 'orders'].includes(id)),
    ).toEqual(['auth', 'payments', 'orders']);

    // **The guarantee the next assertion needs, and it is not
    // `whenStartupComplete` (#51).** That assertion is an *exhaustive* claim
    // about the collection, and `debug` is one of its four possible
    // contributors — so it is only well-defined once `debug` has settled.
    // **A3** gates startup on eager **critical** modules; `debug` is eager
    // *non-critical*, so `whenStartupComplete()` says nothing about it and in
    // fact always resolves while it is still `activating` (measured: 300 of
    // 300 kernels). `debug`'s `DiagnosticPanel` row then enters the collection
    // when its providers register and leaves when F3 withdraws them — a real
    // window, median ≈ 8 ms wide, that nothing here was ordered against.
    // The test passed anyway only because `activate(OrdersModule)` takes
    // longer still (the window had closed ≥ 25 ms before, over 60 cold runs),
    // which is a coincidence of import timing, not a guarantee. Awaiting the
    // quarantine makes it one.
    //
    // Waiting rather than filtering `debug` out of the list is deliberate:
    // `debug` is a real contributor to *this* token, so dropping it would turn
    // an exhaustive assertion into a whitelist that could no longer notice an
    // unexpected fourth row. (Contrast the filter above, which excludes `nav`
    // and `shell` — neither contributes to this token at all, and that
    // assertion is about order rather than membership.)
    await waitForStatus(kernel, DebugModule, 'failed');

    // **C5**: and the contribution collection grew with them. `debug` is
    // absent because F3 withdrew its row.
    expect(panelOwners(kernel)).toEqual(['auth', 'payments', 'orders']);
  });

  it('criterion 1: debug is quarantined without affecting startup', async () => {
    const { kernel, log } = createAppKernel(undefined);

    // **The startup half, asserted first and positively.** `debug` failing is
    // easy to show; "without affecting startup" is the clause that a passing
    // test can silently skip. `whenStartupComplete` resolves only when every
    // eager *critical* module is `ready` and rejects if one cannot be (F2), so
    // awaiting it here is the machine-checked form of "the app started".
    await expect(kernel.whenStartupComplete()).resolves.toBeUndefined();
    expect(kernel.status(AuthModule)).toBe('ready');

    // **F1/F3**: `debug` is eager and non-critical, so its identical failure
    // is quarantined instead.
    await waitForStatus(kernel, DebugModule, 'failed');
    const row = kernel.inspect().modules.find((entry) => entry.id === 'debug');
    expect(row?.error?.message).toContain(DEBUG_INIT_FAILURE);

    // **F3**: its contributions are withdrawn, so nothing downstream of the
    // reactive collection ever sees them.
    expect(panelOwners(kernel)).toEqual(['auth']);

    // And the app still works *afterwards*: a lazy module can still be
    // activated, which is the practical meaning of "startup was not affected".
    await kernel.activate(OrdersModule);
    expect(kernel.status(OrdersModule)).toBe('ready');

    // **F4**: the failure was reported to `auth`'s sink with the kernel's own
    // attribution (**C9**) — `'debug'`, from a sink `debug` does not own.
    render(
      <AppKernel kernel={kernel}>
        <App log={log} />
      </AppKernel>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('error-log').textContent).toContain('debug');
    });
    expect(screen.getByTestId('error-log').textContent).toContain(DEBUG_INIT_FAILURE);
    expect(screen.getByTestId('module-debug').getAttribute('data-status')).toBe('failed');
    expect(screen.getByTestId('module-auth').getAttribute('data-status')).toBe('ready');
  });

  it('criterion 1: deactivate(AuthModule) disposes orders and payments in reverse topological order', async () => {
    const { kernel, log } = createAppKernel(undefined);
    await kernel.whenStartupComplete();
    await kernel.activate(OrdersModule);
    expect(sequenceOf(log, 'disposed')).toEqual([]);

    await kernel.deactivate(AuthModule);

    // **A4, and this is where the criterion's own wording is wrong.** A4
    // disposes "the module and every active module that transitively depends
    // on it": `orders` depends on `auth`, so it dies first; `auth` dies last.
    // `payments` depends on *nothing* — the module table in issue #23 and
    // §15's own `dependsOn` for it are both empty — so it is not part of this
    // cascade at all. §15 criterion 1 says logout cascades "disposal of orders
    // and payments dependents in reverse order", which cannot be true of this
    // graph in either reading. Asserted as it actually is, and reported as a
    // spec defect rather than papered over by giving `payments` a dependency
    // it does not have.
    expect(sequenceOf(log, 'disposed')).toEqual(['orders', 'auth']);
    expect(kernel.status(PaymentsModule)).toBe('ready');

    // The order claim, stated as an order rather than as membership: the
    // dependent is gone before the module it depended on begins disposing.
    const disposals = log.getState().filter((event) => event.status === 'disposed');
    expect(disposals[0]?.seq).toBeLessThan(disposals[1]?.seq ?? -1);

    // And the criterion's *intent* — a full logout, reverse-topologically —
    // discharged the only way this graph allows: `payments` is disposed by its
    // own `deactivate`, and lands after both.
    await kernel.deactivate(PaymentsModule);
    expect(sequenceOf(log, 'disposed')).toEqual(['orders', 'auth', 'payments']);
  });

  it('H2: the composition root arms every module\'s hot block with the kernel', async () => {
    // **The obligation the kernel cannot discharge for itself.** `accept` is
    // called by the module, not the kernel (§17), and a module may not import
    // the composition root (B1) — so if the root forgets one
    // `acceptHotUpdate(kernel)` call, that module simply never hot-replaces
    // and every edit to it falls through to a full page reload. Nothing else
    // in the workspace would notice, which is exactly the "documented but not
    // enforced" shape principle 4 rejects.
    const armed: string[] = [];
    const replaced: string[] = [];
    const callbacks = new Map<string, (next?: unknown) => void>();

    const { kernel } = createAppKernel(undefined, (moduleId) => ({
      accept: (callback) => {
        armed.push(moduleId);
        callbacks.set(moduleId, callback);
      },
    }));
    await kernel.whenStartupComplete();

    // `nav` is armed like any other module package — criterion 10's PoC
    // navigation module has no privileges, and that includes no exemption
    // from H2. `shell` is absent because it is app source rather than a
    // module package; see the note in `composition-root.ts`.
    expect(armed).toEqual(['auth', 'debug', 'payments', 'orders', 'nav']);

    // Armed with the *kernel*, not merely armed: firing a module's callback
    // with a replacement descriptor has to reach `kernel.hotReplace`. A root
    // that passed the wrong kernel — or a stale one from a previous
    // `createAppKernel` — would pass the assertion above and fail this.
    const original = kernel.hotReplace.bind(kernel);
    kernel.hotReplace = async (ref, next) => {
      replaced.push(ref.id);
      await original(ref, next);
    };
    callbacks.get('payments')?.({ module: appModules[2] });
    expect(replaced).toEqual(['payments']);
  });

  it('renders the diagnostic surface with every module accounted for', async () => {
    const { kernel, log } = createAppKernel(undefined);
    await kernel.whenStartupComplete();
    await waitForStatus(kernel, DebugModule, 'failed');

    render(
      <AppKernel kernel={kernel}>
        <App log={log} />
      </AppKernel>,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('acceptance criterion 1');
    for (const ref of [AuthModule, DebugModule, PaymentsModule, OrdersModule]) {
      expect(screen.getByTestId(`module-${ref.id}`)).toBeDefined();
    }
    expect(screen.getByTestId('module-payments').getAttribute('data-status')).toBe('registered');

    // **C5/R3**: only `auth` has contributed so far — `payments` and `orders`
    // are inactive and `debug` is quarantined.
    expect(screen.getByTestId('panel-auth').textContent).toContain('signed in as demo-user');
    expect(screen.queryByTestId('panel-debug')).toBeNull();
    expect(screen.queryByTestId('panel-orders')).toBeNull();

    // **A2**: the lifecycle log is the kernel's transitions, in order.
    expect(screen.getByTestId('lifecycle-log').textContent).toContain('auth');
  });
});
