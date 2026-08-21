// The failure policy (spec §10, F1-F4).
//
// F1 (retain the error) and F2's signal (reject `whenStartupComplete`) live
// in `kernel.ts`, because they are states of a module and of startup. This
// file owns the two parts that are mechanisms rather than states:
//
//  - **`ErrorSinkToken`** — F4's contribution collection. Error *reporting*
//    is not a kernel API surface; it is an ordinary C5 collection that the
//    kernel happens to own the token for. A module `contribute`s a sink and
//    gets every lifecycle, cleanup, resolution and activation error the
//    kernel handles, with kernel-assigned attribution (C9).
//  - **`ErrorRouter`** — the delivery rules. Everything below exists
//    because the error-reporting path is, by definition, the path that runs
//    when something is already broken: it must not itself throw, recurse,
//    or silently drop.
//
// Error *containment* for rendered screens (per-module error boundaries) is
// explicitly not here and not in this spec — §10 F4 puts it in spec 03,
// built on provenance. This file adds no error boundary and no red screen.
//
// ADR-6: no `react` import.

import { createToken } from '../token';
import type { ErrorInfo, ErrorSink } from '../types';

/**
 * **F4**: the token modules contribute error sinks to.
 *
 * A `contribute` token, never a `provide` one: the registry rejects mixing
 * the two kinds for a token (C5), so this being contributed once anywhere
 * permanently fixes it as a collection — which is exactly the intent. There
 * is no "the" error sink, and no module can become one by provideing it.
 *
 * The label follows ADR-8's `moduleId/Name` convention with `kernel` as the
 * owning "module": the kernel is the only thing that ever reads this
 * collection.
 */
export const ErrorSinkToken = createToken<ErrorSink>('kernel/ErrorSink');

/**
 * How many reports are buffered while no sink exists yet. See
 * `ErrorRouter`'s header for why buffering exists and why it is bounded.
 */
const DEFAULT_BUFFER_LIMIT = 50;

/** One report waiting for a sink to exist. */
interface BufferedReport {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/** Constructor options for `ErrorRouter`. */
export interface ErrorRouterOptions {
  /**
   * Resolves the live `ErrorSinkToken` collection, passing `accept` down to
   * the container so that a rejected owner's sink is **never constructed**
   * (see `Container.getAllWhere`). Injected rather than taking a
   * `Container` so this file stays a policy, testable without one.
   */
  readonly resolveSinks: (accept: (ownerModuleId: string) => boolean) => readonly ErrorSink[];
  /**
   * **F4**: `false` for a module whose sinks must be skipped — one that is
   * `failed` (quarantined) or `disposed`. A quarantined module's code is
   * exactly the code that just proved it cannot be trusted, and a disposed
   * module's sink would be resurrected by the very report that says it is
   * gone.
   */
  readonly isModuleLive: (moduleId: string) => boolean;
  /** Test seam. Defaults to 50 — see the header. */
  readonly bufferLimit?: number;
}

/**
 * **F4**: routes an error to every contributed `ErrorSink`.
 *
 * Four rules, each of which is a way the naive implementation breaks on the
 * day it is needed:
 *
 * 1. **A throwing sink is isolated and its throw is never re-routed.**
 *    Routing a sink's own failure back through the sinks is unbounded
 *    mutual recursion between two sinks that both throw, and it is not
 *    hypothetical: a sink whose transport is down throws on *every* report,
 *    including the report about itself. A re-entrancy latch (`routing`)
 *    makes the rule structural rather than a promise — anything reported
 *    while a pass is in flight goes to the last resort, whether it came
 *    from a sink, from a `subscribeAll` subscriber a sink triggered, or
 *    from three frames deeper.
 *
 * 2. **Resolving the sinks can itself throw.** They are contributions with
 *    factories and dependencies like any other provider (C3), so a sink
 *    whose factory throws, or which depends on a token nobody provides
 *    (C8), fails *while the kernel is trying to report something else*.
 *    That failure goes to the last resort and the original report is
 *    buffered rather than lost.
 *
 * 3. **Errors raised before any sink exists are buffered, not dropped.**
 *    The first errors an application produces are the ones raised during
 *    the startup activation pass — before the telemetry module that
 *    contributes the sink has activated. Dropping those would make F4
 *    useless for precisely the failures it matters most for. Of the issue's
 *    two options this is the buffering one, and it is bounded at 50: an app
 *    with no sink at all must not accumulate every error it ever produces.
 *
 * 4. **Overflow does not swallow.** Once the buffer is full the *newest*
 *    report goes straight to `console.error` instead of displacing an older
 *    one. Both halves are deliberate: the oldest reports are kept because
 *    the root cause precedes the cascade it triggers, and the overflowing
 *    report still reaches a human because "bounded" must not become a
 *    quiet upper bound on how many errors an app is allowed to have.
 *
 * `console.error` is the last resort in dev *and* in production. The
 * alternative — drop in production — makes the unroutable-error path silent
 * exactly where nobody is watching, and by construction this path is only
 * reached when the app's own sinks are missing or broken.
 */
export class ErrorRouter {
  private readonly resolveSinks: (accept: (ownerModuleId: string) => boolean) => readonly ErrorSink[];
  private readonly isModuleLive: (moduleId: string) => boolean;
  private readonly bufferLimit: number;
  private readonly buffer: BufferedReport[] = [];
  /** Rule 1: true while a routing pass is in flight. */
  private routing = false;

  constructor(options: ErrorRouterOptions) {
    this.resolveSinks = options.resolveSinks;
    this.isModuleLive = options.isModuleLive;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  /**
   * F4: reports `error`, attributed to `moduleId` in `phase`, to every live
   * sink — or buffers it if there are none yet.
   *
   * Never throws. A caller on a teardown or quarantine path must be able to
   * report without a `try`, or the reporting itself becomes the thing that
   * aborts the teardown (L3).
   */
  report(error: unknown, info: ErrorInfo): void {
    if (this.routing) {
      // Rule 1. Re-entrancy means a sink (or something a sink called) is
      // failing while we report; routing it would recurse.
      lastResort(error, info);
      return;
    }
    this.routing = true;
    try {
      const sinks = this.liveSinks();
      if (sinks.length === 0) {
        this.enqueue(error, info);
        return;
      }
      this.drain(sinks);
      deliver(sinks, error, info);
    } finally {
      this.routing = false;
    }
  }

  /**
   * Delivers anything buffered, if a sink exists now. Called by the kernel
   * whenever the sink collection may have grown — i.e. after a module
   * activates — so a buffered startup failure reaches the first sink to
   * register without waiting for a second error to push it out.
   *
   * Cheap and safe to call unconditionally: it returns immediately when
   * nothing is buffered, which is the overwhelmingly common case.
   */
  flush(): void {
    if (this.buffer.length === 0 || this.routing) {
      return;
    }
    this.routing = true;
    try {
      const sinks = this.liveSinks();
      if (sinks.length > 0) {
        this.drain(sinks);
      }
    } finally {
      this.routing = false;
    }
  }

  /** Diagnostic seam for the tests: how many reports are waiting for a sink. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Rule 2: resolving the sinks must not become a second failure. */
  private liveSinks(): readonly ErrorSink[] {
    try {
      return this.resolveSinks((ownerModuleId) => this.isModuleLive(ownerModuleId));
    } catch (error) {
      lastResort(error, { moduleId: 'app', phase: 'resolve' });
      return [];
    }
  }

  /** Rules 3 and 4. */
  private enqueue(error: unknown, info: ErrorInfo): void {
    if (this.buffer.length >= this.bufferLimit) {
      lastResort(error, info);
      return;
    }
    this.buffer.push({ error, info });
  }

  /**
   * Hands every buffered report to `sinks`, oldest first, and empties the
   * buffer **before** delivering — a sink that throws must not leave the
   * buffer half-drained and redeliver its contents on the next report.
   */
  private drain(sinks: readonly ErrorSink[]): void {
    if (this.buffer.length === 0) {
      return;
    }
    const pending = this.buffer.splice(0, this.buffer.length);
    for (const report of pending) {
      deliver(sinks, report.error, report.info);
    }
  }
}

/** Rule 1: every sink runs, and a throwing one is contained. */
function deliver(sinks: readonly ErrorSink[], error: unknown, info: ErrorInfo): void {
  for (const sink of sinks) {
    try {
      sink.report(error, info);
    } catch (sinkError) {
      lastResort(sinkError, info);
    }
  }
}

/**
 * The end of the line: an error that cannot reach a sink, either because
 * none exists yet and the buffer is full, or because reporting it *is* what
 * failed.
 *
 * Guarded on `console` existing at all — the kernel has to run under React
 * Native and in a bare JS runtime, and the last-resort reporter must not
 * become the thing that throws.
 */
function lastResort(error: unknown, info: ErrorInfo): void {
  const console_ = (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console;
  if (typeof console_?.error === 'function') {
    console_.error(`[ng-react] unreported error in module '${info.moduleId}' (${info.phase}):`, error);
  }
}

/**
 * **F2**: startup failed on a `critical` module, visibly.
 *
 * The issue specifies: call the configurable `KernelOptions.onFatal`
 * handler; with no handler, the dev default is to rethrow so the host
 * surfaces a red screen, and the prod default is "call `onFatal` if
 * provided, else rethrow". **As worded those two defaults are the same
 * behaviour** — with no handler, both rethrow — so there is one code path
 * here and `dev` changes only how loud it is on the way out, not what
 * happens. Implemented as written rather than "fixed"; see the PR for #16.
 *
 * "Rethrow" cannot mean throwing on the caller's stack: an F2 failure
 * happens inside the startup activation pass, which runs on a microtask the
 * kernel scheduled and no host is awaiting, so a synchronous throw would be
 * swallowed by the kernel's own `catch`. It therefore means rethrowing from
 * a fresh macrotask, where nothing is left to catch it and it reaches the
 * host's global error handler — which is what actually produces a red box
 * in React Native and an `onerror`/`uncaughtException` in a browser or in
 * Node. Building the red screen itself is the host's job, per the issue.
 *
 * `whenStartupComplete()` has already been rejected by the caller; this is
 * the second, non-optional half, for the host that never called it.
 */
export function raiseFatal(
  error: unknown,
  options: { readonly dev: boolean; readonly onFatal?: (error: unknown) => void },
): void {
  const { dev, onFatal } = options;
  if (onFatal !== undefined) {
    try {
      onFatal(error);
    } catch (handlerError) {
      // The fatal handler is the last thing standing; if it fails too there
      // is nowhere left to route to but the console. Sending it to the
      // error sinks instead would make a critically-failed startup depend
      // on some module having activated — which is the situation that just
      // failed.
      lastResort(handlerError, { moduleId: 'app', phase: 'activate' });
    }
    return;
  }
  if (dev) {
    // Spec §10 F2 asks the *dev* surface to name the module and the error.
    // The red screen is the host's; naming it in the console costs nothing
    // and survives a host with no global handler at all.
    lastResort(error, { moduleId: moduleIdOf(error) ?? 'app', phase: 'activate' });
  }
  setTimeout(() => {
    throw error;
  }, 0);
}

/** Best-effort module attribution from a `KernelError`'s own `moduleId`. */
function moduleIdOf(error: unknown): string | undefined {
  const candidate = (error as { moduleId?: unknown } | null | undefined)?.moduleId;
  return typeof candidate === 'string' ? candidate : undefined;
}
