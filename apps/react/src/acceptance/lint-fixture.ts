// Runs the **real** ESLint over a checked-in fixture directory, through the
// **real** root `eslint.config.js`.
//
// Modelled on `packages/eslint-config-modules/src/no-cycle.test.ts`, which is
// the precedent this repo settled on after issue #43: a `RuleTester` case
// proves a rule works *given a graph*, and what has actually broken here
// twice is everything that must be true before a rule sees one — resolver,
// extension allowlist, parser, `exports` maps, and the root config wiring the
// preset in by package name. So: real ESLint, real files on disk, real config.
//
// `ignore: false` is load-bearing. The fixture directories live under
// `packages/eslint-config-modules/__fixtures__/`, which the root config
// ignores outright — a repo whose `pnpm lint` always failed would be a repo
// whose lint is ignored — and without this flag every lint below would return
// zero results and every assertion built on it would be vacuous. `lintedFiles`
// exists so a test can say so out loud.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * Repo root, derived from this file's own location — no `cwd` assumption, so
 * this works whether vitest is run from the root or from `apps/react`.
 *
 * **`fileURLToPath`, not `new URL('.', import.meta.url).pathname`.** These
 * tests run in the `demo` project, which is jsdom, and jsdom installs its own
 * WHATWG `URL` whose base resolution here yields `/src/acceptance` rather
 * than the file's real directory — silently, and the resulting root is `/`.
 * `node:url`'s helper is not shadowed by the DOM environment.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** One reported problem, flattened to something a test can assert on directly. */
export interface LintMessage {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Lints one repo-relative glob through the real root config, ignores disabled. */
export async function lintPath(relativeGlob: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
    ignore: false,
  });
  return eslint.lintFiles([path.join(repoRoot, relativeGlob)]);
}

/** Lints `<repo>/packages/eslint-config-modules/__fixtures__/<name>/**\/*.ts`. */
export async function lintFixture(name: string): Promise<ESLint.LintResult[]> {
  return lintPath(path.join('packages/eslint-config-modules/__fixtures__', name, '**/*.ts'));
}

/** Which files ESLint actually looked at, by basename, sorted. The vacuity guard. */
export function lintedFiles(results: readonly ESLint.LintResult[]): readonly string[] {
  return results.map((result) => path.basename(result.filePath)).sort();
}

/** Every problem `ruleId` reported, in file order. */
export function messagesFor(
  results: readonly ESLint.LintResult[],
  ruleId: string,
): readonly LintMessage[] {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === ruleId)
      .map((message) => ({
        file: path.basename(result.filePath),
        line: message.line,
        message: message.message,
      })),
  );
}
