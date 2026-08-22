// **H7 — the post-HMR-cycle leak invariant**, plus **acceptance criterion 3**
// at the unit level.
//
// `.test.ts` → the **kernel** project (node): no renderer, no bundler. Every
// HMR update below is a direct `hotReplace` call (ADR-5).
//
// Two halves:
//
//  1. `LeakInvariantCheck` on fabricated `LeakReport`s — the rule itself,
//     stated in `leak-check.ts` and asserted here in isolation, including
//     the case issue #20's proposed rule could not distinguish (an edit that
//     legitimately adds listeners).
//  2. The whole cycle through `createTestKernel`, which owns the counters
//     the check reads (spec §12 R4). That is where the 20-cycle
//     no-drift assertion lives, and where H3's blessed persistent-store
//     pattern is proved not to produce a false leak.

import { describe, expect, it, vi } from 'vitest';

import { LeakInvariantCheck, LeakInvariantViolation } from './leak-check';
import { defineStore } from './persistent';
import type { Store } from './persistent';
import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createTestKernel } from '../testing/test-kernel';
import type { LeakReport } from '../testing/leak-counters';
import { createToken } from '../token';
import type { ModuleContext } from '../types';

// ---------------------------------------------------------------------------
// Part 1 — the rule, in isolation
// ---------------------------------------------------------------------------

type Detail = LeakReport['details'][number];

/** Builds a `LeakReport` from `(moduleId, kind, count)` triples. */
function report(...rows: readonly Detail[]): LeakReport {
  let listeners = 0;
  let effects = 0;
  let moduleInstances = 0;
  for (const row of rows) {
    if (row.kind === 'listener') listeners += row.count;
    else if (row.kind === 'effect') effects += row.count;
    else moduleInstances += row.count;
  }
  return {
    listeners,
    effects,
    moduleInstances,
    balanced: listeners === 0 && effects === 0 && moduleInstances === 0,
    details: rows,
  };
}

/** A check whose `read` walks a scripted sequence of reports. */
function scriptedCheck(sequence: readonly LeakReport[]): {
  readonly check: LeakInvariantCheck;
  readonly routed: { readonly error: unknown; readonly moduleId: string }[];
} {
  let index = 0;
  const routed: { error: unknown; moduleId: string }[] = [];
  const check = new LeakInvariantCheck({
    read: () => sequence[Math.min(index++, sequence.length - 1)] ?? report(),
    route: (error, moduleId) => {
      routed.push({ error, moduleId });
    },
  });
  return { check, routed };
}

/** Drives one cycle: `before`, `residual`, `after`, then the check. */
function runCycle(options: {
  readonly cascade: readonly string[];
  readonly before: LeakReport;
  readonly residual: LeakReport;
  readonly after: LeakReport;
}): { readonly error: unknown; readonly moduleId: string }[] {
  const { check, routed } = scriptedCheck([options.before, options.residual, options.after]);
  const before = check.snapshot();
  const residual = check.snapshot();
  const after = check.snapshot();
  check.check({ cascade: options.cascade, before, residual, after });
  return routed;
}

describe('LeakInvariantCheck — H7, the rule', () => {
  it('H7: a clean cycle reports nothing, however much the new init registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // This is the case issue #20's proposed rule cannot see: the edit
      // legitimately went from 2 listeners to 9. `residual` is empty, so the
      // check is silent — no baseline is remembered and none is needed.
      const routed = runCycle({
        cascade: ['orders'],
        before: report({ moduleId: 'orders', kind: 'listener', count: 2 }),
        residual: report(),
        after: report({ moduleId: 'orders', kind: 'listener', count: 9 }),
      });
      expect(routed).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: an outstanding count after disposal is a violation naming the module', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const routed = runCycle({
        cascade: ['orders'],
        before: report({ moduleId: 'orders', kind: 'effect', count: 3 }),
        residual: report({ moduleId: 'orders', kind: 'effect', count: 1 }),
        after: report({ moduleId: 'orders', kind: 'effect', count: 4 }),
      });

      expect(routed).toHaveLength(1);
      const entry = routed[0];
      expect(entry?.moduleId).toBe('orders');
      const violation = entry?.error;
      expect(violation).toBeInstanceOf(LeakInvariantViolation);
      expect((violation as LeakInvariantViolation).code).toBe('KERNEL_LEAK_DETECTED');
      expect((violation as LeakInvariantViolation).moduleId).toBe('orders');
      expect((violation as LeakInvariantViolation).message).toBe(
        "Hot replace leaked 1 ctx.effect registration from module 'orders'. " +
          'The registration remained after the module was disposed, so future edits will accumulate more ' +
          '(before the edit: 3, outstanding after disposal: 1, after re-activation: 4). ' +
          'Release every registration during teardown: use ctx.on/ctx.effect for subscriptions and effects, ' +
          'and do not register new work in dispose(ctx), which runs after cleanups.',
      );
      // H7: "violations log a leak warning".
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith((violation as LeakInvariantViolation).message);
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: a module outside the cascade is never reported, however high its counts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // `catalog` was not disposed by this cycle, so its registrations are
      // *supposed* to still be outstanding. Reporting them would name every
      // live module in the app on every edit.
      const routed = runCycle({
        cascade: ['orders'],
        before: report({ moduleId: 'catalog', kind: 'listener', count: 12 }),
        residual: report({ moduleId: 'catalog', kind: 'listener', count: 12 }),
        after: report({ moduleId: 'catalog', kind: 'listener', count: 12 }),
      });
      expect(routed).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: a negative residual (double release) is not reported as a leak', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const routed = runCycle({
        cascade: ['orders'],
        before: report(),
        residual: report({ moduleId: 'orders', kind: 'instance', count: -2 }),
        after: report({ moduleId: 'orders', kind: 'instance', count: -2 }),
      });
      expect(routed).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: the check never throws — not when the warning channel throws, nor when reading does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console is gone');
    });
    try {
      const { check, routed } = scriptedCheck([
        report({ moduleId: 'orders', kind: 'listener', count: 1 }),
      ]);
      const snapshot = check.snapshot();
      expect(() => {
        check.check({ cascade: ['orders'], before: snapshot, residual: snapshot, after: snapshot });
      }).not.toThrow();
      // The throw happened before routing, so nothing was delivered — which
      // is the accepted cost of never letting a diagnostic break a hot update.
      expect(routed).toEqual([]);

      const exploding = new LeakInvariantCheck({
        read: () => {
          throw new Error('counters exploded');
        },
        route: () => {},
      });
      expect(() => {
        exploding.check({
          cascade: ['orders'],
          before: new Map(),
          residual: new Map(),
          after: new Map(),
        });
      }).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the whole cycle, through `createTestKernel` (R4)
//
// ADR-10 / AGENTS.md §9: differently typed tokens — a persistent store of
// value objects, a service interface, a flow object, and a bare function.
// ---------------------------------------------------------------------------

interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}
const CartStoreToken = createToken<Store<readonly CartLine[]>>('orders/CartStore');

interface OrderService {
  readonly generation: number;
  place(sku: string): string;
}
const OrderServiceToken = createToken<OrderService>('orders/OrderService');

interface CheckoutFlow {
  begin(): string;
}
const CheckoutFlowToken = createToken<CheckoutFlow>('checkout/CheckoutFlow');

type MoneyFormatter = (amountMinor: number) => string;
const MoneyFormatterToken = createToken<MoneyFormatter>('reporting/MoneyFormatter');

const ordersRef = moduleRef('orders');
const checkoutRef = moduleRef('checkout');
const reportingRef = moduleRef('reporting');

/** A minimal `on`/`off` emitter, so `ctx.on` (L2) has something real to hold. */
class OrderBus {
  private readonly handlers = new Map<string, Set<(...args: never[]) => void>>();
  on(event: string, handler: (...args: never[]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }
  off(event: string, handler: (...args: never[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }
  /** How many handlers are attached — the ground truth H7's counters mirror. */
  count(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/**
 * `orders`, parameterised by generation — "generation N" is what a
 * re-evaluated implementation file produces after the Nth edit.
 *
 * It carries **H3's blessed pattern**: a `persistent: true` store whose
 * `init` subscribes to it through `ctx.effect`, plus an `ctx.on` listener on
 * a real emitter. Both are exactly what the H7 counters count.
 */
function ordersModule(options: {
  readonly generation: number;
  readonly bus: OrderBus;
  readonly notifications: string[];
}): ModuleDescriptor {
  const { generation, bus, notifications } = options;
  return defineModule({
    id: ordersRef,
    providers: () => [
      provide(CartStoreToken, {
        scope: 'module',
        persistent: true,
        factory: (): Store<readonly CartLine[]> => defineStore<readonly CartLine[]>([]),
      }),
      provide(OrderServiceToken, {
        scope: 'module',
        deps: [CartStoreToken],
        factory: (cart: Store<readonly CartLine[]>): OrderService => ({
          generation,
          place: (sku) => `${sku}x${String(cart.getState().length)}@gen${String(generation)}`,
        }),
      }),
    ],
    init: (ctx: ModuleContext) => {
      const cart = ctx.get(CartStoreToken);
      // A **live subscriber** on the persistent store, released by L3.
      ctx.effect(() => cart.subscribe(() => notifications.push(`gen${String(generation)}`)));
      ctx.on(bus, 'order-placed', () => {});
    },
  });
}

/** A **true consumer** of `orders`: its flow is built out of an `OrderService`. */
function checkoutModule(): ModuleDescriptor {
  return defineModule({
    id: checkoutRef,
    dependsOn: [ordersRef],
    providers: () => [
      provide(CheckoutFlowToken, {
        scope: 'module',
        deps: [OrderServiceToken],
        factory: (orders: OrderService): CheckoutFlow => ({
          begin: () => `checkout:${orders.place('DESK-1')}`,
        }),
      }),
    ],
  });
}

/** Declares `dependsOn: [orders]` and resolves nothing from it (H5). */
function reportingModule(): ModuleDescriptor {
  return defineModule({
    id: reportingRef,
    dependsOn: [ordersRef],
    providers: () => [
      provide(MoneyFormatterToken, {
        factory: (): MoneyFormatter => (amountMinor) => `${(amountMinor / 100).toFixed(2)} EUR`,
      }),
    ],
  });
}

describe('H7 — the post-HMR-cycle invariant, end to end', () => {
  it(
    'H3/H4/H7: 20 consecutive hotReplace cycles of `orders` re-activate only `orders` and its true ' +
      'consumers, preserve persistent store state, and leave leak counters unchanged',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const bus = new OrderBus();
        const notifications: string[] = [];
        const kernel = createTestKernel({
          modules: [
            ordersModule({ generation: 1, bus, notifications }),
            checkoutModule(),
            reportingModule(),
          ],
        });
        await kernel.activate(checkoutRef);
        await kernel.activate(reportingRef);
        // C3: nothing is constructed until it is resolved.
        expect(kernel.get(CheckoutFlowToken).begin()).toBe('checkout:DESK-1x0@gen1');
        kernel.get(CartStoreToken).setState([{ sku: 'DESK-1', quantity: 2 }]);

        let afterFirstCycle: LeakReport | undefined;
        for (let generation = 2; generation <= 21; generation += 1) {
          await kernel.hotReplace(ordersRef, ordersModule({ generation, bus, notifications }));
          // **H6**: a mounted component re-resolves after the epoch bump.
          // Doing it here is what keeps the *resolution graph* current, and
          // therefore what keeps `checkout` in every later cascade (H5).
          expect(kernel.get(CheckoutFlowToken).begin()).toBe(
            `checkout:DESK-1x1@gen${String(generation)}`,
          );
          // **H3/ADR-3**: the cart survived the edit, every time.
          expect(kernel.get(CartStoreToken).getState()).toEqual([{ sku: 'DESK-1', quantity: 2 }]);
          if (generation === 2) {
            afterFirstCycle = kernel.leaks();
          }
        }

        // **H7**: 20 edits that change nothing structural drift nothing.
        expect(kernel.leaks()).toEqual(afterFirstCycle);
        // …and no violation was ever reported, through either channel.
        expect(warn).not.toHaveBeenCalled();
        expect(kernel.errors).toEqual([]);

        // **H5**: only `orders` and its true consumer were re-activated.
        expect(kernel.epochOf('orders')).toBe(20);
        expect(kernel.epochOf('checkout')).toBe(20);
        expect(kernel.epochOf('reporting')).toBe(0);
        expect(kernel.get(MoneyFormatterToken)(2599)).toBe('25.99 EUR');

        // The ground truth behind the `listener` counter: L3 really did
        // unsubscribe each generation, so the emitter holds exactly one.
        expect(bus.count('order-placed')).toBe(1);

        await kernel.dispose();
        expect(kernel.leaks().balanced).toBe(true);
        expect(bus.count('order-placed')).toBe(0);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('H3/H7: a persistent store with live subscribers survives 20 cycles without a leak warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new OrderBus();
      const notifications: string[] = [];
      const kernel = createTestKernel({
        modules: [ordersModule({ generation: 1, bus, notifications })],
      });
      await kernel.activate(ordersRef);

      for (let generation = 2; generation <= 21; generation += 1) {
        await kernel.hotReplace(ordersRef, ordersModule({ generation, bus, notifications }));
        // Resolving the store constructs the replacement and runs ADR-3's
        // transfer — the moment at which the *previous* instance is dropped
        // without ever being disposed (spec §17). Counting it would make
        // this loop report a growing `instance` leak on H3's own pattern.
        kernel.get(CartStoreToken).setState([{ sku: 'LAMP', quantity: generation }]);
      }

      expect(kernel.get(CartStoreToken).getState()).toEqual([{ sku: 'LAMP', quantity: 21 }]);
      // The live subscriber the *current* generation's init registered is
      // still attached and still firing.
      expect(notifications.at(-1)).toBe('gen21');
      // One listener and one effect outstanding: the live generation's. Not
      // twenty-one of each.
      expect(kernel.leaks().details).toEqual([
        { moduleId: 'orders', kind: 'effect', count: 1 },
        { moduleId: 'orders', kind: 'listener', count: 1 },
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(kernel.errors).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('H7/F4: an injected leak is reported through the error sinks, naming the module', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const leakyRef = moduleRef('leaky');
      // A realistic leak: a `dispose(ctx)` handler that re-subscribes. L3's
      // cleanups have already run by then (spec §8), so the registration is
      // never released and every cycle adds one more.
      const leakyModule = (generation: number): ModuleDescriptor =>
        defineModule({
          id: leakyRef,
          init: (ctx: ModuleContext) => {
            ctx.effect(() => () => {});
          },
          dispose: (ctx: ModuleContext) => {
            ctx.effect(() => () => `generation ${String(generation)} never cleaned up`);
          },
        });

      const kernel = createTestKernel({ modules: [leakyModule(1)] });
      await kernel.activate(leakyRef);
      expect(kernel.leaks().details).toEqual([{ moduleId: 'leaky', kind: 'effect', count: 1 }]);

      await kernel.hotReplace(leakyRef, leakyModule(2));

      const violations = kernel.errors.filter(
        (entry) => entry.error instanceof LeakInvariantViolation,
      );
      expect(violations).toHaveLength(1);
      const violation = violations[0]?.error as LeakInvariantViolation;
      expect(violation.leakedModuleId).toBe('leaky');
      expect(violation.kind).toBe('effect');
      expect(violation.outstanding).toBe(1);
      // C9: the kernel attributes it, in the phase whose job it was.
      expect(violations[0]?.info).toEqual({ moduleId: 'leaky', phase: 'dispose' });
      expect(warn).toHaveBeenCalledWith(violation.message);

      // It accumulates, which is the point: the second cycle finds two.
      await kernel.hotReplace(leakyRef, leakyModule(3));
      const second = kernel.errors
        .filter((entry) => entry.error instanceof LeakInvariantViolation)
        .at(-1)?.error as LeakInvariantViolation;
      expect(second.outstanding).toBe(2);
      expect(second.message).toContain("leaked 2 ctx.effect registrations from module 'leaky'");

      await kernel.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: a leak warning never breaks the hot update, even when console.warn throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('no console here');
    });
    try {
      const leakyRef = moduleRef('leaky');
      const leakyModule = (generation: number): ModuleDescriptor =>
        defineModule({
          id: leakyRef,
          providers: () => [
            provide(MoneyFormatterToken, {
              factory: (): MoneyFormatter => (amountMinor) =>
                `${String(amountMinor)}/gen${String(generation)}`,
            }),
          ],
          dispose: (ctx: ModuleContext) => {
            ctx.effect(() => () => {});
          },
        });

      const kernel = createTestKernel({ modules: [leakyModule(1)] });
      await kernel.activate(leakyRef);

      await expect(kernel.hotReplace(leakyRef, leakyModule(2))).resolves.toBeUndefined();
      // The update landed in full despite the reporter blowing up.
      expect(kernel.status(leakyRef)).toBe('ready');
      expect(kernel.get(MoneyFormatterToken)(7)).toBe('7/gen2');
      await kernel.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: no check runs, and nothing is reported, when the kernel is not in dev mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const leakyRef = moduleRef('leaky');
      const leakyModule = (): ModuleDescriptor =>
        defineModule({
          id: leakyRef,
          dispose: (ctx: ModuleContext) => {
            ctx.effect(() => () => {});
          },
        });

      const kernel = createTestKernel({ modules: [leakyModule()], dev: false });
      await kernel.activate(leakyRef);
      await kernel.hotReplace(leakyRef, leakyModule());

      // Nothing is instrumented and no check is installed, so the same leak
      // that fires above is invisible here — H7 is a dev-mode check.
      expect(kernel.leaks().balanced).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(kernel.errors).toEqual([]);
      await kernel.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});
