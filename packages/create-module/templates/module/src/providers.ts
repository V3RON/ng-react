// `__pkg__` — provider declarations (spec §7.2).
//
// This file is **implementation**: it is not exported from the package
// (spec §4 gives a module package exactly two subpath exports), and it is
// reached only through `module.ts`'s thunk, at activation (**D1**).
//
// Five declarations, each carrying one blessed pattern:
//
//  - `__Pascal__SettingsToken` — a plain data provider, the thing a test or
//    the composition root replaces with `override: true` (**C6**).
//  - `__Pascal__GatewayToken` — the module's remote edge, and the token the
//    emitted test mocks.
//  - `__Pascal__ServiceToken` — `scope: 'module'` (**C2**), with `MODULE_ID`
//    among its deps (**C4**) and a `dispose()` the container calls when the
//    module is disposed (**C7**).
//  - `__Pascal__DraftsToken` — `persistent: true` over `defineStore`
//    (**H3**/**H4**, ADR-3): the one kind of state that survives an HMR
//    re-activation of this module.
//  - `ErrorSinkToken` — a `contribute` (**C5**), i.e. an append to a
//    collection the kernel owns (**F4**), not a `provide`.

import {
  contribute,
  defineStore,
  ErrorSinkToken,
  MODULE_ID,
  provide,
  recordEvaluation,
} from '@ng-react/kernel';
import type { AnyProviderRecord, ErrorInfo } from '@ng-react/kernel';
import {
  __Pascal__DraftsToken,
  __Pascal__GatewayToken,
  __Pascal__ServiceToken,
  __Pascal__SessionToken,
  __Pascal__SettingsToken,
} from './contract';
import type {
  __Pascal__Draft,
  __Pascal__Gateway,
  __Pascal__Record,
  __Pascal__Service,
  __Pascal__Session,
  __Pascal__Settings,
} from './contract';

// **Acceptance criterion 9**: records that this file was evaluated, so a test
// can prove it was not evaluated before its module's activation trigger
// (**D1**). A no-op when no test kernel is live.
recordEvaluation('__id__', '__id__/providers.ts');

function create__Pascal__Gateway(settings: __Pascal__Settings): __Pascal__Gateway {
  return {
    fetch: async (id) => {
      if (!settings.enabled) {
        throw new Error(`__id__: disabled by settings, cannot fetch '${id}'.`);
      }
      return { id, label: `__Pascal__ ${id}` };
    },
  };
}

function create__Pascal__Service(
  gateway: __Pascal__Gateway,
  settings: __Pascal__Settings,
  requester: string,
): __Pascal__Service {
  const handlers = new Set<(record: __Pascal__Record) => void>();
  return {
    load: async (id) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
        try {
          const record = await gateway.fetch(id);
          for (const handler of [...handlers]) {
            handler(record);
          }
          return record;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`__id__: load('${id}') failed for '${requester}'.`, { cause: lastError });
    },
    on: (_event, handler) => {
      handlers.add(handler);
    },
    off: (_event, handler) => {
      handlers.delete(handler);
    },
    // **C7**: the container invokes this when the module that owns the
    // instance is disposed — module scope ends with the module's activation.
    dispose: () => {
      handlers.clear();
    },
  };
}

function open__Pascal__Session(service: __Pascal__Service): __Pascal__Session {
  let open = true;
  return {
    flush: async () => {
      if (open) {
        await service.load('pending');
      }
    },
    close: () => {
      open = false;
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
  provide(__Pascal__SettingsToken, {
    // C2: `singleton` is the default scope and is what a value with no
    // per-module identity wants.
    factory: () => ({ enabled: true, maxRetries: 2 }),
  }),

  provide(__Pascal__GatewayToken, {
    deps: [__Pascal__SettingsToken],
    factory: (settings) => create__Pascal__Gateway(settings),
  }),

  provide(__Pascal__ServiceToken, {
    // C2: one instance per *activation* of this module — re-activation
    // (A4, H2) constructs exactly one new one (§17, issue #34).
    scope: 'module',
    // **C4**: `MODULE_ID` resolves to the module on whose behalf the
    // resolution chain was *started* — this module when its own `init` asks,
    // ADR-2's reserved `'app'` when the composition root or `kernel.get()`
    // does. It is the sanctioned way to specialise a service for its
    // consumer; a module never passes its own id as a string.
    deps: [__Pascal__GatewayToken, __Pascal__SettingsToken, MODULE_ID],
    factory: (gateway, settings, requester) =>
      create__Pascal__Service(gateway, settings, requester),
  }),

  provide(__Pascal__SessionToken, {
    // C2/C7: a new instance per resolution, and the container never disposes
    // it — the consumer owns its lifetime. See `lifecycle.ts` for the
    // blessed acquisition site.
    scope: 'transient',
    deps: [__Pascal__ServiceToken],
    factory: (service) => open__Pascal__Session(service),
  }),

  provide(__Pascal__DraftsToken, {
    // **H3/H4** (ADR-3): the instance is held back across an HMR
    // re-activation of this module and its state transferred onto the fresh
    // one via `snapshot()`/`restore()` — which is exactly what `defineStore`
    // exists to provide. A real `deactivate` still throws the state away.
    scope: 'module',
    persistent: true,
    factory: () => defineStore<readonly __Pascal__Draft[]>([]),
  }),

  // **C5/F4**: `contribute`, not `provide` — this appends to a collection the
  // kernel owns. `provide` on a contributed token is a registration-time
  // error, and vice versa.
  contribute(ErrorSinkToken, {
    deps: [MODULE_ID],
    factory: (owner) => ({
      // **C9**: `info.moduleId` is the kernel's attribution of the *failing*
      // module, assigned at registration and never self-reported. `owner` is
      // C4's resolution context — for a contribution, always its own owner
      // (§17), so the two differ whenever another module is the one failing.
      report: (error: unknown, info: ErrorInfo) => {
        console.error(`[${owner}] ${info.moduleId} failed during ${info.phase}:`, error);
      },
    }),
  }),
];
