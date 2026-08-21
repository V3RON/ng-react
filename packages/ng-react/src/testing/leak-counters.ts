// **H7** leak counters, and the instrumentation that feeds them.
//
// Spec §11 H7: "a dev-mode invariant check runs after each HMR cycle:
// listener counts and effect counts must return to their pre-dispose
// baseline ± the diff introduced by the edit; violations log a leak warning
// naming the module." This file owns the counting half of that; stage 5
// (`test-kernel.ts`) uses it to prove a disposed kernel leaked nothing, and
// stage 6 task 6.2 uses the *same* counters for the post-HMR-cycle
// invariant — see "How task 6.2 uses this" below.
//
// Three things are counted, per module, and each is a pair of a **register**
// event and a **cleanup** event, so a count is "outstanding registrations":
//
//  - `listener` — one `ctx.on(...)` registration (L2), released when its
//    unsubscribe cleanup runs (L3).
//  - `effect`   — one `ctx.effect(...)` registration (L2), released when its
//    cleanup runs (L3).
//  - `instance` — one **`module`-scoped, non-`persistent`** provider
//    instance (C2/C7), released when the container disposes it
//    (`disposeModuleInstances`).
//
// **`persistent: true` records are not counted at all — neither acquire nor
// release (task 6.2, H7).** A preserved persistent instance is deliberately
// *not disposed* by an HMR re-activation (spec §17, H3/ADR-3: disposing a
// store is how a store throws its state away), so its acquire has no
// matching release on that path — while an ordinary `deactivate` *does*
// dispose it, and would produce a release with no acquire if only the HMR
// path were special-cased. The count could not balance either way, and it is
// not a leak: the instance is parked in the resolver, reachable, and handed
// to its successor. Excluding the record from the wrapper entirely keeps the
// pairing symmetric on **every** path, which is what the H7 residual check
// (`src/hmr/leak-check.ts`) needs to avoid reporting a false leak, once per
// cycle forever, on H3's blessed pattern. The cost, stated plainly: a
// persistent instance that genuinely leaked is invisible to these counters.
// H7 names only listener and effect counts, and both are still fully
// covered.
//
// **Deliberate scope limit on `instance`.** Only `module`-scoped instances
// are counted. `singleton`-scoped instances owned by a module are *not*.
// The original reason — the container never disposed a module's singletons,
// so counting them would have made `balanced` permanently `false` after any
// `dispose()` — is **gone as of #34**: `disposeModuleInstances` now disposes
// them with the owning module, exactly as H4 requires ("every provider
// instance it registered is disposed and discarded regardless of scope").
// Lifting the limit is therefore now possible: change the guard in
// `instrumentRecords` below to exclude only `transient`. It is left in place
// here because widening the count is a *reporting* decision, not a container
// one — a live module's singleton becomes an outstanding `instance`, so
// `balanced` starts meaning "nothing is alive" rather than "nothing leaked",
// and three existing expectations move with it. That belongs in the issue
// that owns H7's counters, not in the container fix. `transient` stays out
// by C7 either way: the container never disposes a transient instance, so
// its lifetime is the caller's and there is nothing here to balance.
//
// **Task 6.2 looked at lifting it and decided not to.** H7's own text names
// "listener counts and effect counts" and nothing else, and the check that
// actually runs after each HMR cycle measures what a module's *teardown*
// failed to release — a question `ctx.on` and `ctx.effect` already answer
// completely, since every `init` registration goes through one of them.
// Counting singletons would add no H7 signal: #34 made
// `disposeModuleInstances` dispose a module's singletons with it, and a
// regression in *that* is a container bug with container tests. What it
// would add is a changed meaning for every existing `leaks()` reader, in the
// same PR that *narrows* the same counter for `persistent` above. Two
// opposing changes to one report in one change is how a report stops being
// trusted. The limit stays; the note stays with it.
//
// **Gating is structural, not a runtime flag.** When the kernel is not in
// dev mode, `test-kernel.ts` does not install any of the wrappers below: the
// module's own `ModuleContext` and its own `ProviderRecord`s are handed to
// the kernel untouched, nothing is allocated per registration, and no
// counting code runs at all. A `dev: false` counter is inert because it is
// not there, not because a branch returned early.
//
// ADR-6: no `react` import.

import type { Disposable, EventEmitterLike, ModuleContext } from '../types';
import type { AnyProviderRecord, ProviderOptions, ProviderRecord } from '../provider';
import { contribute, provide } from '../provider';
import type { Dep, Token } from '../token';

/** The three things H7 counts. */
type LeakKind = 'listener' | 'effect' | 'instance';

/**
 * **H7**: outstanding registration counts at one instant.
 *
 * A *snapshot*: `leaks()` builds a fresh, frozen report every call and never
 * hands out a live view, which is what makes the baseline/delta use below
 * possible.
 *
 * ### How task 6.2 uses this (H7's post-HMR-cycle invariant)
 *
 * H7 is not "everything must be zero" — after an HMR cycle a module is
 * *alive*, so its counts are non-zero by design. The invariant is that the
 * counts return to their pre-dispose **baseline ± the diff introduced by the
 * edit**. That is why the useful unit here is `details` — a per-module,
 * per-kind breakdown — rather than the three totals:
 *
 * ```ts
 * const baseline = kernel.leaks();          // before the edit
 * await hmr.applyEdit(...);                 // dispose + re-activate one module
 * const after = kernel.leaks();             // after the cycle
 * // delta per (moduleId, kind); anything non-zero for a module the edit did
 * // not touch is the leak H7 asks the dev-mode check to warn about, naming
 * // that module — which `details` already carries.
 * ```
 *
 * `details` is sorted by `moduleId` then `kind` and contains only non-zero
 * entries, so two reports subtract deterministically and an empty `details`
 * is exactly `balanced === true`.
 */
export interface LeakReport {
  /** Outstanding `ctx.on` registrations across every module. */
  readonly listeners: number;
  /** Outstanding `ctx.effect` registrations across every module. */
  readonly effects: number;
  /**
   * Outstanding **`module`-scoped, non-`persistent`** provider instances —
   * see the file header for both exclusions.
   */
  readonly moduleInstances: number;
  /** True when every count is zero. */
  readonly balanced: boolean;
  /** Per-module, per-kind outstanding counts. Non-zero entries only, sorted. */
  readonly details: readonly { readonly moduleId: string; readonly kind: LeakKind; readonly count: number }[];
}

/**
 * The per-kernel counter set. One instance per test kernel — there is no
 * module-level counter state anywhere in this file, which is what lets two
 * test kernels run in one test file without interfering.
 */
export class LeakCounters {
  /**
   * Lazily created: a kernel that never registers anything (and every
   * kernel with the instrumentation not installed) allocates no map.
   */
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
   * twice, which is a real defect and must be visible rather than rounded
   * away into a green `balanced`.
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

  /** H7: the current outstanding counts, as a frozen snapshot. */
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
 * The counting `ModuleContext` a module's `init`/`dispose` receives in dev
 * mode. One per hook call; created by `instrumentContext`.
 *
 * A **class with `#private` fields**, deliberately, rather than an object
 * literal. Two properties of the real `ModuleContextImpl` have to survive
 * wrapping, and both are structural:
 *
 *  - `moduleId` is a **prototype** getter, so L4 still applies (reading it
 *    on a dead context throws `DeadContextError`) *without* the getter being
 *    an own enumerable property. A test framework that serialises a value —
 *    which vitest's `expect` does while building a message — walks own
 *    enumerable properties and would otherwise invoke that getter on a
 *    disposed context and throw from inside the assertion.
 *  - `#private` fields are invisible to the same walk, so serialising a
 *    wrapped context shows what serialising the real one shows.
 *
 * **`on` counts as a `listener`, not as an `effect`,** even though the real
 * `ctx.on` is sugar over the real `ctx.effect`: the sugar calls
 * `ModuleContextImpl`'s own `effect`, never this wrapper's, so the two
 * counters stay disjoint by construction rather than by subtraction.
 */
class InstrumentedContext implements ModuleContext {
  readonly #ctx: ModuleContext;
  readonly #counters: LeakCounters;
  readonly #moduleId: string;

  constructor(ctx: ModuleContext, counters: LeakCounters) {
    this.#ctx = ctx;
    this.#counters = counters;
    // Captured while the context is alive: a cleanup running at teardown
    // must be able to say which module it belonged to, and by then reading
    // it back off the real context would throw (L4).
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
      // `fn` runs first and a throw propagates unchanged (it ran as part of
      // `init`, so it fails activation, F1) — nothing is counted for an
      // effect that never took hold.
      const cleanup = fn();
      counters.acquire(moduleId, 'effect');
      // A counting cleanup is returned even when `fn` returned none, so that
      // *every* registration has a release. The only observable difference
      // is one more entry in the context's private cleanup list; L3's
      // reverse ordering across the module's own cleanups is untouched.
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
    // Registered **before** the real `on`, so that under L3's reverse
    // ordering the release runs **after** the real unsubscribe. A
    // subscription is only accounted for as gone once it is actually gone.
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
 * Rebuilds `record` with `patch` applied, through the public
 * `provide`/`contribute` doors.
 *
 * `ProviderRecord` is frozen and nominally branded, so "a copy with one
 * field changed" has to go back through the declaration API — which also
 * means the copy is re-validated exactly like a hand-written one. The
 * `kind` is preserved: a contribution stays a contribution (C5 rejects
 * mixing kinds on one token, and quietly turning one into the other here
 * would surface as an unrelated `ProviderKindConflictError`).
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
 * C7 precedence, mirrored: the container calls `onDispose` when there is
 * one, and the instance's own `dispose()` otherwise — **never both**.
 * Instrumenting a record means supplying an `onDispose` where there may
 * have been none, so this re-implements that choice for the wrapped record;
 * without it, adding a counting `onDispose` would silently suppress an
 * instance's own `dispose()`.
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
 * Wraps every **`module`-scoped, non-`persistent`** record in `records` so
 * that construction and disposal are counted against `moduleId`. Every other
 * record is passed through by identity — see the file header for why
 * `singleton` and `persistent: true` are both excluded.
 */
export function instrumentRecords(
  moduleId: string,
  records: readonly AnyProviderRecord[],
  counters: LeakCounters,
): AnyProviderRecord[] {
  return records.map((record) => {
    // **H7 (task 6.2)**: `persistent` is excluded here, at the single point
    // where both halves of the pair are created, so acquire and release can
    // never be gated differently. See the file header.
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
        // dropped the instance from its cache by this point, so it is gone
        // whether or not its `dispose()` throws or times out (ADR-1).
        counters.release(moduleId, 'instance');
        return callOriginalDispose(record, instance);
      },
    });
  });
}
