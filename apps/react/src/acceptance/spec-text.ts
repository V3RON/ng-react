// The acceptance suite's link back to the normative document.
//
// **Why the spec is read rather than transcribed.** AGENTS.md §7 requires
// that "error messages match the spec verbatim where the spec quotes them
// (G1, C8) … Assert on the exact string", and a transcribed copy of a quoted
// message is a second source of truth that can drift from the first without
// anything noticing — the same failure mode as a rule that exists only in
// documentation (principle 4). So the two messages the spec quotes are pulled
// out of `docs/spec/01-kernel-and-module-system.md` itself, at test time, and
// the assertion is a diff between the running kernel and the document.
//
// Loaded with Vite's `?raw` import rather than `node:fs`: `apps/react`'s
// tsconfig pins `types` to `["vite/client", "vitest/globals"]`, which leaves
// `node:fs` untyped (`TS2307` — see HANDOFF §5.9), and `?raw` is typed by
// `vite/client`, which is already in that list.

import specSource from '../../../../docs/spec/01-kernel-and-module-system.md?raw';

/**
 * The single backtick-delimited span that follows `marker` in the spec.
 *
 * Throws rather than returning `undefined`, and the throw is the point: if
 * the spec is reworded so the marker no longer appears, every test built on
 * it must fail loudly instead of quietly asserting against nothing. A helper
 * that returned `undefined` here would turn a spec edit into a silently
 * vacuous suite, which is the exact defect this project has now shipped three
 * times.
 */
export function specQuoteAfter(marker: string): string {
  const markerIndex = specSource.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `The spec no longer contains the marker ${JSON.stringify(marker)}. ` +
        `An acceptance test asserts a kernel error against the text quoted after it; ` +
        `update the marker (and check the assertion still means what it did) rather than deleting it.`,
    );
  }
  const open = specSource.indexOf('`', markerIndex + marker.length);
  const close = open === -1 ? -1 : specSource.indexOf('`', open + 1);
  if (open === -1 || close === -1) {
    throw new Error(
      `Found the marker ${JSON.stringify(marker)} in the spec but no backtick-quoted message after it.`,
    );
  }
  return specSource.slice(open + 1, close);
}

/**
 * **C8**'s quoted example (spec §7.2). Reproduced here only as a comment, so
 * a reader of this file knows what shape to expect:
 *
 * > Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.
 */
export const SPEC_C8_MESSAGE = specQuoteAfter('Example target message:');

/**
 * **G1**'s quoted message (spec §9), for a three-module cycle:
 *
 * > Module dependency cycle: orders → payments → risk → orders. Break it by moving the shared surface into a contract.
 */
export const SPEC_G1_MESSAGE = specQuoteAfter(
  'Cycles in `dependsOn` are fatal at registration with the full path:',
);
