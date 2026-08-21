// `@app/debug` — provider declarations (spec §7.2).
//
// **These registrations are the ones F3 withdraws.** The module's `init`
// throws (see `lifecycle.ts`), and quarantine withdraws a failed module's
// providers *and* its contributions — so `DebugProbeToken` ends up with no
// owner and the `DiagnosticPanelToken` row below never reaches the panel.
// Watching that row fail to appear, and then appear on a successful
// `kernel.retry`, is what makes C5's reactivity visible in the demo.
//
// **The error sink is deliberately NOT here.** A sink contributed by this
// module would be withdrawn by the same quarantine that produced the error it
// was meant to report. It lives in `@app/auth` instead — see the comment
// there.

import { contribute, MODULE_ID, provide, recordEvaluation } from '@ng-react/kernel';
import type { AnyProviderRecord } from '@ng-react/kernel';
import { DiagnosticPanelToken } from '@app/auth/contract';
import { DashboardCardToken } from '@app/dashboard/contract';
import { DebugProbeToken } from './contract';
// **Extensionless on purpose** — the bundler and `tsc` pick `screen.web.tsx`
// or `screen.native.tsx`. Issue #52 §3; see `packages/dashboard/src/screen.web.tsx`.
import { DebugCard } from './screen';
import type { DebugProbe } from './contract';

// **Acceptance criterion 9** — this file *is* evaluated: the providers thunk
// runs before `init`, and it is `init` that throws.
recordEvaluation('debug', 'debug/providers.ts');

/** ADR-10: `AnyProviderRecord`, never `ProviderRecord<unknown>[]`. */
export const providers: AnyProviderRecord[] = [
  provide(DebugProbeToken, {
    scope: 'module',
    deps: [MODULE_ID],
    factory: (owner): DebugProbe => ({
      describe: () => `probe owned by '${owner}'`,
    }),
  }),

  contribute(DiagnosticPanelToken, {
    deps: [MODULE_ID, DebugProbeToken],
    factory: (owner, probe) => ({
      moduleId: owner,
      label: 'Debug probe',
      describe: () => probe.describe(),
    }),
  }),

  // **C5 — a dashboard card that is registered and then withdrawn.**
  //
  // This is the line that makes the dashboard demonstrate **F3** with no
  // dashboard code involved. This file *is* evaluated and this contribution
  // *is* registered — the providers thunk runs before `init`, and it is
  // `init` that throws (see `lifecycle.ts`) — so the collection genuinely
  // gains this card and then loses it when quarantine withdraws the module's
  // registrations. "The card is absent" and "the card was never contributed"
  // look identical from the outside, so the test that pins this asserts the
  // *sequence* the collection's subscribers saw
  // (`apps/react/src/shell/dashboard.test.tsx`), which is the only assertion
  // that can tell them apart.
  //
  // **No menu entry**, on purpose: a menu row for a screen that cannot be
  // reached would be a worse demonstration than a missing card, and issue #52
  // asks for the card only.
  contribute(DashboardCardToken, {
    deps: [MODULE_ID],
    factory: (owner) => ({
      id: 'debug/probe',
      title: `Debug probe (${owner})`,
      order: 90,
      component: DebugCard,
    }),
  }),
];
