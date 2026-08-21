// The **app shell** module — the demo's top-level route table.
//
// Spec §3: a module is "a feature unit with an identity, a descriptor,
// optional providers, and a lifecycle. Physically, a package (**or a folder
// treated as one**) with controlled entry points." This is that folder. It is
// an ordinary module with an ordinary descriptor; the only thing unusual
// about it is that the application owns it rather than a package.
//
// ---
//
// ### Why it exists at all: a lazy module cannot contribute the route that activates it
//
// This is the one genuine design finding from building the PoC navigator, and
// it is worth stating plainly because the brief for #24 does not mention it.
//
// A contribution is registered when its module's `providers` thunk runs,
// which is **at activation** (**C3**/**D1**). So a route contributed by
// `orders` exists only while `orders` is already active — and a route table
// built solely from feature-module contributions can therefore never contain
// the route whose job is to *trigger* the first activation. The chicken has
// to come from somewhere that is already running.
//
// Spec §6 says exactly where, and says it in one clause that is easy to read
// past: *"the navigation module (spec 03) activates a module when a **parent
// route config** maps a matched path to its ref."* The parent. The entry
// route for a lazy module belongs to something already active — the shell —
// and the lazy module contributes its *own* routes once it is up. That is
// also how Angular's `loadChildren` and every other lazy router works, so the
// kernel is not short of a primitive here; the spec's model is right and only
// its acceptance criteria are silent about it.
//
// The two halves are visible in the demo as two different behaviours:
//
//  - `/orders` — contributed here, always present, names `OrdersModule`. The
//    navigator turns it into `kernel.activate(OrdersModule)` (spec §6) and
//    renders a fallback while the status is `activating` (**A2**).
//  - `/orders/detail` — contributed by `@app/orders` itself, present only
//    while that module is active, and withdrawn again by logout (**A4**,
//    **C5**).
//
// **D1**: everything below is static. The route components and the provider
// records live in `./routes`, behind the thunk, so importing this file
// evaluates no screen — which is what makes the shell subject to acceptance
// criterion 9 like any other module rather than exempt from it.

import { defineModule, moduleRef } from '@ng-react/kernel';

/** **M1**: the shell's identity. `'shell'` is not reserved — ADR-2 reserves only `'app'`. */
export const ShellModule = moduleRef('shell');

export const module = defineModule({
  id: ShellModule,
  // **D3**: nothing. The shell names `OrdersModule` and `PaymentsModule` in
  // its route configs, and a route is emphatically **not** a dependency: the
  // point of a lazy route is that the target is *not* activated until it is
  // reached. Adding a `dependsOn` here would activate both lazy modules at
  // startup and quietly delete the behaviour criterion 9 measures.
  dependsOn: [],
  // Eager: the entry routes have to exist before anything can be routed to.
  load: 'eager',
  critical: false,
  providers: () => import('./routes').then((m) => m.providers),
});
