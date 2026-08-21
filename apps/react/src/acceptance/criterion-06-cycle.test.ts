// **Acceptance criterion 6** (spec §15.6):
//
// > A cycle introduced between two modules fails at lint time via contract
// > import cycle detection and, if forced past lint, at registration with the
// > G1 message listing the exact cycle.
//
// Two independent defences, and the criterion is explicit that both must
// hold — "if forced past lint" is the second half's whole premise. So there
// are two tests, and neither stands in for the other.
//
// The lint half runs the real ESLint over a real two-file contract cycle
// (`__fixtures__/contract-cycle/`); see `lint-fixture.ts` for why it is not a
// `RuleTester` suite. It could not have been written before #44: the resolver
// could not resolve `.ts`, so `import-x/no-cycle` had no graph to walk and
// silently passed a planted cycle for the whole of stage 7 (issues #43/#44,
// spec §17).

import { describe, expect, it } from 'vitest';
import { createKernel, defineModule, DependencyCycleError, moduleRef } from '@ng-react/kernel';
import { lintedFiles, lintFixture, messagesFor } from './lint-fixture';
import { SPEC_G1_MESSAGE } from './spec-text';

describe('acceptance criterion 6 — a cycle between two modules', () => {
  it('B3: the contract import cycle is reported by the root ESLint config', async () => {
    const results = await lintFixture('contract-cycle');

    // **The vacuity guard, and it is not optional here.** The fixture is
    // inside a directory the root config ignores; a glob typo, a moved file,
    // or a dropped `ignore: false` would make ESLint match nothing and every
    // assertion below would pass having linted zero files. This is the exact
    // shape of failure issue #43 shipped for a whole stage.
    expect(lintedFiles(results)).toEqual(['contract.ts', 'contract.ts']);

    expect(messagesFor(results, 'import-x/no-cycle')).toEqual([
      { file: 'contract.ts', line: 20, message: 'Dependency cycle detected' },
      { file: 'contract.ts', line: 5, message: 'Dependency cycle detected' },
    ]);

    // Errors, not warnings — the criterion says the cycle "fails at lint
    // time", and a warning does not fail anything.
    for (const result of results) {
      expect(result.errorCount).toBeGreaterThan(0);
    }
  });

  it('B3: no-cycle fires because of a real graph, not because nothing resolved', async () => {
    // The second half of #43's lesson, and the reason `no-unresolved` is in
    // the preset at all: a resolver that silently stops resolving takes
    // `no-cycle` down with it and nothing else notices. If `no-unresolved`
    // fired on this fixture, the test above would be asserting that a rule
    // reported a cycle it could not possibly have seen.
    const results = await lintFixture('contract-cycle');
    expect(messagesFor(results, 'import-x/no-unresolved')).toEqual([]);
  });

  it('G1: forced past lint, registration is fatal and prints the full cycle in order', () => {
    // "Forced past lint" made literal: two descriptors whose `dependsOn`
    // close a loop. Nothing lints a runtime value, so this is the state the
    // kernel has to defend against on its own.
    const orders = moduleRef('orders');
    const payments = moduleRef('payments');

    expect(() =>
      createKernel({
        modules: [
          defineModule({ id: orders, dependsOn: [payments] }),
          defineModule({ id: payments, dependsOn: [orders] }),
        ],
      }),
    ).toThrow(DependencyCycleError);

    let error: DependencyCycleError | undefined;
    try {
      createKernel({
        modules: [
          defineModule({ id: orders, dependsOn: [payments] }),
          defineModule({ id: payments, dependsOn: [orders] }),
        ],
      });
    } catch (thrown) {
      error = thrown as DependencyCycleError;
    }

    expect(error?.message).toBe(
      'Module dependency cycle: orders → payments → orders. ' +
        'Break it by moving the shared surface into a contract.',
    );
    // "listing the exact cycle" — the ids, in order, as data and not only as
    // prose. The message repeats the first id at the end to show closure;
    // `cycle` does not.
    expect(error?.cycle).toEqual(['orders', 'payments']);
  });

  it('G1: the message is the spec\'s quoted message, diffed against the document', () => {
    // Spec §9 quotes G1 verbatim for a **three**-module cycle, so the
    // three-module case is the one that can be diffed byte-for-byte against
    // `docs/spec/01-kernel-and-module-system.md`. (`SPEC_G1_MESSAGE` is read
    // out of the document at test time — see `spec-text.ts`.)
    const orders = moduleRef('orders');
    const payments = moduleRef('payments');
    const risk = moduleRef('risk');

    let message = '';
    try {
      createKernel({
        modules: [
          defineModule({ id: orders, dependsOn: [payments] }),
          defineModule({ id: payments, dependsOn: [risk] }),
          defineModule({ id: risk, dependsOn: [orders] }),
        ],
      });
    } catch (thrown) {
      message = (thrown as Error).message;
    }

    expect(message).toBe(SPEC_G1_MESSAGE);
    expect(message).toBe(
      'Module dependency cycle: orders → payments → risk → orders. ' +
        'Break it by moving the shared surface into a contract.',
    );
  });

  it('D3: the degenerate one-module cycle never reaches G1 — defineModule rejects it first', () => {
    // A module depending on itself is the case a path-building implementation
    // renders as `orders → orders → orders`, or as an empty path, or not at
    // all. It never gets that far: `defineModule` refuses the descriptor, so
    // the diagnosis names the offending field rather than describing a graph
    // the developer never meant to draw. Asserted because "G1 handles it"
    // would have been a reasonable and wrong thing to assume.
    const orders = moduleRef('orders');
    expect(() => defineModule({ id: orders, dependsOn: [orders] })).toThrow(
      "defineModule(orders): dependsOn[0] is the module's own ref ('orders'). " +
        'A module cannot depend on itself.',
    );
  });
});
