// `@app/debug` — the module's own test, against `createTestKernel` (**R4**).
//
// This module fails on purpose, so its test is the mirror image of the usual
// one: it asserts **F1/F3** — the failure is retained, the registrations are
// withdrawn, and nothing leaks despite `init` never completing.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog } from '@ng-react/kernel';
import { DiagnosticPanelToken } from '@app/auth/contract';
import { DebugModule, DebugProbeToken } from './contract';
import { module } from './module';

/**
 * `debug`'s deliberate failure message, duplicated from `lifecycle.ts` rather
 * than imported. Importing it would evaluate `lifecycle.ts` when this file
 * loads — before any kernel exists — and the criterion 9 assertion below,
 * which is the whole point of `recordEvaluation`, would silently lose its
 * last entry. Duplication is the cheaper of the two costs.
 */
const DEBUG_INIT_FAILURE =
  "debug: init failed on purpose so the demo can show F3's quarantine. " +
  'The app must still start, and every other module must still be ready.';

describe('debug module', () => {
  it('D1 / criterion 9: providers are evaluated, then init — which is where it throws', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(DebugModule)).toBe('registered');
    expect(evaluationLog(kernel)).toEqual([]);

    await expect(kernel.activate(DebugModule)).rejects.toThrow(DEBUG_INIT_FAILURE);

    // The providers thunk ran to completion; `init` is the step that failed.
    // That ordering is what gives F3 something real to withdraw.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'debug/providers.ts',
      '<init>',
      'debug/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('F1/F3: a failing init quarantines the module, withdrawing its providers and contributions', async () => {
    const kernel = createTestKernel({ modules: [module] });

    // **F1**: an *explicit* `kernel.activate(ref)` rejects — the caller asked
    // for this module, so it is told. What quarantine changes is the blast
    // radius, not the answer to the asker: the startup eager pass swallows
    // the same failure (see `apps/react/src/App.test.tsx`, which proves the
    // app starts anyway), and the error is retained either way.
    await expect(kernel.activate(DebugModule)).rejects.toThrow(DEBUG_INIT_FAILURE);
    expect(kernel.status(DebugModule)).toBe('failed');
    expect(kernel.inspect().modules.find((row) => row.id === 'debug')?.error?.message).toContain(
      DEBUG_INIT_FAILURE,
    );

    // **F3**: providers withdrawn — the token has no owner at all, which is
    // what quarantine means to a consumer.
    expect(kernel.ownerOf(DebugProbeToken)).toBeUndefined();
    // **F3 + C5**: and the contribution is gone from the reactive collection,
    // which is how the demo's `useServiceAll` panel loses the row.
    expect(kernel.getAll(DiagnosticPanelToken)).toEqual([]);

    // **F4**: the failure reached the error sinks with the kernel's own
    // attribution (**C9**) — `'debug'`, never self-reported.
    expect(kernel.errors.map((entry) => entry.info.moduleId)).toContain('debug');

    await kernel.dispose();
    // **F3/H7**: `init` threw *after* resolving a module-scoped instance and
    // the quarantine still ran the cleanups and the disposal, so the residual
    // is zero. This is the assertion that would fail if quarantine only
    // withdrew registrations.
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('F3: retry re-attempts activation from a clean slate — and fails again, by design', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await expect(kernel.activate(DebugModule)).rejects.toThrow(DEBUG_INIT_FAILURE);
    const failuresAfterFirst = kernel.errors.filter(
      (entry) => entry.info.moduleId === 'debug',
    ).length;

    await expect(kernel.retry(DebugModule)).rejects.toThrow(DEBUG_INIT_FAILURE);

    expect(kernel.status(DebugModule)).toBe('failed');
    // A second, distinct report: `retry` really re-ran `init` rather than
    // re-surfacing the retained error.
    expect(kernel.errors.filter((entry) => entry.info.moduleId === 'debug').length).toBe(
      failuresAfterFirst + 1,
    );
    expect(kernel.getAll(DiagnosticPanelToken)).toEqual([]);

    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
  });
});
