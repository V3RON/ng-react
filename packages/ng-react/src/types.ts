import type { Token } from './token';

/** A module's lifecycle state. */
export type ModuleStatus = 'registered' | 'activating' | 'ready' | 'failed' | 'disposed';

/** Whether a module activates at startup or on first use. */
export type LoadStrategy = 'eager' | 'lazy';

/** The lifetime of a provider's instances. */
export type Scope = 'singleton' | 'module' | 'transient';

/** Implemented by anything the container tears down when its scope ends. */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Removes the subscription it was returned from. */
export type Unsubscribe = () => void;

/**
 * Which part of a module's life produced an error.
 *
 * - `activate` — activation failed as a whole: the `providers` thunk threw,
 *   `init` threw or timed out, or a dependency was quarantined.
 * - `init` — an error that escaped `init(ctx)` after activation had already
 *   been decided, i.e. a late rejection the kernel had stopped waiting for.
 * - `dispose` — a module `dispose(ctx)` handler, or a provider instance's
 *   `dispose()`/`onDispose`, threw or overran its timeout.
 * - `cleanup` — a cleanup registered via `ctx.effect`/`ctx.on` threw.
 * - `resolve` — a contribution factory or a contribution-collection
 *   subscriber threw.
 */
export type ErrorPhase = 'activate' | 'init' | 'dispose' | 'cleanup' | 'resolve';

/**
 * The attribution handed to every error sink alongside the error.
 *
 * `moduleId` is derived by the kernel from the module it was acting for,
 * never self-reported by the code that failed. It is `'app'` when no single
 * module owns the error.
 */
export interface ErrorInfo {
  readonly moduleId: string;
  readonly phase: ErrorPhase;
}

/**
 * A destination for errors the kernel handles rather than throws. Modules
 * register one with `contribute(ErrorSinkToken, …)`.
 *
 * Every contributed sink receives every error. A sink must not throw — one
 * that does is isolated, the remaining sinks still receive the report, and
 * its own error is not routed back through the sinks. It must also be cheap:
 * it runs on paths that are already failing.
 */
export interface ErrorSink {
  report(error: unknown, info: ErrorInfo): void;
}

/**
 * How the container hands the kernel an error it is not allowed to throw.
 *
 * `moduleId` is optional here and required on `ErrorInfo` because the
 * container knows the owner of a provider instance it is disposing, but not
 * of a subscriber callback or of one contribution among many. It omits the
 * attribution rather than inventing one, and the kernel substitutes `'app'`.
 *
 * Internal: not exported from `index.ts`.
 */
export type ErrorReporter = (
  error: unknown,
  info: { readonly moduleId?: string; readonly phase: ErrorPhase },
) => void;

/**
 * Every emitter shape `ctx.on` accepts: a subscribe/unsubscribe pair keyed by
 * event name under any of three conventional method-name pairs, or a bare
 * subscribe function returning its own unsubscribe.
 *
 * 1. `on` / `off` — Node's `EventEmitter`, most in-house buses.
 * 2. `addListener` / `removeListener` — React Native's `NativeEventEmitter`.
 * 3. `addEventListener` / `removeEventListener` — DOM `EventTarget`,
 *    `AbortSignal`, `WebSocket`.
 * 4. `(event, handler) => unsubscribe` — the store/observable convention.
 *
 * This is a union rather than an interface to implement: an emitter needs no
 * knowledge of the kernel to be usable. Subscribe/unsubscribe return types
 * are `unknown` because Node's `EventEmitter#on` returns `this` while DOM's
 * `addEventListener` returns `void`. `Args` is the tuple the handler
 * receives, so `ctx.on(bus, 'auth/session.expired', flush)` type-checks
 * `flush` against the payload the emitter declares.
 */
export type EventEmitterLike<Args extends readonly unknown[] = readonly unknown[]> =
  | {
      on(event: string, handler: (...args: Args) => void): unknown;
      off(event: string, handler: (...args: Args) => void): unknown;
    }
  | {
      addListener(event: string, handler: (...args: Args) => void): unknown;
      removeListener(event: string, handler: (...args: Args) => void): unknown;
    }
  | {
      addEventListener(event: string, handler: (...args: Args) => void): unknown;
      removeEventListener(event: string, handler: (...args: Args) => void): unknown;
    }
  | ((event: string, handler: (...args: Args) => void) => Unsubscribe);

/**
 * The object passed to a module's `init` and `dispose` handlers.
 *
 * On dispose, the collected cleanups run in reverse registration order and
 * the context becomes dead: every member below, `moduleId` included, throws
 * `DeadContextError` from then on. Do not retain it past `dispose`.
 */
export interface ModuleContext {
  /** The id of the module that owns this context. */
  readonly moduleId: string;
  /** Resolves a single provider, with this module as the resolution context. */
  get<T>(token: Token<T>): T;
  /**
   * Resolves the full contribution collection for `token`.
   *
   * Each contribution resolves on behalf of its own owning module, not of the
   * caller, so what `MODULE_ID` yields inside a contribution factory does not
   * depend on who asked for the collection.
   */
  getAll<T>(token: Token<T>): readonly T[];
  /** Runs `fn` immediately and registers the cleanup it returns, if any, to run on dispose. */
  effect(fn: () => void | (() => void)): void;
  /**
   * Subscribes `handler` to `event` on `emitter` and unsubscribes on dispose.
   *
   * @throws {UnsupportedEmitterError} if `emitter` matches none of the
   *   supported subscribe/unsubscribe shapes.
   */
  on<Args extends readonly unknown[]>(
    emitter: EventEmitterLike<Args>,
    event: string,
    handler: (...args: Args) => void,
  ): void;
}
