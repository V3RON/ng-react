// Loads Metro's **real** `require.js` polyfill — the actual file from
// `metro-runtime`, not a re-implementation — and drives it exactly as Metro
// itself would: `__d()` to define a tiny module graph, `__r()` to require
// from it, `__accept()` to simulate an edit. The module and provider
// factories below are hand-written in the exact shape
// `@ng-react/babel-plugin-hmr` emits (see `index.ts`'s injected block) and
// call the **real** `createKernel`/`defineModule`/`hotReplaceModule` from
// `@ng-react/kernel` — no mock kernel, no mock require.js.
//
// What this proves, read straight off the mechanism (see `index.ts`'s header
// comment for the full trace through Metro's source): editing a module whose
// factory Metro re-runs in place, and whose freshly re-run factory
// registers `module.hot.accept(...)`, reaches `hotReplaceModule` with the
// *previous* evaluation's descriptor and the *new* one — with no hand-written
// wiring anywhere outside the injected block itself, and without Metro ever
// escalating to a full refresh.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NgReactKernel from '@ng-react/kernel';
import type { Kernel, ModuleDescriptor, ModuleRef, Store, Token } from '@ng-react/kernel';

// ---------------------------------------------------------------------------
// Metro's module-id space for this test's tiny graph. Real Metro assigns
// these; here they are just distinct integers this file controls.
// ---------------------------------------------------------------------------
const KERNEL_ID = 0;
const CONTRACT_ID = 1;
const PROVIDERS_ID = 2;
const MODULE_ID = 3;

/** Metro's factory signature — see `loadModuleImplementation`'s `factory(...)` call. */
type MetroFactory = (
  global: typeof globalThis,
  metroRequire: (id: number) => unknown,
  importDefault: unknown,
  importAll: unknown,
  module: { hot?: MetroHot; id?: number; exports: unknown },
  exports: Record<string, unknown>,
  dependencyMap: unknown,
) => void;

interface MetroHot {
  accept(callback: () => void): void;
  dispose(callback: () => void): void;
  _didAccept: boolean;
  _acceptCallback: (() => void) | null;
  _disposeCallback: (() => void) | null;
  [key: string]: unknown;
}

declare global {
  var __d: (factory: MetroFactory, moduleId: number, dependencyMap?: readonly number[]) => void;
  var __r: (moduleId: number) => Record<string, unknown>;
  var __c: () => unknown;
  var __accept: (
    id: number,
    factory: MetroFactory | undefined,
    dependencyMap: unknown,
    inverseDependencies: Record<number, readonly number[]>,
  ) => void;
}

let kernelExports: typeof NgReactKernel;

beforeAll(async () => {
  // Metro's own bundle preamble sets these before `require.js` runs; a real
  // device or `expo start` provides them, this test stands in for that.
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
  (globalThis as unknown as { __METRO_GLOBAL_PREFIX__: string }).__METRO_GLOBAL_PREFIX__ = '';
  kernelExports = await import('@ng-react/kernel');
  // The real file — `node_modules/metro-runtime/src/polyfills/require.js` —
  // loaded through the package's own `exports` map, not copied or stubbed.
  await import('metro-runtime/polyfills/require');
});

beforeEach(() => {
  // `__c` (`clear()`) is Metro's own reset — a fresh `modules` Map per test,
  // exactly as a fresh bundle load would give a real app.
  globalThis.__c();
  (globalThis as unknown as { window?: { location: { reload: () => void } } }).window = {
    location: { reload: vi.fn() },
  };
});

/** `KERNEL_ID`'s factory: a thin bridge to the real, already-imported `@ng-react/kernel`. */
const kernelFactory: MetroFactory = (_global, _require, _importDefault, _importAll, _module, exports) => {
  Object.assign(exports, kernelExports);
};

/** This graph's `contract.ts` equivalent: a module ref plus its two tokens. */
interface GreeterContract {
  readonly GreeterRef: ModuleRef;
  readonly GreeterToken: Token<{ greet(): string }>;
  readonly NotesToken: Token<Store<readonly string[]>>;
}

/** `CONTRACT_ID`'s factory — this graph's `contract.ts` equivalent. */
const contractFactory: MetroFactory = (_global, metroRequire, _importDefault, _importAll, _module, exports) => {
  const kernel = metroRequire(KERNEL_ID) as typeof NgReactKernel;
  exports.GreeterRef = kernel.moduleRef('greeter');
  exports.GreeterToken = kernel.createToken<{ greet(): string }>('greeter/Greeter');
  exports.NotesToken = kernel.createToken('greeter/Notes');
};

/** Builds a `PROVIDERS_ID` factory for one "generation" of an edit — this graph's `providers.ts`. */
function makeProvidersFactory(greeting: string): MetroFactory {
  return (_global, metroRequire, _importDefault, _importAll, _module, exports) => {
    const kernel = metroRequire(KERNEL_ID) as typeof NgReactKernel;
    const contract = metroRequire(CONTRACT_ID) as GreeterContract;
    exports.providers = [
      kernel.provide(contract.GreeterToken, { factory: () => ({ greet: () => greeting }) }),
      // H3/H4: a `persistent: true` store, exactly like `orders/providers.ts`'s
      // `OrderNotesToken` — carried across a hot update by the kernel itself.
      kernel.provide(contract.NotesToken, {
        scope: 'singleton',
        persistent: true,
        factory: () => kernel.defineStore<readonly string[]>([]),
      }),
    ];
  };
}

/**
 * `MODULE_ID`'s factory — **the exact shape
 * `@ng-react/babel-plugin-hmr` emits**, hand-written here rather than run
 * through Babel so this test exercises Metro's runtime semantics in
 * isolation from the transform (that pairing is `hmr-preset.test.ts`).
 * Compare this against `buildAcceptBlock` in `index.ts` line by line.
 */
const moduleFactory: MetroFactory = (_global, metroRequire, _importDefault, _importAll, module, exports) => {
  const kernel = metroRequire(KERNEL_ID) as typeof NgReactKernel;
  const contract = metroRequire(CONTRACT_ID) as Pick<GreeterContract, 'GreeterRef'>;
  const __ngReactModule = kernel.defineModule({
    id: contract.GreeterRef,
    dependsOn: [],
    load: 'eager',
    critical: false,
    // Plain `require`, not the `() => import('./x').then(...)` thunk ADR-7
    // mandates for a real ESM module file: this graph is hand-assembled
    // through Metro's synchronous `require`, and the thunk form is already
    // covered — this test is about the HMR runtime, not D1.
    providers: () => (metroRequire(PROVIDERS_ID) as { providers: unknown[] }).providers as never,
  });
  exports.module = __ngReactModule;
  if (typeof module !== 'undefined' && module.hot) {
    const __ngReactPrevModule = module.hot.__ngReactPrevModule as ModuleDescriptor | undefined;
    module.hot.__ngReactPrevModule = __ngReactModule;
    module.hot.accept(() => {
      kernel.hotReplaceModule(__ngReactPrevModule as ModuleDescriptor, __ngReactModule);
    });
  }
};

/** Builds the graph and activates the module. Returns the live kernel and its tokens. */
async function bootGraph(): Promise<
  { kernel: Kernel } & GreeterContract
> {
  globalThis.__d(kernelFactory, KERNEL_ID, []);
  globalThis.__d(contractFactory, CONTRACT_ID, []);
  globalThis.__d(makeProvidersFactory('v1'), PROVIDERS_ID, []);
  globalThis.__d(moduleFactory, MODULE_ID, []);

  const contract = globalThis.__r(CONTRACT_ID) as unknown as GreeterContract;
  const moduleExports = globalThis.__r(MODULE_ID) as { module: ModuleDescriptor };

  const kernel = kernelExports.createKernel({ modules: [moduleExports.module] });
  await kernel.activate(contract.GreeterRef);

  return { kernel, GreeterRef: contract.GreeterRef, GreeterToken: contract.GreeterToken, NotesToken: contract.NotesToken };
}

describe('Metro require.js + @ng-react/babel-plugin-hmr — real runtime', () => {
  it('editing providers.js (a child of module.js) hot-replaces through module.js\'s own accept, keeps persistent state, and never triggers a full refresh', async () => {
    const { kernel, GreeterToken, NotesToken } = await bootGraph();
    expect(kernel.get(GreeterToken).greet()).toBe('v1');

    const notes = kernel.get(NotesToken);
    notes.setState((current) => [...current, 'written before the edit']);
    expect(notes.getState()).toEqual(['written before the edit']);

    const hotReplaceCalls: unknown[] = [];
    const originalHotReplace = kernel.hotReplace.bind(kernel);
    kernel.hotReplace = async (ref, next) => {
      hotReplaceCalls.push(ref.id);
      await originalHotReplace(ref, next);
    };

    // The edit: a new generation of providers.js only. `module.js` itself
    // is not re-supplied a factory (`updatedID === id` is false for it in
    // Metro's own `runUpdatedModule`), so its *existing* factory re-runs
    // unchanged — which is exactly what makes this the "child" case the
    // task calls out, distinct from editing module.ts directly.
    globalThis.__accept(PROVIDERS_ID, makeProvidersFactory('v2'), [], {
      [PROVIDERS_ID]: [MODULE_ID],
      [MODULE_ID]: [],
    });

    await vi.waitFor(() => {
      expect(kernel.get(GreeterToken).greet()).toBe('v2');
    });

    // **Propagation stopped at module.js**: exactly one `hotReplace` call,
    // attributed to `greeter` (module.js's own module id) — never to
    // `providers.js`, which has no module id of its own in the kernel and
    // registers no accept callback at all.
    expect(hotReplaceCalls).toEqual(['greeter']);

    // H3/H4: the persistent store's *state* survived the re-activation this
    // edit triggered.
    expect(kernel.get(NotesToken)).not.toBe(notes);
    expect(kernel.get(NotesToken).getState()).toEqual(['written before the edit']);

    // **No full refresh.** `performFullRefresh` (private to require.js)
    // reloads via `window.location.reload` when it runs outside a React
    // Refresh runtime, which is exactly this test's environment (no
    // `$RefreshReg$`/`Refresh` installed) — so this is the reachable proxy
    // for "Metro did not escalate to a full refresh" the task asks for.
    const reload = (globalThis as unknown as { window: { location: { reload: () => void } } }).window.location
      .reload;
    expect(reload).not.toHaveBeenCalled();
  });

  it('editing module.ts itself also hot-replaces with no full refresh', async () => {
    const { kernel, GreeterToken } = await bootGraph();
    expect(kernel.get(GreeterToken).greet()).toBe('v1');

    // A "fresh evaluation" of module.ts: same shape, same providers
    // generation, but a structurally new descriptor object — exactly what a
    // real edit to module.ts (not its imports) hands the runtime.
    globalThis.__accept(MODULE_ID, moduleFactory, [], { [MODULE_ID]: [] });

    await vi.waitFor(() => {
      // `greet()` is unchanged (providers.js was not touched) — the
      // assertion is that the module re-activated at all, observed through
      // H6's epoch bump.
      expect(kernel.epochOf('greeter')).toBeGreaterThan(0);
    });

    const reload = (globalThis as unknown as { window: { location: { reload: () => void } } }).window.location
      .reload;
    expect(reload).not.toHaveBeenCalled();
  });
});
