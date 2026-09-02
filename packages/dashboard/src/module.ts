// `@app/dashboard/module` — the kernel-facing descriptor (spec §5.2).
//
// **B1**: this entry point may be imported only by the application's
// composition root; every other importer uses `@app/dashboard/contract`.
//
// **D1**: nothing below evaluates an implementation file. `providers` is a
// thunk and the kernel calls it only at activation — so importing this file
// evaluates no screen, which is what keeps this module subject to acceptance
// criterion 9 like any other. **ADR-7**: this repo is ESM-only, so the
// blessed thunk form is `() => import('./x').then(m => m.y)`, not the spec's
// CommonJS `require`.
//
// **ADR-9**: the descriptor has exactly seven fields; five are declared here.
// `init` and `dispose` are both absent on purpose (**D4**), and the generated
// `lifecycle.ts` was deleted rather than left empty: the dashboard registers
// *nothing* at activation. Its whole behaviour is two contributions and a
// React subscription to a collection whose contents it does not own — the
// same shape `@app/nav` has, and the reason spec §7.2's **C3** ("a provider
// that must run at activation regardless of consumers is not a provider — it
// is `init` code") has nothing to bite on here.

import { defineModule } from '@ng-react/kernel';
import { DashboardModule } from './contract';

export const module = defineModule({
  // **D2**: the module's own ref, imported from its own contract. The
  // descriptor never re-states the id string.
  id: DashboardModule,
  // **D3**: the only inter-module ordering mechanism. Listing a ref does not
  // grant import access to that module's implementation — only its contract
  // is importable, and that is true with or without this list.
  // **D3**: empty, and deliberately so. Every module that contributes a card
  // imports `DashboardCardToken` from this package's *contract* and declares
  // no `dependsOn` edge to it — a contribution is precisely the relationship
  // that creates none (spec §17, M2). That is what lets the dashboard start
  // before any contributor exists, and what lets a contributor appear without
  // the dashboard knowing it does.
  dependsOn: [],
  // **`eager`**: the dashboard owns the route that reaches it, and a
  // collection's consumer has to be running before the collection can be
  // watched. Non-critical, because a broken dashboard should be quarantined
  // (**F3**) rather than fail startup (**F2**).
  load: 'eager',
  critical: false,
  providers: () => import('./providers').then((m) => m.providers),
});
