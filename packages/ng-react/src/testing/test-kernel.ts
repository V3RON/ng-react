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
 * The id of the module the harness registers. It carries the default error
 * sink and the `overrides`, and every module under test is made to depend on
 * it.
 *
 * A module under test that reuses this id fails with
 * `DuplicateModuleIdError`.
 */
const HARNESS_MODULE_ID = 'ng-react/test-kernel';

/** Low so a hung `init` fails a test fast instead of stalling CI. */
const DEFAULT_TEST_INIT_TIMEOUT_MS = 1000;
const DEFAULT_TEST_DISPOSE_TIMEOUT_MS = 500;

/** Options for `createTestKernel`. */
export interface TestKernelOptions {
  /** The descriptors under test, exactly as the composition root would list them. */
  readonly modules: readonly ModuleDescriptor[];
  /**
   * Mock providers, re-declared with `override: true` and registered by the
   * harness module. An override for a token no module provides is allowed.
   *
   * @default []
   */
  readonly overrides?: readonly AnyProviderRecord[];
  /**
   * Per-module `init` timeout in milliseconds. Lower than a production
   * kernel's `10_000`.
   *
   * @default 1000
   */
  readonly initTimeoutMs?: number;
  /**
   * Awaited-disposal timeout in milliseconds. Lower than a production
   * kernel's `2_000`.
   *
   * @default 500
   */
  readonly disposeTimeoutMs?: number;
  /**
   * Whether to install dev-mode instrumentation. Set `false` to assert that
   * the leak counters and the resolution graph are inert.
   *
   * @default true
   */
  readonly dev?: boolean;
  /**
   * Called when a `critical` module fails during startup activation, including
   * a lazy dependency pulled in by an eager module.
   *
   * Defaults to a no-op, unlike `createKernel`, whose default rethrows from a
   * fresh macrotask — in a test runner that throw lands in an unrelated test
   * or takes the worker down. The failure stays observable in `errors`,
   * `status(ref)`, `inspect()` and as a rejection of `whenStartupComplete()`.
   *
   * @default () => {}
   */
  readonly onFatal?: (error: unknown) => void;
}

/** One error routed to the harness's default error sink. */
export interface CollectedError {
  readonly error: unknown;
  readonly info: ErrorInfo;
}

/**
 * A `Kernel` with the three extra read surfaces a test needs.
 *
 * `ownerOf(token)` reports the harness module for a token supplied through
 * `overrides`, since the harness is genuinely the registering module —
 * `inspect()` hides the harness's rows, `ownerOf` does not.
 *
 * `await using kernel = createTestKernel(...)` works: `Symbol.asyncDispose`
 * is installed at runtime by `createTestKernel` where the host provides the
 * well-known symbol. It cannot be declared on this interface under the
 * repo's pinned `lib: ["ES2022"]`.
 *
 * @example
 * ```ts
 * const kernel = createTestKernel({ modules: [Orders], overrides: [mockPayments] });
 * await kernel.activate(Orders);
 * expect(kernel.errors).toEqual([]);
 * await kernel.dispose();
 * expect(kernel.leaks().balanced).toBe(true);
 * ```
 */
export interface TestKernel extends Kernel {
  /** Every error the kernel routed, in order. */
  readonly errors: readonly CollectedError[];
  /** Outstanding listener, effect and module-scoped-instance counts. */
  leaks(): LeakReport;
  /**
   * Disposes every module under test in reverse topological order, then the
   * harness module itself. Idempotent.
   */
  dispose(): Promise<void>;
}

/** Narrows a thunk result, which may be sync or async. */
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}

/**
 * Builds an isolated kernel for tests: mock providers through `overrides`,
 * drive the lifecycle, then assert on `errors`, `inspect()` and `leaks()`.
 *
 * Everything the harness accumulates lives on the returned object, so two
 * test kernels in one file cannot see each other's state. The exception is
 * `recordEvaluation`, whose events fan out to every live test kernel.
 *
 * @throws {InvalidDescriptorError} When `options` is not an object with a
 *   `modules` array.
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
  // Every override is re-declared with `override: true` whether or not the
  // caller set it.
  const overrides = (options.overrides ?? []).map((record) => rebuildRecord(record, { override: true }));

  const harness = defineModule({
    id: harnessRef,
    load: 'eager',
    critical: false,
    providers: () => [
      // An ordinary contribution, not a special case, so it travels the same
      // routing a real module's sink does — buffering of errors raised before
      // any sink existed included.
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

  // `new KernelImpl` rather than `createKernel`: the harness needs
  // `installLeakCheck`, which is on the class and not on the public `Kernel`
  // interface.
  const kernel = new KernelImpl({
    modules: [harness, ...wrapped],
    initTimeoutMs: options.initTimeoutMs ?? DEFAULT_TEST_INIT_TIMEOUT_MS,
    disposeTimeoutMs: options.disposeTimeoutMs ?? DEFAULT_TEST_DISPOSE_TIMEOUT_MS,
    dev,
    onFatal: options.onFatal ?? (() => {}),
  });
  // A no-op when `dev` is off, where nothing is instrumented either.
  kernel.installLeakCheck(() => counters.report());

  // Started here rather than left to the kernel's scheduled eager pass, so
  // the sink and the overrides are registered before anything a test does
  // synchronously after this call can trigger a module. The eager pass joins
  // this activation rather than starting a second one.
  const harnessReady = kernel.activate(harnessRef);
  harnessReady.catch(() => {});

  const testKernel: TestKernel = {
    get errors(): readonly CollectedError[] {
      return errors;
    },
    leaks: () => counters.report(),
    status: (ref) => kernel.status(ref),
    subscribeStatus: (ref, callback) => kernel.subscribeStatus(ref, callback),
    // `requester` must be forwarded, not dropped. It is the one member here
    // whose `Kernel` signature has a second, optional parameter, so an arrow
    // written `(token) => …` still type-checks while silently substituting
    // `'app'` for every resolution — `MODULE_ID` would then lie inside every
    // factory, and a resolution error would name the wrong module.
    get: (token, requester) => kernel.get(token, requester),
    getAll: (token) => kernel.getAll(token),
    subscribeAll: (token, callback) => kernel.subscribeAll(token, callback),
    ownerOf: (token) => kernel.ownerOf(token),
    epochOf: (moduleId) => kernel.epochOf(moduleId),
    bumpEpoch: (moduleId) => {
      kernel.bumpEpoch(moduleId);
    },
    subscribeEpoch: (moduleId, callback) => kernel.subscribeEpoch(moduleId, callback),
    inspect: () => hideHarness(kernel.inspect()),
    activate: (ref) => {
      // The activation trigger, which is the position every "not evaluated
      // before" assertion in the evaluation log is relative to.
      if (dev && ref !== null && typeof ref === 'object' && typeof ref.id === 'string') {
        recorder.record(ref.id, '<activate>');
      }
      return kernel.activate(ref);
    },
    whenStartupComplete: () => kernel.whenStartupComplete(),
    deactivate: (ref) => kernel.deactivate(ref),
    // The replacement descriptor must be wrapped: a raw one would drop both
    // the `dependsOn` edge to the harness module and the thunk
    // instrumentation, taking the leak counters and the guarantee that the
    // overrides are registered first with it.
    hotReplace: (ref, nextDescriptor) =>
      kernel.hotReplace(
        ref,
        nextDescriptor === undefined
          ? undefined
          : wrapDescriptor(nextDescriptor, { harnessRef, counters, recorder, dev }),
      ),
    retry: (ref) => kernel.retry(ref),
    dispose: async () => {
      // The harness module is a dependency of every module under test, so
      // deactivating it cascades through all of them in reverse topological
      // order and disposes the harness — and with it the error sink — last.
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
 * `dependsOn` gains the harness module, so the overrides and the error sink
 * are registered and `ready` before this module's thunks run. `hideHarness`
 * removes the added edges again from `inspect()`.
 *
 * The thunks are wrapped, never pre-called — evaluating `providers` early
 * would break the lazy-evaluation guarantee the evaluation log measures — and
 * wrapping preserves their sync-versus-async shape.
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
          // `dispose(ctx)` is registered after the cleanups already ran, so
          // its own cleanup never runs. That is a real leak and `leaks()`
          // should say so.
          dispose: (ctx: ModuleContext) => dispose(dev ? instrumentContext(ctx, counters) : ctx),
        }),
  });
}

/**
 * Removes the harness module from a `KernelInspection` — its row, the edges
 * every module gained towards it, and the providers and contributions it
 * owns — so a test sees the graph it wrote rather than the harness's
 * plumbing.
 *
 * Contribution `index` values are recomputed after the harness's own
 * contributions are dropped, so a test's collection is numbered from zero.
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
    // The harness resolves the error sinks and owns the `overrides`, so it
    // appears on both ends of real resolution edges and is hidden from both.
    // Spread so a `dev: false` test kernel keeps the key absent rather than
    // gaining an empty array.
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
 * works, without naming the symbol in a typed position. A no-op on a host
 * that lacks the well-known symbol.
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
