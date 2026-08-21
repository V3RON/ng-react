// **B2** — a contract file exporting a value that is not a token or a ref.
//
// Criterion 8's second case. Named `contract.ts` because that is what the
// rule's `contractGlob` matches (`**/contract.ts`), and carrying exactly one
// `moduleRef()` call so the *other* half of the rule (M1: a contract declares
// exactly one ref) stays silent and the failure below is unambiguous.
import { createToken, moduleRef } from '@ng-react/kernel';

export const BadModule = moduleRef('bad');

export interface Session {
  readonly userId: string;
}

export const SessionToken = createToken<Session>('bad/Session');

// The violation: implementation in a file every other module may import.
// Spec §4: a contract "contains no implementation values".
export const DEFAULT_SESSION: Session = { userId: 'anonymous' };

export function normalize(session: Session): Session {
  return { userId: session.userId.trim() };
}
