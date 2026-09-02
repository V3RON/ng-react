// `@app/dashboard` — the module's own test, against `createTestKernel` (**R4**).
//
// R4 is the harness the spec names for exactly this: "activate a module with
// mocked providers (via `override: true`), drive its lifecycle, dispose, and
// assert via `kernel.inspect()` and H7-style leak counters that nothing
// survived". It runs in a plain node environment with **no React renderer** —
// acceptance criterion 7 — which is why every assertion below is about the
// *collection* and none is about rendered output. The rendered half lives in
// `apps/react/src/shell/dashboard.test.tsx`, where there is a DOM.
//
// **Sequences, not membership.** Every claim about C5's reactivity here is
// asserted as an ordered list of collection snapshots recorded by
// `subscribeAll`. A membership assertion ("the card is there now") passes just
// as well against a collection that is rebuilt from scratch on every read, and
// would not notice a missing notification at all.

import { describe, expect, it } from 'vitest';
import { contribute, createTestKernel, defineModule, evaluationLog, moduleRef } from '@ng-react/kernel';
import type { AnyProviderRecord, Kernel } from '@ng-react/kernel';
import { DashboardCardToken, DashboardModule } from './contract';
import { module } from './module';

/**
 * Two stand-in contributors, and **stand-ins rather than the real feature
 * modules on purpose**: `@app/orders` and `@app/debug` are reachable from a
 * test only through their contracts (**B1** reserves `<pkg>/module` for the
 * composition root), and registering them would make this a test of them too.
 * The demo-level suite exercises the real ones.
 *
 * They contribute *differently ordered* cards so the sort below has something
 * to do, and `alpha` contributes **two** cards so within-module declaration
 * order is exercised as well as between-module order — the case where C5's
 * "declaration order within a module" could drift unnoticed.
 */
const AlphaModule = moduleRef('alpha');
const BetaModule = moduleRef('beta');

/** A card body. Never rendered here — this project has no renderer (criterion 7). */
function EmptyCard(): null {
  return null;
}

function cardsOf(ids: readonly (readonly [string, number | undefined])[]): AnyProviderRecord[] {
  return ids.map(([id, order]) =>
    contribute(DashboardCardToken, {
      factory: () => ({
        id,
        title: id,
        component: EmptyCard,
        ...(order === undefined ? {} : { order }),
      }),
    }),
  );
}

const alphaModule = defineModule({
  id: AlphaModule,
  dependsOn: [],
  load: 'lazy',
  critical: false,
  // `alpha/late` carries no `order` at all, so it must sort after every
  // ordered card regardless of where C5 puts it.
  providers: () => cardsOf([['alpha/first', 2], ['alpha/late', undefined]]),
});

const betaModule = defineModule({
  id: BetaModule,
  dependsOn: [],
  load: 'lazy',
  critical: false,
  // Same `order` as `alpha/first`, and registered by a *later* module: the tie
  // must break on C5's order, which puts `alpha/first` first.
  providers: () => cardsOf([['beta/tied', 2]]),
});

/**
 * A contributor whose `init` throws — the F3 subject, and shaped after
 * `@app/debug`. **`init` and not `providers`**: the providers thunk has to
 * succeed, or the card would never be registered and the sequence below could
 * not tell quarantine apart from silence.
 */
const brokenModule = defineModule({
  id: moduleRef('broken'),
  dependsOn: [],
  load: 'lazy',
  critical: false,
  providers: () => cardsOf([['broken/card', 0]]),
  init: () => {
    throw new Error('broken: init fails on purpose (F1/F3).');
  },
});

/** Records every notification `subscribeAll` delivers, as card-id lists. */
function recordCards(kernel: Kernel): readonly (readonly string[])[] {
  const seen: (readonly string[])[] = [];
  kernel.subscribeAll(DashboardCardToken, (cards) => {
    seen.push(cards.map((card) => card.id));
  });
  return seen;
}

/** `(order ?? Infinity, C5 index)` — the rule `screen.web.tsx` renders by. */
function ordered(kernel: Kernel): readonly string[] {
  return kernel
    .getAll(DashboardCardToken)
    .map((card, index) => ({ card, index }))
    .sort(
      (left, right) =>
        (left.card.order ?? Number.POSITIVE_INFINITY) -
          (right.card.order ?? Number.POSITIVE_INFINITY) || left.index - right.index,
    )
    .map(({ card }) => card.id);
}

describe('dashboard module', () => {
  it('D1 / criterion 9: nothing is evaluated until the activation trigger, then in order', async () => {
    const kernel = createTestKernel({ modules: [module] });
    expect(kernel.status(DashboardModule)).toBe('registered');

    // Registration is cheap: the descriptor's static fields are readable
    // without any implementation file having been evaluated.
    expect(evaluationLog(kernel)).toEqual([]);

    await kernel.activate(DashboardModule);

    // This assertion is what makes the empty one above mean something. On its
    // own, an empty log is also what you get from a `module.ts` that imported
    // `./providers` at the top — that evaluation happens when *this test file*
    // is loaded, before any kernel exists to record it. The full sequence
    // below is not reproducible that way. There is no `<init>` step: **D4**,
    // the dashboard declares no `init`.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<activate>',
      '<providers>',
      'dashboard/providers.ts',
    ]);

    await kernel.dispose();
  });

  it('C5: the card collection grows on activation and shrinks on disposal — as a sequence', async () => {
    const kernel = createTestKernel({ modules: [module, alphaModule, betaModule] });
    await kernel.activate(DashboardModule);

    const seen = recordCards(kernel);
    // `subscribeAll` does not fire on subscribe (C5), so the first entry below
    // is the first *change*, not a snapshot of "now".
    expect(seen).toEqual([]);

    await kernel.activate(AlphaModule);
    await kernel.activate(BetaModule);
    await kernel.deactivate(AlphaModule);

    expect(seen).toEqual([
      ['alpha/first', 'alpha/late'],
      ['alpha/first', 'alpha/late', 'beta/tied'],
      ['beta/tied'],
    ]);

    await kernel.dispose();
  });

  it('the render order is (order ?? Infinity, C5 order), and the tie breaks on C5', async () => {
    const kernel = createTestKernel({ modules: [module, alphaModule, betaModule] });
    await kernel.activate(DashboardModule);
    await kernel.activate(AlphaModule);
    await kernel.activate(BetaModule);

    // C5's own order — the order `getAll` returns and the order the owner rows
    // in `inspect()` are aligned with.
    expect(kernel.getAll(DashboardCardToken).map((card) => card.id)).toEqual([
      'alpha/first',
      'alpha/late',
      'beta/tied',
    ]);

    // …and the order a person reads. `beta/tied` has the same `order` as
    // `alpha/first` and loses the tie to C5; `alpha/late` has no `order` and
    // sorts last despite being second in C5's order. Both halves would pass a
    // membership assertion.
    expect(ordered(kernel)).toEqual(['alpha/first', 'beta/tied', 'alpha/late']);

    await kernel.dispose();
  });

  it('C9: each card is attributed by the kernel, not by the card', async () => {
    const kernel = createTestKernel({ modules: [module, alphaModule, betaModule] });
    await kernel.activate(DashboardModule);
    await kernel.activate(AlphaModule);
    await kernel.activate(BetaModule);

    // `DashboardCard` has no `owner` field to check — that is the point. The
    // alignment `screen.web.tsx` depends on is that `inspect().contributions`
    // for this token is positionally aligned with `getAll`, including for
    // `alpha`, which contributes two cards.
    const fromInspect = kernel
      .inspect()
      .contributions.filter((row) => row.token === 'dashboard/DashboardCard')
      .map((row) => row.owner);
    expect(fromInspect).toEqual(['alpha', 'alpha', 'beta']);
    expect(kernel.getAll(DashboardCardToken).map((card) => card.id)).toEqual([
      'alpha/first',
      'alpha/late',
      'beta/tied',
    ]);

    await kernel.dispose();
  });

  it('F3: a quarantined module\'s card is withdrawn, not never-contributed', async () => {
    const kernel = createTestKernel({ modules: [module, brokenModule] });
    await kernel.activate(DashboardModule);

    const seen = recordCards(kernel);
    await expect(kernel.activate(brokenModule.id)).rejects.toThrow();

    // **This is the assertion that "the card is absent" cannot make.** A card
    // that was never contributed produces *no* notifications at all; this one
    // produces two, in this order: registered by the providers thunk, then
    // withdrawn when `init` threw and F3 quarantined the module. The absence
    // at the end is caused by the failure, and the sequence is the proof.
    expect(seen).toEqual([['broken/card'], []]);
    expect(kernel.status(brokenModule.id)).toBe('failed');
    expect(kernel.getAll(DashboardCardToken)).toEqual([]);

    await kernel.dispose();
  });
});
