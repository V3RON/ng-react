// **A3/F2 in the real web demo** — the gate `main.tsx` actually mounts.
//
// These render `<AppRoot>` over `createAppKernel()`'s real descriptor list,
// for the same reason `App.test.tsx` does: a test that hand-assembled a kernel
// would pass while the composition root was wrong, and "the demo gates first
// paint" is a claim about the composition root.

import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DebugModule } from '@app/debug/contract';
import { AuthModule } from '@app/auth/contract';
import { createAppKernel } from '../composition-root';
import { AppRoot } from './startup';

describe('the web demo startup gate (A3)', () => {
  it('A3: the splash is on screen before the gate opens, and the diagnostic surface after it', async () => {
    const { kernel, log } = createAppKernel(undefined);

    render(
      <StrictMode>
        <AppRoot kernel={kernel} log={log} />
      </StrictMode>,
    );

    // **The premise.** The eager pass is scheduled on a microtask, so the
    // first paint happens with `auth` still `registered` — which is what makes
    // the gate worth having and what stops this test passing on a gate that
    // renders its children unconditionally.
    expect(kernel.status(AuthModule)).toBe('registered');
    expect(screen.getByTestId('startup-splash')).toBeDefined();
    expect(screen.queryByTestId('module-auth')).toBeNull();

    await waitFor(() => {
      // **The acceptance surface, still reachable.** Everything
      // `App.test.tsx` and the acceptance suite assert against is behind the
      // gate, and the gate opens.
      expect(screen.getByTestId('module-auth')).toBeDefined();
    });
    expect(screen.queryByTestId('startup-splash')).toBeNull();
    expect(screen.queryByTestId('startup-failed')).toBeNull();
    expect(screen.getByTestId('contribution-panels')).toBeDefined();
  });

  it("A3: the gate opens without waiting for `debug`, which is eager, non-critical and fails on purpose", async () => {
    const { kernel, log } = createAppKernel(undefined);

    render(
      <StrictMode>
        <AppRoot kernel={kernel} log={log} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('module-auth')).toBeDefined();
    });

    // `debug` is eager and non-critical and its `init` throws. A3 says it must
    // never hold the splash up, and the demo carries it for exactly this
    // proof. Whether it is still `activating` or already `failed` when the
    // gate opens is a scheduling detail — that it is *not* `ready`, and that
    // the gate opened anyway, is the guarantee.
    expect(kernel.status(DebugModule)).not.toBe('ready');
    expect(kernel.status(AuthModule)).toBe('ready');
  });
});
