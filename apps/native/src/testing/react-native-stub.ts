// **The `react-native` stand-in for this app's Vitest project — and exactly
// what it does and does not buy.**
//
// `react-native`'s entry point is Flow-typed JavaScript. Node cannot parse it,
// esbuild cannot strip it, and no amount of Vitest configuration changes that:
// running the real package outside Metro is not possible. The alternatives were
//
//  - **a second test runner** (Jest with `react-native`'s own preset, which is
//    what an RN app normally uses). Issue #53 says "do **not** bolt on a second
//    test runner without saying so", and a second runner would need its own
//    transform, its own module mapper and its own duplicate of the platform
//    resolution decision — a sixth vocabulary for #52's one decision;
//  - **not testing the native app at all**, leaving every claim in it to the
//    simulator run;
//  - **this**: one alias, in the one Vitest project that needs it.
//
// **What the tests that use it actually assert.** Contribution collection
// contents, the *sequences* C5's subscribers observed, C9 owner attribution,
// the descriptor list, and the HMR adapter's shape. Not one of those touches a
// React Native primitive: a `DashboardCard.component` is an opaque *value* as
// far as the kernel and the collections are concerned, which is the whole
// reason one `contribute()` call can carry a DOM component on one platform and
// an RN component on another. The stub exists so that `import 'react-native'`
// at the top of `screen.native.tsx` resolves — it is never called.
//
// **What it therefore does not prove**, stated plainly rather than left to be
// discovered: nothing here renders, so no test in this repository renders a
// React Native component. Rendering is verified by the simulator run only, and
// the PR body says which observations are which. `platform-split.test.ts` is
// the guard that keeps *these* tests from being the reason a native screen
// silently reverts to a DOM placeholder.
//
// It lives under `src/testing/` rather than in a `__mocks__` directory because
// nothing in this app imports it: it is reached only through the `native`
// project's `resolve.alias` in the root `vitest.config.ts`, which names this
// path.

/** A style object is its own descriptor here; nothing reads it. */
export const StyleSheet = {
  create: <T>(styles: T): T => styles,
};

/**
 * The host components, as inert marker functions.
 *
 * They are named and distinct rather than a single shared `() => null` so that
 * a stack trace or a failed assertion says which one was reached — if one ever
 * is, that is itself the bug, because these tests do not render.
 */
export function View(): null {
  return null;
}

export function Text(): null {
  return null;
}

export function Pressable(): null {
  return null;
}

export function ScrollView(): null {
  return null;
}
