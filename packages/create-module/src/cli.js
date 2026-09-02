// The `create-module` command line (spec §13 B4).
//
// `node:util`'s `parseArgs` rather than a dependency: AGENTS.md keeps this
// workspace's runtime dependency count at zero, and the flag set below is
// small enough that a parser earns nothing.
//
// Everything that can fail throws `CreateModuleError` with a message that
// names the rule it enforces; `run()` returns an exit code and the text to
// print rather than calling `process.exit` itself, so the whole CLI is
// testable without spawning a process.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { CreateModuleError } from './errors.js';
import { generateModule } from './generate.js';

const USAGE = `Usage: pnpm create-module <id> [options]

Emits a module package carrying every blessed pattern in spec 01 (§13 B4):
the §4 exports map, the contract/module split, ADR-7 thunks, C4/C5/C7/H3
providers, an L2 lifecycle with no hand-written dispose, and an R4
createTestKernel test. The emitted module.ts carries no HMR code of its own —
hot updates for it are wired by the bundler plugins (@ng-react/vite-plugin
for Vite, the Metro Babel plugin for React Native), not by generated code.

Options:
  --scope <scope>        npm scope for the package name (default: @app)
  --dir <dir>            workspace directory to create the package in (default: packages)
  --load <eager|lazy>    spec §6 load strategy (default: lazy)
  --critical             §10: startup fails visibly if this module fails
  --depends-on <ids>     comma-separated dependency ids (repeatable)
  --dry-run              print the tree and every file's contents; write nothing
  --help                 print this message

After generating, run \`pnpm install\` so the new package joins the workspace,
then wire it into the composition root:

  import { module as exampleModule } from '@app/example/module';
  const kernel = createKernel({ modules: [exampleModule] });
`;

/** @typedef {{ readonly code: number, readonly stdout: string, readonly stderr: string }} RunResult */

/**
 * Parses `argv`, generates, and either writes the tree or renders it.
 *
 * @param {readonly string[]} argv arguments after the script name.
 * @param {{ cwd?: string }} [options] `cwd` is the workspace root the emitted
 *   paths are resolved against. Default `process.cwd()` — which is the repo
 *   root, because `pnpm create-module` runs root scripts from there.
 * @returns {RunResult}
 */
export function run(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        scope: { type: 'string' },
        dir: { type: 'string' },
        load: { type: 'string' },
        critical: { type: 'boolean' },
        'depends-on': { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });

    if (parsed.values.help === true) {
      return { code: 0, stdout: USAGE, stderr: '' };
    }
    if (parsed.positionals.length > 1) {
      throw new CreateModuleError(
        `create-module: expected exactly one module id, got ${parsed.positionals.length} ` +
          `(${parsed.positionals.map((value) => `'${value}'`).join(', ')}). One generator, one module ` +
          `(principle 5).`,
      );
    }

    const dependsOn = (parsed.values['depends-on'] ?? [])
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const generated = generateModule({
      id: /** @type {string} */ (parsed.positionals[0]),
      ...(parsed.values.scope === undefined ? {} : { scope: parsed.values.scope }),
      ...(parsed.values.dir === undefined ? {} : { dir: parsed.values.dir }),
      ...(parsed.values.load === undefined
        ? {}
        : { load: /** @type {'eager' | 'lazy'} */ (parsed.values.load) }),
      ...(parsed.values.critical === undefined ? {} : { critical: parsed.values.critical }),
      dependsOn,
    });

    const target = path.resolve(cwd, generated.dir);
    if (fs.existsSync(target)) {
      throw new CreateModuleError(
        `create-module: '${generated.dir}' already exists. Refusing to overwrite a module that is already ` +
          `on disk — generated files are a starting point, not a migration. Delete it first, or choose a ` +
          `different id or --dir.`,
      );
    }

    if (parsed.values['dry-run'] === true) {
      return { code: 0, stdout: renderDryRun(generated), stderr: '' };
    }

    for (const file of generated.files) {
      const absolute = path.resolve(cwd, file.path);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, file.contents, 'utf8');
    }
    return { code: 0, stdout: renderCreated(generated), stderr: '' };
  } catch (error) {
    if (error instanceof CreateModuleError) {
      return { code: 1, stdout: '', stderr: `${error.message}\n` };
    }
    // `parseArgs` throws a plain `TypeError` for an unknown option; its
    // message is already actionable ("Unknown option '--nope'"), so it is
    // passed through rather than reworded, with the usage line appended.
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: '', stderr: `create-module: ${message}\n\n${USAGE}` };
  }
}

/**
 * @param {import('./generate.js').GeneratedModule} generated
 */
function renderDryRun(generated) {
  const lines = [
    `create-module ${generated.id} --dry-run (${generated.packageName}) — nothing written`,
    '',
    generated.dir,
  ];
  for (const [index, file] of generated.files.entries()) {
    const last = index === generated.files.length - 1;
    lines.push(`${last ? '└──' : '├──'} ${file.path.slice(generated.dir.length + 1)}`);
  }
  for (const file of generated.files) {
    lines.push('', `--- ${file.path} ---`, file.contents.replace(/\n$/, ''));
  }
  lines.push('', ...nextSteps(generated));
  return `${lines.join('\n')}\n`;
}

/**
 * @param {import('./generate.js').GeneratedModule} generated
 */
function renderCreated(generated) {
  return `${[
    `create-module: wrote ${generated.files.length} files to ${generated.dir} (${generated.packageName})`,
    ...generated.files.map((file) => `  ${file.path}`),
    '',
    ...nextSteps(generated),
  ].join('\n')}\n`;
}

/**
 * @param {import('./generate.js').GeneratedModule} generated
 * @returns {string[]}
 */
function nextSteps(generated) {
  return [
    'Next:',
    '  1. pnpm install                 # the package joins the workspace and links @ng-react/kernel',
    `  2. add ${generated.packageName}/module to the composition root's module list`,
    '  3. pnpm verify',
  ];
}
