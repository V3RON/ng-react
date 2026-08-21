// **C9 + the display order** — shared by this app's drawer and its dashboard
// screen.
//
// ---
//
// ### This is the third copy of the same comparison, exactly as #52 predicted
//
// `MenuEntry.order`'s doc comment in `@app/nav/contract` records that the
// `(order ?? Infinity, C5 index)` rule already existed twice — in
// `apps/react/src/shell/menu.tsx` and in `packages/dashboard/src/screen.web.tsx` —
// and that "issue #53's drawer will need it a third time". It does. The
// reason it still cannot be shared is unchanged and is worth restating so the
// next person does not spend an afternoon on it:
//
//  - **B2** allows a module contract to export only types, `createToken()`
//    calls and one `moduleRef()`, so a comparator function has no home in
//    `@app/nav/contract` or `@app/dashboard/contract`;
//  - spec §4 gives a module package exactly two subpath exports, so an
//    implementation file holding one is unreachable from outside the package;
//  - and `apps/react` and `apps/native` are separate workspace packages, so a
//    relative import between them is not available either.
//
// What *is* new here is the size of the cost, which is now measurable rather
// than hypothetical: this file is the third copy, and it is generic over both
// collections rather than written twice more, so the marginal cost of a
// *fourth* surface in this app is zero. Sharing it across hosts would mean
// turning it into a service behind a token — spec 03's call, not this PR's.
//
// It is a plain `.ts` file with no `react-native` import on purpose: that is
// what lets `ordering.test.ts` run in the node Vitest project with no
// renderer and no React Native in the path (acceptance criterion 7's
// environment, applied to app code).

import type { Kernel, Token } from '@ng-react/kernel';

/** The half of `MenuEntry`/`DashboardCard` this comparison actually reads. */
export interface Orderable {
  readonly id: string;
  readonly order?: number;
}

/** One row, paired with the owner the *kernel* assigned to it (**C9**). */
export interface OwnedRow<T> {
  readonly value: T;
  readonly owner: string;
}

/**
 * **C9 — the owners of one token's contributions, in C5 order.**
 *
 * `inspect().contributions` rows for a token arrive in the same order
 * `getAll`/`useServiceAll` returns its values in — C5's "module topological
 * order, declaration order within a module" — so position `i` of one aligns
 * with position `i` of the other. `DashboardCard` and `MenuEntry` carry no
 * `owner` field (C9: provenance is kernel-assigned and never passed by the
 * module), so this is the only place attribution can come from.
 *
 * **Generic in `T`, and that is ADR-10 rather than a style choice.** This
 * function reads nothing but `token.label`, so `Token<unknown>` looks like
 * the honest parameter type — and is not one: `Token<T>` is *invariant* in
 * `T`, so `Token<MenuEntry>` is not assignable to `Token<unknown>` and every
 * call site would fail to compile. `AnyToken` would work and is the erased
 * alias ADR-10 sanctions, but a plain type parameter needs no `any` at all.
 */
export function ownersOf<T>(kernel: Kernel, token: Token<T>): readonly string[] {
  return kernel
    .inspect()
    .contributions.filter((row) => row.token === token.label)
    .map((row) => row.owner);
}

/**
 * Pairs each value with its owner **and only then sorts**.
 *
 * The pairing has to happen before the sort, and that is the load-bearing
 * line of this file. The owner list is in C5 order; the display order is
 * `(order ?? Infinity, C5 index)`. Sorting first and indexing `owners[i]`
 * afterwards would attribute every row to whichever module happened to land
 * at its new position — a bug that is invisible while every module
 * contributes one row *and* every `order` agrees with the topology, which is
 * why `ordering.test.ts` asserts attribution with `order` values that
 * genuinely reorder the list.
 *
 * Entries without an `order` keep C5's order and sort after every entry that
 * has one; ties inside one `order` value fall back to C5, never to an
 * unstable comparison.
 */
export function ownedInDisplayOrder<T extends Orderable>(
  values: readonly T[],
  owners: readonly string[],
): readonly OwnedRow<T>[] {
  return values
    .map((value, index) => ({ value, owner: owners[index] ?? 'unknown', index }))
    .sort(
      (left, right) =>
        (left.value.order ?? Number.POSITIVE_INFINITY) -
          (right.value.order ?? Number.POSITIVE_INFINITY) || left.index - right.index,
    )
    .map(({ value, owner }) => ({ value, owner }));
}
