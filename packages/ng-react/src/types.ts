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
 * The minimal shape `ctx.on` (L2) needs from an event emitter: a
 * subscribe/unsubscribe pair keyed by event name. Deliberately duck-typed —
 * spec §8 requires `ctx.on` to "work against the event bus (spec 02) without
 * the bus being special-cased", so this is not tied to any concrete emitter
 * implementation. `Args` is the tuple of arguments the handler receives for
 * `event`.
 */
export interface EventEmitterLike<Args extends readonly unknown[] = readonly unknown[]> {
  on(event: string, handler: (...args: Args) => void): void;
  off(event: string, handler: (...args: Args) => void): void;
}

/**
 * The object passed to a module's `init`/`dispose` thunks (spec §8). Declared
 * here as an interface only — stage 1.2 (this file) fixes the shape so
 * `defineModule`'s `init`/`dispose` fields type-check; stage 3 (`kernel/context.ts`)
 * provides the implementation. Do not implement this interface here.
 *
 * - **L1** — `get`/`getAll` resolve through the container with this module as
 *   resolution context; `getAll` resolves the full reactive contribution
 *   collection (C5).
 * - **L2** — `effect` runs its callback immediately and registers the
 *   returned cleanup (if any) to run on dispose; `on` is sugar over `effect`
 *   for any subscribe/unsubscribe-shaped emitter.
 * - **L3/L4** — teardown and post-dispose behavior are implementation
 *   concerns owned by stage 3; nothing here encodes them.
 */
export interface ModuleContext {
  /** ADR-2: the id of the module owning this context; never `'app'`. */
  readonly moduleId: string;
  /** L1: resolve a single provider, with this module as resolution context. */
  get<T>(token: Token<T>): T;
  /** L1: resolve the full reactive contribution collection for `token` (C5). */
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
