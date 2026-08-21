// `@app/debug/contract` — the module's public surface (spec §4).
//
// **B2**: types, `createToken()` calls and exactly one `moduleRef()` call.
//
// `debug` is **eager and non-critical**, and its `init` **throws on purpose**.
// It exists to demonstrate **F1/F3**: the module is quarantined with its
// error retained, its providers and contributions are withdrawn, and startup
// completes normally around it. That last part is the half of acceptance
// criterion 1 that is easy to claim and hard to prove — see
// `apps/react/src/App.test.tsx`.

import { createToken, moduleRef } from '@ng-react/kernel';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const DebugModule = moduleRef('debug');

/** What the module would have provided, had its `init` not thrown. */
export interface DebugProbe {
  /** A one-line snapshot for the demo's diagnostics panel. */
  describe(): string;
}

/**
 * **C1**. Nothing ever resolves this token in the demo: `debug`'s activation
 * fails, so **F3** withdraws the provider and the token has no owner. That is
 * the point — `kernel.ownerOf(DebugProbeToken)` returning `undefined` is what
 * "quarantined" means to a consumer.
 */
export const DebugProbeToken = createToken<DebugProbe>('debug/DebugProbe');
