// Regression fixture for issue #43 / spec §13 B3 — half of a deliberate,
// two-file dependency cycle. NOT dead code and NOT an example to copy: it
// exists to be *rejected* by ESLint, and `src/no-cycle.test.ts` fails if the
// rejection ever stops happening.
//
// Deliberately extensionless TypeScript relative imports, because that is the
// only import form this workspace can write (`tsconfig.base.json` sets
// `allowImportingTsExtensions: false`) and precisely the form that
// `createNodeResolver` could not resolve — which is what made
// `import-x/no-cycle` inert for the whole of stage 7.
//
// The root `eslint .` ignores this directory (see `eslint.config.js`); the
// test lints it explicitly, through the real root config.
import { refreshToken } from './token-store';

export interface Session {
  readonly userId: string;
  readonly token: string;
}

export const openSession = (userId: string): Session => ({
  userId,
  token: refreshToken(userId),
});
