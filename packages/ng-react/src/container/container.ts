// Container facade (task 2.2, extended by task 2.3): pairs a
// `ProviderRegistry` (registration, provenance) with a `Resolver` (scopes,
// resolution context, disposal) and a `ContributionCollections` (C5
// ordering and reactivity) so the kernel (a later stage) has a single
// object to hold. Deliberately thin — every method delegates to one of the
// three collaborators; the only thing decided here is *when* a registry
// mutation notifies C5 subscribers, which is "immediately after the
// mutation is fully applied" for both `register` and `withdraw`.
//
// Like `ProviderRegistry`, `Resolver` and `ContributionCollections`,
// `Container` is internal and not exported from `index.ts`.
//
// Spec §7.2 names `injectAll(token)` and `subscribeAll(token, cb)` as free
// functions. They are `getAll`/`subscribeAll` methods here instead: a free
// function needs an ambient container to resolve against, and no kernel
// exists until stage 3. Inventing global mutable state to fake one would be
// a permanent contract paid for a stage-3 convenience, so the free
// functions land with the kernel that can back them — see the PR for #13.

import { ContributionCollections } from './collections';
import { ProviderRegistry } from './registry';
import type { RegistrySnapshot } from './registry';
import { Resolver } from './resolver';
import type { ResolveOptions, ResolverOptions } from './resolver';
import type { AnyProviderRecord } from '../provider';
import type { AnyToken, Token } from '../token';
import type { Unsubscribe } from '../types';

/**
 * Constructor options for `Container` — forwarded verbatim to its
 * `Resolver` and its `ContributionCollections` (`onError` and
 * `getTopologicalIndex` are read by both, which is what keeps a single
 * `new Container({...})` enough to configure the whole container).
 */
export type ContainerOptions = ResolverOptions;

export class Container {
  private readonly registry = new ProviderRegistry();
  private readonly resolver: Resolver;
  private readonly collections: ContributionCollections;

  constructor(options: ContainerOptions = {}) {
    this.resolver = new Resolver(this.registry, options);
    this.collections = new ContributionCollections(
      this.registry,
      (token) => this.resolver.resolveAllOf(token),
      options,
    );
  }

  /**
   * Delegates to `ProviderRegistry.register` (C5, C6, C9), then notifies
   * C5 subscribers **once** for each contribution token in `records`
   * (task 2.3), after the registry mutation is fully applied.
   *
   * `register` is atomic and throws before writing anything, so a rejected
   * batch notifies nobody. A module contributing three items to one token
   * fires one notification: the token set below is a `Set`.
   */
  register(moduleId: string, records: readonly AnyProviderRecord[]): void {
    this.registry.register(moduleId, records);
    const contributed = new Set<AnyToken>();
    for (const record of records) {
      if (record.kind === 'contribute') {
        contributed.add(record.token as AnyToken);
      }
    }
    this.collections.notifyAffected(contributed);
  }

  /**
   * Delegates to `ProviderRegistry.withdraw` (F3 quarantine, A4 disposal),
   * then notifies C5 subscribers of the affected tokens (task 2.3).
   *
   * Still deliberately does **not** cascade into `disposeModuleScope` —
   * registration and resolution lifetimes are separate concerns here, and
   * the kernel (which knows the right ordering relative to `dispose`/`init`,
   * A4/H2) decides when each runs. That is also what makes C5's "instances
   * are disposed before subscribers are notified" achievable *without* a
   * cascade: the caller sequences
   *
   * ```ts
   * await container.disposeModuleScope(id); // C7 — module-scoped instances
   * container.withdraw(id);                 // registry mutation + C5 notify
   * ```
   *
   * `withdraw` is synchronous and `disposeModuleScope` is `async`, so the
   * ordering cannot be folded in here without making `withdraw` async —
   * a lifecycle decision stage 3 (#15/#16) owns, not this task.
   *
   * The affected-token set from the registry over-reports on purpose (it
   * includes `provide`-kind tokens and contribution tokens whose effective
   * collection did not change). `ContributionCollections.notifyAffected`
   * collapses the excess; nothing is filtered here.
   */
  withdraw(moduleId: string): void {
    const affected = this.registry.withdraw(moduleId);
    this.collections.notifyAffected(affected);
  }

  /** Delegates to `ProviderRegistry.setKnownModules` — backs the C8 suggestion. */
  setKnownModules(ids: readonly string[]): void {
    this.registry.setKnownModules(ids);
  }

  /** Delegates to `Resolver.resolve` (C2, C3, C4, C8). */
  resolve<T>(token: Token<T>, options: ResolveOptions): T {
    return this.resolver.resolve(token, options);
  }

  /**
   * C5's `injectAll`: the full contribution collection for `token`, in
   * module topological order, constructed lazily (C3) on the first call.
   * `[]` for an unknown token, and for a token that has a single `provide`d
   * provider — never an error. Delegates to `ContributionCollections`,
   * which shares its one construction path with `deps: [allOf(Token)]`.
   *
   * Unlike `resolve`, this takes **no** `ResolveOptions`. Each contribution
   * is resolved on behalf of its own owner (C4/C9), so there is no caller
   * resolution context to supply — and an accepted-but-ignored
   * `{ requester }` would be a parameter that silently does nothing, which
   * is exactly how the value that reaches `MODULE_ID` becomes a surprise.
   * `ModuleContext.getAll<T>(token)` in `types.ts` already has this shape.
   * The task issue's suggested `getAll(token, { requester })` is a
   * deliberate deviation — see the PR for #13.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.collections.getAll(token);
  }

  /**
   * **F4**: `getAll` restricted to contributions whose owning module
   * `accept` returns `true` for — evaluated **before** the contribution is
   * constructed.
   *
   * The kernel's error-sink routing is the one caller, and the ordering is
   * its whole reason for existing: a sink contributed by a module that is
   * `failed` or `disposed` must be skipped, and skipping it *after*
   * `getAll` would mean the quarantined module's factory had already run
   * and (for `singleton`/`module` scope) been cached. Goes straight to the
   * resolver rather than through `ContributionCollections`, which is a pure
   * pass-through for construction anyway — the C5 ordering, laziness and
   * per-owner resolution context are the resolver's and are unchanged here.
   */
  getAllWhere<T>(token: Token<T>, accept: (ownerModuleId: string) => boolean): readonly T[] {
    return this.resolver.resolveAllOf(token, accept);
  }

  /**
   * C5's `subscribeAll`: notifies `callback` when `token`'s contribution
   * set changes (module registered contributions, or was withdrawn by
   * disposal or F3 quarantine). Does not fire on subscribe — read the
   * current value with `getAll`. The returned `Unsubscribe` is idempotent.
   */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe {
    return this.collections.subscribeAll(token, callback);
  }

  /** Delegates to `Resolver.disposeModuleScope` (C7). */
  disposeModuleScope(moduleId: string): Promise<void> {
    return this.resolver.disposeModuleScope(moduleId);
  }

  /** Delegates to `Resolver.dispose` (C7) — container teardown, singletons only. */
  dispose(): Promise<void> {
    return this.resolver.dispose();
  }

  /** Delegates to `ProviderRegistry.hasToken`. */
  hasToken<T>(token: Token<T>): boolean {
    return this.registry.hasToken(token);
  }

  /** Delegates to `ProviderRegistry.ownerOf`. */
  ownerOf<T>(token: Token<T>): string | undefined {
    return this.registry.ownerOf(token);
  }

  /** Delegates to `ProviderRegistry.inspect` (G3). */
  inspect(): RegistrySnapshot {
    return this.registry.inspect();
  }
}
