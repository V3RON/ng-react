// `ordering.ts` — the pairing and the sort the drawer applies to the menu
// collection.
//
// Node environment, no renderer, and this file imports nothing that imports
// `react-native`: the whole point of `ordering.ts` being a plain `.ts` module
// is that the platform-neutral half of the drawer is testable without one.

import { ownedInDisplayOrder } from './ordering';
import type { Orderable } from './ordering';

/** Realistically shaped rows, differently ordered from their C5 order. */
interface Entry extends Orderable {
  readonly title: string;
}

describe('ownedInDisplayOrder', () => {
  it('C9: pairs each row with its owner before sorting, so a reordering sort cannot misattribute', () => {
    // **The mutation this test exists for**: pairing *after* the sort.
    // `payments` is first in C5 order and last in display order, so an
    // implementation that sorted first and then indexed `owners[i]` would
    // attribute `Payments` to `orders` and `Orders` to `payments` — and would
    // pass every membership-shaped assertion about the same two rows being
    // present. Both surfaces in this repository sort for display, so both have
    // to get this right, and #52's mutations B and C are the same check on the
    // web menu and the web dashboard.
    const values: readonly Entry[] = [
      { id: 'payments/drafts', title: 'Payments', order: 20 },
      { id: 'orders/detail', title: 'Orders', order: 10 },
    ];
    const owners = ['payments', 'orders'];

    expect(ownedInDisplayOrder(values, owners)).toEqual([
      { value: values[1], owner: 'orders' },
      { value: values[0], owner: 'payments' },
    ]);
  });

  it('sorts by (order ?? Infinity, C5 index): a tie falls back to C5 and no order sorts last', () => {
    // Three distinct cases in one list, because two of them only differ when
    // the third is present: `beta/tied` ties with `alpha/first` and must lose
    // to it on C5 index; `alpha/late` has no `order` at all and must sort after
    // both despite being second in C5's order.
    const values: readonly Entry[] = [
      { id: 'alpha/first', title: 'Alpha', order: 5 },
      { id: 'alpha/late', title: 'Late' },
      { id: 'beta/tied', title: 'Beta', order: 5 },
    ];
    const owners = ['alpha', 'alpha', 'beta'];

    expect(ownedInDisplayOrder(values, owners).map((row) => `${row.owner}:${row.value.id}`)).toEqual(
      ['alpha:alpha/first', 'beta:beta/tied', 'alpha:alpha/late'],
    );
  });

  it('falls back to "unknown" rather than to a neighbour when the owner list is short', () => {
    // A short owner list means the positional alignment between
    // `inspect().contributions` and `getAll` has drifted — `HANDOFF.md` §6
    // records that the kernel exposes no per-contribution identity to align on
    // instead. Rendering `unknown` is the honest outcome; silently shifting
    // every later row up by one would attribute rows to the wrong module and
    // look correct.
    const values: readonly Entry[] = [
      { id: 'a/one', title: 'One', order: 1 },
      { id: 'b/two', title: 'Two', order: 2 },
    ];
    expect(ownedInDisplayOrder(values, ['a']).map((row) => row.owner)).toEqual(['a', 'unknown']);
  });

  it('is a pure function of its arguments: an empty collection is an empty list, not a throw', () => {
    // The drawer renders before any module has contributed (the eager
    // activation pass is asynchronous), so this is the first state the app is
    // ever in rather than an edge case.
    expect(ownedInDisplayOrder([], [])).toEqual([]);
  });
});
