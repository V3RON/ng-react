// **C9 attribution + the display order**, shared by this module's two screens.
//
// Lifted out of `screen.web.tsx` by issue #53, which is what
// `screen.native.tsx`'s own checklist asked for: "the hooks, the C9 owner
// pairing and the `(order ?? Infinity, C5 index)` sort are all
// platform-neutral and should be **lifted, not re-derived**". Writing the
// comparison a second time inside this package would have made the count of
// copies four; it is three.
//
// **It can live here because it never leaves the package.** `MenuEntry.order`
// records why the same comparison cannot be shared *across* packages — **B2**
// allows a contract to export only types, `createToken()` calls and one
// `moduleRef()`, and spec §4 gives a module package exactly two subpath
// exports — and neither of those says anything about an implementation file
// imported by two other implementation files in the same package. This is a
// third file behind the same two entry points, not a third entry point.
//
// A plain `.ts` file with no `react` and no `react-native` import on purpose:
// it is the half of both screens that has no platform, which is exactly why it
// is the half that can be shared.

import type { DashboardCard } from './contract';

/** One card, paired with the owner the *kernel* assigned to it. */
export interface OwnedCard {
  readonly card: DashboardCard;
  readonly owner: string;
}

/**
 * **C9 — who contributed each card, asked of the kernel rather than of the
 * card, and paired before the sort rather than after.**
 *
 * `DashboardCard` carries no owner (see the contract), so attribution comes
 * from `kernel.inspect().contributions`, which C9 requires be derived from the
 * activating descriptor. The rows for one token arrive in the same order
 * `useServiceAll` returns its values in — C5's "module topological order,
 * declaration order within a module" — so position `i` of one aligns with
 * position `i` of the other.
 *
 * **The pairing therefore happens before the sort, never after.** The card
 * order a person reads is `(order ?? Infinity, C5 index)`; the owner index is
 * C5's. Sorting the cards and then indexing `owners[i]` would attribute every
 * card to whichever module happens to sit at its new position — a bug that is
 * invisible while every module contributes one card, which is why
 * `apps/react/src/shell/dashboard.test.tsx` asserts attribution with `order`
 * values that actually reorder the list.
 */
export function orderedCards(
  cards: readonly DashboardCard[],
  owners: readonly string[],
): readonly OwnedCard[] {
  return cards
    .map((card, index) => ({ card, owner: owners[index] ?? 'unknown', index }))
    .sort(
      (left, right) =>
        (left.card.order ?? Number.POSITIVE_INFINITY) -
          (right.card.order ?? Number.POSITIVE_INFINITY) || left.index - right.index,
    )
    .map(({ card, owner }) => ({ card, owner }));
}
