// Acceptance criterion 6, lint half — one side of a deliberate **contract**
// import cycle between two module packages.
//
// NOT an example to copy: it exists to be rejected. `import-x/no-cycle` (B3)
// must report it, and `apps/react/src/acceptance/criterion-06-cycle.test.ts`
// fails if the rejection ever stops happening.
//
// Why a contract cycle and not any old cycle: G1's own note says "ref-based
// `dependsOn` makes cycles between contract imports visible to
// `import/no-cycle` as well, so most cycles are caught at lint time before
// runtime". This fixture is the shape that claim is about — two contracts
// each importing the other's ref, which is what a `dependsOn` cycle looks
// like at the file level.
//
// The root `eslint .` ignores `packages/eslint-config-modules/__fixtures__/**`
// (a repo whose lint always fails is a repo whose lint is ignored); the test
// lints this directory explicitly, through the real root config, with
// `ignore: false`.
import { moduleRef } from '@ng-react/kernel';
import { PaymentsModule } from '../../payments/src/contract';

export const OrdersModule = moduleRef('cycle-orders');

/** The cycle: this file needs the other module's ref, and that file needs this one's. */
export type OrdersDependencies = readonly [typeof PaymentsModule];
