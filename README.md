# ng-react

Angular 2+ guarantees for React and React Native — module boundaries, explicit dependency
injection, and a deterministic module lifecycle — without decorators, `reflect-metadata`,
or hierarchical injectors.

- `packages/ng-react` — `@ng-react/kernel`, the framework.
- `apps/react` — Vite + React 19 demo and acceptance app.
- `docs/spec/01-kernel-and-module-system.md` — the normative spec.
- [AGENTS.md](AGENTS.md) — ground truth for contributors: toolchain, conventions, ADRs.
- [HANDOFF.md](HANDOFF.md) — current status, decisions made, and known traps.

```bash
pnpm install
pnpm verify   # typecheck + lint + test
pnpm --filter @ng-react/demo-react dev
```

Work is tracked as GitHub issues: **stages** are issues, **tasks** are sub-issues, and
each task lands as one squash-merged PR.
