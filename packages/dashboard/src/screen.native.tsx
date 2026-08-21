// `@app/dashboard` — the dashboard screen, **React Native implementation**.
//
// Read `screen.web.tsx`'s header first: it carries the platform decision this
// file is the other half of. This file is that decision's other half made
// real — it was a documented placeholder until issue #53, and the checklist it
// carried is discharged as follows:
//
//  1. **`react-native` added to this package's `dependencies`.** Not
//     `devDependencies`: this file is reached at runtime by anything that
//     activates `dashboard` on a native host, so the dependency is a real one.
//     No `@types/react-native` — React Native 0.86 ships its own types.
//  2. **The body is `<View>`/`<Text>`**, and the platform-neutral half —
//     the hooks, the C9 owner pairing, the `(order ?? Infinity, C5 index)`
//     sort — was **lifted into `./ordering`** rather than re-derived, so the
//     comparison exists once per package rather than once per platform.
//  3. **`apps/native/tsconfig.json` carries `moduleSuffixes: [".native", ""]`**,
//     which is what makes `providers.ts`'s `./screen` resolve here.
//  4. **What the *web* `tsc` does with this file, decided:** it type-checks
//     it, `react-native` types and all. The checklist offered two options —
//     a root `react-native` dependency purely for types, or excluding
//     `**/*.native.tsx` from every web `tsconfig.json` — and called the second
//     "cheaper, and a hole". It is the hole that decides it: excluding these
//     files would mean nothing type-checks them until the native app's own
//     `tsc` runs, and this package's `tsconfig.json` is what `pnpm -r
//     typecheck` runs. So `react-native` is a real dependency of this package
//     and `packages/dashboard/tsconfig.json` is unchanged: the web `tsc`
//     compiles this file with `lib: [… "DOM"]` and the *native* program in
//     `apps/native` compiles it again with `lib: ["ES2022"]` and no DOM.
//     **Both must pass**, which is stricter than either alone and is what
//     catches a `document.` in a native file.
//
// The one thing that was *not* needed: any change to `packages/dashboard`'s
// `tsconfig.json`, to the web `tsconfig.base.json`, or to any resolver
// configuration for Metro. Metro's `.native.*` resolution is free, as #52
// predicted.

import { StyleSheet, Text, View } from 'react-native';
import type { ReactElement } from 'react';
import { useKernel, useServiceAll } from '@ng-react/kernel';
import { DashboardCardToken } from './contract';
// **C9 pairing and the display sort live in `./ordering`**, shared with
// `screen.web.tsx`. See that file.
import { orderedCards } from './ordering';

/**
 * **R3/C5** — the dashboard is, at its core, `useServiceAll(DashboardCardToken)`,
 * and this file is the evidence that the sentence is platform-neutral.
 *
 * Line for line the same component as `screen.web.tsx`: the same two hooks, the
 * same `inspect()` read for C9 attribution, the same shared sort. What differs
 * is `<View>` for `<section>` and `<Text>` for `<h4>`. A module activating adds
 * its card and a module being disposed or quarantined (**F3**) withdraws it,
 * with no registry in this package to keep in step and no knowledge of which
 * modules exist — on either platform.
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
    <View style={styles.screen} testID="dashboard">
      <Text style={styles.heading}>Dashboard</Text>
      <Text style={styles.note}>
        C5: one card per contributing module, from useServiceAll(dashboard/DashboardCard). Cards
        appear when a module activates and are withdrawn when it is disposed or quarantined —
        debug has no card for exactly that second reason (F3), and this package contains no code
        that knows debug exists.
      </Text>

      <View testID="dashboard-cards" style={styles.cards}>
        {ordered.map(({ card, owner }) => (
          <View key={card.id} style={styles.card} testID={`dashboard-card-${card.id}`}>
            <Text style={styles.cardTitle}>{card.title}</Text>
            <Text style={styles.owner}>contributed by {owner}</Text>
            <card.component />
          </View>
        ))}
      </View>

      {ordered.length === 0 ? (
        <Text style={styles.note} testID="dashboard-empty">
          No cards — nothing that contributes one is active.
        </Text>
      ) : null}

      {/* The native counterpart of `screen.web.tsx`'s `data-platform="web"`.
          On web it is what `apps/react/src/shell/dashboard.test.tsx` asserts to
          prove the *web* file was picked; here it is what a screenshot shows
          to prove the *native* one was — which, before this task, was the
          single unverified half of #52's platform decision. */}
      <Text style={styles.platform} testID="dashboard-platform">
        platform: native
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#f4f7f9',
    borderColor: '#d6e0e6',
    borderRadius: 10,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  cardTitle: { color: '#101418', fontSize: 16, fontWeight: '700' },
  cards: { gap: 12 },
  heading: { color: '#101418', fontSize: 22, fontWeight: '700' },
  note: { color: '#5a6b78', fontSize: 12, lineHeight: 17 },
  owner: { color: '#7b5cd6', fontSize: 11 },
  platform: { color: '#5a6b78', fontSize: 11, fontStyle: 'italic' },
  screen: { flex: 1, gap: 12, padding: 20 },
});
