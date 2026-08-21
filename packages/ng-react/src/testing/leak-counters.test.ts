// H7 leak counters — the scope limit on `moduleInstances`, and the counting
// rules the test kernel relies on. Node project, `.test.ts` (ADR-6).

import { defineModule } from '../define-module';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken } from '../token';
import { LeakCounters } from './leak-counters';
import { createTestKernel } from './test-kernel';

interface Cache {
  read(key: string): string | undefined;
}

const CacheToken = createToken<Cache>('orders/Cache');
const RequestIdToken = createToken<string>('orders/RequestId');
const ClockToken = createToken<() => number>('orders/Clock');

const ordersRef = moduleRef('orders');

describe('LeakCounters (H7)', () => {
  it('H7: a report is empty until something is registered, and counts are per module and per kind', () => {
    const counters = new LeakCounters();
    expect(counters.report()).toEqual({
      listeners: 0,
      effects: 0,
      moduleInstances: 0,
      balanced: true,
      details: [],
    });

    counters.acquire('orders', 'listener');
    counters.acquire('orders', 'listener');
    counters.acquire('auth', 'effect');
    expect(counters.report()).toEqual({
      listeners: 2,
      effects: 1,
      moduleInstances: 0,
      balanced: false,
      details: [
        { moduleId: 'auth', kind: 'effect', count: 1 },
        { moduleId: 'orders', kind: 'listener', count: 2 },
      ],
    });

    counters.release('orders', 'listener');
    counters.release('orders', 'listener');
    counters.release('auth', 'effect');
    expect(counters.report().balanced).toBe(true);
  });

  it('H7: a double release goes negative rather than clamping to a green balanced', () => {
    const counters = new LeakCounters();
    counters.acquire('orders', 'effect');
    counters.release('orders', 'effect');
    counters.release('orders', 'effect');
    const report = counters.report();
    expect(report.effects).toBe(-1);
    expect(report.balanced).toBe(false);
    expect(report.details).toEqual([{ moduleId: 'orders', kind: 'effect', count: -1 }]);
  });
});

describe('instance counting scope limit (H7, issue #34)', () => {
  it('H7: only module-scoped instances are counted — singleton and transient are not', async () => {
    const built: string[] = [];
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: ordersRef,
          load: 'eager',
          critical: true,
          providers: () => [
            provide(CacheToken, {
              scope: 'module',
              factory: () => {
                built.push('module');
                return { read: () => undefined };
              },
            }),
            provide(RequestIdToken, {
              scope: 'transient',
              factory: () => {
                built.push('transient');
                return 'req-1';
              },
            }),
            provide(ClockToken, {
              scope: 'singleton',
              factory: () => {
                built.push('singleton');
                return () => 0;
              },
            }),
          ],
          init: (ctx) => {
            ctx.get(CacheToken);
            ctx.get(RequestIdToken);
            ctx.get(ClockToken);
          },
        }),
      ],
    });

    await kernel.whenStartupComplete();
    expect(built.sort()).toEqual(['module', 'singleton', 'transient']);
    // All three were constructed; exactly one is counted.
    expect(kernel.leaks().moduleInstances).toBe(1);
    expect(kernel.leaks().details).toEqual([{ moduleId: 'orders', kind: 'instance', count: 1 }]);

    // C7 leaves `singleton` instances alive at module disposal (issue #34 —
    // H4 will change that), so counting them here would make `balanced`
    // permanently false through no fault of this harness. The limit is
    // deliberate and this assertion pins it.
    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('H7: a module-scoped provider that is never resolved is never counted (C3 laziness)', async () => {
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: ordersRef,
          load: 'eager',
          critical: true,
          providers: () => [provide(CacheToken, { scope: 'module', factory: () => ({ read: () => undefined }) })],
        }),
      ],
    });
    await kernel.whenStartupComplete();
    expect(kernel.leaks().moduleInstances).toBe(0);
    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
  });

  it("H7: instrumenting a record does not suppress the instance's own dispose() (C7 precedence)", async () => {
    const events: string[] = [];
    const kernel = createTestKernel({
      modules: [
        defineModule({
          id: ordersRef,
          load: 'eager',
          critical: true,
          providers: () => [
            provide(CacheToken, {
              scope: 'module',
              factory: () => ({
                read: () => undefined,
                dispose: () => {
                  events.push('own dispose()');
                },
              }),
            }),
          ],
          init: (ctx) => {
            ctx.get(CacheToken);
          },
        }),
      ],
    });
    await kernel.whenStartupComplete();
    await kernel.dispose();
    expect(events).toEqual(['own dispose()']);
    expect(kernel.leaks().balanced).toBe(true);
  });
});
