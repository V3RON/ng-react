// `@app/orders` — the module lifecycle (spec §8).
//
// **There is deliberately no `dispose` export in this file**, and `module.ts`
// deliberately declares no `dispose` thunk. Spec §8: "`ctx` collects
// disposables so teardown is structural; a hand-written `dispose` mirroring
// `init` is an anti-pattern and should almost never exist." Everything `init`
// registers below is registered *through* `ctx`, so **L3** tears it down in
// reverse registration order with nothing to mirror. Add a `dispose` only for
// teardown that `ctx` genuinely cannot express — and then say in a comment
// what that is.
//
// **L4**: after teardown the `ctx` is dead. Do not close over it in anything
// that can outlive the module; using a stale one throws, naming this module.

import { recordEvaluation } from '@ng-react/kernel';
import type { ModuleContext } from '@ng-react/kernel';
import {
  OrdersDraftsToken,
  OrdersServiceToken,
  OrdersSessionToken,
} from './contract';
import type { OrdersRecord } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('orders', 'orders/lifecycle.ts');

/**
 * **L1/L2**: the module's only place for effects. `ctx.get` resolves with
 * this module as the resolution context (**C4**), so `MODULE_ID` inside every
 * factory reached from here is `'orders'`.
 */
export function init(ctx: ModuleContext): void {
  const service = ctx.get(OrdersServiceToken);
  const drafts = ctx.get(OrdersDraftsToken);

  // **L2**: sugar over `effect` for any subscribe/unsubscribe-shaped API.
  // The service is an ordinary emitter here; the event bus (spec 02) fits the
  // same signature without being special-cased.
  ctx.on(service, 'orders/changed', (record: OrdersRecord) => {
    drafts.setState((current) => current.filter((draft) => draft.id !== record.id));
  });

  // **C7 — the blessed way to use a `transient`.** The container never
  // disposes a transient instance, so its lifetime is the consumer's
  // responsibility: acquire it inside `ctx.effect` and release it in the
  // cleanup the effect returns. Resolving one at the top level of `init` (or
  // of a component — **R2**) leaks it.
  ctx.effect(() => {
    const session = ctx.get(OrdersSessionToken);
    const timer = setInterval(() => {
      void session.flush();
    }, 60_000);
    return () => {
      clearInterval(timer);
      session.close();
    };
  });
}
