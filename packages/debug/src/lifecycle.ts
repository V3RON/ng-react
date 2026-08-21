// `@app/debug` — the module lifecycle (spec §8).
//
// **This module fails on purpose.** It is the demo's proof of **F1/F3**:
// a non-critical module whose activation throws is quarantined — status
// `failed` with the error retained, providers and contributions withdrawn —
// while every other module activates normally and startup completes.
//
// It throws in `init` rather than in the providers thunk because that is the
// harder case: the providers thunk has already run and registered, so
// quarantine has something real to withdraw (F3), and the `ctx` cleanups the
// half-finished `init` registered still run.

import { recordEvaluation } from '@ng-react/kernel';
import type { ModuleContext } from '@ng-react/kernel';
import { DebugProbeToken } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('debug', 'debug/lifecycle.ts');

/**
 * The message the demo UI shows and every test asserts on.
 *
 * **Deliberately not exported**, and the tests duplicate the literal instead.
 * Exporting it made `module.test.ts` `import ... from './lifecycle'`, which
 * evaluates this file when the *test file* loads — before any kernel exists —
 * so `recordEvaluation` below fired into no recorder and criterion 9's
 * evaluation-order assertion lost its last entry. A test file that imports a
 * module's implementation has already broken D1 for itself.
 */
const DEBUG_INIT_FAILURE =
  "debug: init failed on purpose so the demo can show F3's quarantine. " +
  'The app must still start, and every other module must still be ready.';

/**
 * **F1**: throws, every time.
 *
 * **It fails on retry too, and that is deliberate.** `kernel.retry(ref)`
 * (**F3**) re-attempts activation from a clean slate, and the honest thing
 * for this module to do is fail again: a retry that succeeded the second time
 * would need a flag somewhere, and the only places to keep one are a module
 * closure (which H3 says is lost on every edit, so the demo would behave
 * differently before and after a hot update) or another module's provider
 * (which would be an undeclared dependency this module has no `dependsOn`
 * for). What the Retry button demonstrates is therefore the full F3 cycle —
 * `failed → activating → failed`, a *second* entry in the error log, and the
 * panel row still absent — which is what retrying a genuinely broken module
 * looks like.
 */
export function init(ctx: ModuleContext): void {
  // Resolved before throwing so the failure happens with a real, constructed
  // module-scoped instance outstanding: quarantine has to dispose it as well
  // as withdraw the registration, and a leak here would show up in H7's
  // counters as a positive residual for `debug`.
  ctx.get(DebugProbeToken);
  throw new Error(DEBUG_INIT_FAILURE);
}
