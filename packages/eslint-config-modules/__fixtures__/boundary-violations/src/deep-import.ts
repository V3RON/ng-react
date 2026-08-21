// **B1** — a deep import into another module package's `src/`.
//
// Criterion 8's first case. The target is real: `@app/orders` exports exactly
// `./contract` and `./module` (spec §4), so `@app/orders/src/providers` is
// unreachable through the resolver — this rule is the *backstop* for
// resolvers that ignore `exports` maps, and it is what turns a runtime
// resolution failure into a lint error at the moment the line is typed.
import { providers } from '@app/orders/src/providers';
import { SessionServiceToken } from '@app/auth/src/contract';

export const stolen = [providers, SessionServiceToken];
