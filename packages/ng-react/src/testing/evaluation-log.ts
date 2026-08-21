// Evaluation-order instrumentation — **acceptance criterion 9**.
//
// Criterion 9: "with all modules `lazy` except `auth`, no implementation
// file of a lazy module is evaluated before its activation trigger (verified
// via evaluation-order instrumentation in dev)." That is an *ordering*
// claim, so the log records a sequence, and the assertions this file exists
// to support compare **positions**, never mere membership.
//
// Two kinds of event land in the log:
//
//  - **kernel-driven**, recorded by `test-kernel.ts` as it wraps a
//    descriptor: `<activate>` when a trigger calls `kernel.activate(ref)`,
//    `<providers>` when the descriptor's providers thunk is called, and
//    `<init>` when `init(ctx)` is called (ADR-7: both may be sync or async;
//    the event is recorded at the call, which is the moment the
//    implementation module is evaluated).
//  - **module-driven**, recorded by `recordEvaluation(moduleId, file)` at
//    the top of a generated implementation file. Stage 7's `create-module`
//    generator emits that call; stage 8 asserts against it in the demo app.
//
// ## The one piece of module-level mutable state in this package
//
// `recordEvaluation(moduleId, file)` is specified with no kernel argument —
// it is called from a module's own top level, where no kernel handle exists
// (that is the entire point: the file is being evaluated *before* anything
// hands it one). Some process-wide rendezvous is therefore unavoidable, and
// it sits here, deliberately narrow:
//
//  - `liveRecorders` — the recorders of test kernels that exist and have not
//    been disposed. A `recordEvaluation` call fans out to **all** of them,
//    because a file evaluation is a process-wide event: it genuinely
//    happened during every live kernel's lifetime, and attributing it to one
//    of them would be a guess.
//  - `recorderByKernel` — a `WeakMap` so `evaluationLog(kernel)` can find a
//    kernel's own log. Weak, so a dropped kernel is collectable.
//
// Neither is shared *state* between kernels: each recorder owns its own log
// and its own sequence counter, so two test kernels in one file still report
// independently. `test-kernel.ts`'s `dispose()` removes its recorder from
// `liveRecorders`, so a disposed kernel stops accumulating; its log stays
// readable.
//
// ADR-6: no `react` import.

import { InvalidDescriptorError } from '../errors';
import type { Kernel } from '../kernel/kernel';

/** One evaluation event. `at` is the recorder's own logical clock — see `EvaluationRecorder`. */
export interface EvaluationEvent {
  readonly moduleId: string;
  readonly file: string;
  readonly at: number;
}

/**
 * One test kernel's evaluation log.
 *
 * `at` is a per-recorder sequence number rather than a timestamp on purpose:
 * criterion 9 is a strict-ordering claim, and `Date.now()` ties at
 * millisecond resolution for exactly the fast synchronous evaluations this
 * log is watching — two entries with the same `at` would make "before"
 * unanswerable.
 */
export class EvaluationRecorder {
  private readonly events: EvaluationEvent[] = [];
  private sequence = 0;

  /** Appends one event. */
  record(moduleId: string, file: string): void {
    this.events.push(Object.freeze({ moduleId, file, at: this.sequence++ }));
  }

  /** The log so far, oldest first. A snapshot: later events do not mutate it. */
  snapshot(): readonly EvaluationEvent[] {
    return Object.freeze([...this.events]);
  }
}

/** See the file header. Registered by `createTestKernel`, removed by `dispose()`. */
const liveRecorders = new Set<EvaluationRecorder>();

/** See the file header. Weak, so holding a log open cannot pin a kernel. */
const recorderByKernel = new WeakMap<Kernel, EvaluationRecorder>();

/** Internal: binds `recorder` to `kernel` and starts fanning `recordEvaluation` into it. */
export function attachRecorder(kernel: Kernel, recorder: EvaluationRecorder): void {
  recorderByKernel.set(kernel, recorder);
  liveRecorders.add(recorder);
}

/**
 * Internal: stops fanning events into `recorder`. The binding to its kernel
 * survives, so `evaluationLog(kernel)` still answers after `dispose()` —
 * which is when most criterion-9 assertions actually run.
 */
export function detachRecorder(recorder: EvaluationRecorder): void {
  liveRecorders.delete(recorder);
}

/**
 * **Acceptance criterion 9**: records that `file` of module `moduleId` was
 * evaluated. Called from the top level of a generated implementation file:
 *
 * ```ts
 * recordEvaluation('orders', 'orders/providers.ts');
 * ```
 *
 * A no-op when no test kernel is live — an implementation file imported by
 * production code must not pay for, or depend on, this instrumentation.
 */
export function recordEvaluation(moduleId: string, file: string): void {
  for (const recorder of liveRecorders) {
    recorder.record(moduleId, file);
  }
}

/**
 * **Acceptance criterion 9**: the evaluation log of a kernel created by
 * `createTestKernel`, oldest first.
 *
 * @throws {InvalidDescriptorError} for any other kernel. Returning an empty
 *   log instead would let an ordering assertion pass vacuously against a
 *   kernel that was never instrumented, which is the one failure mode this
 *   function exists to rule out.
 */
export function evaluationLog(kernel: Kernel): readonly EvaluationEvent[] {
  const recorder = recorderByKernel.get(kernel);
  if (recorder === undefined) {
    throw new InvalidDescriptorError(
      'evaluationLog(): this kernel was not created by createTestKernel(), so nothing recorded its ' +
        'evaluation order. Create it with createTestKernel({ modules }) to use evaluation-order instrumentation.',
    );
  }
  return recorder.snapshot();
}
