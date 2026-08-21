// Leak counters, and the instrumentation that feeds them.
//
// Three things are counted per module, each as a pair of a registration
// event and a cleanup event, so a count is "outstanding registrations":
//
//  - `listener` — one `ctx.on(...)` registration, released when its
//    unsubscribe cleanup runs.
//  - `effect`   — one `ctx.effect(...)` registration, released when its
//    cleanup runs.
//  - `instance` — one `module`-scoped, non-`persistent` provider instance,
//    released when the container disposes it.
//
// `persistent: true` records are not counted at all, neither acquire nor
// release. A preserved persistent instance is deliberately never disposed by
// a hot replace — disposing a store is how a store throws its state away —
// so its acquire would have no matching release. Excluding the record from
// the wrapper entirely keeps the pairing symmetric on every path. The cost,
// stated plainly: a persistent instance that genuinely leaked is invisible
// to these counters.
//
// `singleton`-scoped instances are not counted either. A live module's
// singleton would show up as an outstanding `instance`, so `balanced` would
// mean "nothing is alive" rather than "nothing leaked". `transient`
// instances are out because the container never disposes one — its lifetime
// is the caller's, and there is nothing here to balance.
//
// Gating is structural: when the kernel is not in dev mode, `test-kernel.ts`
// installs none of the wrappers below, nothing is allocated per registration
// and no counting code runs.

import type { Disposable, EventEmitterLike, ModuleContext } from '../types';
import type { AnyProviderRecord, ProviderOptions, ProviderRecord } from '../provider';
import { contribute, provide } from '../provider';
import type { Dep, Token } from '../token';

/** The three things counted. */
type LeakKind = 'listener' | 'effect' | 'instance';

/**
 * Outstanding registration counts at one instant.
 *
 * A frozen snapshot, never a live view, so two reports taken at different
 * moments can be subtracted. A live module's counts are non-zero by design;
 * what a leak looks like is a count that fails to come back down once the
 * module is disposed.
 *
 * @example
 * ```ts
 * const baseline = kernel.leaks();
 * await kernel.hotReplace(Orders, nextOrders);
 * const after = kernel.leaks();
 * // Compare `details` per (moduleId, kind).
 * ```
 */
export interface LeakReport {
  /** Outstanding `ctx.on` registrations across every module. */
  readonly listeners: number;
  /** Outstanding `ctx.effect` registrations across every module. */
  readonly effects: number;
  /**
   * Outstanding `module`-scoped, non-`persistent` provider instances. See
   * the file header for both exclusions.
   */
  readonly moduleInstances: number;
  /** Whether every count is zero. */
  readonly balanced: boolean;
  /**
   * Per-module, per-kind outstanding counts, sorted by `moduleId` then
   * `kind`. Non-zero entries only, so an empty `details` means
   * `balanced === true`.
   */
  readonly details: readonly { readonly moduleId: string; readonly kind: LeakKind; readonly count: number }[];
}

/**
 * The per-kernel counter set. One instance per test kernel, so two test
 * kernels in one file never interfere.
 */
export class LeakCounters {
  /** Lazily created: a kernel that registers nothing allocates no map. */
  private counts: Map<string, Map<LeakKind, number>> | undefined;

  /** Records one registration. */
  acquire(moduleId: string, kind: LeakKind): void {
    const counts = (this.counts ??= new Map());
    let byKind = counts.get(moduleId);
    if (byKind === undefined) {
      byKind = new Map();
      counts.set(moduleId, byKind);
    }
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  /**
   * Records one cleanup.
   *
   * Never clamps at zero: a negative count means something was released
   * twice, and must stay visible rather than round away into a green
   * `balanced`.
   */
  release(moduleId: string, kind: LeakKind): void {
    const counts = (this.counts ??= new Map());
    let byKind = counts.get(moduleId);
    if (byKind === undefined) {
      byKind = new Map();
      counts.set(moduleId, byKind);
    }
    byKind.set(kind, (byKind.get(kind) ?? 0) - 1);
  }

  /** Returns the current outstanding counts as a frozen snapshot. */
  report(): LeakReport {
    const details: { readonly moduleId: string; readonly kind: LeakKind; readonly count: number }[] = [];
    let listeners = 0;
    let effects = 0;
    let moduleInstances = 0;
    for (const moduleId of [...(this.counts?.keys() ?? [])].sort()) {
      const byKind = this.counts?.get(moduleId);
      if (byKind === undefined) {
        continue;
      }
      for (const kind of ['effect', 'instance', 'listener'] as const) {
        const count = byKind.get(kind) ?? 0;
        if (count === 0) {
          continue;
        }
        details.push(Object.freeze({ moduleId, kind, count }));
        if (kind === 'listener') {
          listeners += count;
        } else if (kind === 'effect') {
          effects += count;
        } else {
          moduleInstances += count;
        }
      }
    }
    return Object.freeze({
      listeners,
      effects,
      moduleInstances,
      balanced: listeners === 0 && effects === 0 && moduleInstances === 0,
      details: Object.freeze(details),
    });
  }
}

/**
 * The counting `ModuleContext` a module's `init` and `dispose` receive in dev
 * mode. One per hook call.
 *
 * A class with `#private` fields rather than an object literal, so that a
 * wrapped context serialises like the real one: `moduleId` stays a prototype
 * getter (it still throws `DeadContextError` on a dead context) instead of
 * becoming an own enumerable property that a test framework's serialiser
 * would invoke while building a failure message.
 *
 * `on` counts as a `listener` and not also as an `effect`: `ctx.on` is sugar
 * over the real context's `effect`, never over this wrapper's, so the two
 * counters stay disjoint.
 */
class InstrumentedContext implements ModuleContext {
  readonly #ctx: ModuleContext;
  readonly #counters: LeakCounters;
  readonly #moduleId: string;

  constructor(ctx: ModuleContext, counters: LeakCounters) {
    this.#ctx = ctx;
    this.#counters = counters;
    // Captured while the context is alive: a cleanup running at teardown
    // must say which module it belonged to, and by then reading it back off
    // the real context would throw.
    this.#moduleId = ctx.moduleId;
  }

  get moduleId(): string {
    return this.#ctx.moduleId;
  }

  get<T>(token: Token<T>): T {
    return this.#ctx.get(token);
  }

  getAll<T>(token: Token<T>): readonly T[] {
    return this.#ctx.getAll(token);
  }

  effect(fn: () => void | (() => void)): void {
    const counters = this.#counters;
    const moduleId = this.#moduleId;
    this.#ctx.effect(() => {
      // `fn` runs first and a throw propagates unchanged, so nothing is
      // counted for an effect that never took hold.
      const cleanup = fn();
      counters.acquire(moduleId, 'effect');
      // A counting cleanup is returned even when `fn` returned none, so
      // every registration has a release. The reverse ordering across the
      // module's own cleanups is untouched.
      return () => {
        try {
          cleanup?.();
        } finally {
          counters.release(moduleId, 'effect');
        }
      };
    });
  }

  on<Args extends readonly unknown[]>(
    emitter: EventEmitterLike<Args>,
    event: string,
    handler: (...args: Args) => void,
  ): void {
    const counters = this.#counters;
    const moduleId = this.#moduleId;
    // Registered before the real `on`, so that under the reverse cleanup
    // ordering the release runs after the real unsubscribe. A subscription
    // is only counted as gone once it is actually gone.
    this.#ctx.effect(() => {
      counters.acquire(moduleId, 'listener');
      return () => {
        counters.release(moduleId, 'listener');
      };
    });
    this.#ctx.on(emitter, event, handler);
  }
}

/**
 * Wraps `ctx` so that `effect` and `on` registrations are counted, and
 * released when their L3 cleanups run. See `InstrumentedContext`.
 */
export function instrumentContext(ctx: ModuleContext, counters: LeakCounters): ModuleContext {
  return new InstrumentedContext(ctx, counters);
}

/**
 * Rebuilds `record` with `patch` applied, back through `provide` or
 * `contribute`, so the copy is re-validated like a hand-written one.
 *
 * The record's `kind` is preserved: a contribution stays a contribution.
 */
export function rebuildRecord<T>(
  record: ProviderRecord<T>,
  patch: {
    readonly factory?: (...args: readonly unknown[]) => T;
    readonly onDispose?: (instance: T) => void | Promise<void>;
    readonly override?: boolean;
  },
): ProviderRecord<T> {
  const onDispose = patch.onDispose ?? record.onDispose;
  const options: ProviderOptions<T, readonly Dep[]> = {
    scope: record.scope,
    deps: record.deps,
    factory: patch.factory ?? record.factory,
    override: patch.override ?? record.override,
    persistent: record.persistent,
    ...(onDispose === undefined ? {} : { onDispose }),
    ...(record.transfer === undefined ? {} : { transfer: record.transfer }),
  };
  return record.kind === 'provide'
    ? provide<T, readonly Dep[]>(record.token, options)
    : contribute<T, readonly Dep[]>(record.token, options);
}

/**
 * Mirrors the container's disposal precedence: `onDispose` when the record
 * has one, the instance's own `dispose()` otherwise, never both.
 *
 * Instrumenting a record supplies an `onDispose` where there may have been
 * none, which would otherwise suppress the instance's own `dispose()`.
 */
function callOriginalDispose<T>(record: ProviderRecord<T>, instance: T): void | Promise<void> {
  const own = record.onDispose;
  if (own !== undefined) {
    return own(instance);
  }
  if (instance !== null && typeof instance === 'object') {
    const maybe = instance as Partial<Disposable>;
    if (typeof maybe.dispose === 'function') {
      return maybe.dispose();
    }
  }
  return undefined;
}

/**
 * Wraps every `module`-scoped, non-`persistent` record in `records` so that
 * construction and disposal are counted against `moduleId`. Every other
 * record is passed through by identity.
 */
export function instrumentRecords(
  moduleId: string,
  records: readonly AnyProviderRecord[],
  counters: LeakCounters,
): AnyProviderRecord[] {
  return records.map((record) => {
    // `persistent` is excluded at the single point where both halves of the
    // pair are created, so acquire and release can never be gated
    // differently.
    if (record.scope !== 'module' || record.persistent) {
      return record;
    }
    return rebuildRecord(record, {
      factory: (...args: readonly unknown[]) => {
        const instance: unknown = record.factory(...args);
        counters.acquire(moduleId, 'instance');
        return instance;
      },
      onDispose: (instance: unknown) => {
        // Released before the real disposal runs: the container has already
        // dropped the instance from its cache, so it is gone whether or not
        // its `dispose()` throws or times out.
        counters.release(moduleId, 'instance');
        return callOriginalDispose(record, instance);
      },
    });
  });
}
