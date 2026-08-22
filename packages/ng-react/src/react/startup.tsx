// `useKernelStartup` is the primitive here; `<KernelStartupGate>` is a call
// to it and a three-way branch.

import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useKernelContext } from './context';
import type { KernelStartupState } from './startup-store';

/**
 * Returns the startup state of the kernel provided by the enclosing
 * `<AppKernel>`, re-rendering when it settles: `pending`, then `ready` or
 * `failed`.
 *
 * Startup waits for critical modules in every eager module's transitive
 * activation closure. A non-critical module may still be activating, or
 * already quarantined, when this reports `ready`; to put a module inside the
 * gate, mark it `critical: true` and make it part of that closure.
 *
 * `failed` carries the error that stopped startup, unwrapped. It is reached
 * whenever a startup-critical module cannot become ready, so a consumer that
 * handles only `ready` leaves the app on its loading screen for good.
 *
 * Startup settles once per kernel. There is no retry: `useModule(ref)` offers
 * a per-module one, and recovering from a failed startup means building a new
 * kernel.
 *
 * @throws {KernelError} When called outside an `<AppKernel>`.
 *
 * @example Hiding a native splash screen once startup settles, either way.
 * ```tsx
 * const startup = useKernelStartup();
 * useEffect(() => {
 *   if (startup.status !== 'pending') void SplashScreen.hideAsync();
 * }, [startup.status]);
 * ```
 */
export function useKernelStartup(): KernelStartupState {
  const { startup } = useKernelContext('useKernelStartup');
  return useSyncExternalStore(startup.subscribe, startup.getSnapshot, startup.getSnapshot);
}

/** What `<KernelStartupGate>` takes. */
export interface KernelStartupGateProps {
  /** Rendered once startup is ready, and at no other time. */
  readonly children: ReactNode;
  /**
   * Rendered while startup is still running.
   *
   * @default null — which is what a native app wants while its own splash
   *   screen is still up.
   */
  readonly fallback?: ReactNode;
  /**
   * Rendered when startup failed, with the error that stopped it. The
   * `fallback` is not rendered in this case.
   *
   * Required: a gate that renders nothing for a failed startup shows its
   * loading state for good, and that is the failure this component exists to
   * prevent.
   */
  readonly renderFailure: (error: unknown) => ReactNode;
}

/**
 * Renders `fallback` while the kernel's startup-critical modules are starting,
 * `children` once they are ready, and `renderFailure(error)` if one cannot be.
 *
 * Reach for `useKernelStartup()` instead when startup settling has to *do*
 * something — hide a native splash screen, log, report — rather than only
 * render. This component takes no callback for that.
 *
 * See `useKernelStartup()` for what startup does and does not wait for.
 *
 * @throws {KernelError} When rendered outside an `<AppKernel>`.
 *
 * @example
 * ```tsx
 * <KernelStartupGate fallback={<Splash />} renderFailure={(e) => <StartupFailed error={e} />}>
 *   <App />
 * </KernelStartupGate>
 * ```
 */
export function KernelStartupGate(props: KernelStartupGateProps): ReactNode {
  const startup = useKernelStartup();
  if (startup.status === 'pending') {
    return props.fallback ?? null;
  }
  if (startup.status === 'failed') {
    return props.renderFailure(startup.error);
  }
  return props.children;
}
