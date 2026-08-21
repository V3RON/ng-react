// **Acceptance criterion 3** (spec §15.3):
//
// > Editing `orders/lifecycle.ts` while the app runs re-activates only
// > `orders` (and true consumers per H5), preserves `persistent: true` store
// > state per H3/H4, and the H7 leak check passes across 20 consecutive
// > edits.
//
// ---
//
// ### What drives the edit, and why it is not "the fake HMR adapter"
//
// The brief for #24 says to drive this through a fake `HmrAdapter`. As of
// #47 that is no longer possible and the adapter is not the seam: `accept`
// was removed from `HmrAdapter` entirely (issue #42, spec §17), because Vite
// decides self-acceptance by *lexically scanning a module's own source* for
// `import.meta.hot.accept` — so no indirection can register it. What remains
// on the adapter is `invalidate`. The seam an edit arrives through is each
// module's own `acceptHotUpdate(kernel, hot?)`, and the call it makes is
// `kernel.hotReplace(ref, nextDescriptor)`. This file drives `hotReplace`
// directly, which is what that callback does and all that it does;
// `packages/orders/src/module.test.ts` covers the callback itself.
//
// ### Why `createTestKernel` and not the demo app
//
// Because the H7 half is only *measurable* there. `LeakInvariantCheck` is
// constructed only when something installed leak counters for it to read, and
// today `createTestKernel` is the only thing that does (`kernel.ts`'s
// `installLeakCheck`). A browser session of the demo app therefore runs the
// H7 check **not at all**, and "no leak warnings after 20 edits" measured
// against the demo would be vacuous rather than passing — spec §17 records
// exactly this and hands the problem to this task. The modules under test are
// still the real ones, from the real composition root.

import { describe, expect, it } from 'vitest';
import { createTestKernel } from '@ng-react/kernel';
import type { ModuleDescriptor, TestKernel } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { PaymentDraftStoreToken, PaymentsModule } from '@app/payments/contract';
import { OrderNotesToken, OrdersModule } from '@app/orders/contract';
import { descriptorFor } from './modules';

/** Spec §15.3's number, in one place. */
const CONSECUTIVE_EDITS = 20;

/**
 * The real demo, minus the modules this criterion is not about.
 *
 * `debug` is left out because it fails on purpose and would fill `errors`
 * with a quarantine report that the H7 assertion below would then have to
 * filter — and an assertion with a filter in it is one step from an assertion
 * that filters away the thing it was watching for. `nav` and `shell` are left
 * out because neither consumes anything from `orders`, so their absence
 * cannot flatter the H5 result (their presence is asserted separately, in
 * criterion 10's test).
 */
function runtime(): { kernel: TestKernel; orders: ModuleDescriptor } {
  const orders = descriptorFor(OrdersModule);
  const kernel = createTestKernel({
    modules: [descriptorFor(AuthModule), descriptorFor(PaymentsModule), orders],
  });
  return { kernel, orders };
}

/**
 * One edit to `orders/lifecycle.ts`.
 *
 * A file edit produces a re-evaluated `module.ts` whose `module` export is a
 * *new descriptor object* referencing the same thunks — the thunks are
 * `() => import('./lifecycle')`, and it is the bundler that re-evaluates the
 * imported file, not the descriptor. So a structurally identical replacement
 * is exactly what an edit to a lifecycle or provider file hands `hotReplace`,
 * and the identity is fresh so nothing can short-circuit on it.
 */
async function applyEdit(kernel: TestKernel, orders: ModuleDescriptor): Promise<void> {
  await kernel.hotReplace(OrdersModule, { ...orders });
}

describe('acceptance criterion 3 — editing orders/lifecycle.ts', () => {
  it('H5: an edit to orders re-activates orders and nothing else', async () => {
    const { kernel, orders } = runtime();
    await kernel.activate(OrdersModule);
    expect(kernel.status(OrdersModule)).toBe('ready');
    expect(kernel.status(PaymentsModule)).toBe('ready');

    // **H6 epochs are the observation surface.** Each module re-activation
    // bumps the resolution epoch of the module re-activated, so the epoch is
    // a per-module count of "how many times has this been through a cycle" —
    // which is precisely what H5 constrains. Asserted as a *baseline diff*
    // rather than an absolute, so this cannot pass because nothing ever
    // bumped anything.
    const before = {
      auth: kernel.epochOf('auth'),
      payments: kernel.epochOf('payments'),
      orders: kernel.epochOf('orders'),
    };

    await applyEdit(kernel, orders);

    expect(kernel.epochOf('orders')).toBe(before.orders + 1);
    // **`payments` is a *dependency* of `orders`, not a consumer of it.** H5
    // narrows the cascade to "modules that actually consumed a resolved
    // instance from the edited module"; nothing in this app resolves anything
    // out of `orders`, so the cascade is `orders` alone. The declared-
    // `dependsOn` cascade (A4) would have been the same here — it runs to
    // *dependents* too — which is why the H5-vs-A4 difference is asserted in
    // criterion 4's test, where the edited module does have a consumer.
    expect(kernel.epochOf('payments')).toBe(before.payments);
    expect(kernel.epochOf('auth')).toBe(before.auth);
    expect(kernel.status(PaymentsModule)).toBe('ready');
    expect(kernel.status(AuthModule)).toBe('ready');
    expect(kernel.status(OrdersModule)).toBe('ready');

    await kernel.dispose();
  });

  it('H3/H4: the edited module\'s persistent store keeps its state across the edit', async () => {
    const { kernel, orders } = runtime();
    await kernel.activate(OrdersModule);

    const notes = kernel.get(OrderNotesToken);
    // `init` seeded one note. Adding a second is what makes the assertion
    // about *state* rather than about a re-seed: a discarded store would come
    // back with the seed's single entry, which is a different number from
    // this one.
    notes.setState((current) => [...current, { text: 'written after activation' }]);
    expect(notes.getState()).toHaveLength(2);

    await applyEdit(kernel, orders);

    const afterEdit = kernel.get(OrderNotesToken);
    // **H4's sole exception, stated precisely.** H4: "`persistent: true`
    // stores are the sole exception: their **state** is transferred to the
    // newly constructed instance". So what survives is the state, not the
    // object — the old instance is parked rather than disposed (spec §17:
    // "disposing a store is how a store throws its state away"), its snapshot
    // is restored onto a freshly constructed successor, and the old one is
    // then dropped.
    //
    // Asserted in both directions, because "preserved" is ambiguous in
    // English and is not in the spec: the instance **is** new, and the state
    // **is** the old one. The first half is why H6's epoch bump is not
    // optional — a component holding the old reference is holding a store
    // nothing will write to again, and re-resolving is the only fix.
    expect(afterEdit).not.toBe(notes);
    expect(afterEdit.getState()).toHaveLength(2);
    expect(afterEdit.getState().map((note) => note.text)).toEqual([
      'seeded by orders/lifecycle.ts init',
      'written after activation',
    ]);

    // And the contrast H3 exists to draw: a **real** deactivation discards
    // it. Without this, "preserved" would be indistinguishable from "never
    // disposed under any circumstances", which is not what H3 promises.
    await kernel.deactivate(OrdersModule);
    await kernel.activate(OrdersModule);
    expect(kernel.get(OrderNotesToken).getState()).toHaveLength(1);

    await kernel.dispose();
  });

  it('H3: an unrelated module\'s persistent store is untouched by the edit', async () => {
    // Weaker than the test above on purpose — `payments` is not in the
    // cascade, so this could only fail if `hotReplace` reached outside it —
    // and recorded as such in `docs/acceptance.md` rather than counted as the
    // H3 evidence.
    const { kernel, orders } = runtime();
    await kernel.activate(OrdersModule);
    const drafts = kernel.get(PaymentDraftStoreToken);
    const before = drafts.getState();

    await applyEdit(kernel, orders);

    expect(kernel.get(PaymentDraftStoreToken)).toBe(drafts);
    expect(kernel.get(PaymentDraftStoreToken).getState()).toBe(before);

    await kernel.dispose();
  });

  it(`H7: the leak check reports nothing across ${String(CONSECUTIVE_EDITS)} consecutive edits`, async () => {
    const { kernel, orders } = runtime();
    await kernel.activate(OrdersModule);

    // **The vacuity guard.** H7's check runs only when a `LeakInvariantCheck`
    // exists, which requires a dev kernel with counters installed. If the
    // counters were inert the report below would be all zeros and the
    // assertion at the end would pass having measured nothing. `orders`'
    // `init` registers one `ctx.on` listener and one `ctx.effect`, so both
    // counted kinds must be non-zero here before any edit happens.
    const baseline = kernel.leaks();
    expect(baseline.details).toContainEqual({ moduleId: 'orders', kind: 'listener', count: 1 });
    expect(baseline.details).toContainEqual({ moduleId: 'orders', kind: 'effect', count: 1 });

    for (let edit = 0; edit < CONSECUTIVE_EDITS; edit += 1) {
      await applyEdit(kernel, orders);
      // Asserted *inside* the loop: a leak that appeared on edit 3 and was
      // somehow reconciled by edit 20 would still be a leak, and checking
      // only at the end would miss it.
      expect(kernel.status(OrdersModule)).toBe('ready');
    }

    expect(kernel.epochOf('orders')).toBe(CONSECUTIVE_EDITS);

    // **H7 proper**: a violation is a `LeakInvariantViolation` routed to the
    // F4 sinks with `code === 'KERNEL_H7_LEAK'` (it is never thrown — "a leak
    // report that broke the app would be a worse bug than the leak"). The
    // test kernel's harness sink collects every routed error, so this is the
    // check itself and not a proxy for it.
    const leakWarnings = kernel.errors.filter(
      (entry) => (entry.error as { code?: string }).code === 'KERNEL_H7_LEAK',
    );
    expect(leakWarnings).toEqual([]);
    // Nothing else was routed either — a failed re-activation would be here.
    expect(kernel.errors).toEqual([]);

    // And the counters themselves did not drift. `balanced` is *false* here
    // and correctly so: it means "some registrations are outstanding", which
    // is true of any live module — `orders` is `ready` and holding its
    // listener and its timer. What H7 is about is **accumulation**, so the
    // assertion is that 20 cycles left the counts exactly where they started.
    expect(kernel.leaks().details).toEqual(baseline.details);

    await kernel.dispose();

    // After teardown there is nothing outstanding at all, which is the same
    // claim stated in the form criterion 7 uses.
    expect(kernel.leaks().balanced).toBe(true);
  });
});
