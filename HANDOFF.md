# HANDOFF — ng-react orchestration, day 3

Written 2026-08-21 for the next orchestrator. Read this, then `AGENTS.md`, then
`docs/spec/01-kernel-and-module-system.md` (including **§17**, which records every decision made
while implementing — it now overrides the spec's own prose in several places).

**One-line status:** **spec 01 is implemented end to end.** All eight stages are closed and
`docs/acceptance.md` maps every acceptance criterion to the test that proves it, with two honest
partials. `master` is green at **656 tests / 55 files**. Open work is a flaky-test fix (#51) and
two new feature issues (#52 → #53) that extend the demo to a menu/dashboard contribution model and
a React Native app.

Day 2's handoff is superseded. Its structure is kept because it worked; its stale claims are
corrected in place rather than deleted, for the reason given in §5.3.

---

## 1. What this project is

A library bringing Angular 2+'s *guarantees* — module boundaries, explicit DI, a deterministic
module lifecycle — to React and React Native, without its *mechanisms* (no decorators, no
`reflect-metadata`, no hierarchical injectors).

`docs/spec/01-kernel-and-module-system.md` is normative and vendored into the repo so sub-agents
can read it inside their worktrees. Its numbered requirements (`M1`, `D3`, `C8`, `A2`, `H4`, `R2`,
…) are the contract between issues, code, and tests. Test names carry the ids.

---

## 2. Current state

### Merged (`master` green: **656 tests, 55 files**, `pnpm verify` exit 0)

| PR | What |
|---|---|
| — | Workspace bootstrap: pnpm, TS, Vitest, ESLint, fallow, AGENTS.md |
| #25 #26 | Module refs, tokens, `MODULE_ID`, `optional`/`allOf`, errors; `provide`/`contribute`/`defineModule` |
| #27 #29 #30 | Container: registry + provenance, resolution engine, reactive contribution collections |
| #28 | `@ng-react/eslint-config-modules` — B1–B3 boundary rules |
| #31 #32 #33 | Kernel: graph + registration + `inspect()`, activation + `ModuleContext`, deactivation + F1–F4 |
| #35 #36 | React bindings; `createTestKernel`, H7 leak counters, evaluation-order instrumentation |
| #38 | **Two container defects** (#34 singleton lifetime, #37 override supersede) |
| #39 #40 | HMR: adapter, `hotReplace`, persistent stores; dev resolution graph + H7 invariant |
| #41 | `create-module` generator: templates, golden fixture, the emitted H2 hot block |
| #44 | **`import-x/no-cycle` made real** (#43 — it had never fired) |
| #45 | Demo: four `@app` module packages, composition root, criterion 1 |
| #47 | **The Vite self-accept fix** (#46) and the `HmrAdapter` shrink (#42) |
| #48 | `@app/nav` PoC navigation module + the ten-criterion acceptance suite + `docs/acceptance.md` |
| #50 | `createTestKernel.get()` forwards the requester (#49) |
| — | Six docs commits (corrections and spec §17 records) |

### Issue board

- **Closed:** every stage (#1–#8) and every task under them; defects #34 #37 #42 #43 #46 #49
- **Open:** **#51** (flaky demo test — in flight at the time of writing), **#52** (menu +
  dashboard contribution collections, web), **#53** (Expo SDK 57 + React Navigation app, depends
  on #52)

Several issues carry **orchestrator comments added after they were written**, and those comments
correct or extend the brief. **Tell every sub-agent to run `gh issue view <n> --comments`.**

### Public API

`packages/ng-react/src/index.ts` is the single auditable surface — no `export *`. Roughly 50 named
exports: identity, declaration, kernel, React bindings, HMR (`HmrAdapter` is now **`invalidate` +
`enabled` only**, see §4), and testing. `ProviderRegistry`, `Resolver`, `Container`, `KernelImpl`,
`ResolutionGraph`, `LeakInvariantCheck` are internal and deliberately not exported.

---

## 3. How the work is run

One task = one branch = one PR = one squash-merged commit. Sub-agents work in isolated worktrees
under `.claude/worktrees/`, open PRs, and never merge. The orchestrator reviews, verifies, merges,
pulls.

Dispatch prompt structure, unchanged and still the highest-leverage thing you control:

1. Orient: worktree + `pnpm install`, read `AGENTS.md`, `HANDOFF.md`, the spec sections,
   `gh issue view <n> --comments`, and the merged code being built on.
2. Implement exactly the issue — plus **"the things most likely to go wrong, in order"**, drawn
   from reading the merged code yourself. **This is the part that pays.**
3. Verify: `pnpm verify`, mutation-check the load-bearing guard, print produced error strings
   verbatim into the PR.
4. Ship: one commit, `Closes #n`, do not merge.
5. Report — and explicitly: *"if a requirement is wrong, contradictory, or impossible, say so
   plainly rather than working around it silently."*

That last line has produced every significant finding across three days. Naming a concrete
suspicion ("item 1 above is my best guess at where this task's defect is") beats a generic
invitation, and has been right more often than not.

### Review process — do not skip these

- **Verify claims yourself; do not trust the PR body.** A throwaway `zzprobe.test.ts` that
  collects results and throws them so vitest prints them is still the fastest tool.
- **Mutation-check the load-bearing guard.** Revert the fix, run the suite, confirm the *right*
  tests fail and nothing else does. This caught a vacuously-passing rule, proved two workarounds
  genuinely removed, and is how day 3 confirmed the H7 20-edit test has real power.
- **Some claims need a running system.** Three findings this session were only reachable with a
  real Vite dev server and a browser client, or by clicking through the demo. When a claim is
  about a bundler or a device, a unit test cannot settle it — run the thing.
- **Diff error messages byte-for-byte against the spec**, in code, not by eye.
- **Use `git diff master...branch` (three dots).**
- Merge with `gh pr merge <n> --squash`. GitHub blocks self-approval, so post the review as a
  comment — worth doing anyway, it is the durable record.
- After merge: remove the worktree, `git worktree prune`, delete the branch, pull, re-verify.
- **When closing a stage, verify its definition of done clause by clause.** Stage 7's clause 2
  was a straight fail that two merged PRs had not noticed (#43). Every closed stage carries a
  clause-by-clause comment with probe output.

### On parallelism

The dependency chain is real; resist fanning out. The one parallel dispatch (#17/#18) cost a
round-trip when #17 widened the `Kernel` interface mid-flight. Day 3 held #52 back rather than
running it alongside #51 because both touch `apps/react`. If you do parallelise, tell both agents
which file they share and what the other is likely to change.

---

## 4. Decisions already made — do not re-litigate

Full text in `AGENTS.md`; spec §17 is the spec-side record.

| ADR | Decision |
|---|---|
| 1 | async `dispose` awaited with a **2 s** timeout; module still marked `disposed`, timeout routed to error sinks |
| 2 | `MODULE_ID` outside any module resolves to the reserved id **`'app'`**; `moduleRef('app')` throws |
| 3 | `persistent: true` transfers by snapshot, with an optional `transfer(old, new)` hook |
| 4 | pnpm workspaces; boundaries via ESLint preset + `exports` maps, not Nx tags |
| 5 | HMR abstracted behind an `HmrAdapter` — **narrowed, see below**; no kernel code may touch `import.meta.hot` / `module.hot` |
| 6 | kernel core must not import `react` — only `src/react/**` may |
| 7 | descriptor thunks are `() => T \| Promise<T>` |
| 8 | naming: `@ng-react/kernel`, bare feature ids, `moduleId/Name` token labels |
| 9 | **the descriptor has seven fields, not six** |
| 10 | **`AnyToken` / `AnyProviderRecord`** erased aliases; `any` confined to those two declarations |

**ADR-5 was narrowed on day 3 (#42/#46/#47), and this is binding.** `HmrAdapter` was
`accept`/`dispose`/`invalidate`; it is now **`invalidate` + `enabled` only**. `accept` cannot live
behind an adapter *at all*: Vite decides self-acceptance by lexically scanning a module's own
source for `import.meta.hot.accept`, so any indirection makes every edit a full page reload. The
sentence that still binds is the one that matters — no file in `packages/ng-react` may name a
bundler's hot API. Acceptance is registered by each generated module's own hot block, which is
**app** code.

Semantics settled during implementation, recorded only in spec §17 and as binding as the ADRs:

- **A module-owned `singleton` lives for its module's *activation*, not the process.** (#34/#38)
- **A plain `provide` losing to an `override: true` is superseded, not fatal.** (#37/#38)
- **A contribution resolves on behalf of its own `owner`,** never on behalf of whoever asked for
  the collection — hence `getAll(token)` takes no requester. (#30)
- **`HmrAdapter.accept` is called by the module, not the kernel** — and as of #47 it must appear
  **literally** as `import.meta.hot.accept(...)` in the module's own source. The generated block
  registers a *dispatcher* over module-local callbacks; `acceptHotUpdate(kernel)` subscribes into
  it, so there is still **no ambient "current kernel"** and R4 test kernels stay isolated.
- **§15 criterion 1's own wording is wrong** about the logout cascade, and **M2's "the contract
  import graph mirrors the module graph" is false once C5 exists.** Both recorded in §17. (#45)

---

## 5. Traps that cost time — read before touching code

### 5.1 The invariance wall (ADR-10) — still the big one

`Token<T>` is invariant in `T`, and `ProviderRecord<T>` is invariant twice over. A heterogeneous
`providers` array has **no** common supertype expressible with `unknown`, so the spec's §7.2
worked example did not compile. Fixed with the two erased aliases. **Do not "fix" them back** —
`packages/ng-react/src/spec-examples.test.ts` fails if you try. Covariance is a trap: it does not
fix the array problem *and* it breaks `provide(CatToken, { factory: () => dog })`.

### 5.2 The weak-test pattern — the single most valuable thing to watch for

Stage 1's tests used `Token<unknown>` and single-token arrays throughout, so nothing exercised two
differently-typed tokens in one array. **The tests passed by being weaker than reality.** Every
recurrence since has been the same shape:

- #39: every `persistent` test used the default `singleton` scope; the module-scoped half was
  untested until mutation testing found it.
- #41: `expect(evaluationLog(kernel)).toEqual([])` "proved" D1 — but an eager import evaluates
  when the *test file* loads, before any kernel exists to record it. The empty log was vacuous.
- #43: the H7 rule as first written could never fire; the `no-cycle` rule had never fired at all.
- #45: four generated modules' test files ran in **no vitest project**, and `pnpm test` reported
  the same count as before.

Say "use realistically and differently typed tokens" in every dispatch, and **mutation-check**.

### 5.3 Container sequencing — **the day-1 claim here was false**

`Container.withdraw()` and `disposeModuleInstances()` are separate primitives; `kernel.ts`
sequences them. Day 1 claimed withdrawing without disposing "leaks every module-scoped instance
silently." **That is false** — and it had propagated into two issue briefs before being caught.
What withdraw-first actually breaks is C5's invariant: subscribers are notified while the
withdrawn module's instances are still live. Same required order, sound reason.

Kept as a worked example of the thing to guard against: a plausible mechanism stated as fact,
propagated into briefs, believed for a day.

### 5.4 `onError` is wired — F4 is real

Day 1 warned it was an unwired no-op. **Fixed in #33.** Every seam routes to the `ErrorSinkToken`
collection; errors raised before any sink exists are buffered (bounded at 50) and flushed.
`createTestKernel` collects them in `.errors`.

### 5.5 `.claude/worktrees/` is inside the repo

Agent worktrees are full checkouts with their own `node_modules`. `.claude/**` is excluded from
eslint, vitest and fallow — keep it that way.

### 5.6 `npx` in a fresh worktree

A worktree without `pnpm install` lets `npx tsc` fetch a **decoy** `tsc` that reports no errors.
Always `pnpm install` first, and sanity-check a probe by planting a deliberate error.

### 5.7 `pnpm-workspace.yaml` carries `allowBuilds: unrs-resolver: true`

Native binding behind `eslint-plugin-import-x` *and* behind the TypeScript resolver added in #44.
Without the approved build, `pnpm lint` fails with `node with invalid interface loaded as
resolver`. Do not remove it.

### 5.8 TypeScript is pinned to 5.9.3

TS 7 breaks `typescript-eslint@8`. Documented in `AGENTS.md`.

### 5.9 `lib` is `ES2022`, so `Symbol.asyncDispose` is untypeable

`TestKernel` installs its `Symbol.asyncDispose` binding at runtime without declaring the member.
The ADR-5 source-scan check still has no home; it remains the one rule enforced by convention.

### 5.10 A preserved `persistent` instance is never disposed

H4's sole exception, which is why `instrumentRecords` skips `persistent` records entirely. Cost: a
genuinely leaked persistent instance is invisible to the counters.

### 5.11 Two settings are needed to make `import-x/no-cycle` fire, and the obvious check passes with one

A TypeScript-aware resolver is necessary and **not sufficient**: `no-cycle` walks past the first
hop through `ExportMap.for()`, which returns `null` for any path failing an extension allowlist
defaulting to `['.js','.mjs','.cjs']`. With the resolver swapped and `import-x/extensions` absent,
`import-x/no-unresolved` is clean workspace-wide while a planted cycle still passes silently — so
#43's own acceptance criterion would have signed off on a dead rule. Both settings are pinned and
each is mutation-checked. (#44)

### 5.12 The leak counters see what goes through `ctx`, not the resources behind it

Verified on day 3: an effect that returns **no cleanup** leaves `leaks().balanced === true`, and
the leaked interval is invisible. The counters catch "teardown did not run" — breaking the kernel's
cleanup loop fails the H7 20-edit test immediately — not "the developer never registered a
cleanup". Do not read "H7 passes" as "nothing leaks".

### 5.13 `whenStartupComplete()` gates the startup-critical closure

A3 gates on critical modules in every eager module's transitive activation closure. A lazy
critical dependency is therefore part of the gate and its startup failure is fatal (#61).
Non-critical modules remain outside the condition: a test that awaits the gate and then asserts a
non-critical module's post-failure state is racy. Use `waitForStatus` for that state (#51).
When the closure contains no critical module, the gate deliberately resolves immediately and the
React binding emits a dev warning.

---

## 6. Known gaps and honest partials

`docs/acceptance.md` is now the authoritative table — it names, per criterion, both the evidence
and the guard that stops that evidence being vacuous. Summary:

- **Criterion 4 is Partial.** "Without any reload" is *measured* (#47's dev-server output), not
  tested: no test here has a bundler in the path, so nothing can observe Vite's static scan.
- **`no-transient-in-component` (R2) is Partial** — a same-file heuristic, warn-only; #35's
  runtime dev warning covers the cross-file case.
- **Metro / React Native is entirely unverified.** Not runnable here today. #53 is what would
  change that, and it should report which RN claims become verified and which stay reasoning.
- **`inspect().contributions[].index`** cannot reflect declaration order *within* one module.
- **Leak counters count listeners, effects and module-scoped instances only** — see §5.12.
- **`useServiceOptional` on an unprovided token does not re-render when the module later
  activates.** `App.tsx` pairs it with `useModule` to close the gap; the pairing is commented at
  both use sites.
- **A collection read via `ctx.getAll` records no resolution-graph edge** to its contributors.

---

## 7. Suggested next moves

1. **#51** — the flaky demo test (§5.13). Small, and the sweep matters more than the fix.
2. **#52** — menu and dashboard contribution collections, adopted in the web demo. The design
   decision it must settle and write down: how one `contribute()` call yields a web component on
   web and an RN component on native. Platform file extensions (`screen.web.tsx` /
   `screen.native.tsx`) is the preferred shape; `tsc` is the part most likely to bite.
3. **#53** — the Expo SDK 57 + React Navigation app, rendering the same collections. Sequential
   after #52. Two things to hold the agent to: **verify the actual current Expo SDK from the
   registry** rather than trusting the issue title, and treat the Metro HMR no-op as expected
   behaviour to confirm, not a bug to silently fix. It has iOS Simulator tooling — a screenshot of
   the drawer is the only proof any of this works on a device.
4. Spec 02 (event bus) and spec 03 (navigation) are unwritten. `@app/nav` exists as a PoC on public
   primitives only and is the evidence that spec 03 needs no kernel changes; #52/#53 extend that
   evidence to menu and dashboard surfaces.

---

## 8. Scorecard

Across three days: **twenty PRs merged, five sent back with change requests**, all five justified.

**Every PR contained at least one confirmed defect in a brief or in the spec, not in the
implementation.** That remains the single most important pattern on this project:

| Defect | Found in | By |
|---|---|---|
| Unsatisfiable `D extends readonly Dep[]` constraint (twice) | brief | agent |
| Descriptor six-vs-seven field contradiction | spec | agent |
| The invariance wall (ADR-10) | spec | agent |
| Disposal clause contradicting C7 for singletons | brief (#13) | agent |
| Stale `getAll` requester signature | brief (#14) | agent |
| **The "silent leak" claim — simply false** | **day-1 handoff** | agent (#32) |
| C7/H4 singleton lifetime — unsound, not ambiguous | spec | review (#33) → fixed #38 |
| C6 override fatal to the loser | spec silence | agent (#36) → fixed #38 |
| H2 "kernel registers acceptance for chunks" — not implementable | spec | agent (#39) |
| **The H7 rule — vacuous, not imprecise** | **brief (#20)** | agent (#40) |
| H5 edge consumer cannot be C4's `requester` | brief (#20) | agent (#40) |
| Composition-root hot block rejected for the wrong reason | **my #22 addendum** | agent (#41) |
| `import-x/no-cycle` inert — and the fix needs two settings | code + **my #43 brief** | review → agent (#44) |
| §15 criterion 1's logout cascade is impossible on its own graph | spec | agent (#45) |
| M2's "mirrors by construction" is false once C5 exists | spec | review (#45) |
| **The generated hot block never self-accepts under Vite** | **#41's design, which I pushed for** | agent (#45) → fixed #47 |
| Criterion 5 contradicts C8's own suggestion rule | spec | agent (#48) |
| `createTestKernel.get()` drops the requester | code | agent (#48) → fixed #50 |
| `hotReplace` missing from my audit list — the likeliest sibling | **my #49 brief** | agent (#50) |

Five of those were mine. One (#43) shipped an acceptance check that would have passed while the
bug it tested for was still present; another (#46) was a design I argued for in review. **Assume
yours will be on this list too** — the instruction that surfaces them is still the most valuable
line in the dispatch prompt.

The standard to hold agents to, and the reason to ask for mutation checks explicitly: #39's agent
used mutation testing to find a false claim in **its own** comment and corrected the comment
rather than overstating the code. #48's agent found a kernel defect and deliberately left it
unfixed because fixing it would have broken the constraint its own task existed to prove.
