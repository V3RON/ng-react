// **R2 / R3 / H6** — the three consumer hooks: `useService`,
// `useServiceAll`, `useModule` (plus `useServiceOptional`).
//
// Every one of them is a `useSyncExternalStore` over a kernel subscription,
// which is what makes them correct under React 18/19 concurrent rendering:
// a store read during a transition cannot tear, and StrictMode's
// mount/unmount/remount is safe because every kernel `Unsubscribe` in this
// package is idempotent and every `subscribe` is symmetric.
//
// **The one rule that governs this file**: `getSnapshot` runs on *every*
// render, not only after a notification, so it must return a referentially
// stable value or React re-renders forever. Two consequences:
//
//  - `useService`/`useServiceOptional` snapshot the **epoch number**, never
//    the resolved instance, and re-resolve in a `useMemo` keyed by it. A
//    number is stable by construction; a `transient` provider snapshotted
//    directly would be a fresh object on every call — an instant loop.
//  - `useServiceAll` caches the collection array and replaces it only when
//    the contribution set actually changed. C5 already promises that a
//    value-equal collection does not *notify*, but that is not enough on
//    its own: nothing stops React from calling `getSnapshot` between
//    notifications, and a fresh `getAll()` array each time would loop.
//
// ADR-6: `src/react/**` is the only place that may import `react`.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useKernelContext, useModuleScope } from './context';
import type { Kernel } from '../kernel/kernel';
import type { ModuleRef } from '../module-ref';
import { MODULE_ID } from '../token';
import type { AnyToken, Token } from '../token';
import type { ModuleStatus, Unsubscribe } from '../types';

/**
 * Dev-only gate for the transient warning (R2). Same probe as
 * `kernel.ts`'s `DEV_BY_DEFAULT`: read through `globalThis`, because
 * `process` may not exist at all in a browser or under React Native.
 *
 * Deliberately *not* `kernel.dev`: `dev` is a field on the internal
 * `KernelImpl`, not on the public `Kernel` interface, and widening that
 * interface for a `console.warn` is not a trade this task should make.
 */
const IS_DEV: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] !== 'production';

/**
 * **H6**: subscribes to the resolution epoch of `moduleId` and returns its
 * current value.
 *
 * `moduleId` is the **provider's owning module** (`kernel.ownerOf`), per
 * H6 — not the consuming component's module scope. A component in `orders`'
 * screen holding a `payments`-owned instance must re-render when *payments*
 * reloads, and `payments` is the module whose epoch moves.
 *
 * `undefined` subscribes to the global epoch. That is the honest fallback
 * when the token has no single owning module — nothing provides it yet
 * (`useServiceOptional`), or it is a contribution token, for which
 * `ownerOf` is `undefined` by design. A superset of the right
 * notifications; never a missed one.
 */
function useEpoch(kernel: Kernel, moduleId: string | undefined): number {
  const subscribe = useCallback(
    (onStoreChange: () => void): Unsubscribe => kernel.subscribeEpoch(moduleId, onStoreChange),
    [kernel, moduleId],
  );
  // A number: referentially stable by construction, so `getSnapshot` can be
  // called on every render (and as the server snapshot) without looping.
  const getSnapshot = useCallback((): number => kernel.epochOf(moduleId), [kernel, moduleId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * **R2**: emits the transient `console.warn`, at most once per token per
 * `<AppKernel>`.
 *
 * Spec §12 R2 makes "`transient` in components" a *lint* warning, and
 * `ng-react-modules/no-transient-in-component` (already merged, #28) is
 * that rule. This is not a second way to do the same thing: that rule
 * documents, at the top of its own source, that it can only flag a
 * `useService(Token)` whose `provide(Token, { scope: 'transient' })` is in
 * the *same file* — which in real code it almost never is. The runtime
 * check sees the registry, so it catches exactly the cross-file case static
 * analysis cannot, and it names the blessed alternative rather than just
 * complaining.
 *
 * In an effect, not in render: render must stay free of side effects under
 * concurrent rendering, and `kernel.inspect()` is far too expensive to run
 * on every render of every consumer. `warnedTransientTokens` is the
 * `<AppKernel>`-scoped set from `context.tsx` — see the note there on why
 * this must not be module-level state.
 *
 * Scope lookup goes through `inspect()` because that is the only public
 * surface carrying a provider's scope, and its rows are keyed by the
 * token's *label*. Narrowing by `owner` first (from `ownerOf`, which is
 * token-identity keyed) makes a false positive need two distinct tokens
 * with the same label provided by the same module — and the cost of one
 * would be a spurious dev warning, never a behaviour change.
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
 * **R2**: resolves `token` through the kernel's container, on behalf of the
 * module owning the enclosing `<ModuleScope>` (ADR-2's `'app'` outside any).
 *
 * **Referential stability** for `singleton` and `module` scopes comes from
 * the container's own instance cache, not from the `useMemo` below — C2
 * says one instance per app lifetime / per activation, so two calls in two
 * renders are `Object.is`-identical whether or not React kept the memo. The
 * memo exists to make the *epoch* a dependency (H6), so a re-activation
 * re-resolves.
 *
 * **C8 errors reach the caller unchanged.** There is no `try` on this path:
 * a failed resolution throws the container's `ResolutionError` verbatim,
 * message and all, out of the component's render. That message — the full
 * resolution chain plus the `dependsOn` suggestion — is the whole point of
 * C8, and a binding that wrapped it in "failed to resolve service" would
 * destroy the feature.
 */
export function useService<T>(token: Token<T>): T {
  const { kernel, warnedTransientTokens } = useKernelContext('useService');
  const requester = useModuleScope();
  const owner = kernel.ownerOf(token);
  const epoch = useEpoch(kernel, owner);
  useTransientWarning(kernel, token, owner, warnedTransientTokens);
  // `epoch` is a dependency, not an input: H6's re-resolution is exactly
  // "throw away the memo when the owning module reloads".
  return useMemo(() => kernel.get(token, requester), [kernel, token, requester, epoch]);
}

/**
 * **R2**: `useService` for a token that may have no provider — `undefined`
 * instead of a C8 error.
 *
 * "No provider" is decided with `kernel.ownerOf`, which is the *same*
 * registry check `optional(token)` performs (§7.3), so this hook and
 * `deps: [optional(token)]` can never disagree. It follows that an error
 * thrown by a factory that *was* found still propagates: only the
 * found-or-not question is optional here.
 *
 * `MODULE_ID` is the one contextual token with no registry entry, and
 * `optional(MODULE_ID)` still yields the requester; this hook matches.
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
 * `getSnapshot` hands back the *same array* until the contribution set
 * actually changes. `refresh` is the single place that decides "changed",
 * and it compares element-wise: C5's notification is already suppressed for
 * a value-equal collection, so the comparison is belt-and-braces — but it
 * is what makes `subscribe` able to catch up on changes missed while
 * unsubscribed (StrictMode unmounts and remounts) *without* handing React a
 * fresh, equal array and forcing a pointless re-render.
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
      // Catch up first: between an unsubscribe and the next subscribe (a
      // StrictMode remount, or a token/kernel change) notifications are not
      // delivered, so a stale cached array would survive. Value-equal
      // results keep the existing reference.
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

/** Element-wise identity comparison — C5 collections are ordered (topological). */
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
 * **R3**: the full reactive contribution collection for `token` (C5), in
 * module topological order, re-rendering when the contribution set changes
 * — module activation, disposal, or F3 quarantine.
 *
 * This is the render-side primitive spec 03 is built on: the navigation
 * module's root navigator is, at its core, `useServiceAll(RouteConfigToken)`.
 *
 * **No epoch subscription, and that is deliberate — see the PR body.** H6's
 * wording ("subscribe to the epoch of the provider's module") has no
 * meaning for a collection: it has N owners, `ownerOf` returns `undefined`
 * for a contribution token by design, and the set of owners is itself what
 * changes. `subscribeAll` already covers the case H6 exists for, exactly: a
 * module re-activation is a `withdraw` followed by a `register`, both of
 * which mutate the contribution records and therefore notify, and the
 * replacement records resolve to the fresh instances. Adding an epoch
 * subscription on top would be a second, weaker path to the same signal.
 */
export function useServiceAll<T>(token: Token<T>): readonly T[] {
  const { kernel } = useKernelContext('useServiceAll');
  const store = useMemo(() => createCollectionStore(kernel, token), [kernel, token]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** **R3**: what `useModule` reports about one module. */
export interface ModuleState {
  /** A2: the module's current lifecycle state. */
  readonly status: ModuleStatus;
  /**
   * F1: the retained failure of a `failed` module, as the kernel describes
   * it in `inspect()` (`{ name, message, code }`). `unknown` because a
   * consumer should render it, not branch on it.
   */
  readonly error?: unknown;
  /** F3: re-attempts activation from a clean slate. Referentially stable. */
  readonly retry: () => void;
}

/**
 * **R3**: `ref`'s status, its retained failure, and F3's `retry`,
 * re-rendering on every status transition.
 *
 * **This hook does not trigger activation**, and must not: spec §6 says
 * activation is explicit (`kernel.activate`) or dependency-driven, and the
 * kernel deliberately has no other trigger. A `lazy` module observed
 * through `useModule` stays `registered` until something activates it —
 * rendering a status indicator is not a reason to start a module.
 *
 * `retry` is `useCallback`-stable across renders (it closes over nothing
 * that changes), so a consumer may pass it straight to a `<button>` without
 * re-rendering the subtree on every status change. It discards the promise
 * `kernel.retry` returns: a retry that fails re-quarantines the module,
 * reports through the F4 sinks and shows up in `status` — rethrowing into
 * an unhandled rejection would add nothing and crash the app.
 */
export function useModule(ref: ModuleRef): ModuleState {
  const { kernel } = useKernelContext('useModule');

  const subscribe = useCallback(
    (onStoreChange: () => void): Unsubscribe => kernel.subscribeStatus(ref, onStoreChange),
    [kernel, ref],
  );
  // A `ModuleStatus` is a string union — stable by construction.
  const getSnapshot = useCallback((): ModuleStatus => kernel.status(ref), [kernel, ref]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const retry = useCallback((): void => {
    void kernel.retry(ref).catch(() => {
      // Intentionally swallowed: see the doc comment. The failure is
      // already retained (F1), routed to the error sinks (F4) and visible
      // in `status`.
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
