// `@app/auth/contract` — the module's public surface (spec §4).
//
// **B2**: a contract may export only types and interfaces, `createToken()`
// calls, and **exactly one** `moduleRef()` call. No implementation values —
// this file is importable by every other module in the workspace, and the
// whole point of the split is that importing it evaluates nothing.
// `@ng-react/eslint-config-modules`' `contract-exports-allowlist` rule
// enforces that, verified by import provenance: a locally defined function
// called `createToken` does not count.
//
// **M1/M2**: the ref below is this module's value identity. Other modules
// name it by importing it from here, so a typo is a compile error and "find
// all references" on the ref lists every dependent (D3).

import { createToken, moduleRef } from '@ng-react/kernel';
import type { Store } from '@ng-react/kernel';

/** **M1/D2**: the module's identity. The one `moduleRef()` call in this file. */
export const AuthModule = moduleRef('auth');

/** Plain, immutable configuration — the shape a composition root or a test overrides. */
export interface AuthSettings {
  readonly enabled: boolean;
  readonly maxRetries: number;
}

/** One record this module owns. */
export interface AuthRecord {
  readonly id: string;
  readonly label: string;
}

/** A not-yet-committed edit. Durable across HMR — see `AuthDraftsToken`. */
export interface AuthDraft {
  readonly id: string;
  readonly text: string;
}

/**
 * The remote edge of the module. Declared here so a test can replace it with
 * `provide(AuthGatewayToken, { override: true, … })` — spec §15
 * criterion 7's "activate with a mocked gateway" in this module's terms.
 */
export interface AuthGateway {
  fetch(id: string): Promise<AuthRecord>;
}

/**
 * The module's own service. It is also an emitter, so `ctx.on` (L2) has
 * something real to subscribe to without the kernel special-casing any bus
 * (spec 02's event bus is the other, later, case L2 must also fit).
 */
export interface AuthService {
  load(id: string): Promise<AuthRecord>;
  on(event: string, handler: (record: AuthRecord) => void): void;
  off(event: string, handler: (record: AuthRecord) => void): void;
  /** **C7**: the container calls this when the owning module is disposed. */
  dispose(): void;
}

/**
 * A short-lived unit of work. Its provider is `scope: 'transient'`, so **C7**
 * applies: the container never disposes it, and the blessed way to acquire
 * one is inside `ctx.effect` (see `lifecycle.ts`), never at the top level of
 * a component (**R2**).
 */
export interface AuthSession {
  flush(): Promise<void>;
  close(): void;
}

/** **C1**: token labels are `moduleId/Name` (ADR-8). Each call is a distinct identity. */
export const AuthSettingsToken = createToken<AuthSettings>('auth/Settings');
export const AuthGatewayToken = createToken<AuthGateway>('auth/Gateway');
export const AuthServiceToken = createToken<AuthService>('auth/Service');
export const AuthSessionToken = createToken<AuthSession>('auth/Session');
/** **H3**: durable state lives in a store, never in a module closure. */
export const AuthDraftsToken =
  createToken<Store<readonly AuthDraft[]>>('auth/Drafts');
