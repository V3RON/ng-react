// `@app/payments` — the module's own test, against `createTestKernel` (**R4**).
//
// R4 is the harness the spec names for exactly this: "activate a module with
// mocked providers (via `override: true`), drive its lifecycle, dispose, and
// assert via `kernel.inspect()` and H7-style leak counters that nothing
// survived". It runs in a plain node environment with no React renderer —
// acceptance criterion 7.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog, provide } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef } from '@ng-react/kernel';
import { PaymentsGatewayToken, PaymentsServiceToken, PaymentsModule } from './contract';
import { acceptHotUpdate, module } from './module';
import type { ModuleHotContext } from './module';

describe('payments module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(PaymentsModule)).toBe('registered');

    // Registration is cheap: the descriptor's static fields are readable
    // without any implementation file having been evaluated.
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(PaymentsModule);

    // This assertion is what makes the empty one above mean something. On its
    // own, an empty log is also what you get from a `module.ts` that imported
    // `./providers` at the top — that evaluation happens when *this test file*
    // is loaded, before any kernel exists to record it. The full sequence
    // below is not reproducible that way: it pins that each file was
    // evaluated, and that each was evaluated *after* the trigger.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'payments/providers.ts',
      '<init>',
      'payments/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('R4: activates with a mocked gateway, behaves, and disposes without leaks', async () => {
    const kernel = createTestKernel({
      modules: [module],
      // **C6**: the module's own plain `provide` for this token is superseded
      // by the override rather than colliding with it (§17, issue #37), so
      // mocking the gateway does not kill the module that provides it.
      overrides: [
        provide(PaymentsGatewayToken, {
          factory: () => ({
            fetch: async (id: string) => ({ id, label: 'mocked record' }),
          }),
        }),
      ],
    });

    await kernel.activate(PaymentsModule);
    expect(kernel.status(PaymentsModule)).toBe('ready');

    const service = kernel.get(PaymentsServiceToken);
    await expect(service.load('42')).resolves.toEqual({ id: '42', label: 'mocked record' });

    // C9: provenance is kernel-assigned, so `inspect()` attributes every
    // provider above to this module.
    const owners = new Set(kernel.inspect().providers.map((row) => row.owner));
    expect([...owners]).toEqual(['payments']);

    await kernel.dispose();

    // **F4**: a module that logged a failure to the error sinks and still
    // balanced its counters is not a passing example. Assert both.
    expect(kernel.errors).toEqual([]);
    // **H7**: every `ctx.on`, every `ctx.effect` and every module-scoped
    // instance released by teardown.
    expect(kernel.leaks().balanced).toBe(true);
  });

  // **H2**: the hot block, executed rather than read. `ModuleHotContext` is
  // structural for exactly this reason — a plain object literal is a valid
  // host, so the accept callback can be captured and driven by hand, with no
  // bundler in the path. Three branches, and each one is load-bearing: drop
  // the guard and the first fails, drop the `hotReplace` and the third fails,
  // drop the re-arm and the third fails too.
  describe('H2: acceptHotUpdate', () => {
    /** A `Kernel` whose `hotReplace` records instead of running. */
    function recordingKernel(into: { ref: string; next: string | undefined }[]): Kernel {
      const kernel = createTestKernel({ modules: [] });
      return {
        ...kernel,
        hotReplace: async (ref: ModuleRef, next?: ModuleDescriptor) => {
          into.push({ ref: ref.id, next: next?.id.id });
        },
      };
    }

    /** A hot context that captures the callback the module registers. */
    function fakeHost(): { hot: ModuleHotContext; fire: (next?: unknown) => void } {
      let accepted: ((next?: unknown) => void) | undefined;
      return {
        hot: {
          accept: (callback) => {
            accepted = callback;
          },
        },
        fire: (next) => {
          if (accepted === undefined) {
            throw new Error('acceptHotUpdate registered no callback');
          }
          accepted(next);
        },
      };
    }

    it('with no hot context (a production build, and React Native today) it is a no-op', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      // Also the default-parameter path: under vitest `import.meta.hot` is
      // undefined, so the one-argument call the composition root makes lands
      // here too. Without the guard this throws on `undefined.accept`.
      expect(() => acceptHotUpdate(recordingKernel(replaced))).not.toThrow();
      expect(() => acceptHotUpdate(recordingKernel(replaced), undefined)).not.toThrow();
      expect(replaced).toEqual([]);
    });

    it('an update carrying no descriptor leaves the old one in force', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      const host = fakeHost();
      acceptHotUpdate(recordingKernel(replaced), host.hot);

      // A syntax error in the edited file, or a host that passes no namespace.
      host.fire(undefined);
      host.fire({});

      expect(replaced).toEqual([]);
    });

    it('an update carrying a descriptor calls hotReplace and re-arms the fresh copy', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      const kernel = recordingKernel(replaced);
      const host = fakeHost();
      acceptHotUpdate(kernel, host.hot);

      const rearmed: { kernel: Kernel; hot: ModuleHotContext | undefined }[] = [];
      host.fire({
        module,
        acceptHotUpdate: (nextKernel: Kernel, nextHot?: ModuleHotContext) => {
          rearmed.push({ kernel: nextKernel, hot: nextHot });
        },
      });

      expect(replaced).toEqual([{ ref: 'payments', next: 'payments' }]);
      // Without this, the *second* edit falls through to a full reload: the
      // fresh copy never accepted, and the composition root is not re-run.
      expect(rearmed).toEqual([{ kernel, hot: host.hot }]);
    });
  });
});
