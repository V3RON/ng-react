// `@app/auth` — the module's own test, against `createTestKernel` (**R4**).
//
// R4 is the harness the spec names for exactly this: "activate a module with
// mocked providers (via `override: true`), drive its lifecycle, dispose, and
// assert via `kernel.inspect()` and H7-style leak counters that nothing
// survived". It runs in a plain node environment with no React renderer —
// acceptance criterion 7.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog, ErrorSinkToken } from '@ng-react/kernel';
import type { ErrorInfo } from '@ng-react/kernel';
import {
  AuthErrorLogToken,
  AuthModule,
  DiagnosticPanelToken,
  SessionServiceToken,
} from './contract';
import { module } from './module';

describe('auth module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(AuthModule)).toBe('registered');

    // Registration is cheap: the descriptor's static fields are readable
    // without any implementation file having been evaluated. `auth` is
    // `load: 'eager'`, and this still holds — the kernel's eager pass is an
    // activation like any other, and it has not run yet.
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(AuthModule);

    // This assertion is what makes the empty one above mean something. On its
    // own, an empty log is also what you get from a `module.ts` that imported
    // `./providers` at the top — that evaluation happens when *this test file*
    // is loaded, before any kernel exists to record it.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'auth/providers.ts',
      '<init>',
      'auth/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('R4: activates, signs the demo user in, and disposes without leaks', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(AuthModule);
    expect(kernel.status(AuthModule)).toBe('ready');

    // L2: `init`'s effect logged the demo user in. Asserting the *service*
    // rather than the effect is the point — the effect is an implementation
    // detail, the session is the module's contract.
    const session = kernel.get(SessionServiceToken);
    expect(session.current()?.userId).toBe('demo-user');

    // C9: provenance is kernel-assigned, so `inspect()` attributes every
    // provider above to this module.
    const owners = new Set(kernel.inspect().providers.map((row) => row.owner));
    expect([...owners]).toEqual(['auth']);

    // C5: exactly one row from this module, describing the live session.
    const panels = kernel.getAll(DiagnosticPanelToken);
    expect(panels.map((panel) => panel.moduleId)).toEqual(['auth']);
    expect(panels[0]?.describe()).toBe('signed in as demo-user');

    await kernel.dispose();

    // **F4**: a module that logged a failure to the error sinks and still
    // balanced its counters is not a passing example. Assert both.
    expect(kernel.errors).toEqual([]);
    // **H7**: every `ctx.on`, every `ctx.effect` and every module-scoped
    // instance released by teardown.
    expect(kernel.leaks().balanced).toBe(true);
  });

  it("F4/F3: auth's error sink records another module's failure, with the kernel's attribution", async () => {
    // The reason the sink lives in `auth` and not in `debug`: a sink
    // contributed by a module that is itself quarantined is withdrawn by that
    // quarantine (**F3**) and reports nothing. Here `auth` is the working
    // module, and the attribution it records is the kernel's (**C9**), not
    // its own — so the entry names `'app'`, the module the error was raised
    // for, and never `'auth'`.
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(AuthModule);

    const log = kernel.get(AuthErrorLogToken);
    expect(log.getState()).toEqual([]);

    for (const sink of kernel.getAll(ErrorSinkToken)) {
      sink.report(new Error('debug: boom'), { moduleId: 'debug', phase: 'activate' } as ErrorInfo);
    }

    expect(log.getState()).toEqual([
      { moduleId: 'debug', phase: 'activate', message: 'debug: boom' },
    ]);

    await kernel.dispose();
    expect(kernel.leaks().balanced).toBe(true);
  });
});
