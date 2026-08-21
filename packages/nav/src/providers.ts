// `@app/nav` — provider declarations (spec §7.2).
//
// Implementation, reached only through `module.ts`'s thunk at activation
// (**D1**). Nothing here is exported from the package.
//
// **Note what is absent: any `contribute` call.** The navigation module owns
// `RouteConfigToken` and consumes its collection; it contributes nothing to
// it. Every route in the demo comes from somewhere else, which is what makes
// this a test of C5 rather than a table with extra steps.

import { provide, recordEvaluation } from '@ng-react/kernel';
import type { AnyProviderRecord, Unsubscribe } from '@ng-react/kernel';
import { NavigatorToken, RouterToken } from './contract';
import type { Router } from './contract';
import { RootNavigator } from './navigator';

// **Acceptance criterion 9** — proves this file was not evaluated before
// `nav`'s activation trigger.
recordEvaluation('nav', 'nav/providers.ts');

/** Where the demo starts. Exact-match, like every path in this PoC. */
const INITIAL_PATH = '/';

/**
 * An in-memory `Router`.
 *
 * **Deliberately not backed by `window.location` or the History API.** A
 * navigation module that reached for a browser global would be untestable
 * without a DOM and unusable on React Native — the platform the spec is
 * written for (§1) — and picking one host's location API is exactly the
 * decision spec 03 exists to make. The PoC's job is to show that the
 * *kernel* primitives suffice, so its location source is the smallest thing
 * that can be one.
 */
function createRouter(): Router {
  let path = INITIAL_PATH;
  const listeners = new Set<() => void>();

  return {
    current: () => path,
    navigate: (next) => {
      // No-op on an unchanged path: `useSyncExternalStore` would otherwise
      // be told the snapshot changed when `current()` still returns the same
      // string, which is a re-render for nothing.
      if (next === path) {
        return;
      }
      path = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  provide(RouterToken, {
    // **C2 + §17 (#34)**: `singleton` means one instance for as long as this
    // module's providers are registered. Deactivating `nav` throws the
    // current location away, which is the honest behaviour — a navigator
    // that is not running has no current route.
    scope: 'singleton',
    factory: () => createRouter(),
  }),

  provide(NavigatorToken, {
    // A component is a value like any other, and this one must be
    // referentially stable across renders or React would unmount and remount
    // the entire navigator every time the app re-rendered. `singleton` is
    // what makes that true, and **R2**'s referential-stability guarantee is
    // what lets a consumer rely on it.
    scope: 'singleton',
    factory: () => RootNavigator,
  }),
];
