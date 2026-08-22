// The post-hot-replace leak check.
//
// For every module in a hot replace's cascade, and every counted kind
// (`listener`, `effect`, `instance`), the residual is the count still
// outstanding after the whole cascade has been disposed and before anything
// is re-activated. A residual above zero is a registration that outlived its
// module, and is reported as a violation.
//
// The residual, rather than a remembered baseline, is what makes the check
// survive an edit that legitimately changes the counts: adding ten listeners
// raises the post-cycle count by ten and leaves the residual at zero.
//
// A negative count is a double-release rather than a leak; it is the
// counters' own invariant and is not reported here.

import { KernelError } from '../errors';
import type { LeakReport } from '../testing/leak-counters';

/** The counted kinds, recovered from `LeakReport` rather than re-declared. */
type LeakKind = LeakReport['details'][number]['kind'];

/** One instant's counts, keyed by NUL-joined `moduleId` and kind. */
type LeakSnapshot = ReadonlyMap<string, number>;

const SEPARATOR = '\u0000';

/** How each counted kind is named in a warning. Singular, then plural. */
const KIND_NOUNS: Readonly<Record<LeakKind, readonly [string, string]>> = {
  listener: ['ctx.on listener registration', 'ctx.on listener registrations'],
  effect: ['ctx.effect registration', 'ctx.effect registrations'],
  instance: ['module-scoped provider instance', 'module-scoped provider instances'],
};

/**
 * The violation a hot replace's leak check reports.
 *
 * Routed to the error sinks and logged, never thrown. An error sink singles
 * it out with `error.code === 'KERNEL_LEAK_DETECTED'`.
 */
export class LeakInvariantViolation extends KernelError {
  /** The module the leaked registrations belong to. */
  readonly leakedModuleId: string;
  /** Which counter accumulated. */
  readonly kind: LeakKind;
  /** How many registrations survived the module's disposal. */
  readonly outstanding: number;

  constructor(options: {
    readonly moduleId: string;
    readonly kind: LeakKind;
    readonly before: number;
    readonly outstanding: number;
    readonly after: number;
  }) {
    const [singular, plural] = KIND_NOUNS[options.kind];
    const noun = options.outstanding === 1 ? singular : plural;
    super(
      'KERNEL_LEAK_DETECTED',
      `Hot replace leaked ${String(options.outstanding)} ${noun} from module '${options.moduleId}'. ` +
        `The registration remained after the module was disposed, so future edits will accumulate more ` +
        `(before the edit: ${String(options.before)}, ` +
        `outstanding after disposal: ${String(options.outstanding)}, ` +
        `after re-activation: ${String(options.after)}). ` +
        `Release every registration during teardown: use ctx.on/ctx.effect for subscriptions and effects, ` +
        `and do not register new work in dispose(ctx), which runs after cleanups.`,
      { moduleId: options.moduleId },
    );
    this.name = 'LeakInvariantViolation';
    this.leakedModuleId = options.moduleId;
    this.kind = options.kind;
    this.outstanding = options.outstanding;
  }
}

/** Options for `LeakInvariantCheck`. */
export interface LeakInvariantOptions {
  /** Reads the current counts. Supplied by whoever installed the instrumentation. */
  readonly read: () => LeakReport;
  /** Routes one violation to the error sinks, attributed to `moduleId`. */
  readonly route: (error: unknown, moduleId: string) => void;
}

/**
 * Checks, after each hot replace, that the disposed modules released
 * everything they registered.
 *
 * Constructed only by a dev kernel, and only when something installed leak
 * counters for it to read. A production kernel has no instance at all.
 */
export class LeakInvariantCheck {
  constructor(private readonly options: LeakInvariantOptions) {}

  /** Returns the counts at this instant, flattened. */
  snapshot(): LeakSnapshot {
    const flat = new Map<string, number>();
    for (const row of this.options.read().details) {
      flat.set(`${row.moduleId}${SEPARATOR}${row.kind}`, row.count);
    }
    return flat;
  }

  /**
   * Reports every leak in one completed hot replace, to `console.warn` and to
   * the error sinks.
   *
   * Never throws, on any path — a throwing error sink or a missing `console`
   * included.
   *
   * @param input `cascade` is the set of modules this cycle disposed and
   *   re-activated; only those are checked, since a module the cycle never
   *   touched is supposed to keep its registrations.
   */
  check(input: {
    readonly cascade: readonly string[];
    readonly before: LeakSnapshot;
    readonly residual: LeakSnapshot;
    readonly after: LeakSnapshot;
  }): void {
    try {
      for (const moduleId of [...input.cascade].sort()) {
        for (const kind of ['effect', 'instance', 'listener'] as const) {
          const key = `${moduleId}${SEPARATOR}${kind}`;
          const outstanding = input.residual.get(key) ?? 0;
          if (outstanding <= 0) {
            continue;
          }
          const violation = new LeakInvariantViolation({
            moduleId,
            kind,
            before: input.before.get(key) ?? 0,
            outstanding,
            after: input.after.get(key) ?? 0,
          });
          // This object only exists in a dev kernel, so there is no second
          // gate here.
          console.warn(violation.message);
          this.options.route(violation, moduleId);
        }
      }
    } catch {
      // Swallowed whole: a failure of the leak reporter must not reach the
      // hot replace it was observing.
    }
  }
}
