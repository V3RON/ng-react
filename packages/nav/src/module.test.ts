// `@app/nav` — the module's own test, against `createTestKernel` (**R4**).
//
// **Node environment, no React renderer.** This file matches the
// `app-modules` vitest project (`*/src/**/*.test.ts`, `environment: 'node'`),
// which is the same machine check acceptance criterion 7 rests on: if the
// navigation module needed a renderer to be *registered and activated*, it
// would have a dependency it must not have. The navigator component itself is
// React and is tested where React belongs —
// `apps/react/src/acceptance/criterion-10-navigation-poc.test.tsx`.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog } from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef } from '@ng-react/kernel';
import { NavigatorToken, NavModule, RouteConfigToken, RouterToken } from './contract';
import { acceptHotUpdate, module } from './module';
import type { ModuleHotContext } from './module';

describe('nav module', () => {
  it('D1 / criterion 9: nothing is evaluated until activation, and there is no init', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(NavModule)).toBe('registered');
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(NavModule);

    // No `<init>` marker and no `nav/lifecycle.ts`: the navigation module
    // declares no `init` (**D4**). Everything it does is providers plus a
    // React subscription, so there is no activation-time work — C3's "a
    // provider that must run at activation regardless of consumers is not a
    // provider, it is `init` code" simply does not apply here.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'nav/providers.ts',
    ]);

    await kernel.dispose();
  });

  it('C9: the module owns its two providers and contributes no routes of its own', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(NavModule);

    expect(kernel.ownerOf(RouterToken)).toBe('nav');
    expect(kernel.ownerOf(NavigatorToken)).toBe('nav');

    // **The claim worth pinning.** The navigation module *declares*
    // `RouteConfigToken` and *consumes* its collection; it contributes
    // nothing to it. A navigator that seeded its own routes would make the
    // C5 demonstration circular, and this is what stops that happening
    // silently.
    expect(kernel.getAll(RouteConfigToken)).toEqual([]);
    expect(
      kernel.inspect().contributions.filter((row) => row.token === RouteConfigToken.label),
    ).toEqual([]);

    await kernel.dispose();
  });

  it('C2: the router is a singleton for the module\'s activation, and notifies on change', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(NavModule);

    const router = kernel.get(RouterToken);
    expect(kernel.get(RouterToken)).toBe(router);
    expect(router.current()).toBe('/');

    const seen: string[] = [];
    const unsubscribe = router.subscribe(() => {
      seen.push(router.current());
    });

    router.navigate('/orders');
    // A no-op: navigating to the current path must not notify, or
    // `useSyncExternalStore` would be told the snapshot changed while
    // `current()` returned the same string.
    router.navigate('/orders');
    router.navigate('/');
    unsubscribe();
    router.navigate('/payments');

    expect(seen).toEqual(['/orders', '/']);
    expect(router.current()).toBe('/payments');

    // **§17 (#34)**: a module-owned `singleton` lives for the module's
    // *activation*. Deactivating throws the location away, and a navigator
    // that is not running has no current route.
    await kernel.deactivate(NavModule);
    await kernel.activate(NavModule);
    expect(kernel.get(RouterToken)).not.toBe(router);
    expect(kernel.get(RouterToken).current()).toBe('/');

    await kernel.dispose();
  });

  it('R4/H7: activation and disposal leave nothing outstanding', async () => {
    const kernel = createTestKernel({ modules: [module] });
    await kernel.activate(NavModule);
    kernel.get(RouterToken);
    kernel.get(NavigatorToken);

    await kernel.dispose();

    expect(kernel.errors).toEqual([]);
    expect(kernel.leaks().balanced).toBe(true);
  });

  // **H2**: the hot block, executed rather than read — the same three
  // branches, and the same rationale, as every generated module's test. The
  // navigation module hot-replaces exactly like a feature module; that it is
  // *ordinary* in this respect too is part of criterion 10.
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
      expect(() => acceptHotUpdate(recordingKernel(replaced))).not.toThrow();
      expect(replaced).toEqual([]);
    });

    it('an update carrying no descriptor leaves the old one in force', () => {
      const replaced: { ref: string; next: string | undefined }[] = [];
      const host = fakeHost();
      acceptHotUpdate(recordingKernel(replaced), host.hot);

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

      expect(replaced).toEqual([{ ref: 'nav', next: 'nav' }]);
      // Without this, the *second* edit falls through to a full reload.
      expect(rearmed).toEqual([{ kernel, hot: host.hot }]);
    });
  });
});
