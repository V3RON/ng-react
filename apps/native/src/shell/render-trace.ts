// **What the route outlet actually rendered**, as opposed to what the kernel
// logged.
//
// Issue #53 asks for a screenshot of "a lazy module activating from a drawer
// tap (the activating state, then the screen)". The activating state is real —
// `ModuleRoute` renders it, and it is the whole reason **A2** exposes
// `activating` to React rather than only `ready`/`failed` — but under Metro it
// lasts for one dynamic `import()` plus a synchronous `init`, which is
// single-digit milliseconds. No tooling that has to round-trip a tap and a
// screen capture over a socket can photograph that, and pretending otherwise
// by inserting an artificial delay would be staging the evidence rather than
// gathering it.
//
// So this store records, per module, the sequence of statuses the *outlet
// component actually rendered*. It is appended to from `ModuleRoute`'s render
// body, so a status only reaches it if React committed a render for it.
//
// **It is not a lifecycle log.** `kernel.subscribeStatus` would give the
// kernel's transitions, which is a different claim: a kernel that transitions
// `registered → activating → ready` proves nothing about whether any component
// ever painted the middle one. That distinction is the reason this file exists
// instead of a copy of `apps/react/src/lifecycle-log.ts`.
//
// It lives outside the container on purpose, for the same reason the web
// demo's lifecycle log does: every token in this app is owned by a module, and
// logout disposes modules, so a trace that lived in one would be withdrawn
// halfway through recording the cascade that withdrew it.

import { defineStore } from '@ng-react/kernel';
import type { ModuleStatus, Store } from '@ng-react/kernel';

/** One render of the route outlet for a module-bearing route. */
export interface RenderTraceEntry {
  readonly moduleId: string;
  readonly status: ModuleStatus;
}

/** Bounded, so a long session cannot grow without limit. */
const RENDER_TRACE_LIMIT = 100;

/** The trace, plus the two operations the app needs on it. */
export interface RenderTrace {
  /** **H3**'s blessed carrier, used here for app-level state rather than module state. */
  readonly store: Store<readonly RenderTraceEntry[]>;
  /** Appends `status` for `moduleId` unless it is already the latest for it (renders repeat). */
  record(moduleId: string, status: ModuleStatus): void;
  /** The statuses this module's outlet rendered, in order, deduplicated. */
  forModule(moduleId: string): readonly ModuleStatus[];
}

function createRenderTrace(): RenderTrace {
  const store = defineStore<readonly RenderTraceEntry[]>([]);

  return {
    store,
    record: (moduleId, status) => {
      const current = store.getState();
      // React re-renders a component many times for one status (a parent
      // re-render, a collection notification, StrictMode's double invoke).
      // Recording each would turn the trace into noise, and the claim being
      // made is "this status was rendered at least once, in this order".
      const latest = [...current].reverse().find((entry) => entry.moduleId === moduleId);
      if (latest?.status === status) {
        return;
      }
      store.setState((entries) => [...entries, { moduleId, status }].slice(-RENDER_TRACE_LIMIT));
    },
    forModule: (moduleId) =>
      store
        .getState()
        .filter((entry) => entry.moduleId === moduleId)
        .map((entry) => entry.status),
  };
}

/**
 * The app's single trace.
 *
 * Module scope rather than a provider, and rather than a parameter threaded
 * through the drawer: it is diagnostics for the demo, it must outlive every
 * module in it, and there is exactly one running app per process on a device.
 * A test that wants isolation reads `forModule` before and after rather than
 * constructing a second one — which is what `render-trace.test.ts` does.
 */
export const renderTrace: RenderTrace = createRenderTrace();
