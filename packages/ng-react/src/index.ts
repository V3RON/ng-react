// Public API surface of the ng-react kernel.
// Populated stage by stage; see AGENTS.md for the staged plan.
//
// Every export here is explicit and named — no `export *` — so this file
// stays the single, auditable source of truth for what a consumer may use.

// types.ts — shared public vocabulary.
export type {
  ModuleStatus,
  LoadStrategy,
  Scope,
  Disposable,
  Unsubscribe,
  EventEmitterLike,
  ModuleContext,
} from './types';

// errors.ts — the KernelError hierarchy.
export type { KernelErrorOptions } from './errors';
export {
  KernelError,
  ReservedModuleIdError,
  DuplicateModuleIdError,
  DependencyCycleError,
  UnknownModuleError,
  InvalidDescriptorError,
  DeadContextError,
} from './errors';

// module-ref.ts — module value identities (M1-M3).
export type { ModuleRef } from './module-ref';
export { moduleRef, isModuleRef } from './module-ref';

// token.ts — injection tokens and dependency-declaration wrappers (C1, C4).
export type { Token, OptionalDep, AllOfDep, Dep, Resolved, ResolvedDeps } from './token';
export { createToken, isToken, optional, allOf, MODULE_ID } from './token';

// provider.ts — provider declaration API (C2, C3, C5, C6, C7, ADR-3).
export type { ProviderOptions, ProviderRecord } from './provider';
export { provide, contribute } from './provider';

// define-module.ts — module descriptor declaration API (D1-D4).
export type { ModuleDescriptor, DefineModuleInput } from './define-module';
export { defineModule } from './define-module';
