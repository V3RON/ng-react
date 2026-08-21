// `.test.tsx` → the **kernel-dom** project (jsdom + the React plugin).
// AGENTS.md §3: a `.test.ts` under `src/react/` would run in the React-free
// node project and break ADR-6's machine check.
//
// Everything renders under `<StrictMode>`: double-invoked renders and
// double-run effects are a requirement of R1/R2, not a hazard to work
// around.

import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppKernel, ModuleScope, useKernel, useModuleScope } from './context';
import { useService } from './hooks';
import { defineModule } from '../define-module';
import { KernelError } from '../errors';
import { createKernel } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import { provide } from '../provider';
import { createToken, MODULE_ID } from '../token';

// --- fixtures: realistically and *differently* typed services (AGENTS.md §9) ---

const platformRef = moduleRef('platform');

/** A transient provider, so `MODULE_ID` reflects the *actual* requester of
 *  each resolution rather than whichever module resolved first (C2's
 *  `module`/`singleton` caches would freeze the first one in). */
interface RequestLogger {
  readonly scopeId: string;
  format(line: string): string;
}
const RequestLoggerToken = createToken<RequestLogger>('platform/RequestLogger');

const platform = defineModule({
  id: platformRef,
  providers: () => [
    provide(RequestLoggerToken, {
      scope: 'transient',
      deps: [MODULE_ID],
      factory: (scopeId: string): RequestLogger => ({
        scopeId,
        format: (line) => `[${scopeId}] ${line}`,
      }),
    }),
  ],
});

async function startKernel(): Promise<Kernel> {
  const kernel = createKernel({ modules: [platform] });
  await kernel.whenStartupComplete();
  await kernel.activate(platformRef);
  return kernel;
}

function Tree(props: { kernel: Kernel; children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <AppKernel kernel={props.kernel}>{props.children}</AppKernel>
    </StrictMode>
  );
}

/** React logs a render-phase throw through `console.error`; silence it so a
 *  deliberate failure does not look like a broken suite. */
function silenceReactErrorLogging(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<AppKernel> and useKernel (R1)', () => {
  it('R1: provides the kernel to the subtree', async () => {
    const kernel = await startKernel();
    function Probe(): ReactNode {
      return <span data-testid="same">{String(useKernel() === kernel)}</span>;
    }

    render(
      <Tree kernel={kernel}>
        <Probe />
      </Tree>,
    );

    expect(screen.getByTestId('same').textContent).toBe('true');
  });

  it('R1: nesting <AppKernel> throws, naming the rule and createTestKernel', async () => {
    const kernel = await startKernel();
    silenceReactErrorLogging();

    expect(() =>
      render(
        <Tree kernel={kernel}>
          <AppKernel kernel={kernel}>
            <span>inner</span>
          </AppKernel>
        </Tree>,
      ),
    ).toThrow(
      'Nested <AppKernel>: there is exactly one kernel per app (R1). ' +
        'Remove the inner <AppKernel> and let the subtree read the outer one with useKernel(). ' +
        'If you need a second, isolated kernel — in a test — build it with createTestKernel() ' +
        'and render it as the only <AppKernel> of that tree (R4).',
    );
  });

  it('R1: the nesting error is a KernelError, not a bare Error', async () => {
    const kernel = await startKernel();
    silenceReactErrorLogging();

    let thrown: unknown;
    try {
      render(
        <Tree kernel={kernel}>
          <AppKernel kernel={kernel}>
            <span>inner</span>
          </AppKernel>
        </Tree>,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(KernelError);
    expect((thrown as KernelError).code).toBe('REACT_NESTED_APP_KERNEL');
  });

  it('R1: useKernel outside <AppKernel> throws, naming the hook and the fix', () => {
    silenceReactErrorLogging();
    function Orphan(): ReactNode {
      return <span>{String(useKernel() !== undefined)}</span>;
    }

    expect(() =>
      render(
        <StrictMode>
          <Orphan />
        </StrictMode>,
      ),
    ).toThrow(
      'useKernel() was called outside <AppKernel> (R1). ' +
        'Wrap the tree in <AppKernel kernel={kernel}> at the composition root, ' +
        'or, in a test, in <AppKernel kernel={createTestKernel({ modules: [...] })}>.',
    );
  });

  it('R1: useService outside <AppKernel> names useService, not an internal helper', () => {
    silenceReactErrorLogging();
    function Orphan(): ReactNode {
      // eslint-disable-next-line ng-react-modules/no-transient-in-component -- resolving a transient at component top level is the behaviour under test (R2).
      return <span>{useService(RequestLoggerToken).scopeId}</span>;
    }

    expect(() =>
      render(
        <StrictMode>
          <Orphan />
        </StrictMode>,
      ),
    ).toThrow(/^useService\(\) was called outside <AppKernel> \(R1\)\./);
  });
});

describe('<ModuleScope> and useModuleScope (R2, ADR-2)', () => {
  function ScopeProbe(props: { testId: string }): ReactNode {
    return <span data-testid={props.testId}>{useModuleScope()}</span>;
  }

  function LoggerProbe(props: { testId: string }): ReactNode {
    // eslint-disable-next-line ng-react-modules/no-transient-in-component -- resolving a transient at component top level is the behaviour under test (R2).
    return <span data-testid={props.testId}>{useService(RequestLoggerToken).format('hi')}</span>;
  }

  it("ADR-2: outside any <ModuleScope> the resolution context is the reserved id 'app'", async () => {
    const kernel = await startKernel();

    render(
      <Tree kernel={kernel}>
        <ScopeProbe testId="scope" />
        <LoggerProbe testId="logger" />
      </Tree>,
    );

    expect(screen.getByTestId('scope').textContent).toBe('app');
    // ADR-2 again, this time through the container: MODULE_ID resolved for
    // an app-root React resolution is `'app'`, never `undefined`.
    expect(screen.getByTestId('logger').textContent).toBe('[app] hi');
  });

  it('R2/C4: <ModuleScope> sets the resolution context for its subtree', async () => {
    const kernel = await startKernel();
    const ordersRef = moduleRef('orders');

    render(
      <Tree kernel={kernel}>
        <ModuleScope module={ordersRef}>
          <ScopeProbe testId="scope" />
          <LoggerProbe testId="logger" />
        </ModuleScope>
      </Tree>,
    );

    expect(screen.getByTestId('scope').textContent).toBe('orders');
    expect(screen.getByTestId('logger').textContent).toBe('[orders] hi');
  });

  it('R2: <ModuleScope> nests, and the innermost wins', async () => {
    const kernel = await startKernel();
    const ordersRef = moduleRef('orders');
    const analyticsRef = moduleRef('analytics');

    render(
      <Tree kernel={kernel}>
        <ModuleScope module={ordersRef}>
          <ScopeProbe testId="outer" />
          <ModuleScope module={analyticsRef}>
            <ScopeProbe testId="inner" />
            <LoggerProbe testId="inner-logger" />
          </ModuleScope>
        </ModuleScope>
      </Tree>,
    );

    expect(screen.getByTestId('outer').textContent).toBe('orders');
    expect(screen.getByTestId('inner').textContent).toBe('analytics');
    expect(screen.getByTestId('inner-logger').textContent).toBe('[analytics] hi');
  });

  it('R2: two sibling scopes resolve independently', async () => {
    const kernel = await startKernel();
    const ordersRef = moduleRef('orders');
    const billingRef = moduleRef('billing');

    render(
      <Tree kernel={kernel}>
        <ModuleScope module={ordersRef}>
          <LoggerProbe testId="orders" />
        </ModuleScope>
        <ModuleScope module={billingRef}>
          <LoggerProbe testId="billing" />
        </ModuleScope>
      </Tree>,
    );

    expect(screen.getByTestId('orders').textContent).toBe('[orders] hi');
    expect(screen.getByTestId('billing').textContent).toBe('[billing] hi');
  });

  it('R2: useModuleScope outside <AppKernel> is still valid — it needs no kernel', () => {
    render(
      <StrictMode>
        <ScopeProbe testId="scope" />
      </StrictMode>,
    );

    expect(screen.getByTestId('scope').textContent).toBe('app');
  });
});
