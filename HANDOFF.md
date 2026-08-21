# HANDOFF — ng-react orchestration, day 2

Written 2026-08-21 for the next orchestrator. Read this, then `AGENTS.md`, then
`docs/spec/01-kernel-and-module-system.md` (including **§17**, which now records nineteen
decisions made while implementing).

**One-line status:** stages 1–6 are done and merged. `master` is green at **542 tests / 35
files**. The next task is **#22** (the `create-module` generator), then stage 8's demo and
acceptance suite (#23 → #24).

Day 1's handoff is superseded by this file. Two of its claims were later proved false; the
corrections are recorded in place below (§5.3, §5.4) rather than deleted, because knowing a
stated fact was wrong is worth more than a clean document.

---

## 1. What this project is

A library bringing Angular 2+'s *guarantees* — module boundaries, explicit DI, a
deterministic module lifecycle — to React and React Native, without its *mechanisms* (no
decorators, no `reflect-metadata`, no hierarchical injectors).

`docs/spec/01-kernel-and-module-system.md` is normative and vendored into the repo so
sub-agents can read it inside their worktrees. Its numbered requirements (`M1`, `D3`, `C8`,
`A2`, `H4`, `R2`, …) are the contract between issues, code, and tests. Everything is traced
by those ids — test names include them.

---

## 2. Current state

### Merged (`master` green: **542 tests, 35 files**, `pnpm verify` exit 0)

| PR | What |
|---|---|
| — | Workspace bootstrap: pnpm, TS, Vitest (3 projects), ESLint, fallow, AGENTS.md |
| #25 #26 | Module refs, tokens, `MODULE_ID`, `optional`/`allOf`, errors; `provide`/`contribute`/`defineModule` |
| #27 #29 #30 | Container: registry + provenance, resolution engine, reactive contribution collections |
| #28 | `@ng-react/eslint-config-modules` — B1–B3 boundary rules |
| #31 #32 #33 | Kernel: graph + registration + `inspect()`, activation + `ModuleContext`, deactivation + F1–F4 |
| #35 | React bindings: `AppKernel`, `ModuleScope`, `useService`/`useServiceAll`/`useModule`, epoch store |
| #36 | `createTestKernel`, H7 leak counters, evaluation-order instrumentation |
| #38 | **Two container defects** (#34 singleton lifetime, #37 override supersede) |
| #39 #40 | HMR: adapter, `hotReplace`, persistent stores; dev resolution graph + H7 invariant |
| — | Four docs commits (two corrections, two spec §17 records) |

### Public API today (`packages/ng-react/src/index.ts`)

Roughly 50 named exports in six groups: identity (`moduleRef`, `createToken`, `MODULE_ID`,
`optional`, `allOf`), declaration (`provide`, `contribute`, `defineModule`), kernel
(`createKernel`, `Kernel`, `KernelOptions`, `ErrorSinkToken`), React (`AppKernel`,
`ModuleScope`, `useKernel`, `useService`, `useServiceOptional`, `useServiceAll`, `useModule`,
`useModuleScope`), HMR (`HmrAdapter`, `createViteHmrAdapter`, `createNoopHmrAdapter`,
`defineStore`), and testing (`createTestKernel`, `LeakReport`, `recordEvaluation`,
`evaluationLog`).

`ProviderRegistry`, `Resolver`, `Container`, `KernelImpl`, `ResolutionGraph` and
`LeakInvariantCheck` are **internal** — deliberately not exported.

### Issue board

- **Closed:** stages #1–#6 and every task under them; defects #34, #37
- **Open, next up:** **#22** (task 7.2, `create-module` generator)
- **Open, after that:** #23 (task 8.1, demo app) → #24 (task 8.2, PoC navigation module +
  acceptance suite); stage issues #7 and #8
- Stage 7's other half (#21, the lint preset) was merged on day 1

Several issues carry **orchestrator comments added after they were written**, and those
comments correct or extend the brief. **Tell every sub-agent to run
`gh issue view <n> --comments`, not `gh issue view <n>`.** #24 in particular is still
flagged: `no-transient-in-component` must be recorded as **Partial** in `docs/acceptance.md`.

---

## 3. How the work is run

One task = one branch = one PR = one squash-merged commit. Sub-agents work in isolated
worktrees, open PRs, and never merge. The orchestrator reviews, verifies, merges, pulls.

Dispatch prompt structure that has worked, unchanged from day 1 and still the highest-leverage
thing you control:

1. Orient: `pnpm install`, read `AGENTS.md`, read the spec sections, `gh issue view <n> --comments`, read the merged code you build on, create the branch.
2. Implement exactly the issue — plus a short list of *"the things most likely to go wrong, in order"*, drawn from reading the merged code yourself. **This is the part that pays.** Every defect found this session was on one of those lists, or was found because the list told the agent to be suspicious of something adjacent.
3. Verify: `pnpm verify`, **print produced error strings verbatim into the PR** so they can be diffed against the spec.
4. Ship: one commit, `Closes #n`, do not merge.
5. Report back — and explicitly: *"if a requirement is wrong, contradictory, or impossible, say so plainly rather than working around it silently."*

That last instruction has produced every significant finding across both days. Keep it, and
make it specific: naming a concrete suspicion ("item 3 above is my best guess at where this
task's defect is") gets better results than a generic invitation.

### Review process — do not skip these

- **Verify claims yourself; do not trust the PR body.** A throwaway `zzprobe.test.ts` that
  collects results into an array and throws them, so vitest prints them, is still the fastest
  tool here. Write it, run it, delete it.
- **Mutation-check the load-bearing guard.** Day 2's biggest addition to the process. Revert
  the fix, run the suite, confirm the *right* tests fail and nothing else does. It caught a
  vacuously-passing rule, confirmed several real ones, and twice proved a workaround had
  genuinely been removed rather than merely gone unused. Ask agents to do it, then do it
  yourself on the one guard that matters most.
- **Diff error messages byte-for-byte against the spec**, in code, not by eye. C8 and G1 are
  quoted verbatim and are acceptance criteria.
- **Review against the *next* task's requirements, not just this issue's.**
- **Use `git diff master...branch` (three dots), never `master..branch`.**
- Merge with `gh pr merge <n> --squash`. GitHub blocks approving your own PR, so post the
  review as a comment — worth doing anyway, it is the durable record.
- After merge: remove the agent worktree, `git worktree prune`, delete the remote branch,
  pull master, re-run `pnpm verify`.

### On parallelism

Day 1 said only #17/#18 were genuinely parallelisable. That was right, and running them in
parallel **cost one round-trip**: #17 widened the `Kernel` interface mid-flight, so #18's
`TestKernel extends Kernel` no longer satisfied it (`TS2739`). Neither agent could see it from
its own worktree.

If you parallelise, tell both agents (a) which file they share and to keep edits to one
appended block, and (b) about each other's likely cross-cutting change. Warning #17 to scope
its warn-once `Set` per-provider instead of module-level — because #18 was auditing for
exactly that global state — worked. The interface widening is the one I failed to anticipate.
The dependency chain is otherwise real; resist fanning out.

---

## 4. Decisions already made — do not re-litigate

Full text in `AGENTS.md`; spec §17 is the spec-side record and now carries **nineteen**
entries, including every discrepancy found while implementing.

| ADR | Decision |
|---|---|
| 1 | async `dispose` awaited with a **2 s** timeout; module still marked `disposed`, timeout routed to error sinks |
| 2 | `MODULE_ID` outside any module resolves to the reserved id **`'app'`**; `moduleRef('app')` throws |
| 3 | `persistent: true` transfers by snapshot, with an optional `transfer(old, new)` hook |
| 4 | pnpm workspaces; boundaries via ESLint preset + `exports` maps, not Nx tags |
| 5 | HMR abstracted behind an `HmrAdapter`; **no kernel code may touch `import.meta.hot` / `module.hot`** |
| 6 | kernel core must not import `react` — only `src/react/**` may |
| 7 | descriptor thunks are `() => T \| Promise<T>`; blessed ESM form is `() => import('./providers').then(m => m.providers)` |
| 8 | naming: `@ng-react/kernel`, bare feature ids, `moduleId/Name` token labels |
| 9 | **the descriptor has seven fields, not six** — the spec's prose was stale, its example is the contract |
| 10 | **`AnyToken` / `AnyProviderRecord`** erased aliases; `any` confined to those two declarations |

Four further semantics were settled during implementation and are recorded only in spec §17.
They are as binding as the ADRs:

- **A module-owned `singleton` lives for its module's *activation*, not the process.**
  Deactivation disposes it; re-activation constructs exactly one new one. H4 governs over
  C7's narrower prose. (#34/#38)
- **A plain `provide` losing to an `override: true` is superseded, not fatal.** Two *plain*
  provides remain fatal and still name both modules. (#37/#38)
- **A contribution resolves on behalf of its own `owner`,** never on behalf of whoever asked
  for the collection — so a subscriber's mere existence cannot change what `MODULE_ID`
  resolves to. Hence `getAll(token)` takes no requester. (#30)
- **`HmrAdapter.accept` is called by the module, not the kernel.** A module id is not a
  bundler chunk id, and only the re-evaluated `module.ts` holds the new descriptor. The
  kernel holds the adapter and uses it for `invalidate`. **Stage 7's generator must emit the
  hot block.** (#39)

---

## 5. Traps that cost time — read before touching code

### 5.1 The invariance wall (ADR-10) — still the big one

`Token<T>` is invariant in `T`, and `ProviderRecord<T>` is invariant **twice over** (via its
token, and via `onDispose(instance: T)` / `transfer(old: T, new: T)`). Consequence: a
heterogeneous `providers` array has **no** common supertype expressible with `unknown`, so
the spec's own §7.2 worked example did not compile.

Fixed with the two erased aliases. **Do not "fix" them back to `unknown`** —
`packages/ng-react/src/spec-examples.test.ts` exists to fail if you try.

Covariance looks like the obvious alternative and is a trap: it does not fix the array
problem **and** it silently breaks `provide(CatToken, { factory: () => dog })`, because `T`
then infers from the factory instead of the token. Verified both ways against the compiler.

### 5.2 Why it survived a whole stage — the weak-test pattern

Stage 1's tests used `Token<unknown>` and single-token arrays throughout, so nothing ever
exercised two differently-typed tokens in one array. **The tests passed by being weaker than
reality.** This is the failure mode to watch for above all others. It recurred in smaller form
in #39, where every `persistent` test used the default `singleton` scope and the module-scoped
half went untested until mutation testing found it.

`AGENTS.md` §9 lists it as a reject reason. Every dispatch prompt says "use realistically and
differently typed tokens". Keep saying it, and keep mutation-checking.

### 5.3 Container sequencing — **the day-1 claim here was false**

`Container.withdraw()` and `Container.disposeModuleInstances()` are separate primitives and
neither calls the other. That is deliberate — the container should not decide lifecycle
ordering — and `kernel.ts` sequences them.

**Day 1 claimed that withdrawing without disposing "leaks every module-scoped instance
silently." That is false**, and it had already propagated into the #15 and #16 briefs before
being caught in #32. `Resolver` keys its caches by `entry.owner` and each `CachedInstance`
carries its own `record`, so `disposeModuleInstances` never consults the registry — nothing
leaks in either order. What withdraw-first actually breaks is **C5's invariant**: subscribers
are notified while the withdrawn module's instances are still live. Same required order,
sound reason. Verified in both directions.

Kept here as a worked example of what to guard against: a plausible mechanism stated as fact,
propagated into two briefs, believed for a day.

### 5.4 `onError` is now wired — F4 is real

Day 1 warned that `onError` defaulted to a no-op and that "absence of reported errors proves
nothing". **That was fixed in #33.** Every seam (`Resolver`, `Container`,
`ContributionCollections`, `ModuleContext`) now routes to the `ErrorSinkToken` contribution
collection, `KernelOptions.onError` was removed, and errors raised before any sink exists are
buffered (bounded at 50) and flushed. `createTestKernel` collects them in `.errors`.

### 5.5 `.claude/worktrees/` is inside the repo

Agent worktrees are full checkouts with their own `node_modules`. A root `eslint .` was
descending into a live agent's tree and failing on a plugin that agent had installed.
`.claude/**` is excluded from eslint, vitest and fallow — keep it that way.

### 5.6 `npx` in a fresh worktree

A worktree without `pnpm install` will let `npx tsc` fetch a **decoy** `tsc` that reports no
errors. The ADR-10 finding was nearly dismissed because of this. Always `pnpm install` in a
review worktree before probing, and sanity-check a probe by introducing a deliberate error.
Every dispatch prompt this session told agents the same; several reported the decoy biting
them.

### 5.7 `pnpm-workspace.yaml` carries `allowBuilds: unrs-resolver: true`

Native resolver behind `eslint-plugin-import-x`, which backs `import-x/no-cycle` (B3).
Without the approved build, `pnpm lint` fails with an opaque
`node with invalid interface loaded as resolver`. Do not remove it.

### 5.8 TypeScript is pinned to 5.9.3

TS 7 is out; `typescript-eslint@8` has no stable release supporting it. Bumping TS breaks
lint. Documented in `AGENTS.md`.

### 5.9 `lib` is `ES2022`, so `Symbol.asyncDispose` is untypeable

`packages/ng-react/tsconfig.json` also sets `types: ["vitest/globals"]`, which makes `node:fs`
untyped (`TS2307`). Two consequences already hit: `TestKernel` installs its
`Symbol.asyncDispose` binding at runtime without declaring the member, and the ADR-5
source-scan machine check ("no kernel file references `import.meta.hot`") could not be written
as a test. **The right home for that check is the eslint preset — stage 7.**

### 5.10 A preserved `persistent` instance is never disposed

H4's sole exception. Its listeners therefore outlive an HMR generation by design, which is why
`instrumentRecords` skips `persistent` records entirely rather than gating on the HMR path —
gating would break `deactivate`, which *does* dispose them, in the opposite direction.
Accepted cost: a genuinely leaked persistent instance is invisible to the counters. H7 names
only listener and effect counts, both fully covered.

---

## 6. Known gaps and honest partials

- **Acceptance criterion 3 is only half-discharged.** Proved at the unit level in #40; issue
  #20 assigns the demo-level repeat to **stage 8**. Do not treat it as done.
- **`no-transient-in-component` (spec R2) is a same-file heuristic.** In a realistic layout the
  provider lives in `providers.ts` and the `useService` call in a component, so the lint rule
  rarely fires; #35 added a *runtime* dev warning covering the cross-file case. Two mechanisms,
  disjoint coverage — not a principle-5 violation, but `docs/acceptance.md` must record the
  lint half as **Partial**. Noted on #24.
- **`inspect().contributions[].index`** cannot reflect declaration order *within* one module
  contributing several items to one token — `RegistrySnapshot`'s rows carry no registration
  index. Cross-module topological order is exact. Fix is a `registrationIndex` field if dev
  tools ever need it.
- **Leak counters count only `module`-scoped instances.** Deliberate, twice reviewed and twice
  left alone (#36, #40). The residual rule measures what teardown failed to release, and
  `ctx.on`/`ctx.effect` answer that completely.
- **`useServiceOptional` on an unprovided token does not re-render when the module later
  activates** — nothing bumps epochs on plain activation. Known, documented in #35.
- **A collection read via `ctx.getAll` records no resolution-graph edge** to its contributors —
  no requester by C9 design, no construction stack. Accepted, because the declared-`dependsOn`
  cascade never covered it either (#40, recorded in §17).
- The demo app is still the placeholder from bootstrap.

---

## 7. Suggested next moves

1. **Dispatch #22** (task 7.2, the `create-module` generator). It has an obligation day 1 did
   not know about: **the generator must emit the module's own HMR hot block** calling
   `kernel.hotReplace(ref, nextDescriptor)`, because the kernel cannot call `accept` itself
   (§4, ADR-5 addendum). It should also emit the `defineStore` persistent-state pattern (H3)
   and a `createTestKernel` test.
2. Consider having #22 or a small follow-up add the **ADR-5 source-scan rule to the eslint
   preset** (§5.9) — it is the last unenforced rule in the spec, and principle 4 says a rule
   that only exists in documentation is unimplemented.
3. Then **#23 → #24** serially. #24 carries acceptance criterion 10 — a PoC navigation module
   built on public primitives only, which validates principle 1 before spec 03 is written.
   Everything it needs now exists: `kernel.activate`, `kernel.status`/`subscribeStatus`,
   `useServiceAll` over reactive collections, and provenance via `ownerOf`/`inspect()`.
4. When closing a stage issue, **verify its stated definition of done clause by clause** rather
   than assuming its sub-issues covered it. Every stage closed this session carries a comment
   doing exactly that, with probe output. Two of them also record what was *not* discharged.

---

## 8. Scorecard

Across both days: **fourteen PRs merged, fourteen reviewed, four sent back with change
requests**, all four justified.

**Every PR contained at least one confirmed defect in a brief or in the spec, not in the
implementation.** That is the single most important pattern on this project:

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

Two of those were mine, written this session, and both had already propagated into other
briefs before being caught. Assume yours will too. The instruction that surfaces them — *"if a
requirement is wrong, say so plainly rather than working around it silently"* — is still the
most valuable line in the dispatch prompt.

The best single moment was #39's agent using mutation testing to find a false claim in **its
own** comment, and correcting the comment rather than overstating the code. That is the
standard to hold agents to, and the reason to ask for mutation checks explicitly.
