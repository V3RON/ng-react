// **Acceptance criterion 4** (spec §15.4):
//
// > Editing a service implementation behind a `singleton` provider of
// > `payments` disposes the old instance (H4), re-activates only actual
// > consumers (H5), and mounted components re-render with the fresh instance
// > without any reload (H6).
//
// The provider is `payments/PaymentGateway`, `singleton`-scoped. Its consumer
// is `orders`, whose `OrderService` factory takes `PaymentGatewayToken` in
// `deps` — so this is the one place in the demo where H5's narrowing has
// something to narrow *to*, and where it differs from A4's declared-
// `dependsOn` cascade.
//
// ---
//
// ### "without any reload" is not asserted here, and cannot be
//
// There is no bundler in this test's path, so "no page reload" is not a
// proposition it can evaluate — a unit test that claimed it would be
// asserting the absence of something that was never possible. That half is
// discharged by measurement instead: #46/#47 ran a real Vite dev server
// against this demo and observed `hmr update` (not `page reload`) for
// twenty-five consecutive edits across `module.ts`, `providers.ts` and
// `lifecycle.ts`, each producing a `disposed → activating → ready` cycle.
// Recorded in spec §17 and in `docs/acceptance.md`, which marks this clause
// **Partial (measured, not tested)**.
//
// What *is* asserted here is the part a reload would have hidden: the old
// instance is gone, the fresh one is in place, and a component that was
// already mounted is now holding the fresh one.

import { describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AppKernel, createTestKernel, useService } from '@ng-react/kernel';
import type { ModuleDescriptor, TestKernel } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { PaymentDraftStoreToken, PaymentGatewayToken, PaymentsModule } from '@app/payments/contract';
import type { PaymentGateway } from '@app/payments/contract';
import { OrdersModule } from '@app/orders/contract';
import { descriptorFor } from './modules';

/** The real `auth` + `payments` + `orders`, with `orders` active and consuming the gateway. */
async function activeRuntime(): Promise<{ kernel: TestKernel; payments: ModuleDescriptor }> {
  const payments = descriptorFor(PaymentsModule);
  const kernel = createTestKernel({
    modules: [descriptorFor(AuthModule), payments, descriptorFor(OrdersModule)],
  });
  // Activating `orders` pulls `payments` up transitively (**A1**) *and*
  // resolves the gateway inside `OrderService`'s factory, which is what
  // records the H5 resolution-graph edge `orders → payments/PaymentGateway`.
  // Without this the cascade below would have nothing to cascade to and the
  // H5 assertion would pass vacuously.
  await kernel.activate(OrdersModule);
  return { kernel, payments };
}

/** One edit to a file behind `payments`' providers — see criterion 3 on why this is what an edit looks like. */
async function editPayments(kernel: TestKernel, payments: ModuleDescriptor): Promise<void> {
  await act(async () => {
    await kernel.hotReplace(PaymentsModule, { ...payments });
  });
}

/**
 * A mounted consumer of the edited provider, recording what it resolved on
 * each render.
 *
 * **R2/H6**: `useService` subscribes to the resolution epoch of the token's
 * *owning module*, so this component re-renders when `payments` is
 * re-activated and resolves again — with no HMR awareness of its own, which
 * is the whole of H6's claim.
 */
function GatewayProbe(props: { readonly seen: PaymentGateway[] }): ReactElement {
  const gateway = useService(PaymentGatewayToken);
  props.seen.push(gateway);
  return <p data-testid="gateway-renders">{String(props.seen.length)}</p>;
}

describe('acceptance criterion 4 — editing a service behind a singleton provider', () => {
  it('H4: the old instance is discarded and the next resolution constructs from the new factory', async () => {
    const { kernel, payments } = await activeRuntime();

    const before = kernel.get(PaymentGatewayToken);
    // The gateway's authorization ids embed a per-instance counter. Driving
    // it twice makes the *state* of the instance observable, which is what
    // turns "a different object" into "a genuinely new instance built by the
    // new factory" — an implementation that re-used the old closure would
    // hand back a fresh wrapper and keep counting from 3.
    expect((await before.authorize({ amountMinor: 100, currency: 'EUR' }, 'a')).id).toBe(
      'auth-orders-1',
    );
    expect((await before.authorize({ amountMinor: 100, currency: 'EUR' }, 'b')).id).toBe(
      'auth-orders-2',
    );

    await editPayments(kernel, payments);

    const after = kernel.get(PaymentGatewayToken);
    // **H4**: "every provider instance it registered is disposed and
    // discarded **regardless of scope** — including `singleton`". `singleton`
    // is the case the spec singles out, and it is the one under test.
    expect(after).not.toBe(before);
    expect((await after.authorize({ amountMinor: 100, currency: 'EUR' }, 'c')).id).toBe(
      'auth-orders-1',
    );

    // The old instance is still callable — nothing can stop a caller holding
    // a reference — but it is no longer *reachable through the container*,
    // which is what "discarded" means and all it can mean for an object with
    // no `dispose` method. Disposal proper (a provider that declares
    // `onDispose`, or an instance with `dispose()`) is pinned in the kernel's
    // own `src/kernel/hot-replace.test.ts`; `docs/acceptance.md` records that
    // this half rests on those unit tests rather than on the demo.
    expect(kernel.get(PaymentGatewayToken)).toBe(after);

    await kernel.dispose();
  });

  it('H3: the persistent draft store carries its state onto the new instance', async () => {
    const { kernel, payments } = await activeRuntime();

    // `payments`' `init` seeds exactly one draft, and **only into an empty
    // store**. So the discriminator has to be a count the seed cannot
    // reproduce: two. A discarded store comes back freshly seeded with one; a
    // preserved one comes back with two and `init`'s conditional does not
    // fire.
    const drafts = kernel.get(PaymentDraftStoreToken);
    expect(drafts.getState()).toHaveLength(1);
    drafts.setState((current) => [
      ...current,
      { reference: 'second-basket', amount: { amountMinor: 999, currency: 'EUR' as const } },
    ]);

    await editPayments(kernel, payments);

    // **H3/H4**: `persistent: true` is the sole exception to H4's "regardless
    // of scope", and this store is `module`-scoped — the half #39 left
    // untested. The instance is new (the state is transferred onto a freshly
    // constructed successor, ADR-3) and the state is the old one.
    const after = kernel.get(PaymentDraftStoreToken);
    expect(after).not.toBe(drafts);
    expect(after.getState().map((draft) => draft.reference)).toEqual([
      'demo-basket',
      'second-basket',
    ]);

    // The contrast: a real `deactivate` discards it, and the next activation
    // is seeded from scratch.
    await kernel.deactivate(PaymentsModule);
    await kernel.activate(PaymentsModule);
    expect(kernel.get(PaymentDraftStoreToken).getState().map((draft) => draft.reference)).toEqual([
      'demo-basket',
    ]);

    await kernel.dispose();
  });

  it('H5: only the actual consumer is re-activated — not every dependsOn dependent', async () => {
    const { kernel, payments } = await activeRuntime();
    const before = {
      auth: kernel.epochOf('auth'),
      payments: kernel.epochOf('payments'),
      orders: kernel.epochOf('orders'),
    };

    await editPayments(kernel, payments);

    // The edited module, plus `orders` — which really did build its own
    // service out of a `payments` instance. This is the case H5 exists for:
    // the *declared* graph would have given the same answer here, but the
    // resolution graph is what justifies it, and spec §17 records that the
    // consumer is the owner one level up the construction stack rather than
    // C4's requester.
    expect(kernel.epochOf('payments')).toBe(before.payments + 1);
    expect(kernel.epochOf('orders')).toBe(before.orders + 1);
    // **`auth` is the control.** It is `ready` and it is a `dependsOn`
    // dependency of `orders`, but nothing it owns was built out of a
    // `payments` instance, so H5 must leave it alone. Without this assertion
    // the two above would pass under a cascade that simply re-activated
    // everything.
    expect(kernel.epochOf('auth')).toBe(before.auth);
    expect(kernel.status(AuthModule)).toBe('ready');

    // …and the edge that justifies it is really in the graph. A dev kernel
    // records the true resolution graph; if this were empty, the assertions
    // above would be describing a cascade that happened for some other
    // reason.
    expect(kernel.inspect().resolutionGraph).toContainEqual({
      consumer: 'orders',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });

    await kernel.dispose();
  });

  it('H6: a mounted component re-renders and resolves the fresh instance', async () => {
    const { kernel, payments } = await activeRuntime();
    const seen: PaymentGateway[] = [];

    render(
      <AppKernel kernel={kernel}>
        <GatewayProbe seen={seen} />
      </AppKernel>,
    );

    const rendersBefore = seen.length;
    expect(rendersBefore).toBeGreaterThan(0);
    const resolvedBefore = seen.at(-1);
    expect(resolvedBefore).toBe(kernel.get(PaymentGatewayToken));

    await editPayments(kernel, payments);

    // **H6**: "each module re-activation bumps a kernel resolution epoch.
    // `useService` subscribes to the epoch of the provider's module, so
    // components holding a disposed instance re-render and resolve the fresh
    // one. Components need no HMR awareness of their own." Both halves:
    // it re-rendered, and what it now holds is the new instance.
    expect(seen.length).toBeGreaterThan(rendersBefore);
    expect(seen.at(-1)).not.toBe(resolvedBefore);
    expect(seen.at(-1)).toBe(kernel.get(PaymentGatewayToken));
    expect(screen.getByTestId('gateway-renders').textContent).toBe(String(seen.length));

    await kernel.dispose();
  });
});
