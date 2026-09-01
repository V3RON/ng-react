import type { ModuleStatus } from '@ng-react/kernel';

/**
 * Whether merely rendering a module route should trigger its activation.
 *
 * `disposed` is intentionally excluded: deactivation cascades update module
 * statuses one at a time, and an offscreen route must not reactivate a
 * dependent while its dependency is still being torn down. Reactivation is
 * an explicit user action in the drawer.
 */
export function shouldActivateFromRoute(status: ModuleStatus): boolean {
  return status === 'registered';
}
