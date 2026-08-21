# HANDOFF — ng-react orchestration, day 1

Written 2026-08-20 for the next orchestrator. Read this, then `AGENTS.md`, then
`docs/spec/01-kernel-and-module-system.md`.

**One-line status:** the toolchain, the work registry, stage 1 (foundations), two thirds of
stage 2 (DI container), and stage 7's lint preset are done and merged. `master` is green.
The next task is **#13**, which closes stage 2 and unblocks everything else.

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

### Merged (`master` green: **205 tests, 17 files**, `pnpm verify` exit 0)

| PR | What |
|---|---|
| — | Workspace bootstrap: pnpm, TS, Vitest (3 projects), ESLint, fallow, AGENTS.md |
| #25 | Module refs, tokens, `MODULE_ID`, `optional`/`allOf`, error hierarchy, shared types |
| #26 | `provide` / `contribute` / `defineModule` declaration APIs |
| #27 | `ProviderRegistry` — provenance, C5/C6 validation, deterministic `inspect()` |
| #28 | `@ng-react/eslint-config-modules` — B1–B3 boundary rules |
| #29 | Resolution engine — three scopes, C4 propagation, C7 disposal, C8 diagnostics |
| — | Two docs commits (ADR-9, spec §17) and one wiring commit (preset by package name) |

### Public API today (`packages/ng-react/src/index.ts`)

`moduleRef` · `isModuleRef` · `createToken` · `isToken` · `optional` · `allOf` ·
`MODULE_ID` · `provide` · `contribute` · `defineModule`, plus types (`ModuleRef`, `Token`,
`AnyToken`, `Dep`, `ResolvedDeps`, `ProviderRecord`, `AnyProviderRecord`,
`ModuleDescriptor`, `ModuleContext`, `EventEmitterLike`, `ModuleStatus`, `Scope`, …) and
the `KernelError` hierarchy.

`ProviderRegistry`, `Resolver` and `Container` are **internal** — deliberately not exported.
The kernel (stage 3) is their only intended caller.

### Issue board

Stages are issues, tasks are sub-issues, both linked via GitHub's sub-issue API.

- **Closed:** #1 (stage 1), #9, #10, #11, #12, #21
- **Open, next up:** **#13** (task 2.3, reactive contribution collections) — closes stage 2
- **Open, blocked behind #13:** #14, #15, #16 (stage 3) → #17 (stage 4), #18 (stage 5) →
  #19, #20 (stage 6) → #23, #24 (stage 8)
- **Open, blocked behind stage 5:** #22 (task 7.2, generator — it emits a `createTestKernel` test)

Several open issues carry **orchestrator comments added after they were written**. Those
comments correct or extend the brief and sub-agents must read them:
- **#13** — the registry's copy-on-write contract and the failure mode it prevents
- **#15** — `EventEmitterLike` must be widened to four emitter shapes; plus the withdraw/dispose sequencing obligation
- **#16** — the same sequencing obligation, and the `onError` → `ErrorSinkToken` wiring
- **#24** — `no-transient-in-component` must be recorded as **Partial** in `docs/acceptance.md`

**Tell every sub-agent to run `gh issue view <n> --comments`, not `gh issue view <n>`.**

---

## 3. How the work is run

One task = one branch = one PR = one squash-merged commit. Sub-agents work in isolated
worktrees, open PRs, and never merge. The orchestrator reviews, verifies, merges, pulls.

Dispatch prompt structure that has worked (see the git history of this conversation's PRs
for the tone):

1. Orient: `pnpm install`, read `AGENTS.md`, read the spec sections, `gh issue view <n> --comments`, read the merged code you build on, rename the branch.
2. Implement exactly the issue — plus a short list of *"the things most likely to go wrong, in order"*, drawn from reading the spec yourself. This has been the highest-leverage part of the prompt.
3. Verify: `pnpm verify`, **print produced error strings verbatim into the PR** so they can be diffed against the spec.
4. Ship: one commit, `Closes #n`, do not merge.
5. Report back — and explicitly: *"if a requirement is wrong, contradictory, or impossible, say so plainly rather than working around it silently."*

That last instruction has produced every significant finding on this project. Keep it.

### Review process — do not skip these

- **Verify claims yourself; do not trust the PR body.** `expectTypeOf` assertions can pass
  vacuously and tests can be weaker than reality. Write a throwaway probe, run it, delete it.
  A pattern that works well: a temp `zzprobe.test.ts` that collects results into an array and
  throws them, so vitest prints them.
- **Diff error messages byte-for-byte against the spec**, in code, not by eye. C8 and G1 are
  quoted verbatim in the spec and are acceptance criteria.
- **Review against the *next* task's requirements, not just this issue's.** The contribution-array
  aliasing bug in #27 was invisible within task 2.1 and fatal to task 2.3.
- **Use `git diff master...branch` (three dots), never `master..branch`.** Two-dot diffs against
  a branch that predates recent master commits show your own work as deletions. #28 looked
  like it reverted ADR-10 and it was purely an artifact.
- Merge with `gh pr merge <n> --squash`. GitHub blocks approving your own PR, so post the
  review as a comment instead — worth doing anyway, it is the durable record.
- After merge: remove the agent worktree, `git worktree prune`, delete the remote branch,
  pull master, re-run `pnpm verify`.

---

## 4. Decisions already made — do not re-litigate

Full text in `AGENTS.md`; §16 resolutions also recorded in spec §17 as the spec itself asks.

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

---

## 5. Traps that cost time — read before touching code

### 5.1 The invariance wall (ADR-10) — the big one

`Token<T>` is invariant in `T`, and `ProviderRecord<T>` is invariant **twice over** (via its
token, and via `onDispose(instance: T)` / `transfer(old: T, new: T)`). Consequence: a
heterogeneous `providers` array has **no** common supertype expressible with `unknown`, so
the spec's own §7.2 worked example did not compile. Every real module's `providers.ts` would
have failed the moment stage 3 wired descriptors up.

Fixed with the two erased aliases. **Do not "fix" them back to `unknown`** —
`packages/ng-react/src/spec-examples.test.ts` exists to fail if you try.

Covariance looks like the obvious alternative and is a trap: it does not fix the array
problem (the record stays invariant via `onDispose`/`transfer`) **and** it silently breaks
`provide(CatToken, { factory: () => dog })`, because `T` then infers from the factory instead
of the token. Verified both ways against the compiler.

### 5.2 Why it survived a whole stage

Stage 1's tests used `Token<unknown>` and single-token arrays throughout, so nothing ever
exercised two differently-typed tokens in one array. The tests passed by being weaker than
reality. `AGENTS.md` §9 now lists that as a reject reason, and every dispatch prompt says
"use realistically and differently typed tokens." Keep saying it.

### 5.3 Container sequencing — an unfixed obligation for stage 3

`Container.withdraw()` and `Container.disposeModuleScope()` are separate primitives and
neither calls the other. That is deliberate — the container should not decide lifecycle
ordering. The required order (dispose instances *before* withdrawing the providers) is written
out on #15 and #16, and task 3.2 implements it.

**Correction (2026-08-21, from #32):** the original version of this note claimed that
withdrawing without disposing "leaks every module-scoped instance silently." **That is false**,
and it propagated into the #15/#16 comments before being caught. `Resolver` keys
`moduleScopedCache` by `entry.owner` and each `CachedInstance` carries its own `record`, so
`disposeModuleScope` never consults the registry — nothing leaks in either order. What
withdraw-first actually breaks is **C5's invariant**: subscribers get notified while the
withdrawn module's instances are still live. Same required order, sound reason. Verified in
both directions.

### 5.4 The `onError` seam is still a no-op

`Resolver`/`Container` accept an `onError` callback and it currently **defaults to a no-op**.
Dispose timeouts (ADR-1) and disposal errors are being silently dropped today. **Task 3.3
(#16) must wire it to the `ErrorSinkToken` contribution collection (F4).** Until then, do not
believe an absence of reported errors.

### 5.5 `.claude/worktrees/` is inside the repo

Agent worktrees are full checkouts with their own `node_modules`. A root `eslint .` was
descending into a live agent's tree and failing on a plugin that agent had installed.
`.claude/**` is now excluded from eslint, vitest and fallow — keep it that way.

### 5.6 `npx` in a fresh worktree

A worktree without `pnpm install` will let `npx tsc` fetch a **decoy** `tsc` that reports no
errors. I nearly dismissed the ADR-10 finding because of this. Always `pnpm install` in a
review worktree before probing, and sanity-check a probe by introducing a deliberate error.

### 5.7 `pnpm-workspace.yaml` carries `allowBuilds: unrs-resolver: true`

Native resolver behind `eslint-plugin-import-x`, which backs `import-x/no-cycle` (B3).
Without the approved build, `pnpm lint` fails with an opaque
`node with invalid interface loaded as resolver`. Do not remove it.

### 5.8 TypeScript is pinned to 5.9.3

TS 7 is out; `typescript-eslint@8` has no stable release supporting it. Bumping TS breaks
lint. Documented in `AGENTS.md`.

---

## 6. Known gaps and honest partials

- **`no-transient-in-component` (spec R2) is a same-file heuristic.** In a realistic layout
  the provider lives in `providers.ts` and the `useService` call in a component, so it will
  rarely fire. Accepted — R2 only asks for a warning, and it is wired as `'warn'` — but
  `docs/acceptance.md` must record it as **Partial** with the reason. Noted on #24.
- **C8's "registered but inactive" suggestion** is implemented as "known to the registry and
  absent from the requester's `dependsOn`". This is correct in practice, because providers only
  enter the registry at activation, but the container layer has no activation-state concept of
  its own. Revisit if stage 3 makes activation state available and the wording drifts.
- **`EventEmitterLike` currently covers one emitter shape** (`on`/`off`). Task 3.2 must widen
  it to four. Noted on #15.
- Nothing under `src/kernel/`, `src/react/`, `src/hmr/`, `src/testing/` exists yet.
- The demo app is still the placeholder from bootstrap.

---

## 7. Suggested next moves

1. **Dispatch #13** (task 2.3). It closes stage 2, and its brief plus the contract comment are
   already written. Nothing else is unblocked until it lands.
2. Then **stage 3 serially**: #14 → #15 → #16. They share `src/kernel/kernel.ts`, so running
   them in parallel will conflict. #16 is where the `onError` seam gets closed.
3. Then **#17 and #18 in parallel** — different directories (`src/react/` vs `src/testing/`),
   only `index.ts` overlaps. #18 must not import React (ADR-6); the `kernel` vitest project is
   the machine check for that.
4. Then #19 → #20, then #22, then #23 → #24.
5. When closing a stage issue, verify its stated definition of done rather than assuming its
   sub-issues covered it. I closed stage 2 prematurely by accident and had to reopen it.

**Parallelism note:** only #17/#18 and (earlier) #21 were genuinely parallelisable. The
dependency chain is real; resist the urge to fan out.

---

## 8. Scorecard so far

Five PRs merged, five reviewed, **three sent back with change requests**, all three
justified:

- **#26** — I claimed a wrong-arity factory could not be guarded at runtime when `deps` is
  omitted. It can: `Function.prototype.length` counts required leading positional params, so
  `factory.length > deps.length` is a one-sided guard that can only false-negative.
- **#27** — `getContributions` handed out the live internal array, mutated in place. Invisible
  in task 2.1; would have silently killed C5 reactivity in task 2.3.
- **#29** — no change requested; probed clean on all eleven behaviours.

**Three defects were found in *my* briefs or in the spec, not in the implementations:** the
unsatisfiable `D extends readonly Dep[]` constraint (twice), the six-vs-seven field
contradiction, and the invariance wall. All three surfaced because agents were told to push
back rather than work around. That instruction is the most valuable line in the dispatch
prompt — do not drop it.
