// F4's delivery rules and F2's fatal dispatch, unit-tested against
// `ErrorRouter` / `raiseFatal` directly. The kernel-level tests in
// `kernel.test.ts` pin the *policy* (who is attributed, which sinks are
// skipped, when a report happens at all); these pin the *mechanism*, which
// is easier to break and harder to observe through a whole kernel.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResolutionError } from '../errors';
import { createToken } from '../token';
import type { ErrorInfo, ErrorSink } from '../types';
import { ErrorRouter, ErrorSinkToken, raiseFatal } from './failure';

/** One captured `report` call. */
interface Captured {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/** A recording sink, optionally one that throws on every report. */
function recordingSink(into: Captured[], options: { readonly throws?: Error } = {}): ErrorSink {
  return {
    report(error, info) {
      into.push({ error, info });
      if (options.throws !== undefined) {
        throw options.throws;
      }
    },
  };
}

const CLEANUP: ErrorInfo = { moduleId: 'orders', phase: 'cleanup' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ErrorSinkToken (F4)', () => {
  it('F4/C1: is a token labelled kernel/ErrorSink and is a distinct identity from any lookalike', () => {
    expect(ErrorSinkToken.label).toBe('kernel/ErrorSink');
    // C1: labels are diagnostics, not identity. A module cannot capture the
    // kernel's sink collection by creating a token with the same label.
    expect(ErrorSinkToken).not.toBe(createToken<ErrorSink>('kernel/ErrorSink'));
  });
});

describe('ErrorRouter — delivery (F4)', () => {
  it('F4: routes one report to every sink, in collection order, with the attribution unchanged', () => {
    const first: Captured[] = [];
    const second: Captured[] = [];
    const order: string[] = [];
    const router = new ErrorRouter({
      resolveSinks: () => [
        {
          report: (error, info) => {
            order.push('first');
            recordingSink(first).report(error, info);
          },
        },
        {
          report: (error, info) => {
            order.push('second');
            recordingSink(second).report(error, info);
          },
        },
      ],
      isModuleLive: () => true,
    });

    const boom = new Error('unsubscribe failed');
    router.report(boom, CLEANUP);

    expect(order).toEqual(['first', 'second']);
    expect(first).toEqual([{ error: boom, info: CLEANUP }]);
    expect(second).toEqual([{ error: boom, info: CLEANUP }]);
  });

  it('F4: a throwing sink does not stop the others, and its own throw is not routed back to the sinks', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const captured: Captured[] = [];
    const sinkFailure = new Error('transport is down');
    const router = new ErrorRouter({
      resolveSinks: () => [recordingSink(captured, { throws: sinkFailure }), recordingSink(captured)],
      isModuleLive: () => true,
    });

    const boom = new Error('unsubscribe failed');
    router.report(boom, CLEANUP);

    // Both sinks saw the original report — the first one's throw did not
    // abort the pass.
    expect(captured).toEqual([
      { error: boom, info: CLEANUP },
      { error: boom, info: CLEANUP },
    ]);
    // The sink's own failure went to the console, *not* back through the
    // sinks: a sink whose transport is down throws on every report, so
    // re-routing would be unbounded recursion.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[ng-react] unreported error in module 'orders' (cleanup):");
    expect(consoleError.mock.calls[0]?.[1]).toBe(sinkFailure);
  });

  it('F4: a report raised *by* a sink while it is being routed does not recurse', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const captured: Captured[] = [];
    const reentrant = new Error('raised from inside a sink');
    const router: ErrorRouter = new ErrorRouter({
      resolveSinks: () => [
        {
          report: (error, info) => {
            captured.push({ error, info });
            // The realistic shape: a sink touches the kernel, which reports
            // again. Without the re-entrancy latch this is infinite.
            router.report(reentrant, { moduleId: 'telemetry', phase: 'resolve' });
          },
        },
      ],
      isModuleLive: () => true,
    });

    const boom = new Error('original');
    router.report(boom, CLEANUP);

    expect(captured).toEqual([{ error: boom, info: CLEANUP }]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toBe(reentrant);
  });

  it('F4: a sink collection that throws while resolving is reported to the console and the original report is buffered', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const captured: Captured[] = [];
    const resolveFailure = new ResolutionError(['kernel/ErrorSink', 'http/Client']);
    let broken = true;
    const router = new ErrorRouter({
      resolveSinks: () => {
        if (broken) {
          throw resolveFailure;
        }
        return [recordingSink(captured)];
      },
      isModuleLive: () => true,
    });

    const boom = new Error('unsubscribe failed');
    router.report(boom, CLEANUP);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[ng-react] unreported error in module 'app' (resolve):");
    expect(consoleError.mock.calls[0]?.[1]).toBe(resolveFailure);
    // Not swallowed: it is waiting for a sink that can be resolved.
    expect(router.bufferedCount).toBe(1);

    broken = false;
    router.flush();
    expect(captured).toEqual([{ error: boom, info: CLEANUP }]);
    expect(router.bufferedCount).toBe(0);
  });
});

describe('ErrorRouter — pre-sink buffering (F4)', () => {
  it('F4: reports raised before any sink exists are buffered and flushed to the first sink, oldest first', () => {
    const captured: Captured[] = [];
    let sinks: readonly ErrorSink[] = [];
    const router = new ErrorRouter({
      resolveSinks: () => sinks,
      isModuleLive: () => true,
    });

    const early = new Error('failed during startup');
    const later = new Error('failed a moment later');
    router.report(early, { moduleId: 'auth', phase: 'activate' });
    router.report(later, { moduleId: 'payments', phase: 'activate' });
    expect(captured).toEqual([]);
    expect(router.bufferedCount).toBe(2);

    sinks = [recordingSink(captured)];
    router.flush();

    expect(captured).toEqual([
      { error: early, info: { moduleId: 'auth', phase: 'activate' } },
      { error: later, info: { moduleId: 'payments', phase: 'activate' } },
    ]);
    expect(router.bufferedCount).toBe(0);
  });

  it('F4: a report that arrives once a sink exists drains the buffer ahead of itself', () => {
    const captured: Captured[] = [];
    let sinks: readonly ErrorSink[] = [];
    const router = new ErrorRouter({ resolveSinks: () => sinks, isModuleLive: () => true });

    const early = new Error('buffered');
    router.report(early, { moduleId: 'auth', phase: 'activate' });
    sinks = [recordingSink(captured)];
    const now = new Error('live');
    router.report(now, CLEANUP);

    expect(captured.map((entry) => entry.error)).toEqual([early, now]);
  });

  it('F4: the buffer is bounded — an overflowing report goes to the console rather than displacing an older one', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const captured: Captured[] = [];
    let sinks: readonly ErrorSink[] = [];
    const router = new ErrorRouter({
      resolveSinks: () => sinks,
      isModuleLive: () => true,
      bufferLimit: 2,
    });

    const first = new Error('first');
    const second = new Error('second');
    const overflow = new Error('overflow');
    router.report(first, CLEANUP);
    router.report(second, CLEANUP);
    router.report(overflow, CLEANUP);

    expect(router.bufferedCount).toBe(2);
    // Not swallowed.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toBe(overflow);

    sinks = [recordingSink(captured)];
    router.flush();
    // The *oldest* survived: the root cause precedes the cascade.
    expect(captured.map((entry) => entry.error)).toEqual([first, second]);
  });

  it('F4: the default bound is 50', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = new ErrorRouter({ resolveSinks: () => [], isModuleLive: () => true });

    for (let index = 0; index < 51; index += 1) {
      router.report(new Error(`boom ${index}`), CLEANUP);
    }

    expect(router.bufferedCount).toBe(50);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('F4: flush is a no-op with nothing buffered, and does not resolve the sinks', () => {
    const resolveSinks = vi.fn(() => []);
    const router = new ErrorRouter({ resolveSinks, isModuleLive: () => true });
    router.flush();
    expect(resolveSinks).not.toHaveBeenCalled();
  });
});

describe('raiseFatal (F2)', () => {
  it('F2: calls the configured onFatal handler and does not rethrow', () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const boom = new Error('no keychain');

    raiseFatal(boom, { dev: true, onFatal });

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(boom);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('F2: with no handler, rethrows from a fresh macrotask so the host surfaces it', () => {
    vi.useFakeTimers();
    const boom = new Error('no keychain');

    raiseFatal(boom, { dev: false });

    expect(() => vi.runAllTimers()).toThrow(boom);
  });

  it('F2: in dev the module id and error are named on the console on the way out', () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = Object.assign(new Error('no keychain'), { moduleId: 'auth' });

    raiseFatal(boom, { dev: true });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("[ng-react] unreported error in module 'auth' (activate):");
    expect(() => vi.runAllTimers()).toThrow(boom);
  });

  it('F2: an onFatal that throws is contained — the console gets it and nothing is rethrown', () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlerFailure = new Error('the fatal handler is broken too');

    raiseFatal(new Error('no keychain'), {
      dev: false,
      onFatal: () => {
        throw handlerFailure;
      },
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toBe(handlerFailure);
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
