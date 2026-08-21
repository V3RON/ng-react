// `createTestKernel` — R4, C6, F4, H7, acceptance criteria 7 and 9.
//
// A `.test.ts` file in vitest's **node** project. Nothing here imports
// `react`, and nothing here needs a DOM: that is the machine-checked half of
// acceptance criterion 7's "in a plain Jest/Vitest environment with no React
// renderer" (ADR-6, AGENTS.md §3).

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import { ErrorSinkToken } from '../kernel/failure';
import { createKernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken } from '../token';
import type { ModuleContext } from '../types';
import { evaluationLog, recordEvaluation } from './evaluation-log';
import { createTestKernel } from './test-kernel';

// --- The domain under test -------------------------------------------------
//
// ADR-10 / AGENTS.md §9: realistically and *differently* typed tokens. A
// suite written against `Token<unknown>` everywhere is weaker than reality
// and proves nothing about the erased collections these APIs pass around.

interface PaymentGateway {
  charge(cents: number): string;
}

interface OrderService {
  place(sku: string): string;
}

/** A minimal `on`/`off` emitter — spec §8 L2's first supported shape. */
class SessionBus {
  private readonly handlers = new Map<string, Set<(reason: string) => void>>();

  on(event: string, handler: (reason: string) => void): this {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  off(event: string, handler: (reason: string) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, reason: string): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(reason);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

const GatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');
const OrderServiceToken = createToken<OrderService>('orders/OrderService');
const SessionBusToken = createToken<SessionBus>('auth/SessionBus');
const RetryBudgetToken = createToken<number>('orders/RetryBudget');

const authRef = moduleRef('auth');
const paymentsRef = moduleRef('payments');
const ordersRef = moduleRef('orders');

/** The demo app's shape, per acceptance criterion 1. */
function buildModules(options: {
  readonly bus: SessionBus;
  readonly expirations: string[];
  readonly disposed: string[];
}): readonly ModuleDescriptor[] {
  const auth = defineModule({
    id: authRef,
    load: 'eager',
    critical: true,
    providers: () => [provide(SessionBusToken, { scope: 'singleton', factory: () => options.bus })],
  });

  const payments = defineModule({
    id: paymentsRef,
    load: 'lazy',
    providers: () => [
      provide(GatewayToken, {
        scope: 'module',
        factory: () => ({ charge: (cents: number) => `real:${cents}` }),
      }),
    ],
  });

  const orders = defineModule({
    id: ordersRef,
    dependsOn: [authRef, paymentsRef],
    load: 'lazy',
    providers: () => [
      provide(OrderServiceToken, {
        scope: 'module',
        deps: [GatewayToken],
        factory: (gateway: PaymentGateway) => ({
          place: (sku: string) => `${sku}=${gateway.charge(100)}`,
        }),
        onDispose: () => {
          options.disposed.push('orders/OrderService');
        },
      }),
    ],
    init: (ctx) => {
      ctx.on(ctx.get(SessionBusToken), 'auth/session.expired', (reason: string) => {
        options.expirations.push(reason);
      });
      // Force construction of the module-scoped instance during init.
      ctx.get(OrderServiceToken);
    },
  });

  return [auth, payments, orders];
}

describe('createTestKernel (R4)', () => {
  it('R4: activates orders with a mocked payments/PaymentGateway, runs an init-registered listener, disposes, and proves zero leaked listeners', async () => {
    const bus = new SessionBus();
    const expirations: string[] = [];
    const disposed: string[] = [];

    const kernel = createTestKernel({
      modules: buildModules({ bus, expirations, disposed }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: (cents: number) => `mock:${cents}` }) })],
    });

    await kernel.whenStartupComplete();
    await kernel.activate(ordersRef);

    // The mock won, not payments' own provider (C6).
    expect(kernel.get(OrderServiceToken).place('sku-1')).toBe('sku-1=mock:100');
    expect(kernel.status(ordersRef)).toBe('ready');
    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.errors).toEqual([]);

    // The init-registered listener is live.
    bus.emit('auth/session.expired', 'token-expired');
    expect(expirations).toEqual(['token-expired']);
    expect(bus.listenerCount('auth/session.expired')).toBe(1);

    // H7: one listener and one module-scoped instance outstanding.
    const before = kernel.leaks();
    expect(before.listeners).toBe(1);
    expect(before.moduleInstances).toBe(1);
    expect(before.balanced).toBe(false);
    expect(before.details).toEqual([
      { moduleId: 'orders', kind: 'instance', count: 1 },
      { moduleId: 'orders', kind: 'listener', count: 1 },
    ]);

    await kernel.dispose();

    // Zero leaked listeners — both as the counters see it and as the
    // emitter itself sees it.
    expect(kernel.leaks().balanced).toBe(true);
    expect(kernel.leaks().listeners).toBe(0);
    expect(bus.listenerCount('auth/session.expired')).toBe(0);
    bus.emit('auth/session.expired', 'after-dispose');
    expect(expirations).toEqual(['token-expired']);
    expect(disposed).toEqual(['orders/OrderService']);
    expect(kernel.status(ordersRef)).toBe('disposed');
    expect(kernel.status(authRef)).toBe('disposed');
  });

  it('R4: dispose() leaves leaks().balanced === true and is idempotent', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({
      modules: buildModules({ bus, expirations: [], disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: () => 'mock' }) })],
    });
    await kernel.activate(ordersRef);
    expect(kernel.leaks().balanced).toBe(false);

    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('R4: dispose() tears modules down in reverse topological order', async () => {
    const order: string[] = [];
    const make = (ref: ReturnType<typeof moduleRef>, dependsOn: ReturnType<typeof moduleRef>[]) =>
      defineModule({
        id: ref,
        dependsOn,
        load: 'eager',
        critical: true,
        init: () => {
          order.push(`init:${ref.id}`);
        },
        dispose: () => {
          order.push(`dispose:${ref.id}`);
        },
      });

    const kernel = createTestKernel({
      modules: [make(ordersRef, [authRef, paymentsRef]), make(paymentsRef, [authRef]), make(authRef, [])],
    });
    await kernel.whenStartupComplete();
    expect(order).toEqual(['init:auth', 'init:payments', 'init:orders']);

    await kernel.dispose();
    expect(order.slice(3)).toEqual(['dispose:orders', 'dispose:payments', 'dispose:auth']);
  });

  it('R4: inspect() shows the graph the test wrote, without the harness module', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({ modules: buildModules({ bus, expirations: [], disposed: [] }) });
    await kernel.whenStartupComplete();

    const inspection = kernel.inspect();
    expect(inspection.modules.map((row) => row.id)).toEqual(['auth', 'payments', 'orders']);
    expect(inspection.edges).toEqual([
      { from: 'orders', to: 'auth' },
      { from: 'orders', to: 'payments' },
    ]);
    expect(inspection.providers.every((row) => row.owner !== 'ng-react/test-kernel')).toBe(true);
    await kernel.dispose();
  });

  it('R4: two test kernels in one file do not interfere', async () => {
    const busA = new SessionBus();
    const busB = new SessionBus();
    const expirationsA: string[] = [];
    const expirationsB: string[] = [];

    const a = createTestKernel({
      modules: buildModules({ bus: busA, expirations: expirationsA, disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: () => 'A' }) })],
    });
    const b = createTestKernel({
      modules: buildModules({ bus: busB, expirations: expirationsB, disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: () => 'B' }) })],
    });

    await a.activate(ordersRef);
    expect(a.get(OrderServiceToken).place('x')).toBe('x=A');
    expect(a.leaks().listeners).toBe(1);
    // B has activated nothing: its counters, its errors and its module
    // statuses are untouched by A.
    expect(b.leaks().balanced).toBe(true);
    expect(b.status(ordersRef)).toBe('registered');

    await b.activate(ordersRef);
    expect(b.get(OrderServiceToken).place('x')).toBe('x=B');
    expect(a.get(OrderServiceToken).place('x')).toBe('x=A');

    await a.dispose();
    expect(a.leaks().balanced).toBe(true);
    // A's teardown left B alone.
    expect(b.leaks().listeners).toBe(1);
    expect(b.status(ordersRef)).toBe('ready');
    busB.emit('auth/session.expired', 'b-only');
    expect(expirationsB).toEqual(['b-only']);
    expect(expirationsA).toEqual([]);

    await b.dispose();
    expect(b.leaks().balanced).toBe(true);
  });

  it('R4: Symbol.asyncDispose is wired so `await using` disposes the kernel', async () => {
    // Declared as an optional runtime binding, not a typed member: the
    // repo's pinned `lib: ES2022` has no `Symbol.asyncDispose` type, and
    // tsconfig is out of scope for this task. See `TestKernel`'s doc comment.
    const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
    expect(typeof asyncDispose).toBe('symbol');
    if (typeof asyncDispose !== 'symbol') {
      return;
    }
    const bus = new SessionBus();
    const kernel = createTestKernel({ modules: buildModules({ bus, expirations: [], disposed: [] }) });
    await kernel.activate(ordersRef);
    const binding = (kernel as unknown as Record<symbol, () => Promise<void>>)[asyncDispose];
    expect(typeof binding).toBe('function');
    await binding?.();
    expect(kernel.leaks().balanced).toBe(true);
    expect(kernel.status(ordersRef)).toBe('disposed');
  });
});

describe('createTestKernel overrides (C6)', () => {
  it('C6: an override registered before the module’s own provider wins, and the module still activates', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({
      modules: buildModules({ bus, expirations: [], disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: (cents: number) => `mock:${cents}` }) })],
    });
    // The harness module always registers first (every module under test
    // dependsOn it), so this is the "override first" order.
    await kernel.activate(ordersRef);
    expect(kernel.get(GatewayToken).charge(7)).toBe('mock:7');
    expect(kernel.status(paymentsRef)).toBe('ready');
    // #37: the module's own record used to be dropped by the harness before
    // the container saw it, so `inspect()` showed nothing at all for this
    // token (the harness's own row is hidden). It is now recorded as
    // superseded, which is what proves the mock displaced a *real* provider
    // rather than mocking a token no module provides.
    expect(kernel.inspect().providers.find((row) => row.token === 'payments/PaymentGateway')).toEqual({
      token: 'payments/PaymentGateway',
      kind: 'provide',
      scope: 'module',
      owner: 'payments',
      override: false,
      overriddenBy: 'ng-react/test-kernel',
    });
    await kernel.dispose();
  });

  it('C6: an override registered after the module’s own provider wins, and both modules stay ready', async () => {
    // The other registration order, exercised against the container's own
    // C6 rule with no harness in the way.
    const mocksRef = moduleRef('mocks');
    const kernel = createKernel({
      dev: false,
      modules: [
        defineModule({
          id: paymentsRef,
          load: 'eager',
          critical: true,
          providers: () => [provide(GatewayToken, { factory: () => ({ charge: () => 'real' }) })],
        }),
        defineModule({
          id: mocksRef,
          dependsOn: [paymentsRef],
          load: 'eager',
          critical: true,
          providers: () => [provide(GatewayToken, { override: true, factory: () => ({ charge: () => 'mock' }) })],
        }),
      ],
    });
    await kernel.whenStartupComplete();
    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.status(mocksRef)).toBe('ready');
    expect(kernel.get(GatewayToken).charge(1)).toBe('mock');
  });

  it('C6/#37: a plain provide arriving after an override is superseded, not fatal — the overridden module still activates', async () => {
    // The container behaviour that used to shape `wrapDescriptor`, now on a
    // *raw* kernel with no harness in sight: C6's precedence is
    // order-independent about which record wins, and since #37 the loser is
    // ignored rather than rejected, so mocking a token no longer kills the
    // module being mocked for (acceptance criterion 7).
    const mocksRef = moduleRef('mocks');
    const kernel = createKernel({
      dev: false,
      modules: [
        defineModule({
          id: mocksRef,
          load: 'eager',
          critical: true,
          providers: () => [provide(GatewayToken, { override: true, factory: () => ({ charge: () => 'mock' }) })],
        }),
        defineModule({
          id: paymentsRef,
          dependsOn: [mocksRef],
          load: 'lazy',
          providers: () => [provide(GatewayToken, { factory: () => ({ charge: () => 'real' }) })],
        }),
      ],
    });
    await kernel.whenStartupComplete();
    await expect(kernel.activate(paymentsRef)).resolves.toBeUndefined();
    expect(kernel.status(paymentsRef)).toBe('ready');
    expect(kernel.get(GatewayToken).charge(1)).toBe('mock');
    expect(kernel.inspect().providers).toContainEqual({
      token: 'payments/PaymentGateway',
      kind: 'provide',
      scope: 'singleton',
      owner: 'payments',
      override: false,
      overriddenBy: 'mocks',
    });
  });

  it('C6: an override for a token no module provides is a pure mock and resolves', async () => {
    const kernel = createTestKernel({
      modules: [defineModule({ id: authRef, load: 'eager', critical: true })],
      overrides: [provide(RetryBudgetToken, { factory: () => 3 })],
    });
    await kernel.whenStartupComplete();
    expect(kernel.get(RetryBudgetToken)).toBe(3);
    await kernel.dispose();
  });

  it('C6: overrides are registered with override: true even when the caller did not set it', async () => {
    // Observable end to end: two overrides for one token land in a single
    // `register()` batch, and C6 rejects the second as a
    // `DuplicateProviderError` unless it carries `override: true`. That it
    // registers at all — and that the last one wins — is the proof.
    const kernel = createTestKernel({
      modules: [defineModule({ id: authRef, load: 'eager', critical: true })],
      overrides: [provide(RetryBudgetToken, { factory: () => 3 }), provide(RetryBudgetToken, { factory: () => 9 })],
    });
    await kernel.whenStartupComplete();
    expect(kernel.status(authRef)).toBe('ready');
    expect(kernel.errors).toEqual([]);
    expect(kernel.get(RetryBudgetToken)).toBe(9);
    await kernel.dispose();
  });
});

describe('createTestKernel delegation to the C5/C9/H6 kernel surface', () => {
  it('C5/C9: subscribeAll and ownerOf reach the same container the kernel uses', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({ modules: buildModules({ bus, expirations: [], disposed: [] }) });
    await kernel.whenStartupComplete();

    const notifications: number[] = [];
    const unsubscribe = kernel.subscribeAll(ErrorSinkToken, (sinks) => {
      notifications.push(sinks.length);
    });
    // C9: provenance is kernel-assigned, and nothing provides the token yet.
    expect(kernel.ownerOf(OrderServiceToken)).toBeUndefined();

    await kernel.activate(ordersRef);
    expect(kernel.ownerOf(OrderServiceToken)).toBe('orders');
    expect(kernel.ownerOf(GatewayToken)).toBe('payments');

    // C5: withdrawing a module notifies the collection's subscribers — the
    // harness module owns the only ErrorSinkToken contribution, so its
    // teardown at dispose() is the change this subscription observes.
    await kernel.deactivate(ordersRef);
    await kernel.dispose();
    expect(notifications).toEqual([0]);
    unsubscribe();
  });

  it('C9: ownerOf reports the harness module for an overridden token', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({
      modules: buildModules({ bus, expirations: [], disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: () => 'mock' }) })],
    });
    await kernel.activate(ordersRef);
    // The harness genuinely registered the mock, and C9 provenance is
    // kernel-assigned — so H6 consumers watch the harness's epoch for it.
    expect(kernel.ownerOf(GatewayToken)).toBe('ng-react/test-kernel');
    expect(kernel.ownerOf(OrderServiceToken)).toBe('orders');
    await kernel.dispose();
  });

  it('H6: epochOf, bumpEpoch and subscribeEpoch delegate to the kernel\u2019s own per-kernel store', async () => {
    const bus = new SessionBus();
    const a = createTestKernel({ modules: buildModules({ bus, expirations: [], disposed: [] }) });
    const b = createTestKernel({ modules: buildModules({ bus, expirations: [], disposed: [] }) });
    await a.whenStartupComplete();
    await b.whenStartupComplete();

    const perModule: string[] = [];
    const global: string[] = [];
    const offModule = a.subscribeEpoch('orders', () => {
      perModule.push('orders');
    });
    const offGlobal = a.subscribeEpoch(undefined, () => {
      global.push('any');
    });

    expect(a.epochOf('orders')).toBe(0);
    a.bumpEpoch('orders');
    a.bumpEpoch('payments');

    // `epochOf` already *is* the per-module bump count, which is why the
    // harness records nothing of its own \u2014 see `TestKernel`'s doc comment.
    expect(a.epochOf('orders')).toBe(1);
    expect(a.epochOf('payments')).toBe(1);
    expect(a.epochOf()).toBe(2);
    expect(perModule).toEqual(['orders']);
    expect(global).toEqual(['any', 'any']);

    // Isolation: each kernel owns its own epoch store.
    expect(b.epochOf('orders')).toBe(0);
    expect(b.epochOf()).toBe(0);

    offModule();
    offGlobal();
    a.bumpEpoch('orders');
    expect(perModule).toEqual(['orders']);
    expect(a.epochOf('orders')).toBe(2);

    await a.dispose();
    await b.dispose();
  });
});

describe('createTestKernel error collection (F4)', () => {
  it('F4: errors collects a failed activation, with kernel-assigned attribution', async () => {
    const brokenRef = moduleRef('broken');
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: brokenRef,
          load: 'lazy',
          init: () => {
            throw new Error('init exploded');
          },
        }),
      ],
    });
    await expect(kernel.activate(brokenRef)).rejects.toThrow('init exploded');
    expect(kernel.errors).toHaveLength(1);
    expect(kernel.errors[0]?.info).toEqual({ moduleId: 'broken', phase: 'activate' });
    expect((kernel.errors[0]?.error as Error).message).toContain('init exploded');
    await kernel.dispose();
  });

  it('F4: a startup failure of an eager critical module is collected rather than escaping to the console', async () => {
    // The failure item 6 of the brief is about: the very first errors an app
    // produces are startup errors. The harness module (which carries the
    // sink) is a dependency of every module under test, so it is always
    // `ready` first and the sink is live before any module can fail — a
    // stronger guarantee than relying on the router's buffer-and-flush.
    const bootRef = moduleRef('boot');
    const fatal: unknown[] = [];
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: bootRef,
          load: 'eager',
          critical: true,
          providers: () => {
            throw new Error('providers exploded at startup');
          },
        }),
      ],
      onFatal: (error) => {
        fatal.push(error);
      },
    });
    await expect(kernel.whenStartupComplete()).rejects.toThrow('providers exploded at startup');
    expect(kernel.errors).toHaveLength(1);
    expect(kernel.errors[0]?.info.moduleId).toBe('boot');
    expect(fatal).toHaveLength(1);
    await kernel.dispose();
  });

  it('F4: a cleanup that throws during dispose is collected and does not abort teardown', async () => {
    const flakyRef = moduleRef('flaky');
    const ran: string[] = [];
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: flakyRef,
          load: 'eager',
          critical: true,
          init: (ctx) => {
            ctx.effect(() => () => {
              ran.push('first');
            });
            ctx.effect(() => () => {
              throw new Error('cleanup exploded');
            });
          },
        }),
      ],
    });
    await kernel.whenStartupComplete();
    expect(kernel.leaks().effects).toBe(2);

    await kernel.dispose();
    expect(ran).toEqual(['first']);
    expect(kernel.errors.map((entry) => (entry.error as Error).message)).toContain('cleanup exploded');
    expect(kernel.errors.map((entry) => entry.info.phase)).toContain('cleanup');
    // H7: the counters balance even though a cleanup threw — the effect is
    // gone either way, and pretending otherwise would report a phantom leak.
    expect(kernel.leaks().balanced).toBe(true);
  });
});

describe('leak counters (H7)', () => {
  it('H7: counters are inert when dev is false — nothing is wrapped and nothing is counted', async () => {
    const bus = new SessionBus();
    // Only booleans are captured, never the context itself: whether the two
    // hooks saw one object or two is the question, and answering it inside
    // the module avoids holding a context past L4.
    let initCtx: ModuleContext | undefined;
    let sameContextInDispose: boolean | undefined;
    const modules = [
      defineModule({
        id: authRef,
        load: 'eager',
        critical: true,
        providers: () => [provide(SessionBusToken, { scope: 'module', factory: () => bus })],
        init: (ctx) => {
          initCtx = ctx;
          ctx.get(SessionBusToken);
          ctx.on(bus, 'auth/session.expired', () => {});
          ctx.effect(() => () => {});
        },
        dispose: (ctx) => {
          sameContextInDispose = ctx === initCtx;
        },
      }),
    ];

    const off = createTestKernel({ modules, dev: false });
    await off.whenStartupComplete();
    // Behavioural, not a getter-returns-zero check: a live counter would
    // report 1 listener, 1 effect and 1 module-scoped instance right here.
    // Zero means no counting happened at all.
    expect(off.leaks()).toEqual({
      listeners: 0,
      effects: 0,
      moduleInstances: 0,
      balanced: true,
      details: [],
    });
    // And nothing was allocated to wrap the module's context: the kernel's
    // own `ModuleContext` reached `init` and `dispose` unmodified, so both
    // hooks saw the very same object.
    expect(sameContextInDispose).toBeUndefined();
    await off.dispose();
    expect(sameContextInDispose).toBe(true);

    // The same modules with dev on: every one of those registrations is
    // counted, and the context each hook sees is a per-call wrapper.
    const on = createTestKernel({ modules, dev: true });
    await on.whenStartupComplete();
    expect(on.leaks()).toEqual({
      listeners: 1,
      effects: 1,
      moduleInstances: 1,
      balanced: false,
      details: [
        { moduleId: 'auth', kind: 'effect', count: 1 },
        { moduleId: 'auth', kind: 'instance', count: 1 },
        { moduleId: 'auth', kind: 'listener', count: 1 },
      ],
    });
    sameContextInDispose = undefined;
    await on.dispose();
    // Each hook got its own counting wrapper, so `dispose` did not see the
    // object `init` saw — the allocation the dev:false run did not make.
    expect(sameContextInDispose).toBe(false);
    expect(on.leaks().balanced).toBe(true);
  });

  it('H7: details give the per-module baseline stage 6.2 diffs a cycle against', async () => {
    const bus = new SessionBus();
    const kernel = createTestKernel({
      modules: buildModules({ bus, expirations: [], disposed: [] }),
      overrides: [provide(GatewayToken, { factory: () => ({ charge: () => 'mock' }) })],
    });
    await kernel.activate(ordersRef);
    const baseline = kernel.leaks();

    // One dispose/re-activate cycle — the shape of an HMR cycle (H4).
    await kernel.deactivate(ordersRef);
    expect(kernel.leaks().details).toEqual([]);
    await kernel.activate(ordersRef);
    const after = kernel.leaks();

    // H7: back to the pre-dispose baseline, with no diff, per module.
    expect(after.details).toEqual(baseline.details);
    expect(after.listeners).toBe(baseline.listeners);
    expect(after.moduleInstances).toBe(baseline.moduleInstances);
    await kernel.dispose();
  });

  it('H7: leaks() is a snapshot, not a live view', async () => {
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: authRef,
          load: 'eager',
          critical: true,
          init: (ctx) => {
            ctx.effect(() => () => {});
          },
        }),
      ],
    });
    await kernel.whenStartupComplete();
    const snapshot = kernel.leaks();
    await kernel.dispose();
    expect(snapshot.effects).toBe(1);
    expect(kernel.leaks().effects).toBe(0);
  });
});

describe('evaluation-order instrumentation (acceptance criterion 9)', () => {
  it('criterion 9: no implementation file of a lazy module is evaluated before its activation trigger', async () => {
    const evaluated: string[] = [];
    const spyThunk = (id: string, file: string) => () => {
      evaluated.push(file);
      recordEvaluation(id, file);
      return [];
    };

    const kernel = createTestKernel({
      modules: [
        defineModule({ id: authRef, load: 'eager', critical: true, providers: spyThunk('auth', 'auth/providers.ts') }),
        defineModule({ id: paymentsRef, load: 'lazy', providers: spyThunk('payments', 'payments/providers.ts') }),
        defineModule({
          id: ordersRef,
          dependsOn: [paymentsRef],
          load: 'lazy',
          providers: spyThunk('orders', 'orders/providers.ts'),
        }),
      ],
    });

    await kernel.whenStartupComplete();
    // Only the eager module has been evaluated so far.
    expect(evaluated).toEqual(['auth/providers.ts']);

    await kernel.activate(ordersRef);

    const log = evaluationLog(kernel);
    const positionOf = (moduleId: string, file: string): number =>
      log.findIndex((event) => event.moduleId === moduleId && event.file === file);

    const trigger = positionOf('orders', '<activate>');
    expect(trigger).toBeGreaterThanOrEqual(0);

    // The ordering claim, asserted positionally: every lazy module's
    // implementation file sits *after* the trigger, and the eager module's
    // sits before it.
    expect(positionOf('auth', 'auth/providers.ts')).toBeLessThan(trigger);
    expect(positionOf('orders', 'orders/providers.ts')).toBeGreaterThan(trigger);
    expect(positionOf('payments', 'payments/providers.ts')).toBeGreaterThan(trigger);
    // A1: the transitive dependency is evaluated before its dependent.
    expect(positionOf('payments', 'payments/providers.ts')).toBeLessThan(
      positionOf('orders', 'orders/providers.ts'),
    );
    // `at` is a strictly increasing logical clock, so "before" is total.
    expect(log.map((event) => event.at)).toEqual([...log.map((event) => event.at)].sort((a, b) => a - b));
    expect(new Set(log.map((event) => event.at)).size).toBe(log.length);

    await kernel.dispose();
  });

  it('criterion 9: the kernel-driven events record the providers thunk and init, in that order', async () => {
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: authRef,
          load: 'lazy',
          providers: () => [],
          init: () => {},
        }),
      ],
    });
    await kernel.activate(authRef);
    expect(evaluationLog(kernel).map((event) => `${event.moduleId}:${event.file}`)).toEqual([
      'auth:<activate>',
      'auth:<providers>',
      'auth:<init>',
    ]);
    await kernel.dispose();
  });

  it('criterion 9: evaluationLog() rejects a kernel that was not created by createTestKernel', () => {
    const kernel = createKernel({ dev: false, modules: [] });
    expect(() => evaluationLog(kernel)).toThrow(
      'evaluationLog(): this kernel was not created by createTestKernel(), so nothing recorded its ' +
        'evaluation order. Create it with createTestKernel({ modules }) to use evaluation-order instrumentation.',
    );
  });

  it('criterion 9: a disposed kernel stops recording but keeps its log readable', async () => {
    const kernel = createTestKernel({ modules: [] });
    recordEvaluation('orders', 'orders/lifecycle.ts');
    await kernel.dispose();
    recordEvaluation('orders', 'orders/after-dispose.ts');
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual(['orders/lifecycle.ts']);
  });
});
