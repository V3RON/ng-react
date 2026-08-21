import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import {
  ActivationTimeoutError,
  DependencyActivationError,
  DependencyCycleError,
  DuplicateModuleIdError,
  InvalidDescriptorError,
  ModuleActivationError,
  ResolutionError,
  UnknownModuleError,
} from '../errors';
import { moduleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import type { AnyProviderRecord } from '../provider';
import { createToken, MODULE_ID } from '../token';
import type { ModuleContext, ModuleStatus } from '../types';
import { createKernel, KernelImpl } from './kernel';
import type { Kernel } from './kernel';

// ---------------------------------------------------------------------------
// Fixtures. Deliberately *differently* typed tokens (AGENTS.md §9): a service
// interface, a callback, a primitive and a contribution element type, so
// nothing here can pass by being weaker than a real module's providers.
// ---------------------------------------------------------------------------

interface PaymentGateway {
  charge(amountMinor: number): Promise<string>;
}
interface AnalyticsSink {
  /** The module that contributed this sink (C4/C9 — resolved from MODULE_ID). */
  readonly source: string;
  record(event: string): void;
}
interface SessionClock {
  now(): number;
}

const PaymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
const AnalyticsSinkToken = createToken<AnalyticsSink>('telemetry/AnalyticsSink');
const SessionClockToken = createToken<SessionClock>('auth/SessionClock');
const MaxRetriesToken = createToken<number>('orders/MaxRetries');
const HttpClientToken = createToken<{ get(url: string): Promise<string> }>('http/Client');
const StorageRootToken = createToken<string>('storage/Root');

const AuthModule = moduleRef('auth');
const PaymentsModule = moduleRef('payments');
const OrdersModule = moduleRef('orders');
const TelemetryModule = moduleRef('telemetry');
const UiModule = moduleRef('ui');

/** A minimal descriptor set: auth ← payments ← orders ← ui, telemetry standalone. */
function appModules(): ModuleDescriptor[] {
  return [
    defineModule({ id: AuthModule, load: 'eager', critical: true }),
    defineModule({ id: PaymentsModule, dependsOn: [AuthModule] }),
    defineModule({ id: OrdersModule, dependsOn: [AuthModule, PaymentsModule] }),
    defineModule({ id: UiModule, dependsOn: [OrdersModule] }),
    defineModule({ id: TelemetryModule }),
  ];
}

/** Every permutation of `items`, capped — determinism is asserted over these. */
function permutations<T>(items: readonly T[], limit = 24): T[][] {
  const out: T[][] = [];
  const walk = (rest: readonly T[], acc: T[]): void => {
    if (out.length >= limit) {
      return;
    }
    if (rest.length === 0) {
      out.push(acc);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      const picked = rest[i];
      if (picked === undefined) {
        continue;
      }
      walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, picked]);
    }
  };
  walk(items, []);
  return out;
}

/**
 * Test subclass exposing the two seams task 3.2 will drive from inside the
 * kernel: the A2 status transition and the F1 retained failure. Nothing in
 * task 3.1 can *produce* either (a registration failure is fatal and
 * `createKernel` never returns), so without this the notification mechanism
 * the issue asks for would ship untested.
 */
class DrivableKernel extends KernelImpl {
  transitionTo(moduleId: string, status: ModuleStatus): void {
    this.setStatus(moduleId, status);
  }
  recordFailure(moduleId: string, error: unknown): void {
    this.failures.set(moduleId, error);
  }
}

describe('createKernel — registration (spec §6)', () => {
  it('M3: two descriptors with the same id string is a fatal error naming both', () => {
    // Two separate moduleRef('orders') calls — the copy-paste M3 guards against.
    const first = moduleRef('orders');
    const second = moduleRef('orders');
    try {
      createKernel({
        modules: [
          defineModule({ id: AuthModule }),
          defineModule({ id: first }),
          defineModule({ id: second }),
        ],
      });
      expect.unreachable('expected DuplicateModuleIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateModuleIdError);
      expect((error as Error).message).toBe(
        "Duplicate module id 'orders': registered by both 'modules[1]' and 'modules[2]'. " +
          'Each moduleRef() call must use a unique id string.',
      );
    }
  });

  it("M3/ADR-2: a hand-built descriptor with the reserved id 'app' is rejected", () => {
    const forged = { id: 'app' } as unknown as ReturnType<typeof moduleRef>;
    const descriptor = { id: forged, dependsOn: [], load: 'lazy', critical: false } as ModuleDescriptor;
    expect(() => createKernel({ modules: [descriptor] })).toThrow(
      "createKernel(): modules[0] uses the reserved module id 'app'. " +
        "'app' is reserved for resolutions started outside any module (ADR-2).",
    );
  });

  it('G2: a dependsOn ref missing from the composition root names the missing module and the dependent', () => {
    try {
      createKernel({
        modules: [defineModule({ id: OrdersModule, dependsOn: [AuthModule, PaymentsModule] })],
      });
      expect.unreachable('expected UnknownModuleError');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModuleError);
      expect((error as Error).message).toBe(
        "Module 'orders' depends on 'auth', which was not registered with the kernel. " +
          'Add its descriptor to the composition root.',
      );
    }
  });

  it('G1: a two-module cycle fails at registration with the verbatim message', () => {
    // Cycles cannot be built through defineModule's own ref checks alone —
    // they need two descriptors pointing at each other, which is legal
    // per-descriptor and only fatal as a graph.
    try {
      createKernel({
        modules: [
          defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
          defineModule({ id: PaymentsModule, dependsOn: [OrdersModule] }),
        ],
      });
      expect.unreachable('expected DependencyCycleError');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as Error).message).toBe(
        'Module dependency cycle: orders → payments → orders. ' +
          'Break it by moving the shared surface into a contract.',
      );
    }
  });

  it('G1: a three-module cycle lists the exact cycle, verbatim (acceptance criterion 6)', () => {
    const RiskModule = moduleRef('risk');
    try {
      createKernel({
        modules: [
          defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
          defineModule({ id: PaymentsModule, dependsOn: [RiskModule] }),
          defineModule({ id: RiskModule, dependsOn: [OrdersModule] }),
        ],
      });
      expect.unreachable('expected DependencyCycleError');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Module dependency cycle: orders → payments → risk → orders. ' +
          'Break it by moving the shared surface into a contract.',
      );
    }
  });

  it('G1: the reported cycle is deterministic across shuffled input', () => {
    const RiskModule = moduleRef('risk');
    const modules = [
      defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
      defineModule({ id: PaymentsModule, dependsOn: [RiskModule] }),
      defineModule({ id: RiskModule, dependsOn: [OrdersModule] }),
      defineModule({ id: UiModule, dependsOn: [OrdersModule] }),
    ];
    const messages = new Set<string>();
    for (const permutation of permutations(modules)) {
      try {
        createKernel({ modules: permutation });
        expect.unreachable('expected DependencyCycleError');
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect([...messages]).toEqual([
      'Module dependency cycle: orders → payments → risk → orders. ' +
        'Break it by moving the shared surface into a contract.',
    ]);
  });

  it('the topological order is deterministic across shuffled input', () => {
    const orders = new Set<string>();
    for (const permutation of permutations(appModules(), 120)) {
      const inspected = createKernel({ modules: permutation }).inspect();
      orders.add(inspected.modules.map((entry) => entry.id).join(','));
    }
    expect(orders.size).toBe(1);
    expect([...orders]).toEqual(['auth,payments,orders,telemetry,ui']);
  });

  it('A2: every module is `registered` once createKernel returns', () => {
    const kernel = createKernel({ modules: appModules() });
    for (const ref of [AuthModule, PaymentsModule, OrdersModule, UiModule, TelemetryModule]) {
      expect(kernel.status(ref)).toBe('registered');
    }
  });

  it('M1: status() takes a ref and rejects one this kernel never registered', () => {
    const kernel = createKernel({ modules: [defineModule({ id: AuthModule })] });
    expect(() => kernel.status(OrdersModule)).toThrow(InvalidDescriptorError);
    expect(() => kernel.status(OrdersModule)).toThrow(
      "kernel.status(): module 'orders' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
    );
  });

  it('D1: registration evaluates no implementation code (acceptance criterion 9)', () => {
    // ADR-7: thunks may be synchronous or return a promise; both shapes are
    // represented so neither can be evaluated by accident.
    const syncProviders = vi.fn(() => [provide(MaxRetriesToken, { factory: () => 3 })]);
    const asyncProviders = vi.fn(() =>
      Promise.resolve([
        provide(SessionClockToken, { factory: (): SessionClock => ({ now: () => 0 }) }),
      ]),
    );
    const init = vi.fn();
    const dispose = vi.fn();
    const asyncInit = vi.fn(() => Promise.resolve());

    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, providers: asyncProviders, init: asyncInit, dispose }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule],
          providers: syncProviders,
          init,
          dispose,
        }),
      ],
    });

    expect(syncProviders).toHaveBeenCalledTimes(0);
    expect(asyncProviders).toHaveBeenCalledTimes(0);
    expect(init).toHaveBeenCalledTimes(0);
    expect(asyncInit).toHaveBeenCalledTimes(0);
    expect(dispose).toHaveBeenCalledTimes(0);
    // Nothing is registered with the container either, so a token some
    // module *would* provide still resolves to nothing.
    expect(kernel.getAll(AnalyticsSinkToken)).toEqual([]);
    expect(() => kernel.get(MaxRetriesToken)).toThrow(ResolutionError);
  });

  it('rejects malformed options', () => {
    expect(() => createKernel({ modules: undefined as unknown as ModuleDescriptor[] })).toThrow(
      'createKernel() requires an options object with a modules array.',
    );
  });

  it('an empty module list is a valid kernel', () => {
    const kernel = createKernel({ modules: [] });
    expect(kernel.inspect()).toEqual({ modules: [], edges: [], providers: [], contributions: [] });
  });

  it('options carry the A3 and ADR-1 defaults, overridable per kernel', () => {
    const defaults = createKernel({ modules: [] }) as KernelImpl;
    expect(defaults.initTimeoutMs).toBe(10_000);
    expect(defaults.disposeTimeoutMs).toBe(2_000);
    expect(typeof defaults.dev).toBe('boolean');

    const custom = createKernel({
      modules: [],
      initTimeoutMs: 250,
      disposeTimeoutMs: 25,
      dev: false,
    }) as KernelImpl;
    expect(custom.initTimeoutMs).toBe(250);
    expect(custom.disposeTimeoutMs).toBe(25);
    expect(custom.dev).toBe(false);
  });
});

describe('kernel.inspect() — G3', () => {
  it('G3: inspect() is deterministic and serialisable (JSON round-trip)', () => {
    const snapshots = new Set<string>();
    for (const permutation of permutations(appModules(), 120)) {
      snapshots.add(JSON.stringify(createKernel({ modules: permutation }).inspect()));
    }
    expect(snapshots.size).toBe(1);

    const inspected = createKernel({ modules: appModules() }).inspect();
    expect(JSON.parse(JSON.stringify(inspected))).toEqual(inspected);

    expect(inspected.modules).toEqual([
      { id: 'auth', status: 'registered', load: 'eager', critical: true, dependsOn: [] },
      { id: 'payments', status: 'registered', load: 'lazy', critical: false, dependsOn: ['auth'] },
      {
        id: 'orders',
        status: 'registered',
        load: 'lazy',
        critical: false,
        dependsOn: ['auth', 'payments'],
      },
      { id: 'telemetry', status: 'registered', load: 'lazy', critical: false, dependsOn: [] },
      { id: 'ui', status: 'registered', load: 'lazy', critical: false, dependsOn: ['orders'] },
    ]);
    expect(inspected.edges).toEqual([
      { from: 'orders', to: 'auth' },
      { from: 'orders', to: 'payments' },
      { from: 'payments', to: 'auth' },
      { from: 'ui', to: 'orders' },
    ]);
    // Providers only reach the container at activation (task 3.2), so both
    // provider tables are empty after registration alone — which is D1
    // restated as a snapshot.
    expect(inspected.providers).toEqual([]);
    expect(inspected.contributions).toEqual([]);
  });

  it('G3/C9: providers and contributions appear with provenance and C5 positions', () => {
    const kernel = createKernel({ modules: appModules() }) as KernelImpl;
    // What task 3.2's activate() will do; done directly here because
    // activation does not exist yet.
    kernel.container.register('ui', [
      contribute(AnalyticsSinkToken, {
        deps: [MODULE_ID],
        factory: (source): AnalyticsSink => ({ source, record: () => {} }),
      }),
    ]);
    kernel.container.register('payments', [
      provide(PaymentGatewayToken, {
        scope: 'module',
        factory: (): PaymentGateway => ({ charge: async () => 'ok' }),
      }),
      contribute(AnalyticsSinkToken, {
        deps: [MODULE_ID],
        factory: (source): AnalyticsSink => ({ source, record: () => {} }),
      }),
    ]);

    const inspected = kernel.inspect();
    expect(inspected.providers).toEqual([
      {
        token: 'payments/PaymentGateway',
        kind: 'provide',
        scope: 'module',
        owner: 'payments',
        override: false,
      },
      {
        token: 'telemetry/AnalyticsSink',
        kind: 'contribute',
        scope: 'singleton',
        owner: 'payments',
        override: false,
      },
      {
        token: 'telemetry/AnalyticsSink',
        kind: 'contribute',
        scope: 'singleton',
        owner: 'ui',
        override: false,
      },
    ]);
    // C5 positions follow module topological order (payments before ui),
    // not the order the modules registered in.
    expect(inspected.contributions).toEqual([
      { token: 'telemetry/AnalyticsSink', owner: 'payments', index: 0 },
      { token: 'telemetry/AnalyticsSink', owner: 'ui', index: 1 },
    ]);
    expect(JSON.parse(JSON.stringify(inspected))).toEqual(inspected);
  });

  it('F1: a retained failure is reported as a plain { name, message, code }', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    kernel.recordFailure('payments', new ResolutionError(['payments/PaymentGateway']));
    kernel.transitionTo('payments', 'failed');

    const payments = kernel.inspect().modules.find((entry) => entry.id === 'payments');
    expect(payments?.status).toBe('failed');
    expect(payments?.error).toEqual({
      name: 'ResolutionError',
      message: 'Cannot resolve payments/PaymentGateway: no provider.',
      code: 'CONTAINER_NO_PROVIDER',
    });
    expect(JSON.parse(JSON.stringify(kernel.inspect()))).toEqual(kernel.inspect());
  });
});

describe('kernel status subscriptions — A2', () => {
  it('A2: subscribeStatus does not fire on subscribe (matching subscribeAll, C5)', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const seen: ModuleStatus[] = [];
    kernel.subscribeStatus(PaymentsModule, (status) => seen.push(status));
    expect(seen).toEqual([]);
    expect(kernel.status(PaymentsModule)).toBe('registered');
  });

  it('A2: transitions notify subscribers of that module only, and only on a real change', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const payments: ModuleStatus[] = [];
    const auth: ModuleStatus[] = [];
    kernel.subscribeStatus(PaymentsModule, (status) => payments.push(status));
    kernel.subscribeStatus(AuthModule, (status) => auth.push(status));

    kernel.transitionTo('payments', 'activating');
    kernel.transitionTo('payments', 'activating'); // no-op: same status
    kernel.transitionTo('payments', 'ready');

    expect(payments).toEqual(['activating', 'ready']);
    expect(auth).toEqual([]);
    expect(kernel.status(PaymentsModule)).toBe('ready');
  });

  it('A2: unsubscribe is idempotent and stops further notifications', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const seen: ModuleStatus[] = [];
    const unsubscribe = kernel.subscribeStatus(PaymentsModule, (status) => seen.push(status));
    kernel.transitionTo('payments', 'activating');
    unsubscribe();
    unsubscribe();
    unsubscribe();
    kernel.transitionTo('payments', 'ready');
    expect(seen).toEqual(['activating']);
  });

  it('A2: the same callback may subscribe twice and each subscription is independent', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const seen: ModuleStatus[] = [];
    const callback = (status: ModuleStatus): void => {
      seen.push(status);
    };
    const first = kernel.subscribeStatus(PaymentsModule, callback);
    kernel.subscribeStatus(PaymentsModule, callback);
    kernel.transitionTo('payments', 'activating');
    expect(seen).toEqual(['activating', 'activating']);
    first();
    kernel.transitionTo('payments', 'ready');
    expect(seen).toEqual(['activating', 'activating', 'ready']);
  });

  it('A2: a subscriber added or removed during a pass does not affect the in-flight pass', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const order: string[] = [];
    const late = vi.fn();
    const cancelled = vi.fn();

    const cancel = kernel.subscribeStatus(PaymentsModule, () => {
      order.push('first');
      // Added mid-pass: must not be called for the status being delivered.
      kernel.subscribeStatus(PaymentsModule, late);
    });
    // Registered after `cancel`'s owner so it is still pending when the
    // first subscriber removes it below.
    kernel.subscribeStatus(PaymentsModule, () => {
      order.push('second');
      cancel();
    });
    kernel.subscribeStatus(PaymentsModule, cancelled);

    kernel.transitionTo('payments', 'activating');
    expect(order).toEqual(['first', 'second']);
    expect(late).toHaveBeenCalledTimes(0);
    // The third subscriber is unaffected by the removal that happened
    // mid-pass; only the *removed* subscription is skipped.
    expect(cancelled).toHaveBeenCalledTimes(1);

    kernel.transitionTo('payments', 'ready');
    expect(order).toEqual(['first', 'second', 'second']);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('A2: a subscription cancelled mid-pass does not fire in that pass', () => {
    const kernel = new DrivableKernel({ modules: appModules() });
    const victim = vi.fn();
    const cancelVictim: { current?: () => void } = {};
    kernel.subscribeStatus(PaymentsModule, () => cancelVictim.current?.());
    cancelVictim.current = kernel.subscribeStatus(PaymentsModule, victim);

    kernel.transitionTo('payments', 'activating');
    expect(victim).toHaveBeenCalledTimes(0);
  });

  it('M1: subscribeStatus rejects a ref this kernel never registered', () => {
    const kernel = createKernel({ modules: [defineModule({ id: AuthModule })] });
    expect(() => kernel.subscribeStatus(UiModule, () => {})).toThrow(
      "kernel.subscribeStatus(): module 'ui' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
    );
  });
});

describe('kernel resolution — the three injected container callbacks', () => {
  it('ADR-2: kernel.get() resolves with the reserved requester `app`', () => {
    const kernel = createKernel({ modules: appModules() });
    expect(kernel.get(MODULE_ID)).toBe('app');
  });

  it('C5: kernel.getAll() orders contributions by the kernel topological order, not registration order', () => {
    const kernel = createKernel({ modules: appModules() }) as KernelImpl;
    // `ui` registers first but sorts topologically last; `auth` registers
    // last but sorts first. If `getTopologicalIndex` were not wired into
    // the container, this would come back in registration order.
    kernel.container.register('ui', [
      contribute(AnalyticsSinkToken, {
        deps: [MODULE_ID],
        factory: (source): AnalyticsSink => ({ source, record: () => {} }),
      }),
    ]);
    kernel.container.register('orders', [
      contribute(AnalyticsSinkToken, {
        deps: [MODULE_ID],
        factory: (source): AnalyticsSink => ({ source, record: () => {} }),
      }),
    ]);
    kernel.container.register('auth', [
      contribute(AnalyticsSinkToken, {
        deps: [MODULE_ID],
        factory: (source): AnalyticsSink => ({ source, record: () => {} }),
      }),
    ]);

    // C4/C9: each `source` is the *owner* of its contribution, which also
    // pins that `getAll` resolves on behalf of each contributor rather than
    // on behalf of the caller.
    expect(kernel.getAll(AnalyticsSinkToken).map((sink) => sink.source)).toEqual([
      'auth',
      'orders',
      'ui',
    ]);
  });

  it('C8: a failed kernel.get() suggests a module that is registered but not depended on', () => {
    const kernel = createKernel({ modules: appModules() });
    try {
      kernel.get(PaymentGatewayToken);
      expect.unreachable('expected ResolutionError');
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      // Proves `setKnownModules` was called with the kernel's module ids:
      // without it the registry cannot tell the label prefix 'payments'
      // from any other slash-containing string, and the second sentence
      // silently disappears.
      expect((error as Error).message).toBe(
        "Cannot resolve payments/PaymentGateway: no provider. 'payments' is registered but not " +
          "listed in dependsOn of 'app'.",
      );
    }
  });

  it('C8: a token label prefix that is not a registered module id yields no suggestion', () => {
    const kernel = createKernel({ modules: appModules() });
    expect(() => kernel.get(HttpClientToken)).toThrow('Cannot resolve http/Client: no provider.');
  });

  it('C8: the suggestion is suppressed when the requester already lists the module in dependsOn', () => {
    // Resolution on behalf of a *module* (rather than 'app') is reachable
    // today only through a contribution, which C9 resolves on behalf of its
    // owner — so this is also the only place `getDependsOn` is observable
    // before activation exists (task 3.2).
    const withDependency = createKernel({ modules: appModules() }) as KernelImpl;
    withDependency.container.register('orders', [
      contribute(AnalyticsSinkToken, {
        deps: [PaymentGatewayToken],
        factory: (): AnalyticsSink => ({ source: 'orders', record: () => {} }),
      }),
    ]);
    try {
      withDependency.getAll(AnalyticsSinkToken);
      expect.unreachable('expected ResolutionError');
    } catch (error) {
      // 'orders' does depend on 'payments', so C8 has nothing to suggest.
      expect((error as Error).message).toBe(
        'Cannot resolve telemetry/AnalyticsSink → payments/PaymentGateway: no provider.',
      );
    }

    // Same resolution, from a module that does *not* depend on payments.
    const withoutDependency = createKernel({
      modules: [
        defineModule({ id: AuthModule }),
        defineModule({ id: PaymentsModule, dependsOn: [AuthModule] }),
        defineModule({ id: OrdersModule, dependsOn: [AuthModule] }),
      ],
    }) as KernelImpl;
    withoutDependency.container.register('orders', [
      contribute(AnalyticsSinkToken, {
        deps: [PaymentGatewayToken],
        factory: (): AnalyticsSink => ({ source: 'orders', record: () => {} }),
      }),
    ]);
    try {
      withoutDependency.getAll(AnalyticsSinkToken);
      expect.unreachable('expected ResolutionError');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Cannot resolve telemetry/AnalyticsSink → payments/PaymentGateway: no provider. ' +
          "'payments' is registered but not listed in dependsOn of 'orders'.",
      );
    }
  });

  it('C5: getAll takes no requester and returns [] for a token nobody contributes to', () => {
    const kernel = createKernel({ modules: appModules() });
    expect(kernel.getAll(AnalyticsSinkToken)).toEqual([]);
    expect(kernel.getAll(SessionClockToken)).toEqual([]);
  });
});

describe('kernel activation surface — task 3.3 stubs', () => {
  it('deactivate/retry reject with a "not implemented" error naming the task', async () => {
    const kernel = createKernel({ modules: appModules() });
    await expect(kernel.deactivate(AuthModule)).rejects.toThrow(
      'kernel.deactivate() is not implemented yet (task 3.3); this kernel only performs registration.',
    );
    await expect(kernel.retry(AuthModule)).rejects.toThrow(
      'kernel.retry() is not implemented yet (task 3.3); this kernel only performs registration.',
    );
  });
});

// ===========================================================================
// Task 3.2 — activation (spec §6, A1-A3) and teardown sequencing (L3/L4).
// ===========================================================================

/** Lets the microtask queue drain — the eager startup pass is scheduled on it. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/** A module-scoped instance that records its own teardown (C7). */
interface TeardownProbe {
  readonly id: string;
  disposed: boolean;
  dispose(): void;
}
const TeardownProbeToken = createToken<TeardownProbe>('telemetry/TeardownProbe');

describe('kernel activation — spec §6 (A1, A2, A3)', () => {
  it('D1/§6: a lazy module evaluates nothing until it is triggered (acceptance criterion 9)', async () => {
    // ADR-7: both thunk shapes, so neither can be evaluated by accident.
    const authProviders = vi.fn(() =>
      Promise.resolve([
        provide(SessionClockToken, { factory: (): SessionClock => ({ now: () => 42 }) }),
      ]),
    );
    const authInit = vi.fn();
    const ordersProviders = vi.fn(() => [provide(MaxRetriesToken, { factory: () => 3 })]);
    const ordersInit = vi.fn(() => Promise.resolve());

    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, providers: authProviders, init: authInit }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule],
          providers: ordersProviders,
          init: ordersInit,
        }),
      ],
    });

    // The eager startup pass has run to completion and found nothing eager.
    await kernel.whenStartupComplete();
    await flushMicrotasks();
    expect(authProviders).toHaveBeenCalledTimes(0);
    expect(authInit).toHaveBeenCalledTimes(0);
    expect(ordersProviders).toHaveBeenCalledTimes(0);
    expect(ordersInit).toHaveBeenCalledTimes(0);
    expect(kernel.status(OrdersModule)).toBe('registered');

    await kernel.activate(OrdersModule);
    expect(authProviders).toHaveBeenCalledTimes(1);
    expect(authInit).toHaveBeenCalledTimes(1);
    expect(ordersProviders).toHaveBeenCalledTimes(1);
    expect(ordersInit).toHaveBeenCalledTimes(1);
    expect(kernel.get(MaxRetriesToken)).toBe(3);
  });

  it('A1: activating a module first activates its dependsOn transitively, in topological order', async () => {
    const order: string[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, init: () => void order.push('auth') }),
        defineModule({
          id: PaymentsModule,
          dependsOn: [AuthModule],
          init: () => void order.push('payments'),
        }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule, PaymentsModule],
          init: () => void order.push('orders'),
        }),
        defineModule({ id: UiModule, dependsOn: [OrdersModule], init: () => void order.push('ui') }),
        defineModule({ id: TelemetryModule, init: () => void order.push('telemetry') }),
      ],
    });

    await kernel.activate(UiModule);
    // Transitive, ordered — and telemetry, which nothing depends on, is
    // untouched: activation is not "activate everything reachable".
    expect(order).toEqual(['auth', 'payments', 'orders', 'ui']);
    expect(kernel.status(TelemetryModule)).toBe('registered');
  });

  it('A1: a module never observes a dependency that is registered but not ready', async () => {
    // The assertion that matters is made from *inside* init, against the
    // kernel's own status API — checking activation order from outside
    // would not prove what A1 actually promises.
    const seen: Record<string, ModuleStatus[]> = {};
    // A holder, because `init` has to ask the kernel that is activating it.
    const host: { kernel?: Kernel } = {};
    const record = (id: string, deps: readonly ReturnType<typeof moduleRef>[]): void => {
      const kernel = host.kernel;
      if (kernel === undefined) {
        throw new Error('init ran before createKernel() returned');
      }
      seen[id] = deps.map((dep) => kernel.status(dep));
    };

    host.kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule }),
        defineModule({
          id: PaymentsModule,
          dependsOn: [AuthModule],
          init: () => record('payments', [AuthModule]),
        }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule, PaymentsModule],
          init: () => record('orders', [AuthModule, PaymentsModule]),
        }),
        defineModule({
          id: UiModule,
          dependsOn: [OrdersModule],
          init: () => record('ui', [OrdersModule]),
        }),
      ],
    });

    await host.kernel.activate(UiModule);
    expect(seen).toEqual({
      payments: ['ready'],
      orders: ['ready', 'ready'],
      ui: ['ready'],
    });
  });

  it('A2: activation is idempotent — activating a ready module runs nothing again', async () => {
    const providers = vi.fn(() => [provide(MaxRetriesToken, { factory: () => 5 })]);
    const init = vi.fn();
    const kernel = createKernel({
      modules: [defineModule({ id: OrdersModule, providers, init })],
    });

    await kernel.activate(OrdersModule);
    await kernel.activate(OrdersModule);
    await kernel.activate(OrdersModule);

    expect(providers).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(kernel.status(OrdersModule)).toBe('ready');
  });

  it('A2: N concurrent activate() calls run the provider thunk and init exactly once', async () => {
    // The test the implementation has to be written for. An `await` between
    // starting an activation and recording it passes the sequential
    // idempotence test above and fails this one.
    const providers = vi.fn(async () => {
      await Promise.resolve();
      return [provide(MaxRetriesToken, { factory: () => 7 })];
    });
    const init = vi.fn(async () => {
      await Promise.resolve();
    });
    const kernel = createKernel({
      modules: [defineModule({ id: OrdersModule, providers, init })],
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => kernel.activate(OrdersModule)),
    );

    expect(results).toHaveLength(12);
    expect(providers).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('A2: a diamond — two modules activating concurrently share one activation of their common dependency', async () => {
    const authProviders = vi.fn(async () => {
      await Promise.resolve();
      return [provide(SessionClockToken, { factory: (): SessionClock => ({ now: () => 1 }) })];
    });
    const authInit = vi.fn(async () => {
      await Promise.resolve();
    });
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, providers: authProviders, init: authInit }),
        defineModule({ id: PaymentsModule, dependsOn: [AuthModule] }),
        defineModule({ id: OrdersModule, dependsOn: [AuthModule] }),
        defineModule({ id: UiModule, dependsOn: [OrdersModule, PaymentsModule] }),
      ],
    });

    await Promise.all([
      kernel.activate(PaymentsModule),
      kernel.activate(OrdersModule),
      kernel.activate(UiModule),
    ]);

    expect(authProviders).toHaveBeenCalledTimes(1);
    expect(authInit).toHaveBeenCalledTimes(1);
    expect(kernel.inspect().providers).toEqual([
      {
        token: 'auth/SessionClock',
        kind: 'provide',
        scope: 'singleton',
        owner: 'auth',
        override: false,
      },
    ]);
  });

  it('A2: status transitions registered → activating → ready are published to subscribeStatus', async () => {
    const kernel = createKernel({
      modules: [defineModule({ id: OrdersModule, init: () => Promise.resolve() })],
    });
    const seen: ModuleStatus[] = [];
    kernel.subscribeStatus(OrdersModule, (status) => void seen.push(status));

    expect(kernel.status(OrdersModule)).toBe('registered');
    await kernel.activate(OrdersModule);
    expect(seen).toEqual(['activating', 'ready']);
  });

  it('§6: eager modules activate at startup in topological order; lazy ones do not', async () => {
    const order: string[] = [];
    const lazyInit = vi.fn();
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: () => void order.push('auth') }),
        defineModule({
          id: PaymentsModule,
          dependsOn: [AuthModule],
          load: 'eager',
          init: () => void order.push('payments'),
        }),
        defineModule({ id: TelemetryModule, load: 'eager', init: () => void order.push('telemetry') }),
        defineModule({ id: OrdersModule, dependsOn: [AuthModule], init: lazyInit }),
      ],
    });

    // Every module is still `registered` synchronously after createKernel:
    // the registration pass evaluates nothing (D1), and the eager pass is
    // scheduled so that this window exists for subscribers.
    expect(kernel.status(AuthModule)).toBe('registered');

    await kernel.whenStartupComplete();
    await flushMicrotasks();

    expect(order).toEqual(['auth', 'payments', 'telemetry']);
    expect(lazyInit).toHaveBeenCalledTimes(0);
    expect(kernel.status(OrdersModule)).toBe('registered');
  });

  it('§6/A1: an eager module pulls its lazy dependency in with it', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule }),
        defineModule({ id: PaymentsModule, dependsOn: [AuthModule], load: 'eager', critical: true }),
      ],
    });

    await kernel.whenStartupComplete();
    expect(kernel.status(AuthModule)).toBe('ready');
    expect(kernel.status(PaymentsModule)).toBe('ready');
  });

  it('A3 hook: whenStartupComplete resolves once every eager critical module is ready', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true }),
        defineModule({ id: TelemetryModule, load: 'eager' }),
      ],
    });

    await expect(kernel.whenStartupComplete()).resolves.toBeUndefined();
    expect(kernel.status(AuthModule)).toBe('ready');
  });

  it('A3 hook: whenStartupComplete resolves immediately when no module is eager and critical', async () => {
    const kernel = createKernel({ modules: [defineModule({ id: OrdersModule })] });
    await expect(kernel.whenStartupComplete()).resolves.toBeUndefined();
  });

  it('F2: an eager critical module that fails rejects whenStartupComplete with its failure', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AuthModule,
          load: 'eager',
          critical: true,
          init: () => {
            throw new Error('no keychain');
          },
        }),
      ],
    });

    await expect(kernel.whenStartupComplete()).rejects.toThrow(
      "Activating module 'auth' failed in its init(ctx): no keychain",
    );
    expect(kernel.status(AuthModule)).toBe('failed');
  });

  it('F3/F1: a non-critical eager failure does not stop the startup pass', async () => {
    // 'admin' sorts before 'auth', so the failing module is reached first
    // and the pass has to survive it to get to the critical one.
    const AdminModule = moduleRef('admin');
    const laterInit = vi.fn();
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AdminModule,
          load: 'eager',
          init: () => {
            throw new Error('sink unavailable');
          },
        }),
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: laterInit }),
      ],
    });

    await kernel.whenStartupComplete();
    expect(kernel.status(AdminModule)).toBe('failed');
    expect(laterInit).toHaveBeenCalledTimes(1);
    expect(kernel.status(AuthModule)).toBe('ready');
  });
});

describe('kernel activation — failures (F1, F3)', () => {
  it('F1: an init that throws leaves the module failed with the error retained by inspect()', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          init: () => {
            throw new Error('draft store missing');
          },
        }),
      ],
    });

    await expect(kernel.activate(OrdersModule)).rejects.toBeInstanceOf(ModuleActivationError);
    expect(kernel.status(OrdersModule)).toBe('failed');
    const row = kernel.inspect().modules.find((entry) => entry.id === 'orders');
    expect(row?.error).toEqual({
      name: 'ModuleActivationError',
      message: "Activating module 'orders' failed in its init(ctx): draft store missing",
      code: 'KERNEL_ACTIVATION_FAILED',
    });
  });

  it('F1: a providers thunk that rejects fails the module, naming the providers phase', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          providers: () => Promise.reject(new Error('chunk load failed')),
        }),
      ],
    });

    try {
      await kernel.activate(OrdersModule);
      expect.unreachable('expected ModuleActivationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleActivationError);
      expect((error as Error).message).toBe(
        "Activating module 'orders' failed in its providers thunk: chunk load failed",
      );
      expect((error as ModuleActivationError).phase).toBe('providers');
      expect(((error as Error).cause as Error).message).toBe('chunk load failed');
    }
  });

  it('F1/A2: a failed module stays failed — activate() rejects with the retained error, not a re-attempt', async () => {
    const init = vi.fn(() => {
      throw new Error('boom');
    });
    const kernel = createKernel({ modules: [defineModule({ id: OrdersModule, init })] });

    const first = await kernel.activate(OrdersModule).catch((error: unknown) => error);
    const second = await kernel.activate(OrdersModule).catch((error: unknown) => error);

    // Re-attempting is `kernel.retry()` (F3, task 3.3) and only that.
    expect(second).toBe(first);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('F3: a dependent fails with a cause chain naming the failed dependency', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: PaymentsModule,
          init: () => {
            throw new Error('gateway offline');
          },
        }),
        defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
        defineModule({ id: UiModule, dependsOn: [OrdersModule] }),
      ],
    });

    try {
      await kernel.activate(UiModule);
      expect.unreachable('expected DependencyActivationError');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyActivationError);
      expect((error as Error).message).toBe(
        "Module 'ui' cannot activate: its dependency 'orders' failed to activate. " +
          "Fix 'orders' and call kernel.retry() for it, or remove it from 'ui's dependsOn.",
      );
      // The chain reads ui → orders → payments → the module author's own error.
      const viaOrders = (error as Error).cause as DependencyActivationError;
      expect(viaOrders.message).toBe(
        "Module 'orders' cannot activate: its dependency 'payments' failed to activate. " +
          "Fix 'payments' and call kernel.retry() for it, or remove it from 'orders's dependsOn.",
      );
      const viaPayments = (viaOrders as Error).cause as ModuleActivationError;
      expect(viaPayments.message).toBe(
        "Activating module 'payments' failed in its init(ctx): gateway offline",
      );
      expect(((viaPayments as Error).cause as Error).message).toBe('gateway offline');
    }
    expect(kernel.status(UiModule)).toBe('failed');
    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(kernel.status(PaymentsModule)).toBe('failed');
  });

  it('C6: a duplicate provider surfaces at activation with its own spec-quoted message, unwrapped', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: PaymentsModule,
          providers: () => [
            provide(PaymentGatewayToken, { factory: (): PaymentGateway => ({ charge: async () => 'a' }) }),
          ],
        }),
        defineModule({
          id: OrdersModule,
          dependsOn: [PaymentsModule],
          providers: () => [
            provide(PaymentGatewayToken, { factory: (): PaymentGateway => ({ charge: async () => 'b' }) }),
          ],
        }),
      ],
    });

    await expect(kernel.activate(OrdersModule)).rejects.toThrow(
      "Token 'payments/PaymentGateway' is already provided by 'payments'; 'orders' cannot provide it again.",
    );
    expect(kernel.status(OrdersModule)).toBe('failed');
  });

  it('kernel.activate() rejects for a ref this kernel never registered', async () => {
    const kernel = createKernel({ modules: [defineModule({ id: AuthModule })] });
    await expect(kernel.activate(OrdersModule)).rejects.toThrow(
      "kernel.activate(): module 'orders' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
    );
  });
});

describe('kernel activation — A3 timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A3: the timeout covers the providers thunk, not only init', async () => {
    vi.useFakeTimers();
    const init = vi.fn();
    const kernel = createKernel({
      initTimeoutMs: 10_000,
      modules: [
        defineModule({
          id: OrdersModule,
          providers: () =>
            new Promise<AnyProviderRecord[]>((resolve) => {
              setTimeout(() => resolve([provide(MaxRetriesToken, { factory: () => 1 })]), 30_000);
            }),
          init,
        }),
      ],
    });

    const activation = kernel.activate(OrdersModule);
    const assertion = expect(activation).rejects.toThrow(
      "Activating module 'orders' did not complete within 10000ms. The timeout covers the providers " +
        'thunk and init(ctx). Raise it with createKernel({ initTimeoutMs }), or move the slow work out ' +
        'of init() and into the service that needs it.',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(init).toHaveBeenCalledTimes(0);
  });

  it('A3: an init that outlives initTimeoutMs fails the module with ActivationTimeoutError', async () => {
    vi.useFakeTimers();
    const kernel = createKernel({
      initTimeoutMs: 5_000,
      modules: [
        defineModule({
          id: OrdersModule,
          init: () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 60_000);
            }),
        }),
      ],
    });

    const activation = kernel.activate(OrdersModule);
    const assertion = expect(activation).rejects.toBeInstanceOf(ActivationTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(kernel.status(OrdersModule)).toBe('failed');
  });

  it('A3: an init that resolves after the timeout does not resurrect the failed module', async () => {
    vi.useFakeTimers();
    let releaseInit!: () => void;
    const kernel = createKernel({
      initTimeoutMs: 5_000,
      modules: [
        defineModule({
          id: OrdersModule,
          init: () =>
            new Promise<void>((resolve) => {
              releaseInit = resolve;
            }),
        }),
      ],
    });
    const seen: ModuleStatus[] = [];
    kernel.subscribeStatus(OrdersModule, (status) => void seen.push(status));

    const assertion = expect(kernel.activate(OrdersModule)).rejects.toBeInstanceOf(ActivationTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(kernel.status(OrdersModule)).toBe('failed');

    // The late completion is dropped on the floor.
    releaseInit();
    await flushMicrotasks();
    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(seen).toEqual(['activating', 'failed']);
  });

  it('A3: a late init *rejection* after a timeout is reported, not thrown as an unhandled rejection', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let rejectInit!: (error: unknown) => void;
    const kernel = createKernel({
      initTimeoutMs: 5_000,
      onError,
      modules: [
        defineModule({
          id: OrdersModule,
          init: () =>
            new Promise<void>((_resolve, reject) => {
              rejectInit = reject;
            }),
        }),
      ],
    });

    const assertion = expect(kernel.activate(OrdersModule)).rejects.toBeInstanceOf(ActivationTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    rejectInit(new Error('too late'));
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as ModuleActivationError).message).toBe(
      "Activating module 'orders' failed in its init(ctx): too late",
    );
    expect(kernel.status(OrdersModule)).toBe('failed');
  });

  it('A3: each dependency gets its own timeout budget rather than sharing one', async () => {
    vi.useFakeTimers();
    const slowInit = (): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 4_000);
      });
    const kernel = createKernel({
      initTimeoutMs: 5_000,
      modules: [
        defineModule({ id: AuthModule, init: slowInit }),
        defineModule({ id: PaymentsModule, dependsOn: [AuthModule], init: slowInit }),
        defineModule({ id: OrdersModule, dependsOn: [PaymentsModule], init: slowInit }),
      ],
    });

    const activation = kernel.activate(OrdersModule);
    // 12 s of wall clock across three modules, none of which exceeds 5 s.
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(activation).resolves.toBeUndefined();
    expect(kernel.status(OrdersModule)).toBe('ready');
  });
});

describe('kernel activation — the container hand-off (C4, C9)', () => {
  it('C9: activation registers the module providers under kernel-assigned provenance', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: PaymentsModule,
          providers: () => [
            provide(PaymentGatewayToken, {
              scope: 'module',
              factory: (): PaymentGateway => ({ charge: async () => 'ok' }),
            }),
            contribute(AnalyticsSinkToken, {
              deps: [MODULE_ID],
              factory: (source): AnalyticsSink => ({ source, record: () => {} }),
            }),
          ],
        }),
      ],
    });

    await kernel.activate(PaymentsModule);
    expect(kernel.inspect().providers).toEqual([
      {
        token: 'payments/PaymentGateway',
        kind: 'provide',
        scope: 'module',
        owner: 'payments',
        override: false,
      },
      {
        token: 'telemetry/AnalyticsSink',
        kind: 'contribute',
        scope: 'singleton',
        owner: 'payments',
        override: false,
      },
    ]);
    // C9 is kernel-assigned, and the collection resolves each contribution
    // on behalf of its own owner.
    expect(kernel.getAll(AnalyticsSinkToken).map((sink) => sink.source)).toEqual(['payments']);
  });

  it('C4/L1: ctx.get inside init resolves with the activating module as resolution context', async () => {
    let seenFromOrders: string | undefined;
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AuthModule,
          providers: () => [
            provide(StorageRootToken, { deps: [MODULE_ID], factory: (id) => `/data/${id}` }),
          ],
        }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule],
          init: (ctx) => {
            seenFromOrders = ctx.get(StorageRootToken);
            expect(ctx.moduleId).toBe('orders');
          },
        }),
      ],
    });

    await kernel.activate(OrdersModule);
    // ADR-2/C4: 'orders' started the chain, so MODULE_ID is 'orders' — not
    // 'auth' (the provider's owner) and not 'app'.
    expect(seenFromOrders).toBe('/data/orders');
    expect(kernel.get(StorageRootToken)).toBe('/data/orders');
  });

  it('L2: effects registered in init run immediately and survive until teardown', async () => {
    const started: string[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => {
              started.push('sync-pending-orders');
              return () => started.push('cleared');
            });
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(OrdersModule);
    expect(started).toEqual(['sync-pending-orders']);
    await kernel.disposeModule('orders');
    expect(started).toEqual(['sync-pending-orders', 'cleared']);
  });
});

describe('kernel teardown sequencing — L3, L4, C7', () => {
  /**
   * The whole L3 sequence in one assertion. Steps 3 and 4 —
   * `disposeModuleScope` before `withdraw` — are separate container
   * primitives and neither calls the other, so the kernel is the only place
   * this order exists; `withdraw` is observed through the C5 notification it
   * fires, which is what makes its position visible at all.
   */
  it('L3: cleanups (reverse order), then dispose(ctx), then module-scoped instances, then the withdrawal', async () => {
    const sequence: string[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: TelemetryModule,
          providers: () => [
            contribute(TeardownProbeToken, {
              scope: 'module',
              deps: [MODULE_ID],
              factory: (id): TeardownProbe => ({
                id,
                disposed: false,
                dispose(): void {
                  this.disposed = true;
                  sequence.push('instance-dispose');
                },
              }),
            }),
          ],
          init: (ctx) => {
            ctx.effect(() => () => void sequence.push('cleanup-1'));
            ctx.effect(() => () => void sequence.push('cleanup-2'));
          },
          dispose: () => void sequence.push('dispose-handler'),
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(TelemetryModule);
    // Construct the module-scoped instance so there is something to dispose.
    expect(kernel.getAll(TeardownProbeToken).map((probe) => probe.id)).toEqual(['telemetry']);

    let disposedWhenNotified: boolean | undefined;
    const probe = kernel.getAll(TeardownProbeToken)[0];
    kernel.container.subscribeAll(TeardownProbeToken, () => {
      disposedWhenNotified = probe?.disposed;
      sequence.push('withdraw-notify');
    });

    await kernel.disposeModule('telemetry');

    expect(sequence).toEqual([
      'cleanup-2',
      'cleanup-1',
      'dispose-handler',
      'instance-dispose',
      'withdraw-notify',
    ]);
    // C5's invariant: instances are disposed before subscribers are told.
    expect(disposedWhenNotified).toBe(true);
    expect(kernel.getAll(TeardownProbeToken)).toEqual([]);
    expect(kernel.status(TelemetryModule)).toBe('disposed');
    expect(kernel.inspect().providers).toEqual([]);
  });

  it('L3: a cleanup that throws is reported and the remaining cleanups still run', async () => {
    const onError = vi.fn();
    const ran: string[] = [];
    const kernel = createKernel({
      onError,
      modules: [
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => () => void ran.push('first'));
            ctx.effect(() => () => {
              throw new Error('unsubscribe failed');
            });
            ctx.effect(() => () => void ran.push('third'));
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');

    expect(ran).toEqual(['third', 'first']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('unsubscribe failed');
    expect(kernel.status(OrdersModule)).toBe('disposed');
  });

  it('ADR-1: an async dispose(ctx) that overruns disposeTimeoutMs is reported and does not block teardown', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const kernel = createKernel({
        onError,
        disposeTimeoutMs: 2_000,
        modules: [
          defineModule({
            id: OrdersModule,
            dispose: () =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, 30_000);
              }),
          }),
        ],
      }) as KernelImpl;

      await kernel.activate(OrdersModule);
      const teardown = kernel.disposeModule('orders');
      await vi.advanceTimersByTimeAsync(2_000);
      await teardown;

      expect(kernel.status(OrdersModule)).toBe('disposed');
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
        "dispose(ctx) for module 'orders' did not complete within 2000ms. The module is marked disposed " +
          'regardless; the dispose call may still be running in the background.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('L3: a dispose(ctx) handler that throws is reported and teardown still completes', async () => {
    const onError = vi.fn();
    const kernel = createKernel({
      onError,
      modules: [
        defineModule({
          id: OrdersModule,
          dispose: () => {
            throw new Error('dispose blew up');
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');
    expect(kernel.status(OrdersModule)).toBe('disposed');
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('dispose blew up');
  });

  it('L4: the ctx handed to init is dead after teardown, on every member', async () => {
    let captured: ModuleContext | undefined;
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            captured = ctx;
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(OrdersModule);
    const ctx = captured as ModuleContext;
    expect(ctx.moduleId).toBe('orders');

    await kernel.disposeModule('orders');

    const expected =
      "ModuleContext for 'orders' is dead: the module has been disposed. " +
      'This usually means code is holding a stale closure across HMR.';
    expect(() => ctx.moduleId).toThrow(expected);
    expect(() => ctx.get(MaxRetriesToken)).toThrow(expected);
    expect(() => ctx.getAll(AnalyticsSinkToken)).toThrow(expected);
    expect(() => ctx.effect(() => {})).toThrow(expected);
    expect(() => ctx.on((_e: string, _h: () => void) => () => {}, 'x', () => {})).toThrow(expected);
  });

  it('L4: the dispose(ctx) handler still gets a live context — it dies only afterwards', async () => {
    let aliveInDispose: string | undefined;
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          dispose: (ctx) => {
            aliveInDispose = ctx.moduleId;
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');
    expect(aliveInDispose).toBe('orders');
  });

  it('L3: disposeModule is a no-op for a module that was never activated', async () => {
    const dispose = vi.fn();
    const kernel = createKernel({
      modules: [defineModule({ id: OrdersModule, dispose })],
    }) as KernelImpl;

    await kernel.disposeModule('orders');
    expect(dispose).toHaveBeenCalledTimes(0);
    expect(kernel.status(OrdersModule)).toBe('registered');
  });
});
