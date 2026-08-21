// `@app/auth/contract` — the module's public surface (spec §4).
//
// **B2**: a contract may export only types and interfaces, `createToken()`
// calls, and **exactly one** `moduleRef()` call. No implementation values —
// this file is importable by every other module in the workspace, and the
// whole point of the split is that importing it evaluates nothing.
//
// **M1/M2**: the ref below is this module's value identity. `orders` names
// this module by importing `AuthModule` from here, so the contract import
// graph mirrors the module graph by construction.
//
// `auth` is the demo's **eager, critical** module (spec §15 criterion 1): it
// is the one whose failure would fail startup visibly (**F2**), and the one
// `deactivate` targets on logout (**A4**).

import { createToken, moduleRef } from '@ng-react/kernel';
import type { ErrorInfo, Store, Unsubscribe } from '@ng-react/kernel';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const AuthModule = moduleRef('auth');

/** A signed-in user. Plain data — a contract holds no behaviour of its own. */
export interface Session {
  readonly userId: string;
  readonly startedAt: number;
}

/**
 * The demo's session service.
 *
 * It is also an emitter (`on`/`off`), so `orders`' `init` has something real
 * to subscribe to through `ctx.on` (**L2**) without the kernel special-casing
 * any bus — the same shape spec 02's event bus will present.
 */
export interface SessionService {
  login(userId: string): Session;
  logout(): void;
  current(): Session | undefined;
  on(event: 'auth/session.changed', handler: (session: Session | undefined) => void): void;
  off(event: 'auth/session.changed', handler: (session: Session | undefined) => void): void;
  subscribe(listener: () => void): Unsubscribe;
}

/** One line of the demo's error log, as `auth`'s F4 sink records it. */
export interface AuthErrorEntry {
  /** **C9**: the kernel's attribution of the *failing* module. Never self-reported. */
  readonly moduleId: string;
  readonly phase: ErrorInfo['phase'];
  readonly message: string;
}

/**
 * One row of the demo's `useServiceAll` panel (**C5**, **R3**).
 *
 * The token for it is declared *here*, in `auth`, and contributed to by
 * `auth`, `payments`, `orders` and `debug`. That is C5's shape exactly: a
 * collection token is owned by the module that consumes the collection, and
 * contributors merely import its contract. It is also why the panel is a
 * live demonstration of F3 — `debug`'s row is withdrawn the moment `debug`
 * is quarantined, and `orders`'/`payments`' rows appear and disappear with
 * their activation.
 */
export interface DiagnosticPanel {
  readonly moduleId: string;
  readonly label: string;
  describe(): string;
}

/** **C1**: token labels are `moduleId/Name` (ADR-8). Each call is a distinct identity. */
export const SessionServiceToken = createToken<SessionService>('auth/SessionService');
/**
 * **H3**: durable state lives in a store, never in a module closure. This one
 * is where `auth`'s `ErrorSinkToken` contribution writes what the kernel
 * routes to it (**F4**).
 */
export const AuthErrorLogToken = createToken<Store<readonly AuthErrorEntry[]>>('auth/ErrorLog');
/** **C5**: the demo's contribution collection. See `DiagnosticPanel` above. */
export const DiagnosticPanelToken = createToken<DiagnosticPanel>('auth/DiagnosticPanel');
