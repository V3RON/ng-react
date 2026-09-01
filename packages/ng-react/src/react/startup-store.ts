// The external store `useKernelStartup` subscribes to. Kept free of `react`
// so that `context.tsx` can own one instance per `<AppKernel>` without an
// import cycle.

import { IS_DEV } from './dev';
import type { Kernel } from '../kernel/kernel';
import type { Unsubscribe } from '../types';

/**
 * The state of a kernel's startup: still running, finished, or failed with
 * the error that stopped it.
 *
 * A union rather than an optional `error` field, so `state.error` does not
 * type-check until `state.status === 'failed'` has been checked.
 */
export type KernelStartupState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly error: unknown };

// Shared singletons: `getSnapshot` runs on every render, so its result has to
// be referentially stable. The `failed` state carries an error and is built
// once, on settle.
const PENDING: KernelStartupState = { status: 'pending' };
const READY: KernelStartupState = { status: 'ready' };

/** The `useSyncExternalStore` surface one `<AppKernel>` publishes for startup. */
export interface KernelStartupStore {
  getSnapshot(): KernelStartupState;
  subscribe(onStoreChange: () => void): Unsubscribe;
}

/**
 * Builds the startup store for `kernel`.
 *
 * Nothing is attached to `kernel.whenStartupComplete()` until the first
 * subscriber arrives, so an `<AppKernel>` whose tree never asks about startup
 * observes it not at all. Both settlement paths are observed: the state
 * becomes `failed` when startup rejects, never staying `pending`.
 *
 * @returns A store whose snapshot moves from `pending` to `ready` or `failed`
 *   exactly once.
 */
export function createKernelStartupStore(kernel: Kernel): KernelStartupStore {
  let state: KernelStartupState = PENDING;
  let started = false;
  const listeners = new Set<() => void>();

  const settle = (next: KernelStartupState): void => {
    if (state.status !== 'pending') {
      return;
    }
    state = next;
    // Copied: a listener that unsubscribes while being notified must not
    // shorten the iteration for the ones after it.
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const start = (): void => {
    if (started) {
      return;
    }
    started = true;
    warnIfNothingIsGated(kernel);
    kernel.whenStartupComplete().then(
      () => {
        settle(READY);
      },
      (error: unknown) => {
        settle({ status: 'failed', error });
      },
    );
  };

  return {
    getSnapshot: (): KernelStartupState => state,
    subscribe: (onStoreChange: () => void): Unsubscribe => {
      listeners.add(onStoreChange);
      start();
      return () => {
        listeners.delete(onStoreChange);
      };
    },
  };
}

/**
 * Warns, in dev only, when the kernel has no module for startup to wait on.
 *
 * `whenStartupComplete()` waits on critical modules in the activation closure
 * of every eager module. With none, it resolves immediately and anything gated
 * on it opens before a module has finished activating.
 */
function warnIfNothingIsGated(kernel: Kernel): void {
  if (!IS_DEV) {
    return;
  }
  const modules = kernel.inspect().modules;
  const byId = new Map(modules.map((module) => [module.id, module]));
  const startupModuleIds = new Set(
    modules.filter((module) => module.load === 'eager').map((module) => module.id),
  );
  const pending = [...startupModuleIds];
  for (const moduleId of pending) {
    for (const dependencyId of byId.get(moduleId)?.dependsOn ?? []) {
      if (!startupModuleIds.has(dependencyId)) {
        startupModuleIds.add(dependencyId);
        pending.push(dependencyId);
      }
    }
  }
  if (modules.some((module) => module.critical && startupModuleIds.has(module.id))) {
    return;
  }
  console.warn(
    'useKernelStartup(): no critical module is in the startup activation closure, so ' +
      'kernel.whenStartupComplete() resolves immediately and this gate opens before any module ' +
      'has finished activating. Mark the modules first paint depends on critical: true. ' +
      'A critical lazy dependency pulled in by an eager module also participates in the gate.',
  );
}
