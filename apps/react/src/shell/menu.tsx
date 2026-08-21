// The demo's hamburger menu — **C5/R3**, on the collection `@app/nav` owns.
//
// **App chrome, not a module.** The menu lives here rather than in
// `@app/nav` because a hamburger is a *host* decision: issue #53's native app
// renders the same `MenuEntryToken` collection as a React Navigation drawer,
// which builds its own rows and has no use for a component we hand it. What
// crosses the boundary is therefore the data — `MenuEntry` carries no
// `component` field — and each host renders it its own way. That is also why
// this file is plain `.tsx` and not `menu.web.tsx`: it is already inside the
// web app, so there is nothing to select between.
//
// **B1**: this file imports `<pkg>/contract` and nothing else.
//
// No UI framework and no new dependency: `<details>`/`<summary>` is a
// disclosure widget the browser already implements, keyboard-accessible and
// screen-reader-labelled without a line of JavaScript. A hand-rolled
// `useState` toggle would be more code and less accessible.

import type { ReactElement } from 'react';
import { useKernel, useService, useServiceAll } from '@ng-react/kernel';
import type { Kernel } from '@ng-react/kernel';
import { MenuEntryToken, RouterToken } from '@app/nav/contract';
import type { MenuEntry } from '@app/nav/contract';

/**
 * **C9** — the owner of each entry, asked of the kernel rather than of the
 * entry, and **paired before the sort rather than after**.
 *
 * `inspect().contributions` for one token is positionally aligned with
 * `useServiceAll`'s values (C5's "module topological order, declaration order
 * within a module"). Sorting the entries and then indexing `owners[i]` would
 * attribute each row to whichever module happened to land at its new
 * position — a bug that is invisible while every module contributes one entry
 * and every `order` happens to agree with the topology, which is why
 * `menu.test.tsx` asserts attribution against an `order` that genuinely
 * reorders the list.
 *
 * The comparison itself is `(order ?? Infinity, C5 index)`; `MenuEntry.order`
 * documents why C5's own order is not enough for a surface a person reads top
 * to bottom, and records that this comparison is duplicated by the dashboard's
 * screen and cannot be shared without turning it into a service (B2).
 */
function orderedEntries(
  entries: readonly MenuEntry[],
  kernel: Kernel,
): readonly { readonly entry: MenuEntry; readonly owner: string }[] {
  const owners = kernel
    .inspect()
    .contributions.filter((row) => row.token === MenuEntryToken.label)
    .map((row) => row.owner);

  return entries
    .map((entry, index) => ({ entry, owner: owners[index] ?? 'unknown', index }))
    .sort(
      (left, right) =>
        (left.entry.order ?? Number.POSITIVE_INFINITY) -
          (right.entry.order ?? Number.POSITIVE_INFINITY) || left.index - right.index,
    )
    .map(({ entry, owner }) => ({ entry, owner }));
}

/**
 * The menu itself.
 *
 * Rendered only while `nav` is active — see `App.tsx`, which pairs
 * `useServiceOptional(NavigatorToken)` with `useModule(NavModule)` for the
 * known re-render gap. `useService(RouterToken)` here is therefore safe: this
 * component does not exist unless `nav` does.
 */
export function AppMenu(): ReactElement {
  const kernel = useKernel();
  const router = useService(RouterToken);
  // **R3/C5** — the whole menu, and nothing else. Rows appear when a module
  // activates and are withdrawn when it is disposed or quarantined (**F3**),
  // with no menu registry here to keep in step.
  const entries = useServiceAll(MenuEntryToken);
  const ordered = orderedEntries(entries, kernel);

  return (
    <nav aria-label="Main menu" data-testid="app-menu">
      <details>
        <summary data-testid="app-menu-toggle">
          Menu ({String(ordered.length)})
        </summary>
        <ul data-testid="app-menu-items">
          {ordered.map(({ entry, owner }) => (
            <li key={entry.id}>
              <button
                type="button"
                data-testid={`menu-item-${entry.id}`}
                data-owner={owner}
                onClick={() => {
                  router.navigate(entry.path);
                }}
              >
                {entry.title}
              </button>{' '}
              <small>
                <code>{entry.path}</code> · contributed by <code>{owner}</code>
              </small>
            </li>
          ))}
        </ul>
      </details>
      <p className="note">
        C5: <code>useServiceAll(nav/MenuEntry)</code>. Activating a module adds its item; logout
        withdraws it. Attribution comes from <code>kernel.inspect()</code> (C9), never from the
        entry.
      </p>
    </nav>
  );
}
