// The native app's **shell** module — this host's top-level route table and
// the drawer rows that reach it.
//
// The direct counterpart of `apps/react/src/shell/module.ts`, and it exists
// for the same reason that one does: **a lazy module cannot contribute the
// route that activates it.** A contribution is registered when its module's
// `providers` thunk runs, which is at activation (**C3**/**D1**), so the
// route whose job is to *trigger* the first activation has to come from
// something already running. Spec §6's "a **parent** route config maps a
// matched path to its ref" is where that lives, and the parent is the shell.
//
// **Why a second shell rather than importing the web app's.** The shell is
// the one part of this demo that is genuinely per-host: it owns the entry
// routes and, here, the drawer rows that reach them. `apps/react`'s shell
// contributes no `MenuEntry` for `/orders` or `/payments` because its
// navigator renders the whole route table as links, so those paths are
// already reachable; a React Navigation drawer has no such list, and issue
// #53 asks specifically that "a drawer item for a lazy module calls
// `kernel.activate(ref)` and renders an activating state". So this shell
// contributes two menu entries the web one does not, and that difference —
// two `contribute` calls in an app-owned folder — is the *entire* cost of
// putting the same six modules behind a different navigation library.
//
// **D1**: everything below is static. The screens and the provider records
// live in `./routes`, behind the thunk, so importing this file evaluates no
// screen.

import { defineModule, moduleRef } from '@ng-react/kernel';

/** **M1**: the shell's identity. `'shell'` is not reserved — ADR-2 reserves only `'app'`. */
export const ShellModule = moduleRef('shell');

export const module = defineModule({
  id: ShellModule,
  // **D3**: nothing. The shell *names* `OrdersModule` and `PaymentsModule` in
  // its route configs, and a route is emphatically not a dependency — the
  // point of a lazy route is that the target is not activated until it is
  // reached. A `dependsOn` here would activate both at startup and quietly
  // delete the behaviour this app exists to show.
  dependsOn: [],
  // Eager: the entry routes and their drawer rows have to exist before
  // anything can be routed to.
  load: 'eager',
  critical: false,
  providers: () => import('./routes').then((m) => m.providers),
});
