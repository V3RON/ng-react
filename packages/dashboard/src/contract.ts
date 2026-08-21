// `@app/dashboard/contract` — the module's public surface (spec §4).
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
// `ComponentType` is a *type-only* import, so this file still evaluates
// nothing and still costs a contract importer nothing.
//
// `dashboard` is an **ordinary module**. It owns a collection token, renders
// the collection, and has no kernel privileges of any kind — the same claim
// `@app/nav` makes for routing (acceptance criterion 10), made a second time
// for a second surface. It does not know which modules exist, and nothing in
// this workspace tells it.

import { createToken, moduleRef } from '@ng-react/kernel';
import type { ComponentType } from 'react';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const DashboardModule = moduleRef('dashboard');

/**
 * One dashboard card, as a feature module declares it.
 *
 * **No `owner` field** — C9: provenance is kernel-assigned at registration
 * and "never passed by the module". The screen reads the real owner out of
 * `kernel.inspect().contributions`, aligned by position with the collection,
 * exactly as `@app/nav`'s navigator already does for routes.
 */
export interface DashboardCard {
  /** Stable across renders and re-activations: the React key, and what tests name. */
  readonly id: string;
  /** The card's heading. */
  readonly title: string;
  /**
   * Sorted by `(order ?? Infinity, C5 order)` — see `MenuEntry.order` in
   * `@app/nav/contract` for why C5's own order is not enough for a surface a
   * person reads top to bottom.
   */
  readonly order?: number;
  /**
   * The card's body.
   *
   * **This is the field the platform decision is about** (issue #52 §3). A
   * `ComponentType` is a DOM component on web and a React Native component on
   * native, and the *same* `contribute()` call has to yield both. It does,
   * because the contributing module imports it from `./screen` and the
   * bundler picks `screen.web.tsx` or `screen.native.tsx` — Metro by its own
   * platform-extension resolution, Vite via `resolve.extensions`, and `tsc`
   * via `moduleSuffixes`. See the header of
   * `packages/dashboard/src/screen.web.tsx` for the full decision and its
   * alternatives.
   *
   * It is a `ComponentType` and not, say, a `describe(): string`, because a
   * card that could only ever render a string would make the platform
   * question disappear by making the surface useless — and answering that
   * question is the point of this task.
   */
  readonly component: ComponentType;
}

/**
 * **C5** — the dashboard collection. Owned here, contributed to by feature
 * modules, withdrawn by the kernel when a module is disposed or quarantined
 * (**F3**) with no code in this package involved. That last property is what
 * `debug`'s missing card demonstrates in the demo app.
 *
 * **C1**: `moduleId/Name` labels (ADR-8).
 */
export const DashboardCardToken = createToken<DashboardCard>('dashboard/DashboardCard');
