// `__pkg__` — the module's own test, against `createTestKernel` (**R4**).
//
// R4 is the harness the spec names for exactly this: "activate a module with
// mocked providers (via `override: true`), drive its lifecycle, dispose, and
// assert via `kernel.inspect()` and H7-style leak counters that nothing
// survived". It runs in a plain node environment with no React renderer —
// acceptance criterion 7.

import { describe, expect, it } from 'vitest';
import { createTestKernel, __defineModuleImport__evaluationLog, provide } from '@ng-react/kernel';
// __moduleDescriptorImport__
import { __Pascal__GatewayToken, __Pascal__ServiceToken, __Ref__ } from './contract';
import { module } from './module';
// __dependencyStubs__

describe('__id__ module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [__modulesUnderTest__] });
    expect(kernel.status(__Ref__)).toBe('registered');
    // **D2**: the descriptor never re-states its id string — it is read off
    // the ref it was built with.
    expect(module.id.id).toBe('__id__');

    // Registration is cheap: the descriptor's static fields are readable
    // without any implementation file having been evaluated.
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(__Ref__);

    // This assertion is what makes the empty one above mean something. On its
    // own, an empty log is also what you get from a `module.ts` that imported
    // `./providers` at the top — that evaluation happens when *this test file*
    // is loaded, before any kernel exists to record it. The full sequence
    // below is not reproducible that way: it pins that each file was
    // evaluated, and that each was evaluated *after* the trigger.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      '__id__/providers.ts',
      '<init>',
      '__id__/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('R4: activates with a mocked gateway, behaves, and disposes without leaks', async () => {
    const kernel = createTestKernel({
      modules: [__modulesUnderTest__],
      // **C6**: the module's own plain `provide` for this token is superseded
      // by the override rather than colliding with it (§17, issue #37), so
      // mocking the gateway does not kill the module that provides it.
      overrides: [
        provide(__Pascal__GatewayToken, {
          factory: () => ({
            fetch: async (id: string) => ({ id, label: 'mocked record' }),
          }),
        }),
      ],
    });

    await kernel.activate(__Ref__);
    expect(kernel.status(__Ref__)).toBe('ready');

    const service = kernel.get(__Pascal__ServiceToken);
    await expect(service.load('42')).resolves.toEqual({ id: '42', label: 'mocked record' });

    // C9: provenance is kernel-assigned, so `inspect()` attributes every
    // provider above to this module.
    const owners = new Set(kernel.inspect().providers.map((row) => row.owner));
    expect([...owners]).toEqual(['__id__']);

    await kernel.dispose();

    // **F4**: a module that logged a failure to the error sinks and still
    // balanced its counters is not a passing example. Assert both.
    expect(kernel.errors).toEqual([]);
    // **H7**: every `ctx.on`, every `ctx.effect` and every module-scoped
    // instance released by teardown.
    expect(kernel.leaks().balanced).toBe(true);
  });
});
