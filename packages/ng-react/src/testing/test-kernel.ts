// `createTestKernel` — spec §12 **R4**.
//
// R4: "`createTestKernel({ modules, overrides })` builds an isolated kernel
// for tests: activate a module with mocked providers (via `override: true`),
// drive its lifecycle, dispose, and assert via `kernel.inspect()` and
// H7-style leak counters that nothing survived. This harness is part of the
// kernel package, not an afterthought."
//
// Everything a test needs that a production kernel does not is added here,
// **around** `createKernel` rather than inside it: the kernel gets no test
// hooks, no dev-only branches and no new options because of this file. The
// harness works with three seams that already exist:
//
//  1. **Descriptors are values.** Overriding, instrumenting and
//     evaluation-recording are all done by handing `createKernel` wrapped
//     descriptors (D1's thunks stay thunks — nothing is evaluated earlier
//     than it would have been).
//  2. **Error reporting is a contribution collection (F4).** The harness's
//     default error sink is an ordinary `contribute(ErrorSinkToken, …)` from
//     an ordinary module, so it travels the same path a real telemetry
//     module's sink does, buffering and flushing included.
//  3. **Teardown is A4's cascade.** `dispose()` is one
//     `kernel.deactivate(harness)`; the cascade does reverse topological
//     order for us because every module under test depends on the harness
//     module (see `HARNESS_MODULE_ID` below).
//
// ADR-6: no `react` import — this file, and every test of it, runs in
// vitest's **node** project. That is the machine-checked proof of acceptance
// criterion 7 ("in a plain Jest/Vitest environment with no React renderer").

import { defineModule } from '../define-module';
import type { ModuleDescriptor } from '../define-module';
import { InvalidDescriptorError } from '../errors';
import { ErrorSinkToken } from '../kernel/failure';
import { KernelImpl } from '../kernel/kernel';
import type { Kernel } from '../kernel/kernel';
import { moduleRef } from '../module-ref';
import type { ModuleRef } from '../module-ref';
import { contribute } from '../provider';
import type { AnyProviderRecord } from '../provider';
import type { ErrorInfo, ModuleContext } from '../types';
import { attachRecorder, detachRecorder, EvaluationRecorder } from './evaluation-log';
import { instrumentContext, instrumentRecords, LeakCounters, rebuildRecord } from './leak-counters';
import type { LeakReport } from './leak-counters';

/**
 * The id of the module the harness itself registers. It carries the default
 * error sink and the `overrides`, and every module under test is made to
 * depend on it (see `createTestKernel`).
 *
 * A module under test may not use this id — `createKernel` raises M3's
 * `DuplicateModuleIdError` naming both if one does, which is the correct and
 * legible failure.
 */
const HARNESS_MODULE_ID = 'ng-react/test-kernel';

/** R4: low by default so a hung `init` fails a test fast instead of stalling CI. */
const DEFAULT_TEST_INIT_TIMEOUT_MS = 1000;
/** R4: same reasoning as `DEFAULT_TEST_INIT_TIMEOUT_MS`, for ADR-1's awaited disposal. */
const DEFAULT_TEST_DISPOSE_TIMEOUT_MS = 500;

/** Options accepted by `createTestKernel` (R4). */
export interface TestKernelOptions {
  /** The descriptors under test, exactly as the composition root would list them. */
  readonly modules: readonly ModuleDescriptor[];
  /**
   * **C6**: mock providers, re-declared with `override: true` and registered
   * by the harness module. An override for a token no module provides is
   * allowed — that is a pure mock.
   *
   * Typed `AnyProviderRecord` per ADR-10: a heterogeneous array of records
   * has no common supertype expressible with `unknown`.
   */
  readonly overrides?: readonly AnyProviderRecord[];
  /** A3. Default `1000` here, not the kernel's `10_000` — see the file header. */
  readonly initTimeoutMs?: number;
  /** ADR-1. Default `500` here, not the kernel's `2_000`. */
  readonly disposeTimeoutMs?: number;
  /**
   * Dev-mode instrumentation. Default `true` — a test kernel is a dev
   * kernel. Set `false` to assert that the H7 counters are inert, which is
   * the only reason this option exists (it is not in the issue's sketch of
   * this interface; see the PR).
   */
  readonly dev?: boolean;
  /**
   * **F2**: what to do when a `critical` eager module fails startup.
   * Defaults to a **no-op**, unlike `createKernel`, whose default rethrows
   * from a fresh macrotask. In a test runner that macrotask throw lands in
   * an unrelated test, or takes the worker down, while the failure itself is
   * already fully observable here: in `errors`, in `status(ref)`, in
   * `inspect()`, and as a rejection of `whenStartupComplete()`. Pass a
   * handler to observe F2 itself.
   */
  readonly onFatal?: (error: unknown) => void;
}

/** One routed error, as collected by the harness's default sink (F4). */
export interface CollectedError {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/**
 * A `Kernel` with the three things a test needs on top (R4).
 *
 * ### Why the H6 epoch members are plain delegation and not recorded
 *
 * `errors` and `leaks()` exist because the things they expose have **no**
 * other read surface: a routed error would otherwise reach `console`, and
 * listener/effect counts are invisible by construction. Epochs are the
 * opposite case — H6 already ships a first-class read surface, and it is
 * shaped for exactly this question. `epochOf(moduleId)` *is* the count of
 * bumps for that module (it starts at `0` and increases by one per bump), so
 * "how many HMR cycles did this module go through" needs no recording, and
 * `subscribeEpoch(undefined, cb)` gives cross-module bump ordering in three
 * lines inside the test that wants it:
 *
 * ```ts
 * const bumps: string[] = [];
 * kernel.subscribeEpoch(undefined, () => bumps.push('bump'));
 * ```
 *
 * A `testKernel.epochBumps` array next to that would be a second way to ask
 * one question (principle 5, AGENTS.md §9), and it would be surface no issue
 * asked for. Task 6.2 should observe through `epochOf`/`subscribeEpoch`; if a
 * concrete 6.2 assertion turns out to need something these two cannot answer,
 * that is the moment to add it, with the assertion as the justification.
 *
 * ### `ownerOf` and overrides (C9)
 *
 * `ownerOf(token)` reports the harness module (`ng-react/test-kernel`) for a
 * token supplied through `overrides`, because the harness genuinely is the
 * registering module and C9 provenance is kernel-assigned. `inspect()` hides
 * the harness rows; `ownerOf` cannot, and should not — **H6** uses it to pick
 * whose epoch a `useService` consumer watches, and for a mocked service that
 * is the harness's epoch, not the mocked-out module's.
 *
 * ### `Symbol.asyncDispose` and `await using`
 *
 * The issue declares `[Symbol.asyncDispose]?(): Promise<void>` on this
 * interface. It cannot be declared: `tsconfig.base.json` pins
 * `lib: ["ES2022", …]`, under which `Symbol.asyncDispose` does not exist as
 * a type (`TS2550`), and the tsconfig is out of scope for this task. The
 * binding is therefore **installed at runtime** by `createTestKernel` when
 * the host provides the well-known symbol (Node >= 20 does), so
 * `await using kernel = createTestKernel(...)` works wherever the *consumer's*
 * `lib` supports the syntax — it just cannot be typed, or tested, from
 * inside this package. See the PR.
 */
export interface TestKernel extends Kernel {
  /** **F4**: every error the kernel routed, in order, via the harness's default sink. */
  readonly errors: readonly CollectedError[];
  /** **H7**: outstanding listener / effect / module-scoped-instance counts. */
  leaks(): LeakReport;
  /**
   * A4: disposes every module under test in reverse topological order, then
   * the harness module itself. Idempotent.
   */
  dispose(): Promise<void>;
}

/** Narrowing helper — ADR-7 thunks may be sync or async. */
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}

/**
 * **R4**: builds an isolated kernel for tests.
 *
 * Isolated in the literal sense: everything this harness accumulates —
 * collected errors, leak counts, the evaluation log — lives on the object
 * returned here, so two test kernels in one file cannot see each other's
 * state. (The one process-wide rendezvous, `recordEvaluation`, is documented
 * in `evaluation-log.ts`.)
 */
export function createTestKernel(options: TestKernelOptions): TestKernel {
  if (typeof options !== 'object' || options === null || !Array.isArray(options.modules)) {
    throw new InvalidDescriptorError('createTestKernel() requires an options object with a modules array.');
  }
  const dev = options.dev ?? true;
  const counters = new LeakCounters();
  const recorder = new EvaluationRecorder();
  const errors: CollectedError[] = [];

  const harnessRef = moduleRef(HARNESS_MODULE_ID);
  // C6: every override is re-declared with `override: true` whether or not
  // the caller set it, which is what R4 means by "via `override: true`".
  const overrides = (options.overrides ?? []).map((record) => rebuildRecord(record, { override: true }));

  const harness = defineModule({
    id: harnessRef,
    load: 'eager',
    critical: false,
    providers: () => [
      // **F4**: an ordinary contribution, not a special case. It therefore
      // exercises the same routing a real module's sink does — including
      // rule 3's buffering of errors raised before any sink existed, which
      // are flushed into this sink the moment the harness module goes
      // `ready`.
      contribute(ErrorSinkToken, {
        factory: () => ({
          report: (error: unknown, info: ErrorInfo) => {
            errors.push(Object.freeze({ error, info }));
          },
        }),
      }),
      ...overrides,
    ],
  });

  const wrapped = options.modules.map((descriptor) =>
    wrapDescriptor(descriptor, { harnessRef, counters, recorder, dev }),
  );

  // `new KernelImpl` rather than `createKernel`, which is the same
  // constructor with a `Kernel`-typed return. The harness needs the one
  // member that is on the class and deliberately not on the public
  // interface: `installLeakCheck` (**H7**). The counters live here — the
  // instrumentation this file installs is what produces them — so this file
  // is also the only thing that can hand the kernel a reader for them.
  const kernel = new KernelImpl({
    modules: [harness, ...wrapped],
    initTimeoutMs: options.initTimeoutMs ?? DEFAULT_TEST_INIT_TIMEOUT_MS,
    disposeTimeoutMs: options.disposeTimeoutMs ?? DEFAULT_TEST_DISPOSE_TIMEOUT_MS,
    dev,
    onFatal: options.onFatal ?? (() => {}),
  });
  // **H7**: the post-HMR-cycle invariant check. A no-op when `dev` is off —
  // and with `dev` off nothing is instrumented either, so the reader would
  // have nothing to read (see `wrapDescriptor`).
  kernel.installLeakCheck(() => counters.report());

  // Started here rather than left to the kernel's scheduled eager pass so
  // that the sink and the overrides are registered before *anything* a test
  // does synchronously after this call can trigger a module. Single-flight
  // (A2): the eager pass joins this activation rather than starting a
  // second one.
  const harnessReady = kernel.activate(harnessRef);
  harnessReady.catch(() => {});

  const testKernel: TestKernel = {
    get errors(): readonly CollectedError[] {
      return errors;
    },
    leaks: () => counters.report(),
    status: (ref) => kernel.status(ref),
    subscribeStatus: (ref, callback) => kernel.subscribeStatus(ref, callback),
    // **C4/ADR-2 (#49)**: `requester` is forwarded, not dropped. It is the
    // one member of this object whose `Kernel` signature has a second,
    // *optional* parameter, and an arrow written `(token) => …` satisfies
    // that signature while silently substituting ADR-2's `'app'` for every
    // resolution — so `MODULE_ID` lies inside every factory a test kernel
    // reaches, and the C8 suggestion names `'app'` instead of the real
    // requesting module. Both failures are silent: a value comes back, and
    // the error message is merely *plausible*. Pinned by the
    // "agrees with a real kernel" tests in `test-kernel.test.ts`.
    get: (token, requester) => kernel.get(token, requester),
    getAll: (token) => kernel.getAll(token),
    // C5/C9/H6 (#17's additions to `Kernel`): pure delegation, deliberately.
    // See `TestKernel`'s doc comment for why `bumpEpoch` is not recorded.
    subscribeAll: (token, callback) => kernel.subscribeAll(token, callback),
    ownerOf: (token) => kernel.ownerOf(token),
    epochOf: (moduleId) => kernel.epochOf(moduleId),
    bumpEpoch: (moduleId) => {
      kernel.bumpEpoch(moduleId);
    },
    subscribeEpoch: (moduleId, callback) => kernel.subscribeEpoch(moduleId, callback),
    inspect: () => hideHarness(kernel.inspect()),
    activate: (ref) => {
      // Acceptance criterion 9: the activation *trigger*, which is the
      // position every "not evaluated before" assertion is relative to.
      if (dev && ref !== null && typeof ref === 'object' && typeof ref.id === 'string') {
        recorder.record(ref.id, '<activate>');
      }
      return kernel.activate(ref);
    },
    whenStartupComplete: () => kernel.whenStartupComplete(),
    deactivate: (ref) => kernel.deactivate(ref),
    // **H2**: nothing is *recorded* here — a hot update's effects are
    // already fully observable through `status`, `epochOf`, `inspect()` and
    // `errors`, so there is no harness-only state to add (the same argument
    // as the epoch members above).
    //
    // The replacement descriptor is wrapped, though, and must be: every
    // module under test gains a `dependsOn` edge to the harness module and
    // has its thunks instrumented, and a raw replacement would silently drop
    // both — taking the leak counters (H7) and the guarantee that the
    // overrides are registered first (A1) with it.
    hotReplace: (ref, nextDescriptor) =>
      kernel.hotReplace(
        ref,
        nextDescriptor === undefined
          ? undefined
          : wrapDescriptor(nextDescriptor, { harnessRef, counters, recorder, dev }),
      ),
    retry: (ref) => kernel.retry(ref),
    dispose: async () => {
      // A4: the harness module is a dependency of every module under test,
      // so deactivating it cascades through all of them in reverse
      // topological order and disposes the harness — and with it the error
      // sink — last.
      await harnessReady.catch(() => {});
      await kernel.deactivate(harnessRef);
      detachRecorder(recorder);
    },
  };

  attachRecorder(testKernel, recorder);
  installAsyncDispose(testKernel);
  return testKernel;
}

/** Everything `wrapDescriptor` needs from the enclosing `createTestKernel` call. */
interface WrapOptions {
  readonly harnessRef: ModuleRef;
  readonly counters: LeakCounters;
  readonly recorder: EvaluationRecorder;
  readonly dev: boolean;
}

/**
 * Rebuilds one descriptor with the harness's instrumentation woven in.
 *
 * Three things happen here, and each is a decision worth stating:
 *
 * **1. `dependsOn` gains the harness module.** A1 then guarantees the
 * harness is `ready` before this module's thunks run, so the overrides and
 * the error sink are registered before anything can resolve them. The
 * alternative — relying on the harness sorting first in the eager pass —
 * would be a lexical accident (`graph.ts` breaks topological ties
 * alphabetically), not a guarantee. The added edges are hidden again by
 * `hideHarness` so `inspect()` shows the graph the test wrote.
 *
 * **2. The module's own records are passed through untouched, overrides
 * included.** This is where the harness used to drop a `provide` whose token
 * an override held, because the registry made the losing plain registration
 * fatal (`DuplicateProviderError`) and — providers being registered during
 * activation — killed the module the override was mocking *for*. #37 fixed
 * that in the registry: the superseded record is now recorded and ignored,
 * in both registration orders, so the harness no longer has to pre-empt it.
 * `inspect()` shows the superseded row with `overriddenBy` set, which is
 * strictly more than the workaround left behind (it dropped the record
 * before the container ever saw it).
 *
 * **3. The thunks are wrapped, never pre-called.** D1 is the property the
 * kernel exists to protect; a harness that evaluated `providers` early to
 * inspect it would break exactly the guarantee acceptance criterion 9
 * measures. Wrapping preserves sync-vs-async shape (ADR-7) too: a
 * synchronous `init` stays synchronous.
 */
function wrapDescriptor(descriptor: ModuleDescriptor, options: WrapOptions): ModuleDescriptor {
  const { harnessRef, counters, recorder, dev } = options;
  const moduleId = descriptor.id.id;
  const providers = descriptor.providers;
  const init = descriptor.init;
  const dispose = descriptor.dispose;

  return defineModule({
    id: descriptor.id,
    dependsOn: [...descriptor.dependsOn, harnessRef],
    load: descriptor.load,
    critical: descriptor.critical,
    ...(providers === undefined
      ? {}
      : {
          providers: () => {
            if (dev) {
              recorder.record(moduleId, '<providers>');
            }
            const prepare = (records: AnyProviderRecord[]): AnyProviderRecord[] =>
              dev ? instrumentRecords(moduleId, records, counters) : records;
            const result = providers();
            return isPromise(result) ? result.then(prepare) : prepare(result);
          },
        }),
    ...(init === undefined
      ? {}
      : {
          init: (ctx: ModuleContext) => {
            if (dev) {
              recorder.record(moduleId, '<init>');
            }
            return init(dev ? instrumentContext(ctx, counters) : ctx);
          },
        }),
    ...(dispose === undefined
      ? {}
      : {
          // Instrumented like `init`: an effect or listener registered from
          // `dispose(ctx)` is registered *after* L3 ran the cleanups, so it
          // never runs one — a real leak, and `leaks()` should say so rather
          // than look away.
          dispose: (ctx: ModuleContext) => dispose(dev ? instrumentContext(ctx, counters) : ctx),
        }),
  });
}

/**
 * Removes the harness module from a `KernelInspection` — its row, the edges
 * every module gained towards it, and the providers and contributions it
 * owns.
 *
 * R4 names `inspect()` as the thing tests assert on, so it must show the
 * graph the test wrote, not the harness's plumbing. Contribution `index`
 * values are recomputed after the harness's own contributions are dropped,
 * so a test reading C5 positions sees its own collection numbered from zero.
 */
function hideHarness(inspection: ReturnType<Kernel['inspect']>): ReturnType<Kernel['inspect']> {
  const contributions: { readonly token: string; readonly owner: string; readonly index: number }[] = [];
  const nextIndex = new Map<string, number>();
  for (const row of inspection.contributions) {
    if (row.owner === HARNESS_MODULE_ID) {
      continue;
    }
    const index = nextIndex.get(row.token) ?? 0;
    nextIndex.set(row.token, index + 1);
    contributions.push(Object.freeze({ token: row.token, owner: row.owner, index }));
  }
  return Object.freeze({
    modules: Object.freeze(inspection.modules.filter((row) => row.id !== HARNESS_MODULE_ID)),
    edges: Object.freeze(
      inspection.edges.filter((row) => row.from !== HARNESS_MODULE_ID && row.to !== HARNESS_MODULE_ID),
    ),
    providers: Object.freeze(inspection.providers.filter((row) => row.owner !== HARNESS_MODULE_ID)),
    contributions: Object.freeze(contributions),
    // **H5/G3**: the harness resolves the error sinks and owns the
    // `overrides`, so it appears on both ends of real edges. Hidden on both
    // ends for the same reason its `dependsOn` edges are — a test asserting
    // on the resolution graph should see its own modules, not the harness.
    // Spread so that a `dev: false` test kernel keeps the key *absent*
    // rather than gaining an empty array.
    ...(inspection.resolutionGraph === undefined
      ? {}
      : {
          resolutionGraph: Object.freeze(
            inspection.resolutionGraph.filter(
              (row) => row.consumer !== HARNESS_MODULE_ID && row.owner !== HARNESS_MODULE_ID,
            ),
          ),
        }),
  });
}

/**
 * Installs the `Symbol.asyncDispose` binding at runtime so `await using`
 * works, without naming the symbol in a typed position — see `TestKernel`'s
 * doc comment for why it cannot be declared under the repo's pinned `lib`.
 */
function installAsyncDispose(testKernel: TestKernel): void {
  const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
  if (typeof asyncDispose !== 'symbol') {
    return;
  }
  Object.defineProperty(testKernel, asyncDispose, {
    value: (): Promise<void> => testKernel.dispose(),
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
