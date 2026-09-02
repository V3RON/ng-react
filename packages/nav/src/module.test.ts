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
import { NavigatorToken, NavModule, RouteConfigToken, RouterToken } from './contract';
import { module } from './module';

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
});
