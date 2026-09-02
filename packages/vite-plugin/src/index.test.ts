// Unit coverage for the transform heuristic and the literal shape Vite's
// static self-accept scan requires. `packages/orders` has no build step of
// its own to run this against directly, so `apps/react/scripts/hmr-e2e.mjs`
// is what proves this plugin works against a real `vite` dev server and a
// real browser; this file is the fast, no-server half.

import { describe, expect, it } from 'vitest';
import { transformWithOxc } from 'vite';
import { ngReactHmr } from './index';

const MODULE_SOURCE = `
import { defineModule } from '@ng-react/kernel';
import { OrdersModule } from './contract';

export const module = defineModule({
  id: OrdersModule,
  dependsOn: [],
  load: 'lazy',
  critical: false,
  providers: () => import('./providers').then((m) => m.providers),
});
`;

const NON_MODULE_SOURCE = `
import { contribute } from '@ng-react/kernel';
export const providers = [contribute];
`;

/** Runs the plugin's own `transform` hook exactly as Vite would call it. */
function runTransform(
  code: string,
  id: string,
  options?: { ssr?: boolean },
): { code: string; map: unknown } | null | undefined {
  const plugin = ngReactHmr();
  const hook = plugin.transform;
  if (hook === undefined) {
    throw new Error('plugin has no transform hook');
  }
  const handler = typeof hook === 'function' ? hook : hook.handler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (handler as any).call({}, code, id, options) as
    | { code: string; map: unknown }
    | null
    | undefined;
  return result;
}

describe('ngReactHmr — the transform hook', () => {
  it('injects the accept block into a file matching the module-entry heuristic', () => {
    const result = runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.ts');
    expect(result).not.toBeNull();
    expect(result?.code).toContain(
      "import { hotReplaceModule as __ngReactHotReplace } from '@ng-react/kernel';",
    );
    expect(result?.code).toContain('__ngReactHotReplace(module, next?.module);');
    // The literal Vite's static scan requires — see the plugin's own header
    // comment for exactly what that scan does and does not tolerate.
    expect(result?.code).toMatch(/^\s*import\.meta\.hot\??\.accept\(/m);
    // The injected import is the first line: an `import` declaration is
    // legal anywhere at a module's top level (hoisting makes position
    // irrelevant to *execution*), but keeping it first is what the task's
    // own worked example shows and is the least surprising placement to
    // read.
    expect(result?.code.startsWith('import { hotReplaceModule')).toBe(true);
  });

  it('leaves a non-module file untouched', () => {
    const result = runTransform(NON_MODULE_SOURCE, '/repo/packages/orders/src/providers.ts');
    expect(result).toBeUndefined();
  });

  it('ignores node_modules, non-TS files, and SSR transforms', () => {
    expect(
      runTransform(MODULE_SOURCE, '/repo/node_modules/@app/orders/src/module.ts'),
    ).toBeUndefined();
    expect(runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.css')).toBeUndefined();
    expect(
      runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.ts', { ssr: true }),
    ).toBeUndefined();
  });

  it('strips a query string before matching the file extension (Vite always appends one on HMR requests)', () => {
    const result = runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.ts?t=1700000000000');
    expect(result).not.toBeNull();
    expect(result?.code).toContain('__ngReactHotReplace');
  });

  it('the injected block survives esbuild/oxc transform intact — the code Vite actually scans, not the .ts text', async () => {
    // `transformWithOxc` is the same TS-stripping transform Vite's dev
    // server runs on every module before import analysis. Asserting on its
    // output rather than the pre-transform string is the point: a cast or
    // an indirection that erases to something else across that transform
    // would still pass a naive string check on the `.ts` source and still
    // break in a real browser (issue #46, spec §17, referenced in the
    // kernel's own `hotReplace` doc comment).
    const injected = runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.ts');
    if (injected === null || injected === undefined) {
      throw new Error('expected the module source to be transformed');
    }
    const { code } = await transformWithOxc(injected.code, 'module.ts');
    expect(code).toMatch(/^\s*import\.meta\.hot\??\.accept\(/m);
  });

  it('is idempotent: a second pass over already-injected code is a no-op', () => {
    const once = runTransform(MODULE_SOURCE, '/repo/packages/orders/src/module.ts');
    if (once === null || once === undefined) {
      throw new Error('expected the module source to be transformed');
    }
    const twice = runTransform(once.code, '/repo/packages/orders/src/module.ts');
    expect(twice).toBeUndefined();
  });
});
