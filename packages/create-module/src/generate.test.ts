// The golden-file test for spec §13 **B4**'s emitted set, plus the option
// matrix that the golden tree cannot cover (it is one point in the space).
//
// The fixture doubles as documentation: `__fixtures__/demo-thing/` is exactly
// what `pnpm create-module demo-thing` writes, and its `module.test.ts` runs
// as a real test in this same vitest project — see `vitest.config.ts`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CreateModuleError } from './errors.js';
import { generateModule } from './generate.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../__fixtures__/demo-thing/', import.meta.url));

/** The emitted path `packages/demo-thing/src/x.ts` -> its checked-in fixture copy. */
function fixturePath(emitted: string): string {
  return path.join(FIXTURE_ROOT, emitted.slice('packages/demo-thing/'.length));
}

describe('generateModule — B4 golden tree', () => {
  const generated = generateModule({ id: 'demo-thing' });

  it('emits exactly the seven files B4 names, in tree order', () => {
    expect(generated.files.map((file) => file.path)).toEqual([
      'packages/demo-thing/package.json',
      'packages/demo-thing/tsconfig.json',
      'packages/demo-thing/src/contract.ts',
      'packages/demo-thing/src/module.ts',
      'packages/demo-thing/src/providers.ts',
      'packages/demo-thing/src/lifecycle.ts',
      'packages/demo-thing/src/module.test.ts',
    ]);
  });

  it.each(generateModule({ id: 'demo-thing' }).files.map((file) => file.path))(
    'matches the checked-in fixture: %s',
    (emittedPath) => {
      const file = generated.files.find((candidate) => candidate.path === emittedPath);
      expect(fs.readFileSync(fixturePath(emittedPath), 'utf8')).toBe(file?.contents);
    },
  );

  it('leaves no placeholder unsubstituted', () => {
    for (const file of generated.files) {
      expect(file.contents, file.path).not.toMatch(/__[A-Za-z]+__/);
    }
  });

  it('spec §4: the package.json has no root export and exactly two subpath exports', () => {
    const manifest: unknown = JSON.parse(
      generated.files.find((file) => file.path.endsWith('package.json'))?.contents ?? '{}',
    );
    expect(manifest).toMatchObject({
      name: '@app/demo-thing',
      sideEffects: false,
      exports: {
        './contract': './src/contract.ts',
        './module': './src/module.ts',
      },
      dependencies: { '@ng-react/kernel': 'workspace:*' },
    });
    expect(Object.keys((manifest as { exports: object }).exports)).toEqual(['./contract', './module']);
    expect((manifest as { exports: Record<string, unknown> }).exports['.']).toBeUndefined();
  });

  it('ADR-7/D1: providers and init are dynamic-import thunks and dispose is absent (D4)', () => {
    const source = generated.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    expect(source).toContain("providers: () => import('./providers').then((m) => m.providers),");
    expect(source).toContain("init: (ctx) => import('./lifecycle').then((m) => m.init(ctx)),");
    expect(source).not.toContain('dispose:');
    // D1: nothing may pull an implementation file in at module scope.
    expect(source).not.toMatch(/^import .*'\.\/(providers|lifecycle)'/m);
  });

  it('H2: the descriptor file carries the hot block, with the kernel and the host injected', () => {
    const source = generated.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    expect(source).toContain('export function acceptHotUpdate(');
    expect(source).toContain('void kernel.hotReplace(DemoThingModule, replacement.module);');
    // The hot context is an optional parameter resolved against the module's
    // own self-accept, not an internal read: that is what makes the emitted
    // `module.test.ts` able to drive the block with an object literal, and
    // what lets a Metro host supply its own.
    expect(source).toContain('export function acceptHotUpdate(kernel: Kernel, hot?: ModuleHotContext): void {');
    expect(source).toContain('const context = hot ?? selfAccept;');
    // Principle 3 / the addendum's item 1: no module-level mutable kernel.
    // `let selfAccept` is module-level and mutable and is *not* one: it holds
    // a hot context, never a kernel, which is the whole of #41's decision.
    expect(source).not.toMatch(/globalThis|let kernel|currentKernel/);
    // The behavioural coverage lives in the *emitted* test, so every generated
    // module inherits it. Assert it is emitted; the fixture project runs it.
    const test = generated.files.find((file) => file.path.endsWith('src/module.test.ts'))?.contents ?? '';
    expect(test).toContain("describe('H2: acceptHotUpdate'");
    expect(test).toContain('expect(rearmed).toEqual([{ kernel, hot: host.hot }]);');
  });

  it('states plainly that the emitted hot block is Vite-only today', () => {
    const source = generated.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    // ADR-5 exists because the kernel has to run on React Native. A generated
    // module is a normative artefact, so it must not imply a portability it
    // does not have: Metro's `module.hot` is a per-module CommonJS binding and
    // is unreachable from a portable ESM file.
    expect(source).toContain('the block above is Vite-only');
    expect(source).toContain("Metro's\n * self-accepting callback receives no module namespace");
    // And must not imply the Vite half is unverified, or the RN half verified.
    expect(source).toContain('**None of this is verified**');
  });

  it('H2 / #46: the emitted module self-accepts under Vite own detection rule', async () => {
    const source = generated.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';

    // **The guard for issue #46, and the only one a unit test can hold.**
    //
    // Vite decides self-acceptance by *lexically* scanning the transformed
    // source: after an `import.meta` token it slices `.hot`, an optional `?`,
    // then `.accept` (`isSelfAccepting` in vite's import-analysis plugin).
    // Any indirection — `hot.accept(cb)` through a parameter, an alias or an
    // adapter — is invisible to it, the module is treated as
    // non-self-accepting, and every edit becomes a full page reload. That is
    // exactly what shipped in #41 and what #46 measured.
    //
    // So the assertion is made against the code Vite actually scans, not the
    // TypeScript on disk: `transformWithOxc` is the same transform the dev
    // server runs before import analysis, and it is what erases the `as`
    // casts the emitted block needs (the package owns no bundler types).
    // Asserting on the `.ts` text instead would pass on a source whose casts
    // erased to something else entirely.
    const { transformWithOxc } = await import('vite');
    const { code } = await transformWithOxc(source, 'module.ts');

    // Anchored to the start of a line so a mention inside the block's own
    // doc comment — there are several, deliberately — cannot satisfy it.
    expect(code).toMatch(/^\s*import\.meta\.hot\??\.accept\(/m);
  });
});

describe('generateModule — options', () => {
  it('spec §6: --load eager and --critical reach the descriptor', () => {
    const generated = generateModule({ id: 'auth', load: 'eager', critical: true });
    const source = generated.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    expect(source).toContain("load: 'eager',");
    expect(source).toContain('critical: true,');
  });

  it('D3: --depends-on emits contract imports and the ref list, and no blank line when empty', () => {
    const withDeps = generateModule({ id: 'orders', dependsOn: ['auth', 'payments'] });
    const source = withDeps.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    expect(source).toContain("import { AuthModule } from '@app/auth/contract';");
    expect(source).toContain("import { PaymentsModule } from '@app/payments/contract';");
    expect(source).toContain('dependsOn: [AuthModule, PaymentsModule],');

    const without = generateModule({ id: 'orders' });
    const bare = without.files.find((file) => file.path.endsWith('src/module.ts'))?.contents ?? '';
    expect(bare).toContain('dependsOn: [],');
    expect(bare).toContain(
      "import type { Kernel, ModuleDescriptor } from '@ng-react/kernel';\nimport { OrdersModule } from './contract';",
    );
  });

  it('D3: --depends-on also reaches package.json, or pnpm never links the dependency', () => {
    // Found by task 8.1: the emitted `@app/orders` imported
    // `@app/auth/contract` in `module.ts` while its manifest declared only
    // `@ng-react/kernel`, so `pnpm install` linked nothing and the untouched
    // package failed `pnpm verify` twice over — `tsc` TS2307 and
    // `import-x/no-unresolved`, both pointing at a line the generator wrote.
    // The import half and the manifest half are one feature; assert both.
    const withDeps = generateModule({ id: 'orders', dependsOn: ['auth', 'payments'] });
    const manifest: unknown = JSON.parse(
      withDeps.files.find((file) => file.path.endsWith('package.json'))?.contents ?? '{}',
    );
    expect((manifest as { dependencies: Record<string, string> }).dependencies).toEqual({
      '@app/auth': 'workspace:*',
      '@app/payments': 'workspace:*',
      '@ng-react/kernel': 'workspace:*',
    });

    // The scope follows `--scope`, because that is what the contract imports
    // in `module.ts` are rendered with.
    const scoped = generateModule({ id: 'orders', scope: '@acme', dependsOn: ['auth'] });
    const scopedManifest: unknown = JSON.parse(
      scoped.files.find((file) => file.path.endsWith('package.json'))?.contents ?? '{}',
    );
    expect((scopedManifest as { dependencies: Record<string, string> }).dependencies).toEqual({
      '@acme/auth': 'workspace:*',
      '@ng-react/kernel': 'workspace:*',
    });

    // And a module with no dependencies keeps the manifest it always had —
    // the placeholder line goes with the line, not as an empty key.
    const without = generateModule({ id: 'orders' });
    const bare = without.files.find((file) => file.path.endsWith('package.json'))?.contents ?? '';
    expect(bare).toContain('  "dependencies": {\n    "@ng-react/kernel": "workspace:*"\n  }');
  });

  it('--scope and --dir move the package without changing the module id', () => {
    const generated = generateModule({ id: 'orders', scope: '@acme', dir: 'features' });
    expect(generated.packageName).toBe('@acme/orders');
    expect(generated.dir).toBe('features/orders');
    expect(generated.files[0]?.path).toBe('features/orders/package.json');
    const contract = generated.files.find((file) => file.path.endsWith('src/contract.ts'))?.contents ?? '';
    expect(contract).toContain("moduleRef('orders')");
  });

  it('rejects an invalid --load, --scope, a self-dependency and a duplicate dependency', () => {
    expect(() => generateModule({ id: 'orders', load: 'sometimes' as 'lazy' })).toThrow(
      "create-module: invalid --load 'sometimes'. Valid values are 'eager' and 'lazy' (spec §5.2, §6); " +
        "'lazy' is the default and the one a feature module almost always wants.",
    );
    expect(() => generateModule({ id: 'orders', scope: 'app' })).toThrow(
      "create-module: invalid --scope 'app'. A scope is '@' followed by a lowercase npm name, e.g. " +
        '\'@app\'. Spec §4: "the package name is the module id prefixed by the workspace scope".',
    );
    expect(() => generateModule({ id: 'orders', dependsOn: ['orders'] })).toThrow(
      "create-module: --depends-on lists 'orders', which is the module's own id. A module cannot depend " +
        'on itself (D3), and defineModule() rejects it at runtime.',
    );
    expect(() => generateModule({ id: 'orders', dependsOn: ['auth', 'auth'] })).toThrow(
      "create-module: --depends-on lists 'auth' twice. Each dependency may be listed only once (D3).",
    );
    expect(() => generateModule({ id: 'app' })).toThrow(CreateModuleError);
  });
});
