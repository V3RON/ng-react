// `@app/auth` — the module lifecycle (spec §8).
//
// **There is deliberately no `dispose` export in this file**, and `module.ts`
// deliberately declares no `dispose` thunk. Spec §8: "`ctx` collects
// disposables so teardown is structural; a hand-written `dispose` mirroring
// `init` is an anti-pattern and should almost never exist." Everything `init`
// registers below is registered *through* `ctx`, so **L3** tears it down in
// reverse registration order with nothing to mirror.
//
// **L4**: after teardown the `ctx` is dead. Do not close over it in anything
// that can outlive the module.

import { recordEvaluation } from '@ng-react/kernel';
import type { ModuleContext } from '@ng-react/kernel';
import { AuthErrorLogToken, SessionServiceToken } from './contract';

// **Acceptance criterion 9** — see the same call in `providers.ts`.
recordEvaluation('auth', 'auth/lifecycle.ts');

/**
 * **L1/L2**: the module's only place for effects. `ctx.get` resolves with
 * this module as the resolution context (**C4**), so `MODULE_ID` inside every
 * factory reached from here is `'auth'`.
 *
 * `auth` is `critical: true`, so anything that throws here fails startup
 * visibly (**F2**) — which is precisely the contrast the demo needs against
 * `debug`, whose identical failure is quarantined.
 */
export function init(ctx: ModuleContext): void {
  const session = ctx.get(SessionServiceToken);

  // **C3**: a provider is constructed on first resolution, and the error log
  // must exist *before* the first error rather than on the first read — a
  // sink that constructed its log lazily would drop nothing, but the demo's
  // panel would show an empty log until something failed. Spec §7.2 C3 is
  // explicit that "a provider that must run at activation regardless of
  // consumers is not a provider — it is `init` code"; this is that line.
  ctx.get(AuthErrorLogToken);

  // **L2**: the demo starts signed in, so `orders` has a session to work
  // against, and the effect's cleanup ends the session when `auth` is
  // disposed. Logout in the UI is `kernel.deactivate(AuthModule)` (**A4**),
  // so this cleanup is what makes "logged out" true of the service as well
  // as of the kernel — structurally, with no hand-written `dispose`.
  ctx.effect(() => {
    session.login('demo-user');
    return () => {
      session.logout();
    };
  });
}
