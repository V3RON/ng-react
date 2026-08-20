# AGENTS.md — ground truth for contributors and sub-agents

This repository implements **ng-react**: a modular application framework for React and
React Native that brings Angular 2+'s *guarantees* (module boundaries, DI, deterministic
lifecycle) to React — deliberately **not** its mechanisms (no decorators, no
`reflect-metadata`, no hierarchical injectors).

**Read `docs/spec/01-kernel-and-module-system.md` before writing any code.** It is
normative. Every requirement in it is numbered (`M1`, `D3`, `C8`, `A2`, `H4`, `R2`, …) and
those numbers are the contract between issues, code, and tests.

---

## 1. Repository layout

```
.
├── AGENTS.md                    # this file
├── docs/spec/                   # normative specs (01 = kernel & module system)
├── package.json                 # workspace root; scripts run from here
├── pnpm-workspace.yaml
├── tsconfig.base.json           # shared compiler options; every project extends it
├── tsconfig.json                # solution file (project references)
├── vitest.config.ts             # single root config, three named projects
├── eslint.config.js             # flat config
├── .fallowrc.json               # fallow (dead code / dupes / health)
├── packages/
│   └── ng-react/                # @ng-react/kernel — the library
│       ├── package.json         # exports "." -> ./src/index.ts (source exports, no build step to consume)
│       ├── tsconfig.json        # composite; emits to dist/ for `pnpm build`
│       └── src/
│           └── index.ts         # THE public API barrel — see §4
└── apps/
    └── react/                   # @ng-react/demo-react — Vite + React 19 demo & acceptance app
```

Additional packages arrive in later stages (`packages/eslint-config-modules`,
`packages/create-module`). Create them only in the stage that owns them.

---

## 2. Toolchain — fixed facts

| Fact | Value | Why it matters |
|---|---|---|
| Package manager | **pnpm 11** workspaces | `npm`/`yarn` will corrupt the lockfile. Never run them. |
| Node | >= 22 | |
| TypeScript | **5.9.3** — pinned | TS 7 is out but `typescript-eslint@8` does not support it yet. **Do not bump TypeScript.** |
| Bundler (app) | Vite 8 + `@vitejs/plugin-react` | |
| Test runner | **Vitest 4**, `globals: true` | |
| Lint | ESLint 10 flat config + `typescript-eslint` 8 | |
| Dead code | `fallow` 3 | `pnpm fallow` |
| Boundary lint | `@ng-react/eslint-config-modules` (this repo) | Wired into root `eslint.config.js` **by package name**, so the workspace `exports` map is exercised. |
| React | 19.2 — a **required** peer dependency of `@ng-react/kernel` | |

> **`pnpm-workspace.yaml` has `allowBuilds: unrs-resolver: true`.** `unrs-resolver` is the
> native resolver behind `eslint-plugin-import-x`, which backs `import-x/no-cycle` (B3).
> pnpm will not run its postinstall build without this approval, and without the build,
> `pnpm lint` fails outright with `node with invalid interface loaded as resolver`. It is a
> dev-only transitive dependency. Do not remove the entry.

### Commands (always run from the repo root)

```bash
pnpm install          # after touching any package.json
pnpm typecheck        # tsc across all projects
pnpm lint             # eslint
pnpm test             # vitest run — all three projects
pnpm fallow           # dead-code report (advisory, not gating)
pnpm verify           # typecheck + lint + test — THE gate for every PR
```

**`pnpm verify` must pass before you open a PR. No exceptions.**

---

## 3. Test conventions — this is load-bearing

`vitest.config.ts` defines three projects. **The file extension picks the environment:**

| File pattern | Project | Environment | Use for |
|---|---|---|---|
| `packages/ng-react/src/**/*.test.ts` | `kernel` | **node** — no DOM, no React renderer | kernel, container, lifecycle, `createTestKernel` |
| `packages/ng-react/src/**/*.test.tsx` | `kernel-dom` | jsdom + React plugin | React bindings only |
| `apps/react/src/**/*.test.{ts,tsx}` | `demo` | jsdom | demo app / acceptance |

This is not cosmetic. **Acceptance criterion 7** requires that the kernel and
`createTestKernel` work "in a plain Jest/Vitest environment with no React renderer". The
`node` project is the machine-checked proof of that: if a kernel test needs jsdom, the
kernel has a dependency it must not have.

Tests live **next to** the code they test (`src/container/resolver.ts` →
`src/container/resolver.test.ts`).

Spec-traceability: name tests after the requirement they pin, e.g.

```ts
it('C6: two provide() calls for one token are a registration-time fatal error naming both modules', …)
```

---

## 4. The public API barrel

`packages/ng-react/src/index.ts` is the **only** public entry point. Rules:

- Everything a consumer may use is re-exported from `index.ts`, explicitly named
  (no `export *` — it defeats `fallow`'s unused-export analysis and tree shaking).
- Everything else is internal. Internal modules import each other by relative path.
- Never add a second subpath export to `packages/ng-react/package.json` without saying so
  in the PR description.

Consumers (the demo app) import **only** from `@ng-react/kernel`, never from
`@ng-react/kernel/src/...`.

---

## 5. Planned source layout of `packages/ng-react/src`

Stages create these files. Stick to the layout so PRs do not collide:

```
src/
  index.ts              public barrel
  types.ts              shared public types (descriptor, status, provider shapes…)
  errors.ts             KernelError hierarchy + message builders (G1, G2, C6, C8, M3, L4)
  token.ts              createToken (C1), MODULE_ID (C4), optional(), allOf()
  module-ref.ts         moduleRef (M1–M3)
  provider.ts           provide / contribute declaration API (C2, C5, C6, C7)
  define-module.ts      defineModule (D1–D4)
  container/
    registry.ts         provider registry + provenance (C9)
    resolver.ts         resolution engine, scopes, disposal (C2, C3, C4, C7, C8)
    collections.ts      reactive contribution collections (C5)
    container.ts        Container facade
  kernel/
    graph.ts            dependency graph, topological sort, cycle detection (G1–G3)
    kernel.ts           Kernel: register/activate/deactivate/status/inspect/retry
    context.ts          ModuleContext (L1–L4)
    failure.ts          failure policy + ErrorSinkToken routing (F1–F4)
  hmr/
    epoch.ts            resolution epochs (H6)
    adapter.ts          HmrAdapter interface + Vite adapter (H2)
    persistent.ts       persistent store transfer (H3, H4)
  react/
    context.tsx         <AppKernel>, useKernel (R1)
    hooks.ts            useService, useServiceAll, useModule (R2, R3)
  testing/
    test-kernel.ts      createTestKernel + leak counters (R4, H7)
```

---

## 6. Architectural decisions (ADRs)

These resolve §16 of the spec and the React-vs-React-Native gap. **They are decided. Do
not re-litigate them in a PR; if you believe one is wrong, say so in the PR description
and implement it as written.**

**ADR-1 — Async `dispose` is awaited with a 2 s timeout.** (Spec §16 Q1.)
HMR correctness depends on teardown completing. On timeout: the module is still marked
`disposed`, and a timeout error is routed to the error sinks (F4) naming the module.
The timeout is configurable via kernel options (`disposeTimeoutMs`, default `2000`),
mirroring the activation timeout (`initTimeoutMs`, default `10000`, A3).

**ADR-2 — `MODULE_ID` outside any module resolves to the reserved id `'app'`.**
(Spec §16 Q2.) `'app'` is a reserved module id: `moduleRef('app')` in a module contract is
a fatal registration error. Resolutions started by the composition root, by
`kernel.get()`, or by components outside any module screen (R2) get `'app'`. `MODULE_ID`
therefore never resolves to `undefined`, and consumers need no `optional()` dance.

**ADR-3 — `persistent: true` transfers by snapshot, with an optional `transfer` hook.**
(Spec §16 Q3.) Default: structural clone of the instance's `snapshot()` return value (or
of the plain-object instance when no `snapshot()` exists), applied to the newly
constructed instance via `restore(snapshot)`. A provider may declare
`transfer: (oldInstance, newInstance) => void` to override entirely, for migrations
between edits.

**ADR-4 — pnpm workspaces, no Nx, no Turbo.** (Spec §16 Q4.) Boundary rules B1/B3 are
implemented as an ESLint preset (`packages/eslint-config-modules`, stage 7), not as Nx
tags. Package `exports` maps are the primary enforcement (§4 of the spec).

**ADR-5 — HMR is abstracted behind an `HmrAdapter`.** The spec is written against Metro
(`module.hot`). This repo's demo app is Vite. The kernel therefore depends on a small
`HmrAdapter` interface (accept/dispose/invalidate), with a `createViteHmrAdapter(hot)`
implementation shipped and a Metro adapter left as a documented, trivial second
implementation. **No kernel code may reference `import.meta.hot` or `module.hot`
directly** — only the adapter may. This keeps the kernel React Native ready without a
React Native app in the repo.

**ADR-6 — The kernel core must not import `react`.** Only `src/react/**` may. Enforced in
practice by the node-environment test project (§3).

**ADR-7 — `require` thunks vs dynamic `import()`.** The spec's descriptor examples use
CommonJS `require('./providers')` for lazy evaluation (D1). This repo is ESM-only, and
Vite/Metro both support dynamic `import()`. Therefore: **descriptor thunks may be
synchronous or return a promise.** `providers`, `init` and `dispose` are all
`() => T | Promise<T>`, so `providers: () => import('./providers').then(m => m.providers)`
is the blessed ESM form. The D1 guarantee (no implementation evaluated before activation)
is unchanged and is what acceptance criterion 9 verifies.

**ADR-10 — Type erasure for heterogeneous provider/token collections.** `Token<T>` is
invariant in `T` (its brand puts `T` in both co- and contravariant position), and
`ProviderRecord<T>` is invariant twice over — via its token and via
`onDispose(instance: T)` / `transfer(old: T, new: T)`. Consequence: a heterogeneous
`providers` array has **no** common supertype expressible with `unknown`, so the spec's own
§7.2 worked example did not compile. Two erased aliases fix it:

```ts
export type AnyToken = Token<any>;                    // token.ts
export type AnyProviderRecord = ProviderRecord<any>;  // provider.ts
```

`any` is the standard existential-type escape hatch and is **confined to these two
aliases**. Every public API that accepts a token or a record stays generic in `T` and
recovers the precise type from its argument, so `any` never reaches a consumer. Use
`AnyProviderRecord` for any collection of records (descriptor `providers`, registry
storage, container internals) and `AnyToken` for type-erased map keys. Do not "fix" these
by substituting `unknown` — that is the bug, and `packages/ng-react/src/spec-examples.test.ts`
will fail if you try.

The accepted cost: an erased record can be re-narrowed to a concrete `ProviderRecord<X>`
without complaint. Harmless, because records are opaque — nothing reads `T` off a record;
the container re-derives it from the token passed to `resolve`.

**ADR-9 — The descriptor has seven fields, not six.** Spec §5.2's prose says "It has
exactly six fields", but the worked example directly below it — and every other field list
in the spec — has **seven**: `id`, `dependsOn`, `load`, `critical`, `providers`, `init`,
`dispose`. The prose is stale: Revision 2's changelog records `capabilities` and
`contributions` being removed from that list, and the count was evidently not updated. The
executable example wins. **Seven is the contract**; an eighth field is the rejected case in
§9 below. `defineModule` validates against exactly these seven and names them in its
unknown-field error. Do not "fix" the count in either direction.

**ADR-8 — Naming.** Public package is `@ng-react/kernel`; module id strings in the demo
app use the bare feature name (`auth`, `orders`) per spec §4. Token labels are
`moduleId/Name` (C1).

---

## 7. How work is organised

- **Stages are GitHub issues.** Each stage issue lists its tasks as a checklist.
- **Tasks are GitHub sub-issues** of their stage. A task issue contains the full,
  self-contained brief: spec requirements to satisfy, files to create, public API to
  export, and the tests that must exist. **Read your task issue in full; it is the
  authority for your scope.**
- **One task = one branch = one PR = one commit** (squash-merged).
- Sub-agents work in **isolated git worktrees** and open PRs. The orchestrator reviews,
  verifies, and merges.

### Branch and commit conventions

- Branch: `stage-<n>/<task-slug>` — e.g. `stage-2/resolution-engine`.
- Commit subject: `<area>: <imperative summary>` — e.g. `container: add resolution engine with three scopes`.
- Commit body: reference the spec requirement ids implemented and `Closes #<issue>`.

### PR checklist (the orchestrator enforces all of it)

1. `pnpm verify` passes locally, output pasted in the PR body.
2. Every spec requirement id claimed by the task issue has at least one test naming it.
3. No new public export that the task issue did not ask for.
4. No changes to files outside the task's declared scope (especially not to
   `package.json`, `tsconfig*.json`, `vitest.config.ts` — if you need one, say why in the
   PR body).
5. Error messages match the spec verbatim where the spec quotes them (G1, C8). "Errors are
   a feature" — principle 6. Assert on the exact string.

---

## 8. Coding standards

- **TypeScript strict**, `noUncheckedIndexedAccess` on. No `any` in exported signatures;
  `unknown` plus a narrowing helper instead. The **only** sanctioned exceptions are the
  two erased aliases in ADR-10, each carrying a single scoped `eslint-disable-next-line`.
  Adding a third requires the same standard of justification as a new descriptor field.
- `import type { … }` for type-only imports (`consistent-type-imports` is an error).
- No decorators. No `reflect-metadata`. No runtime reflection of function parameter names.
  Dependencies are always explicit token arrays (principle 3).
- No default exports.
- Errors: throw subclasses from `src/errors.ts`, never bare `Error`. Every error carries
  the full resolution/cycle path and, where the spec specifies one, a suggested fix.
- Comments explain *why*, and cite the spec id (`// C4: resolution context …`) when
  implementing a numbered requirement.
- Keep the kernel dependency-free: **zero runtime dependencies** beyond the `react` peer.

---

## 9. Things that will get a PR rejected

- Adding a field to the module descriptor. It has exactly six (D2 note in §5.2) and each
  addition is a permanent contract requiring justification against principle 1.
- Introducing a hierarchical/child injector, property injection, async factories, or
  circular-resolution support (spec §7.3).
- Adding a lifecycle hook beyond `init` and `dispose` (principle 2).
- A rule described in a doc but not enforced by code or lint (principle 4).
- Two ways to do the same thing (principle 5).
- `npm install` / `yarn` — pnpm only.
- Snapshot tests standing in for behavioural assertions on error messages.
- Transcribing a spec code block into a test with the types weakened (`Token<unknown>`
  everywhere, empty arrays) so it passes. That is how the ADR-10 defect survived stage 1.
  Worked examples get realistic, *differently*-typed values or they prove nothing.
