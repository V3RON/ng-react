// **Acceptance criterion 2** (spec §15.2):
//
// > Type-level test: a string literal or a ref with a mismatched type in
// > `dependsOn` fails compilation; a ref for a module missing from the
// > composition root fails registration with the G2 message.
//
// Two halves with two different judges. The compile half is judged by
// `tsc --noEmit` (`pnpm typecheck`), not by vitest: each `@ts-expect-error`
// below is an assertion that the next line **does** fail to compile, and TS
// reports an *unused* `@ts-expect-error` as an error of its own — so if
// `dependsOn` ever started accepting a string, this file would stop
// type-checking. Vitest merely runs the runtime half.

import { describe, expect, it } from 'vitest';
import { createKernel, defineModule, moduleRef, UnknownModuleError } from '@ng-react/kernel';
import { AuthModule, SessionServiceToken } from '@app/auth/contract';
import { OrdersModule } from '@app/orders/contract';
import { PaymentsModule } from '@app/payments/contract';
import { descriptorFor } from './modules';

describe('acceptance criterion 2 — typed dependsOn', () => {
  it('M2/D3: a string literal in dependsOn does not compile, and does not run either', () => {
    expect(() =>
      defineModule({
        id: OrdersModule,
        // **M2**: "because a dependency is expressed by importing the ref
        // from the target module's contract, a typo is a compile error".
        // Revision 2 of the spec replaced string ids with refs to get this.
        // @ts-expect-error — 'auth' is a string, not a ModuleRef.
        dependsOn: ['auth'],
      }),
    ).toThrow("defineModule(orders): dependsOn[0] is not a ModuleRef, got string 'auth'.");

    expect(() =>
      defineModule({
        id: OrdersModule,
        // The near-miss that matters more than the typo: a *correctly
        // spelled* id is still not a ref.
        // @ts-expect-error — a correct id string is still not a ModuleRef.
        dependsOn: [AuthModule.id],
      }),
    ).toThrow("defineModule(orders): dependsOn[0] is not a ModuleRef, got string 'auth'.");
  });

  it('M1/D3: a differently-typed value in dependsOn does not compile, and does not run either', () => {
    expect(() =>
      defineModule({
        id: OrdersModule,
        // A `Token` is the other value identity in this system and the one a
        // reader is most likely to reach for by mistake. `ModuleRef`'s brand
        // is a module-private symbol, so no other branded type satisfies it.
        // @ts-expect-error — a Token is not a ModuleRef.
        dependsOn: [SessionServiceToken],
      }),
    ).toThrow('defineModule(orders): dependsOn[0] is not a ModuleRef, got object.');

    expect(() =>
      defineModule({
        id: OrdersModule,
        // And a hand-rolled object of the right *shape* is still rejected:
        // M1's "unique value identity" is nominal, not structural, which is
        // what makes `kernel.activate` impossible to call with a forgery —
        // the compile error above and this throw are the same guarantee seen
        // from either side of the type system.
        // @ts-expect-error — structurally ref-shaped, but unbranded.
        dependsOn: [{ id: 'auth' }],
      }),
    ).toThrow('defineModule(orders): dependsOn[0] is not a ModuleRef, got object.');
  });

  it('M1/D3: the real refs do compile — the control for the three cases above', () => {
    // Without this, all three `@ts-expect-error`s above could be passing
    // because `dependsOn` rejects *everything*, which would be a different
    // bug wearing the same green tick.
    const descriptor = defineModule({
      id: OrdersModule,
      dependsOn: [AuthModule, PaymentsModule],
    });
    expect(descriptor.dependsOn).toEqual([AuthModule, PaymentsModule]);
  });

  it('G2: a ref missing from the composition root fails registration, naming both modules', () => {
    // The real `orders` descriptor, registered on its own — which is exactly
    // what a composition root that forgot a line looks like. G2's own text:
    // "this now indicates a composition-root omission rather than a typo,
    // since typos no longer compile" — i.e. the test above and this one are
    // the two halves G2 was reworded around.
    const register = (): unknown => createKernel({ modules: [descriptorFor(OrdersModule)] });

    expect(register).toThrow(UnknownModuleError);

    let message = '';
    try {
      register();
    } catch (error) {
      message = (error as Error).message;
    }

    // **Asserted as an exact string.** Spec §9 G2, unlike G1 and C8, quotes
    // no message of its own — it requires only that the error name "the
    // missing module id and the dependent" — so there is nothing in the
    // document to diff against and this literal is the contract. Recorded in
    // `docs/acceptance.md`; the two clauses G2 does state are asserted
    // separately below so a reworded sentence still fails for the right
    // reason.
    expect(message).toBe(
      "Module 'orders' depends on 'auth', which was not registered with the kernel. " +
        'Add its descriptor to the composition root.',
    );
    expect(message).toContain("'orders'");
    expect(message).toContain("'auth'");
  });

  it('G2: it is the missing ref that is reported, not the first ref in the list', () => {
    // `orders` dependsOn [auth, payments]. Registering it with `auth` present
    // and `payments` absent must name `payments` — an implementation that
    // reported the first unresolved edge it happened to visit would pass the
    // test above and fail this one.
    const register = (): unknown =>
      createKernel({ modules: [descriptorFor(AuthModule), descriptorFor(OrdersModule)] });

    expect(register).toThrow(
      "Module 'orders' depends on 'payments', which was not registered with the kernel. " +
        'Add its descriptor to the composition root.',
    );
  });

  it('G2: a ref that no descriptor anywhere declares is the same error', () => {
    // The other shape of the same omission: a module that was never written,
    // rather than one that was written and left out of the list.
    const ghost = moduleRef('reporting');
    expect(() =>
      createKernel({
        modules: [defineModule({ id: OrdersModule, dependsOn: [ghost] })],
      }),
    ).toThrow(
      "Module 'orders' depends on 'reporting', which was not registered with the kernel. " +
        'Add its descriptor to the composition root.',
    );
  });
});
