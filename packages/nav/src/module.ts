// `@app/nav/module` — the kernel-facing descriptor (spec §5.2).
//
// **B1**: this entry point may be imported only by the application's
// composition root; every other importer uses `@app/nav/contract`.
//
// **D1**: nothing below evaluates an implementation file. `providers` is a
// thunk and the kernel calls it only at activation — which is what
// acceptance criterion 9 measures. **ADR-7**: this repo is ESM-only, so the
// blessed thunk form is `() => import('./x').then(m => m.y)`, not the spec's
// CommonJS `require`.
//
// **ADR-9**: the descriptor has exactly seven fields; five are declared here
// and `init`/`dispose` are absent on purpose (**D4**). The navigation module
// registers *nothing* at activation: its whole behaviour is two providers
// and a React subscription to a collection it does not own the contents of.
// Spec §7.2 **C3** — "a provider that must run at activation regardless of
// consumers is not a provider — it is `init` code" — reads the other way
// round here, and correctly: there is no such work to do.
//
// This module carries no hand-written HMR code: hot updates for it flow
// through the bundler plugins (`@ng-react/vite-plugin` / the Metro Babel
// plugin), which inject the accept wiring at build time. See
// `packages/vite-plugin` and `packages/babel-plugin`.

import { defineModule } from '@ng-react/kernel';
import { NavModule } from './contract';

export const module = defineModule({
  // **D2**: the module's own ref, imported from its own contract. The
  // descriptor never re-states the id string.
  id: NavModule,
  // **D3**: empty, and that is a claim worth reading twice. The navigation
  // module depends on no feature module — a *contribution* is precisely the
  // relationship that creates no `dependsOn` edge (spec §17, M2), which is
  // what lets a feature register a route without the navigator knowing it
  // exists, and what lets the navigator start before any of them.
  dependsOn: [],
  // **`eager`**: the navigator has to be able to render the route that
  // *triggers* the first activation, so it cannot itself be waiting for one.
  // Non-critical, because an app whose navigation failed should surface that
  // (**F3**) rather than refuse to start (**F2**).
  load: 'eager',
  critical: false,
  providers: () => import('./providers').then((m) => m.providers),
});
