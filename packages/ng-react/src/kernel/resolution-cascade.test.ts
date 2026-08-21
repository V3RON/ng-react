// **H5 / A4 / G3** — the dev resolution graph and the consumer cascade,
// end to end through the kernel.
//
// `.test.ts` → the **kernel** project (node): no bundler, no renderer. The
// React half — that a `useService` outside any `<ModuleScope>` produces an
// `'app'`-attributed edge — lives in `src/react/resolution-graph.test.tsx`,
// because attributing it needs a renderer and nothing else here does.
//
// The claim this file exists to pin is H5's, verbatim: "the HMR cascade
// disposes and re-activates only modules that actually consumed a resolved
// instance from the edited module, not all `dependsOn` dependents.
// Production deactivation (A4) continues to cascade by declared
// `dependsOn`". Two cascades, deliberately different, over one module graph.

import { describe, expect, it, vi } from 'vitest';

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import type { HmrAdapter } from '../hmr/adapter';
import { ResolutionGraph } from '../hmr/resolution-graph';
import { moduleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import { createToken } from '../token';
import type { ErrorSink } from '../types';
import { ErrorSinkToken } from './failure';
import { createKernel } from './kernel';
import type { Kernel } from './kernel';

// ---------------------------------------------------------------------------
// Fixtures. ADR-10 / AGENTS.md §9: four *differently* typed tokens — a
// record, an interface with a method, a function type, and a tuple-shaped
// value object — so nothing here is provable only because everything is the
// same shape.
// ---------------------------------------------------------------------------

interface Session {
  readonly userId: string;
  readonly expiresAtMs: number;
}
const SessionToken = createToken<Session>('auth/Session');

interface PaymentGateway {
  readonly generation: number;
  charge(amountMinor: number): string;
}
const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');

interface OrderService {
  place(sku: string): string;
}
const OrderServiceToken = createToken<OrderService>('orders/OrderService');

/** A bare function type, provided as a value — nothing else here is callable. */
type MoneyFormatter = (amountMinor: number) => string;
const MoneyFormatterToken = createToken<MoneyFormatter>('reporting/MoneyFormatter');

const authRef = moduleRef('auth');
const paymentsRef = moduleRef('payments');
const ordersRef = moduleRef('orders');
const reportingRef = moduleRef('reporting');

/** Records lifecycle steps so a cascade's membership is directly observable. */
type Trace = string[];

function authModule(trace: Trace): ModuleDescriptor {
  return defineModule({
    id: authRef,
    load: 'eager',
    critical: true,
    providers: () => [
      provide(SessionToken, {
        factory: (): Session => ({ userId: 'u-1', expiresAtMs: 1_700_000_000_000 }),
      }),
    ],
    init: () => {
      trace.push('auth:init');
    },
    dispose: () => {
      trace.push('auth:dispose');
    },
  });
}

function paymentsModule(options: { readonly generation: number; readonly trace: Trace }): ModuleDescriptor {
  const { generation, trace } = options;
  return defineModule({
    id: paymentsRef,
    dependsOn: [authRef],
    providers: () => [
      provide(PaymentGatewayToken, {
        deps: [SessionToken],
        factory: (session: Session): PaymentGateway => ({
          generation,
          charge: (amountMinor) => `gen${String(generation)}:${session.userId}:${String(amountMinor)}`,
        }),
      }),
    ],
    init: () => {
      trace.push(`payments:init:${String(generation)}`);
    },
    dispose: () => {
      trace.push(`payments:dispose:${String(generation)}`);
    },
  });
}

/** A **true consumer**: its own provider is built out of a `payments` instance. */
function ordersModule(trace: Trace): ModuleDescriptor {
  return defineModule({
    id: ordersRef,
    dependsOn: [paymentsRef],
    providers: () => [
      provide(OrderServiceToken, {
        deps: [PaymentGatewayToken],
        factory: (gateway: PaymentGateway): OrderService => ({
          place: (sku) => `${sku}@${gateway.charge(100)}`,
        }),
      }),
    ],
    init: () => {
      trace.push('orders:init');
    },
    dispose: () => {
      trace.push('orders:dispose');
    },
  });
}

/**
 * **The module H5 exists for.** It *declares* `dependsOn: [payments]` — a
 * perfectly ordinary thing to do, e.g. because it needs `payments` activated
 * before it and may resolve a gateway later — but it never resolves a
 * `payments` token, so it holds no `payments`-derived instance and an edit
 * to `payments` cannot invalidate anything it owns.
 */
function reportingModule(trace: Trace): ModuleDescriptor {
  return defineModule({
    id: reportingRef,
    dependsOn: [paymentsRef],
    providers: () => [
      provide(MoneyFormatterToken, {
        factory: (): MoneyFormatter => (amountMinor) => `${(amountMinor / 100).toFixed(2)} EUR`,
      }),
    ],
    init: () => {
      trace.push('reporting:init');
    },
    dispose: () => {
      trace.push('reporting:dispose');
    },
  });
}

async function settled(kernel: Kernel): Promise<void> {
  await kernel.whenStartupComplete();
}

/**
 * Brings up all four modules and makes `orders` a true consumer by resolving
 * its service (C3: nothing is constructed until it is asked for).
 */
async function bootAll(trace: Trace, options: { readonly dev?: boolean } = {}): Promise<Kernel> {
  const kernel = createKernel({
    modules: [
      authModule(trace),
      paymentsModule({ generation: 1, trace }),
      ordersModule(trace),
      reportingModule(trace),
    ],
    ...(options.dev === undefined ? {} : { dev: options.dev }),
  });
  await settled(kernel);
  await kernel.activate(ordersRef);
  await kernel.activate(reportingRef);
  expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@gen1:u-1:100');
  return kernel;
}

describe('H5 — the HMR cascade follows the resolution graph', () => {
  it('H5: hotReplace re-activates a true consumer and skips a declared-but-never-resolved dependent', async () => {
    const trace: Trace = [];
    const kernel = await bootAll(trace);
    expect(kernel.status(reportingRef)).toBe('ready');

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    // `orders` consumed a gateway, so it is disposed and comes back.
    // `reporting` declares `dependsOn: [payments]` and resolved nothing from
    // it, so it is left running — that is the whole of H5.
    expect(trace).toEqual([
      'orders:dispose',
      'payments:dispose:1',
      'payments:init:2',
      'orders:init',
    ]);
    expect(kernel.epochOf('orders')).toBe(1);
    expect(kernel.epochOf('reporting')).toBe(0);
    // …and it is still holding its own live instance, not a disposed one.
    expect(kernel.get(MoneyFormatterToken)(2599)).toBe('25.99 EUR');
    // The consumer really did re-resolve against the new generation (H2/H4).
    expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@gen2:u-1:100');
  });

  it('A4: deactivate still cascades by declared dependsOn, in dev, including that same dependent', async () => {
    const trace: Trace = [];
    const kernel = await bootAll(trace);

    trace.length = 0;
    await kernel.deactivate(paymentsRef);

    // The *same* module the H5 cascade skipped is torn down here. A4 is
    // production deactivation and cascades by declaration, and the
    // resolution graph is "never load-bearing for correctness" — so a dev
    // kernel must not quietly narrow this one too.
    expect(trace).toContain('reporting:dispose');
    expect(trace).toEqual(['reporting:dispose', 'orders:dispose', 'payments:dispose:1']);
    expect(kernel.status(reportingRef)).toBe('disposed');
    expect(kernel.status(ordersRef)).toBe('disposed');
    expect(kernel.status(paymentsRef)).toBe('disposed');
  });

  it('H5: a transitive consumer is cascaded even though it never named the edited module', async () => {
    const trace: Trace = [];
    const kernel = await bootAll(trace);

    trace.length = 0;
    // `orders` never declares `dependsOn: [auth]`, but its `OrderService`
    // was built from a gateway that was built from a session. Editing `auth`
    // therefore invalidates it, two consumption hops away.
    await kernel.hotReplace(authRef, authModule(trace));

    expect(trace).toEqual([
      'orders:dispose',
      'payments:dispose:1',
      'auth:dispose',
      'auth:init',
      'payments:init:1',
      'orders:init',
    ]);
    expect(kernel.epochOf('reporting')).toBe(0);
  });

  it('H5: an edge is invalidated when its consumer is disposed and re-recorded on re-activation', async () => {
    const trace: Trace = [];
    const kernel = await bootAll(trace);

    const before = kernel.inspect().resolutionGraph ?? [];
    expect(before).toContainEqual({
      consumer: 'orders',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });

    // Replace `orders` with a generation that resolves a *different* token
    // from a *different* module and never touches `payments` again.
    const ordersV2 = defineModule({
      id: ordersRef,
      dependsOn: [paymentsRef],
      providers: () => [
        provide(OrderServiceToken, {
          deps: [SessionToken],
          factory: (session: Session): OrderService => ({
            place: (sku) => `${sku}@offline:${session.userId}`,
          }),
        }),
      ],
      init: () => {
        trace.push('orders:init:2');
      },
    });
    await kernel.hotReplace(ordersRef, ordersV2);
    // C3: the new provider is lazy — resolve it so the new edge exists.
    expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@offline:u-1');

    const after = kernel.inspect().resolutionGraph ?? [];
    // The assertion that matters is the *absence*: a graph that only ever
    // grows over-cascades, so editing `payments` would still tear `orders`
    // down for an instance it no longer holds.
    expect(after).not.toContainEqual({
      consumer: 'orders',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });
    expect(after).toContainEqual({ consumer: 'orders', owner: 'auth', token: 'auth/Session' });

    // And the narrowed cascade follows: `payments` no longer reaches `orders`.
    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 3, trace }));
    expect(trace).toEqual(['payments:dispose:1', 'payments:init:3']);
    expect(kernel.epochOf('orders')).toBe(1);
  });

  it("H5/ADR-2: an 'app'-attributed edge is recorded and never enters the cascade", async () => {
    const trace: Trace = [];
    const invalidated: string[] = [];
    // ADR-5: a plain fake, not a bundler. `invalidate` is the only member
    // the kernel calls; the other three exist because the interface has them.
    const hmr: HmrAdapter = {
      enabled: true,
      accept: () => {},
      dispose: () => {},
      invalidate: (moduleId, reason) => {
        invalidated.push(`${moduleId}:${String(reason)}`);
      },
    };
    const reports: { readonly moduleId: string }[] = [];
    const kernel = createKernel({
      modules: [
        authModule(trace),
        paymentsModule({ generation: 1, trace }),
        defineModule({
          id: moduleRef('telemetry'),
          load: 'eager',
          critical: false,
          providers: () => [
            contribute(ErrorSinkToken, {
              factory: (): ErrorSink => ({
                report: (_error, info) => {
                  reports.push({ moduleId: info.moduleId });
                },
              }),
            }),
          ],
        }),
      ],
      hmr,
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    // ADR-2: a resolution started outside any module. Exactly what a
    // `useService` rendered outside any `<ModuleScope>` produces (R2).
    expect(kernel.get(PaymentGatewayToken).charge(500)).toBe('gen1:u-1:500');

    expect(kernel.inspect().resolutionGraph).toContainEqual({
      consumer: 'app',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });

    const appEpochBumps: string[] = [];
    kernel.subscribeEpoch('app', () => appEpochBumps.push('app'));

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    // `'app'` is not a module: if it entered the cascade the kernel would
    // try to dispose and re-activate it, `activateById('app')` would throw
    // an `InvalidDescriptorError`, and all three of these would fire.
    expect(trace).toEqual(['payments:dispose:1', 'payments:init:2']);
    expect(appEpochBumps).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(reports).toEqual([]);
  });
});

describe('H5/G3 — the graph is dev-only', () => {
  it('G3: inspect() carries resolutionGraph in dev and omits the key entirely in production', async () => {
    const devTrace: Trace = [];
    const devKernel = await bootAll(devTrace, { dev: true });
    const devInspection = devKernel.inspect();
    expect('resolutionGraph' in devInspection).toBe(true);
    expect(devInspection.resolutionGraph).toContainEqual({
      consumer: 'orders',
      owner: 'payments',
      token: 'payments/PaymentGateway',
    });

    const prodTrace: Trace = [];
    const prodKernel = await bootAll(prodTrace, { dev: false });
    const prodInspection = prodKernel.inspect();
    // Absent, not `undefined`: there is no graph to report, and an empty
    // array would claim there is one and nothing was resolved.
    expect('resolutionGraph' in prodInspection).toBe(false);
    expect(prodInspection.resolutionGraph).toBeUndefined();
    // Everything else is unchanged by the flag.
    expect(prodInspection.modules.map((row) => row.id)).toEqual(
      devInspection.modules.map((row) => row.id),
    );
  });

  it('H5: with dev: false nothing is recorded — the recorder is never called at all', async () => {
    const record = vi.spyOn(ResolutionGraph.prototype, 'record');
    try {
      const prodTrace: Trace = [];
      const prodKernel = await bootAll(prodTrace, { dev: false });
      // `bootAll` already activated four modules and resolved a two-hop
      // chain; a dev kernel records four edges doing that (asserted below).
      expect(record).not.toHaveBeenCalled();
      // And nothing else was recorded on the way out, either.
      await prodKernel.deactivate(paymentsRef);
      expect(record).not.toHaveBeenCalled();

      // The control: the *same* sequence against a dev kernel does record,
      // so the assertion above is about the `dev` flag and not about the
      // spy being attached to the wrong thing.
      const devTrace: Trace = [];
      await bootAll(devTrace, { dev: true });
      expect(record).toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
  });

  it('H5: with dev: false hotReplace falls back to the declared dependsOn cascade (never load-bearing)', async () => {
    const trace: Trace = [];
    const kernel = await bootAll(trace, { dev: false });

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    // The declared-but-never-resolved dependent *is* torn down here, which
    // is the pre-H5 behaviour: with no graph the kernel cannot narrow, and
    // the wider cascade is the correct one to fall back to.
    expect(trace).toContain('reporting:dispose');
    expect(trace).toContain('reporting:init');
  });
});
