import type { Container } from '../container/container';
import { DeadContextError, UnsupportedEmitterError } from '../errors';
import type { Token } from '../token';
import type { EventEmitterLike, ModuleContext, Unsubscribe } from '../types';

/** Constructor options for `ModuleContextImpl`. */
export interface ModuleContextOptions {
  /** The id of the owning module, assigned by the kernel. */
  readonly moduleId: string;
  /** The kernel's container — `get`/`getAll` delegate to it unchanged. */
  readonly container: Container;
  /**
   * Receives a cleanup that threw. Cleanup errors must not abort the
   * remaining cleanups, so they are never rethrown.
   *
   * @default a no-op
   */
  readonly onError?: (error: unknown) => void;
}

/** The three method-name pairs `ctx.on` duck-types, in probe order. */
const EMITTER_METHOD_PAIRS: readonly (readonly [string, string])[] = [
  ['on', 'off'],
  ['addListener', 'removeListener'],
  ['addEventListener', 'removeEventListener'],
];

/** Erased handler type for the duck-typed call into an unknown emitter. */
type ErasedHandler = (...args: never[]) => void;

/** Renders a value for an error message: `string 'x'`, `number 42`, `null`, … */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `string '${value}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`;
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Subscribes `handler` to `event` on `emitter`, whatever subscribe-shaped
 * API it exposes, and returns the matching unsubscribe.
 *
 * Method pairs are probed before the callable form, so an object that is
 * both callable and has an `on`/`off` pair subscribes through the pair. A
 * pair matches only when *both* halves are functions: subscribing with no
 * way to unsubscribe would make `ctx.on` a leak.
 *
 * @throws {UnsupportedEmitterError} if `emitter` matches no supported shape,
 *   or is a subscribe function that returns something other than an
 *   unsubscribe function.
 */
function subscribeDuckTyped(
  moduleId: string,
  emitter: unknown,
  event: string,
  handler: ErasedHandler,
): Unsubscribe {
  if (emitter !== null && (typeof emitter === 'object' || typeof emitter === 'function')) {
    const probe = emitter as Record<string, unknown>;
    for (const [subscribeName, unsubscribeName] of EMITTER_METHOD_PAIRS) {
      const subscribe = probe[subscribeName];
      const unsubscribe = probe[unsubscribeName];
      if (typeof subscribe === 'function' && typeof unsubscribe === 'function') {
        (subscribe as (e: string, h: ErasedHandler) => unknown).call(emitter, event, handler);
        return () => {
          (unsubscribe as (e: string, h: ErasedHandler) => unknown).call(emitter, event, handler);
        };
      }
    }
  }

  if (typeof emitter === 'function') {
    const result = (emitter as (e: string, h: ErasedHandler) => unknown)(event, handler);
    if (typeof result !== 'function') {
      throw new UnsupportedEmitterError(
        moduleId,
        event,
        `the subscribe function returned ${describeValue(result)} instead of an unsubscribe function`,
      );
    }
    return result as Unsubscribe;
  }

  throw new UnsupportedEmitterError(
    moduleId,
    event,
    `the emitter is not subscribe-shaped (got ${describeValue(emitter)})`,
  );
}

/**
 * The one implementation of `ModuleContext`. Internal: a module never
 * constructs its own context, which is what makes `moduleId`
 * kernel-assigned rather than self-reported.
 */
export class ModuleContextImpl implements ModuleContext {
  /** Cleanups in registration order. `runCleanups` walks this backwards. */
  private readonly cleanups: (() => void)[] = [];
  private readonly id: string;
  private readonly container: Container;
  private readonly onError: (error: unknown) => void;
  private dead = false;

  constructor(options: ModuleContextOptions) {
    this.id = options.moduleId;
    this.container = options.container;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * The owning module's id.
   *
   * A getter rather than a field so that it too throws once the context is
   * dead: otherwise a closure that outlived a hot update could still read a
   * module id and pass it around as a live identity.
   *
   * @throws {DeadContextError} once the module has been disposed.
   */
  get moduleId(): string {
    this.assertAlive();
    return this.id;
  }

  /**
   * Resolves `token` with **this module** as the resolution context, so
   * `MODULE_ID` yields this module's id inside every factory in the chain.
   *
   * @throws {DeadContextError} once the module has been disposed.
   * @throws {ResolutionError} if no module provides `token`.
   */
  get<T>(token: Token<T>): T {
    this.assertAlive();
    return this.container.resolve(token, { requester: this.id });
  }

  /**
   * The full contribution collection for `token`, in module topological
   * order.
   *
   * Unlike `get`, this does not make the reading module the resolution
   * context: each contribution resolves on behalf of its own owner, so
   * reading a collection cannot change what `MODULE_ID` yields inside
   * another module's contribution factory.
   *
   * @throws {DeadContextError} once the module has been disposed.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    this.assertAlive();
    return this.container.getAll(token);
  }

  /**
   * Runs `fn` immediately and registers its returned cleanup, if any, to
   * run on dispose.
   *
   * A throwing `fn` propagates, so an `effect` that fails during `init`
   * fails the activation. Cleanups registered by earlier `effect` calls in
   * the same `init` are kept and still run at teardown.
   *
   * @throws {DeadContextError} once the module has been disposed.
   */
  effect(fn: () => void | (() => void)): void {
    this.assertAlive();
    const cleanup = fn();
    if (typeof cleanup === 'function') {
      this.cleanups.push(cleanup);
    }
  }

  /**
   * Subscribes `handler` to `event` on `emitter` and unsubscribes on
   * dispose. Sugar over `effect`, sharing its registration list and reverse
   * teardown ordering.
   *
   * @throws {DeadContextError} once the module has been disposed.
   * @throws {UnsupportedEmitterError} if `emitter` matches none of the
   *   supported shapes, or is a subscribe function that returns something
   *   other than an unsubscribe.
   */
  on<Args extends readonly unknown[]>(
    emitter: EventEmitterLike<Args>,
    event: string,
    handler: (...args: Args) => void,
  ): void {
    this.assertAlive();
    // The erasure is confined to this call: the public signature keeps
    // `Args` tied to the emitter's declared payload, which the duck-typed
    // subscribe cannot know.
    const erased = handler as unknown as ErasedHandler;
    this.effect(() => subscribeDuckTyped(this.id, emitter, event, erased));
  }

  /**
   * Runs every registered cleanup in **reverse registration order**,
   * reporting failures to `onError` and continuing regardless: one throwing
   * cleanup never aborts the remaining ones.
   *
   * Idempotent — the list is emptied as it is walked, so a second call, or
   * a disposal racing a hot update's teardown, re-runs nothing. Never
   * throws.
   */
  runCleanups(): void {
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (cleanup === undefined) {
        continue;
      }
      try {
        cleanup();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /**
   * Marks the context dead, after which every member throws
   * `DeadContextError`.
   *
   * Called by the kernel *after* the descriptor's `dispose(ctx)` handler has
   * run: that handler legitimately uses the context.
   */
  markDead(): void {
    this.dead = true;
  }

  /** The single gate every public member passes through. */
  private assertAlive(): void {
    if (this.dead) {
      throw new DeadContextError(this.id);
    }
  }
}
