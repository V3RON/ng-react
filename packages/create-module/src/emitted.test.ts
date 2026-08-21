// "The emitted package must pass `pnpm verify` unmodified" — as much of it as
// can honestly be run from inside this repo.
//
// `pnpm verify` is `typecheck && lint && test`, and the three halves are
// discharged in three different places, on purpose:
//
//  - **typecheck** — here, by running the repo's own `tsc` over a module
//    generated into a throwaway workspace (`tsc --noEmit -p <pkg>`), against
//    the emitted `tsconfig.json` exactly as written. That is the part a
//    golden-file diff cannot prove.
//  - **lint** — here, by running ESLint programmatically over the same tree
//    with the *root* `eslint.config.js`, i.e. with
//    `@ng-react/eslint-config-modules` wired in by package name. Warnings are
//    asserted to be zero too, because `no-transient-in-component` is a
//    `warn` (B3/R2) and the emitted C7 pattern must not trip it.
//  - **test** — not here. The emitted `module.test.ts` runs as a real test in
//    this vitest project, from `__fixtures__/demo-thing/`, which is a
//    byte-for-byte copy of this tree (`generate.test.ts` pins that). Running
//    vitest recursively from inside a vitest worker is the one thing that
//    would prove less while costing more.
//
// What none of this covers is stated in the PR: the generated package is not
// installed into the real workspace, so `workspace:*` resolution of
// `@ng-react/kernel` is stood in for by a symlinked `node_modules` rather
// than by `pnpm install`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateModule } from './generate.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let workspace: string;
let packageDir: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'create-module-verify-'));

  // The emitted tsconfig says `extends: "../../tsconfig.base.json"`, which is
  // true of a package at `packages/<id>/` in this workspace. Reproduce that
  // shape rather than rewriting the emitted file.
  fs.copyFileSync(
    path.join(REPO_ROOT, 'tsconfig.base.json'),
    path.join(workspace, 'tsconfig.base.json'),
  );

  // Stands in for `pnpm install`: `@ng-react/kernel` is a `workspace:*`
  // dependency of the emitted package, and `vitest` is what its test imports.
  const nodeModules = path.join(workspace, 'node_modules');
  fs.mkdirSync(path.join(nodeModules, '@ng-react'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'packages/ng-react'), path.join(nodeModules, '@ng-react/kernel'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules/vitest'), path.join(nodeModules, 'vitest'));

  const generated = generateModule({ id: 'demo-thing' });
  for (const file of generated.files) {
    const absolute = path.join(workspace, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents, 'utf8');
  }
  packageDir = path.join(workspace, generated.dir);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the emitted package', () => {
  it('type-checks with the repo tsc, against its own emitted tsconfig', () => {
    const tsc = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
    // A non-zero exit throws; the stdout of a failing `tsc` is the diagnostic
    // list, so surface it rather than the bare "command failed".
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', packageDir], {
        cwd: workspace,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? String(error);
      expect.unreachable(`tsc reported errors in the emitted package:\n${output}`);
    }
  }, 120_000);

  it('is not a vacuous type-check: a deliberate error in the emitted tree fails it', () => {
    // AGENTS.md / HANDOFF §5.6: an unprimed `npx tsc` silently reports success.
    // This asserts the probe above can actually fail.
    const contract = path.join(packageDir, 'src/contract.ts');
    const original = fs.readFileSync(contract, 'utf8');
    fs.writeFileSync(contract, `${original}\nexport const broken: number = 'not a number';\n`);
    try {
      const tsc = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
      expect(() =>
        execFileSync(process.execPath, [tsc, '--noEmit', '-p', packageDir], {
          cwd: workspace,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      fs.writeFileSync(contract, original);
    }
  }, 120_000);

  it('lints clean under the root config — zero errors and zero warnings (B1-B3, R2)', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({
      cwd: workspace,
      overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
    });
    const results = await eslint.lintFiles([path.join(packageDir, 'src')]);

    expect(results.length).toBeGreaterThan(0);
    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${path.relative(workspace, result.filePath)}:${message.line} ${message.ruleId ?? 'parse'} ` +
          `${message.message}`,
      ),
    );
    expect(problems).toEqual([]);
  }, 120_000);

  it('the boundary preset is actually applied to the emitted files', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({
      cwd: workspace,
      overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
    });
    // The clean run above would look identical if the preset were not wired
    // in at all. B4 asks the generator to emit "the lint config wiring"; in
    // this workspace that wiring is the root config's `packages/**` reach, so
    // the check is that the rules resolve for an emitted file, not that the
    // package carries a config of its own (a nested flat config would replace
    // the root one, losing the TS parser with it).
    const config = (await eslint.calculateConfigForFile(
      path.join(packageDir, 'src/contract.ts'),
    )) as { rules: Record<string, unknown> };

    expect(Object.keys(config.rules)).toEqual(
      expect.arrayContaining([
        'ng-react-modules/no-cross-module-deep-import',
        'ng-react-modules/module-entry-only-in-composition-root',
        'ng-react-modules/contract-exports-allowlist',
        'ng-react-modules/no-override-outside-composition-root',
        'ng-react-modules/no-transient-in-component',
        'import-x/no-cycle',
      ]),
    );
  }, 120_000);
});
