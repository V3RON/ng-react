// Shared public type vocabulary for the kernel. No implementations here —
// every other module imports from this file for its runtime vocabulary, and
// this file never imports runtime code back. `ModuleContext` below needs
// `Token<T>` to type `get`/`getAll`, so it imports that one type from
// `token.ts` with `import type` — erased at compile time, so it does not
// create a runtime dependency in either direction.

import type { Token } from './token';

/** A module's lifecycle state, exposed via `kernel.status` / `useModule` (A2). */
export type ModuleStatus = 'registered' | 'activating' | 'ready' | 'failed' | 'disposed';

/** Whether a module activates at startup or on first trigger (section 6). */
export type LoadStrategy = 'eager' | 'lazy';

/** The three flat provider scopes — no hierarchy (C2). */
export type Scope = 'singleton' | 'module' | 'transient';

/** Implemented by anything the container can tear down on scope end (C7). */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Returned by subscription-shaped APIs to remove the subscription. */
export type Unsubscribe = () => void;

/**
 * Every emitter shape `ctx.on` (L2) accepts: a subscribe/unsubscribe pair
 * keyed by event name, under any of the three conventional method-name
 * pairs, or a bare subscribe function that returns its own unsubscribe.
 *
 * Deliberately duck-typed and deliberately a *union*, not an interface to
 * implement — spec §8 L2 requires `ctx.on` to "work against the event bus
 * (spec 02) without the bus being special-cased", so this file must not
 * name, import, or privilege any concrete emitter. The four members below
 * are, between them, every subscription convention in the ecosystem the
 * kernel has to interoperate with:
 *
 * 1. `on` / `off` — Node's `EventEmitter`, most in-house buses.
 * 2. `addListener` / `removeListener` — Node's aliases, React Native's
 *    `NativeEventEmitter`.
 * 3. `addEventListener` / `removeEventListener` — DOM `EventTarget`,
 *    `AbortSignal`, `WebSocket`.
 * 4. `(event, handler) => unsubscribe` — the store/observable convention.
 *
 * Return types are `unknown` on purpose: Node's `EventEmitter#on` returns
 * `this` and DOM's `addEventListener` returns `void`, and requiring either
 * would exclude the other. `Args` is the tuple the handler receives, so
 * `ctx.on(bus, 'auth/session.expired', flush)` type-checks `flush` against
 * the payload the emitter declares.
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
 * The object passed to a module's `init`/`dispose` thunks (spec §8). Declared
 * here as an interface only — stage 1.2 (this file) fixes the shape so
 * `defineModule`'s `init`/`dispose` fields type-check; `kernel/context.ts`
 * provides the implementation. Do not implement this interface here.
 *
 * - **L1** — `get` resolves through the container with **this module** as
 *   resolution context (C4). `getAll` resolves the full reactive
 *   contribution collection (C5) and takes **no** resolution context: each
 *   contribution is resolved on behalf of its *own* owner (C9 provenance),
 *   so what `MODULE_ID` yields inside someone else's contribution factory
 *   cannot depend on who asked for the collection. The asymmetry is
 *   deliberate — see `container/collections.ts`'s header for the argument.
 * - **L2** — `effect` runs its callback immediately and registers the
 *   returned cleanup (if any) to run on dispose; `on` is sugar over `effect`
 *   for any subscribe/unsubscribe-shaped emitter.
 * - **L3/L4** — teardown runs collected cleanups in reverse registration
 *   order and then the context is dead: every member below throws
 *   `DeadContextError`, `moduleId` included.
 */
export interface ModuleContext {
  /** ADR-2: the id of the module owning this context; never `'app'`. L4: throws once disposed. */
  readonly moduleId: string;
  /** L1/C4: resolve a single provider, with this module as resolution context. */
  get<T>(token: Token<T>): T;
  /**
   * L1/C5: resolve the full reactive contribution collection for `token`.
   * Takes no resolution context — each contribution resolves on behalf of
   * its own owner (C9), not of this module.
   */
  getAll<T>(token: Token<T>): readonly T[];
  /** L2: run `fn` immediately; its returned cleanup (if any) runs on dispose. */
  effect(fn: () => void | (() => void)): void;
  /** L2: subscribe to `emitter`, auto-unsubscribing on dispose. */
  on<Args extends readonly unknown[]>(
    emitter: EventEmitterLike<Args>,
    event: string,
    handler: (...args: Args) => void,
  ): void;
}
