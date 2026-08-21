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
import { isAllOfDep, isOptionalDep, isToken, MODULE_ID } from '../token';
import type { AnyToken, Dep, Token } from '../token';
import type { AnyProviderRecord } from '../provider';
import type { Disposable } from '../types';
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
   * disposals (L3). Error-sink routing (F4) is a stage-3 concern; this
   * task only needs the injection point. Defaults to a no-op.
   */
  readonly onError?: (error: unknown) => void;
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
  private readonly onError: (error: unknown) => void;
  private readonly disposeTimeoutMs: number;
  private readonly getTopologicalIndex: (moduleId: string) => number;

  // C2 singleton scope: one instance for the app lifetime. Keyed by the
  // provider's own frozen `ProviderRecord` object, which is a stable,
  // unique identity per `provide()`/`contribute()` call — this lets the
  // same map serve both single-provider and contribution instances without
  // token-label collisions.
  private readonly singletonCache = new Map<AnyProviderRecord, CachedInstance>();
  private readonly singletonOrder: AnyProviderRecord[] = [];

  // C2 module scope: one instance per *providing* module's activation
  // (i.e. keyed by the provider's owner — provenance — never by the
  // requester; two different consumers of the same module-scoped provider
  // get the same instance). Outer key is the owning module id.
  private readonly moduleScopedCache = new Map<string, Map<AnyProviderRecord, CachedInstance>>();
  private readonly moduleScopedOrder = new Map<string, AnyProviderRecord[]>();

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
  resolveAllOf<T>(token: Token<T>): readonly T[] {
    const contributions = this.registry.getContributions(token);
    const ordered = orderContributions(contributions, this.getTopologicalIndex);
    // C4/C9: `entry.owner` — kernel-assigned provenance, so this is a pure
    // function of registration and can never depend on who resolved first.
    return ordered.map((entry) => this.construct(entry, entry.owner));
  }

  /**
   * C7: disposes every `module`-scoped instance owned by `moduleId`, in
   * reverse construction order. A no-op if the module never constructed
   * anything. After this resolves, the next resolution of one of that
   * module's `module`-scoped providers constructs a fresh instance.
   */
  async disposeModuleScope(moduleId: string): Promise<void> {
    const order = this.moduleScopedOrder.get(moduleId);
    const cache = this.moduleScopedCache.get(moduleId);
    this.moduleScopedOrder.delete(moduleId);
    this.moduleScopedCache.delete(moduleId);
    if (order === undefined || cache === undefined) {
      return;
    }
    for (const record of [...order].reverse()) {
      const cached = cache.get(record);
      if (cached !== undefined) {
        await this.disposeInstance(cached);
      }
    }
  }

  /**
   * C7: container teardown — disposes every `singleton` instance, in
   * reverse construction order. `module`-scoped instances are not touched
   * here; they are disposed via `disposeModuleScope` as each module is
   * torn down (a kernel/stage-3 orchestration concern).
   */
  async dispose(): Promise<void> {
    const order = [...this.singletonOrder].reverse();
    this.singletonOrder.length = 0;
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

      if (record.scope === 'singleton') {
        this.singletonCache.set(record, { value, record, ownerId: entry.owner });
        this.singletonOrder.push(record);
      } else if (record.scope === 'module') {
        let cache = this.moduleScopedCache.get(entry.owner);
        if (cache === undefined) {
          cache = new Map();
          this.moduleScopedCache.set(entry.owner, cache);
        }
        cache.set(record, { value, record, ownerId: entry.owner });
        let order = this.moduleScopedOrder.get(entry.owner);
        if (order === undefined) {
          order = [];
          this.moduleScopedOrder.set(entry.owner, order);
        }
        order.push(record);
      }
      // 'transient': never cached, never tracked for disposal (C7).

      return value as T;
    } finally {
      this.constructing.delete(record);
      this.stack.pop();
    }
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
      this.onError(err);
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
        this.onError(new DisposeTimeoutError(cached.ownerId, cached.record.token.label, this.disposeTimeoutMs));
        // Fire-and-forget: still report a late rejection instead of
        // producing an unhandled rejection.
        pending.catch((err) => this.onError(err));
      }
    } catch (err) {
      if (!timedOut) {
        this.onError(err);
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
