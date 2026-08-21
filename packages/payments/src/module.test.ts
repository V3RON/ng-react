// `@app/payments` — the module's own test, against `createTestKernel` (**R4**).
//
// Runs in a plain node environment with no React renderer — acceptance
// criterion 7.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef } from '@ng-react/kernel';
import { DiagnosticPanelToken } from '@app/auth/contract';
import { PaymentDraftStoreToken, PaymentGatewayToken, PaymentsModule } from './contract';
import { acceptHotUpdate, module } from './module';
import type { ModuleHotContext } from './module';

describe('payments module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(PaymentsModule)).toBe('registered');
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(PaymentsModule);

    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'payments/providers.ts',
      '<init>',
      'payments/lifecycle.ts',
    ]);

    await kernel.dispose();
  });

  it('R4/C4: the gateway authorizes on behalf of its requester and clears the draft', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(PaymentsModule);
    expect(kernel.status(PaymentsModule)).toBe('ready');

    // H3: `init` seeded the persistent store, and only because it was empty.
    const drafts = kernel.get(PaymentDraftStoreToken);
    expect(drafts.getState().map((draft) => draft.reference)).toEqual(['demo-basket']);

    // **C4/ADR-2**: this resolution was started by the test, i.e. outside any
    // module, so `MODULE_ID` is the reserved id `'app'` — visible in the
    // authorization id, which is the point of C4's "consumer-specialized
    // services" without anyone passing an id string.
    const gateway = kernel.get(PaymentGatewayToken);
    await expect(gateway.authorize({ amountMinor: 4200, currency: 'EUR' }, 'demo-basket')).resolves
      .toEqual({
        id: 'auth-app-1',
        amount: { amountMinor: 4200, currency: 'EUR' },
        authorizedFor: 'demo-basket',
      });
    expect(drafts.getState()).toEqual([]);

    // C9: every provider above is attributed to this module.
    expect([...new Set(kernel.inspect().providers.map((row) => row.owner))]).toEqual(['payments']);

    // C5: the row this module contributes to `auth`'s collection token. It is
    // resolvable without `auth` being registered at all — a contribution
    // token is a value identity (C1), not a link to its declaring package.
    expect(kernel.getAll(DiagnosticPanelToken).map((panel) => panel.label)).toEqual([
      'Payment drafts',
    ]);

    await kernel.dispose();
    expect(kernel.errors).toEqual([]);
    expect(kernel.leaks().balanced).toBe(true);
  });

  it('C8: authorizing a non-positive amount fails with a message naming the reference', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(PaymentsModule);
    await expect(
      kernel.get(PaymentGatewayToken).authorize({ amountMinor: 0, currency: 'USD' }, 'empty'),
    ).rejects.toThrow("payments: cannot authorize 0 USD for 'empty'.");
    await kernel.dispose();
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
