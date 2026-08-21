// The resolution engine (task 2.2): turns a token plus a requesting module
// into an instance. Scopes (C2), laziness (C3), resolution-context
// propagation (C4, ADR-2), the dependency wrappers (`optional`/`allOf`,
// §7.3), cycle detection, the C8 diagnostic, and disposal (C7, ADR-1) all
// live here. Registration and provenance are the registry's job (task 2.1);
// this file only ever reads from it.
//
// `Resolver` is internal, like `ProviderRegistry` — not exported from
// `index.ts`. `container.ts` is the thin facade that pairs one with the
// other for the kernel (a later stage) to hold.

import {
  CircularDependencyError,
  DisposeTimeoutError,
  InvalidDescriptorError,
  ProviderFactoryError,
  ResolutionError,
} from '../errors';
import { transferPersistentState } from '../hmr/persistent';
import { isAllOfDep, isOptionalDep, isToken, MODULE_ID } from '../token';
import type { AnyToken, Dep, Token } from '../token';
import type { AnyProviderRecord } from '../provider';
import type { Disposable, ErrorReporter } from '../types';
import { orderContributions } from './collections';
import type { ProviderRegistry, RegisteredProvider } from './registry';

/** ADR-1's default; overridable per `Resolver` instance. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2000;

/** Options accepted by `resolve()`. */
export interface ResolveOptions {
  /**
   * C4: the module on whose behalf this resolution chain was started.
   * Propagates unchanged through every nested dependency resolution — a
   * factory three levels deep that asks for `MODULE_ID` gets this value,
   * not its own owner. Per ADR-2, callers outside any module (composition
   * root, `kernel.get()`, app-root React) pass the reserved id `'app'`;
   * the resolver never invents or defaults this itself.
   */
  readonly requester: string;
}

/** Constructor options for `Resolver`. */
export interface ResolverOptions {
  /**
   * C8 suggestion support: given the requester's module id, returns its
   * declared `dependsOn` as plain id strings (or `undefined` if the
   * requester is unknown). Injected so the container stays independent of
   * the kernel (which owns the descriptor graph). Defaults to a callback
   * that always returns `undefined`, which simply means the C8 suggestion
   * branch never fires — a safe degradation for standalone/test use.
   */
  readonly getDependsOn?: (moduleId: string) => readonly string[] | undefined;
  /**
   * Reports a disposal error or timeout that must not abort remaining
   * disposals (L3). Wired by the kernel to F4's `ErrorSinkToken` routing
   * (task 3.3), which is the only reason it takes an attribution argument:
   * a sink is told *which module's* instance failed to dispose (C9), and
   * this is the only layer that knows. Defaults to a no-op, which is what
   * a container driven standalone in a test gets.
   */
  readonly onError?: ErrorReporter;
  /** ADR-1: timeout for awaited async disposal. Default `2000`. */
  readonly disposeTimeoutMs?: number;
  /**
   * C5 ordering (task 2.3): the position of `moduleId` in the kernel's
   * activation (topological) order, used to order contribution
   * collections. See `ContributionCollectionsOptions.getTopologicalIndex`
   * for the contract and the documented no-kernel fallback.
   */
  readonly getTopologicalIndex?: (moduleId: string) => number;
}

/** One cached instance, enough context to dispose it later. */
interface CachedInstance {
  readonly value: unknown;
  readonly record: AnyProviderRecord;
  readonly ownerId: string;
  /**
   * Monotonic construction sequence number, resolver-wide. Only reason it
   * exists: `disposeModuleInstances` disposes a module's `singleton` and
   * `module`-scoped instances together in one reverse-construction order,
   * and the two scopes live in two different caches, so the order has to be
   * recoverable after merging them.
   */
  readonly seq: number;
}

/** Renders a value for an error message: `string 'x'`, `number 42`, … */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string '${value}'`;
  return typeof value;
}

/** Picks the single dispose function C7 says to call, if any — never both. */
function getDisposeFn(record: AnyProviderRecord, instance: unknown): (() => void | Promise<void>) | undefined {
  if (record.onDispose !== undefined) {
    return () => record.onDispose?.(instance);
  }
  if (instance !== null && typeof instance === 'object' && typeof (instance as Partial<Disposable>).dispose === 'function') {
    return () => (instance as Disposable).dispose();
  }
  return undefined;
}

export class Resolver {
  private readonly getDependsOn: (moduleId: string) => readonly string[] | undefined;
  private readonly onError: ErrorReporter;
  private readonly disposeTimeoutMs: number;
  private readonly getTopologicalIndex: (moduleId: string) => number;

  // C2 singleton scope: one instance for the app lifetime **of the owning
  // module's activation** — see `disposeModuleInstances` for why H4 makes
  // that qualifier part of the contract rather than a weakening of it.
  // Keyed by the provider's own frozen `ProviderRecord` object, which is a
  // stable, unique identity per `provide()`/`contribute()` call — this lets
  // the same map serve both single-provider and contribution instances
  // without token-label collisions.
  private readonly singletonCache = new Map<AnyProviderRecord, CachedInstance>();
  // Construction order across *all* singletons, for `dispose`'s reverse
  // teardown. Rebuilt (never spliced blindly) when
  // `disposeModuleInstances` removes a module's entries from the middle, so
  // it always holds exactly the records still present in `singletonCache`.
  private singletonOrder: AnyProviderRecord[] = [];
  /** Feeds `CachedInstance.seq`. */
  private nextSeq = 0;

  // C2 module scope: one instance per *providing* module's activation
  // (i.e. keyed by the provider's owner — provenance — never by the
  // requester; two different consumers of the same module-scoped provider
  // get the same instance). Outer key is the owning module id.
  private readonly moduleScopedCache = new Map<string, Map<AnyProviderRecord, CachedInstance>>();
  private readonly moduleScopedOrder = new Map<string, AnyProviderRecord[]>();

  /**
   * **H3/H4/ADR-3**: instances held back from the previous activation of a
   * module, waiting for their replacement to be constructed.
   *
   * `Map<owning module id, Map<token label, old instance>>`. Populated only
   * by `disposeModuleInstances(id, { preservePersistent: true })` — i.e.
   * only by an HMR re-activation — and drained by `construct` the moment
   * the matching fresh instance exists.
   *
   * **Keyed by token *label*, not by token identity, and that is a
   * deliberate weakening.** A re-evaluated module file yields fresh
   * `ProviderRecord` objects (that is what makes H4's disposal necessary at
   * all), and under a real bundler it may yield fresh `Token` objects too if
   * the contract chunk was re-evaluated alongside. The label is the one
   * identity that survives, it is `moduleId/Name` by C1's convention, and
   * the map is already scoped to a single owning module — so two colliding
   * labels would have to be two same-named tokens provided by one module,
   * which is an authoring bug the C1 convention exists to prevent.
   *
   * **Bounded to one generation.** Every `disposeModuleInstances` call
   * clears the module's entry first and only a preserving call refills it,
   * so a store whose provider was deleted in the edit is dropped on the next
   * cycle rather than retained forever, and an ordinary `deactivate`
   * (H3: "not across a real deactivation") empties it outright.
   */
  private readonly pendingPersistent = new Map<string, Map<string, unknown>>();

  // Cycle detection (§7.3): `constructing` is the set of provider records
  // currently mid-construction; `stack` is the same information ordered,
  // for building the token-path in both the C8 and circular-dependency
  // messages. Both are cleared per record as construction finishes
  // (success or failure), so they only ever describe resolutions still in
  // progress on the current (synchronous) call stack.
  private readonly constructing = new Set<AnyProviderRecord>();
  private readonly stack: AnyProviderRecord[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    options: ResolverOptions = {},
  ) {
    this.getDependsOn = options.getDependsOn ?? (() => undefined);
    this.onError = options.onError ?? (() => {});
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.getTopologicalIndex = options.getTopologicalIndex ?? (() => 0);
  }

  /**
   * Resolves `token` on behalf of `requester` (C4). Lazy (C3): nothing is
   * constructed until this is called.
   *
   * @throws {ResolutionError} C8 — no provider anywhere along the chain.
   * @throws {CircularDependencyError} §7.3 — the chain revisits a provider
   *   already under construction.
   * @throws {ProviderFactoryError} a factory threw; the original error is
   *   preserved as `cause`.
   */
  resolve<T>(token: Token<T>, options: ResolveOptions): T {
    return this.resolveToken(token as AnyToken, options.requester) as T;
  }

  /**
   * C5: the full contribution collection for `token`, in module
   * topological order (`orderContributions`, task 2.3), each contribution
   * constructed in its own scope.
   *
   * This is the *only* place a contribution collection is constructed:
   * `deps: [allOf(Token)]` and `container.getAll(Token)` both land here, so
   * the two can never disagree about ordering or about which instances they
   * see. An unknown token yields `[]`, not an error.
   *
   * **C4 for a contribution: each contribution is resolved on behalf of
   * its own owner (C9 provenance), not on behalf of whoever asked for the
   * collection.** Hence no `ResolveOptions` here — the caller's resolution
   * context deliberately does not reach a contribution, and a parameter
   * that silently did nothing would be worse than no parameter. See the
   * long argument in `collections.ts`'s header; the short version is that
   * `injectAll` is not one resolution chain but N independent ones, one
   * per contributor, each started on behalf of the module that supplied
   * it. `requester` still propagates unchanged within each of those chains
   * (`construct` passes it down to every nested dep), so C4's propagation
   * rule is untouched — only the *seed* of a contribution's chain changes.
   */
  resolveAllOf<T>(token: Token<T>, accept?: (ownerModuleId: string) => boolean): readonly T[] {
    const contributions = this.registry.getContributions(token);
    const ordered = orderContributions(contributions, this.getTopologicalIndex);
    // C4/C9: `entry.owner` — kernel-assigned provenance, so this is a pure
    // function of registration and can never depend on who resolved first.
    //
    // **F4**: `accept` filters by owner **before** `construct` runs, and
    // that order is the whole point of the parameter existing. The kernel
    // must not construct an error sink belonging to a `failed` or
    // `disposed` module; filtering the *resolved* array afterwards would
    // have already run that module's factory and cached the instance.
    const kept = accept === undefined ? ordered : ordered.filter((entry) => accept(entry.owner));
    return kept.map((entry) => this.construct(entry, entry.owner));
  }

  /**
   * C7 + **H4**: disposes and discards every instance owned by `moduleId`
   * — `module`-scoped **and** `singleton` — in reverse construction order
   * across both scopes. A no-op if the module never constructed anything.
   * After this resolves, the next resolution of one of that module's
   * providers constructs a fresh instance.
   *
   * ### The lifetime this pins down (was #34)
   *
   * **A module-owned `singleton` lives for its owning module's activation,
   * not for the process:** deactivating the module disposes and discards
   * it, and re-activating constructs a new one.
   *
   * C7 alone reads "app/kernel teardown for `singleton`", and on that
   * reading not disposing here is defensible. H4 (§11) settles it the other
   * way and is the more specific rule: when a module is re-activated
   * "every provider instance it registered is disposed and discarded
   * **regardless of scope** — including `singleton`… the next resolution
   * constructs from the new factory". A deactivate/re-activate pair is the
   * same shape as an HMR re-activation, so the two cannot have different
   * answers without the container's behaviour depending on *why* the module
   * went away.
   *
   * The alternative — leaving the instance cached — was not a smaller
   * behaviour, it was a broken one: the re-run `providers` thunk yields
   * fresh `ProviderRecord` objects, `singletonCache` is keyed by record
   * identity, so the lookup missed and constructed a *second* instance
   * while the first stayed cached, undisposed and unreachable. "App
   * lifetime" was already not what the old code delivered.
   *
   * `transient` is untouched, per C7: the container never owned those.
   *
   * ### `preservePersistent` — H4's sole exception (H3, ADR-3)
   *
   * `{ preservePersistent: true }` is what an **HMR re-activation** passes
   * and what an ordinary `deactivate` must not. For a record with
   * `persistent: true` it holds the instance back instead of disposing it,
   * parking it in `pendingPersistent` so that the replacement instance —
   * constructed later, lazily, from the *new* factory — can adopt its state
   * (`construct` below). Everything else is disposed exactly as before, so
   * H4's "regardless of scope" is untouched.
   *
   * **A preserved instance is not disposed at all**, and that is the point
   * rather than an oversight: `dispose()` on a store is how a store throws
   * its state away, and running it would destroy precisely what H3 exists to
   * carry over. The cost is that a persistent instance's own listeners
   * outlive one HMR generation; the H7 leak invariant (task 6.2) has to know
   * that, which is why the exception is one flag in one place rather than a
   * property inferred from the call site.
   *
   * Without the flag — `kernel.deactivate`, F3 quarantine, kernel teardown —
   * a persistent instance is disposed and discarded like any other, and the
   * parked entry from any earlier HMR cycle is dropped. That is H3's "but
   * not across a real deactivation", and it is why the two paths cannot be
   * told apart by anything other than an explicit argument: since #34 they
   * are the same code.
   */
  async disposeModuleInstances(
    moduleId: string,
    options: { readonly preservePersistent?: boolean } = {},
  ): Promise<void> {
    const preservePersistent = options.preservePersistent ?? false;
    const owned: CachedInstance[] = [];
    // Cleared unconditionally: see `pendingPersistent`'s "bounded to one
    // generation" note. A non-preserving disposal leaves it empty, which is
    // H3's discard-on-deactivate.
    this.pendingPersistent.delete(moduleId);
    const preserved = new Map<string, unknown>();

    const order = this.moduleScopedOrder.get(moduleId);
    const cache = this.moduleScopedCache.get(moduleId);
    this.moduleScopedOrder.delete(moduleId);
    this.moduleScopedCache.delete(moduleId);
    if (order !== undefined && cache !== undefined) {
      for (const record of order) {
        const cached = cache.get(record);
        if (cached === undefined) {
          continue;
        }
        if (preservePersistent && cached.record.persistent) {
          preserved.set(cached.record.token.label, cached.value);
          continue;
        }
        owned.push(cached);
      }
    }

    // H4: the singleton half. Everything is removed from the cache *before*
    // any disposal runs (matching `dispose` below and ADR-1's "already
    // removed by the caller" note), and `singletonOrder` is rebuilt from
    // the survivors so that a later `dispose()` cannot revisit an entry
    // torn down here — that is what keeps the two paths from
    // double-disposing one instance.
    if (this.singletonOrder.length > 0) {
      const survivors: AnyProviderRecord[] = [];
      for (const record of this.singletonOrder) {
        const cached = this.singletonCache.get(record);
        if (cached !== undefined && cached.ownerId === moduleId) {
          this.singletonCache.delete(record);
          if (preservePersistent && cached.record.persistent) {
            preserved.set(cached.record.token.label, cached.value);
          } else {
            owned.push(cached);
          }
        } else {
          survivors.push(record);
        }
      }
      this.singletonOrder = survivors;
    }

    // H3/ADR-3: parked *before* any disposal runs, so a `dispose()` on some
    // other instance of this module that reaches for the store still finds
    // the same object the replacement will inherit from.
    if (preserved.size > 0) {
      this.pendingPersistent.set(moduleId, preserved);
    }

    if (owned.length === 0) {
      return;
    }
    // One reverse-construction order across both scopes: a module-scoped
    // instance built after a singleton is disposed before it, which is what
    // "reverse construction order" means once the two caches are merged.
    owned.sort((a, b) => b.seq - a.seq);
    for (const cached of owned) {
      await this.disposeInstance(cached);
    }
  }

  /**
   * C7: container teardown — disposes every `singleton` instance still
   * cached, in reverse construction order. `module`-scoped instances are
   * not touched here; they are disposed via `disposeModuleInstances` as
   * each module is torn down (a kernel/stage-3 orchestration concern).
   *
   * "Still cached" is the load-bearing word after #34: a module that was
   * already deactivated took its singletons with it, so this disposes the
   * survivors only and never sees an instance twice.
   */
  async dispose(): Promise<void> {
    const order = [...this.singletonOrder].reverse();
    this.singletonOrder = [];
    for (const record of order) {
      const cached = this.singletonCache.get(record);
      this.singletonCache.delete(record);
      if (cached !== undefined) {
        await this.disposeInstance(cached);
      }
    }
  }

  // --- internals ---

  private resolveToken(token: AnyToken, requester: string): unknown {
    // C4/ADR-2: MODULE_ID is not a registered provider — it is resolved
    // directly to the propagated requester id, which is never `undefined`
    // (the kernel reserves `'app'` for resolutions started outside any
    // module).
    if ((token as AnyToken) === (MODULE_ID as AnyToken)) {
      return requester;
    }

    const entry = this.registry.getProvider(token);
    if (entry === undefined) {
      throw this.buildResolutionError(token, requester);
    }
    return this.construct(entry, requester);
  }

  private resolveDep(dep: Dep, requester: string): unknown {
    if (isToken(dep)) {
      return this.resolveToken(dep as AnyToken, requester);
    }
    if (isOptionalDep(dep)) {
      // §7.3: resolves to undefined instead of throwing when there is no
      // provider — checked directly against the registry, *before* any
      // construction is attempted, so this can never accidentally swallow
      // an error thrown by a factory that *was* found (only the "found or
      // not" question is optional's concern; a nested/failed construction
      // of a provider that does exist always propagates).
      const token = dep.token as AnyToken;
      if ((token as AnyToken) === (MODULE_ID as AnyToken)) {
        return requester;
      }
      const entry = this.registry.getProvider(token);
      if (entry === undefined) {
        return undefined;
      }
      return this.construct(entry, requester);
    }
    if (isAllOfDep(dep)) {
      return this.resolveAllOf(dep.token);
    }
    // Unreachable given provider.ts's validateDeps — every deps[] element
    // was already checked to be a Token/OptionalDep/AllOfDep at
    // provide()/contribute() time. Guarded defensively anyway.
    throw new InvalidDescriptorError(`Resolver: unknown dependency wrapper, got ${describeValue(dep)}.`);
  }

  private construct<T>(entry: RegisteredProvider<T>, requester: string): T {
    const record = entry.record as AnyProviderRecord;

    // C2 scope-based cache lookup — laziness (C3) plus referential
    // stability for singleton/module scopes; transient falls through and
    // always constructs fresh below.
    if (record.scope === 'singleton') {
      const cached = this.singletonCache.get(record);
      if (cached !== undefined) {
        return cached.value as T;
      }
    } else if (record.scope === 'module') {
      const cached = this.moduleScopedCache.get(entry.owner)?.get(record);
      if (cached !== undefined) {
        return cached.value as T;
      }
    }

    // §7.3: no circular resolution of any kind. A record already
    // mid-construction being asked for again — anywhere in the current
    // chain — is a cycle, not a re-entrant resolution.
    if (this.constructing.has(record)) {
      throw this.buildCircularError(record);
    }

    this.constructing.add(record);
    this.stack.push(record);
    try {
      // C4: `requester` is passed through unchanged to every dep — the
      // resolution context is the module that started the whole chain,
      // never the module that happens to own the provider being
      // constructed right now.
      const args = record.deps.map((dep) => this.resolveDep(dep, requester));

      let value: unknown;
      try {
        // §7.3: factories are never awaited. A factory returning a
        // promise yields that promise as the resolved value, as-is.
        value = record.factory(...args);
      } catch (cause) {
        throw this.buildFactoryError(cause);
      }

      const seq = this.nextSeq++;
      if (record.scope === 'singleton') {
        this.singletonCache.set(record, { value, record, ownerId: entry.owner, seq });
        this.singletonOrder.push(record);
      } else if (record.scope === 'module') {
        let cache = this.moduleScopedCache.get(entry.owner);
        if (cache === undefined) {
          cache = new Map();
          this.moduleScopedCache.set(entry.owner, cache);
        }
        cache.set(record, { value, record, ownerId: entry.owner, seq });
        let order = this.moduleScopedOrder.get(entry.owner);
        if (order === undefined) {
          order = [];
          this.moduleScopedOrder.set(entry.owner, order);
        }
        order.push(record);
      }
      // 'transient': never cached, never tracked for disposal (C7).

      // **H3/H4/ADR-3**: adopt the state of the instance the previous
      // activation held back, if there is one. After the cache write, so a
      // `transfer` hook that resolves something which resolves back to this
      // token sees the finished instance rather than re-entering
      // construction — and unconditionally `delete`d, so exactly one
      // generation of instance can ever inherit one parked predecessor.
      if (record.persistent) {
        this.adoptPersistentState(record, entry.owner, value);
      }

      return value as T;
    } finally {
      this.constructing.delete(record);
      this.stack.pop();
    }
  }

  /**
   * **ADR-3**: hands a freshly constructed `persistent` instance the state
   * of its parked predecessor, if the owning module went through an HMR
   * re-activation and had one.
   *
   * `transferPersistentState` never throws (that is ADR-3 branch 4's whole
   * contract), so there is no `try` here — one would only hide a bug in the
   * transfer function itself.
   */
  private adoptPersistentState(record: AnyProviderRecord, ownerId: string, newInstance: unknown): void {
    const parked = this.pendingPersistent.get(ownerId);
    const label = record.token.label;
    if (parked === undefined || !parked.has(label)) {
      return;
    }
    const oldInstance = parked.get(label);
    parked.delete(label);
    if (parked.size === 0) {
      this.pendingPersistent.delete(ownerId);
    }
    transferPersistentState({
      record,
      oldInstance,
      newInstance,
      moduleId: ownerId,
      report: this.onError,
    });
  }

  /** Builds the C8 message: full path plus the dependsOn suggestion, when it applies. */
  private buildResolutionError(token: AnyToken, requester: string): ResolutionError {
    const path = [...this.stack.map((record) => record.token.label), token.label];
    const suggestion = this.buildSuggestion(token.label, requester);
    return new ResolutionError(path, suggestion);
  }

  private buildSuggestion(
    failingLabel: string,
    requester: string,
  ): { readonly missingModuleId: string; readonly requesterId: string } | undefined {
    const prefixModule = this.registry.findModuleByTokenLabelPrefix(failingLabel);
    if (prefixModule === undefined || prefixModule === requester) {
      return undefined;
    }
    const dependsOn = this.getDependsOn(requester) ?? [];
    if (dependsOn.includes(prefixModule)) {
      return undefined;
    }
    return { missingModuleId: prefixModule, requesterId: requester };
  }

  private buildCircularError(record: AnyProviderRecord): CircularDependencyError {
    const cycleStartIndex = this.stack.indexOf(record);
    // `cycleStartIndex` is always found: `constructing.has(record)` (the
    // only caller of this method) can only be true for a record this same
    // synchronous chain pushed onto `stack` and has not yet popped.
    const cyclePath = this.stack.slice(cycleStartIndex).map((r) => r.token.label);
    return new CircularDependencyError(cyclePath);
  }

  private buildFactoryError(cause: unknown): ProviderFactoryError {
    const path = this.stack.map((record) => record.token.label);
    return new ProviderFactoryError(path, cause);
  }

  private async disposeInstance(cached: CachedInstance): Promise<void> {
    const disposeFn = getDisposeFn(cached.record, cached.value);
    if (disposeFn === undefined) {
      return;
    }

    let result: void | Promise<void>;
    try {
      result = disposeFn();
    } catch (err) {
      // L3: a disposal error does not abort remaining disposals.
      this.onError(err, { moduleId: cached.ownerId, phase: 'dispose' });
      return;
    }

    if (result === undefined || typeof (result as Promise<void>).then !== 'function') {
      return;
    }

    // ADR-1: async disposal is awaited with a timeout. On timeout the
    // instance is already removed from the cache by the caller (before
    // this method runs), so it is "marked disposed" regardless; the
    // in-flight promise is left to settle on its own and any rejection is
    // still reported, just late.
    const pending = result as Promise<void>;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, this.disposeTimeoutMs);
    });

    try {
      const outcome = await Promise.race([pending.then(() => 'done' as const), timeoutPromise]);
      if (outcome === 'timeout') {
        this.onError(new DisposeTimeoutError(cached.ownerId, cached.record.token.label, this.disposeTimeoutMs), {
          moduleId: cached.ownerId,
          phase: 'dispose',
        });
        // Fire-and-forget: still report a late rejection instead of
        // producing an unhandled rejection.
        pending.catch((err) => this.onError(err, { moduleId: cached.ownerId, phase: 'dispose' }));
      }
    } catch (err) {
      if (!timedOut) {
        this.onError(err, { moduleId: cached.ownerId, phase: 'dispose' });
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
