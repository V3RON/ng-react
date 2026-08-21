import { createContext, useContext, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { KernelError } from '../errors';
import type { Kernel } from '../kernel/kernel';
import type { ModuleRef } from '../module-ref';
import type { AnyToken } from '../token';

/** The reserved module id for a resolution started outside any module. */
const APP_MODULE_ID = 'app';

/**
 * The value `<AppKernel>` publishes to its subtree.
 *
 * The warn-once set lives here rather than at module level so that two
 * kernels — two test kernels in one file, say — never suppress each other's
 * warnings.
 */
interface KernelContextValue {
  readonly kernel: Kernel;
  /** Tokens already warned about under this `<AppKernel>`. Dev only. */
  readonly warnedTransientTokens: Set<AnyToken>;
}

const KernelContext = createContext<KernelContextValue | undefined>(undefined);
const ModuleScopeContext = createContext<string | undefined>(undefined);

/** Thrown when an `<AppKernel>` is rendered inside another `<AppKernel>`. */
class NestedAppKernelError extends KernelError {
  constructor() {
    super(
      'REACT_NESTED_APP_KERNEL',
      'Nested <AppKernel>: there is exactly one kernel per app (R1). ' +
        'Remove the inner <AppKernel> and let the subtree read the outer one with useKernel(). ' +
        'If you need a second, isolated kernel — in a test — build it with createTestKernel() ' +
        'and render it as the only <AppKernel> of that tree (R4).',
    );
    this.name = 'NestedAppKernelError';
  }
}

/** Thrown when a hook that needs the kernel is called outside `<AppKernel>`. */
class MissingAppKernelError extends KernelError {
  constructor(hookName: string) {
    super(
      'REACT_MISSING_APP_KERNEL',
      `${hookName}() was called outside <AppKernel> (R1). ` +
        'Wrap the tree in <AppKernel kernel={kernel}> at the composition root, ' +
        'or, in a test, in <AppKernel kernel={createTestKernel({ modules: [...] })}>.',
    );
    this.name = 'MissingAppKernelError';
  }
}

/**
 * Provides `kernel` to everything below it. Render exactly one per app, at
 * the composition root.
 *
 * @throws {KernelError} When rendered inside another `<AppKernel>`. Use
 *   `createTestKernel` when a test needs a second, isolated kernel.
 *
 * @example
 * ```tsx
 * <AppKernel kernel={kernel}>
 *   <App />
 * </AppKernel>
 * ```
 */
export function AppKernel(props: { kernel: Kernel; children: ReactNode }): ReactElement {
  const outer = useContext(KernelContext);
  if (outer !== undefined) {
    throw new NestedAppKernelError();
  }

  // A ref rather than `useMemo`: React may discard a memo cache at any time,
  // and discarding this one would reset the warn-once set. The write is
  // idempotent, so StrictMode's double-invoked render keeps one value.
  const valueRef = useRef<KernelContextValue | undefined>(undefined);
  if (valueRef.current === undefined || valueRef.current.kernel !== props.kernel) {
    valueRef.current = { kernel: props.kernel, warnedTransientTokens: new Set<AnyToken>() };
  }

  return <KernelContext value={valueRef.current}>{props.children}</KernelContext>;
}

/**
 * Returns the kernel provided by the enclosing `<AppKernel>`.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 */
export function useKernel(): Kernel {
  return useKernelContext('useKernel').kernel;
}

/**
 * Returns the full context value, for the hooks that also need the
 * warn-once set.
 *
 * @param hookName Named in the "outside `<AppKernel>`" error, so it reports
 *   the hook the consumer called rather than an internal helper.
 * @throws {KernelError} When called outside an `<AppKernel>`.
 */
export function useKernelContext(hookName: string): KernelContextValue {
  const value = useContext(KernelContext);
  if (value === undefined) {
    throw new MissingAppKernelError(hookName);
  }
  return value;
}

/**
 * Sets the resolution context for its subtree: every `useService` and
 * `useServiceOptional` below resolves on behalf of `props.module`, and
 * `MODULE_ID` inside those resolution chains yields its id.
 *
 * Nesting is allowed and the innermost scope wins.
 */
export function ModuleScope(props: { module: ModuleRef; children: ReactNode }): ReactElement {
  return <ModuleScopeContext value={props.module.id}>{props.children}</ModuleScopeContext>;
}

/**
 * Returns the resolution-context module id in force here: the nearest
 * enclosing `<ModuleScope>`'s module, or the reserved `'app'` outside any of
 * them. Never `undefined`.
 */
export function useModuleScope(): string {
  return useContext(ModuleScopeContext) ?? APP_MODULE_ID;
}
