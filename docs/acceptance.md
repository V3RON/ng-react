# Acceptance — spec 01 §15, criterion by criterion

This is the artefact a reviewer reads to decide whether spec 01 is met. Every row names the
file and the test that proves its claim, and every row that is **not** fully proven says so,
in the row, with the reason.

> **The standard this table is held to.** An honest gap is a finding; a false green is a
> defect. This project has shipped three checks that passed vacuously — a lint rule with a
> dead resolver (#43), an H7 rule that reduced to a tautology (#20), and a demo-level leak
> check with no leak check behind it (§17) — and each was caught only by someone deliberately
> trying to make it fail. Where a test here could have been vacuous, the guard that stops it
> being vacuous is named.

Run everything with `pnpm verify` (typecheck + lint + test) from the repo root.

---

## Summary

| # | What it is | Status |
|---|---|---|
| 1 | Four-module demo: lazy activation, transitive activation, quarantine, logout cascade | **Proven**, with a recorded defect in the criterion's own wording |
| 2 | Typed `dependsOn`: compile failure, and G2 at registration | **Proven** |
| 3 | Editing `orders/lifecycle.ts`: H5, H3/H4, H7 across 20 edits | **Proven** |
| 4 | Editing a `singleton` provider of `payments`: H4, H5, H6 | **Partial** — "without any reload" is measured, not tested; H4 "disposes" is proven as "discarded" |
| 5 | A deleted provider produces the C8 message | **Proven**, with a recorded contradiction between the criterion and C8's own rule |
| 6 | A module cycle fails at lint **and** at registration (G1) | **Proven** |
| 7 | `createTestKernel` with a mocked gateway, no React renderer | **Proven** |
| 8 | The lint preset rejects all three boundary violations | **Proven** |
| 9 | All lazy but `auth`: nothing evaluated before its trigger | **Proven** |
| 10 | A PoC navigation module on public primitives, no kernel change | **Proven** — no file under `packages/ng-react/src/` was modified |
| — | `no-transient-in-component` (R2 / B3) | **Partial** — same-file heuristic; see the last section |

---

## 1 — the four-module demo

`apps/react/src/App.test.tsx`, against the **real** composition root (`createAppKernel()`).

- `criterion 1: kernel.activate(OrdersModule) transitively activates payments` — **A1**, asserted
  as an *order* (`auth → payments → orders`) rather than as membership.
- `criterion 1: debug is quarantined without affecting startup` — **F1/F3/F4**. The
  "without affecting startup" half is asserted first and positively, via
  `whenStartupComplete()`.
- `criterion 1: deactivate(AuthModule) disposes orders and payments in reverse topological order`
  — **A4**.

**Recorded defect in the criterion.** §15.1 asks logout to cascade "disposal of `orders` and
`payments` dependents in reverse order", but the same criterion gives `payments` no dependency
on `auth`. A4 cascades to *dependents*, and `payments` is a dependency of `orders`, so it stays
`ready`. The test asserts what actually happens and disposes `payments` through its own
`deactivate`. Spec §17 records this; the criterion's wording is wrong, not the implementation.

---

## 2 — typed `dependsOn`

`apps/react/src/acceptance/criterion-02-typed-depends-on.test.ts`.

**Two judges.** The compile half is judged by `tsc --noEmit` (`pnpm typecheck`), not by vitest:
each `@ts-expect-error` asserts that the next line *does* fail to compile, and TypeScript
reports an unused directive as an error of its own. Both directions were mutation-checked —
removing a directive fails with `TS2322`, and making the offending line legal fails with
`TS2578`.

- `M2/D3: a string literal in dependsOn does not compile, and does not run either`
- `M1/D3: a differently-typed value in dependsOn does not compile, and does not run either` —
  a `Token`, and an unbranded object of the right shape.
- `M1/D3: the real refs do compile — the control for the three cases above` — the guard against
  `dependsOn` rejecting *everything*.
- `G2: a ref missing from the composition root fails registration, naming both modules`
- `G2: it is the missing ref that is reported, not the first ref in the list`
- `G2: a ref that no descriptor anywhere declares is the same error`

**G2's message is asserted as an exact literal, not diffed against the spec**, because spec §9
quotes no G2 message — it requires only that the error name "the missing module id and the
dependent". Both clauses are asserted separately as well, so a reworded sentence still fails for
the right reason. The produced string is:

```
Module 'orders' depends on 'auth', which was not registered with the kernel. Add its descriptor to the composition root.
```

---

## 3 — editing `orders/lifecycle.ts`

`apps/react/src/acceptance/criterion-03-lifecycle-edit.test.ts`, over the real `auth` +
`payments` + `orders` descriptors.

- `H5: an edit to orders re-activates orders and nothing else` — asserted through per-module
  **H6** epochs as a baseline *diff*, so it cannot pass because nothing ever bumped.
- `H3/H4: the edited module's persistent store keeps its state across the edit`
- `H3: an unrelated module's persistent store is untouched by the edit` — deliberately the
  weaker of the two; see below.
- `H7: the leak check reports nothing across 20 consecutive edits`

**Driven through `kernel.hotReplace`, not through a fake `HmrAdapter`.** #24's brief says to
use the adapter; as of #47 the adapter has no `accept` at all (#42), because Vite decides
self-acceptance by lexically scanning a module's own source. The seam an edit arrives through
is each module's `acceptHotUpdate(kernel, hot?)`, whose entire body is a `hotReplace` call;
that callback is covered separately in `packages/orders/src/module.test.ts` (`H2: acceptHotUpdate`).

**Run under `createTestKernel`, and that is load-bearing rather than convenient.**
`LeakInvariantCheck` is constructed only when something installed leak counters for it to read,
and today only `createTestKernel` does. The demo app therefore runs the H7 check *not at all*,
so "no leak warnings after 20 edits" measured against a browser session would be vacuous
(spec §17 records this and assigns it here). The vacuity guard in the test asserts non-zero
listener and effect counts for `orders` *before* the first edit, so an inert counter fails the
test rather than passing it.

**`orders` gained a `persistent: true` store in this PR** (`orders/OrderNotes`), because it had
none: the demo's two persistent stores belonged to `auth` and `payments`, neither of which is in
the cascade of an `orders` edit, so any H3/H4 assertion would have been the weak one above.
Mutation-checked: removing `persistent: true` fails exactly one test.

**What "preserves" means, precisely.** H4 transfers the *state*, not the object: the old
instance is parked rather than disposed, its snapshot is restored onto a freshly constructed
successor (ADR-3), and the old one is dropped. The test asserts both — the instance is new, the
state is the old one — because "preserved" is ambiguous in English and the spec does not
disambiguate it.

---

## 4 — editing a service behind a `singleton` provider of `payments`

`apps/react/src/acceptance/criterion-04-provider-edit.test.tsx`.

- `H4: the old instance is discarded and the next resolution constructs from the new factory`
- `H3: the persistent draft store carries its state onto the new instance`
- `H5: only the actual consumer is re-activated — not every dependsOn dependent`
- `H6: a mounted component re-renders and resolves the fresh instance`

**Partial, in two named places:**

1. **"without any reload" is not asserted and cannot be.** There is no bundler in the test's
   path, so the absence of a page reload is not a proposition it can evaluate. That clause is
   discharged by measurement instead: #46/#47 ran a real Vite dev server against this demo and
   observed `hmr update` (not `page reload`) across twenty-five consecutive edits, each
   producing a `disposed → activating → ready` cycle for the module (spec §17). **Measured, not
   tested.**
2. **H4's "disposes the old instance" is proven as "discarded and reconstructed".** The demo's
   gateway has no `dispose()` method and its provider declares no `onDispose`, so disposal is
   not directly observable at this level. The test proves the stronger *observable* claim — the
   next resolution is a different instance whose internal counter restarts, so it came from the
   new factory — and disposal proper (an instance with `dispose()`, a provider with
   `onDispose`) is pinned in `packages/ng-react/src/kernel/hot-replace.test.ts`.

**`payments/PaymentGateway` was changed from `module` to `singleton` scope in this PR**, because
the criterion says `singleton` in so many words and no provider of `payments` was one. Per spec
§17 (#34) the two scopes are indistinguishable for a module-owned provider — same lifetime, same
disposal, and H4 discards both on a hot replace — so this is a naming change, not a behaviour
change. The `module`-scoped half of `persistent: true` that #39 left untested is still covered,
by the draft store.

**The H5 test is the one place in the demo where H5 differs from a `dependsOn` cascade**: `auth`
is `ready` and is a declared dependency of `orders`, but nothing it owns was built out of a
`payments` instance, so it must not be re-activated. The `resolutionGraph` edge
`orders → payments/PaymentGateway` is asserted directly, so the cascade cannot be passing for
some other reason.

---

## 5 — a deleted provider produces the C8 message

`apps/react/src/acceptance/criterion-05-deleted-provider.test.ts`. The provider deleted is
`payments/PaymentGateway` — C8's own worked example — removed from the module's **real**
providers array, with a guard that asserts exactly one record was removed.

- `C8: the failure reports the full chain, and the chain is the real token labels`
- `C8: with the dependency undeclared, the message is the spec's quoted example verbatim`
- `C8: the suggestion names the module that owns the failing token, not the first missing one`

**The spec's C8 example is diffed in code against `docs/spec/01-kernel-and-module-system.md`**,
read at test time (`spec-text.ts`), not transcribed. Mutation-checked: perturbing the quoted
message in the spec fails two tests.

The two messages produced, verbatim:

```
Cannot resolve orders/OrderService → payments/PaymentGateway: no provider.
```
```
Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.
```

**Recorded contradiction.** The criterion asks for "full chain **plus** actionable suggestion",
but C8's suggestion fires *only* when the failing token's module is registered and **not** in the
requester's `dependsOn` — and `orders` does declare `payments`, because criterion 1 requires it
to. On the demo's real graph the deletion therefore produces the full chain and no suggestion,
correctly: the dependency is already declared and "add a ref you already added" is not
actionable advice. The spec's quoted example is reachable only from a graph where `orders` does
*not* declare `payments`. Both are asserted; neither is presented as the whole criterion.

---

## 6 — a cycle between two modules

`apps/react/src/acceptance/criterion-06-cycle.test.ts`. Two independent defences, two tests,
neither standing in for the other.

- `B3: the contract import cycle is reported by the root ESLint config` — real ESLint, real
  files (`packages/eslint-config-modules/__fixtures__/contract-cycle/`), the real root
  `eslint.config.js`, `ignore: false`.
- `B3: no-cycle fires because of a real graph, not because nothing resolved` — asserts
  `import-x/no-unresolved` is silent on the fixture. This is #43's lesson: a resolver that
  silently stops resolving takes `no-cycle` down with it, and in the intermediate state
  `no-unresolved` is clean while the cycle probe exits 0.
- `G1: forced past lint, registration is fatal and prints the full cycle in order`
- `G1: the message is the spec's quoted message, diffed against the document`
- `D3: the degenerate one-module cycle never reaches G1 — defineModule rejects it first`

**Vacuity guard:** the fixture lives in a directory the root config ignores, so both lint tests
first assert *which files ESLint actually looked at*. A glob typo would otherwise pass on an
empty array.

The G1 message, verbatim (the three-module case the spec quotes):

```
Module dependency cycle: orders → payments → risk → orders. Break it by moving the shared surface into a contract.
```

---

## 7 — `createTestKernel`, no React renderer

`packages/orders/src/module.test.ts` →
`criterion 7: activates with a mocked PaymentGateway, runs the init listener, disposes clean`.

Not duplicated here: it already exists, it already names the criterion, and it is already in a
**node**-environment vitest project (`app-modules`) with no React plugin — which is the machine
check the criterion is asking for. Disposal is asserted by driving the emitter *after* teardown
(a handler removed from a set but still reachable through a closure would pass a count and fail
this), and `kernel.leaks().balanced` covers "zero leaked listeners".

`packages/nav/src/module.test.ts` is a second instance of the same shape, in the same node
project, for the module this PR adds.

---

## 8 — the lint preset rejects all three

`apps/react/src/acceptance/criterion-08-lint-preset.test.ts`, over
`packages/eslint-config-modules/__fixtures__/boundary-violations/`, whose imports name the
**real** demo packages.

- `the fixtures are actually linted — the guard for the three tests below`
- `B1: a deep import into another module package's src/ is an error`
- `B1: and the resolver rejects the same deep imports independently of the rule` — spec §4 makes
  the `exports` map the *primary* enforcement and the rule the backstop; both are asserted.
- `B2: a value export from a contract beyond the allowlist is an error` — and the `moduleRef`
  and `createToken` exports in the same file are *not* reported, which is what makes it an
  allowlist rather than a ban on value exports.
- `B3/C6: override: true inside a module package is an error`
- `the real workspace is clean under the same config — the false-positive control`

Messages are asserted in full (principle 6). Not a `RuleTester` suite, deliberately: the rules'
own unit tests live in `packages/eslint-config-modules/src/rules/`, and what has actually broken
twice here is everything that must be true *before* a rule sees a file.

---

## 9 — nothing lazy is evaluated before its trigger

`apps/react/src/acceptance/criterion-09-lazy-evaluation.test.ts` →
`D1/A1: with everything lazy but auth, each module's files arrive at its own trigger`.

Every descriptor from the real composition root, forced `lazy` except `auth`. Registration
evaluates nothing; startup evaluates `auth`'s two files and no others; activating `orders`
brings `payments`' files *before* `orders`' (**A1** as an ordering claim); `nav`, `shell` and
`debug` stay untouched; a second, independent trigger brings `nav` alone.

**One test, in a file of its own, and that is structural.** `recordEvaluation` fires at module
top level, so it records once per module-graph instance — a second test in the same file would
start with everything already cached and would measure an empty log. The vacuity guard is the
first assertion: an empty log before anything activates.

---

## 10 — a PoC navigation module on public primitives

`packages/nav` (`@app/nav`), an ordinary module with no privileges: an ordinary descriptor,
ordinary providers, an ordinary hot block, registered by the real composition root.

**No file under `packages/ng-react/src/` was modified by this PR.** That is the criterion.

`apps/react/src/acceptance/criterion-10-navigation-poc.test.tsx`, rendering the whole real app:

- `R3: the route table is useServiceAll(RouteConfigToken) and grows as modules activate`
- `A2: a fallback is rendered while the named module is activating` — the navigator renders
  *through* `activating` rather than awaiting it; a navigator that awaited `activate()` would
  hide the one status A2 exposes to React so a UI can show it.
- `C9: each route is attributed to its contributing module by the kernel, not by the route`
- `C5/F3: logout withdraws the disposed modules' routes and leaves the shell's`
- `the navigator uses only exports that were already public — the principle 1 check`

Plus `packages/nav/src/module.test.ts` (node project, no renderer) for the module itself.

**Mutation-checked**: deleting the single `kernel.activate(ref)` call in the navigator fails
exactly four tests, all of them in criterion 10's file, and nothing else in the suite.

### The design finding: a lazy module cannot contribute the route that activates it

A contribution is registered when its module's `providers` thunk runs — **at activation**
(C3/D1). So a route contributed by `orders` exists only while `orders` is already running, and
a route table built solely from feature-module contributions can never hold the route whose job
is to *trigger* the first activation.

Spec §6 already says where it comes from, in a clause that is easy to read past: "the navigation
module activates a module when a **parent route config** maps a matched path to its ref." The
demo therefore has an **app shell** module (`apps/react/src/shell/`, spec §3's "a folder treated
as one") owning the entry routes `/orders` and `/payments`, each naming its target's ref; the
feature modules contribute their own `/orders/detail` and `/payments/drafts` once active. No
kernel primitive is missing — the spec's model is right and only §15.10's silence on this is
misleading.

### Extended by #52 to two more surfaces

Criterion 10 asks whether *a* subsystem module can be built on public primitives only. Issue #52
adds a second and a third surface on the same primitives, and neither needed a kernel change
either: a **menu** collection (`nav/MenuEntry`, rendered by `apps/react/src/shell/menu.tsx`) and a
**dashboard** module (`@app/dashboard`, owning `dashboard/DashboardCard` and rendering it). Both
are `useServiceAll` + `inspect()` provenance + `kernel.activate`, exactly as the navigator is.
Evidence: `apps/react/src/shell/menu.test.tsx`, `apps/react/src/shell/dashboard.test.tsx`,
`packages/dashboard/src/module.test.ts`.

`@app/dashboard` was **generated with `pnpm create-module`** and the emitted package passed
`pnpm verify` unmodified — no generator bugs found, which is itself the first clean result the
generator has had against a new module.

### Residual risk, recorded rather than fixed

The navigator aligns `useServiceAll(RouteConfigToken)` with
`kernel.inspect().contributions` **by position** to attribute each route (C9 forbids a
self-reported owner on the route). Those are two independent code paths that both implement C5's
"module topological order, declaration order within a module", and the second relies on a stable
sort over registration order — which `inspect()`'s own source notes is not exact for one module
contributing several rows to one token (HANDOFF §6). The alignment is pinned by a test using
`shell`, which contributes **three** routes and is therefore the case where it could drift.
There is nothing stronger to align on: the kernel exposes no per-contribution identity, and
adding one is the kernel change this criterion forbids.

The same alignment now carries the menu and the dashboard, and #52 sharpened one point about it:
both of those surfaces **sort** their collection for display (`(order ?? Infinity, C5 index)`),
so they must pair each row with its owner *before* sorting. Pairing afterwards attributes every
row to whichever module lands at its new position — a bug that is invisible while every module
contributes one row and the display order happens to match the topological one. Both tests are
written against an `order` that genuinely reorders the list, and both are mutation-checked:
pairing after the sort fails exactly one test each and nothing else.

---

## Recorded partials that are not criteria

### `no-transient-in-component` (spec R2 / B3) — **Partial**

A **same-file heuristic**: it fires only when a `provide(Token, { scope: 'transient' })` and a
`useService(Token)` appear in the same file. In a realistic layout the provider lives in
`providers.ts` and the `useService` call in a component, so it will rarely fire in practice.
Deciding it properly needs cross-file resolution from a token's use site back to its provider
declaration, which ESLint's per-file model does not give cheaply. This is accepted, not a defect:
R2 asks only for a *warning*, and it is wired as `'warn'` in both preset tiers, so it never gates
CI. #35's **runtime** dev warning covers the cross-file case — two mechanisms with disjoint
coverage, not a principle-5 violation.

### Leak counters do not count everything

`LeakReport` counts `ctx.on` listeners, `ctx.effect` registrations, and `module`-scoped,
non-`persistent` provider instances. A leaked `transient` or a leaked `persistent` instance is
invisible to them (HANDOFF §5.10, §6; spec §17). H7's own text names only listener and effect
counts, both of which are fully covered — but criterion 3's H7 row should be read as "no
listener, effect or module-instance accumulation", not as "no leak of any kind".

### `useServiceOptional` does not re-render on plain activation

Nothing bumps a resolution epoch on ordinary activation, so a component that resolves an
unprovided token with `useServiceOptional` will not re-render when the owning module later
activates (HANDOFF §6, #35). `App.tsx` closes the gap by pairing it with `useModule`, which does
re-render on status change; the pairing is commented at both use sites. Not a criterion, but it
is the kind of thing a reader of this table will hit next.

### A defect found while writing this suite — **fixed in #49**

`createTestKernel(...).get(token, requester)` used to **silently ignore `requester`**:
`packages/ng-react/src/testing/test-kernel.ts` delegated as `get: (token) => kernel.get(token)`,
dropping the optional second parameter that `TestKernel extends Kernel` promises, while a real
`createKernel` honoured it. The consequence was quiet and wrong: `MODULE_ID` resolved to ADR-2's
`'app'` in any test that passed a requester, and a C8 suggestion built from it named the wrong
module.

Fixed by forwarding the argument. It is pinned by three differential tests in
`packages/ng-react/src/testing/test-kernel.test.ts` — same descriptors, same call, once through
`createKernel` and once through `createTestKernel`, with the real kernel as the oracle — covering
C4's `MODULE_ID` across four differently-typed tokens and both directions of C8's suggestion.

The suite here is unchanged by the fix and needed no edit: every test in it starts resolutions the
way the app does, through a module's own `init`, so none of them ever passed a requester to a test
kernel. That was the right shape independently of the defect, not a workaround for it.
