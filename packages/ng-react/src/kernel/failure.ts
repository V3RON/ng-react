import { createToken } from '../token';
import type { ErrorInfo, ErrorSink } from '../types';

/**
 * The token modules contribute error sinks to. Every sink receives every
 * lifecycle, cleanup, resolution and activation error the kernel handles,
 * with kernel-assigned attribution.
 *
 * Always `contribute`d, never `provide`d: the registry rejects mixing the
 * two kinds for one token, so the first contribution anywhere permanently
 * fixes it as a collection. There is no single "the" error sink.
 */
export const ErrorSinkToken = createToken<ErrorSink>('kernel/ErrorSink');

/** How many reports are buffered while no sink exists yet. */
const DEFAULT_BUFFER_LIMIT = 50;

/** One report waiting for a sink to exist. */
interface BufferedReport {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/** Constructor options for `ErrorRouter`. */
export interface ErrorRouterOptions {
  /**
   * Resolves the live `ErrorSinkToken` collection. `accept` is passed down
   * to the container so a rejected owner's sink is **never constructed**.
   */
  readonly resolveSinks: (accept: (ownerModuleId: string) => boolean) => readonly ErrorSink[];
  /**
   * Whether a module's sinks may be used. `false` for a `failed`
   * (quarantined) or `disposed` module: a quarantined module's code is
   * exactly the code that just proved it cannot be trusted, and a disposed
   * module's sink would be resurrected by the report saying it is gone.
   */
  readonly isModuleLive: (moduleId: string) => boolean;
  /**
   * How many reports to hold while no sink exists.
   *
   * @default 50
   */
  readonly bufferLimit?: number;
}

/**
 * Routes an error to every contributed `ErrorSink`. Anything it cannot
 * route reaches `console.error`, in dev and in production alike.
 *
 * Four behaviours a caller depends on:
 *
 * 1. **A throwing sink is isolated, and its throw is never re-routed.**
 *    Routing a sink's own failure back through the sinks would recurse
 *    unboundedly between two sinks that both throw — not hypothetical, since
 *    a sink whose transport is down throws on every report, including the
 *    report about itself. Anything reported while a routing pass is in
 *    flight goes to the console instead, however many frames deep it was
 *    raised.
 *
 * 2. **Resolving the sinks can itself throw**, since sinks are ordinary
 *    contributions with factories and dependencies. That failure goes to the
 *    console and the original report is buffered rather than lost.
 *
 * 3. **Errors raised before any sink exists are buffered, not dropped.** The
 *    first errors an application produces come from the startup activation
 *    pass, before the module contributing a sink has activated.
 *
 * 4. **Overflow does not swallow.** Once the buffer is full the *newest*
 *    report goes to the console rather than displacing an older one: the
 *    root cause precedes the cascade it triggers, so the oldest reports are
 *    the ones worth keeping.
 */
export class ErrorRouter {
  private readonly resolveSinks: (accept: (ownerModuleId: string) => boolean) => readonly ErrorSink[];
  private readonly isModuleLive: (moduleId: string) => boolean;
  private readonly bufferLimit: number;
  private readonly buffer: BufferedReport[] = [];
  /** True while a routing pass is in flight; see behaviour 1. */
  private routing = false;

  constructor(options: ErrorRouterOptions) {
    this.resolveSinks = options.resolveSinks;
    this.isModuleLive = options.isModuleLive;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  /**
   * Reports `error`, attributed to `info.moduleId` in `info.phase`, to every
   * live sink — or buffers it if there are none yet.
   *
   * Never throws, so a caller on a teardown or quarantine path can report
   * without a surrounding `try`.
   */
  report(error: unknown, info: ErrorInfo): void {
    if (this.routing) {
      // Re-entrancy means a sink, or something a sink called, is failing
      // while we report; routing it would recurse.
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
   * Delivers anything buffered, if a sink exists now.
   *
   * Called whenever the sink collection may have grown, so a buffered
   * startup failure reaches the first sink to register without waiting for
   * a second error to push it out. Cheap and safe to call unconditionally.
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

  /** How many reports are waiting for a sink. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Behaviour 2: resolving the sinks must not become a second failure. */
  private liveSinks(): readonly ErrorSink[] {
    try {
      return this.resolveSinks((ownerModuleId) => this.isModuleLive(ownerModuleId));
    } catch (error) {
      lastResort(error, { moduleId: 'app', phase: 'resolve' });
      return [];
    }
  }

  /** Behaviours 3 and 4. */
  private enqueue(error: unknown, info: ErrorInfo): void {
    if (this.buffer.length >= this.bufferLimit) {
      lastResort(error, info);
      return;
    }
    this.buffer.push({ error, info });
  }

  /**
   * Hands every buffered report to `sinks`, oldest first, emptying the
   * buffer **before** delivering: a sink that throws must not leave the
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

/** Every sink runs, and a throwing one is contained. */
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
 * Guarded on `console` existing at all, so the last-resort reporter cannot
 * itself become the thing that throws.
 */
function lastResort(error: unknown, info: ErrorInfo): void {
  const console_ = (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console;
  if (typeof console_?.error === 'function') {
    console_.error(`[ng-react] unreported error in module '${info.moduleId}' (${info.phase}):`, error);
  }
}

/**
 * Surfaces a startup failure on a `critical` module to the host.
 *
 * With an `onFatal` handler, that handler is called and nothing is rethrown;
 * a handler that itself throws falls back to the console. Without one, the
 * error is rethrown **from a fresh macrotask** rather than on the caller's
 * stack, since the startup pass runs on a microtask nobody is awaiting and a
 * synchronous throw would be caught by the kernel itself. From a macrotask
 * it reaches the host's global error handler — a red box in React Native, an
 * `onerror` or `uncaughtException` elsewhere. In dev the error is also named
 * on the console, which survives a host with no global handler at all.
 *
 * Never throws on the caller's stack. `whenStartupComplete()` has already
 * been rejected by the caller; this is the half for the host that never
 * called it.
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
      // Routing this to the error sinks instead would make a
      // critically-failed startup depend on some module having activated,
      // which is the situation that just failed.
      lastResort(handlerError, { moduleId: 'app', phase: 'activate' });
    }
    return;
  }
  if (dev) {
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
