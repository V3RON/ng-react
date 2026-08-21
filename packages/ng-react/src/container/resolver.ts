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

const DEFAULT_DISPOSE_TIMEOUT_MS = 2000;

/** Options accepted by `resolve()`. */
export interface ResolveOptions {
  /**
   * The module on whose behalf this resolution chain was started.
   *
   * Propagates unchanged through every nested dependency resolution: a factory
   * three levels deep that asks for `MODULE_ID` gets this value, not its own
   * owner. Callers outside any module pass the reserved id `'app'`; the
   * resolver never defaults this itself.
   */
  readonly requester: string;
}

/** Constructor options for `Resolver`. */
export interface ResolverOptions {
  /**
   * Returns a module's declared `dependsOn` ids, or `undefined` if the module
   * is unknown. Used to suggest a missing dependency in a resolution error.
   *
   * @default () => undefined — the suggestion branch never fires.
   */
  readonly getDependsOn?: (moduleId: string) => readonly string[] | undefined;
  /**
   * Receives a disposal error or timeout, which must not abort the remaining
   * disposals. Takes an attribution argument so a report can name the module
   * whose instance failed to dispose.
   *
   * @default a no-op.
   */
  readonly onError?: ErrorReporter;
  /**
   * How long an awaited async disposal may run before it is reported as timed
   * out.
   *
   * @default 2000
   */
  readonly disposeTimeoutMs?: number;
  /**
   * The position of `moduleId` in the kernel's activation order, used to order
   * contribution collections.
   *
   * @default () => 0 — collections degrade to registration order.
   */
  readonly getTopologicalIndex?: (moduleId: string) => number;
  /**
   * Records one edge of the resolution graph: `consumerModuleId` resolved
   * `tokenLabel` from a provider owned by `ownerModuleId`.
   *
   * `consumerModuleId` is the owner of the provider record one level up the
   * construction stack — the module whose factory is asking right now — falling
   * back to the chain's `requester` at the top of the stack. It is deliberately
   * not the propagated `requester`, because the graph's consumers need "whose
   * instances embed whose", which the construction stack describes and the
   * resolution context does not.
   *
   * The resolver only writes edges; it never reads them.
   *
   * @default undefined — left unset rather than defaulted to a no-op, so a
   *   production resolution pays no call per construction. Supply it only in
   *   dev.
   */
  readonly recordResolution?: (consumerModuleId: string, ownerModuleId: string, tokenLabel: string) => void;
}

/** One cached instance, with enough context to dispose it later. */
interface CachedInstance {
  readonly value: unknown;
  readonly record: AnyProviderRecord;
  readonly ownerId: string;
  /**
   * Monotonic construction sequence number, resolver-wide.
   *
   * `disposeModuleInstances` disposes a module's `singleton` and `module`-scoped
   * instances together in one reverse-construction order, and the two scopes
   * live in different caches, so the order must survive merging them.
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

/**
 * The single dispose function to call for an instance, if any.
 *
 * A record's `onDispose` hook wins over the instance's own `dispose` method;
 * never both.
 */
function getDisposeFn(record: AnyProviderRecord, instance: unknown): (() => void | Promise<void>) | undefined {
  if (record.onDispose !== undefined) {
    return () => record.onDispose?.(instance);
  }
  if (instance !== null && typeof instance === 'object' && typeof (instance as Partial<Disposable>).dispose === 'function') {
    return () => (instance as Disposable).dispose();
  }
  return undefined;
}

/**
 * Turns a token plus a requesting module into an instance.
 *
 * Owns scopes, laziness, resolution-context propagation, the `optional` and
 * `allOf` dependency wrappers, cycle detection and disposal. Reads from the
 * registry and never writes to it.
 */
export class Resolver {
  private readonly getDependsOn: (moduleId: string) => readonly string[] | undefined;
  private readonly onError: ErrorReporter;
  private readonly disposeTimeoutMs: number;
  private readonly getTopologicalIndex: (moduleId: string) => number;
  /** `undefined` unless the caller opted into graph recording. */
  private readonly recordResolution: ResolverOptions['recordResolution'];

  /**
   * `singleton`-scoped instances: one per provider record for the lifetime of
   * its owning module's activation.
   *
   * Keyed by the frozen `ProviderRecord` object, a unique identity per
   * `provide()`/`contribute()` call, so single providers and contributions share
   * one map without token-label collisions.
   */
  private readonly singletonCache = new Map<AnyProviderRecord, CachedInstance>();
  /**
   * Construction order across all singletons, for `dispose`'s reverse teardown.
   * Rebuilt rather than spliced when `disposeModuleInstances` removes entries,
   * so it always holds exactly the records still in `singletonCache`.
   */
  private singletonOrder: AnyProviderRecord[] = [];
  /** Feeds `CachedInstance.seq`. */
  private nextSeq = 0;

  /**
   * `module`-scoped instances, keyed by the *providing* module's id, then by
   * record. Two different consumers of one module-scoped provider get the same
   * instance.
   */
  private readonly moduleScopedCache = new Map<string, Map<AnyProviderRecord, CachedInstance>>();
  private readonly moduleScopedOrder = new Map<string, AnyProviderRecord[]>();

  /**
   * Instances held back from a module's previous activation, waiting for their
   * replacement to be constructed: owning module id, then token label, then the
   * old instance.
   *
   * Populated only by `disposeModuleInstances(id, { preservePersistent: true })`
   * and drained by `construct` as soon as the matching fresh instance exists.
   *
   * Keyed by token *label* rather than token identity, because a re-evaluated
   * module file may yield fresh `Token` objects while the label survives; the
   * map is already scoped to one owning module, so colliding labels would mean
   * one module providing two same-named tokens.
   *
   * Bounded to one generation: every `disposeModuleInstances` call clears the
   * module's entry first and only a preserving call refills it.
   */
  private readonly pendingPersistent = new Map<string, Map<string, unknown>>();

  /**
   * Provider records currently mid-construction, for cycle detection.
   * `constructing` answers membership; `stack` is the same information ordered,
   * for the token path in error messages. Both describe only resolutions still
   * in progress on the current synchronous call stack.
   */
  private readonly constructing = new Set<AnyProviderRecord>();
  private readonly stack: AnyProviderRecord[] = [];
  /**
   * The owner of each record in `stack`, in step with it.
   *
   * A parallel array because a record does not know its own owner — provenance
   * is assigned by the registry. Maintained in the same `try`/`finally` as
   * `stack` so the two cannot drift, and left empty when `recordResolution` is
   * unset.
   */
  private readonly ownerStack: string[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    options: ResolverOptions = {},
  ) {
    this.getDependsOn = options.getDependsOn ?? (() => undefined);
    this.onError = options.onError ?? (() => {});
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.getTopologicalIndex = options.getTopologicalIndex ?? (() => 0);
    this.recordResolution = options.recordResolution;
  }

  /**
   * Resolves `token` on behalf of `options.requester`, constructing lazily.
   *
   * @throws {ResolutionError} no provider is registered anywhere along the chain.
   * @throws {CircularDependencyError} the chain revisits a provider already
   *   under construction.
   * @throws {ProviderFactoryError} a factory threw; the original error is
   *   preserved as `cause`.
   */
  resolve<T>(token: Token<T>, options: ResolveOptions): T {
    return this.resolveToken(token as AnyToken, options.requester) as T;
  }

  /**
   * The full contribution collection for `token`, in module topological order,
   * each contribution constructed in its own scope. An unknown token yields
   * `[]`, not an error.
   *
   * This is the only place a contribution collection is constructed, so
   * `deps: [allOf(Token)]` and `Container.getAll` can never disagree about
   * ordering or about which instances they see.
   *
   * Each contribution is resolved on behalf of its own owning module, not on
   * behalf of whoever asked for the collection — hence no `ResolveOptions`.
   * `injectAll` is not one resolution chain but one per contributor;
   * propagation within each of those chains is unchanged.
   *
   * @param accept when given, filters contributions by owning module id before
   *   any of them is constructed, so a rejected owner's factory never runs and
   *   nothing is cached for it.
   */
  resolveAllOf<T>(token: Token<T>, accept?: (ownerModuleId: string) => boolean): readonly T[] {
    const contributions = this.registry.getContributions(token);
    const ordered = orderContributions(contributions, this.getTopologicalIndex);
    const kept = accept === undefined ? ordered : ordered.filter((entry) => accept(entry.owner));
    return kept.map((entry) => this.construct(entry, entry.owner));
  }

  /**
   * Disposes and discards every instance owned by `moduleId` — `module`-scoped
   * and `singleton` alike — in reverse construction order across both scopes.
   *
   * A no-op if the module never constructed anything. After this resolves, the
   * next resolution of one of that module's providers constructs a fresh
   * instance: a module-owned `singleton` lives for its owning module's
   * activation, not for the process. `transient` instances were never owned by
   * the container and are untouched.
   *
   * @param options.preservePersistent holds a `persistent: true` instance back
   *   instead of disposing it, parking it so the replacement constructed later
   *   from the new factory can adopt its state. A preserved instance is not
   *   disposed at all, so its own listeners outlive one generation. Everything
   *   else is disposed as usual, and any entry parked by an earlier cycle is
   *   dropped. Defaults to `false`, which discards persistent state.
   */
  async disposeModuleInstances(
    moduleId: string,
    options: { readonly preservePersistent?: boolean } = {},
  ): Promise<void> {
    const preservePersistent = options.preservePersistent ?? false;
    const owned: CachedInstance[] = [];
    // Cleared unconditionally — see `pendingPersistent`'s one-generation bound.
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

    // Entries are removed from the cache before any disposal runs, and
    // `singletonOrder` is rebuilt from the survivors, so a later `dispose()`
    // cannot revisit an instance torn down here.
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

    // Parked before any disposal runs, so another instance of this module that
    // reaches for the preserved one while disposing still finds the same object
    // the replacement will inherit from.
    if (preserved.size > 0) {
      this.pendingPersistent.set(moduleId, preserved);
    }

    if (owned.length === 0) {
      return;
    }
    // One reverse-construction order across both scopes: a module-scoped
    // instance built after a singleton is disposed before it.
    owned.sort((a, b) => b.seq - a.seq);
    for (const cached of owned) {
      await this.disposeInstance(cached);
    }
  }

  /**
   * Container teardown: disposes every `singleton` instance still cached, in
   * reverse construction order.
   *
   * `module`-scoped instances are not touched here; they are disposed via
   * `disposeModuleInstances` as each module is torn down. A module that was
   * already deactivated took its singletons with it, so no instance is ever
   * disposed twice.
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

  private resolveToken(token: AnyToken, requester: string): unknown {
    // MODULE_ID has no provider; it resolves directly to the propagated
    // requester.
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
      // "Found or not" is the only question `optional` answers: absence is
      // checked against the registry before construction is attempted, so a
      // failure inside a provider that does exist still propagates.
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
    // Unreachable: `provider.ts` validates every deps[] element at
    // provide()/contribute() time. Guarded defensively.
    throw new InvalidDescriptorError(`Resolver: unknown dependency wrapper, got ${describeValue(dep)}.`);
  }

  private construct<T>(entry: RegisteredProvider<T>, requester: string): T {
    const record = entry.record as AnyProviderRecord;

    // Recorded before the cache lookup, so a resolution answered from cache
    // counts as an edge too: a module holding a cached instance is as much a
    // consumer as the one whose miss constructed it.
    if (this.recordResolution !== undefined) {
      // The enclosing record's owner, or the chain's requester at the top of the
      // stack. See `ResolverOptions.recordResolution`.
      const consumer = this.ownerStack[this.ownerStack.length - 1] ?? requester;
      this.recordResolution(consumer, entry.owner, record.token.label);
    }

    // `transient` falls through and always constructs fresh below.
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

    // A record already mid-construction being asked for again, anywhere in the
    // current chain, is a cycle rather than a re-entrant resolution.
    if (this.constructing.has(record)) {
      throw this.buildCircularError(record);
    }

    this.constructing.add(record);
    this.stack.push(record);
    if (this.recordResolution !== undefined) {
      this.ownerStack.push(entry.owner);
    }
    try {
      // `requester` passes through unchanged to every dep: the resolution
      // context is the module that started the chain, never the owner of the
      // provider being constructed right now.
      const args = record.deps.map((dep) => this.resolveDep(dep, requester));

      let value: unknown;
      try {
        // Factories are never awaited. A factory returning a promise yields that
        // promise as the resolved value, as-is.
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

      // Adoption runs after the cache write, so a `transfer` hook that resolves
      // back to this token sees the finished instance instead of re-entering
      // construction.
      if (record.persistent) {
        this.adoptPersistentState(record, entry.owner, value);
      }

      return value as T;
    } finally {
      this.constructing.delete(record);
      this.stack.pop();
      if (this.recordResolution !== undefined) {
        this.ownerStack.pop();
      }
    }
  }

  /**
   * Hands a freshly constructed `persistent` instance the state of its parked
   * predecessor, if the owning module has one waiting.
   *
   * The parked entry is removed whether or not the transfer succeeds, so exactly
   * one generation of instance can inherit one predecessor.
   * `transferPersistentState` never throws, so nothing is caught here.
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

  /** Builds the "no provider" error: the full token path plus a suggestion when one applies. */
  private buildResolutionError(token: AnyToken, requester: string): ResolutionError {
    const path = [...this.stack.map((record) => record.token.label), token.label];
    const suggestion = this.buildSuggestion(token.label, requester);
    return new ResolutionError(path, suggestion);
  }

  /**
   * The "did you forget to list it in dependsOn?" suggestion for a failed
   * resolution, or `undefined` when the token label names no known module other
   * than the requester's own, or the requester already declares it.
   */
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
    // Always found: the only caller reaches here because `constructing` holds
    // `record`, which means this same synchronous chain pushed it onto `stack`
    // and has not yet popped it.
    const cyclePath = this.stack.slice(cycleStartIndex).map((r) => r.token.label);
    return new CircularDependencyError(cyclePath);
  }

  private buildFactoryError(cause: unknown): ProviderFactoryError {
    const path = this.stack.map((record) => record.token.label);
    return new ProviderFactoryError(path, cause);
  }

  /**
   * Disposes one cached instance, reporting rather than throwing so that the
   * remaining disposals still run.
   */
  private async disposeInstance(cached: CachedInstance): Promise<void> {
    const disposeFn = getDisposeFn(cached.record, cached.value);
    if (disposeFn === undefined) {
      return;
    }

    let result: void | Promise<void>;
    try {
      result = disposeFn();
    } catch (err) {
      this.onError(err, { moduleId: cached.ownerId, phase: 'dispose' });
      return;
    }

    if (result === undefined || typeof (result as Promise<void>).then !== 'function') {
      return;
    }

    // On timeout the instance counts as disposed regardless — the caller removed
    // it from the cache before this method ran — and the in-flight promise is
    // left to settle on its own, with any rejection still reported, just late.
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
