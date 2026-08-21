// The generator's error type.
//
// AGENTS.md principle 6 — "errors are a feature" — applies to the generator
// too: every message below names what was wrong, why the rule exists (with
// the spec clause or ADR that imposes it), and what to do instead. The CLI
// prints `error.message` and exits 1; nothing else in this package throws.

/**
 * A user-facing generator failure: a bad id, a bad flag, or a refusal to
 * overwrite. Distinguished from a programming error so `bin/create-module.js`
 * can print it without a stack trace.
 */
export class CreateModuleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CreateModuleError';
  }
}
