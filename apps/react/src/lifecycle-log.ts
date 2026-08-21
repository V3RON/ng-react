// The demo's lifecycle log — the surface that makes **A4**'s disposal
// *order* visible rather than merely its end state.
//
// **Why the log is fed by `kernel.subscribeStatus` and not by the modules
// themselves.** A module could append "I am being disposed" from a `ctx`
// cleanup, and the log would then be self-reported: its ordering would be the
// ordering of the modules' own code, which is exactly the thing under test.
// Status transitions are the kernel's (**A2**, **C9**'s spirit), so a log
// built from them cannot flatter the implementation — if the cascade ran in
// the wrong order, this log would say so.
//
// It lives outside the container on purpose. Every token in this app is owned
// by a module, and a logout disposes modules; a log that lived in one of them
// would be withdrawn halfway through recording the cascade that withdrew it.

import { defineStore } from '@ng-react/kernel';
import type { Kernel, ModuleRef, ModuleStatus, Store, Unsubscribe } from '@ng-react/kernel';

/** One observed transition. `seq` is a total order across modules. */
export interface LifecycleEvent {
  readonly seq: number;
  readonly moduleId: string;
  readonly status: ModuleStatus;
}

/** **H3**'s blessed carrier, used here for app-level state rather than module state. */
export type LifecycleLog = Store<readonly LifecycleEvent[]>;

/** How many transitions the demo keeps. Bounded, so a long session cannot grow without limit. */
const LIFECYCLE_LOG_LIMIT = 200;

/**
 * Subscribes to every ref's status and records the transitions in order.
 *
 * `subscribeStatus` does not fire on subscribe (the same rule as every other
 * subscription in the kernel), so the log starts empty and the first entries
 * are the eager activations — which is what makes "the app started, and then
 * `debug` failed" readable straight off the log.
 */
export function attachLifecycleLog(
  kernel: Kernel,
  refs: readonly ModuleRef[],
): { readonly log: LifecycleLog; readonly detach: Unsubscribe } {
  const log: LifecycleLog = defineStore<readonly LifecycleEvent[]>([]);
  let seq = 0;

  const unsubscribes = refs.map((ref) =>
    kernel.subscribeStatus(ref, (status) => {
      seq += 1;
      const event: LifecycleEvent = { seq, moduleId: ref.id, status };
      log.setState((current) => [...current, event].slice(-LIFECYCLE_LOG_LIMIT));
    }),
  );

  return {
    log,
    detach: () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    },
  };
}

/** The ids, in order, that reached `status` — the assertion shape A4 is about. */
export function sequenceOf(log: LifecycleLog, status: ModuleStatus): readonly string[] {
  return log
    .getState()
    .filter((event) => event.status === status)
    .map((event) => event.moduleId);
}
