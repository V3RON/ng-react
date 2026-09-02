// The CLI surface: `--dry-run`, the refusal to overwrite, and flag errors.
//
// `run()` returns `{ code, stdout, stderr }` rather than writing to the
// process, so every case here is an ordinary assertion — no spawned process,
// no captured streams. `bin/create-module.js` is the only thing that touches
// `process`, and it is three lines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './cli.js';

const created: string[] = [];

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-module-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('run', () => {
  it('--dry-run prints the tree and every file, and writes nothing', () => {
    const cwd = tempWorkspace();
    const result = run(['demo-thing', '--dry-run'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'create-module demo-thing --dry-run (@app/demo-thing) — nothing written',
    );
    expect(result.stdout).toContain('packages/demo-thing\n├── package.json\n');
    expect(result.stdout).toContain('└── src/module.test.ts');
    expect(result.stdout).toContain('--- packages/demo-thing/src/contract.ts ---');
    expect(result.stdout).toContain("export const DemoThingModule = moduleRef('demo-thing');");
    expect(fs.existsSync(path.join(cwd, 'packages'))).toBe(false);
  });

  it('writes the tree and reports what it wrote', () => {
    const cwd = tempWorkspace();
    const result = run(['demo-thing'], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'create-module: wrote 7 files to packages/demo-thing (@app/demo-thing)',
    );
    expect(fs.readFileSync(path.join(cwd, 'packages/demo-thing/src/module.ts'), 'utf8')).toContain(
      "export const module = defineModule({",
    );
    // The generated module carries no hand-written HMR code; the next steps
    // name only what a generated module actually needs.
    expect(result.stdout).toContain('  3. pnpm verify');
  });

  it('refuses to overwrite an existing module directory', () => {
    const cwd = tempWorkspace();
    expect(run(['demo-thing'], { cwd }).code).toBe(0);

    const second = run(['demo-thing'], { cwd });
    expect(second.code).toBe(1);
    expect(second.stdout).toBe('');
    expect(second.stderr).toBe(
      "create-module: 'packages/demo-thing' already exists. Refusing to overwrite a module that is " +
        'already on disk — generated files are a starting point, not a migration. Delete it first, or ' +
        'choose a different id or --dir.\n',
    );
  });

  it('refuses before writing anything when the directory exists', () => {
    const cwd = tempWorkspace();
    fs.mkdirSync(path.join(cwd, 'packages/demo-thing'), { recursive: true });

    expect(run(['demo-thing'], { cwd }).code).toBe(1);
    expect(fs.readdirSync(path.join(cwd, 'packages/demo-thing'))).toEqual([]);
  });

  it('--dry-run also refuses when the directory exists, rather than printing a lie', () => {
    const cwd = tempWorkspace();
    fs.mkdirSync(path.join(cwd, 'packages/demo-thing'), { recursive: true });

    const result = run(['demo-thing', '--dry-run'], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^create-module: 'packages\/demo-thing' already exists\./);
  });

  it('accepts --depends-on repeated and comma-separated', () => {
    const cwd = tempWorkspace();
    const result = run(
      ['orders', '--dry-run', '--depends-on', 'auth,payments', '--depends-on', 'debug'],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dependsOn: [AuthModule, PaymentsModule, DebugModule],');
  });

  it('reports an unknown flag with the usage text, and exits 1', () => {
    const result = run(['demo-thing', '--nope'], { cwd: tempWorkspace() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option '--nope'");
    expect(result.stderr).toContain('Usage: pnpm create-module <id> [options]');
  });

  it('principle 5: rejects more than one id', () => {
    const result = run(['orders', 'payments'], { cwd: tempWorkspace() });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "create-module: expected exactly one module id, got 2 ('orders', 'payments'). One generator, " +
        'one module (principle 5).\n',
    );
  });

  it('--help prints usage and exits 0', () => {
    const result = run(['--help'], { cwd: tempWorkspace() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm create-module <id> [options]');
  });
});
