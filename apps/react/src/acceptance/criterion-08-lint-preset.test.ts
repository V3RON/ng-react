// **Acceptance criterion 8** (spec §15.8):
//
// > The lint preset rejects: a deep import into another module's `src/`, a
// > value export from a contract beyond B2's allowlist, and `override: true`
// > inside a module package.
//
// Three cases, one fixture directory, and the imports in it name the **real**
// demo packages — `@app/orders`, `@app/auth`, `@app/payments` — so what is
// under test includes those packages' `exports` maps and the root config's
// `compositionRoot` glob, not only the rules in isolation. The rules' own
// `RuleTester` suites live in `packages/eslint-config-modules/src/rules/`;
// this file is the end-to-end half, run through the real root config.
//
// Messages are asserted **in full**. Principle 6 — "errors are a feature …
// error message quality is an acceptance criterion, not polish" — and a rule
// that fires with an unhelpful message has failed at what B1–B3 are for.

import { describe, expect, it } from 'vitest';
import { lintedFiles, lintFixture, lintPath, messagesFor } from './lint-fixture';

const FIXTURE = 'boundary-violations';

describe('acceptance criterion 8 — the boundary preset rejects all three', () => {
  it('the fixtures are actually linted — the guard for the three tests below', async () => {
    // Same reasoning as criterion 6's guard: the fixture directory is in the
    // root config's `ignores`, so a lint that quietly matched nothing would
    // make all three assertions below pass on an empty array.
    const results = await lintFixture(FIXTURE);
    expect(lintedFiles(results)).toEqual(['contract.ts', 'deep-import.ts', 'providers.ts']);
    for (const result of results) {
      expect(result.errorCount).toBeGreaterThan(0);
    }
  });

  it('B1: a deep import into another module package\'s src/ is an error', async () => {
    const results = await lintFixture(FIXTURE);

    expect(messagesFor(results, 'ng-react-modules/no-cross-module-deep-import')).toEqual([
      {
        file: 'deep-import.ts',
        line: 8,
        message:
          "'@app/orders/src/providers' imports past the module boundary of 'orders'. " +
          "Only 'orders/contract' may be imported from other modules " +
          "('orders/module' is reserved for the composition root). " +
          "Import '@app/orders/contract' instead.",
      },
      {
        file: 'deep-import.ts',
        line: 9,
        // Reaching `src/contract.ts` directly rather than through the
        // `./contract` subpath is the near-miss version, and it is rejected
        // for the same reason: it is the *exports map* that is the boundary,
        // not the filename.
        message:
          "'@app/auth/src/contract' imports past the module boundary of 'auth'. " +
          "Only 'auth/contract' may be imported from other modules " +
          "('auth/module' is reserved for the composition root). " +
          "Import '@app/auth/contract' instead.",
      },
    ]);
  });

  it('B1: and the resolver rejects the same deep imports independently of the rule', async () => {
    // Spec §4 makes the package resolver the **primary** enforcement and the
    // lint rule the backstop ("a backstop for resolvers that ignore
    // `exports`"). Both are asserted, because if only the rule fired, the
    // primary mechanism would be untested and a consumer with a different
    // lint config would have nothing at all.
    const results = await lintFixture(FIXTURE);
    expect(messagesFor(results, 'import-x/no-unresolved')).toEqual([
      {
        file: 'deep-import.ts',
        line: 8,
        message: "Unable to resolve path to module '@app/orders/src/providers'.",
      },
      {
        file: 'deep-import.ts',
        line: 9,
        message: "Unable to resolve path to module '@app/auth/src/contract'.",
      },
    ]);
  });

  it('B2: a value export from a contract beyond the allowlist is an error', async () => {
    const results = await lintFixture(FIXTURE);
    const expected = (name: string): string =>
      "Contract files may only export types, createToken()/moduleRef() calls imported from " +
      "'@ng-react/kernel', and event type declarations (spec §4, B2). " +
      `'${name}' is exported as a plain value. If this is meant to be the module ref or a token, ` +
      "import moduleRef/createToken from '@ng-react/kernel' — a locally defined function or " +
      'constant with the same name is not recognized.';

    // Both shapes of "implementation in a contract": a constant and a
    // function. The fixture's `moduleRef` and `createToken` exports are in
    // the same file and are *not* reported, which is the half that proves the
    // rule is an allowlist rather than a blanket ban on value exports.
    expect(messagesFor(results, 'ng-react-modules/contract-exports-allowlist')).toEqual([
      { file: 'contract.ts', line: 19, message: expected('DEFAULT_SESSION') },
      { file: 'contract.ts', line: 21, message: expected('normalize') },
    ]);
  });

  it('B3/C6: override: true inside a module package is an error', async () => {
    const results = await lintFixture(FIXTURE);

    expect(messagesFor(results, 'ng-react-modules/no-override-outside-composition-root')).toEqual([
      {
        file: 'providers.ts',
        line: 12,
        message:
          'override: true is only allowed in the composition root ' +
          '(**/apps/react/src/composition-root.ts) or test files ' +
          '(**/*.test.{ts,tsx}, **/test/**) (spec C6) — this call is in a module package. ' +
          'Move this override into the composition root, or remove override: true and change ' +
          'the provider being overridden instead.',
      },
    ]);
  });

  it('the real workspace is clean under the same config — the false-positive control', async () => {
    // Three rules that reject correct code are worth nothing. The demo's own
    // packages use every construct the fixtures abuse — cross-module contract
    // imports, `createToken`/`moduleRef` exports, `provide` without
    // `override` — and `pnpm lint` is green over all of them, which is this
    // suite's negative control. Asserted here as well as in CI so a reader of
    // this file sees both halves in one place.
    const results = await lintPath('packages/orders/src/*.{ts,tsx}');
    expect(lintedFiles(results)).toEqual([
      'contract.ts',
      'lifecycle.ts',
      'module.test.ts',
      'module.ts',
      'providers.ts',
      // Two screens since #52: `screen.web.tsx` and its `.native` sibling.
      // Both are linted, which is deliberate — a platform file that only the
      // *other* platform's build ever compiles is exactly where an
      // unnoticed boundary violation would live.
      'screen.native.tsx',
      'screen.web.tsx',
    ]);
    for (const result of results) {
      expect({ file: result.filePath, messages: result.messages }).toEqual({
        file: result.filePath,
        messages: [],
      });
    }
  });
});
