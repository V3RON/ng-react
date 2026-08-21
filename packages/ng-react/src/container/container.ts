import { ContributionCollections } from './collections';
import { ProviderRegistry } from './registry';
import type { RegistrySnapshot } from './registry';
import { Resolver } from './resolver';
import type { ResolveOptions, ResolverOptions } from './resolver';
import type { AnyProviderRecord } from '../provider';
import type { AnyToken, Token } from '../token';
import type { Unsubscribe } from '../types';

/**
 * Constructor options for `Container`, forwarded verbatim to its `Resolver`
 * and its `ContributionCollections`; `onError` and `getTopologicalIndex` are
 * read by both.
 */
export type ContainerOptions = ResolverOptions;

/**
 * A provider registry, a resolver and a reactive contribution collection
 * paired behind one object.
 *
 * Every method delegates. The only behaviour decided here is when a registry
 * mutation notifies contribution subscribers: immediately after the mutation
 * is fully applied.
 */
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
   * Registers `records` as owned by `moduleId`, then notifies subscribers
   * once per distinct contribution token in the batch.
   *
   * Registration is atomic, so a rejected batch notifies nobody.
   *
   * @throws {InvalidDescriptorError} for a malformed `moduleId` or `records`.
   * @throws {DuplicateRegistrationError} if `moduleId` is already registered.
   * @throws {DuplicateProviderError} for a second plain `provide()` of a token.
   * @throws {ProviderKindConflictError} for mixing `provide` and `contribute`
   *   on one token.
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
   * Removes every registration owned by `moduleId`, then notifies
   * subscribers of the affected tokens.
   *
   * This does not dispose the module's instances. Registration and
   * resolution lifetimes are sequenced by the caller, which disposes first
   * so that instances are gone before subscribers observe the change:
   *
   * ```ts
   * await container.disposeModuleInstances(id);
   * container.withdraw(id);
   * ```
   */
  withdraw(moduleId: string): void {
    const affected = this.registry.withdraw(moduleId);
    this.collections.notifyAffected(affected);
  }

  /** Tells the registry which module ids exist, for resolution-error suggestions. */
  setKnownModules(ids: readonly string[]): void {
    this.registry.setKnownModules(ids);
  }

  /**
   * Resolves `token` on behalf of `options.requester`.
   *
   * @throws {ResolutionError} no provider is registered for `token`.
   * @throws {CircularDependencyError} the resolution chain revisits a
   *   provider already under construction.
   * @throws {ProviderFactoryError} a provider factory threw.
   */
  resolve<T>(token: Token<T>, options: ResolveOptions): T {
    return this.resolver.resolve(token, options);
  }

  /**
   * The full contribution collection for `token`, in module topological
   * order, constructed lazily on first call.
   *
   * Returns `[]` for an unknown token and for a token that has a single
   * `provide`d provider — never an error.
   *
   * There is no requester parameter because each contribution is resolved on
   * behalf of its own owning module, not on behalf of the caller.
   */
  getAll<T>(token: Token<T>): readonly T[] {
    return this.collections.getAll(token);
  }

  /**
   * `getAll` restricted to contributions whose owning module `accept`
   * returns `true` for.
   *
   * `accept` is evaluated before a contribution is constructed, so a
   * rejected owner's factory never runs and nothing is cached for it.
   *
   * @param accept receives the owning module id of each contribution.
   */
  getAllWhere<T>(token: Token<T>, accept: (ownerModuleId: string) => boolean): readonly T[] {
    return this.resolver.resolveAllOf(token, accept);
  }

  /**
   * Subscribes to changes in `token`'s contribution set, caused by a module
   * registering contributions or being withdrawn.
   *
   * Does not fire on subscribe; read the current value with `getAll`. The
   * returned `Unsubscribe` is idempotent.
   */
  subscribeAll<T>(token: Token<T>, callback: (values: readonly T[]) => void): Unsubscribe {
    return this.collections.subscribeAll(token, callback);
  }

  /**
   * Disposes and discards every instance owned by `moduleId`, `module`-scoped
   * and `singleton` alike.
   *
   * @param options.preservePersistent holds back `persistent: true` instances
   *   instead of disposing them, so their state can be adopted by the
   *   replacements a re-activation constructs. Passed by hot replacement only;
   *   a real deactivation omits it and discards persistent state. Defaults to
   *   `false`.
   */
  disposeModuleInstances(
    moduleId: string,
    options: { readonly preservePersistent?: boolean } = {},
  ): Promise<void> {
    return this.resolver.disposeModuleInstances(moduleId, options);
  }

  /** Disposes every `singleton` instance still cached, for container teardown. */
  dispose(): Promise<void> {
    return this.resolver.dispose();
  }

  /** Whether `token` has a provider or at least one contribution registered. */
  hasToken<T>(token: Token<T>): boolean {
    return this.registry.hasToken(token);
  }

  /** The module owning `token`'s single provider, or `undefined`. */
  ownerOf<T>(token: Token<T>): string | undefined {
    return this.registry.ownerOf(token);
  }

  /** A deterministic snapshot of the registry's state. */
  inspect(): RegistrySnapshot {
    return this.registry.inspect();
  }
}
