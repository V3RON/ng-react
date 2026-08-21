// The demo's root tree and the two screens its startup gate chooses between.
//
// The gate lives here rather than in `App.tsx` because `App.tsx` is the
// diagnostic surface, mounted directly by the acceptance suite, which must
// keep reaching it with no gate in front of it.

import type { ReactElement } from 'react';
import { AppKernel, KernelStartupGate } from '@ng-react/kernel';
import type { Kernel } from '@ng-react/kernel';
import { App } from '../App';
import type { LifecycleLog } from '../lifecycle-log';

/**
 * The whole of the web demo's root tree: the kernel provider, the startup
 * gate, and the app behind it.
 *
 * `main.tsx` renders this and nothing else, so what a test mounts is what
 * ships.
 *
 * The gate waits for `auth`, the demo's one eager critical module. `debug`
 * fails on purpose, and `nav`, `dashboard` and `shell` are eager but not
 * critical; none of them can hold the first paint up.
 */
export function AppRoot(props: {
  readonly kernel: Kernel;
  readonly log: LifecycleLog;
}): ReactElement {
  return (
    <AppKernel kernel={props.kernel}>
      <KernelStartupGate
        fallback={<StartupSplash />}
        renderFailure={(error) => <StartupFailed error={error} />}
      >
        <App log={props.log} />
      </KernelStartupGate>
    </AppKernel>
  );
}

/** The web equivalent of a native splash screen, shown while the kernel starts. */
function StartupSplash(): ReactElement {
  return (
    <main aria-busy="true" data-testid="startup-splash">
      <h1>ng-react kernel</h1>
      <p className="note">
        Starting the kernel — waiting for the eager <strong>critical</strong> modules (A3). Eager{' '}
        <em>non-critical</em> modules are deliberately not waited for: <code>debug</code> fails on
        purpose and must not be able to hold this screen up.
      </p>
    </main>
  );
}

/**
 * Shown instead of the app when an eager critical module could not start.
 *
 * The kernel's own error is rendered verbatim: it names the module and the
 * phase. There is no retry control, because a kernel whose critical startup
 * failed does not start again.
 */
function StartupFailed(props: { readonly error: unknown }): ReactElement {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <main data-testid="startup-failed">
      <h1>Startup failed</h1>
      <p className="note">
        F2: an eager <code>critical: true</code> module could not become ready, so
        <code> kernel.whenStartupComplete()</code> rejected and the app was never rendered. The
        splash is gone rather than stuck — a gate that handled only the success path would still be
        showing it.
      </p>
      <p>
        <code className="status status-failed">{message}</code>
      </p>
    </main>
  );
}
