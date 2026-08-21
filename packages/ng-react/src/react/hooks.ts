// Every hook here is a `useSyncExternalStore` over a kernel subscription.
// React calls `getSnapshot` on every render, not only after a notification,
// so each one must return a referentially stable value: a fresh object or
// array from `getSnapshot` re-renders forever.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useKernelContext, useModuleScope } from './context';
import type { Kernel } from '../kernel/kernel';
import type { ModuleRef } from '../module-ref';
import { MODULE_ID } from '../token';
import type { AnyToken, Token } from '../token';
import type { ModuleStatus, Unsubscribe } from '../types';

/**
 * Dev-only gate for the transient warning. Read through `globalThis`
 * because `process` may not exist in a browser or under React Native.
 */
const IS_DEV: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] !== 'production';

/**
 * Subscribes to the resolution epoch of `moduleId` and returns its current
 * value.
 *
 * @param moduleId The module that *owns the provider*, not the consuming
 *   component's scope — a component holding a `payments`-owned instance must
 *   re-render when `payments` reloads. `undefined` subscribes to the global
 *   epoch, a superset of the notifications a token with no single owner
 *   needs.
 */
function useEpoch(kernel: Kernel, moduleId: string | undefined): number {
  const subscribe = useCallback(
    (onStoreChange: () => void): Unsubscribe => kernel.subscribeEpoch(moduleId, onStoreChange),
    [kernel, moduleId],
  );
  const getSnapshot = useCallback((): number => kernel.epochOf(moduleId), [kernel, moduleId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Warns, in dev only, when a component resolves a `transient` provider. At
 * most once per token per `<AppKernel>`.
 *
 * Runs in an effect rather than in render: `kernel.inspect()` is too
 * expensive for every render, and render must stay side-effect free under
 * concurrent rendering.
 */
function useTransientWarning(
  kernel: Kernel,
  token: AnyToken,
  owner: string | undefined,
  warnedTransientTokens: Set<AnyToken>,
): void {
  useEffect(() => {
    if (!IS_DEV || owner === undefined) {
      return;
    }
    if (warnedTransientTokens.has(token)) {
      return;
    }
    const row = kernel
      .inspect()
      .providers.find(
        (candidate) =>
          candidate.kind === 'provide' &&
          candidate.owner === owner &&
          candidate.token === token.label,
      );
    if (row?.scope !== 'transient') {
      return;
    }
    warnedTransientTokens.add(token);
    console.warn(
      `useService(${token.label}) resolves a 'transient' provider (owned by '${owner}'): ` +
        'a new instance is constructed on every resolution, so nothing about it is stable ' +
        'across renders and the container will never dispose it (C2, C7). ' +
        'Resolve transients inside an event handler or an effect instead (R2). ' +
        'The ng-react-modules/no-transient-in-component lint rule catches this statically only when '  +
        'the provider is declared in the same file; this warning covers the rest.',
    );
  }, [kernel, token, owner, warnedTransientTokens]);
}

/**
 * Resolves `token`, on behalf of the module owning the enclosing
 * `<ModuleScope>` (or `'app'` outside any), and re-renders when that
 * provider's module is hot-reloaded.
 *
 * `singleton`- and `module`-scoped instances are referentially stable across
 * renders. Resolution errors reach the caller unwrapped, so the container's
 * full resolution chain and `dependsOn` suggestion survive into the render
 * failure.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 * @throws {ResolutionError} When no provider is registered for `token`. Use
 *   `useServiceOptional` when a missing provider is expected.
 * @throws {ProviderFactoryError} When a factory in the resolution chain
 *   throws.
 *
 * @example
 * ```tsx
 * function CartBadge() {
 *   const cart = useService(CartToken);
 *   return <span>{cart.count}</span>;
 * }
 * ```
 */
export function useService<T>(token: Token<T>): T {
  const { kernel, warnedTransientTokens } = useKernelContext('useService');
  const requester = useModuleScope();
  const owner = kernel.ownerOf(token);
  const epoch = useEpoch(kernel, owner);
  useTransientWarning(kernel, token, owner, warnedTransientTokens);
  // `epoch` is a dependency, not an input: it discards the memo when the
  // owning module reloads.
  return useMemo(() => kernel.get(token, requester), [kernel, token, requester, epoch]);
}

/**
 * `useService` for a token that may have no provider: returns `undefined`
 * instead of throwing.
 *
 * Only the found-or-not question is optional — a factory that is found and
 * throws still propagates. Agrees with `deps: [optional(token)]` on what
 * counts as present, `MODULE_ID` included.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 * @throws {ProviderFactoryError} When a factory in the resolution chain
 *   throws.
 */
export function useServiceOptional<T>(token: Token<T>): T | undefined {
  const { kernel, warnedTransientTokens } = useKernelContext('useServiceOptional');
  const requester = useModuleScope();
  const owner = kernel.ownerOf(token);
  const epoch = useEpoch(kernel, owner);
  useTransientWarning(kernel, token, owner, warnedTransientTokens);
  const resolvable = owner !== undefined || (token as AnyToken) === MODULE_ID;
  return useMemo(
    () => (resolvable ? kernel.get(token, requester) : undefined),
    [kernel, token, requester, epoch, resolvable],
  );
}

/**
 * Per-hook-instance cache behind `useServiceAll`.
 *
 * `getSnapshot` must hand back the *same array* until the contribution set
 * actually changes; a fresh array on each call re-renders forever.
 */
function createCollectionStore<T>(kernel: Kernel, token: Token<T>) {
  let snapshot: readonly T[] | undefined;

  const refresh = (next: readonly T[]): boolean => {
    if (snapshot !== undefined && sameContributions(snapshot, next)) {
      return false;
    }
    snapshot = next;
    return true;
  };

  return {
    getSnapshot(): readonly T[] {
      if (snapshot === undefined) {
        snapshot = kernel.getAll(token);
      }
      return snapshot;
    },
    subscribe(onStoreChange: () => void): Unsubscribe {
      // Catch up first: no notifications arrive between an unsubscribe and
      // the next subscribe (a StrictMode remount, or a token/kernel change),
      // so a stale cached array would otherwise survive.
      if (snapshot !== undefined) {
        refresh(kernel.getAll(token));
      }
      return kernel.subscribeAll(token, (values) => {
        if (refresh(values)) {
          onStoreChange();
        }
      });
    },
  };
}

/** Element-wise identity comparison. Contribution collections are ordered. */
function sameContributions<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => Object.is(value, b[index]));
}

/**
 * Returns the full contribution collection for `token`, in module
 * topological order, re-rendering whenever the contribution set changes —
 * module activation, disposal, quarantine, or a hot replace.
 *
 * The returned array is referentially stable while the collection is
 * unchanged, so it is safe as a hook dependency.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 *
 * @example
 * ```tsx
 * const routes = useServiceAll(RouteConfigToken);
 * // [{ path: 'orders', screen: OrdersScreen }, { path: 'cart', screen: CartScreen }]
 * return <>{routes.map((route) => <Route key={route.path} {...route} />)}</>;
 * ```
 */
export function useServiceAll<T>(token: Token<T>): readonly T[] {
  const { kernel } = useKernelContext('useServiceAll');
  const store = useMemo(() => createCollectionStore(kernel, token), [kernel, token]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** What `useModule` reports about one module. */
export interface ModuleState {
  /** The module's current lifecycle state. */
  readonly status: ModuleStatus;
  /**
   * The retained failure of a `failed` module, as `inspect()` describes it
   * (`{ name, message, code }`). Absent unless the module failed.
   */
  readonly error?: unknown;
  /**
   * Re-attempts activation from a clean slate. Referentially stable, and
   * safe to pass straight to a `<button>`.
   *
   * A failed retry re-quarantines the module and surfaces in `status` and
   * `error` rather than rejecting.
   */
  readonly retry: () => void;
}

/**
 * Returns `ref`'s status, its retained failure, and a `retry`, re-rendering
 * on every status transition.
 *
 * Observing a module does not activate it: a `lazy` module watched through
 * this hook stays `registered` until something calls `kernel.activate` or a
 * dependent pulls it in.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 *
 * @example
 * ```tsx
 * const { status, error, retry } = useModule(OrdersModule);
 * if (status === 'failed') return <Retry error={error} onRetry={retry} />;
 * ```
 */
export function useModule(ref: ModuleRef): ModuleState {
  const { kernel } = useKernelContext('useModule');

  const subscribe = useCallback(
    (onStoreChange: () => void): Unsubscribe => kernel.subscribeStatus(ref, onStoreChange),
    [kernel, ref],
  );
  const getSnapshot = useCallback((): ModuleStatus => kernel.status(ref), [kernel, ref]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const retry = useCallback((): void => {
    void kernel.retry(ref).catch(() => {
      // Swallowed: the failure is already retained, routed to the error
      // sinks and visible in `status`.
    });
  }, [kernel, ref]);

  // Only re-read on a transition — `inspect()` walks the whole graph.
  const error = useMemo(
    () => kernel.inspect().modules.find((module) => module.id === ref.id)?.error,
    [kernel, ref, status],
  );

  return useMemo(
    () => (error === undefined ? { status, retry } : { status, error, retry }),
    [status, error, retry],
  );
}
