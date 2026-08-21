// **H7 — the post-HMR-cycle leak invariant.**
//
// Spec §11 H7: "A dev-mode invariant check runs after each HMR cycle:
// listener counts and effect counts must return to their pre-dispose
// baseline ± the diff introduced by the edit; violations log a leak warning
// naming the module."
//
// This file is the *checking* half. The counting half is
// `src/testing/leak-counters.ts`, which was written for this and says so in
// its header. Nothing here counts anything; it is handed a `LeakReport`
// reader and asks it three questions per HMR cycle.
//
// ============================================================================
// The rule, stated exactly
// ============================================================================
//
// For every module `M` in the cascade of one `hotReplace`, and every counted
// kind `K` (`listener`, `effect`, `instance`):
//
//     residual(M, K) = the outstanding count for (M, K) measured **after the
//                      whole cascade has been disposed and before anything
//                      is re-activated**.
//
//     A violation is reported for (M, K) exactly when residual(M, K) > 0.
//
// That is the whole rule. It is a *structural* baseline rather than a
// remembered one: teardown is defined to release everything the module
// registered — L3 runs every `ctx` cleanup in reverse order, and the
// container disposes every instance the module owns regardless of scope
// (H4/#34) — so a healthy module's counters are back at zero at that instant
// no matter what its `init` did. Anything still outstanding there is a
// registration that outlived its module, which is precisely the leak H7
// exists to name.
//
// ### Why not the rule the issue proposed
//
// Issue #20 proposes: adopt the post-cycle count as the new baseline and
// report only when "the count after re-activation exceeds the count after
// the previous cycle's re-activation **by more than the number of
// registrations the new `init` performed**". That rule is **vacuous**, and
// this is not a matter of taste. Write it out:
//
//     after   = residual + registrations(new init)
//     report iff after > previous_after + registrations(new init)
//
// In the healthy case `residual` is 0, so `after` *is*
// `registrations(new init)` — the two terms the rule subtracts are the same
// number — and the condition reduces to `0 > previous_after`, i.e. to the
// previous cycle having ended on a negative count. It can never fire. In the
// leaking case it reduces to `residual > previous_after`, which is worse
// than useless: it goes quiet exactly as the leak grows, because
// `previous_after` grows with it.
//
// The proposal's instinct is right — the check must survive an edit that
// legitimately changes the counts, so it cannot be equality against a
// remembered baseline. Measuring the residual satisfies that instinct
// without needing a baseline at all: an edit that adds ten listeners raises
// `after` by ten and leaves `residual` at zero, so the check is silent, and
// an edit that removes them all is equally silent. Only *accumulation* —
// something teardown could not release — moves it.
//
// ### The persistent-store exception (H3, ADR-3, spec §17)
//
// A `persistent: true` instance is deliberately **not disposed** by an HMR
// cycle: disposing a store is how a store throws its state away. Its
// outstanding-instance count therefore cannot balance across a cycle, and a
// naive residual check would report a leak on H3's *blessed* pattern once
// per cycle, forever. That is fixed where it is caused rather than special
// cased here: `instrumentRecords` in `leak-counters.ts` does not count
// persistent records at all — neither acquire nor release — so the pairing
// stays symmetric on every path. See that file's header.
//
// ### What this deliberately does not report
//
// A **negative** count (more releases than acquires) is a double-release,
// not a leak. It is a real defect and `LeakCounters.release` refuses to
// clamp it away for that reason, but it is the counters' own invariant and
// has its own tests; H7 is about accumulation and reports only positives.
//
// ADR-6: no `react` import.

import { KernelError } from '../errors';
import type { LeakReport } from '../testing/leak-counters';

/**
 * The counted kinds, recovered from `LeakReport` rather than re-declared —
 * `leak-counters.ts` keeps `LeakKind` internal, and a second copy of the
 * union here would be free to drift out of step with the counters that
 * produce it.
 */
type LeakKind = LeakReport['details'][number]['kind'];

/**
 * One instant's counts, flattened to `moduleId → kind → count`.
 *
 * A NUL-joined composite key rather than a nested map: the only
 * operations are "look one up" and "iterate", module ids cannot contain a
 * NUL, and the flat form makes the three snapshots a cycle takes trivially
 * comparable.
 */
type LeakSnapshot = ReadonlyMap<string, number>;

const SEPARATOR = '\u0000';

/** How each counted kind is named in a warning. Singular/plural pair. */
const KIND_NOUNS: Readonly<Record<LeakKind, readonly [string, string]>> = {
  listener: ['ctx.on listener registration', 'ctx.on listener registrations'],
  effect: ['ctx.effect registration', 'ctx.effect registrations'],
  instance: ['module-scoped provider instance', 'module-scoped provider instances'],
};

/**
 * **H7**: the violation an HMR cycle's leak check reports.
 *
 * A `KernelError` subclass so that an F4 sink can narrow it the same way it
 * narrows every other routed error, and so that it carries the `moduleId`
 * H7 requires it to name. Internal to `src/hmr/` — like `EpochStore` and
 * `ResolutionGraph`, it is machinery the kernel drives rather than surface a
 * consumer constructs; a sink that wants to single it out matches
 * `error.code === 'KERNEL_H7_LEAK'`, which is what `KernelError.code` is for.
 *
 * **Never thrown.** H7 says violations *log a warning*; a leak report that
 * broke the app would be a worse bug than the leak.
 */
export class LeakInvariantViolation extends KernelError {
  /** The module the leaked registrations belong to (C9 attribution). */
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
      'KERNEL_H7_LEAK',
      `HMR leak check (H7): module '${options.moduleId}' leaked ${String(options.outstanding)} ${noun} ` +
        `across a hot replace. They were still outstanding after the module was disposed, so every further ` +
        `edit accumulates that many more (before the edit: ${String(options.before)}, ` +
        `outstanding after disposal: ${String(options.outstanding)}, ` +
        `after re-activation: ${String(options.after)}). ` +
        `A module's teardown must release everything it registered: subscribe through ctx.on/ctx.effect so ` +
        `L3 can clean up, and make sure a dispose(ctx) handler does not register anything new — cleanups ` +
        `have already run by the time it is called.`,
      { moduleId: options.moduleId },
    );
    this.name = 'LeakInvariantViolation';
    this.leakedModuleId = options.moduleId;
    this.kind = options.kind;
    this.outstanding = options.outstanding;
  }
}

/** Everything `LeakInvariantCheck` needs from the kernel that owns it. */
export interface LeakInvariantOptions {
  /** The current counts. Supplied by whoever installed the instrumentation. */
  readonly read: () => LeakReport;
  /**
   * **F4**: routes one violation to the error sinks, attributed to
   * `moduleId` (C9). The kernel's own `report` — this file never touches the
   * router directly, for the same reason `ModuleContextImpl` does not.
   */
  readonly route: (error: unknown, moduleId: string) => void;
}

/**
 * **H7**: the per-HMR-cycle invariant check.
 *
 * Constructed only by a **dev** kernel, and only when something installed
 * leak counters for it to read (today: `createTestKernel`). A production
 * kernel has no instance of this class at all, which is the same structural
 * gating the counters themselves use — inert because it is absent, not
 * because a branch returned early.
 */
export class LeakInvariantCheck {
  constructor(private readonly options: LeakInvariantOptions) {}

  /**
   * The counts at this instant, flattened. Cheap: `LeakReport.details`
   * carries non-zero entries only.
   */
  snapshot(): LeakSnapshot {
    const flat = new Map<string, number>();
    for (const row of this.options.read().details) {
      flat.set(`${row.moduleId}${SEPARATOR}${row.kind}`, row.count);
    }
    return flat;
  }

  /**
   * Runs the rule at the top of this file over one completed HMR cycle and
   * reports every violation it finds.
   *
   * **Never throws**, on any path, including a throwing error sink or a
   * `console` that is not there: the whole method body is guarded. H7 is a
   * diagnostic, and a diagnostic that can take down a hot update would cost
   * more than the leaks it finds.
   *
   * `cascade` is the set of modules this cycle actually disposed and
   * re-activated. Only those are checked — a module the cycle never touched
   * is *supposed* to keep its registrations, and reading its counts as a
   * violation would report every live module in the app on every edit.
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
          // H7: "violations log a leak warning naming the module" — in dev,
          // where a developer is looking at a console. This object only
          // exists in a dev kernel, so there is no second gate here.
          console.warn(violation.message);
          // **F4**: and through the error sinks, so a telemetry module sees
          // it too. Attributed to the leaking module (C9), in the `dispose`
          // phase — the phase whose job it was to release these.
          this.options.route(violation, moduleId);
        }
      }
    } catch {
      // Deliberately swallowed whole: see the doc comment. There is nothing
      // useful to do with a failure of the leak *reporter* except not let it
      // reach the HMR cycle it was observing.
    }
  }
}
