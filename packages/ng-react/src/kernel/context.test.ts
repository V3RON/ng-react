import { describe, expect, it, vi } from 'vitest';

import { Container } from '../container/container';
import { DeadContextError, UnsupportedEmitterError } from '../errors';
import { contribute, provide } from '../provider';
import { createToken, MODULE_ID } from '../token';
import type { EventEmitterLike } from '../types';
import { ModuleContextImpl } from './context';

// ---------------------------------------------------------------------------
// Fixtures — deliberately *differently* typed tokens (AGENTS.md §9): a
// service interface, a primitive, and a contribution element type that
// carries its own provenance, so nothing here can pass by being weaker than
// a real module's providers.
// ---------------------------------------------------------------------------

interface SessionClock {
  now(): number;
}
interface AnalyticsSink {
  /** C4/C9: the module the contribution was resolved on behalf of. */
  readonly source: string;
  record(event: string): void;
}

const SessionClockToken = createToken<SessionClock>('auth/SessionClock');
const MaxRetriesToken = createToken<number>('orders/MaxRetries');
const StorageRootToken = createToken<string>('storage/Root');
const AnalyticsSinkToken = createToken<AnalyticsSink>('telemetry/AnalyticsSink');

/** A session-expiry payload, so `ctx.on`'s handler args are not `unknown[]`. */
interface SessionExpired {
  readonly userId: string;
  readonly at: number;
}

function makeContext(moduleId = 'orders', onError?: (error: unknown) => void) {
  const container = new Container();
  const ctx = new ModuleContextImpl({ moduleId, container, ...(onError ? { onError } : {}) });
  return { container, ctx };
}

describe('ModuleContext — L1 resolution', () => {
  it('L1/C4: ctx.get resolves with this module as the resolution context', () => {
    const { container, ctx } = makeContext('orders');
    container.register('storage', [
      provide(StorageRootToken, {
        deps: [MODULE_ID],
        factory: (moduleId) => `/data/${moduleId}`,
      }),
    ]);

    // MODULE_ID is 'orders' — the module whose ctx started the chain — not
    // 'storage', the module that owns the provider.
    expect(ctx.get(StorageRootToken)).toBe('/data/orders');
  });

  it('L1/C4: the requester propagates through a nested resolution chain', () => {
    const { container, ctx } = makeContext('orders');
    container.register('storage', [
      provide(StorageRootToken, { deps: [MODULE_ID], factory: (id) => `/data/${id}` }),
      provide(SessionClockToken, {
        deps: [StorageRootToken],
        factory: (root): SessionClock => ({ now: () => root.length }),
      }),
    ]);

    expect(ctx.get(SessionClockToken).now()).toBe('/data/orders'.length);
  });

  it('L1/C9: ctx.getAll resolves each contribution on behalf of its own owner, not the caller', () => {
    const { container, ctx } = makeContext('orders');
    const sink = (source: string): AnalyticsSink => ({ source, record: () => {} });
    container.register('payments', [
      contribute(AnalyticsSinkToken, { deps: [MODULE_ID], factory: (id) => sink(id) }),
    ]);
    container.register('ui', [
      contribute(AnalyticsSinkToken, { deps: [MODULE_ID], factory: (id) => sink(id) }),
    ]);

    // The asymmetry with `get` is the requirement: 'orders' asked, but each
    // contribution still resolved as its own owner. A subscriber's presence
    // cannot change what MODULE_ID yields inside somebody else's factory.
    expect(ctx.getAll(AnalyticsSinkToken).map((entry) => entry.source)).toEqual(['payments', 'ui']);
  });

  it('L1: ctx.getAll returns [] for a token nobody contributes to', () => {
    const { ctx } = makeContext();
    expect(ctx.getAll(AnalyticsSinkToken)).toEqual([]);
  });
});

describe('ModuleContext — L2 effect', () => {
  it('L2: effect runs its callback immediately, before ctx.effect returns', () => {
    const { ctx } = makeContext();
    const order: string[] = [];
    ctx.effect(() => {
      order.push('ran');
    });
    order.push('after');
    expect(order).toEqual(['ran', 'after']);
  });

  it('L2: a cleanup returned by effect is not run until teardown', () => {
    const { ctx } = makeContext();
    const cleanup = vi.fn();
    ctx.effect(() => cleanup);
    expect(cleanup).toHaveBeenCalledTimes(0);
    ctx.runCleanups();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('L2: an effect that returns nothing registers no cleanup', () => {
    const { ctx } = makeContext();
    ctx.effect(() => undefined);
    expect(() => ctx.runCleanups()).not.toThrow();
  });

  it('L2: an effect body that throws propagates (it is init code, so activation fails)', () => {
    const { ctx } = makeContext();
    expect(() =>
      ctx.effect(() => {
        throw new Error('subscribe failed');
      }),
    ).toThrow('subscribe failed');
  });
});

describe('ModuleContext — L2 ctx.on duck-types four emitter shapes', () => {
  /**
   * Four emitters, one per supported shape. None of them is "the event bus":
   * spec §8 L2 requires `ctx.on` to work against spec 02's bus *without the
   * bus being special-cased*, so these are just four ordinary objects with
   * four ordinary conventions, and the bus is whichever one it happens to
   * look like.
   */
  function onOffEmitter() {
    const handlers = new Map<string, Set<(payload: SessionExpired) => void>>();
    return {
      handlers,
      on(event: string, handler: (payload: SessionExpired) => void): void {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
      },
      off(event: string, handler: (payload: SessionExpired) => void): void {
        handlers.get(event)?.delete(handler);
      },
      emit(event: string, payload: SessionExpired): void {
        for (const handler of handlers.get(event) ?? []) {
          handler(payload);
        }
      },
    };
  }

  const payload: SessionExpired = { userId: 'u-1', at: 1700000000 };

  it('L2: shape 1 — on(event, handler) / off(event, handler)', () => {
    const { ctx } = makeContext();
    const emitter = onOffEmitter();
    const handler = vi.fn<(p: SessionExpired) => void>();

    ctx.on(emitter, 'auth/session.expired', handler);
    emitter.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    ctx.runCleanups();
    emitter.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('L2: shape 2 — addListener / removeListener', () => {
    const { ctx } = makeContext();
    const base = onOffEmitter();
    const emitter = {
      addListener: base.on.bind(base),
      removeListener: base.off.bind(base),
    };
    const handler = vi.fn<(p: SessionExpired) => void>();

    ctx.on(emitter, 'auth/session.expired', handler);
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    ctx.runCleanups();
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('L2: shape 3 — addEventListener / removeEventListener', () => {
    const { ctx } = makeContext();
    const base = onOffEmitter();
    const emitter = {
      addEventListener: base.on.bind(base),
      removeEventListener: base.off.bind(base),
    };
    const handler = vi.fn<(p: SessionExpired) => void>();

    ctx.on(emitter, 'auth/session.expired', handler);
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    ctx.runCleanups();
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('L2: shape 4 — a subscribe function returning an unsubscribe', () => {
    const { ctx } = makeContext();
    const base = onOffEmitter();
    const subscribe = (event: string, handler: (p: SessionExpired) => void): (() => void) => {
      base.on(event, handler);
      return () => base.off(event, handler);
    };
    const handler = vi.fn<(p: SessionExpired) => void>();

    ctx.on(subscribe, 'auth/session.expired', handler);
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    ctx.runCleanups();
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('L2: a method pair only matches when both halves are functions', () => {
    // Subscribing with no way to unsubscribe would be a leak with a green
    // test, so half a pair is treated as no match at all.
    const { ctx } = makeContext('orders');
    const halfPair = { on: () => {} } as unknown as EventEmitterLike<[SessionExpired]>;
    expect(() => ctx.on(halfPair, 'auth/session.expired', () => {})).toThrow(UnsupportedEmitterError);
  });

  it('L2: an unrecognised emitter throws naming what it got and all four supported shapes', () => {
    const { ctx } = makeContext('orders');
    const notAnEmitter = { subscribe: () => {} } as unknown as EventEmitterLike<[SessionExpired]>;
    try {
      ctx.on(notAnEmitter, 'auth/session.expired', () => {});
      expect.unreachable('expected UnsupportedEmitterError');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEmitterError);
      expect((error as Error).message).toBe(
        "ctx.on('auth/session.expired') in module 'orders': the emitter is not subscribe-shaped " +
          '(got object). Supported emitter shapes are on(event, handler)/off(event, handler), ' +
          'addListener(event, handler)/removeListener(event, handler), ' +
          'addEventListener(event, handler)/removeEventListener(event, handler), or a subscribe function ' +
          '(event, handler) => unsubscribe.',
      );
    }
  });

  it('L2: a subscribe function that returns a non-function throws rather than leaking', () => {
    const { ctx } = makeContext('orders');
    const badSubscribe = (() => 42) as unknown as EventEmitterLike<[SessionExpired]>;
    try {
      ctx.on(badSubscribe, 'auth/session.expired', () => {});
      expect.unreachable('expected UnsupportedEmitterError');
    } catch (error) {
      expect((error as Error).message).toBe(
        "ctx.on('auth/session.expired') in module 'orders': the subscribe function returned number 42 " +
          'instead of an unsubscribe function. Supported emitter shapes are ' +
          'on(event, handler)/off(event, handler), ' +
          'addListener(event, handler)/removeListener(event, handler), ' +
          'addEventListener(event, handler)/removeEventListener(event, handler), or a subscribe function ' +
          '(event, handler) => unsubscribe.',
      );
    }
  });

  it('L2: a callable object that also has on/off subscribes through the method pair', () => {
    // The probe order is fixed so the choice is never ambiguous.
    const { ctx } = makeContext();
    const base = onOffEmitter();
    const callable = Object.assign(
      (_event: string, _handler: (p: SessionExpired) => void) => () => {
        throw new Error('the callable shape must not be chosen here');
      },
      { on: base.on.bind(base), off: base.off.bind(base) },
    );
    const handler = vi.fn<(p: SessionExpired) => void>();

    ctx.on(callable, 'auth/session.expired', handler);
    base.emit('auth/session.expired', payload);
    expect(handler).toHaveBeenCalledWith(payload);
    expect(() => ctx.runCleanups()).not.toThrow();
  });
});

describe('ModuleContext — L3 teardown', () => {
  it('L3: cleanups run in reverse registration order', () => {
    const { ctx } = makeContext();
    const order: string[] = [];
    ctx.effect(() => () => order.push('first'));
    ctx.effect(() => () => order.push('second'));
    ctx.on(
      (_event: string, _handler: (p: SessionExpired) => void) => () => order.push('third'),
      'auth/session.expired',
      () => {},
    );

    ctx.runCleanups();
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('L3: a cleanup that throws is reported and does not abort the remaining cleanups', () => {
    const onError = vi.fn();
    const { ctx } = makeContext('orders', onError);
    const order: string[] = [];
    ctx.effect(() => () => order.push('first'));
    ctx.effect(() => () => {
      throw new Error('cleanup blew up');
    });
    ctx.effect(() => () => order.push('third'));

    expect(() => ctx.runCleanups()).not.toThrow();
    expect(order).toEqual(['third', 'first']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('cleanup blew up');
  });

  it('L3: runCleanups is idempotent — a second call re-runs nothing', () => {
    const { ctx } = makeContext();
    const cleanup = vi.fn();
    ctx.effect(() => cleanup);
    ctx.runCleanups();
    ctx.runCleanups();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('ModuleContext — L4 the dead context', () => {
  it('L4: every member throws DeadContextError after the context is dead', () => {
    const { ctx } = makeContext('orders');
    ctx.runCleanups();
    ctx.markDead();

    const expected =
      "ModuleContext for 'orders' is dead: the module has been disposed. " +
      'This usually means code is holding a stale closure across HMR.';

    // Every member, individually — a single spot-check would let the other
    // four rot.
    expect(() => ctx.moduleId).toThrow(DeadContextError);
    expect(() => ctx.moduleId).toThrow(expected);
    expect(() => ctx.get(MaxRetriesToken)).toThrow(expected);
    expect(() => ctx.getAll(AnalyticsSinkToken)).toThrow(expected);
    expect(() => ctx.effect(() => {})).toThrow(expected);
    expect(() =>
      ctx.on(
        (_event: string, _handler: (p: SessionExpired) => void) => () => {},
        'auth/session.expired',
        () => {},
      ),
    ).toThrow(expected);
  });

  it('L4: moduleId is readable right up until markDead', () => {
    const { ctx } = makeContext('orders');
    expect(ctx.moduleId).toBe('orders');
    ctx.markDead();
    expect(() => ctx.moduleId).toThrow(DeadContextError);
  });

  it('L4: a dead context registers no new effect, so nothing can be leaked into it', () => {
    const { ctx } = makeContext('orders');
    ctx.markDead();
    const cleanup = vi.fn();
    expect(() => ctx.effect(() => cleanup)).toThrow(DeadContextError);
    ctx.runCleanups();
    expect(cleanup).toHaveBeenCalledTimes(0);
  });
});
