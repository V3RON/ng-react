// Public API surface. Every export is explicit and named — no `export *` —
// so this file is the complete list of what a consumer may use.

export type {
  ModuleStatus,
  LoadStrategy,
  Scope,
  Disposable,
  Unsubscribe,
  EventEmitterLike,
  ModuleContext,
  ErrorPhase,
  ErrorInfo,
  ErrorSink,
} from './types';

export type { KernelErrorOptions } from './errors';
export {
  KernelError,
  ReservedModuleIdError,
  DuplicateModuleIdError,
  DependencyCycleError,
  UnknownModuleError,
  InvalidDescriptorError,
  DeadContextError,
  DuplicateProviderError,
  ProviderKindConflictError,
  DuplicateRegistrationError,
  ResolutionError,
  CircularDependencyError,
  ProviderFactoryError,
  DisposeTimeoutError,
  ActivationTimeoutError,
  ModuleActivationError,
  DependencyActivationError,
  ModuleDisposeTimeoutError,
  UnsupportedEmitterError,
} from './errors';

export type { ModuleRef } from './module-ref';
export { moduleRef, isModuleRef } from './module-ref';

export type { Token, AnyToken, OptionalDep, AllOfDep, Dep, Resolved, ResolvedDeps } from './token';
export { createToken, isToken, optional, allOf, MODULE_ID } from './token';

export type { ProviderOptions, ProviderRecord, AnyProviderRecord } from './provider';
export { provide, contribute } from './provider';

export type { ModuleDescriptor, DefineModuleInput } from './define-module';
export { defineModule } from './define-module';

// The `inspect()` result types are not exported by name; reach them as
// `ReturnType<Kernel['inspect']>`.
export type { Kernel, KernelOptions } from './kernel/kernel';
export { createKernel } from './kernel/kernel';

// The HMR seam is `invalidate` only. The `accept` half belongs to the
// module's own file, which must name `import.meta.hot.accept` literally for
// Vite's static analysis to find it.
export type { HmrAdapter, ViteHotContext } from './hmr/adapter';
export { createViteHmrAdapter, createNoopHmrAdapter } from './hmr/adapter';
export type { Store } from './hmr/persistent';
export { defineStore } from './hmr/persistent';

export { ErrorSinkToken } from './kernel/failure';

// The React bindings are the only exports whose implementation imports
// `react`; importing this barrel does not pull React in unless one of them
// is used (`sideEffects: false`).
export type { ModuleState } from './react/hooks';
export { AppKernel, ModuleScope, useKernel, useModuleScope } from './react/context';
export { useModule, useService, useServiceAll, useServiceOptional } from './react/hooks';
export type { KernelStartupState } from './react/startup-store';
export type { KernelStartupGateProps } from './react/startup';
export { KernelStartupGate, useKernelStartup } from './react/startup';

export type { TestKernel, TestKernelOptions, CollectedError } from './testing/test-kernel';
export { createTestKernel } from './testing/test-kernel';
export type { LeakReport } from './testing/leak-counters';
export type { EvaluationEvent } from './testing/evaluation-log';
export { recordEvaluation, evaluationLog } from './testing/evaluation-log';
