// `.test.tsx` → the **kernel-dom** project (jsdom + the React plugin), and
// every case renders under `<StrictMode>` (AGENTS.md §3, and R1/R2's
// concurrent-rendering requirement).

import { StrictMode, startTransition, useState } from 'react';
import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppKernel, ModuleScope } from './context';
import { useModule, useService, useServiceAll, useServiceOptional } from './hooks';
import { defineModule } from '../define-module';
import { ResolutionError } from '../errors';
import { createKernel } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import { createToken, MODULE_ID } from '../token';

// ---------------------------------------------------------------------------
// Fixtures. Deliberately *differently* typed services and tokens (AGENTS.md
// §9): a clock, a cart, a feature-flag reader, a route config. Nothing here
// is `Token<unknown>`.
// ---------------------------------------------------------------------------

const platformRef = moduleRef('platform');
const ordersRef = moduleRef('orders');
const billingRef = moduleRef('billing');
const paymentsRef = moduleRef('payments');
const reportingRef = moduleRef('reporting');

/** `singleton` (C2): one instance for the app lifetime. */
interface Clock {
  readonly serial: number;
  now(): number;
}
const ClockToken = createToken<Clock>('platform/Clock');

/** `transient` (C2): a new instance per resolution — the R2 warning case. */
interface Correlation {
  readonly id: string;
}
const CorrelationToken = createToken<Correlation>('platform/Correlation');

/** `module` (C2): one instance per owning module activation, so a
 *  deactivate/activate round trip produces a genuinely different object —
 *  which is the H6 story. */
interface Cart {
  readonly serial: number;
  readonly ownerId: string;
  add(sku: string): number;
}
const CartToken = createToken<Cart>('orders/Cart');

/** Never provided by anyone: the C8 case. */
interface PaymentGateway {
  charge(amountMinor: number): Promise<string>;
}
const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');

/** Depends on the unprovided gateway, so C8 reports a two-hop chain. */
interface OrderService {
  place(sku: string): string;
}
const OrderServiceToken = createToken<OrderService>('orders/OrderService');

/** `contribute` (C5): the R3 collection. Spec §12 R3's own example. */
interface RouteConfig {
  readonly path: string;
  readonly title: string;
}
const RouteConfigToken = createToken<RouteConfig>('navigation/RouteConfig');

let clockSerial = 0;
let cartSerial = 0;
let correlationSerial = 0;

function buildModules(options: { reportingInitFails: () => boolean }) {
  const platform = defineModule({
    id: platformRef,
    providers: () => [
      provide(ClockToken, {
        scope: 'singleton',
        factory: (): Clock => ({ serial: ++clockSerial, now: () => 1_700_000_000 }),
      }),
      provide(CorrelationToken, {
        scope: 'transient',
        factory: (): Correlation => ({ id: `c${++correlationSerial}` }),
      }),
    ],
  });

  const orders = defineModule({
    id: ordersRef,
    dependsOn: [platformRef],
    providers: () => [
      provide(CartToken, {
        scope: 'module',
        deps: [MODULE_ID],
        factory: (ownerId: string): Cart => ({
          serial: ++cartSerial,
          ownerId,
          add: () => 1,
        }),
      }),
      provide(OrderServiceToken, {
        scope: 'singleton',
        deps: [PaymentGatewayToken],
        factory: (gateway: PaymentGateway): OrderService => ({
          place: () => String(gateway),
        }),
      }),
      contribute(RouteConfigToken, {
        factory: (): RouteConfig => ({ path: '/orders', title: 'Orders' }),
      }),
    ],
  });

  const billing = defineModule({
    id: billingRef,
    load: 'lazy',
    providers: () => [
      contribute(RouteConfigToken, {
        factory: (): RouteConfig => ({ path: '/billing', title: 'Billing' }),
      }),
    ],
  });

  // Registered but never activated and never in anyone's `dependsOn` — the
  // module whose *existence* makes C8's suggestion fire.
  const payments = defineModule({ id: paymentsRef, load: 'lazy' });

  // F3: fails its first activation, so its contributions are registered and
  // then withdrawn by quarantine; `retry` makes it succeed.
  const reporting = defineModule({
    id: reportingRef,
    load: 'lazy',
    providers: () => [
      contribute(RouteConfigToken, {
        factory: (): RouteConfig => ({ path: '/reporting', title: 'Reporting' }),
      }),
    ],
    init: () => {
      if (options.reportingInitFails()) {
        throw new Error('reporting init blew up');
      }
    },
  });

  return [platform, orders, billing, payments, reporting];
}

async function startKernel(
  options: { reportingInitFails?: () => boolean } = {},
): Promise<Kernel> {
  const kernel = createKernel({
    modules: buildModules({ reportingInitFails: options.reportingInitFails ?? (() => false) }),
    onFatal: () => {},
  });
  await kernel.whenStartupComplete();
  await kernel.activate(ordersRef);
  return kernel;
}

function Tree(props: { kernel: Kernel; children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <AppKernel kernel={props.kernel}>{props.children}</AppKernel>
    </StrictMode>
  );
}

/** A parent that exposes a "render again" button, for the referential
 *  stability and identical-reference checks. */
function Rerenderer(props: { children: (tick: number) => ReactNode }): ReactNode {
  const [tick, setTick] = useState(0);
  // `children` is a *function*, not an element: a stable `ReactNode` child
  // would let React bail out of re-rendering the subtree entirely, and the
  // referential-stability assertions below would then prove nothing.
  return (
    <>
      <button data-testid="rerender" onClick={() => setTick((value) => value + 1)}>
        {tick}
      </button>
      {props.children(tick)}
    </>
  );
}

function clickRerender(): void {
  act(() => {
    screen.getByTestId('rerender').click();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('useService (R2)', () => {
  it('R2: a singleton is the identical instance across renders', async () => {
    const kernel = await startKernel();
    const seen: Clock[] = [];
    function Probe(): ReactNode {
      const clock = useService(ClockToken);
      seen.push(clock);
      return <span data-testid="serial">{clock.serial}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>{() => <Probe />}</Rerenderer>
      </Tree>,
    );
    clickRerender();
    clickRerender();

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((clock) => Object.is(clock, seen[0]))).toBe(true);
    expect(screen.getByTestId('serial').textContent).toBe(String(seen[0]?.serial));
  });

  it('R2: a module-scoped instance is the identical instance across renders', async () => {
    const kernel = await startKernel();
    const seen: Cart[] = [];
    function Probe(): ReactNode {
      const cart = useService(CartToken);
      seen.push(cart);
      return <span data-testid="owner">{cart.ownerId}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>
          {() => (
            <ModuleScope module={ordersRef}>
              <Probe />
            </ModuleScope>
          )}
        </Rerenderer>
      </Tree>,
    );
    clickRerender();
    clickRerender();

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((cart) => Object.is(cart, seen[0]))).toBe(true);
    expect(screen.getByTestId('owner').textContent).toBe('orders');
  });

  it('R2/C4: the resolution context is the enclosing <ModuleScope>, not the provider owner', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      return <span data-testid="module-id">{useService(MODULE_ID)}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <ModuleScope module={billingRef}>
          <Probe />
        </ModuleScope>
      </Tree>,
    );

    expect(screen.getByTestId('module-id').textContent).toBe('billing');
  });

  it('R2/C8: a failed resolution throws the container error unchanged', async () => {
    const kernel = await startKernel();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe(): ReactNode {
      return <span>{useService(OrderServiceToken).place('sku')}</span>;
    }

    let thrown: unknown;
    try {
      render(
        <Tree kernel={kernel}>
          <ModuleScope module={ordersRef}>
            <Probe />
          </ModuleScope>
        </Tree>,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResolutionError);
    expect((thrown as ResolutionError).message).toBe(
      'Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. ' +
        "'payments' is registered but not listed in dependsOn of 'orders'.",
    );
  });

  it('R2: resolving a transient warns exactly once per token, however many consumers render', async () => {
    const kernel = await startKernel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    function Probe(props: { testId: string }): ReactNode {
      // eslint-disable-next-line ng-react-modules/no-transient-in-component -- resolving a transient at component top level is the behaviour under test (R2).
      return <span data-testid={props.testId}>{useService(CorrelationToken).id}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>
          {() => (
            <>
              <Probe testId="a" />
              <Probe testId="b" />
            </>
          )}
        </Rerenderer>
      </Tree>,
    );
    clickRerender();
    clickRerender();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "useService(platform/Correlation) resolves a 'transient' provider (owned by 'platform'): " +
        'a new instance is constructed on every resolution, so nothing about it is stable ' +
        'across renders and the container will never dispose it (C2, C7). ' +
        'Resolve transients inside an event handler or an effect instead (R2). ' +
        'The ng-react-modules/no-transient-in-component lint rule catches this statically only when ' +
        'the provider is declared in the same file; this warning covers the rest.',
    );
  });

  it('R2/R4: the transient warn-once state is per <AppKernel>, not global', async () => {
    const first = await startKernel();
    const second = await startKernel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    function Probe(): ReactNode {
      // eslint-disable-next-line ng-react-modules/no-transient-in-component -- resolving a transient at component top level is the behaviour under test (R2).
      return <span>{useService(CorrelationToken).id}</span>;
    }

    const view = render(
      <Tree kernel={first}>
        <Probe />
      </Tree>,
    );
    expect(warn).toHaveBeenCalledTimes(1);

    // A second, isolated kernel — the shape #18's `createTestKernel` builds —
    // must warn again. A module-level warn-once `Set` would suppress this,
    // and would leak across whole test files.
    view.rerender(
      <Tree kernel={second}>
        <Probe />
      </Tree>,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('R2: a non-transient provider never warns', async () => {
    const kernel = await startKernel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    function Probe(): ReactNode {
      return <span>{useService(ClockToken).serial}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('useServiceOptional (R2)', () => {
  it('R2: yields undefined for a token nothing provides, instead of the C8 error', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      const gateway = useServiceOptional(PaymentGatewayToken);
      return <span data-testid="gateway">{gateway === undefined ? 'none' : 'present'}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    expect(screen.getByTestId('gateway').textContent).toBe('none');
  });

  it('R2: yields the instance when the token is provided, stably across renders', async () => {
    const kernel = await startKernel();
    const seen: (Clock | undefined)[] = [];
    function Probe(): ReactNode {
      const clock = useServiceOptional(ClockToken);
      seen.push(clock);
      return <span data-testid="serial">{clock?.serial ?? 'none'}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>{() => <Probe />}</Rerenderer>
      </Tree>,
    );
    clickRerender();

    expect(seen[0]).toBeDefined();
    expect(seen.every((clock) => Object.is(clock, seen[0]))).toBe(true);
  });

  it('ADR-2: MODULE_ID is optional-resolvable and yields the app-root id', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      return <span data-testid="module-id">{useServiceOptional(MODULE_ID) ?? 'undefined'}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    expect(screen.getByTestId('module-id').textContent).toBe('app');
  });
});

describe('resolution epochs (H6)', () => {
  it('H6: a manual bumpEpoch re-renders and re-resolves the fresh instance', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      return <span data-testid="serial">{String(useService(CartToken).serial)}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <ModuleScope module={ordersRef}>
          <Probe />
        </ModuleScope>
      </Tree>,
    );
    const before = screen.getByTestId('serial').textContent;

    // An HMR re-activation (H4/H5): the old module-scoped instance is
    // disposed and a fresh one will be built on next resolution.
    await act(async () => {
      await kernel.deactivate(ordersRef);
      await kernel.activate(ordersRef);
    });

    // Without the epoch, the component is still holding the disposed
    // instance — which is precisely the defect H6 exists to fix.
    expect(screen.getByTestId('serial').textContent).toBe(before);

    act(() => {
      kernel.bumpEpoch('orders');
    });

    expect(screen.getByTestId('serial').textContent).not.toBe(before);
  });

  it('H6: a bump of an unrelated module does not change the resolved instance', async () => {
    const kernel = await startKernel();
    const seen: Clock[] = [];
    function Probe(): ReactNode {
      const clock = useService(ClockToken);
      seen.push(clock);
      return <span>{clock.serial}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    const count = seen.length;

    act(() => {
      kernel.bumpEpoch('orders');
    });

    // `ClockToken` is owned by `platform`, so nothing here subscribes to
    // `orders`' epoch: no re-render at all.
    expect(seen.length).toBe(count);
  });

  it('H6: mounting and unmounting leaves no epoch subscriber behind (StrictMode symmetry)', async () => {
    const kernel = await startKernel();
    let renders = 0;
    function Probe(): ReactNode {
      renders += 1;
      return <span>{useService(ClockToken).serial}</span>;
    }

    const view = render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    view.unmount();
    const after = renders;

    act(() => {
      kernel.bumpEpoch('platform');
    });

    expect(renders).toBe(after);
  });
});

describe('useServiceAll (R3, C5)', () => {
  function Routes(props: { testId: string }): ReactNode {
    const routes = useServiceAll(RouteConfigToken);
    return <span data-testid={props.testId}>{routes.map((route) => route.path).join(',')}</span>;
  }

  it('R3/C5: renders the collection in module topological order', async () => {
    const kernel = await startKernel();

    render(
      <Tree kernel={kernel}>
        <Routes testId="routes" />
      </Tree>,
    );

    expect(screen.getByTestId('routes').textContent).toBe('/orders');
  });

  it('R3/C5: re-renders when a module activates and again when it is disposed', async () => {
    const kernel = await startKernel();

    render(
      <Tree kernel={kernel}>
        <Routes testId="routes" />
      </Tree>,
    );
    expect(screen.getByTestId('routes').textContent).toBe('/orders');

    await act(async () => {
      await kernel.activate(billingRef);
    });
    expect(screen.getByTestId('routes').textContent).toBe('/billing,/orders');

    await act(async () => {
      await kernel.deactivate(billingRef);
    });
    expect(screen.getByTestId('routes').textContent).toBe('/orders');
  });

  it('R3/F3: a quarantined module contributes nothing, and its retry brings the routes back', async () => {
    let failing = true;
    const kernel = await startKernel({ reportingInitFails: () => failing });

    render(
      <Tree kernel={kernel}>
        <Routes testId="routes" />
      </Tree>,
    );

    await act(async () => {
      await kernel.activate(reportingRef).catch(() => {});
    });
    // Its providers were registered before `init` ran; quarantine withdrew
    // them again (F3), so the collection must not carry the route.
    expect(screen.getByTestId('routes').textContent).toBe('/orders');
    expect(kernel.status(reportingRef)).toBe('failed');

    failing = false;
    await act(async () => {
      await kernel.retry(reportingRef);
    });
    expect(screen.getByTestId('routes').textContent).toBe('/orders,/reporting');
  });

  it('R3: an unchanged collection returns the identical array reference across renders', async () => {
    const kernel = await startKernel();
    const seen: (readonly RouteConfig[])[] = [];
    function Probe(): ReactNode {
      const routes = useServiceAll(RouteConfigToken);
      seen.push(routes);
      return <span>{routes.length}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>{() => <Probe />}</Rerenderer>
      </Tree>,
    );
    clickRerender();
    clickRerender();

    expect(seen.length).toBeGreaterThan(2);
    // The single assertion that catches the `getSnapshot` infinite-loop bug:
    // a fresh array per call would fail here (and hang the suite outright).
    expect(seen.every((routes) => Object.is(routes, seen[0]))).toBe(true);
  });

  it('R3: a changed collection returns a new reference, and the old items keep their identity', async () => {
    const kernel = await startKernel();
    const seen: (readonly RouteConfig[])[] = [];
    function Probe(): ReactNode {
      const routes = useServiceAll(RouteConfigToken);
      seen.push(routes);
      return <span>{routes.length}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    const before = seen[seen.length - 1];

    await act(async () => {
      await kernel.activate(billingRef);
    });
    const after = seen[seen.length - 1];

    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
    // C5 ordering plus C2 caching: the `orders` contribution is the same
    // object it was before `billing` joined (and `billing` sorts ahead of
    // it in module topological order).
    expect(after?.find((route) => route.path === '/orders')).toBe(before?.[0]);
  });

  it('R3: unmounting removes the collection subscription (StrictMode symmetry)', async () => {
    const kernel = await startKernel();
    let renders = 0;
    function Probe(): ReactNode {
      renders += 1;
      return <span>{useServiceAll(RouteConfigToken).length}</span>;
    }

    const view = render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    view.unmount();
    const after = renders;

    await act(async () => {
      await kernel.activate(billingRef);
    });

    expect(renders).toBe(after);
  });

  it('R3: no tearing — every consumer of the token sees the same snapshot in every commit', async () => {
    const kernel = await startKernel();
    const sequences: Record<string, string[]> = { a: [], b: [], c: [] };
    function Probe(props: { name: 'a' | 'b' | 'c' }): ReactNode {
      const routes = useServiceAll(RouteConfigToken);
      const value = routes.map((route) => route.path).join(',');
      const sequence = sequences[props.name];
      if (sequence !== undefined && sequence[sequence.length - 1] !== value) {
        sequence.push(value);
      }
      return <span data-testid={props.name}>{value}</span>;
    }

    function Harness(): ReactNode {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button
            data-testid="transition"
            onClick={() => {
              startTransition(() => {
                setTick((value) => value + 1);
              });
            }}
          >
            {tick}
          </button>
          <Probe name="a" />
          <Probe name="b" />
          <Probe name="c" />
        </>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Harness />
      </Tree>,
    );

    // A store mutation racing a transition-driven re-render: the case
    // `useSyncExternalStore` exists for.
    await act(async () => {
      screen.getByTestId('transition').click();
      await kernel.activate(billingRef);
    });

    expect(screen.getByTestId('a').textContent).toBe('/billing,/orders');
    expect(sequences['b']).toEqual(sequences['a']);
    expect(sequences['c']).toEqual(sequences['a']);
  });
});

describe('useModule (R3, F3)', () => {
  it('R3: does not trigger activation — a lazy module stays registered', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      return <span data-testid="status">{useModule(billingRef).status}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    expect(screen.getByTestId('status').textContent).toBe('registered');
    expect(kernel.status(billingRef)).toBe('registered');
  });

  it('R3/A2: reflects status transitions', async () => {
    const kernel = await startKernel();
    const statuses: string[] = [];
    function Probe(): ReactNode {
      const { status } = useModule(billingRef);
      if (statuses[statuses.length - 1] !== status) {
        statuses.push(status);
      }
      return <span data-testid="status">{status}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    await act(async () => {
      await kernel.activate(billingRef);
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');

    await act(async () => {
      await kernel.deactivate(billingRef);
    });
    expect(screen.getByTestId('status').textContent).toBe('disposed');
    expect(statuses).toEqual(['registered', 'activating', 'ready', 'disposed']);
  });

  it('R3: retry is referentially stable across renders (Object.is)', async () => {
    const kernel = await startKernel();
    const retries: (() => void)[] = [];
    function Probe(): ReactNode {
      const { retry, status } = useModule(billingRef);
      retries.push(retry);
      return <span>{status}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Rerenderer>{() => <Probe />}</Rerenderer>
      </Tree>,
    );
    clickRerender();
    clickRerender();
    await act(async () => {
      await kernel.activate(billingRef);
    });

    expect(retries.length).toBeGreaterThan(3);
    expect(retries.every((retry) => Object.is(retry, retries[0]))).toBe(true);
  });

  it('R3/F1: surfaces the retained failure of a quarantined module', async () => {
    let failing = true;
    const kernel = await startKernel({ reportingInitFails: () => failing });
    function Probe(): ReactNode {
      const { status, error } = useModule(reportingRef);
      return (
        <span data-testid="state">
          {status}:{error === undefined ? 'no-error' : (error as { message: string }).message}
        </span>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    expect(screen.getByTestId('state').textContent).toBe('registered:no-error');

    await act(async () => {
      await kernel.activate(reportingRef).catch(() => {});
    });
    expect(screen.getByTestId('state').textContent).toMatch(/^failed:/);
    expect(screen.getByTestId('state').textContent).toContain('reporting init blew up');

    failing = false;
    await act(async () => {
      await kernel.retry(reportingRef);
    });
    expect(screen.getByTestId('state').textContent).toBe('ready:no-error');
  });

  it('R3/F3: retry() from the returned object drives kernel.retry', async () => {
    let failing = true;
    const kernel = await startKernel({ reportingInitFails: () => failing });
    const retrySpy = vi.spyOn(kernel, 'retry');
    function Probe(): ReactNode {
      const { status, retry } = useModule(reportingRef);
      return (
        <button data-testid="retry" onClick={retry}>
          {status}
        </button>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    await act(async () => {
      await kernel.activate(reportingRef).catch(() => {});
    });
    expect(screen.getByTestId('retry').textContent).toBe('failed');

    failing = false;
    await act(async () => {
      screen.getByTestId('retry').click();
      await Promise.resolve();
    });

    expect(retrySpy).toHaveBeenCalledWith(reportingRef);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('retry').textContent).toBe('ready');
  });

  it('R3: a rejected retry does not become an unhandled rejection', async () => {
    const kernel = await startKernel({ reportingInitFails: () => true });
    function Probe(): ReactNode {
      const { status, retry } = useModule(reportingRef);
      return (
        <button data-testid="retry" onClick={retry}>
          {status}
        </button>
      );
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    await act(async () => {
      await kernel.activate(reportingRef).catch(() => {});
    });

    await act(async () => {
      screen.getByTestId('retry').click();
      await Promise.resolve();
    });

    expect(screen.getByTestId('retry').textContent).toBe('failed');
  });
});
