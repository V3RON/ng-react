// **Acceptance criterion 5** (spec §15.5):
//
// > Deleting a provider that `orders` depends on produces the C8 error
// > message verbatim quality: full chain plus actionable suggestion.
//
// The provider deleted is `payments/PaymentGateway` — spec §7.2 C8's own
// example, and the token `@app/payments`' contract already calls out as "the
// token acceptance criterion 5 deletes". The deletion is modelled by
// filtering that one record out of the module's **real** providers array, so
// everything else — the token labels, the resolution chain, `orders`' own
// `init` starting the chain — is the shipped code.
//
// ---
//
// ### The criterion asks for two things that cannot both be true at once
//
// C8's suggestion fires *only* when the failing token's module is "registered
// but … non-`dependsOn`" — that is what the sentence it appends says. But
// `orders` **does** declare `payments` in `dependsOn` (criterion 1 requires
// it to), so deleting the gateway while the declaration stands produces the
// full chain and **no** suggestion — correctly, because there is nothing to
// suggest: the dependency is already declared and the honest diagnosis is
// "the provider is gone", not "add a ref you already added".
//
// So the criterion's "full chain **plus** actionable suggestion" and the
// spec's own quoted example are reachable only from a graph in which `orders`
// does *not* declare `payments`. Both are asserted below, as two tests, and
// `docs/acceptance.md` records the discrepancy rather than picking one and
// calling the criterion discharged.

import { describe, expect, it } from 'vitest';
import { createTestKernel, ResolutionError } from '@ng-react/kernel';
import type { AnyProviderRecord, ModuleDescriptor } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { PaymentGatewayToken, PaymentsModule } from '@app/payments/contract';
import { OrdersModule } from '@app/orders/contract';
import { descriptorFor, variantOf } from './modules';
import { SPEC_C8_MESSAGE } from './spec-text';

/** `payments`, with `PaymentGatewayToken`'s provider deleted and nothing else changed. */
function paymentsWithoutTheGateway(): ModuleDescriptor {
  const real = descriptorFor(PaymentsModule);
  return variantOf(PaymentsModule, {
    providers: async (): Promise<AnyProviderRecord[]> => {
      const records = await (real.providers?.() ?? []);
      const remaining = records.filter((record) => record.token !== PaymentGatewayToken);
      // The deletion has to actually delete something. If the demo stopped
      // providing the gateway — or the token identity drifted — this suite
      // would otherwise "prove" C8 against a module that never had the
      // provider in the first place.
      if (remaining.length !== records.length - 1) {
        throw new Error(
          `Expected to delete exactly one provider of ${PaymentGatewayToken.label} from '@app/payments'; ` +
            `removed ${String(records.length - remaining.length)}.`,
        );
      }
      return remaining;
    },
  });
}

/** The `ResolutionError` (C8) at the root of `error`'s cause chain. */
function resolutionErrorIn(error: unknown): ResolutionError {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof ResolutionError) {
      return current;
    }
    current = current.cause;
  }
  throw new Error(`No ResolutionError in the cause chain of: ${String(error)}`);
}

/** Activates `orders` over the given module list and returns the failure the kernel retained (F1). */
async function failedActivation(modules: readonly ModuleDescriptor[]): Promise<ResolutionError> {
  const kernel = createTestKernel({ modules });
  await kernel.activate(OrdersModule).catch(() => {});

  // **F1**: the module is `failed` with the error retained. If this ever read
  // `ready`, the assertions below would be inspecting an error that the app
  // shrugged off.
  expect(kernel.status(OrdersModule)).toBe('failed');
  const routed = kernel.errors.at(0);
  expect(routed?.info.moduleId).toBe('orders');

  const error = resolutionErrorIn(routed?.error);
  await kernel.dispose();
  return error;
}

describe('acceptance criterion 5 — a deleted provider produces the C8 message', () => {
  it('C8: the failure reports the full chain, and the chain is the real token labels', async () => {
    const error = await failedActivation([
      descriptorFor(AuthModule),
      paymentsWithoutTheGateway(),
      descriptorFor(OrdersModule),
    ]);

    // "the full chain: requesting module, each token in the path, the token
    // that failed". The path is asserted structurally as well as through the
    // message, because the message is one `join` away from being right by
    // accident.
    expect(error.path).toEqual(['orders/OrderService', 'payments/PaymentGateway']);
    expect(error.message).toBe(
      'Cannot resolve orders/OrderService → payments/PaymentGateway: no provider.',
    );

    // **No suggestion, and that is correct.** `orders` declares `payments` in
    // `dependsOn`, so "add that module's ref to `dependsOn`" would be advice
    // to do something already done. See this file's header.
    expect(error.message).not.toContain('dependsOn of');
  });

  it('C8: with the dependency undeclared, the message is the spec\'s quoted example verbatim', async () => {
    const error = await failedActivation([
      descriptorFor(AuthModule),
      paymentsWithoutTheGateway(),
      // The one edit: `orders` no longer declares `payments`. Its providers
      // and `init` are untouched, so the chain, the labels and the requester
      // are all still the shipped module's.
      variantOf(OrdersModule, { dependsOn: [AuthModule] }),
    ]);

    // **Diffed against the document, not against a transcription of it.**
    // `SPEC_C8_MESSAGE` is read out of `docs/spec/01-kernel-and-module-system.md`
    // at test time (see `spec-text.ts`), so this is the assertion AGENTS.md §7
    // asks for: the running kernel's string against the spec's own.
    expect(error.message).toBe(SPEC_C8_MESSAGE);

    // Spelled out too, so a reader of a failure sees what was expected
    // without opening the spec — and so a spec edit that changed the message
    // fails *two* assertions and cannot be waved through as a reformat.
    expect(error.message).toBe(
      'Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. ' +
        "'payments' is registered but not listed in dependsOn of 'orders'.",
    );
  });

  it('C8: the suggestion names the module that owns the failing token, not the first missing one', async () => {
    // `orders` declaring *nothing* leaves both `auth` and `payments`
    // undeclared. The suggestion must still be about `payments`, because that
    // is the token that failed — an implementation that reported the first
    // absent dependency would pass the test above and mislead here.
    const error = await failedActivation([
      descriptorFor(AuthModule),
      paymentsWithoutTheGateway(),
      variantOf(OrdersModule, { dependsOn: [] }),
    ]);

    expect(error.message).toBe(SPEC_C8_MESSAGE);
  });
});
