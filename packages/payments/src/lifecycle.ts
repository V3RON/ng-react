// `@app/payments` — the module lifecycle (spec §8).
//
// No `dispose` export, and no `dispose` thunk in `module.ts`: everything
// below is registered through `ctx`, so **L3** tears it down in reverse
// registration order and there is nothing to mirror (**D4**).

import { recordEvaluation } from '@ng-react/kernel';
import type { ModuleContext } from '@ng-react/kernel';
import { PaymentDraftStoreToken } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('payments', 'payments/lifecycle.ts');

/** The draft the demo starts with, so the persistent store has visible state. */
const SEED_REFERENCE = 'demo-basket';

/**
 * **L1**: resolves with this module as the resolution context (**C4**).
 */
export function init(ctx: ModuleContext): void {
  const drafts = ctx.get(PaymentDraftStoreToken);

  // **H3, and the seeding is conditional for a reason.** An unconditional
  // seed would make the persistent store impossible to observe: every HMR
  // re-activation would re-add the draft, so a preserved state and a
  // discarded one would look identical. Seeding only an *empty* store means
  // the count in the demo UI is evidence — it holds steady across an edit to
  // this file (H4 carries the snapshot onto the fresh instance) and returns
  // to one after a real `kernel.deactivate`, which discards it.
  if (drafts.getState().length === 0) {
    drafts.setState([{ reference: SEED_REFERENCE, amount: { amountMinor: 4200, currency: 'EUR' } }]);
  }
}
