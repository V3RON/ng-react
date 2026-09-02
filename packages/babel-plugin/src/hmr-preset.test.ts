// Runs `@babel/core` with the **real** `babel-preset-expo` over a realistic
// module entry file, and asserts the emitted code names the CJS wrapper's
// own `module` — not a renamed local — and that the module's public export
// is intact. This is the load-bearing guard against the pitfall the plugin's
// header comment describes: Expo's ESM->CJS transform renames a local
// binding literally called `module` to avoid colliding with the CJS
// wrapper's own `module` parameter, so a hand-written `module.hot` reference
// risks resolving to the wrong thing, or being caught in the rename outright.

import Module from 'node:module';
import { transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';
import ngReactHmrBabelPlugin from './index';

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

/**
 * Mimics the `caller` object Metro's own Babel transformer passes —
 * `babel-preset-expo` reads platform/dev/bundler off it via `api.caller`.
 * `isDev: true` and no `bundler`/webpack markers is what selects Metro's
 * native (not web) pipeline, which is the one that runs the CommonJS
 * transform this test exists to exercise.
 */
const METRO_DEV_CALLER = {
  name: 'metro',
  platform: 'ios',
  engine: 'hermes',
  isDev: true,
  isHMREnabled: true,
};

function transformWithRealPreset(source: string, caller: Record<string, unknown> = METRO_DEV_CALLER): string {
  const result = transformSync(source, {
    filename: 'module.ts',
    presets: [['babel-preset-expo', {}]],
    plugins: [ngReactHmrBabelPlugin],
    caller: caller as never,
    babelrc: false,
    configFile: false,
  });
  if (result?.code === null || result?.code === undefined) {
    throw new Error('babel-preset-expo produced no output');
  }
  return result.code;
}

describe('ngReactHmrBabelPlugin against the real babel-preset-expo', () => {
  it('emits module.hot.accept referencing the CJS wrapper\'s own module, not a renamed local', () => {
    const code = transformWithRealPreset(MODULE_SOURCE);

    // The whole point: `module.hot` in the output has to be the CJS
    // wrapper's own parameter. If Expo's rename had caught our injected
    // reference too, this string would not appear literally — it would read
    // `_module.hot` or similar.
    expect(code).toContain('module.hot');
    expect(code).not.toMatch(/_module\d*\.hot/);

    // The accept call itself survived the transform, guarded exactly as
    // written — CommonJS output, so `typeof module` rather than an ESM
    // `import.meta` check.
    expect(code).toMatch(/typeof module\s*!==\s*['"]undefined['"]\s*&&\s*module\.hot/);
    expect(code).toContain('module.hot.accept(function');

    // The stash key round-trips through the same `module.hot` object.
    expect(code).toContain('module.hot.__ngReactPrevModule');
  });

  it('the package\'s own export named `module` survives the rename intact', () => {
    const code = transformWithRealPreset(MODULE_SOURCE);

    // CJS output: `exports.module = ...` (or an Object.defineProperty getter
    // — babel-preset-expo's interop can go either way depending on options,
    // so the assertion below matches on the *evaluated* module rather than
    // guessing the exact emitted shape).
    const moduleObject = { exports: {} };
    const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', code);
    const fakeRequire = Module.createRequire(import.meta.url);
    fn(
      moduleObject,
      moduleObject.exports,
      (id: string) => {
        if (id === '@ng-react/kernel') {
          return {
            defineModule: (input: unknown) => input,
            hotReplaceModule: () => {},
          };
        }
        if (id === './contract') {
          return { OrdersModule: { id: 'orders' } };
        }
        return fakeRequire(id);
      },
      'module.ts',
      '.',
    );
    const exported = moduleObject.exports as { module?: { id: unknown } };
    expect(exported.module).toBeDefined();
    expect(exported.module?.id).toEqual({ id: 'orders' });
  });

  it('does not touch a file with no `export const module = defineModule(...)`', () => {
    const nonModuleSource = `
      import { contribute } from '@ng-react/kernel';
      export const providers = [contribute];
    `;
    const code = transformWithRealPreset(nonModuleSource);
    expect(code).not.toContain('hotReplaceModule');
    expect(code).not.toContain('__ngReactModule');
  });

  it('skips injection entirely in a production build (api.env("production"))', () => {
    const code = transformWithRealPreset(MODULE_SOURCE, { ...METRO_DEV_CALLER, isDev: false });
    // `babelPresetExpo` itself keys several of its own transforms off
    // `caller.isDev`; the plugin under test keys its own skip off
    // `api.env('production')`, which in turn reads `BABEL_ENV`/`NODE_ENV` —
    // set here directly so the assertion is about *our* plugin's guard, not
    // about which caller flag Expo happens to read.
    const previousEnv = process.env.BABEL_ENV;
    process.env.BABEL_ENV = 'production';
    try {
      const prodCode = transformWithRealPreset(MODULE_SOURCE, { ...METRO_DEV_CALLER, isDev: false });
      expect(prodCode).not.toContain('hotReplaceModule');
      expect(prodCode).not.toContain('module.hot');
    } finally {
      process.env.BABEL_ENV = previousEnv;
    }
    // The dev-caller transform (asserted elsewhere) is untouched by this —
    // referencing `code` keeps the non-production path exercised in the same
    // test file for contrast.
    expect(code).toContain('module.hot');
  });
});
