// `.test.tsx` → the **kernel-dom** project (jsdom + the React plugin).
// AGENTS.md §3: a `.test.ts` under `src/react/` would run in the React-free
// node project and break ADR-6's machine check.
//
// Everything renders under `<StrictMode>`, for the reason `context.test.tsx`
// gives: double-invoked renders and double-run effects are a requirement of
// the R-series, not a hazard to work around.

import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppKernel } from './context';
import { KernelStartupGate, useKernelStartup } from './startup';
import type { KernelStartupState } from './startup-store';
import { defineModule } from '../define-module';
import { KernelError } from '../errors';
import { createKernel } from '../kernel/kernel';
import type { Kernel, KernelOptions } from '../kernel/kernel';
import { moduleRef } from '../module-ref';

// --- fixtures ---------------------------------------------------------------

const AuthModule = moduleRef('auth');
// Sorts *after* `auth`, which is load-bearing: §6 step 2 activates eager
// modules sequentially in topological order, so a module that never finishes
// its `init` blocks every eager module after it. Putting the slow one last is
// what makes "the gate opened while this one was still activating" a statement
// about the *gate* and not about activation order.
const DebugModule = moduleRef('debug');

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A kernel with `onFatal` supplied by default. Not because these tests are
 * about F2's fatal handler, but because its *default* rethrows from a
 * macrotask — an uncaught exception in the run rather than a failure in the
 * test that caused it. `kernel.test.ts` does the same and says so.
 */
function kernelWith(options: Omit<KernelOptions, 'onFatal'>): Kernel {
  return createKernel({ onFatal: vi.fn(), ...options });
}

function Tree(props: { kernel: Kernel; children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <AppKernel kernel={props.kernel}>{props.children}</AppKernel>
    </StrictMode>
  );
}

/** The one gate every test in this file renders, so the props stay honest. */
function Gate(props: { readonly children?: ReactNode }): ReactNode {
  return (
    <KernelStartupGate
      fallback={<span data-testid="splash">splash</span>}
      renderFailure={(error) => (
        <span data-testid="failure">{error instanceof Error ? error.message : String(error)}</span>
      )}
    >
      {props.children ?? <span data-testid="app">app</span>}
    </KernelStartupGate>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the two paths ----------------------------------------------------------

describe('<KernelStartupGate> / useKernelStartup (A3, F2)', () => {
  it('A3: renders the fallback while startup is pending and the children once it is ready', async () => {
    const init = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({
          id: AuthModule,
          load: 'eager',
          critical: true,
          init: () => init.promise,
        }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );

    // The gate is genuinely *closed* here: this assertion is what stops the
    // test passing on a gate that renders its children unconditionally.
    expect(screen.getByTestId('splash')).toBeDefined();
    expect(screen.queryByTestId('app')).toBeNull();

    init.resolve();

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    expect(screen.queryByTestId('splash')).toBeNull();
    expect(kernel.status(AuthModule)).toBe('ready');
  });

  it('F2: a critical startup failure renders renderFailure(error), never the children and never the fallback', async () => {
    const kernel = kernelWith({
      modules: [
        defineModule({
          id: AuthModule,
          load: 'eager',
          critical: true,
          init: () => {
            throw new Error('no keychain');
          },
        }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );

    // "Does not hang" is the assertion `waitFor` makes: a gate that handled
    // only the resolve path would sit on the splash until this times out.
    await waitFor(() => {
      expect(screen.getByTestId('failure')).toBeDefined();
    });
    // The error reaches the consumer verbatim — the kernel's own F2 message,
    // naming the module and the phase, not a wrapper.
    expect(screen.getByTestId('failure').textContent).toBe(
      "Activating module 'auth' failed in its init(ctx): no keychain",
    );
    expect(screen.queryByTestId('app')).toBeNull();
    // The stranded-splash bug, asserted directly: the fallback must be gone.
    expect(screen.queryByTestId('splash')).toBeNull();
  });

  it('F2: the failed state carries the rejection of whenStartupComplete() unchanged', async () => {
    const kernel = kernelWith({
      modules: [
        defineModule({
          id: AuthModule,
          load: 'eager',
          critical: true,
          init: () => {
            throw new Error('no keychain');
          },
        }),
      ],
    });
    const rejection = await kernel.whenStartupComplete().then(
      () => undefined,
      (error: unknown) => error,
    );

    const states: KernelStartupState[] = [];
    function Probe(): ReactNode {
      const state = useKernelStartup();
      if (states.at(-1) !== state) {
        states.push(state);
      }
      return null;
    }
    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    await waitFor(() => {
      expect(states.at(-1)?.status).toBe('failed');
    });
    const last = states.at(-1);
    expect(last?.status === 'failed' && last.error).toBe(rejection);
    expect(last?.status === 'failed' && last.error instanceof KernelError).toBe(true);
  });
});

// --- A3's actual condition — the test most likely to be "fixed" into a bug ---

describe('A3: the gate waits for startup-critical modules and for nothing else', () => {
  it('A3: opens while a quarantined eager non-critical module is still activating', async () => {
    const authInit = deferred<void>();
    const debugInit = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: () => authInit.promise }),
        // Eager, non-critical, and its `init` never settles on its own. This
        // is the demo's `debug` module in miniature: A3 says it must not hold
        // the splash up, and an `init` that is *still running* is the strongest
        // form of that claim — a gate that waited for "all eager modules" could
        // not possibly pass this test.
        defineModule({ id: DebugModule, load: 'eager', init: () => debugInit.promise }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );
    authInit.resolve();

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    // **The anti-vacuity guard.** Without these two lines the test would pass
    // even if `debug` had quietly finished before the gate opened, and it
    // would then be asserting nothing about A3 at all.
    expect(kernel.status(DebugModule)).toBe('activating');
    expect(kernel.status(AuthModule)).toBe('ready');

    // Let it finish, so the suite leaves no module mid-`init` and no
    // activation timeout pending.
    debugInit.resolve();
    await waitFor(() => {
      expect(kernel.status(DebugModule)).toBe('ready');
    });
  });

  it('F3/A3: opens even though an eager non-critical module has already failed', async () => {
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true }),
        defineModule({
          id: DebugModule,
          load: 'eager',
          init: () => {
            throw new Error('debug panel unavailable');
          },
        }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    expect(screen.queryByTestId('failure')).toBeNull();
    expect(kernel.status(DebugModule)).toBe('failed');
  });

  it('#61: with no startup-critical module the gate opens immediately and warns', async () => {
    // **Pinning a behaviour, not endorsing it.** Issue #61 finding 2: the
    // With no critical module in an eager module's activation closure,
    // `whenStartupComplete()` resolves straight away — here while both modules
    // are still activating. The warning keeps that deliberate behavior visible.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authInit = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', init: () => authInit.promise }),
        defineModule({ id: DebugModule, load: 'eager' }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    expect(kernel.status(AuthModule)).toBe('activating');
    expect(kernel.status(DebugModule)).toBe('registered');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('no critical module is in the startup activation closure');

    authInit.resolve();
    await waitFor(() => {
      expect(kernel.status(AuthModule)).toBe('ready');
    });
  });

  it('#61: no warning when something is actually gated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kernel = kernelWith({
      modules: [defineModule({ id: AuthModule, load: 'eager', critical: true })],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('#61: no warning when an eager module pulls a lazy critical dependency into startup', async () => {
    const LazyCriticalModule = moduleRef('lazy-critical');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const init = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: LazyCriticalModule, critical: true, init: () => init.promise }),
        defineModule({ id: AuthModule, dependsOn: [LazyCriticalModule], load: 'eager' }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );

    expect(screen.getByTestId('splash')).toBeDefined();
    expect(warn).not.toHaveBeenCalled();

    init.resolve();
    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
  });
});

// --- the binding discipline every hook in this package is held to -----------

describe('the gate under StrictMode, and the primitive it is sugar over', () => {
  it('R1/A3: the subscription survives StrictMode mount/unmount/remount — the gate still opens', async () => {
    const init = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: () => init.promise }),
      ],
    });

    render(
      <Tree kernel={kernel}>
        <Gate />
      </Tree>,
    );
    // The store is settled *after* StrictMode's simulated remount, so a
    // subscription lost on the discarded mount would never be replaced and the
    // gate would sit on the splash forever.
    init.resolve();

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
  });

  it('A3: getSnapshot is referentially stable — exactly two distinct states across every render', async () => {
    const init = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: () => init.promise }),
      ],
    });

    // A fresh object from `getSnapshot` would re-render forever, which is the
    // rule `hooks.ts` opens with. Counting *distinct* snapshots rather than
    // renders is what makes this assertion survive StrictMode's double-invoked
    // render, which legitimately doubles the render count and must not change
    // the number of states.
    const distinct: KernelStartupState[] = [];
    function Probe(): ReactNode {
      const state = useKernelStartup();
      if (!distinct.includes(state)) {
        distinct.push(state);
      }
      return <span data-testid="status">{state.status}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );
    init.resolve();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('ready');
    });
    expect(distinct.map((state) => state.status)).toEqual(['pending', 'ready']);
  });

  it('A3: two consumers under one <AppKernel> share one startup state', async () => {
    const init = deferred<void>();
    const kernel = kernelWith({
      modules: [
        defineModule({ id: AuthModule, load: 'eager', critical: true, init: () => init.promise }),
      ],
    });

    const seen: KernelStartupState[] = [];
    function Probe(): ReactNode {
      seen.push(useKernelStartup());
      return null;
    }

    render(
      <Tree kernel={kernel}>
        <Gate>
          <span data-testid="app">app</span>
        </Gate>
        <Probe />
      </Tree>,
    );
    init.resolve();

    await waitFor(() => {
      expect(screen.getByTestId('app')).toBeDefined();
    });
    // One store per `<AppKernel>`: every consumer reads the *same* snapshot
    // object, so a remount after startup reads `ready` on its first render
    // rather than flashing the fallback.
    expect(new Set(seen).size).toBe(2);
  });

  it('R1: useKernelStartup outside <AppKernel> throws, naming the hook', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe(): ReactNode {
      useKernelStartup();
      return null;
    }
    expect(() =>
      render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    ).toThrow(/useKernelStartup\(\) requires an enclosing <AppKernel>\./);
  });
});
