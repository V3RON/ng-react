// `@app/orders` — the module lifecycle (spec §8).
//
// No `dispose` export and no `dispose` thunk: both registrations below go
// through `ctx`, so **L3** removes the listener and runs the timer cleanup in
// reverse registration order with nothing to mirror (**D4**).
//
// **This is the file acceptance criterion 3 edits while the app runs.** The
// listener and the timer are also what gives **H7**'s leak counters something
// to count: after a dispose→init cycle the residual listener and effect
// counts for `orders` must be zero, and `createTestKernel().leaks().balanced`
// is where that is asserted.
//
// **L4**: after teardown the `ctx` is dead. Do not close over it in anything
// that can outlive the module; using a stale one throws, naming this module.

import { recordEvaluation } from '@ng-react/kernel';
import type { ModuleContext } from '@ng-react/kernel';
import { SessionServiceToken } from '@app/auth/contract';
import { OrderNotesToken, OrderServiceToken } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('orders', 'orders/lifecycle.ts');

/** How often the demo's background sync runs. Long enough to never fire in a test. */
const SYNC_INTERVAL_MS = 60_000;

/**
 * **L1/L2**: `ctx.get` resolves with `orders` as the resolution context
 * (**C4**), so `MODULE_ID` inside `OrderService`'s factory is `'orders'`.
 */
export function init(ctx: ModuleContext): void {
  const service = ctx.get(OrderServiceToken);
  const session = ctx.get(SessionServiceToken);

  // **H3, and the seed is conditional for the same reason `payments`' is.**
  // An unconditional seed would make a preserved store and a discarded one
  // look identical, so the count below is only evidence because this line
  // does not run twice: it holds steady across an edit to *this* file (H4
  // carries the snapshot onto the fresh instance) and returns to one after a
  // real `kernel.deactivate`, which discards it.
  const notes = ctx.get(OrderNotesToken);
  if (notes.getState().length === 0) {
    notes.setState([{ text: 'seeded by orders/lifecycle.ts init' }]);
  }

  // **L2**: sugar over `effect` for any subscribe/unsubscribe-shaped API.
  // `SessionService` is an ordinary emitter here — the kernel special-cases
  // nothing, which is what spec §8 L2 requires so that spec 02's event bus
  // fits the same call unchanged. Auto-removed on dispose.
  ctx.on(session, 'auth/session.changed', () => {
    service.noteSessionChange();
  });

  // **L2/H7**: an effect with a real cleanup. If teardown ever stopped
  // running cleanups, this timer would survive the module and the leak
  // counters would report a positive residual for `orders`.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void service.placed();
    }, SYNC_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  });
}
