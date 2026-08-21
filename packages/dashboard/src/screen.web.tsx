// `@app/dashboard` — the dashboard screen, **web implementation**.
//
// Implementation: not exported from the package (spec §4 gives a module
// package exactly two subpath exports), reached only through `providers.ts`,
// and therefore only after `dashboard` has activated (**D1**).
//
// =====================================================================
// THE PLATFORM DECISION (issue #52 §3) — one `contribute()`, two platforms
// =====================================================================
//
// **Decision: platform file extensions, resolved by the bundler and by
// `tsc`.** A module that owns a screen or a card writes it twice —
// `screen.web.tsx` and `screen.native.tsx` — and every *other* file in the
// package imports the extensionless `./screen`. There is exactly one
// `contribute(DashboardCardToken, { factory: () => ({ …, component }) })`
// call per contributing module, in one platform-agnostic `providers.ts`, and
// the `component` it carries is a DOM component on web and a React Native
// component on native because the resolver picked a different file.
//
// Four resolvers have to agree, and **only one of them does it for free**:
//
//  1. **Metro** (React Native, issue #53) — free. Metro's `--platform native`
//     resolution tries `screen.native.tsx` before `screen.tsx`. Nothing to
//     configure; this is the convention the shape is borrowed from.
//  2. **Vite** — `resolve.extensions` in `apps/react/vite.config.ts`, with
//     `.web.tsx`/`.web.ts` ahead of the defaults.
//  3. **Vitest** — the same list again in `vitest.config.ts`, per project.
//     Vitest does not read the app's `vite.config.ts`.
//  4. **`tsc`** — `moduleSuffixes: ['.web', '']` in `tsconfig.base.json`.
//     This is the one the issue predicted would bite, and it did, twice:
//     `moduleSuffixes` is not widely used with `moduleResolution: 'bundler'`
//     (it works — verified by removing it and watching TS2307 appear), and
//     **`eslint-import-resolver-typescript` ignores it entirely**, so
//     `import-x/no-unresolved` reported `./screen` unresolved with a
//     perfectly green `tsc`. That needed a fifth agreement, in the boundary
//     preset's own resolver — see `packages/eslint-config-modules/src/index.js`.
//
// **Why not two contributions (metadata here, component there)?** That is the
// alternative the issue invites, and it does not survive contact with the
// same problem: the platform-specific *component* still has to be selected
// per platform, so the file holding the second `contribute()` call would need
// to be `providers.web.ts` / `providers.native.ts` — the identical resolution
// mechanism, one level up, plus a second collection to join by id, plus a
// class of bug where a module ships a card with no component (or a component
// with no card) and neither the kernel nor the dashboard can tell. The only
// version that avoids platform resolution altogether is one where the *app*
// registers each module's component, and that trades the whole property this
// task exists to demonstrate — the dashboard, and the composition root, must
// not know which modules exist — for a config file. Rejected on principle 5
// (one way to do a thing) and principle 1.
//
// **What this file does not prove.** The native half is not exercised here:
// there is no React Native in this workspace, so `screen.native.tsx` is a
// placeholder that compiles as plain React (see its header). What *is*
// proven, by `apps/react/src/shell/dashboard.test.tsx`, is that a
// `.native.tsx` file exists beside this one and that the web build, the web
// typecheck and the web test run all pick *this* file — a test that fails if
// the wrong one is picked. Issue #53 owns the other half.

import { useKernel, useServiceAll } from '@ng-react/kernel';
import type { ReactElement } from 'react';
import { DashboardCardToken } from './contract';
// **C9 pairing and the display sort live in `./ordering`**, imported by this
// file and by `screen.native.tsx`. Issue #53 lifted them there rather than
// letting the native screen re-derive them; that file carries the reasoning.
import { orderedCards } from './ordering';

/**
 * **R3/C5** — the dashboard is, at its core, `useServiceAll(DashboardCardToken)`.
 *
 * Spec §12 R3 says that of the navigator; it is just as true here, and that
 * is the point of adding a second surface: the primitive, not the navigator,
 * is what subsystem modules are built on. A module activating adds its card
 * and a module being disposed or quarantined (**F3**) withdraws it, with no
 * registry in this package to keep in step and no knowledge of which modules
 * exist.
 */
export function DashboardScreen(): ReactElement {
  const kernel = useKernel();
  const cards = useServiceAll(DashboardCardToken);
  const owners = kernel
    .inspect()
    .contributions.filter((row) => row.token === DashboardCardToken.label)
    .map((row) => row.owner);

  const ordered = orderedCards(cards, owners);

  return (
    <section aria-labelledby="dashboard-heading" data-testid="dashboard" data-platform="web">
      <h3 id="dashboard-heading">Dashboard</h3>
      <p className="note">
        C5: one card per contributing module, from <code>useServiceAll(dashboard/DashboardCard)</code>.
        Cards appear when a module activates and are withdrawn when it is disposed or quarantined —{' '}
        <code>debug</code> has no card for exactly that second reason (F3), and this package
        contains no code that knows <code>debug</code> exists.
      </p>
      <ul data-testid="dashboard-cards">
        {ordered.map(({ card, owner }) => (
          <li key={card.id} data-testid={`dashboard-card-${card.id}`} data-owner={owner}>
            <h4>{card.title}</h4>
            <small>
              contributed by <code>{owner}</code>
            </small>
            <card.component />
          </li>
        ))}
      </ul>
      {ordered.length === 0 ? (
        <p data-testid="dashboard-empty">No cards — nothing that contributes one is active.</p>
      ) : null}
    </section>
  );
}
