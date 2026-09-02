// `@app/auth/module` — the kernel-facing descriptor (spec §5.2).
//
// **B1**: this entry point may be imported only by the application's
// composition root; every other importer uses `@app/auth/contract`.
//
// **D1**: nothing below evaluates an implementation file. `providers` and
// `init` are thunks, and the kernel calls them only at activation — which is
// what makes `load: 'lazy'` mean anything and what acceptance criterion 9
// measures. **ADR-7**: this repo is ESM-only, so the blessed thunk form is
// `() => import('./x').then(m => m.y)`, not the spec's CommonJS `require`.
//
// **ADR-9**: the descriptor has exactly seven fields. `dispose` is absent on
// purpose (**D4**, spec §8) — see `lifecycle.ts`.

import { defineModule } from '@ng-react/kernel';
import { AuthModule } from './contract';

export const module = defineModule({
  // **D2**: the module's own ref, imported from its own contract. The
  // descriptor never re-states the id string.
  id: AuthModule,
  // **D3**: the only inter-module ordering mechanism. Listing a ref does not
  // grant import access to that module's implementation — only its contract
  // is importable, and that is true with or without this list.
  dependsOn: [],
  load: 'eager',
  critical: true,
  providers: () => import('./providers').then((m) => m.providers),
  init: (ctx) => import('./lifecycle').then((m) => m.init(ctx)),
});
