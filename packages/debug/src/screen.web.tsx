// `@app/debug` — the module's React components, **web implementation**.
//
// Implementation: unreachable from outside the package (spec §4).
//
// **Nothing in this workspace ever renders this component**, and that is the
// point of the module. `debug`'s `init` throws on purpose, so **F3**
// withdraws the `DashboardCardToken` contribution its `providers.ts` had
// already registered, and the card never reaches the dashboard. The component
// exists so that the absence is caused by quarantine rather than by there
// being nothing to withdraw — see `apps/react/src/shell/dashboard.test.tsx`,
// which asserts the difference.
//
// **`.web.tsx`, and `providers.ts` imports `./screen`** — issue #52 §3's
// platform decision, written up once in `packages/dashboard/src/screen.web.tsx`.

import { useService } from '@ng-react/kernel';
import type { ReactElement } from 'react';
import { DebugProbeToken } from './contract';

/** Would render `debug`'s probe, if `debug` ever activated successfully. */
export function DebugCard(): ReactElement {
  const probe = useService(DebugProbeToken);
  return (
    <p data-testid="debug-card" data-platform="web">
      {probe.describe()}
    </p>
  );
}
