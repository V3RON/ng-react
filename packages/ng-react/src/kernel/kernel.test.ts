import { describe, expect, it, vi } from 'vitest';

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import {
  DependencyCycleError,
  DuplicateModuleIdError,
  InvalidDescriptorError,
  ResolutionError,
  UnknownModuleError,
} from '../errors';
import { moduleRef } from '../module-ref';
import { contribute, provide } from '../provider';
import { createToken, MODULE_ID } from '../token';
import type { ModuleStatus } from '../types';
import { createKernel, KernelImpl } from './kernel';

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

describe('kernel activation surface — task 3.2/3.3 stubs', () => {
  it('activate/deactivate/retry reject with a "not implemented" error naming the task', async () => {
    const kernel = createKernel({ modules: appModules() });
    await expect(kernel.activate(AuthModule)).rejects.toThrow(
      'kernel.activate() is not implemented yet (task 3.2); this kernel only performs registration.',
    );
    await expect(kernel.deactivate(AuthModule)).rejects.toThrow(
      'kernel.deactivate() is not implemented yet (task 3.3); this kernel only performs registration.',
    );
    await expect(kernel.retry(AuthModule)).rejects.toThrow(
      'kernel.retry() is not implemented yet (task 3.3); this kernel only performs registration.',
    );
  });
});
