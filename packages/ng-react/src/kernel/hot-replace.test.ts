// **H2 / H3 / H4 / H6 / G1 / G2** — `kernel.hotReplace`.
//
// `.test.ts` → the **kernel** project (node): no bundler, no renderer. Every
// "HMR update" below is a direct `hotReplace` call or a fake bundler host
// firing its own callback, which is exactly what ADR-5's abstraction is for.
// The H6 component half lives in `src/react/hot-replace.test.tsx`.

import { describe, expect, it, vi } from 'vitest';

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import { DependencyCycleError, InvalidDescriptorError, UnknownModuleError } from '../errors';
import type { HmrAdapter } from '../hmr/adapter';
import { defineStore } from '../hmr/persistent';
import type { Store } from '../hmr/persistent';
import { moduleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import { createToken } from '../token';
import type { ErrorInfo, ErrorSink, ModuleContext } from '../types';
import { ErrorSinkToken } from './failure';
import { createKernel } from './kernel';
import type { Kernel } from './kernel';

// ---------------------------------------------------------------------------
// Fixtures — deliberately *differently* typed tokens (AGENTS.md §9): a
// service interface, a persistent store of records, a persistent numeric
// store, and a contribution element type.
// ---------------------------------------------------------------------------

interface PaymentGateway {
  readonly generation: number;
  charge(amountMinor: number): string;
}
const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');

interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}
const CartStoreToken = createToken<Store<readonly CartLine[]>>('payments/CartStore');

const AttemptCountToken = createToken<Store<number>>('payments/AttemptCount');

interface OrderService {
  place(sku: string): string;
}
const OrderServiceToken = createToken<OrderService>('orders/OrderService');

const authRef = moduleRef('auth');
const paymentsRef = moduleRef('payments');
const ordersRef = moduleRef('orders');
const telemetryRef = moduleRef('telemetry');
const reportingRef = moduleRef('reporting');

/** One routed error, as the F4 sink saw it. */
interface SinkReport {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/** A module that contributes an error sink (F4) into `reports`. */
function sinkModule(reports: SinkReport[]): ModuleDescriptor {
  return defineModule({
    id: telemetryRef,
    load: 'eager',
    critical: false,
    providers: () => [
      contribute(ErrorSinkToken, {
        factory: (): ErrorSink => ({
          report: (error, info) => {
            reports.push({ error, info });
          },
        }),
      }),
    ],
  });
}

/** Records the exact order in which lifecycle steps ran across a cascade. */
type Trace = string[];

/**
 * The `payments` descriptor, parameterised by generation — "generation 2" is
 * what a re-evaluated `providers.ts` would produce after an edit.
 */
function paymentsModule(options: {
  readonly generation: number;
  readonly trace: Trace;
  readonly disposed?: number[];
}): ModuleDescriptor {
  const { generation, trace, disposed } = options;
  return defineModule({
    id: paymentsRef,
    dependsOn: [authRef],
    providers: () => {
      trace.push(`payments:providers:${generation}`);
      return [
        provide(PaymentGatewayToken, {
          factory: (): PaymentGateway => ({
            generation,
            charge: (amountMinor) => `gen${generation}:${amountMinor}`,
          }),
          onDispose: (instance) => {
            trace.push(`payments:disposeGateway:${instance.generation}`);
            disposed?.push(instance.generation);
          },
        }),
      ];
    },
    init: () => {
      trace.push(`payments:init:${generation}`);
    },
    dispose: () => {
      trace.push(`payments:dispose:${generation}`);
    },
  });
}

/** `orders` depends on `payments`, so it is the H2 cascade's dependent. */
function ordersModule(trace: Trace): ModuleDescriptor {
  return defineModule({
    id: ordersRef,
    dependsOn: [paymentsRef],
    providers: () => {
      trace.push('orders:providers');
      return [
        provide(OrderServiceToken, {
          deps: [PaymentGatewayToken],
          factory: (gateway: PaymentGateway): OrderService => ({
            place: (sku) => `${sku}@${gateway.charge(100)}`,
          }),
        }),
      ];
    },
    init: () => {
      trace.push('orders:init');
    },
    dispose: () => {
      trace.push('orders:dispose');
    },
  });
}

const authModule = defineModule({ id: authRef, load: 'eager', critical: true });

/** Lets the scheduled eager startup pass settle before a test asserts. */
async function settled(kernel: Kernel): Promise<void> {
  await kernel.whenStartupComplete();
}

describe('kernel.hotReplace — H2', () => {
  it('H2: an active module is disposed, its thunks re-evaluated, and it is re-activated, in that order', async () => {
    const trace: Trace = [];
    const kernel = createKernel({ modules: [authModule, paymentsModule({ generation: 1, trace })] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    expect(trace).toEqual(['payments:providers:1', 'payments:init:1']);
    // C3: nothing is constructed until it is resolved, so resolve the
    // gateway — otherwise there is no instance for H4 to dispose.
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    expect(trace).toEqual([
      // 1 — dispose: the module's own dispose(ctx) handler, then H4's
      // provider-instance disposal, both before anything is re-evaluated.
      'payments:dispose:1',
      'payments:disposeGateway:1',
      // 2 + 3 — re-evaluate the fresh thunks, then re-activate.
      'payments:providers:2',
      'payments:init:2',
    ]);
    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });

  it('H2: dependents are disposed in reverse topological order and re-activated in topological order', async () => {
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [authModule, paymentsModule({ generation: 1, trace }), ordersModule(trace)],
    });
    await settled(kernel);
    await kernel.activate(ordersRef);
    // C3: resolving the dependent's service constructs the gateway too.
    expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@gen1:100');

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    expect(trace).toEqual([
      // Reverse topological: the dependent dies first and completely.
      'orders:dispose',
      'payments:dispose:1',
      'payments:disposeGateway:1',
      // Topological: the edited module comes back before its dependent, so
      // `orders` never re-resolves against a withdrawn provider.
      'payments:providers:2',
      'payments:init:2',
      'orders:providers',
      'orders:init',
    ]);
    expect(kernel.status(ordersRef)).toBe('ready');
    // The dependent's service was rebuilt against the *new* gateway.
    expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@gen2:100');
  });

  it('H2: a registered-but-inactive module has only its registration refreshed', async () => {
    const trace: Trace = [];
    const kernel = createKernel({ modules: [authModule, paymentsModule({ generation: 1, trace })] });
    await settled(kernel);
    // `payments` is lazy and nothing triggered it.
    expect(kernel.status(paymentsRef)).toBe('registered');

    trace.length = 0;
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    // D1: no thunk ran. Editing a file is not an activation trigger (§6).
    expect(trace).toEqual([]);
    expect(kernel.status(paymentsRef)).toBe('registered');
    expect(kernel.epochOf('payments')).toBe(0);

    // But the refreshed registration is the one that takes effect when
    // something does activate it.
    await kernel.activate(paymentsRef);
    expect(trace).toEqual(['payments:providers:2', 'payments:init:2']);
  });

  it('H2: a hot update with no replacement descriptor re-evaluates the existing thunks', async () => {
    // ADR-7's blessed thunk form re-reads its implementation on every call,
    // so an implementation-file edit needs no new descriptor.
    let generation = 1;
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [
        authModule,
        defineModule({
          id: paymentsRef,
          dependsOn: [authRef],
          providers: () => {
            trace.push(`payments:providers:${generation}`);
            return [
              provide(PaymentGatewayToken, {
                factory: (): PaymentGateway => ({
                  generation,
                  charge: (amountMinor) => `gen${generation}:${amountMinor}`,
                }),
              }),
            ];
          },
        }),
      ],
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);

    generation = 2;
    await kernel.hotReplace(paymentsRef);

    expect(trace).toEqual(['payments:providers:1', 'payments:providers:2']);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });

  it('H2: concurrent updates are serialised, so the later descriptor is the one that lands', async () => {
    const trace: Trace = [];
    const kernel = createKernel({ modules: [authModule, paymentsModule({ generation: 1, trace })] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    // C3: nothing is constructed until it is resolved, so resolve the
    // gateway — otherwise there is no instance for H4 to dispose.
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);

    trace.length = 0;
    // Two edits in flight. Single-flighting these would drop generation 3.
    const first = kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));
    const second = kernel.hotReplace(paymentsRef, paymentsModule({ generation: 3, trace }));
    await Promise.all([first, second]);

    expect(trace).toEqual([
      'payments:dispose:1',
      'payments:disposeGateway:1',
      'payments:providers:2',
      'payments:init:2',
      'payments:dispose:2',
      'payments:providers:3',
      'payments:init:3',
    ]);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(3);
  });

  it('H2: hotReplace rejects a ref this kernel never registered', async () => {
    const kernel = createKernel({ modules: [authModule] });
    await settled(kernel);
    await expect(kernel.hotReplace(reportingRef)).rejects.toThrow(
      "kernel.hotReplace(): module 'reporting' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
    );
  });

  it('H2: a replacement descriptor for a different module is rejected, not silently applied', async () => {
    const trace: Trace = [];
    const kernel = createKernel({ modules: [authModule, paymentsModule({ generation: 1, trace })] });
    await settled(kernel);

    await expect(kernel.hotReplace(paymentsRef, ordersModule(trace))).rejects.toThrow(
      InvalidDescriptorError,
    );
    await expect(kernel.hotReplace(paymentsRef, ordersModule(trace))).rejects.toThrow(
      "kernel.hotReplace(): the replacement descriptor for module 'payments' has id 'orders'. " +
        "A hot update may replace a module's implementation, never its identity.",
    );
  });
});

describe('kernel.hotReplace — graph re-validation (G1, G2)', () => {
  /** An adapter that records what the kernel asked the bundler to do. */
  function recordingAdapter(): HmrAdapter & { readonly invalidations: string[] } {
    const invalidations: string[] = [];
    return {
      enabled: true,
      invalidations,
      invalidate: (id, reason) => {
        invalidations.push(reason === undefined ? id : `${id}: ${reason}`);
      },
    };
  }

  it('G1: a replacement whose dependsOn introduces a cycle is rejected whole and reported to the sinks', async () => {
    const reports: SinkReport[] = [];
    const trace: Trace = [];
    const hmr = recordingAdapter();
    const kernel = createKernel({
      modules: [sinkModule(reports), authModule, paymentsModule({ generation: 1, trace }), ordersModule(trace)],
      hmr,
    });
    await settled(kernel);
    await kernel.activate(ordersRef);
    trace.length = 0;

    // `orders` already depends on `payments`; making `payments` depend on
    // `orders` closes the loop.
    await kernel.hotReplace(
      paymentsRef,
      defineModule({ id: paymentsRef, dependsOn: [authRef, ordersRef], providers: () => [] }),
    );

    const cycle = reports.find((report) => report.error instanceof DependencyCycleError);
    expect((cycle?.error as DependencyCycleError).message).toBe(
      'Module dependency cycle: orders → payments → orders. Break it by moving the shared surface into a contract.',
    );
    expect(cycle?.info).toEqual({ moduleId: 'payments', phase: 'activate' });
    expect(hmr.invalidations).toEqual([
      'payments: the replacement descriptor failed graph validation; the previous descriptor is still in force',
    ]);

    // Rejected *whole*: nothing was disposed, both modules keep running the
    // code they were running, and the old descriptor is still in force.
    expect(trace).toEqual([]);
    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.status(ordersRef)).toBe('ready');
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);
    expect(kernel.inspect().edges).toEqual([
      { from: 'orders', to: 'payments' },
      { from: 'payments', to: 'auth' },
    ]);
  });

  it('G1: after a rejected update, the corrected edit applies — no restart needed', async () => {
    const reports: SinkReport[] = [];
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [sinkModule(reports), authModule, paymentsModule({ generation: 1, trace }), ordersModule(trace)],
    });
    await settled(kernel);
    await kernel.activate(ordersRef);

    await kernel.hotReplace(
      paymentsRef,
      defineModule({ id: paymentsRef, dependsOn: [authRef, ordersRef], providers: () => [] }),
    );
    trace.length = 0;

    // The developer deletes the offending dependsOn entry and saves again.
    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
    expect(trace).toContain('payments:providers:2');
  });

  it('G2: a replacement naming an unregistered module is rejected whole and reported', async () => {
    const reports: SinkReport[] = [];
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [sinkModule(reports), authModule, paymentsModule({ generation: 1, trace })],
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    trace.length = 0;

    await kernel.hotReplace(
      paymentsRef,
      defineModule({ id: paymentsRef, dependsOn: [authRef, reportingRef], providers: () => [] }),
    );

    const missing = reports.find((report) => report.error instanceof UnknownModuleError);
    expect((missing?.error as UnknownModuleError).message).toBe(
      "Module 'payments' depends on 'reporting', which was not registered with the kernel. " +
        'Add its descriptor to the composition root.',
    );
    expect(trace).toEqual([]);
    expect(kernel.status(paymentsRef)).toBe('ready');
  });

  it('H2: a replacement that only reorders dependsOn is not a graph change', async () => {
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [
        authModule,
        defineModule({ id: telemetryRef, load: 'eager' }),
        defineModule({
          id: paymentsRef,
          dependsOn: [authRef, telemetryRef],
          providers: () => {
            trace.push('payments:providers');
            return [];
          },
        }),
      ],
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);

    await kernel.hotReplace(
      paymentsRef,
      defineModule({ id: paymentsRef, dependsOn: [telemetryRef, authRef], providers: () => [] }),
    );

    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.inspect().edges).toEqual([
      { from: 'payments', to: 'auth' },
      { from: 'payments', to: 'telemetry' },
    ]);
  });

  it('H2: a valid dependsOn change rebuilds the graph, so the new dependency is activated (A1)', async () => {
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [
        authModule,
        defineModule({
          id: telemetryRef,
          init: () => {
            trace.push('telemetry:init');
          },
        }),
        paymentsModule({ generation: 1, trace }),
      ],
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);
    expect(kernel.status(telemetryRef)).toBe('registered');
    trace.length = 0;

    await kernel.hotReplace(
      paymentsRef,
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef, telemetryRef],
        providers: () => {
          trace.push('payments:providers:2');
          return [];
        },
      }),
    );

    // A1: the newly declared dependency is activated before the module.
    expect(trace).toEqual([
      'payments:dispose:1',
      'payments:disposeGateway:1',
      'telemetry:init',
      'payments:providers:2',
    ]);
    expect(kernel.status(telemetryRef)).toBe('ready');
    expect(kernel.inspect().edges).toEqual([
      { from: 'payments', to: 'auth' },
      { from: 'payments', to: 'telemetry' },
    ]);
  });
});

describe('kernel.hotReplace — H4 instance disposal', () => {
  it('H4: a singleton instance is disposed and replaced on re-activation, despite C2/C7 app lifetime', async () => {
    const disposed: number[] = [];
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [authModule, paymentsModule({ generation: 1, trace, disposed })],
    });
    await settled(kernel);
    await kernel.activate(paymentsRef);

    const before = kernel.get(PaymentGatewayToken);
    expect(before.generation).toBe(1);
    // C2/C7 in isolation say a `singleton` lives for the app; the same
    // resolution twice is the same object.
    expect(kernel.get(PaymentGatewayToken)).toBe(before);

    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace, disposed }));

    // **H4 contradicts C2's lifetime rule on purpose**: the provider itself
    // changed, so the old instance is invalid and the next resolution
    // constructs from the new factory.
    expect(disposed).toEqual([1]);
    const after = kernel.get(PaymentGatewayToken);
    expect(after).not.toBe(before);
    expect(after.generation).toBe(2);
  });

  it('H4: a module-scoped instance is disposed and replaced too', async () => {
    const disposedSerials: number[] = [];
    let serial = 0;
    const build = (): ModuleDescriptor =>
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef],
        providers: () => [
          provide(PaymentGatewayToken, {
            scope: 'module',
            factory: (): PaymentGateway => ({ generation: ++serial, charge: () => 'ok' }),
            onDispose: (instance) => {
              disposedSerials.push(instance.generation);
            },
          }),
        ],
      });

    const kernel = createKernel({ modules: [authModule, build()] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);

    await kernel.hotReplace(paymentsRef, build());

    expect(disposedSerials).toEqual([1]);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });
});

describe('kernel.hotReplace — H3 persistent stores (ADR-3)', () => {
  /** `payments` with a persistent cart store and a non-persistent gateway. */
  function persistentPayments(generation: number, disposedStores: number[] = []): ModuleDescriptor {
    return defineModule({
      id: paymentsRef,
      dependsOn: [authRef],
      providers: () => [
        provide(CartStoreToken, {
          persistent: true,
          factory: () => defineStore<readonly CartLine[]>([]),
          onDispose: () => {
            disposedStores.push(generation);
          },
        }),
        provide(PaymentGatewayToken, {
          factory: (): PaymentGateway => ({ generation, charge: () => `gen${generation}` }),
        }),
      ],
    });
  }

  it('H3: persistent state survives hotReplace while everything else is rebuilt', async () => {
    const disposedStores: number[] = [];
    const kernel = createKernel({ modules: [authModule, persistentPayments(1, disposedStores)] });
    await settled(kernel);
    await kernel.activate(paymentsRef);

    const cart = kernel.get(CartStoreToken);
    cart.setState([{ sku: 'DESK-1', quantity: 2 }]);

    await kernel.hotReplace(paymentsRef, persistentPayments(2, disposedStores));

    const nextCart = kernel.get(CartStoreToken);
    // A genuinely new instance from the new factory — the state moved, the
    // object did not.
    expect(nextCart).not.toBe(cart);
    expect(nextCart.getState()).toEqual([{ sku: 'DESK-1', quantity: 2 }]);
    // H4's sole exception: the persistent instance is not disposed, because
    // disposing a store is how a store throws its state away.
    expect(disposedStores).toEqual([]);
    // Everything non-persistent still obeys H4.
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });

  it('H3: a module-scoped persistent store is carried too, not just a singleton one', async () => {
    // The two scopes live in two different caches inside the resolver, so
    // "persistent survives" has to be pinned for both — a mutation that
    // disabled the module-scoped half alone went unnoticed until this test
    // existed.
    const build = (generation: number): ModuleDescriptor =>
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef],
        providers: () => [
          provide(CartStoreToken, {
            scope: 'module',
            persistent: true,
            factory: () => defineStore<readonly CartLine[]>([]),
          }),
          provide(PaymentGatewayToken, {
            scope: 'module',
            factory: (): PaymentGateway => ({ generation, charge: () => `gen${generation}` }),
          }),
        ],
      });

    const kernel = createKernel({ modules: [authModule, build(1)] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    const cart = kernel.get(CartStoreToken);
    cart.setState([{ sku: 'CHAIR-9', quantity: 1 }]);

    await kernel.hotReplace(paymentsRef, build(2));

    const nextCart = kernel.get(CartStoreToken);
    expect(nextCart).not.toBe(cart);
    expect(nextCart.getState()).toEqual([{ sku: 'CHAIR-9', quantity: 1 }]);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });

  it('H3: persistent state is discarded by a real deactivation, not carried', async () => {
    const disposedStores: number[] = [];
    const kernel = createKernel({ modules: [authModule, persistentPayments(1, disposedStores)] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    kernel.get(CartStoreToken).setState([{ sku: 'DESK-1', quantity: 2 }]);

    await kernel.deactivate(paymentsRef);
    await kernel.activate(paymentsRef);

    // H3: "carried across an HMR re-activation of their own module (but not
    // across a real deactivation)".
    expect(kernel.get(CartStoreToken).getState()).toEqual([]);
    // And on this path the store *is* disposed, like every other instance.
    expect(disposedStores).toEqual([1]);
  });

  it('H3: a deactivation between two hot updates drops the parked state', async () => {
    const kernel = createKernel({ modules: [authModule, persistentPayments(1)] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    kernel.get(CartStoreToken).setState([{ sku: 'DESK-1', quantity: 2 }]);

    // A hot update parks the state, but nothing resolves the store before
    // the module is deactivated for real. The parked entry must not survive
    // to be adopted by a later activation.
    await kernel.hotReplace(paymentsRef, persistentPayments(2));
    await kernel.deactivate(paymentsRef);
    await kernel.activate(paymentsRef);

    expect(kernel.get(CartStoreToken).getState()).toEqual([]);
  });

  it('ADR-3: the transfer hook runs on the real HMR path, on the *new* record', async () => {
    const build = (multiplier: number): ModuleDescriptor =>
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef],
        providers: () => [
          provide(AttemptCountToken, {
            persistent: true,
            transfer: (oldInstance, newInstance) => {
              newInstance.setState(oldInstance.getState() * multiplier);
            },
            factory: () => defineStore(0),
          }),
        ],
      });

    const kernel = createKernel({ modules: [authModule, build(1)] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    kernel.get(AttemptCountToken).setState(7);

    // The replacement's hook, not the old one's: a migration is written
    // against the shape the *new* code expects.
    await kernel.hotReplace(paymentsRef, build(100));

    expect(kernel.get(AttemptCountToken).getState()).toBe(700);
  });

  it('ADR-3: a failed transfer is reported through the sinks and does not break the cycle', async () => {
    const reports: SinkReport[] = [];
    const build = (): ModuleDescriptor =>
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef],
        providers: () => [
          // A store whose state holds a closure: `structuredClone` throws,
          // so this lands in ADR-3 branch 4 on every hot update.
          provide(CartStoreToken, {
            persistent: true,
            factory: () =>
              defineStore<readonly CartLine[]>([]) as Store<readonly CartLine[]> & { readonly hook?: () => void },
          }),
          provide(AttemptCountToken, {
            persistent: true,
            factory: () => defineStore(0),
          }),
        ],
      });

    const kernel = createKernel({ modules: [sinkModule(reports), authModule, build()] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    // A closure in the state — the realistic version of "someone put a
    // callback in the store".
    (kernel.get(CartStoreToken) as Store<unknown>).setState({ retry: () => {} });
    kernel.get(AttemptCountToken).setState(5);

    await kernel.hotReplace(paymentsRef, build());

    expect(kernel.status(paymentsRef)).toBe('ready');
    // The failed store is reset, and the *other* persistent store still
    // transferred: one bad store does not poison the cycle.
    expect(kernel.get(CartStoreToken).getState()).toEqual([]);
    expect(kernel.get(AttemptCountToken).getState()).toBe(5);

    const failure = reports.find(
      (report) => (report.error as { code?: string }).code === 'HMR_PERSISTENT_TRANSFER_FAILED',
    );
    expect((failure?.error as Error).message).toContain(
      "Persistent state for 'payments/CartStore' (owned by 'payments')",
    );
    expect(failure?.info).toEqual({ moduleId: 'payments', phase: 'resolve' });
  });
});

describe('kernel.hotReplace — H6 epochs', () => {
  it('H6: every re-activated module in the cascade gets its resolution epoch bumped', async () => {
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [authModule, paymentsModule({ generation: 1, trace }), ordersModule(trace)],
    });
    await settled(kernel);
    await kernel.activate(ordersRef);
    // **H5**: `orders` is in the cascade because it *consumed* a `payments`
    // instance, not because it declares `dependsOn: [payments]`. Without
    // this resolution its `OrderService` was never constructed (C3), so it
    // holds nothing the edit invalidates and the H5 cascade — correctly —
    // leaves it running and its epoch untouched. `resolution-cascade.test.ts`
    // asserts that case head-on.
    expect(kernel.get(OrderServiceToken).place('DESK-1')).toBe('DESK-1@gen1:100');
    expect(kernel.epochOf('payments')).toBe(0);
    expect(kernel.epochOf('orders')).toBe(0);

    const bumps: string[] = [];
    kernel.subscribeEpoch('payments', () => bumps.push('payments'));
    kernel.subscribeEpoch('orders', () => bumps.push('orders'));

    await kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));

    expect(kernel.epochOf('payments')).toBe(1);
    expect(kernel.epochOf('orders')).toBe(1);
    // Topological order, like the re-activation itself.
    expect(bumps).toEqual(['payments', 'orders']);
    // An untouched module's epoch does not move.
    expect(kernel.epochOf('auth')).toBe(0);
  });

  it('H6: the epoch is bumped even when re-activation fails, so nothing keeps a disposed instance', async () => {
    const reports: SinkReport[] = [];
    let shouldFail = false;
    const build = (): ModuleDescriptor =>
      defineModule({
        id: paymentsRef,
        dependsOn: [authRef],
        providers: () => [provide(PaymentGatewayToken, { factory: (): PaymentGateway => ({ generation: 1, charge: () => 'ok' }) })],
        init: (_ctx: ModuleContext) => {
          if (shouldFail) {
            throw new Error('payments/init: gateway credentials missing');
          }
        },
      });

    const hmr = { enabled: true, invalidate: vi.fn() };
    const kernel = createKernel({ modules: [sinkModule(reports), authModule, build()], hmr });
    await settled(kernel);
    await kernel.activate(paymentsRef);

    shouldFail = true;
    await kernel.hotReplace(paymentsRef, build());

    expect(kernel.status(paymentsRef)).toBe('failed');
    expect(kernel.epochOf('payments')).toBe(1);
    expect(hmr.invalidate).toHaveBeenCalledWith(
      'payments',
      'module could not be re-activated after a hot update',
    );
  });
});

describe('kernel.hotReplace — driven through a fake bundler host (ADR-5, §17)', () => {
  it('H2: an update fired by the host drives the whole re-activation', async () => {
    const trace: Trace = [];
    // The fake bundler, and note what it is *not*: an `HmrAdapter`. Since #42
    // the seam has no `accept` — `accept` is called by the module's own hot
    // block against `import.meta.hot` directly, because Vite's self-accept
    // detection is a lexical scan of that module's source (#46). So this is
    // the shape of a *generated module's* hot context, which is where the
    // kernel's `hotReplace` is really called from.
    const handlers = new Map<string, () => void>();
    const host = { accept: (id: string, onUpdate: () => void) => handlers.set(id, onUpdate) };

    const kernel = createKernel({ modules: [authModule, paymentsModule({ generation: 1, trace })] });
    await settled(kernel);
    await kernel.activate(paymentsRef);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(1);

    let pending: Promise<void> = Promise.resolve();
    host.accept('payments/providers.ts', () => {
      pending = kernel.hotReplace(paymentsRef, paymentsModule({ generation: 2, trace }));
    });

    trace.length = 0;
    handlers.get('payments/providers.ts')?.();
    await pending;

    expect(trace).toEqual([
      'payments:dispose:1',
      'payments:disposeGateway:1',
      'payments:providers:2',
      'payments:init:2',
    ]);
    expect(kernel.get(PaymentGatewayToken).generation).toBe(2);
  });

  it('ADR-5: the default adapter is the noop one, so a kernel with no hmr option never calls a bundler', async () => {
    const reports: SinkReport[] = [];
    const trace: Trace = [];
    const kernel = createKernel({
      modules: [sinkModule(reports), authModule, paymentsModule({ generation: 1, trace }), ordersModule(trace)],
    });
    await settled(kernel);
    await kernel.activate(ordersRef);

    // The noop adapter has no `invalidate`, so the kernel's optional call
    // must be exactly that — a no-op, not a TypeError that would replace the
    // graph error with a crash.
    await expect(
      kernel.hotReplace(
        paymentsRef,
        defineModule({ id: paymentsRef, dependsOn: [authRef, ordersRef], providers: () => [] }),
      ),
    ).resolves.toBeUndefined();
    expect(reports.some((report) => report.error instanceof DependencyCycleError)).toBe(true);
  });
});
