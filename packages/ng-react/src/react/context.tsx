// **R1 / R2** — the two React contexts the bindings stand on:
//
//  - `<AppKernel kernel={…}>` publishes the kernel. Exactly one per app.
//  - `<ModuleScope module={ref}>` sets C4's resolution context for a
//    subtree, so `useService` inside it resolves *on behalf of that module*
//    and `MODULE_ID` yields its id.
//
// **ADR-6**: `src/react/**` is the only place in the package that may
// import `react`. Nothing here reaches back into `src/kernel/` or
// `src/container/` for anything but types and the public `Kernel` surface.

import { createContext, useContext, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { KernelError } from '../errors';
import type { Kernel } from '../kernel/kernel';
import type { ModuleRef } from '../module-ref';
import type { AnyToken } from '../token';

/**
 * ADR-2: the reserved module id for a resolution started outside any
 * module. Duplicated from `kernel.ts`'s private `APP_REQUESTER` rather than
 * exported from there, because promoting it to a shared public constant
 * would be a new name on the public surface that task 4.1 was not asked to
 * add. Pinned by a test that asserts `useModuleScope()` is `'app'` and that
 * `MODULE_ID` resolves to the same string outside any `ModuleScope`.
 */
const APP_MODULE_ID = 'app';

/**
 * R1: what `<AppKernel>` publishes.
 *
 * More than the bare kernel because of the transient warning (R2). "Warn
 * once per token" needs somewhere to remember which tokens have been
 * warned, and the obvious home — a module-level `Set` — is **global mutable
 * state**: the first test file to render a transient would silently
 * suppress the warning for every later one, and two `createTestKernel`s
 * (#18/R4) in one file would interfere. So the set is created per
 * `<AppKernel>` instance and travels in the context value. There is no
 * module-level mutable state in this package.
 */
interface KernelContextValue {
  readonly kernel: Kernel;
  /** R2: tokens already warned about under this `<AppKernel>` (dev only). */
  readonly warnedTransientTokens: Set<AnyToken>;
}

const KernelContext = createContext<KernelContextValue | undefined>(undefined);
const ModuleScopeContext = createContext<string | undefined>(undefined);

/**
 * R1: `<AppKernel>` was rendered inside another `<AppKernel>`.
 *
 * Not exported from `index.ts` — like every other error in this package it
 * is caught by `instanceof KernelError` and asserted on by message. It
 * lives here rather than in `errors.ts` because task 4.1's declared scope is
 * `src/react/`, `src/hmr/epoch.ts` and the barrel; see the PR body.
 */
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

/**
 * R1: a hook that needs the kernel was called outside `<AppKernel>`.
 */
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
 * **R1**: provides `kernel` to the subtree. Exactly one per app.
 *
 * Nesting is detected by reading the context in the provider body, so an
 * inner `<AppKernel>` throws while rendering rather than silently shadowing
 * the outer kernel — two kernels in one tree means two container instances,
 * two lifecycles and two sets of module-scoped singletons, and the symptom
 * (a service that is mysteriously not the one `init` built) is far away
 * from the cause. `createTestKernel` (R4) is the sanctioned way to get a
 * second, *isolated* kernel, and the message says so.
 *
 * @throws {KernelError} `NestedAppKernelError` when rendered inside another
 *   `<AppKernel>`.
 */
export function AppKernel(props: { kernel: Kernel; children: ReactNode }): ReactElement {
  const outer = useContext(KernelContext);
  if (outer !== undefined) {
    throw new NestedAppKernelError();
  }

  // The context value must be stable across renders or every consumer
  // re-renders on each parent render. A ref rather than `useMemo` because
  // React may discard a `useMemo` cache at will, and discarding this one
  // would silently reset the warn-once set. The write is idempotent — under
  // StrictMode's double-invoked render the second pass finds the same
  // kernel and keeps the first pass's value — and it is re-created only when
  // the `kernel` prop actually changes identity.
  const valueRef = useRef<KernelContextValue | undefined>(undefined);
  if (valueRef.current === undefined || valueRef.current.kernel !== props.kernel) {
    valueRef.current = { kernel: props.kernel, warnedTransientTokens: new Set<AnyToken>() };
  }

  return <KernelContext value={valueRef.current}>{props.children}</KernelContext>;
}

/**
 * **R1**: the kernel provided by the enclosing `<AppKernel>`.
 *
 * @throws {KernelError} `MissingAppKernelError` outside an `<AppKernel>`.
 */
export function useKernel(): Kernel {
  return useKernelContext('useKernel').kernel;
}

/**
 * Internal: the full context value, for the hooks that also need the
 * warn-once set. `hookName` is threaded through so the "outside
 * `<AppKernel>`" error names the hook the consumer actually called rather
 * than an internal helper.
 */
export function useKernelContext(hookName: string): KernelContextValue {
  const value = useContext(KernelContext);
  if (value === undefined) {
    throw new MissingAppKernelError(hookName);
  }
  return value;
}

/**
 * **R2**: sets C4's resolution context for its subtree — every
 * `useService`/`useServiceOptional` below resolves on behalf of
 * `props.module`, and `MODULE_ID` inside those chains yields its id.
 *
 * This is the *mechanism* R2 asks for, not its policy. Spec §12 R2 says the
 * tagging is done "by the navigation module at route registration", which
 * is spec 03 — that module will wrap each route component in a
 * `<ModuleScope>` built from the route contribution's provenance (C9).
 * Nothing in this package does that tagging, and nothing here should.
 *
 * Nesting is allowed and the innermost wins: a screen owned by `orders`
 * that embeds a widget owned by `analytics` is a real composition, and the
 * widget's services should be built for `analytics`.
 */
export function ModuleScope(props: { module: ModuleRef; children: ReactNode }): ReactElement {
  return <ModuleScopeContext value={props.module.id}>{props.children}</ModuleScopeContext>;
}

/**
 * **R2 / ADR-2**: the resolution-context module id in force here — the
 * nearest enclosing `<ModuleScope>`'s module, or the reserved `'app'`
 * outside any of them.
 *
 * Never `undefined`, which is ADR-2's whole point: `MODULE_ID` always
 * resolves, and consumers need no `optional()` dance.
 */
export function useModuleScope(): string {
  return useContext(ModuleScopeContext) ?? APP_MODULE_ID;
}
