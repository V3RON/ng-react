// `@app/auth` — provider declarations (spec §7.2).
//
// This file is **implementation**: it is not exported from the package
// (spec §4 gives a module package exactly two subpath exports), and it is
// reached only through `module.ts`'s thunk, at activation (**D1**).

import {
  contribute,
  defineStore,
  ErrorSinkToken,
  MODULE_ID,
  provide,
  recordEvaluation,
} from '@ng-react/kernel';
import type { AnyProviderRecord, ErrorInfo, Store, Unsubscribe } from '@ng-react/kernel';
import { MenuEntryToken } from '@app/nav/contract';
import { AuthErrorLogToken, DiagnosticPanelToken, SessionServiceToken } from './contract';
import type { AuthErrorEntry, Session, SessionService } from './contract';

// **Acceptance criterion 9**: records that this file was evaluated, so a test
// can prove it was not evaluated before its module's activation trigger
// (**D1**). A no-op when no test kernel is live.
recordEvaluation('auth', 'auth/providers.ts');

/** How many entries the demo's error log keeps. Bounded, like the kernel's own buffer. */
const ERROR_LOG_LIMIT = 50;

function createSessionService(): SessionService {
  let session: Session | undefined;
  const handlers = new Set<(next: Session | undefined) => void>();
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const handler of [...handlers]) {
      handler(session);
    }
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    login: (userId) => {
      session = { userId, startedAt: Date.now() };
      emit();
      return session;
    },
    logout: () => {
      session = undefined;
      emit();
    },
    current: () => session,
    on: (_event, handler) => {
      handlers.add(handler);
    },
    off: (_event, handler) => {
      handlers.delete(handler);
    },
    subscribe: (listener): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * ADR-10: the array element type is `AnyProviderRecord`. A heterogeneous
 * `providers` array of concretely-typed tokens has no common supertype
 * expressible with `unknown`, because `Token<T>` and `ProviderRecord<T>` are
 * both invariant in `T`. Do not "fix" this to `ProviderRecord<unknown>[]`.
 */
export const providers: AnyProviderRecord[] = [
  provide(SessionServiceToken, {
    // **C2 + §17 (#34)**: `singleton` here means one instance for as long as
    // this module's providers are registered — deactivating `auth` on logout
    // disposes it, and a later re-activation constructs exactly one new one.
    // It is emphatically *not* "for the process lifetime": A4 and H2 make
    // that untrue for a module-owned provider.
    scope: 'singleton',
    factory: () => createSessionService(),
  }),

  provide(AuthErrorLogToken, {
    // **H3**: the error log is durable state, so it lives in a store rather
    // than in a closure in this file. `persistent: true` carries it across an
    // HMR re-activation of `auth` (**H4**, ADR-3) — editing this file must
    // not silently erase the diagnostics the demo exists to show. A real
    // `deactivate` still discards it, which is the difference H3 draws.
    scope: 'singleton',
    persistent: true,
    factory: (): Store<readonly AuthErrorEntry[]> => defineStore<readonly AuthErrorEntry[]>([]),
  }),

  // **F4 — and the reason this sink lives in `auth` rather than in `debug`.**
  //
  // `debug` is the module that deliberately fails, so the obvious home for
  // the sink that reports its failure is `debug` itself. That is exactly
  // wrong: **F3** withdraws a quarantined module's providers *and its
  // contributions*, so a sink contributed by `debug` would be withdrawn at
  // the precise moment it was needed and the failure would be reported to
  // nobody. The sink therefore lives in a separate, working module — this
  // one, which is eager and critical and so is `ready` before `debug` even
  // starts. A reader will get this wrong; that is why it is written down.
  contribute(ErrorSinkToken, {
    deps: [AuthErrorLogToken],
    factory: (log) => ({
      report: (error: unknown, info: ErrorInfo) => {
        const entry: AuthErrorEntry = {
          // **C9**: `info.moduleId` is the kernel's attribution of the
          // *failing* module, assigned at registration and never
          // self-reported — so this sink, owned by `auth`, correctly records
          // `'debug'` for `debug`'s quarantine.
          moduleId: info.moduleId,
          phase: info.phase,
          message: error instanceof Error ? error.message : String(error),
        };
        log.setState((current) => [...current, entry].slice(-ERROR_LOG_LIMIT));
      },
    }),
  }),

  // **C5**: `contribute`, not `provide` — this appends to the collection
  // declared in this module's own contract. `provide` on a contributed token
  // is a registration-time error, and vice versa.
  contribute(DiagnosticPanelToken, {
    deps: [MODULE_ID, SessionServiceToken],
    factory: (owner, session) => ({
      moduleId: owner,
      label: 'Session',
      describe: () => {
        const current = session.current();
        return current === undefined ? 'signed out' : `signed in as ${current.userId}`;
      },
    }),
  }),

  // **C5 — a menu entry and nothing else.**
  //
  // `auth` is the demo's **eager, critical** module, so this row is the one
  // that is in the hamburger from the first paint: it needs no activation
  // trigger, and it is still there after every lazy module has been disposed
  // by logout — until logout disposes `auth` itself, at which point it goes
  // too. A menu whose *only* rows came from lazy modules would be empty at
  // startup and would prove nothing about the collection being live.
  //
  // **It points at a path this module does not own**, and that is deliberate
  // rather than an oversight: `MenuEntry.path` names a `RouteConfig.path`,
  // and nothing requires the two to come from the same module. `/` is the
  // shell's home route (`apps/react/src/shell/routes.tsx`), which is active
  // for the app's whole life — so this entry can never dangle. `auth`
  // contributes no route of its own because it has no screen; issue #52 asks
  // for "a menu entry only" and this is what that costs.
  contribute(MenuEntryToken, {
    factory: () => ({ id: 'auth/home', title: 'Home', path: '/', order: 0 }),
  }),
];
