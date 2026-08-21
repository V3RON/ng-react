// B3 regression test for issue #43.
//
// Deliberately NOT a `RuleTester` suite. `import-x/no-cycle` is import-x's
// rule, not ours; a rule-tester case would prove that *their* rule works given
// a graph, which was never in doubt. What broke here is everything that has to
// be true before the rule sees a graph at all — resolver, extension allowlist,
// parser, `exports` maps, the root config wiring the preset in by package name.
// So this test runs the real ESLint, over real files on disk, loading the real
// root `eslint.config.js`, and asserts the cycle is reported.
//
// The fixture lives under `__fixtures__/no-cycle/` and is excluded from the
// root `eslint .` (a repo whose lint always fails is a repo whose lint is
// ignored). `ignore: false` below is what puts it back in scope for this run,
// so the fixture is genuinely reached rather than silently skipped.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixtureDir = path.resolve(here, '../__fixtures__/no-cycle');

const lintFixture = async (): Promise<ESLint.LintResult[]> => {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
    ignore: false,
  });
  return eslint.lintFiles([path.join(fixtureDir, '*.ts')]);
};

const messagesFor = (results: ESLint.LintResult[], ruleId: string) =>
  results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === ruleId)
      .map((message) => `${path.basename(result.filePath)}:${message.line} ${message.message}`),
  );

describe('B3: import-x/no-cycle runs across the workspace (issue #43)', () => {
  it('B3: the two-file fixture cycle is reported as an error by the root ESLint config', async () => {
    const results = await lintFixture();

    // Guard against the fixture silently falling out of scope: if ESLint
    // matched no files, or matched them and had nothing to say, the assertion
    // below would be vacuous rather than failing for the right reason.
    expect(results.map((r) => path.basename(r.filePath)).sort()).toEqual([
      'session-service.ts',
      'token-store.ts',
    ]);

    expect(messagesFor(results, 'import-x/no-cycle')).toEqual([
      'session-service.ts:14 Dependency cycle detected',
      'token-store.ts:3 Dependency cycle detected',
    ]);

    for (const result of results) {
      expect(result.errorCount).toBeGreaterThan(0);
    }
  });

  it('B3: the fixture cycle resolves — no-cycle fires because of a real graph, not an unresolved import', async () => {
    // The failure mode this whole issue is about is a rule that is silent
    // because nothing resolved. If `no-unresolved` fired on the fixture, the
    // assertion above would be testing the wrong thing.
    const results = await lintFixture();

    expect(messagesFor(results, 'import-x/no-unresolved')).toEqual([]);
  });
});
