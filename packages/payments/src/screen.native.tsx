// `@app/payments` — the module's React components, **React Native implementation**.
//
// **A placeholder, and deliberately labelled as one.** The platform decision
// this file is the other half of is written up in
// `packages/dashboard/src/screen.web.tsx`; the "what issue #53 must do"
// checklist is in `packages/dashboard/src/screen.native.tsx`. Neither is
// repeated here.
//
// What is real today is the *file*: `./screen` resolves to `screen.web.tsx`
// and not to this on every web resolver in the workspace, and
// `apps/react/src/shell/dashboard.test.tsx` fails if it ever stops doing so —
// a check that is only meaningful because this file is here to be picked by
// mistake.
//
// What is not real is React Native. There is none in this workspace, and each
// package's `tsconfig.json` includes `src/**/*`, so this file is type-checked
// by the *web* `tsc` and must compile without it. Hence plain React and a
// marker, not `<View>` / `<Text>`.

import type { ReactElement } from 'react';

/** Placeholder — see this file's header. */
export function PaymentsScreen(): ReactElement {
  return <section data-testid="payments-screen" data-platform="native" />;
}

/** Placeholder — see this file's header. */
export function PaymentsCard(): ReactElement {
  return <section data-testid="payments-card" data-platform="native" />;
}
