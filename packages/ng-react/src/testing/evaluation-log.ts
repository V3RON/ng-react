// Evaluation-order instrumentation: proof that a lazy module's
// implementation files are not evaluated before its activation trigger.
//
// `recordEvaluation` takes no kernel argument, because it is called from a
// module's own top level, before anything has handed that file a kernel
// handle. The two process-wide maps below are that rendezvous:
//
//  - `liveRecorders` — the recorders of test kernels that exist and have not
//    been disposed. A call fans out to all of them: a file evaluation is a
//    process-wide event that genuinely happened during every live kernel's
//    lifetime.
//  - `recorderByKernel` — a `WeakMap`, so `evaluationLog(kernel)` can find a
//    kernel's own log without pinning the kernel.
//
// Neither is shared state between kernels: each recorder owns its own log
// and its own sequence counter.

import { InvalidDescriptorError } from '../errors';
import type { Kernel } from '../kernel/kernel';

/** One recorded evaluation of a module's implementation file. */
export interface EvaluationEvent {
  readonly moduleId: string;
  readonly file: string;
  /** The recorder's own sequence number. Strictly increasing, never tied. */
  readonly at: number;
}

/**
 * One test kernel's evaluation log.
 *
 * `at` is a sequence number rather than a timestamp because `Date.now()`
 * ties at millisecond resolution for the fast synchronous evaluations this
 * log watches, and a tie makes "before" unanswerable.
 */
export class EvaluationRecorder {
  private readonly events: EvaluationEvent[] = [];
  private sequence = 0;

  /** Appends one event. */
  record(moduleId: string, file: string): void {
    this.events.push(Object.freeze({ moduleId, file, at: this.sequence++ }));
  }

  /** Returns the log so far, oldest first. Later events do not mutate it. */
  snapshot(): readonly EvaluationEvent[] {
    return Object.freeze([...this.events]);
  }
}

/** Registered by `createTestKernel`, removed by its `dispose()`. */
const liveRecorders = new Set<EvaluationRecorder>();

/** Weak, so holding a log open cannot pin a kernel. */
const recorderByKernel = new WeakMap<Kernel, EvaluationRecorder>();

/** Binds `recorder` to `kernel` and starts fanning `recordEvaluation` into it. */
export function attachRecorder(kernel: Kernel, recorder: EvaluationRecorder): void {
  recorderByKernel.set(kernel, recorder);
  liveRecorders.add(recorder);
}

/**
 * Stops fanning events into `recorder`. The binding to its kernel survives,
 * so `evaluationLog(kernel)` still answers after the kernel is disposed.
 */
export function detachRecorder(recorder: EvaluationRecorder): void {
  liveRecorders.delete(recorder);
}

/**
 * Records that `file` of module `moduleId` was evaluated. Call it from the
 * top level of an implementation file.
 *
 * A no-op when no test kernel is live, so production code pays nothing for
 * the call.
 *
 * @example
 * ```ts
 * recordEvaluation('orders', 'orders/providers.ts');
 * ```
 */
export function recordEvaluation(moduleId: string, file: string): void {
  for (const recorder of liveRecorders) {
    recorder.record(moduleId, file);
  }
}

/**
 * Returns the evaluation log of a kernel created by `createTestKernel`,
 * oldest first.
 *
 * @throws {InvalidDescriptorError} For any other kernel. An empty log would
 *   let an ordering assertion pass vacuously against a kernel that was never
 *   instrumented.
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
