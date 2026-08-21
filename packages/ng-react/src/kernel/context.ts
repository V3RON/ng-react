// The module context (spec §8, L1-L4).
//
// `ModuleContext` is the only object a module's `init`/`dispose` ever
// receives, and the reason spec §8 can say that "a hand-written `dispose`
// mirroring `init` is an anti-pattern": everything `init` sets up is
// registered here as it happens, so teardown is *structural* rather than
// remembered.
//
// This file owns three things and no more:
//
//  - **L1** — `get` (resolves with this module as C4 resolution context) and
//    `getAll` (resolves contributions, each on behalf of its own owner, C9).
//  - **L2** — `effect` and its `on` sugar, including the duck-typing that
//    lets `on` accept any subscribe-shaped API.
//  - **L4** — the death of the context, and the fact that *every* member
//    throws afterwards.
//
// **L3 ordering is not here.** Running the cleanups is (`runCleanups`), but
// the surrounding sequence — cleanups, then `dispose(ctx)`, then
// module-scoped instances, then withdrawing providers — is the kernel's
// call, in `kernel.ts`. The context cannot own it: it knows nothing about
// the descriptor's `dispose` handler or the registry, and a context that
// reached into the container to withdraw its own module's providers would
// be deciding lifecycle ordering from the wrong end.
//
// ADR-6: no `react` import.

import type { Container } from '../container/container';
import { DeadContextError, UnsupportedEmitterError } from '../errors';
import type { Token } from '../token';
import type { EventEmitterLike, ModuleContext, Unsubscribe } from '../types';

/** Constructor options for `ModuleContextImpl`. */
export interface ModuleContextOptions {
  /** C9: the id of the owning module, kernel-assigned from the activating descriptor. */
  readonly moduleId: string;
  /** The kernel's container — `get`/`getAll` delegate to it unchanged. */
  readonly container: Container;
  /**
   * L3: reports a cleanup that threw. Cleanup errors must not abort the
   * remaining cleanups, so they cannot be rethrown; they have to go
   * somewhere, and this is the seam. Task 3.3 replaces the injected
   * callback with `ErrorSinkToken` routing (F4) — deliberately *not* wired
   * here, because a second route to the sinks would be a second way to do
   * one thing (principle 5). Defaults to a no-op.
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
 * L2: subscribes `handler` to `event` on `emitter`, whatever shape the
 * emitter happens to have, and returns the matching unsubscribe.
 *
 * **Probe order is method pairs first, callable last**, and it is fixed so
 * the choice is never ambiguous: an object that is both callable and has an
 * `on`/`off` pair (a callable bus with method sugar) subscribes through the
 * pair. A pair only matches when *both* halves are functions — half a pair
 * is treated as no match, because subscribing with no way to unsubscribe
 * would turn `ctx.on` into a leak with a green test.
 *
 * Nothing here names or imports an event bus type: spec §8 L2 requires
 * `ctx.on` to work against spec 02's bus without special-casing it, so the
 * bus is just whichever of these four shapes it happens to expose.
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
 * The one implementation of `ModuleContext`. Internal: `index.ts` exports
 * the `ModuleContext` *type* only, because a module never constructs its own
 * context — the kernel hands it one, and that is what makes `moduleId`
 * kernel-assigned (C9) rather than self-reported.
 */
export class ModuleContextImpl implements ModuleContext {
  /**
   * L2/L3: cleanups in **registration** order. `runCleanups` walks this
   * backwards; an array plus a reverse walk is the whole mechanism.
   */
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
   * ADR-2/C9: the owning module's id.
   *
   * A getter rather than a field so that L4 covers it too. "The ctx is
   * dead: any use throws" has to include the cheapest possible use, or a
   * stale closure across HMR can still read a module id it has no business
   * holding and pass it around as a live identity.
   */
  get moduleId(): string {
    this.assertAlive();
    return this.id;
  }

  /** L1/C4: resolves `token` with **this module** as resolution context. */
  get<T>(token: Token<T>): T {
    this.assertAlive();
    return this.container.resolve(token, { requester: this.id });
  }

  /**
   * L1/C5: the full contribution collection for `token`, in module
   * topological order.
   *
   * Passes **no** requester, and that asymmetry with `get` is the point:
   * each contribution resolves on behalf of its own owner (C9), so a
   * module's mere act of reading a collection cannot change what
   * `MODULE_ID` yields inside another module's contribution factory. See
   * `container/collections.ts`.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    this.assertAlive();
    return this.container.getAll(token);
  }

  /**
   * L2: runs `fn` immediately and registers its returned cleanup, if any,
   * to run on dispose.
   *
   * An `fn` that throws propagates — it ran as part of `init`, so failing
   * it fails activation (F1). A cleanup registered by an earlier `effect`
   * in the same `init` still runs at teardown: the array is appended to as
   * it goes, never rebuilt at the end.
   */
  effect(fn: () => void | (() => void)): void {
    this.assertAlive();
    const cleanup = fn();
    if (typeof cleanup === 'function') {
      this.cleanups.push(cleanup);
    }
  }

  /**
   * L2: subscribes `handler` to `event` on `emitter` and unsubscribes on
   * dispose. Pure sugar over `effect` — same registration list, same
   * reverse ordering, no second teardown mechanism (principle 5).
   *
   * @throws {UnsupportedEmitterError} if `emitter` matches none of the four
   *   supported shapes, or is a subscribe function that returns something
   *   other than an unsubscribe.
   */
  on<Args extends readonly unknown[]>(
    emitter: EventEmitterLike<Args>,
    event: string,
    handler: (...args: Args) => void,
  ): void {
    this.assertAlive();
    // The erasure is confined to this one call: the public signature keeps
    // `Args` tied to the emitter's declared payload, and the duck-typing
    // below cannot know it.
    const erased = handler as unknown as ErasedHandler;
    this.effect(() => subscribeDuckTyped(this.id, emitter, event, erased));
  }

  /**
   * L3 step 1: runs every registered cleanup in **reverse registration
   * order**, reporting failures to `onError` and continuing regardless —
   * spec §8 L3: "cleanup errors are reported to the error policy but do not
   * abort remaining cleanups".
   *
   * Synchronous, because `effect`'s cleanup type is `() => void`: there is
   * no async cleanup to await, and inventing one here would be a second
   * disposal contract next to C7's `dispose()`/`onDispose`, which the
   * container already awaits under ADR-1's timeout.
   *
   * Idempotent: the list is emptied as it is walked, so a second call (or a
   * dispose racing an HMR teardown) re-runs nothing.
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
   * L4: marks the context dead. Called by the kernel *after* the
   * descriptor's `dispose(ctx)` handler has run — that handler legitimately
   * uses the context, so killing it earlier would break the one caller that
   * is supposed to be there.
   */
  markDead(): void {
    this.dead = true;
  }

  /** L4: the single gate every public member passes through. */
  private assertAlive(): void {
    if (this.dead) {
      throw new DeadContextError(this.id);
    }
  }
}
