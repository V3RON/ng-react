// `__pkg__` — the module lifecycle (spec §8).
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
  __Pascal__DraftsToken,
  __Pascal__ServiceToken,
  __Pascal__SessionToken,
} from './contract';
import type { __Pascal__Record } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('__id__', '__id__/lifecycle.ts');

/**
 * **L1/L2**: the module's only place for effects. `ctx.get` resolves with
 * this module as the resolution context (**C4**), so `MODULE_ID` inside every
 * factory reached from here is `'__id__'`.
 */
export function init(ctx: ModuleContext): void {
  const service = ctx.get(__Pascal__ServiceToken);
  const drafts = ctx.get(__Pascal__DraftsToken);

  // **L2**: sugar over `effect` for any subscribe/unsubscribe-shaped API.
  // The service is an ordinary emitter here; the event bus (spec 02) fits the
  // same signature without being special-cased.
  ctx.on(service, '__id__/changed', (record: __Pascal__Record) => {
    drafts.setState((current) => current.filter((draft) => draft.id !== record.id));
  });

  // **C7 — the blessed way to use a `transient`.** The container never
  // disposes a transient instance, so its lifetime is the consumer's
  // responsibility: acquire it inside `ctx.effect` and release it in the
  // cleanup the effect returns. Resolving one at the top level of `init` (or
  // of a component — **R2**) leaks it.
  ctx.effect(() => {
    const session = ctx.get(__Pascal__SessionToken);
    const timer = setInterval(() => {
      void session.flush();
    }, 60_000);
    return () => {
      clearInterval(timer);
      session.close();
    };
  });
}
