Acceptance criterion 8's fixtures: three files that the boundary preset (spec §13
B1–B3) must reject, written **against the real demo packages** (`@app/auth`,
`@app/orders`, `@app/payments`).

They live here rather than inside those packages for the obvious reason — a
workspace whose `pnpm lint` always failed would be a workspace whose lint is
ignored — and `packages/eslint-config-modules/__fixtures__/**` is already in the
root config's `ignores`. `apps/react/src/acceptance/criterion-08-lint-preset.test.ts`
lints them explicitly, through the real root `eslint.config.js`, with
`ignore: false`, and asserts the exact messages.

Do not "fix" anything in this directory.
