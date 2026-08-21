// **H6 — acceptance criterion 4.**
//
// "Editing a service implementation behind a `singleton` provider of
// `payments` disposes the old instance (H4) … and mounted components
// re-render with the fresh instance without any reload (H6)."
//
// `.test.tsx` → the **kernel-dom** project (jsdom + the React plugin), and
// everything renders under `<StrictMode>` like the rest of `src/react/`.
//
// The HMR update is driven through a **fake `HmrAdapter`** — a plain object
// literal (ADR-5). There is no Vite, no Metro and no bundler anywhere in
// this path, and `import.meta.hot` is never touched.

import { StrictMode, useRef } from 'react';
import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppKernel } from './context';
import { useService } from './hooks';
import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import type { HmrAdapter } from '../hmr/adapter';
import { defineStore } from '../hmr/persistent';
import type { Store } from '../hmr/persistent';
import { createKernel } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken } from '../token';

// ---------------------------------------------------------------------------
// Fixtures — acceptance criterion 4's own scenario: a `singleton` service
// behind a `payments` provider, plus a `persistent: true` cart store so the
// H3 half is visible from the component too.
// ---------------------------------------------------------------------------

interface PaymentGateway {
  /** Which generation of the edited file built this instance. */
  readonly generation: number;
  describe(): string;
}
const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');

interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}
const CartStoreToken = createToken<Store<readonly CartLine[]>>('payments/CartStore');

const paymentsRef = moduleRef('payments');

/** The `payments` descriptor as its `providers.ts` would be after `generation` edits. */
function paymentsModule(generation: number, disposed: number[]): ModuleDescriptor {
  return defineModule({
    id: paymentsRef,
    load: 'eager',
    providers: () => [
      provide(PaymentGatewayToken, {
        // C2's default scope. H4 disposes it anyway.
        scope: 'singleton',
        factory: (): PaymentGateway => ({
          generation,
          describe: () => `gateway v${generation}`,
        }),
        onDispose: (instance) => {
          disposed.push(instance.generation);
        },
      }),
      provide(CartStoreToken, {
        persistent: true,
        factory: () => defineStore<readonly CartLine[]>([]),
      }),
    ],
  });
}

function Tree(props: { kernel: Kernel; children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <AppKernel kernel={props.kernel}>{props.children}</AppKernel>
    </StrictMode>
  );
}

describe('H6: a mounted component picks up the fresh instance after a hot update', () => {
  it('H6/H4 (acceptance criterion 4): the old instance is disposed and the component re-renders holding the new one, with no remount', async () => {
    const disposed: number[] = [];
    // The fake bundler seam. `accept` stores the handler; firing it is what
    // "the developer saved payments/providers.ts" means in this test.
    const handlers = new Map<string, () => void>();
    const hmr: HmrAdapter = {
      enabled: true,
      accept: (id, onUpdate) => handlers.set(id, onUpdate),
      dispose: () => {},
    };

    const kernel = createKernel({ modules: [paymentsModule(1, disposed)], hmr, onFatal: () => {} });
    await kernel.whenStartupComplete();
    // `payments` is eager but non-critical, so `whenStartupComplete` does not
    // wait for it (A3). Await the activation the test depends on explicitly.
    await kernel.activate(paymentsRef);

    const seen: PaymentGateway[] = [];
    const mountCounts: number[] = [];

    function Checkout(): ReactNode {
      const gateway = useService(PaymentGatewayToken);
      // A ref survives a re-render and does not survive a remount, so a
      // constant value here is the machine check for "no remount".
      const mountId = useRef<number | undefined>(undefined);
      if (mountId.current === undefined) {
        mountId.current = mountCounts.length;
        mountCounts.push(mountId.current);
      }
      seen.push(gateway);
      return (
        <span data-testid="gateway">
          {gateway.describe()}#{mountId.current}
        </span>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Checkout />
      </Tree>,
    );

    const first = seen[0];
    expect(first?.generation).toBe(1);
    expect(screen.getByTestId('gateway').textContent).toBe('gateway v1#0');
    const rendersBefore = seen.length;
    const mountsBefore = mountCounts.length;

    // The whole HMR cycle, through the adapter. Nothing here is a kernel
    // internal and nothing here is a bundler.
    let pending: Promise<void> = Promise.resolve();
    hmr.accept('payments/providers.ts', () => {
      pending = kernel.hotReplace(paymentsRef, paymentsModule(2, disposed));
    });
    await act(async () => {
      handlers.get('payments/providers.ts')?.();
      await pending;
    });

    // **H4** — the old singleton was disposed, not left cached.
    expect(disposed).toEqual([1]);

    // **H6** — the component re-rendered…
    expect(seen.length).toBeGreaterThan(rendersBefore);
    // …and it now holds a *different object*, from the new factory. This is
    // the assertion the criterion is actually about: a re-render count alone
    // would pass even if `useService` handed back the disposed instance.
    const latest = seen[seen.length - 1];
    expect(latest).not.toBe(first);
    expect(latest?.generation).toBe(2);
    expect(screen.getByTestId('gateway').textContent).toBe('gateway v2#0');

    // …without any remount (the mount id is still 0) and without a reload.
    expect(mountCounts.length).toBe(mountsBefore);
  });

  it('H3/H6: a persistent store keeps its state across the update, and the component sees it', async () => {
    const disposed: number[] = [];
    const kernel = createKernel({ modules: [paymentsModule(1, disposed)], onFatal: () => {} });
    await kernel.whenStartupComplete();
    // `payments` is eager but non-critical, so `whenStartupComplete` does not
    // wait for it (A3). Await the activation the test depends on explicitly.
    await kernel.activate(paymentsRef);

    function Cart(): ReactNode {
      const store = useService(CartStoreToken);
      const gateway = useService(PaymentGatewayToken);
      return (
        <span data-testid="cart">
          {gateway.describe()}/{store.getState().length}
        </span>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Cart />
      </Tree>,
    );
    expect(screen.getByTestId('cart').textContent).toBe('gateway v1/0');

    act(() => {
      kernel.get(CartStoreToken).setState([{ sku: 'DESK-1', quantity: 2 }]);
    });

    await act(async () => {
      await kernel.hotReplace(paymentsRef, paymentsModule(2, disposed));
    });

    // The gateway is a new object (H4); the cart's *state* survived (H3),
    // even though its instance is new too.
    expect(screen.getByTestId('cart').textContent).toBe('gateway v2/1');
    expect(disposed).toEqual([1]);
  });

  it('H1: a component that resolves nothing is untouched by a hot update — no kernel-driven re-render', async () => {
    const kernel = createKernel({ modules: [paymentsModule(1, [])], onFatal: () => {} });
    await kernel.whenStartupComplete();
    // `payments` is eager but non-critical, so `whenStartupComplete` does not
    // wait for it (A3). Await the activation the test depends on explicitly.
    await kernel.activate(paymentsRef);

    let plainRenders = 0;
    function PlainScreen(): ReactNode {
      plainRenders += 1;
      return <span data-testid="plain">no services here</span>;
    }

    render(
      <Tree kernel={kernel}>
        <PlainScreen />
      </Tree>,
    );
    const before = plainRenders;

    await act(async () => {
      await kernel.hotReplace(paymentsRef, paymentsModule(2, []));
    });

    // H1: screens and ordinary components rely on React Fast Refresh
    // untouched. The kernel has no registry of mounted components and no way
    // to re-render one that is not subscribed to an epoch — which is exactly
    // why there is no component-level HMR handling to test.
    expect(plainRenders).toBe(before);
    expect(screen.getByTestId('plain').textContent).toBe('no services here');
  });
});
