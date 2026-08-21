// `@app/nav/contract` — the navigation module's public surface (spec §4).
//
// **This package is acceptance criterion 10.** It is an *ordinary* module —
// no kernel privileges, no kernel changes, and nothing imported from
// `@ng-react/kernel` that a feature module could not import. Spec §14 says
// the navigation module (spec 03) is "built on the kernel primitives
// specified here (`kernel.activate`, `kernel.status`, reactive contribution
// collections C5, provenance C9) with no kernel changes anticipated"; this
// package is the check on that sentence before spec 03 is written.
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
// `ComponentType` is a *type-only* import, so this file still evaluates
// nothing and still costs a contract importer nothing.

import { createToken, moduleRef } from '@ng-react/kernel';
import type { ModuleRef, Unsubscribe } from '@ng-react/kernel';
import type { ComponentType } from 'react';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const NavModule = moduleRef('nav');

/**
 * One route, as a feature module declares it.
 *
 * **There is deliberately no `owner` field.** C9 is explicit that provenance
 * is "kernel-assigned at registration (derived from the activating
 * descriptor), **never passed by the module**" — a self-reported owner here
 * would be exactly the thing the kernel exists to prevent, and the navigator
 * reads the real one out of `kernel.inspect()` instead.
 *
 * `module` is the spec §6 seam: *"the navigation module (spec 03) activates a
 * module when a parent route config maps a matched path to its ref"*. A route
 * that names one is a **route-driven activation trigger**, translated by this
 * module into `kernel.activate(ref)` — the kernel itself has, and must keep,
 * no notion of routes.
 */
export interface RouteConfig {
  /** The exact path this route matches. The PoC matcher does no patterns. */
  readonly path: string;
  /** **Spec §6**: activate this module before rendering `component`. */
  readonly module?: ModuleRef;
  /** Rendered once the route matches and `module` (if any) is `ready`. */
  readonly component: ComponentType;
}

/**
 * The navigation module's own service: where we are, and how to go
 * elsewhere.
 *
 * Shaped as a `useSyncExternalStore` triple on purpose — `subscribe` returns
 * an `Unsubscribe` and `current` is referentially stable per location — so
 * the navigator needs no state of its own and no React-specific API leaks
 * into a service that a non-React host could reuse.
 */
export interface Router {
  /** The current path. Stable between navigations, so it is a valid store read. */
  current(): string;
  /** Navigates to `path`. A no-op when it is already the current path. */
  navigate(path: string): void;
  /** Notifies on every actual change of `current()`. Does not fire on subscribe. */
  subscribe(listener: () => void): Unsubscribe;
}

/**
 * **C5** — the primitive this whole module is built on. Feature modules
 * `contribute(RouteConfigToken, …)` from their own `providers` array; there
 * is no `contributions` descriptor field and spec §5.2 says there must not
 * be one.
 *
 * **C1**: `moduleId/Name` labels (ADR-8).
 */
export const RouteConfigToken = createToken<RouteConfig>('nav/RouteConfig');

/** The `Router` above, `singleton`-scoped for this module's activation. */
export const RouterToken = createToken<Router>('nav/Router');

/**
 * The root navigator component itself, handed out through the container.
 *
 * **Why a token and not a third subpath export.** Spec §4 gives a module
 * package *exactly two* public entry points, `./contract` and `./module`, and
 * an implementation file "is not exported and is therefore unreachable from
 * outside the package via the resolver". A React component is implementation.
 * So the app reaches the navigator the same way it reaches any other
 * capability a module owns — by resolving a token from this contract — rather
 * than by widening the package's public surface. That is also the honest
 * demonstration criterion 10 is after: a component is just another value the
 * container can carry, exactly as `RouteConfig.component` already is.
 */
export const NavigatorToken = createToken<ComponentType>('nav/Navigator');
