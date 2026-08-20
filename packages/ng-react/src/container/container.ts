// Container facade (task 2.2): pairs a `ProviderRegistry` (registration,
// provenance) with a `Resolver` (scopes, resolution context, disposal) so
// the kernel (a later stage) has a single object to hold. Deliberately
// thin — every method delegates to one of the two collaborators; no new
// rules are enforced here.
//
// Like `ProviderRegistry` and `Resolver`, `Container` is internal and not
// exported from `index.ts`.

import { ProviderRegistry } from './registry';
import type { RegistrySnapshot } from './registry';
import { Resolver } from './resolver';
import type { ResolveOptions, ResolverOptions } from './resolver';
import type { AnyProviderRecord } from '../provider';
import type { Token } from '../token';

/** Constructor options for `Container` — forwarded to its `Resolver`. */
export type ContainerOptions = ResolverOptions;

export class Container {
  private readonly registry = new ProviderRegistry();
  private readonly resolver: Resolver;

  constructor(options: ContainerOptions = {}) {
    this.resolver = new Resolver(this.registry, options);
  }

  /** Delegates to `ProviderRegistry.register` (C5, C6, C9). */
  register(moduleId: string, records: readonly AnyProviderRecord[]): void {
    this.registry.register(moduleId, records);
  }

  /**
   * Delegates to `ProviderRegistry.withdraw`. Deliberately does **not**
   * cascade into `disposeModuleScope` — registration and resolution
   * lifetimes are separate concerns here; the kernel (which knows the
   * right ordering relative to `dispose`/`init`, A4/H2) decides when each
   * runs.
   */
  withdraw(moduleId: string): void {
    this.registry.withdraw(moduleId);
  }

  /** Delegates to `ProviderRegistry.setKnownModules` — backs the C8 suggestion. */
  setKnownModules(ids: readonly string[]): void {
    this.registry.setKnownModules(ids);
  }

  /** Delegates to `Resolver.resolve` (C2, C3, C4, C8). */
  resolve<T>(token: Token<T>, options: ResolveOptions): T {
    return this.resolver.resolve(token, options);
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
