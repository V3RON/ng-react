// **Acceptance criterion 9** (spec §15.9):
//
// > Bundle check: with all modules `lazy` except `auth`, no implementation
// > file of a lazy module is evaluated before its activation trigger
// > (verified via evaluation-order instrumentation in dev).
//
// ---
//
// ### Why this criterion is **one** test, in a file of its own
//
// `recordEvaluation` is called at the **top level** of each implementation
// file, so it fires exactly once per module-graph instance: the second import
// of `orders/providers.ts` is an ES module cache hit and records nothing.
// That is the correct behaviour for the thing being measured — D1 is about
// *evaluation*, and a cached module is not evaluated again — but it makes the
// measurement single-use.
//
// Two consequences, both structural rather than stylistic:
//
//  - **One file.** Vitest isolates module registries per test file, so a
//    sibling test that activated `orders` first would leave this one
//    measuring a log that was already spent. This criterion therefore owns
//    its file, and nothing above imports anything but contracts and
//    descriptors.
//  - **One test.** A second test in this file would start with every
//    implementation file already cached and would see an empty log — which
//    is exactly the vacuous green this project has shipped three times. So
//    the whole sequence (registration → startup → one trigger → a second,
//    independent trigger) runs as one test against one kernel, with the log
//    asserted at each step.
//
// The guard is the first assertion: an empty log before anything activates.
// If a future edit pulls an implementation file in at the top of this file,
// that assertion fails rather than the criterion quietly passing on nothing.

import { describe, expect, it } from 'vitest';
import { createTestKernel, evaluationLog } from '@ng-react/kernel';
import type { ModuleDescriptor } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { NavModule } from '@app/nav/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { appModules } from '../composition-root';
import { variantOf } from './modules';

/**
 * The whole app, with every module `lazy` except `auth` — the criterion's
 * exact premise, applied to the real composition root rather than to a
 * hand-picked subset. `debug` is included and forced lazy too, so its
 * deliberate failure cannot happen during this test at all.
 */
function allLazyExceptAuth(): readonly ModuleDescriptor[] {
  return appModules.map((descriptor) =>
    descriptor.id === AuthModule
      ? variantOf(AuthModule, { load: 'eager' })
      : variantOf(descriptor.id, { load: 'lazy' }),
  );
}

/** Every implementation file recorded so far, in order. */
const filesIn = (log: readonly { readonly file: string }[]): readonly string[] =>
  log.map((event) => event.file).filter((file) => !file.startsWith('<'));

describe('acceptance criterion 9 — nothing lazy is evaluated before its trigger', () => {
  it('D1/A1: with everything lazy but auth, each module\'s files arrive at its own trigger', async () => {
    const kernel = createTestKernel({ modules: allLazyExceptAuth() });

    // **The vacuity guard.** See the file header: if anything had already
    // pulled an implementation file in, every "not yet evaluated" assertion
    // below would be meaningless.
    expect(filesIn(evaluationLog(kernel))).toEqual([]);
    expect(kernel.status(OrdersModule)).toBe('registered');
    expect(kernel.status(PaymentsModule)).toBe('registered');
    expect(kernel.status(NavModule)).toBe('registered');

    // ---- step 1: startup. Only `auth` is eager. -------------------------
    await kernel.whenStartupComplete();

    // **D1**: "the descriptor and its static fields must be evaluable without
    // evaluating any implementation file." A whole composition root was
    // registered and exactly one module's files were touched.
    // The `<providers>`/`<init>` markers are the kernel's own phase
    // boundaries, so this asserts the *order within* the activation as well
    // as its contents: the providers thunk runs to completion before `init`
    // starts, which is what makes `ctx.get` inside `init` resolvable (§6
    // step 2). There is no `<activate>` marker because nothing called
    // `kernel.activate` — the eager pass is the trigger here.
    expect(evaluationLog(kernel).map((event) => event.file)).toEqual([
      '<providers>',
      'auth/providers.ts',
      '<init>',
      'auth/lifecycle.ts',
    ]);

    // ---- step 2: one trigger, `orders`. --------------------------------
    await kernel.activate(OrdersModule);

    // **A1**: `payments` came up transitively and its files were evaluated
    // *before* `orders`' — "a lazy module being activated must never observe
    // a dependency that is registered but not ready" is an ordering claim,
    // and this is the order.
    expect(filesIn(evaluationLog(kernel))).toEqual([
      'auth/providers.ts',
      'auth/lifecycle.ts',
      'payments/providers.ts',
      'payments/lifecycle.ts',
      'orders/providers.ts',
      'orders/lifecycle.ts',
    ]);

    // Nothing else. `nav`, `shell` and `debug` are registered and untriggered,
    // and *this* is the criterion: an implementation file that is not needed
    // is not evaluated, which is what makes `lazy` mean anything to a bundler.
    for (const prefix of ['nav/', 'shell/', 'debug/']) {
      expect(filesIn(evaluationLog(kernel)).some((file) => file.startsWith(prefix))).toBe(false);
    }
    expect(kernel.status(NavModule)).toBe('registered');

    // ---- step 3: a second, independent trigger. ------------------------
    // `nav` and `shell` both contribute to the route collection and neither
    // depends on the other — exactly the pair a `dependsOn`-shaped assumption
    // would get wrong. Activating `nav` must bring `nav` and nothing else.
    await kernel.activate(NavModule);

    expect(filesIn(evaluationLog(kernel))).toEqual([
      'auth/providers.ts',
      'auth/lifecycle.ts',
      'payments/providers.ts',
      'payments/lifecycle.ts',
      'orders/providers.ts',
      'orders/lifecycle.ts',
      // `nav` declares no `init`, so there is no `nav/lifecycle.ts` to
      // evaluate — the absence is the descriptor's shape (D4), not a missed
      // record.
      'nav/providers.ts',
    ]);
    expect(kernel.status(NavModule)).toBe('ready');
    expect(filesIn(evaluationLog(kernel)).some((file) => file.startsWith('shell/'))).toBe(false);

    await kernel.dispose();
  });
});
