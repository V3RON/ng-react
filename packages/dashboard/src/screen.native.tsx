// `@app/dashboard` — the dashboard screen, **React Native implementation**.
//
// **This file is a placeholder, and saying so plainly is the point.** Read
// `screen.web.tsx`'s header first: it carries the platform decision this file
// is the other half of.
//
// What is real here today: the *file*, its name, and the fact that `./screen`
// resolves to `screen.web.tsx` and not to this on every web resolver in the
// workspace (Vite, Vitest, `tsc`, and the boundary preset's ESLint resolver).
// `apps/react/src/shell/dashboard.test.tsx` asserts exactly that, and asserts
// it in a way that fails if this file were picked instead — which is only
// meaningful because this file exists. A resolution test with nothing to
// resolve *away from* proves nothing (§5.2 of `HANDOFF.md`: the weak-test
// pattern).
//
// What is **not** real here: React Native. There is no `react-native` in this
// workspace — issue #53 adds it — and every package's `tsconfig.json`
// includes `src/**/*`, so this file is type-checked by the *web* `tsc` today
// and must therefore compile without it. So the body below is plain React
// with a marker, not `<View>`/`<Text>`.
//
// **What issue #53 must do to this file**, in order:
//
//  1. add `react-native` (and `@types/react-native` if the SDK still needs
//     one) to this package's `dependencies`;
//  2. replace the body with `<View>` / `<Text>` and the card list from
//     `screen.web.tsx`, which is otherwise line-for-line the same component —
//     the hooks, the C9 owner pairing and the `(order ?? Infinity, C5 index)`
//     sort are all platform-neutral and should be lifted, not re-derived;
//  3. give the native app a `tsconfig.json` with `moduleSuffixes:
//     ['.native', '']`, which is what makes `./screen` resolve here;
//  4. decide what the *web* `tsc` should do with a file that now imports
//     `react-native`. The honest options are a `react-native` dev dependency
//     at the root purely for types, or excluding `**/*.native.tsx` from every
//     web `tsconfig.json`. The second is cheaper and the second is a hole:
//     nothing would then typecheck the native files at all until the native
//     app's own `tsc` runs. Pick deliberately and say which.

import type { ReactElement } from 'react';

/**
 * Placeholder — see this file's header. The marker below is what
 * `dashboard.test.tsx` would see if a web resolver picked this file over
 * `screen.web.tsx`, and the whole of what it is for.
 */
export function DashboardScreen(): ReactElement {
  return <section data-testid="dashboard" data-platform="native" />;
}
