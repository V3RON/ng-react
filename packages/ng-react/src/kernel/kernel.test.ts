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
import type { ModuleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import type { AnyProviderRecord } from '../provider';
import { createToken, MODULE_ID } from '../token';
import type { ErrorInfo, ErrorSink, ModuleContext, ModuleStatus } from '../types';
import { ErrorSinkToken } from './failure';
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

/** One `ErrorSink.report` call, captured. */
interface SinkReport {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/**
 * F4: a module whose only job is to contribute a recording `ErrorSink`.
 *
 * A module and not a raw `contribute` call, because that is the only way a
 * sink can exist: `ErrorSinkToken` is a contribution collection and the
 * kernel assigns provenance from the activating descriptor (C9). It also
 * makes the "skip sinks in failed/disposed modules" rule testable — the
 * sink has an owner whose status can change.
 */
function sinkModule(id: ModuleRef, reports: SinkReport[]): ModuleDescriptor {
  return defineModule({
    id,
    providers: () => [
      contribute(ErrorSinkToken, {
        factory: (): ErrorSink => ({
          report: (error, info) => void reports.push({ error, info }),
        }),
      }),
    ],
  });
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
        "'app' identifies resolutions started outside any module. Choose a different module id.",
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
    // **H5/G3**: `resolutionGraph` is present because a kernel with no
    // explicit `dev` option is a dev kernel under vitest — empty, because
    // nothing has resolved anything. `inspect().test.ts`'s G3 coverage and
    // `resolution-cascade.test.ts` pin the present/absent pair directly.
    expect(kernel.inspect()).toEqual({
      modules: [],
      edges: [],
      providers: [],
      contributions: [],
      resolutionGraph: [],
    });
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

describe('kernel lifecycle surface — unregistered refs', () => {
  it('A4/F3: deactivate and retry reject for a ref this kernel never registered', async () => {
    const kernel = createKernel({ modules: [defineModule({ id: AuthModule })] });
    await expect(kernel.deactivate(OrdersModule)).rejects.toThrow(
      "kernel.deactivate(): module 'orders' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
    );
    await expect(kernel.retry(OrdersModule)).rejects.toThrow(
      "kernel.retry(): module 'orders' is not registered with this kernel. " +
        'Add its descriptor to the composition root.',
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
    // `onFatal` is supplied, not because this test is about it (the next
    // describe block covers F2 properly) but because its *default* is to
    // rethrow from a macrotask, which would surface as an uncaught
    // exception in the run rather than in this test.
    const onFatal = vi.fn();
    const kernel = createKernel({
      onFatal,
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

  it('A3/F4: a late init *rejection* after a timeout reaches the error sinks, not an unhandled rejection', async () => {
    vi.useFakeTimers();
    const reports: SinkReport[] = [];
    let rejectInit!: (error: unknown) => void;
    const kernel = createKernel({
      initTimeoutMs: 5_000,
      modules: [
        sinkModule(TelemetryModule, reports),
        defineModule({
          id: OrdersModule,
          init: () =>
            new Promise<void>((_resolve, reject) => {
              rejectInit = reject;
            }),
        }),
      ],
    });
    await kernel.activate(TelemetryModule);

    const assertion = expect(kernel.activate(OrdersModule)).rejects.toBeInstanceOf(ActivationTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    // The timeout itself is an activation failure and is reported too (F1).
    reports.length = 0;

    rejectInit(new Error('too late'));
    await flushMicrotasks();
    expect(reports).toHaveLength(1);
    expect((reports[0]?.error as ModuleActivationError).message).toBe(
      "Activating module 'orders' failed in its init(ctx): too late",
    );
    expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'init' });
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
   * `disposeModuleInstances` before `withdraw` — are separate container
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

  it('L3/F4: a cleanup that throws reaches the error sinks and the remaining cleanups still run', async () => {
    const reports: SinkReport[] = [];
    const ran: string[] = [];
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, reports),
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

    await kernel.activate(TelemetryModule);
    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');

    expect(ran).toEqual(['third', 'first']);
    expect(reports).toHaveLength(1);
    expect((reports[0]?.error as Error).message).toBe('unsubscribe failed');
    expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'cleanup' });
    expect(kernel.status(OrdersModule)).toBe('disposed');
  });

  it('ADR-1: an async dispose(ctx) that overruns disposeTimeoutMs is reported and does not block teardown', async () => {
    vi.useFakeTimers();
    try {
      const reports: SinkReport[] = [];
      const kernel = createKernel({
        disposeTimeoutMs: 2_000,
        modules: [
          sinkModule(TelemetryModule, reports),
          defineModule({
            id: OrdersModule,
            dispose: () =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, 30_000);
              }),
          }),
        ],
      }) as KernelImpl;

      await kernel.activate(TelemetryModule);
      await kernel.activate(OrdersModule);
      const teardown = kernel.disposeModule('orders');
      await vi.advanceTimersByTimeAsync(2_000);
      await teardown;

      expect(kernel.status(OrdersModule)).toBe('disposed');
      expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'dispose' });
      expect((reports[0]?.error as Error).message).toBe(
        "dispose(ctx) for module 'orders' did not complete within 2000ms. The module is marked disposed " +
          'regardless; the dispose call may still be running in the background.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('L3/F4: a dispose(ctx) handler that throws reaches the error sinks and teardown still completes', async () => {
    const reports: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, reports),
        defineModule({
          id: OrdersModule,
          dispose: () => {
            throw new Error('dispose blew up');
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(TelemetryModule);
    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');
    expect(kernel.status(OrdersModule)).toBe('disposed');
    expect((reports[0]?.error as Error).message).toBe('dispose blew up');
    expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'dispose' });
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

// ===========================================================================
// Task 3.3 — the deactivation cascade (A4) and the failure policy (F1-F4).
// ===========================================================================

/** A module-scoped service whose *identity* is the thing under test. */
interface OrderDraftStore {
  readonly owner: string;
  readonly serial: number;
  disposed: boolean;
  dispose(): void;
}

const OrderDraftStoreToken = createToken<OrderDraftStore>('orders/DraftStore');
const RouteContributionToken = createToken<{ readonly path: string }>('nav/Route');

const AdminModule = moduleRef('admin');

describe('kernel deactivation — A4', () => {
  /**
   * The diamond, with `dependsOn` arrows pointing at dependencies:
   *
   *   ui → orders → auth
   *   ui → telemetry → auth
   *
   * so `auth` is the base and `ui` is the top. Deactivating `auth` must
   * dispose `ui`, then `telemetry`, then `orders`, then `auth` — dependents
   * first, in reverse topological order, target last.
   */
  function diamond(sequence: string[]): ModuleDescriptor[] {
    const record = (id: string): ModuleDescriptor =>
      defineModule({
        id: id === 'auth' ? AuthModule : id === 'orders' ? OrdersModule : id === 'telemetry' ? TelemetryModule : UiModule,
        dependsOn:
          id === 'auth'
            ? []
            : id === 'ui'
              ? [OrdersModule, TelemetryModule]
              : [AuthModule],
        dispose: () => void sequence.push(id),
      });
    return [record('auth'), record('orders'), record('telemetry'), record('ui')];
  }

  it('A4: disposes every transitive dependent before the target, in exact reverse topological order', async () => {
    const sequence: string[] = [];
    const kernel = createKernel({ modules: diamond(sequence) });
    await kernel.activate(UiModule);
    expect(kernel.inspect().modules.map((row) => row.id)).toEqual(['auth', 'orders', 'telemetry', 'ui']);

    await kernel.deactivate(AuthModule);

    // The exact sequence, not set membership: 'all four were disposed'
    // passes for every wrong order, including the one that disposes the
    // target first.
    expect(sequence).toEqual(['ui', 'telemetry', 'orders', 'auth']);
    expect(kernel.inspect().modules.map((row) => row.status)).toEqual([
      'disposed',
      'disposed',
      'disposed',
      'disposed',
    ]);
  });

  it('A4: disposing a leaf leaves its dependencies alone', async () => {
    const sequence: string[] = [];
    const kernel = createKernel({ modules: diamond(sequence) });
    await kernel.activate(UiModule);

    await kernel.deactivate(UiModule);

    expect(sequence).toEqual(['ui']);
    expect(kernel.status(UiModule)).toBe('disposed');
    expect(kernel.status(OrdersModule)).toBe('ready');
    expect(kernel.status(TelemetryModule)).toBe('ready');
    expect(kernel.status(AuthModule)).toBe('ready');
  });

  it('A4: deactivating an inactive module is a no-op — registered, and already disposed', async () => {
    const sequence: string[] = [];
    const kernel = createKernel({ modules: diamond(sequence) });

    // Never activated.
    await kernel.deactivate(OrdersModule);
    expect(sequence).toEqual([]);
    expect(kernel.status(OrdersModule)).toBe('registered');

    await kernel.activate(OrdersModule);
    await kernel.deactivate(OrdersModule);
    expect(sequence).toEqual(['orders']);

    // Already disposed: nothing runs a second time.
    await kernel.deactivate(OrdersModule);
    expect(sequence).toEqual(['orders']);
    expect(kernel.status(AuthModule)).toBe('ready');
  });

  it('A4: deactivation is single-flight — concurrent calls await one cascade', async () => {
    const sequence: string[] = [];
    const kernel = createKernel({ modules: diamond(sequence) });
    await kernel.activate(UiModule);

    const [first, second] = [kernel.deactivate(AuthModule), kernel.deactivate(AuthModule)];
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(sequence).toEqual(['ui', 'telemetry', 'orders', 'auth']);
  });

  it('A4: a re-activated module gets a fresh context and a *different* module-scoped instance', async () => {
    let serial = 0;
    const contexts: ModuleContext[] = [];
    const captured: OrderDraftStore[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          providers: () => [
            provide(OrderDraftStoreToken, {
              scope: 'module',
              deps: [MODULE_ID],
              factory: (owner): OrderDraftStore => {
                serial += 1;
                return {
                  owner,
                  serial,
                  disposed: false,
                  dispose(): void {
                    this.disposed = true;
                  },
                };
              },
            }),
          ],
          init: (ctx) => {
            contexts.push(ctx);
            // C4/ADR-2: resolved through the module's own ctx, so MODULE_ID
            // is 'orders'. `kernel.get` would see the requester 'app' — the
            // *instance* is the same either way, because module scope is
            // keyed by the provider's owner (C2).
            captured.push(ctx.get(OrderDraftStoreToken));
          },
        }),
      ],
    });

    await kernel.activate(OrdersModule);
    const before = kernel.get(OrderDraftStoreToken);
    expect(before).toBe(captured[0]);
    expect(before).toMatchObject({ owner: 'orders', serial: 1, disposed: false });

    await kernel.deactivate(OrdersModule);
    expect(before.disposed).toBe(true);
    // The provider record is gone with the module (C5/F3 withdrawal).
    expect(kernel.inspect().providers).toEqual([]);

    await kernel.activate(OrdersModule);
    const after = kernel.get(OrderDraftStoreToken);

    // Not merely "activation succeeded": a *different object*.
    expect(after).not.toBe(before);
    expect(after).toBe(captured[1]);
    expect(after.serial).toBe(2);
    expect(after.owner).toBe('orders');
    expect(after.disposed).toBe(false);
    // A fresh context, and the old one stays dead (L4).
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(() => contexts[0]?.moduleId).toThrow(
      "ModuleContext for 'orders' is dead: the module has been disposed. " +
        'This usually means code is holding a stale closure across HMR.',
    );
    expect(contexts[1]?.moduleId).toBe('orders');
    expect(kernel.status(OrdersModule)).toBe('ready');
  });

  it('A4: a quarantined dependent keeps its failed status and its retained error, rather than being relabelled disposed', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({ id: AuthModule }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule],
          init: () => {
            throw new Error('draft store unavailable');
          },
        }),
      ],
    });
    await expect(kernel.activate(OrdersModule)).rejects.toThrow();
    expect(kernel.status(OrdersModule)).toBe('failed');

    await kernel.deactivate(AuthModule);

    expect(kernel.status(AuthModule)).toBe('disposed');
    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(kernel.inspect().modules.find((row) => row.id === 'orders')?.error?.message).toBe(
      "Activating module 'orders' failed in its init(ctx): draft store unavailable",
    );
  });
});

describe('kernel provider lifetimes across deactivation — H4, C6 (#34, #37)', () => {
  it('H4/#34: a module-owned singleton is disposed on deactivation, and re-activation constructs exactly ONE new instance', async () => {
    // Issue #34's reproduction verbatim: activate → deactivate → activate,
    // counting constructions and disposals. Before the fix this printed
    // `built=2 disposed=[]` — a second live "app-lifetime singleton" with
    // the first still cached, undisposed and unreachable.
    interface SessionStore {
      readonly id: number;
      readonly touched: string[];
    }
    const StoreToken = createToken<SessionStore>('auth/SessionStore');
    const built: number[] = [];
    const disposed: number[] = [];
    let next = 0;
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AuthModule,
          providers: () => [
            provide(StoreToken, {
              scope: 'singleton',
              factory: (): SessionStore => {
                next += 1;
                built.push(next);
                return { id: next, touched: [] };
              },
              onDispose: (instance) => void disposed.push(instance.id),
            }),
          ],
          init: (ctx) => void ctx.get(StoreToken),
        }),
      ],
    });

    await kernel.activate(AuthModule);
    expect([built.length, disposed]).toEqual([1, []]);

    await kernel.deactivate(AuthModule);
    expect([built.length, disposed]).toEqual([1, [1]]);

    await kernel.activate(AuthModule);
    expect([built.length, disposed]).toEqual([2, [1]]);
    // The fresh instance is the one that is reachable — not the stale one.
    expect(kernel.get(StoreToken).id).toBe(2);
  });

  it('H4/#34: a singleton owned by a module that is NOT deactivated survives its consumer’s teardown', async () => {
    // The other half of the lifetime rule: ownership decides, not use. A
    // fix that keyed disposal off the resolving module would pass the test
    // above and break this one.
    const disposals: string[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AuthModule,
          providers: () => [
            provide(SessionClockToken, {
              scope: 'singleton',
              factory: (): SessionClock => ({ now: () => 1 }),
              onDispose: () => void disposals.push('clock'),
            }),
          ],
        }),
        defineModule({
          id: OrdersModule,
          dependsOn: [AuthModule],
          init: (ctx) => void ctx.get(SessionClockToken),
        }),
      ],
    });
    await kernel.activate(OrdersModule);
    const beforeTeardown = kernel.get(SessionClockToken);

    await kernel.deactivate(OrdersModule);

    expect(disposals).toEqual([]);
    expect(kernel.status(AuthModule)).toBe('ready');
    // Same instance: 'auth' never went away, so neither did its singleton.
    expect(kernel.get(SessionClockToken)).toBe(beforeTeardown);
  });

  it('C6/#37: a plain provide losing to an override is superseded, not fatal — the overridden module reaches `ready` in either registration order', async () => {
    // Issue #37's reproduction. Before the fix, order A ended
    // `A payments status = failed`: mocking `payments/PaymentGateway`
    // killed `payments`, the module the mock exists *for* (acceptance
    // criterion 7).
    const mocksRef = moduleRef('mocks');
    const real = (): PaymentGateway => ({ charge: async () => 'real' });
    const mock = (): PaymentGateway => ({ charge: async () => 'mock' });
    const mocks = defineModule({
      id: mocksRef,
      providers: () => [provide(PaymentGatewayToken, { override: true, factory: mock })],
    });
    const payments = defineModule({
      id: PaymentsModule,
      providers: () => [provide(PaymentGatewayToken, { factory: real })],
    });

    // Order A — the override registers first.
    const overrideFirst = createKernel({ modules: [mocks, payments] });
    await overrideFirst.activate(mocksRef);
    await expect(overrideFirst.activate(PaymentsModule)).resolves.toBeUndefined();
    expect(overrideFirst.status(PaymentsModule)).toBe('ready');
    expect(overrideFirst.ownerOf(PaymentGatewayToken)).toBe('mocks');
    expect(await overrideFirst.get(PaymentGatewayToken).charge(1)).toBe('mock');

    // Order B — the real module registers first. Unchanged by #37, asserted
    // here so the two orders are pinned as one behaviour, not two.
    const realFirst = createKernel({ modules: [mocks, payments] });
    await realFirst.activate(PaymentsModule);
    await expect(realFirst.activate(mocksRef)).resolves.toBeUndefined();
    expect(realFirst.status(PaymentsModule)).toBe('ready');
    expect(realFirst.ownerOf(PaymentGatewayToken)).toBe('mocks');
    expect(await realFirst.get(PaymentGatewayToken).charge(1)).toBe('mock');

    // G3: the superseded row is visible, and identical in both orders.
    const superseded = {
      token: 'payments/PaymentGateway',
      kind: 'provide',
      scope: 'singleton',
      owner: 'payments',
      override: false,
      overriddenBy: 'mocks',
    };
    expect(overrideFirst.inspect().providers).toContainEqual(superseded);
    expect(realFirst.inspect().providers).toContainEqual(superseded);
  });
});

describe('kernel failure policy — F1, F2', () => {
  it('F1: the retained error is readable through status, inspect() and a status subscription', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          init: () => {
            throw new Error('draft store unavailable');
          },
        }),
      ],
    });
    const seen: ModuleStatus[] = [];
    kernel.subscribeStatus(OrdersModule, (status) => void seen.push(status));

    await expect(kernel.activate(OrdersModule)).rejects.toThrow(
      "Activating module 'orders' failed in its init(ctx): draft store unavailable",
    );

    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(seen).toEqual(['activating', 'failed']);
    expect(kernel.inspect().modules.find((row) => row.id === 'orders')?.error).toEqual({
      name: 'ModuleActivationError',
      code: 'KERNEL_ACTIVATION_FAILED',
      message: "Activating module 'orders' failed in its init(ctx): draft store unavailable",
    });
  });

  it('F2: a critical startup failure rejects whenStartupComplete *and* calls onFatal with the same error', async () => {
    const onFatal = vi.fn();
    const kernel = createKernel({
      onFatal,
      modules: [
        defineModule({
          id: AuthModule,
          load: 'eager',
          critical: true,
          init: () => {
            throw new Error('no keychain');
          },
        }),
        defineModule({ id: TelemetryModule, load: 'eager' }),
      ],
    });

    const startup = kernel.whenStartupComplete();
    await expect(startup).rejects.toThrow("Activating module 'auth' failed in its init(ctx): no keychain");
    await flushMicrotasks();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const [fatal] = onFatal.mock.calls[0] as [Error];
    await expect(startup).rejects.toBe(fatal);
    // Startup is over: the pass does not go on to the remaining eager modules.
    expect(kernel.status(TelemetryModule)).toBe('registered');
  });

  it('F2: a *non*-critical eager failure never reaches onFatal', async () => {
    const onFatal = vi.fn();
    const kernel = createKernel({
      onFatal,
      modules: [
        defineModule({
          id: AdminModule,
          load: 'eager',
          init: () => {
            throw new Error('sink unavailable');
          },
        }),
      ],
    });

    // A3: with no eager *critical* module, `whenStartupComplete` resolves
    // immediately, so it is not a barrier for the eager pass — draining the
    // microtask queue is.
    await kernel.whenStartupComplete();
    await flushMicrotasks();
    expect(kernel.status(AdminModule)).toBe('failed');
    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('kernel failure policy — F3 quarantine', () => {
  it('F3: a failed module has its providers withdrawn, and subscribeAll subscribers are notified', async () => {
    const notified: (readonly { readonly path: string }[])[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AdminModule,
          providers: () => [contribute(RouteContributionToken, { factory: () => ({ path: '/admin' }) })],
        }),
        defineModule({
          id: OrdersModule,
          providers: () => [
            provide(OrderDraftStoreToken, {
              scope: 'module',
              deps: [MODULE_ID],
              factory: (owner): OrderDraftStore => ({
                owner,
                serial: 0,
                disposed: false,
                dispose(): void {
                  this.disposed = true;
                },
              }),
            }),
            contribute(RouteContributionToken, { factory: () => ({ path: '/orders' }) }),
          ],
          init: (ctx) => {
            // The provider is live at this point — the failure happens after
            // registration, which is what makes the withdrawal observable.
            expect(ctx.get(OrderDraftStoreToken).owner).toBe('orders');
            throw new Error('draft store unavailable');
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(AdminModule);
    kernel.container.subscribeAll(RouteContributionToken, (routes) => void notified.push(routes));

    await expect(kernel.activate(OrdersModule)).rejects.toThrow();

    expect(kernel.status(OrdersModule)).toBe('failed');
    // Withdrawn: nothing 'orders' registered survives quarantine.
    expect(kernel.inspect().providers.map((row) => row.owner)).toEqual(['admin']);
    expect(() => kernel.get(OrderDraftStoreToken)).toThrow(ResolutionError);
    // C5 reactivity: this is what lets a navigation module drop routes on
    // its own, with no kernel knowledge of routes.
    expect(notified).toEqual([
      // 'orders' registering its contribution, then quarantine withdrawing it.
      [{ path: '/admin' }, { path: '/orders' }],
      [{ path: '/admin' }],
    ]);
    expect(kernel.getAll(RouteContributionToken)).toEqual([{ path: '/admin' }]);
  });

  it('F3: cleanups registered by a partial init still run during quarantine', async () => {
    const ran: string[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => {
              ran.push('subscribe-bus');
              return () => void ran.push('unsubscribe-bus');
            });
            ctx.effect(() => {
              ran.push('start-timer');
              return () => void ran.push('clear-timer');
            });
            throw new Error('draft store unavailable');
          },
        }),
      ],
    });

    await expect(kernel.activate(OrdersModule)).rejects.toThrow();

    // Both cleanups, in reverse registration order (L3) — the module never
    // reached `ready`, so a status-driven teardown would skip it entirely
    // and leak the subscription and the timer.
    expect(ran).toEqual(['subscribe-bus', 'start-timer', 'clear-timer', 'unsubscribe-bus']);
  });

  it("F3: a quarantined module's module-scoped instances are disposed", async () => {
    let store: OrderDraftStore | undefined;
    const kernel = createKernel({
      modules: [
        defineModule({
          id: OrdersModule,
          providers: () => [
            provide(OrderDraftStoreToken, {
              scope: 'module',
              deps: [MODULE_ID],
              factory: (owner): OrderDraftStore => ({
                owner,
                serial: 0,
                disposed: false,
                dispose(): void {
                  this.disposed = true;
                },
              }),
            }),
          ],
          init: (ctx) => {
            store = ctx.get(OrderDraftStoreToken);
            throw new Error('draft store unavailable');
          },
        }),
      ],
    });

    await expect(kernel.activate(OrdersModule)).rejects.toThrow();
    expect(store?.disposed).toBe(true);
  });

  it('F3: a dependent fails with a cause chain naming the quarantined module', async () => {
    const kernel = createKernel({
      modules: [
        defineModule({
          id: PaymentsModule,
          init: () => {
            throw new Error('gateway offline');
          },
        }),
        defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
      ],
    });

    try {
      await kernel.activate(OrdersModule);
      expect.unreachable('expected DependencyActivationError');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyActivationError);
      expect((error as Error).message).toBe(
        "Module 'orders' cannot activate: its dependency 'payments' failed to activate. " +
          "Fix 'payments' and call kernel.retry() for it, or remove it from 'orders's dependsOn.",
      );
      expect((error as DependencyActivationError).dependencyId).toBe('payments');
      const cause = (error as Error).cause as ModuleActivationError;
      expect(cause).toBeInstanceOf(ModuleActivationError);
      expect(cause.message).toBe("Activating module 'payments' failed in its init(ctx): gateway offline");
      expect((cause.cause as Error).message).toBe('gateway offline');
    }
    expect(kernel.status(OrdersModule)).toBe('failed');
    expect(kernel.status(PaymentsModule)).toBe('failed');
  });

  it('F3: retry re-activates from a clean slate, and the dependent can then be retried too', async () => {
    let gatewayIsOffline = true;
    const initCount = vi.fn();
    const kernel = createKernel({
      modules: [
        defineModule({
          id: PaymentsModule,
          providers: () => [
            provide(PaymentGatewayToken, {
              factory: (): PaymentGateway => ({ charge: () => Promise.resolve('ch_1') }),
            }),
          ],
          init: () => {
            initCount();
            if (gatewayIsOffline) {
              throw new Error('gateway offline');
            }
          },
        }),
        defineModule({ id: OrdersModule, dependsOn: [PaymentsModule] }),
      ],
    });

    await expect(kernel.activate(OrdersModule)).rejects.toBeInstanceOf(DependencyActivationError);
    expect(kernel.inspect().providers).toEqual([]);

    // Retrying the dependent while the dependency is still broken fails
    // again, with the same honest cause chain.
    await expect(kernel.retry(OrdersModule)).rejects.toBeInstanceOf(DependencyActivationError);
    // Retry is per-module: it clears *this* module's quarantine, and A1 then
    // finds the dependency still `failed` and rejects with its retained
    // error rather than silently re-running the broken init.
    expect(initCount).toHaveBeenCalledTimes(1);

    gatewayIsOffline = false;
    await kernel.retry(PaymentsModule);
    expect(kernel.status(PaymentsModule)).toBe('ready');
    expect(kernel.inspect().modules.find((row) => row.id === 'payments')?.error).toBeUndefined();
    // Fresh registration: the withdrawal during quarantine is what makes a
    // second `register()` legal at all (DuplicateRegistrationError otherwise).
    expect(kernel.inspect().providers.map((row) => row.token)).toEqual(['payments/PaymentGateway']);

    await kernel.retry(OrdersModule);
    expect(kernel.status(OrdersModule)).toBe('ready');
    expect(initCount).toHaveBeenCalledTimes(2);
  });

  it('F3: activate() does not silently re-attempt a quarantined module — only retry() does', async () => {
    const init = vi.fn(() => {
      throw new Error('draft store unavailable');
    });
    const kernel = createKernel({ modules: [defineModule({ id: OrdersModule, init })] });

    await expect(kernel.activate(OrdersModule)).rejects.toThrow();
    await expect(kernel.activate(OrdersModule)).rejects.toThrow();
    expect(init).toHaveBeenCalledTimes(1);

    await expect(kernel.retry(OrdersModule)).rejects.toThrow();
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe('kernel error reporting — F4', () => {
  it('F4/C9: routes to every contributed sink with kernel-assigned attribution', async () => {
    const first: SinkReport[] = [];
    const second: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, first),
        sinkModule(AdminModule, second),
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => () => {
              throw new Error('unsubscribe failed');
            });
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(TelemetryModule);
    await kernel.activate(AdminModule);
    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');

    for (const reports of [first, second]) {
      expect(reports).toHaveLength(1);
      expect((reports[0]?.error as Error).message).toBe('unsubscribe failed');
      // C9: 'orders' is assigned by the kernel from the module it was
      // tearing down. Neither the failing closure nor the sink said so.
      expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'cleanup' });
    }
  });

  it('F4: an activation failure is reported with phase activate, and the failing module never sees its own report', async () => {
    const observer: SinkReport[] = [];
    const ownSink: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, observer),
        defineModule({
          id: OrdersModule,
          providers: () => [
            contribute(ErrorSinkToken, {
              factory: (): ErrorSink => ({
                report: (error, info) => void ownSink.push({ error, info }),
              }),
            }),
          ],
          init: () => {
            throw new Error('draft store unavailable');
          },
        }),
      ],
    });

    await kernel.activate(TelemetryModule);
    await expect(kernel.activate(OrdersModule)).rejects.toThrow();

    expect(observer).toHaveLength(1);
    expect((observer[0]?.error as Error).message).toBe(
      "Activating module 'orders' failed in its init(ctx): draft store unavailable",
    );
    expect(observer[0]?.info).toEqual({ moduleId: 'orders', phase: 'activate' });
    // The quarantined module's own sink is skipped — it is exactly the code
    // that just proved it cannot be trusted.
    expect(ownSink).toEqual([]);
  });

  it('F4: a sink in a failed or disposed module is skipped, and is never even constructed', async () => {
    const live: SinkReport[] = [];
    const quarantined: SinkReport[] = [];
    const constructed = vi.fn();
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, live),
        defineModule({
          id: AdminModule,
          providers: () => [
            contribute(ErrorSinkToken, {
              factory: (): ErrorSink => {
                constructed();
                return { report: (error, info) => void quarantined.push({ error, info }) };
              },
            }),
          ],
        }),
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => () => {
              throw new Error('unsubscribe failed');
            });
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(TelemetryModule);
    await kernel.activate(AdminModule);
    await kernel.activate(OrdersModule);
    // 'admin' is gone by the time anything is reported.
    await kernel.disposeModule('admin');

    await kernel.disposeModule('orders');

    expect(live).toHaveLength(1);
    expect(quarantined).toEqual([]);
    // The natural bug is to resolve the whole collection and *then* filter
    // by status, which constructs an instance from a disposed module.
    expect(constructed).not.toHaveBeenCalled();
  });

  it('F4: a throwing sink does not stop the other sinks, at kernel level', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survivor: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AdminModule,
          providers: () => [
            contribute(ErrorSinkToken, {
              factory: (): ErrorSink => ({
                report: () => {
                  throw new Error('transport is down');
                },
              }),
            }),
          ],
        }),
        sinkModule(TelemetryModule, survivor),
        defineModule({
          id: OrdersModule,
          init: (ctx) => {
            ctx.effect(() => () => {
              throw new Error('unsubscribe failed');
            });
          },
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(AdminModule);
    await kernel.activate(TelemetryModule);
    await kernel.activate(OrdersModule);
    await kernel.disposeModule('orders');

    expect(survivor).toHaveLength(1);
    expect((survivor[0]?.error as Error).message).toBe('unsubscribe failed');
    expect((consoleError.mock.calls[0]?.[1] as Error).message).toBe('transport is down');
    consoleError.mockRestore();
  });

  it('F4: errors raised before any sink exists are buffered and flushed to the first sink that activates', async () => {
    const reports: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        defineModule({
          id: AdminModule,
          load: 'eager',
          init: () => {
            throw new Error('sink unavailable');
          },
        }),
        sinkModule(TelemetryModule, reports),
      ],
    });

    // Let the eager startup pass fail 'admin'. The sink module is lazy and
    // has not activated, so there is nothing to route to yet.
    await flushMicrotasks();
    expect(kernel.status(AdminModule)).toBe('failed');
    expect(reports).toEqual([]);

    await kernel.activate(TelemetryModule);

    expect(reports).toHaveLength(1);
    expect((reports[0]?.error as Error).message).toBe(
      "Activating module 'admin' failed in its init(ctx): sink unavailable",
    );
    expect(reports[0]?.info).toEqual({ moduleId: 'admin', phase: 'activate' });
  });

  it('F4/ADR-1: the container DisposeTimeoutError finally reaches the sinks', async () => {
    vi.useFakeTimers();
    try {
      const reports: SinkReport[] = [];
      const kernel = createKernel({
        disposeTimeoutMs: 2_000,
        modules: [
          sinkModule(TelemetryModule, reports),
          defineModule({
            id: OrdersModule,
            providers: () => [
              provide(OrderDraftStoreToken, {
                scope: 'module',
                deps: [MODULE_ID],
                factory: (owner): OrderDraftStore => ({
                  owner,
                  serial: 0,
                  disposed: false,
                  dispose(): Promise<void> {
                    return new Promise<void>((resolve) => {
                      setTimeout(resolve, 30_000);
                    });
                  },
                }),
              }),
            ],
            init: (ctx) => void ctx.get(OrderDraftStoreToken),
          }),
        ],
      }) as KernelImpl;

      await kernel.activate(TelemetryModule);
      await kernel.activate(OrdersModule);
      const teardown = kernel.disposeModule('orders');
      await vi.advanceTimersByTimeAsync(2_000);
      await teardown;

      expect(reports).toHaveLength(1);
      expect((reports[0]?.error as Error).message).toBe(
        "Disposing 'orders/DraftStore' (owned by 'orders') did not complete within 2000ms. " +
          'The instance is marked disposed regardless; the dispose call may still be running in the background.',
      );
      // ADR-2/C9: attribution comes from the *owner* of the provider, which
      // only the container knows and only the kernel may assign.
      expect(reports[0]?.info).toEqual({ moduleId: 'orders', phase: 'dispose' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('F4: a subscribeAll subscriber that throws is attributed to app (ADR-2) in the resolve phase', async () => {
    const reports: SinkReport[] = [];
    const kernel = createKernel({
      modules: [
        sinkModule(TelemetryModule, reports),
        defineModule({
          id: AdminModule,
          providers: () => [contribute(RouteContributionToken, { factory: () => ({ path: '/admin' }) })],
        }),
      ],
    }) as KernelImpl;

    await kernel.activate(TelemetryModule);
    // Registered by the composition root, not by a module — which is why
    // there is no honest module attribution for its failure.
    kernel.container.subscribeAll(RouteContributionToken, () => {
      throw new Error('route table rebuild failed');
    });

    await kernel.activate(AdminModule);

    expect(reports).toHaveLength(1);
    expect((reports[0]?.error as Error).message).toBe('route table rebuild failed');
    expect(reports[0]?.info).toEqual({ moduleId: 'app', phase: 'resolve' });
  });
});
