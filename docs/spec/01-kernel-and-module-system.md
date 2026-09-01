# SPEC 01 — Kernel & Module System

Status: Draft for implementation — Revision 2
Series: 01 of N (planned: 02 Event Bus, 03 Navigation Module — built on kernel primitives, 04 Slots & Cross-Module UI, 05 Platform Services — storage, app-state, http, config, 06 Dev Tools & Generators)

Revision 2 changes: `dependsOn` uses typed module refs instead of string literals; `capabilities` and `contributions` removed from the descriptor (navigation and all contribution routing move to spec 03, built on kernel primitives); provider hot-reload semantics specified (H4–H6); open question on route manifests resolved by the navigation-as-module design.

## 1. Purpose

This document specifies the kernel and module system of a modular framework for React Native, inspired by the guarantees of Angular 2+, Spring, and .NET DI — not their mechanisms. It defines the module descriptor, the dependency injection container, the module lifecycle, activation semantics, Fast Refresh behavior, failure policy, and the React bindings, together with the tooling that enforces module boundaries.

The kernel is the only component in the system with authority: it knows module identities, controls when module code is evaluated and activated, owns disposal, and exposes the primitives (activation, providers, reactive contribution collections, provenance) that higher subsystems — navigation, slots, notifications — are built on as ordinary modules. Everything that does not require this authority is explicitly out of the kernel and must be implemented as an injectable service or a module in a later spec.

## 2. Design principles

These principles are normative. When an implementation question is not answered by this document, resolve it against them, in order.

1. **Minimal kernel.** A capability belongs in the kernel only if it must act before a module's code is evaluated, must act across modules with enforced (not self-reported) identity, or must guarantee ordering that no single module can guarantee for itself. Everything else is a service or module registered through the container — including navigation (spec 03), which relates to the kernel as Angular's RouterModule relates to Angular core.
2. **Services over lifecycle.** The framework never adds a lifecycle hook whose meaning is "the framework informs you about X." Modules learn about X by injecting a service and subscribing inside `init`. The lifecycle is fixed at two phases: `init` and `dispose`.
3. **Explicit over reflective.** No `reflect-metadata`, no decorator-driven injection metadata. Dependencies are declared as explicit token arrays. This keeps the system compatible with Hermes, minification-safe, tree-shakeable, and debuggable.
4. **Boundaries by tooling, not discipline.** Module encapsulation is enforced by the package resolver (subpath exports) and lint rules. A rule that only exists in documentation is considered unimplemented.
5. **One blessed way.** Where two API styles could serve a concern, exactly one is specified and the other is rejected. Generators emit the blessed style.
6. **Errors are a feature.** Container and graph errors must always report the full resolution or cycle path and, where possible, a suggested fix. Error message quality is an acceptance criterion, not polish.

## 3. Terminology

**Module** — a feature unit with an identity, a descriptor, optional providers, and a lifecycle. Physically, a package (or a folder treated as one) with controlled entry points.

**Module ref** — a typed value identity for a module, created with `moduleRef(id)` and exported from the module's contract. Refs are how modules are named in `dependsOn`, in kernel APIs, and by higher subsystems (e.g. route configs in spec 03).

**Descriptor** — the statically evaluable object that describes a module to the kernel. Evaluating a descriptor must not evaluate the module's implementation code.

**Contract** — a module's public surface: TypeScript interfaces, tokens, its module ref, and event type declarations. Contains no implementation values.

**Registration** — the kernel learning that a module exists (descriptor loaded, graph edges recorded). Cheap; happens for all modules at startup.

**Activation** — the kernel evaluating a module's implementation (resolving provider thunks, running `init`). May happen at startup (eager) or on demand (lazy).

**Token** — a typed, unique key identifying an injectable capability. Created via `createToken<T>(description)`.

**Resolution context** — the identity of the module on whose behalf a resolution is being performed, available to factories.

**Provenance** — the kernel-recorded fact of which module supplied a given provider or contribution. Enforced by the kernel, never self-reported.

## 4. Package layout and entry points

Each module is a package in the monorepo. The package name is the module id prefixed by the workspace scope (e.g. `@app/orders` has module id `orders`). Each module package declares `"sideEffects": false` and exposes exactly two public subpath exports, with no root export:

```json
{
  "name": "@app/orders",
  "sideEffects": false,
  "exports": {
    "./contract": "./src/contract.ts",
    "./module": "./src/module.ts"
  }
}
```

`./contract` may be imported by any module. It contains only types, `createToken` calls, the module's `moduleRef`, and event type declarations. A lint rule (section 13) rejects any other value export from a contract file.

`./module` may be imported only by the application's composition root (the file that assembles the module list). It exports the descriptor as a named export `module`.

Implementation files are not exported and are therefore unreachable from outside the package via the resolver. Metro must be configured with package exports support enabled (stable in current React Native; enable `unstable_enablePackageExports` on older Metro versions).

The shared kernel package (`@app/kernel`) exports the framework API. There is deliberately no shared "common" module with special status; shared UI or utilities are ordinary packages with no module privileges and no access to module internals.

## 5. Module ref and descriptor

### 5.1 Module ref

```ts
// @app/orders — src/contract.ts
import { moduleRef } from '@app/kernel';
export const OrdersModule = moduleRef('orders');
```

**M1.** A ref is a unique value identity (each `moduleRef` call is distinct); the string is the module id used for diagnostics, graph serialization, and dev tools. Refs are the only sanctioned way to name a module in code: `dependsOn`, `kernel.activate`, `kernel.deactivate`, `useModule`, and higher-subsystem configs all take refs. String-based lookups exist only on diagnostic surfaces (`kernel.inspect()`).

**M2.** Because a dependency is expressed by importing the ref from the target module's contract, a typo is a compile error and "find all references" on the ref shows every dependent. The import graph of contracts mirrors the module graph by construction.

**M3.** Registering two descriptors whose refs carry the same id string is a fatal startup error naming both packages (guards against copy-paste of `moduleRef('x')` across contracts).

### 5.2 Descriptor

The descriptor is created with `defineModule` and is the complete kernel-facing surface of a module. It has exactly seven fields; each future addition is a permanent contract and requires justification against principle 1.

```ts
// @app/orders — src/module.ts
import { defineModule } from '@app/kernel';
import { OrdersModule } from './contract';
import { AuthModule } from '@app/auth/contract';
import { PaymentsModule } from '@app/payments/contract';

export const module = defineModule({
  id: OrdersModule,
  dependsOn: [AuthModule, PaymentsModule],
  load: 'lazy',                       // 'eager' | 'lazy'; default 'lazy'
  critical: false,                    // failure policy, section 10
  providers: () => require('./providers').providers,
  init: (ctx) => require('./lifecycle').init(ctx),
  dispose: (ctx) => require('./lifecycle').dispose(ctx),
});
```

Normative requirements:

**D1.** The descriptor and its static fields (`id`, `dependsOn`, `load`, `critical`) must be evaluable without evaluating any implementation file. All implementation references are thunks using inline `require`; the kernel calls them only at activation. (Contract files are importable by descriptors because contracts contain no implementation.)

**D2.** `id` is the module's own ref, imported from its own contract. This is the single source of the module's identity; the descriptor never re-states the id string.

**D3.** `dependsOn` is an array of refs of modules whose activation must complete before this module's activation. It is the only inter-module ordering mechanism. It does not grant import access to the other module's implementation — only contracts are importable regardless.

**D4.** `init` and `dispose` are optional. Modules whose behavior is fully expressed by providers declare neither.

There is no `contributions` field and no `capabilities` field. Routes, deep links, notification handlers, and slot fills are expressed as ordinary multi-provider contributions inside `providers` against tokens owned by the relevant subsystem module (navigation — spec 03; slots — spec 04). Native capability declarations are deferred entirely and are not a kernel concern in this revision.

## 6. Registration, activation, and load strategies

At startup the application composition root passes the full descriptor list to the kernel. The kernel then:

1. Registers all descriptors: validates refs (M3), builds the dependency graph from `dependsOn`, and topologically sorts it. Cycle detection failures are fatal and must print every module in the cycle in order (section 9).
2. Activates all `eager` modules in topological order. Activation of a module means: evaluate its provider thunk and register providers; run `init(ctx)` to completion (async allowed); mark the module `ready`.
3. Defers `lazy` modules until an activation trigger occurs: explicit `kernel.activate(ref)`, or another activating module listing the ref in `dependsOn`.

The kernel itself has no notion of route-, deep-link-, or notification-driven activation. Subsystem modules built on the kernel translate their own triggers into `kernel.activate(ref)` — e.g. the navigation module (spec 03) activates a module when a parent route config maps a matched path to its ref. This keeps every activation trigger outside the kernel expressible without kernel changes.

Normative requirements:

**A1.** Activating a module first activates its not-yet-active `dependsOn` transitively, in topological order. A lazy module being activated must never observe a dependency that is registered but not ready.

**A2.** Activation is idempotent and single-flight: concurrent triggers await one activation. Module status is one of `registered | activating | ready | failed | disposed`, exposed to React via `useModule` (section 12) and observable programmatically via `kernel.status(ref)` subscriptions, which subsystem modules use.

**A3.** `init` may be async. The kernel imposes a configurable timeout per module (default 10 s); on timeout the failure policy (section 10) applies. Critical modules in the startup activation closure — every eager module plus its transitive dependencies — gate splash-screen dismissal. If that closure contains no critical module, the gate resolves immediately without waiting for eager non-critical activation. This hook point is specified here, its use by a startup orchestration service in spec 05.

**A4.** Deactivation (`kernel.deactivate(ref)`) disposes the module and every active module that transitively depends on it, in reverse topological order, before disposing the module itself. Used by feature-flag kills, logout flows, tests, and HMR.

## 7. Dependency injection container

### 7.1 Tokens

```ts
// in @app/orders contract
export interface OrderService {
  place(draft: OrderDraft): Promise<OrderId>;
}
export const OrderServiceToken = createToken<OrderService>('orders/OrderService');
```

**C1.** Tokens are value identities (each `createToken` call is unique); the string is a diagnostic label, conventionally `moduleId/Name`. Two calls with the same label are still distinct tokens — collisions are impossible by construction.

### 7.2 Providers

```ts
export const providers = [
  provide(OrderServiceToken, {
    scope: 'module',                      // 'singleton' | 'module' | 'transient'
    deps: [HttpToken, StorageRootToken, MODULE_ID],
    factory: (http, storage, moduleId) => createOrderService(http, storage.forModule(moduleId)),
  }),
  contribute(AnalyticsSinkToken, {
    deps: [],
    factory: () => ordersAnalyticsSink,
  }),
];
```

**C2. Scopes.** Exactly three, flat, no hierarchy: `singleton` (one instance for the app lifetime, constructed on first resolution), `module` (one instance per providing module's activation, disposed with the module), `transient` (new instance per resolution). There is no injector tree and no shadowing; this is a deliberate rejection of Angular's hierarchical injectors.

**C3. Laziness.** All construction is lazy on first resolution. A provider that must run at activation regardless of consumers is not a provider — it is `init` code.

**C4. Resolution context.** `MODULE_ID` is a kernel-supplied contextual token resolving to the id of the module on whose behalf the current resolution chain was started (the module owning the resolving `init`/provider, or the module owning the screen for React resolutions). It is the sanctioned mechanism for consumer-specialized services (namespaced storage, tagged loggers, module-scoped analytics). Modules never pass their own id as a string argument for these purposes.

**C5. Multi-providers.** `contribute(token, provider)` appends to a collection; `injectAll(token)` (and `deps: [allOf(Token)]`) resolves the full collection in module topological order. Contributions from a module are removed when it is disposed, and the collection is **reactive**: `subscribeAll(token, cb)` (and `useServiceAll`, R3) notify when the set changes due to module activation or disposal. Reactive contribution collections are the primary kernel primitive that subsystem modules (navigation, slots) are built on. `provide` on a token that has contributions, or `contribute` on a token that was `provide`d, is a registration-time error.

**C6. Conflicts and overrides.** Two `provide` calls for one token are a registration-time fatal error naming both providing modules (via provenance). Overriding is explicit — `provide(token, { override: true, ... })` — and is intended for the composition root and tests only; a lint rule flags `override: true` inside module packages.

**C7. Disposal.** If a constructed instance has a `dispose(): void | Promise<void>` method, or the provider declares `onDispose(instance)`, the container invokes it when the owning scope ends (module disposal for `module` scope; app/kernel teardown for `singleton`; never for `transient` — transient lifetime is the consumer's responsibility, and the generator's blessed pattern is to acquire transients inside `ctx.effect`).

**C8. Errors.** A failed resolution reports the full chain: requesting module, each token in the path, the token that failed, and — when the token's label prefix matches a registered but inactive or non-`dependsOn` module — a suggestion to add that module's ref to `dependsOn`. Example target message: `Cannot resolve orders/OrderService → payments/PaymentGateway: no provider. 'payments' is registered but not listed in dependsOn of 'orders'.`

**C9. Provenance.** The kernel records, for every provider and contribution, the module that registered it. Provenance is kernel-assigned at registration (derived from the activating descriptor), never passed by the module, and is exposed via `kernel.inspect()` and to subsystem modules (e.g. the navigation module uses route-contribution provenance to wrap screens in module-attributed error boundaries — spec 03).

### 7.3 What the container will not do

No property injection, no optional-by-default dependencies (an explicit `optional(Token)` wrapper resolves to `undefined` instead of erroring), no decorators, no async factories (async work happens in `init` or inside the service's own methods), no circular resolution support of any kind.

## 8. Lifecycle and the context object

`init(ctx)` is the module's only place for effects: subscriptions, registrations with services, timers. `ctx` collects disposables so teardown is structural; a hand-written `dispose` mirroring `init` is an anti-pattern and should almost never exist.

```ts
export async function init(ctx: ModuleContext) {
  const bus = ctx.get(EventBusToken);
  ctx.on(bus, 'auth/session.expired', flushOrderDrafts);       // auto-removed on dispose
  ctx.effect(() => {
    const timer = setInterval(syncPendingOrders, 60_000);
    return () => clearInterval(timer);                          // auto-run on dispose
  });
}
```

**L1.** `ctx.get(token)` resolves through the container with this module as resolution context. `ctx.getAll(token)` resolves contributions.

**L2.** `ctx.effect(fn)` runs `fn` immediately and registers its returned cleanup. `ctx.on(emitter, event, handler)` is sugar over `effect` for any subscribe/unsubscribe-shaped API and must work against the event bus (spec 02) without the bus being special-cased.

**L3.** On dispose, the kernel runs collected cleanups in reverse registration order, then the optional `dispose(ctx)` handler, then disposes module-scoped provider instances. Cleanup errors are reported to the error policy but do not abort remaining cleanups.

**L4.** After dispose, the `ctx` is dead: any use throws with the module id and a note that the code is likely holding a stale closure across HMR.

## 9. Graph validation and error reporting

**G1.** Cycles in `dependsOn` are fatal at registration with the full path: `Module dependency cycle: orders → payments → risk → orders. Break it by moving the shared surface into a contract.` (Note that ref-based `dependsOn` makes cycles between contract imports visible to `import/no-cycle` as well, so most cycles are caught at lint time before runtime.)

**G2.** A `dependsOn` ref whose descriptor was not registered with the kernel is fatal at registration, naming the missing module id and the dependent (this now indicates a composition-root omission rather than a typo, since typos no longer compile).

**G3.** The kernel exposes the resolved graph (`kernel.inspect()`): modules, statuses, edges, providers and contributions with provenance. This is the data source for dev tools (spec 06) and for graph snapshot tests.

## 10. Failure policy

**F1.** A module whose activation fails (provider thunk throws, `init` throws or times out) transitions to `failed` with the error retained.

**F2.** If `critical: true` and the failure occurs during startup activation, startup fails visibly (dev: red screen with the module id and error; prod: configurable fatal handler). This includes a lazy critical module pulled into startup by an eager dependent; the fatal error names the critical module rather than only the dependent that triggered it. Critical modules are expected to be few.

**F3.** Non-critical failures quarantine the module: its providers and contributions are withdrawn (reactive collections notify, so e.g. the navigation module drops its routes automatically), and dependents' activation fails with a cause chain naming the quarantined module. `kernel.retry(ref)` re-attempts activation.

**F4.** Error *reporting* is a contribution collection owned by the kernel: modules `contribute(ErrorSinkToken, …)` and the kernel routes lifecycle, cleanup, and activation errors to all sinks with kernel-assigned module attribution (C9). Error *containment* for rendered screens (per-module error boundaries around route components) is a navigation-module concern specified in spec 03, built on provenance.

## 11. Fast Refresh and HMR

Goal: editing lifecycle code, providers, service implementations, or screens never requires a full reload, and never double-registers effects.

**H1.** Screens and ordinary components rely on React Fast Refresh untouched; the kernel does not interfere.

**H2.** The kernel registers Metro HMR acceptance (`module.hot`-equivalent API) for descriptor, lifecycle, and provider chunks. On update of any implementation file of an active module: dispose the module (running all `ctx` cleanups and provider-instance disposal per H4), re-evaluate the updated thunks, re-activate, and re-activate any dependents that were disposed by the cascade, preserving topological order. On update of a `registered`-but-inactive module, only the registration is refreshed.

**H3.** Because HMR re-activation is dispose→init, durable state must not live in module closures. The blessed pattern: state lives in `singleton`-scoped stores (which survive *other* modules' re-activation) or in stores explicitly marked `persistent: true`, which the container carries across an HMR re-activation of their own module (but not across a real deactivation). The generator emits this pattern; the docs state plainly that closure state is lost on every edit by design.

**H4. Instance disposal on provider edit.** When a module is HMR-re-activated, every provider instance it registered is disposed and discarded **regardless of scope** — including `singleton`. In production terms a singleton is app-lifetime, but under HMR the provider itself changed, so the old instance is invalid; the next resolution constructs from the new factory. `persistent: true` stores (H3) are the sole exception: their state is transferred to the newly constructed instance via the store's transfer function.

**H5. Consumer cascade by resolution graph.** In dev mode the container records the true resolution graph — which module actually resolved which token from which provider (a subset of `dependsOn`). The HMR cascade disposes and re-activates only modules that actually consumed a resolved instance from the edited module, not all `dependsOn` dependents. Production deactivation (A4) continues to cascade by declared `dependsOn`; the resolution graph is a dev-only optimization and is never load-bearing for correctness.

**H6. React re-resolution.** Each module re-activation bumps a kernel resolution epoch. `useService` subscribes to the epoch of the provider's module, so components holding a disposed instance re-render and resolve the fresh one. Components need no HMR awareness of their own.

**H7.** A dev-mode invariant check runs after each HMR cycle: listener counts and effect counts must return to their pre-dispose baseline ± the diff introduced by the edit; violations log a leak warning naming the module.

## 12. React bindings

**R1.** `<AppKernel kernel={kernel}>` provides the kernel via context at the root. There is exactly one per app; nesting is an error (except the test kernel, R4).

**R2.** `useService(Token)` resolves through the container with resolution context set to the module owning the enclosing screen (provenance-tagged by the navigation module at route registration — spec 03; components outside any module screen resolve with app-root context). Referential stability: for `singleton` and `module` scopes the same instance is returned across renders (subject to H6 epochs in dev); `transient` in components is a lint warning (blessed alternative: resolve inside handlers or effects).

**R3.** `useModule(ref)` returns `{ status, error, retry }` and re-renders on status change. `useServiceAll(Token)` mirrors `injectAll` over the reactive collection (C5) and re-renders when the contribution set changes (module activation, disposal, quarantine). `useServiceAll` is the render-side half of the primitive that subsystem modules build on — the navigation module's root navigator is, at its core, `useServiceAll(RouteConfigToken)`.

**R4.** `createTestKernel({ modules, overrides })` builds an isolated kernel for tests: activate a module with mocked providers (via `override: true`), drive its lifecycle, dispose, and assert via `kernel.inspect()` and H7-style leak counters that nothing survived. This harness is part of the kernel package, not an afterthought.

## 13. Boundary enforcement

Shipped as a lint config preset (`@app/eslint-config-modules`) and required in CI:

**B1.** Imports across module packages are allowed only from `<pkg>/contract`; importing `<pkg>/module` is allowed only in the composition root. (Backstop for resolvers that ignore `exports`; primary enforcement is the resolver itself, section 4.)

**B2.** Contract files may export only types, interfaces, `createToken` calls, exactly one `moduleRef` call, and event type declarations. Any other value export is an error.

**B3.** `import/no-cycle` (or the Nx boundary equivalent) runs across the workspace; `override: true` outside the composition root and test files is an error; `transient` resolution via `useService` is a warning (R2).

**B4.** The `create-module` generator emits: package.json with the exports map (section 4), `contract.ts` (with the `moduleRef`), `module.ts` descriptor referencing it, `providers.ts`, `lifecycle.ts`, a test using `createTestKernel`, and the lint config wiring. Generators are the delivery vehicle for every blessed pattern in this spec.

## 14. Out of scope for this spec

The event bus implementation and typed event map (spec 02 — this spec only requires that `ctx.on` composes with it, L2). The navigation module (spec 03): route configs, guards, deep links, notification routing, screen error boundaries, and route-driven activation — all built on the kernel primitives specified here (`kernel.activate`, `kernel.status`, reactive contribution collections C5, provenance C9) with no kernel changes anticipated. Slots (spec 04). Storage, app-state, http, config, startup orchestration services (spec 05) — all pure services per principle 1. Native capability declarations and Module Federation / OTA delivery — deferred entirely; nothing in this revision reserves descriptor surface for them. Persistence of any kernel state across app restarts — none exists.

## 15. Acceptance criteria

1. A demo app with four modules (`auth` eager+critical, `orders` lazy, `payments` lazy, `debug` eager non-critical) where `orders` dependsOn `auth` and `payments`, demonstrating: lazy activation via `kernel.activate(OrdersModule)`, transitive activation of `payments`, quarantine of a deliberately failing `debug` module without startup impact, and logout via `deactivate(AuthModule)` cascading disposal of `orders` and `payments` dependents in reverse order.
2. Type-level test: a string literal or a ref with a mismatched type in `dependsOn` fails compilation; a ref for a module missing from the composition root fails registration with the G2 message.
3. Editing `orders/lifecycle.ts` while the app runs re-activates only `orders` (and true consumers per H5), preserves `persistent: true` store state per H3/H4, and the H7 leak check passes across 20 consecutive edits.
4. Editing a service implementation behind a `singleton` provider of `payments` disposes the old instance (H4), re-activates only actual consumers (H5), and mounted components re-render with the fresh instance without any reload (H6).
5. Deleting a provider that `orders` depends on produces the C8 error message verbatim quality: full chain plus actionable suggestion.
6. A cycle introduced between two modules fails at lint time via contract import cycle detection and, if forced past lint, at registration with the G1 message listing the exact cycle.
7. `createTestKernel` can activate `orders` with a mocked `payments/PaymentGateway`, run an `init`-registered listener, dispose, and prove zero leaked listeners — in a plain Jest/Vitest environment with no React renderer.
8. The lint preset rejects: a deep import into another module's `src/`, a value export from a contract beyond B2's allowlist, and `override: true` inside a module package.
9. Bundle check: with all modules `lazy` except `auth`, no implementation file of a lazy module is evaluated before its activation trigger (verified via evaluation-order instrumentation in dev).
10. A minimal proof-of-concept navigation module can be built against the kernel package using only public primitives (activate, status subscription, `useServiceAll`, provenance) — no kernel modification. This criterion exists to validate principle 1 before spec 03 is written.

## 16. Open questions (decide during implementation, record decisions in this doc)

1. Async `dispose`: awaited with a timeout, or fire-and-forget with reporting? Leaning: awaited with a short (2 s) timeout, since HMR correctness depends on teardown completing.
2. `MODULE_ID` propagation for resolutions started outside any module (composition root, app-level UI): a reserved `app` id, or `undefined` with `optional()` semantics?
3. `persistent: true` transfer semantics (H4): structural copy of a plain-object state snapshot vs a user-supplied `transfer(oldState) => newState` function. Leaning: snapshot by default, optional transfer function for migrations between edits.
4. Monorepo tooling baseline (pnpm workspaces + turbo vs Nx) — affects how B1/B3 are implemented but nothing in the kernel API.

**All four are decided. The resolutions are recorded in §17 below**, which is the "record decisions in this doc" half of this section's own instruction, together with every discrepancy found in this document while implementing it. The full rationale for each lives in `AGENTS.md` under the matching ADR id (`ADR-1`..`ADR-4` for the four questions above); `AGENTS.md` §6 is also where they are declared not to be re-litigated in a PR. Which criterion each decision is exercised by is recorded in `docs/acceptance.md`.

---

## 17. Decisions recorded during implementation

Resolutions of §16 and of discrepancies found while implementing. The full rationale for
each lives in `AGENTS.md` under the matching ADR id; this section is the spec-side record
that §16 asks for.

- **§16 Q1 — async `dispose`** → awaited with a **2 s timeout** (`disposeTimeoutMs`), since
  HMR correctness depends on teardown completing. On timeout the module is still marked
  `disposed` and the timeout is routed to the error sinks (F4). See ADR-1.
- **§16 Q2 — `MODULE_ID` outside any module** → the reserved id **`'app'`**, not
  `undefined`. `moduleRef('app')` is a fatal error, so the id cannot collide. `MODULE_ID`
  therefore never resolves to `undefined` and consumers need no `optional()` dance.
  See ADR-2.
- **§16 Q3 — `persistent: true` transfer** → **snapshot by default**, with an optional
  user-supplied `transfer(oldInstance, newInstance)` for migrations between edits.
  Resolution order: `transfer` → `snapshot()`/`restore()` → structural copy of own
  enumerable properties → warn and keep the fresh instance. Never throws. See ADR-3.
- **§16 Q4 — monorepo tooling** → **pnpm workspaces**, no Nx, no Turbo. B1/B3 are
  implemented as an ESLint preset plus package `exports` maps rather than Nx tags.
  See ADR-4.

Discrepancies found in this document and how they were resolved:

- **§6 A3 / §10 F2 — `critical` on a lazy startup dependency.** Load strategy and
  criticality are independent. The startup gate is built from critical modules in the
  transitive activation closure of every eager module, not only descriptors whose own
  `load` is `eager`. A lazy critical dependency therefore gates startup and its failure
  rejects `whenStartupComplete()` and reaches `onFatal` with that module's own error.
  With no critical module in the closure, the promise still resolves immediately without
  waiting for eager non-critical modules. See issue #61.
- **§10 F2 / React failure UI — rendering does not replace host fatal policy.** The
  kernel remains React-free (ADR-6): it cannot know that `useKernelStartup()` or
  `<KernelStartupGate>` is rendering the rejected startup promise. A host that wants that
  UI to be the only visible failure surface passes `onFatal` at the composition root; a
  no-op is valid. Without it, the default macrotask rethrow still reaches React Native's
  LogBox or the browser overlay and may cover the app-owned screen. Both demos model the
  explicit handler. See issue #70.

- **§5.2 field count** — the prose said "exactly six fields" while the worked example
  below it lists seven (`id`, `dependsOn`, `load`, `critical`, `providers`, `init`,
  `dispose`). Revision 2 removed `capabilities` and `contributions` without updating the
  count. **Corrected to seven** in §5.2 above; the example was always the executable
  contract. See ADR-9.
- **§5.2 / D1 `require` thunks** — the descriptor examples use CommonJS
  `require('./providers')` for lazy evaluation. The implementation is ESM-only, so thunks
  are typed `() => T | Promise<T>` and the blessed form is
  `providers: () => import('./providers').then(m => m.providers)`. The D1 guarantee is
  unchanged. See ADR-7.
- **§7.2 worked example did not type-check** — a heterogeneous `providers` array
  (`[provide(OrderServiceToken, …), contribute(AnalyticsSinkToken, …)]`) has no common
  supertype, because both `Token<T>` and `ProviderRecord<T>` are invariant in `T`. Fixed
  with two erased aliases, `AnyToken` and `AnyProviderRecord`, confining `any` to those two
  declarations. The spec's examples are now transcribed as executable regression tests in
  `packages/ng-react/src/spec-examples.test.ts`. See ADR-10.
- **§11 Metro `module.hot`** — abstracted behind an `HmrAdapter` interface so the kernel
  stays bundler-agnostic and React Native ready. See ADR-5.
- **§11 H2 — who calls `HmrAdapter.accept`.** H2 says "the kernel registers Metro HMR
  acceptance for descriptor, lifecycle, and provider chunks". The kernel **cannot**: a
  module id (`payments`) is not a bundler chunk id, only a module's own files know their
  specifiers, and only the re-evaluated `module.ts` holds the new descriptor. **Resolved:**
  `accept` is called from the module's own hot-update block (stage 7's generator emits it)
  and calls `kernel.hotReplace(ref, nextDescriptor)`; the kernel holds the adapter and uses
  it for `invalidate` — telling the bundler to escalate when an update could not be applied
  in place. `KernelOptions.hmr` defaults to the noop adapter, so a production kernel never
  asks a bundler for anything. See issue #19.
- **§11 H2 — a replacement descriptor that fails graph re-validation.** G1/G2 validation
  runs **before** anything is disposed, and a failing replacement is rejected *whole*: the
  old descriptor and old graph stay in force, nothing is torn down, the module keeps
  running the code it was running, and the error goes to the error sinks (F4) and to
  `hmr.invalidate`. `hotReplace` still resolves. The alternative — dispose first, discover
  the cycle, leave the module `disposed` — leaves the app dead until a manual reload,
  because the *fixing* edit then arrives for an inactive module, which H2 refreshes
  registration-only. The accepted cost is that while a bad edit is in force the running
  code and the source on disk disagree. See issue #19.
- **§11 H2/H4 — the descriptor swap lands between disposal and re-activation.**
  `teardown` calls `descriptor.dispose(ctx)`, and §8 makes a `dispose` handler the mirror
  of a *completed* `init`. Committing the replacement before disposal would run the new
  code's teardown against the old code's context. See issue #19.
- **§11 H3/H4 — how "preserve on HMR, discard on deactivate" is threaded.** Since #34 both
  paths run the same disposal code, so the distinction cannot be inferred from the call
  site. `Container.disposeModuleInstances(id, { preservePersistent })` carries it
  explicitly, and only `hotReplace` passes `true`. A preserved instance is **not disposed
  at all** — disposing a store is how a store throws its state away — so a persistent
  instance's listeners outlive one HMR generation, which the H7 leak invariant (task 6.2)
  has to account for. See issue #19.
- **§11 H6 — the epoch is bumped even when re-activation fails.** A component holding an
  instance of a module that failed to come back is holding a disposed object either way;
  re-rendering surfaces that as a C8 error it can render, rather than as silently stale
  state. See issue #19.
- **§7.2 C7 vs §11 H4 — the lifetime of a module-owned `singleton`.** C7 says a `singleton`
  instance is disposed at "app/kernel teardown", which reads as *never* on module disposal.
  H4 says that on re-activation "every provider instance it registered is disposed and
  discarded **regardless of scope** — including `singleton`". Taken together with C2's
  record-identity caching these were not merely ambiguous but unsound: a module's providers
  thunk re-runs on re-activation and yields fresh `ProviderRecord` objects, so the cache
  missed and constructed a *second* app-lifetime instance while the first stayed cached and
  reachable forever. **Resolved in favour of H4:** a `singleton` registered by a module lives
  for that module's *activation* — deactivation disposes and discards it, re-activation
  constructs exactly one new one. `singleton` still means "one instance for as long as its
  provider is registered"; what changed is that C7's prose was written as if a module's
  providers were registered for the lifetime of the app, which A4 and H2 make untrue. Both
  scopes are disposed in one merged reverse-construction order. See issue #34.
- **§11 H5 — what a resolution graph edge's *consumer* is.** H5 says the
  container records "which module actually resolved which token from which
  provider". The obvious reading — C4's `requester`, the module the chain was
  started on behalf of — is wrong for the cascade: C4 propagates the
  *starting* module through every nested resolution, so
  `kernel.get(OrderServiceToken)` records only `app → orders/OrderService`
  and never records that `orders`' own instance was built out of a `payments`
  gateway. **Resolved:** the consumer is the owner of the record one level up
  the construction stack, falling back to the `requester` at the top of the
  stack (where it is ADR-2's `'app'` for a resolution started outside any
  module). The cascade needs "whose instances embed whose", which is the
  construction stack, not the resolution context. C4 itself is untouched.
  See issue #20.
- **§11 H5 — a contribution collection read through `getAll` records no edge
  to its contributors.** `ModuleContext.getAll` and `Container.getAll` take no
  requester by design (each contribution resolves on behalf of its own owner,
  C9), so a module that merely *reads* a collection is not attributable. That
  is accepted rather than fixed: the declared-`dependsOn` cascade never
  covered it either (a collection's consumer typically does not depend on its
  contributors — that is the point of C5), so H5's narrowing does not lose a
  guarantee that existed. C5's own reactivity (`subscribeAll`) is what keeps a
  collection fresh across a re-activation. `deps: [allOf(Token)]` *is*
  attributed, because it resolves inside a factory and therefore has a
  construction stack. See issue #20.
- **§11 H7 — "± the diff introduced by the edit" is not implementable as
  stated, and the issue's proposed refinement is vacuous.** Issue #20 proposed
  reporting when the post-cycle count exceeds the previous cycle's by more
  than "the number of registrations the new `init` performed". Those are the
  same number: teardown releases everything the module registered, so the
  post-cycle count *is* what the new `init` registered, and the condition
  reduces to "the previous cycle ended on a negative count". **Resolved:** the
  check measures the **residual** — the outstanding count for each module in
  the cascade *after the whole cascade has been disposed and before anything
  is re-activated* — and reports a violation exactly when it is positive. The
  baseline is structural (zero) rather than remembered, so an edit that
  legitimately adds or removes registrations moves the post-cycle count and
  never the residual. See `src/hmr/leak-check.ts` and issue #20.
- **§11 H3/H7 — `persistent: true` instances are not counted by the leak
  counters at all.** A preserved persistent instance is never disposed, so its
  acquire has no release on the HMR path, while an ordinary `deactivate` does
  dispose it and would produce a release with no acquire if only the HMR path
  were excluded. The count cannot balance either way, and the instance is not
  leaked — it is parked in the resolver and handed to its successor.
  **Resolved:** `instrumentRecords` skips `persistent` records entirely, so
  acquire and release stay paired on every path and H7 does not report a false
  leak, once per cycle forever, on H3's blessed pattern. H7's own text names
  only listener and effect counts, both of which remain fully covered. The
  `singleton` exclusion noted since #34 stays as it is, for the reasons in
  `src/testing/leak-counters.ts`. See issue #20.
- **§7.2 C6 — a plain `provide` that loses to an `override: true`.** C6 makes two `provide`
  calls for one token a fatal error and names `override: true` as the explicit escape, but
  did not say what happens to the *loser*. The implementation made it fatal, so the
  overridden module transitioned to `failed` during activation — meaning that mocking
  `payments/PaymentGateway` killed `payments`, which is acceptance criterion 7's exact
  scenario. **Resolved:** a plain `provide` for a token already held by an `override: true`
  record is **superseded, not rejected**; two *plain* provides remain fatal and still name
  both modules. Both registration orders now produce byte-identical registry state, and the
  superseded row is visible in `inspect()` as `overriddenBy`. See issue #37.
- **§13 B3 — "`import/no-cycle` runs across the workspace" needs two settings, not one, and
  the natural check for the first one passes while the rule is still dead.** The preset
  originally configured `createNodeResolver()`, which applies Node's algorithm and does not
  resolve `.ts`. Since `allowImportingTsExtensions: false` makes every internal import
  extensionless TypeScript, nothing resolved, `no-cycle` had no graph to walk, and it silently
  passed a planted two-file cycle for the whole of stage 7. Swapping in
  `createTypeScriptImportResolver` fixes resolution — and is **not sufficient**: `no-cycle`
  walks past the first hop through `ExportMap.for()`, which returns `null` for any path failing
  `hasValidExtension()`, whose default allowlist is `['.js', '.mjs', '.cjs']`. In that
  intermediate state `import-x/no-unresolved` is clean workspace-wide while the cycle probe
  still exits 0 — the most misleading possible reading. **Resolved:** both
  `import-x/resolver-next` (TypeScript-aware) and `import-x/extensions` are load-bearing, each
  verified by independent removal, and `no-unresolved` is enabled as the alarm for the resolver
  silently dying. The regression test lints real files through the real root config rather than
  using `RuleTester`: what broke was everything that must be true *before* the rule sees a
  graph. See issues #43 and #44.
- **§13 — the preset's package name.** §13 calls it `@app/eslint-config-modules`; it ships as
  `@ng-react/eslint-config-modules`, per ADR-8 (`@app/*` is the scope for *application* module
  packages, and a shared lint preset is not one). Cosmetic, recorded rather than fixed in the
  spec text. See PR #44.
- **§15 criterion 1 — the logout cascade it describes cannot happen on the graph it
  specifies.** The criterion asks for `deactivate(AuthModule)` to cascade "disposal of
  `orders` and `payments` dependents in reverse order", but the same criterion gives
  `payments` no dependency on `auth` (`orders` dependsOn `auth` and `payments`). A4 cascades
  to *dependents*, and `payments` is a dependency of `orders`, not a dependent of `auth`, so
  it stays `ready` after logout. **Resolved:** the demo asserts what actually happens
  (`orders` then `auth`, as an order and not as membership) and disposes `payments` through
  its own `deactivate`; the criterion's wording is wrong, not the implementation. Giving
  `payments` a dependency it does not need would have made the criterion look discharged
  while teaching the wrong model. See issue #23 and PR #45.
- **§3 M2 — "the import graph of contracts mirrors the module graph by construction" is not
  true once C5 contributions exist.** A contributing module imports the collection token from
  the declaring module's contract and correctly declares **no** `dependsOn` edge to it: a
  contribution is precisely the relationship that does not create one (that is what makes C5
  useful). In the demo, `payments` and `debug` both import `@app/auth/contract` for
  `DiagnosticPanelToken` with empty `dependsOn`. M2 holds for *dependency refs* — a typo is
  still a compile error and "find all references" still works — but the contract import graph
  is a **superset** of the module graph, not a mirror. Recorded rather than fixed; the same
  fact is why §15 criterion 1's cascade reads wrong. See PR #45.
- **§11 H2 — a hot block routed through an injected context is invisible to Vite.** Vite
  decides self-acceptance by lexically scanning source for `import.meta.hot.accept`, so the
  generated block's `hot.accept(cb)` — where `hot` is a parameter defaulted to
  `import.meta.hot`, which is what made it testable — never registers: every edit to a module
  file becomes a full page reload and `hotReplace` is never called. Measured with a real dev
  server (`page reload` for the shipped block; `hmr update` after adding a literal accept).
  Consequence: the accept call **must appear literally in the module's own source**, which
  settles issue #42 — no adapter indirection can satisfy a static scan.
  **Resolved:** the generated `module.ts` now carries a literal, top-level
  `if (import.meta.hot) { import.meta.hot.accept(cb) }`. That runs at module-evaluation
  time, before the composition root can hand the module a kernel, so what it registers is
  a **dispatcher** over a module-local list of callbacks; `acceptHotUpdate(kernel)`
  subscribes into it through `ModuleHotContext` — the same seam a non-Vite host passes in,
  so there is one mechanism and not two. The list holds callbacks, never a kernel: #41's
  rejection of an ambient "current kernel" stands, and two kernels in one process subscribe
  two callbacks that cannot observe each other. The re-arm forwards the `hot` argument it
  was *given*, not the context it resolved, because Vite clears the previous evaluation's
  callbacks when the fresh copy registers its own. Measured after the fix on the same demo
  app: five consecutive edits across `module.ts`, `providers.ts` and `lifecycle.ts` each
  produced `hmr update` and a `disposed → activating → ready` cycle for the module, with
  no page reload; twenty further consecutive edits produced twenty more. See issue #46.
- **§11 H2 / ADR-5 — `HmrAdapter` is the invalidate seam and nothing else.** The interface
  shipped with four members and the kernel called one. `accept` and `dispose` had no call
  site, and the evidence above makes `accept` **unusable** rather than merely unused: a
  static scan cannot see through an adapter, so acceptance can only ever be registered by
  the module's own source. **Resolved in favour of #42's option 2 (shrink):** `accept` and
  `dispose` are removed from `HmrAdapter` and from `ViteHotContext`, the generated module's
  direct `import.meta.hot` access is the documented blessed pattern for both bundlers
  (`module.hot` on Metro), and ADR-5's remaining claim — *no kernel code may name a
  bundler's hot API* — is unchanged and still true. The `KernelOptions.hmr` doc snippet
  that could not be written as shown is replaced by the emitted block itself. See issue #42.
- **§11 H3/H7 — what the demo app can and cannot discharge of acceptance criteria 3 and 4.**
  With the fix above, H3 was observed at the demo level: `payments`' `persistent: true`
  draft store held its state across three consecutive hot replacements (its conditional
  seed never re-ran). H7's *leak counters* were not observed and cannot be, because
  `LeakInvariantCheck` is constructed only when something installed counters for it to read
  — today only `createTestKernel` does, so a browser session of the demo app runs the H7
  check not at all, and "no leak warnings in the console" is vacuous rather than passing.
  Discharging criterion 4's leak half at the demo level needs a test-kernel-driven harness
  or a kernel option; task #24 owns it.
- **§15 criterion 10 / §6 — a lazy module cannot contribute the route that activates it.**
  §5.2 and §12 R3 together say route registration is an ordinary C5 contribution and the root
  navigator is `useServiceAll(RouteConfigToken)`. But a contribution is registered when its
  module's `providers` thunk runs, which is **at activation** (C3/D1) — so a route contributed
  by `orders` exists only while `orders` is already running, and a table built solely from
  feature-module contributions can never hold the route whose job is to *trigger* the first
  activation. **Resolved, and no kernel primitive is missing:** §6 already says where the
  trigger comes from — "the navigation module activates a module when a **parent route config**
  maps a matched path to its ref" — so entry routes belong to a module that is already active.
  The demo gives them to an app-shell module (`apps/react/src/shell/`, §3's "a folder treated as
  one"), and each feature module contributes its own child routes once up. §15.10's silence on
  this is what misleads; the model is right. See issue #24 and `docs/acceptance.md`.
- **§15 criterion 5 — its two halves cannot both be true of criterion 1's graph.** It asks that
  deleting a provider `orders` depends on produce "full chain **plus** actionable suggestion",
  but C8 appends the suggestion *only* when the failing token's module is registered and **not**
  in the requester's `dependsOn` — and §15.1 requires `orders` to declare `payments`. On that
  graph the deletion correctly yields the chain and no suggestion: the dependency is already
  declared, so "add its ref to `dependsOn`" would not be actionable. C8's own quoted example is
  reachable only from a graph where `orders` does not declare `payments`. **Resolved:** both are
  asserted, and neither is presented as the whole criterion. See issue #24.
- **§15 criterion 4 — `payments` had no `singleton` provider, and since #34 the distinction it
  draws no longer exists.** The criterion says "a `singleton` provider of `payments`"; both of
  that module's providers were `module`-scoped. Since #34 a module-owned `singleton` lives for
  its module's *activation* and H4 discards both scopes on a hot replace, so the two are
  indistinguishable for a module-owned provider. **Resolved:** `payments/PaymentGateway` is
  declared `singleton` so the criterion is literally checkable; it is a naming change, not a
  behaviour change, and the `module`-scoped half of `persistent: true` remains covered by the
  draft store. See issue #24.
- **§12 R4 — `createTestKernel(...).get(token, requester)` silently ignores `requester`.** The
  test kernel delegates as `get: (token) => kernel.get(token)`, dropping the optional second
  parameter that `TestKernel extends Kernel` promises and that a real `createKernel` honours.
  `MODULE_ID` (C4) therefore resolves to ADR-2's `'app'` in any test that passes one, and a C8
  suggestion built from it names the wrong module. Found while writing the acceptance suite and
  **deliberately not fixed there**: criterion 10 forbids changing `packages/ng-react/src/`, and
  a kernel edit smuggled into the PR that exists to prove the kernel needed none would be worse
  than the bug. **Resolved:** the argument is forwarded, and three differential tests — the same
  descriptors resolved once through `createKernel` and once through `createTestKernel`, with the
  real kernel as the oracle — pin C4's `MODULE_ID` across four differently-typed tokens and both
  directions of the C8 suggestion. The delegations beside it (`status`, `subscribeStatus`,
  `getAll`, `subscribeAll`, `ownerOf`, `epochOf`, `bumpEpoch`, `subscribeEpoch`, `inspect`,
  `activate`, `whenStartupComplete`, `deactivate`, `hotReplace`, `retry`) were audited in the
  same pass and all forward their full signature. See #24 and #49.
- **§11 H2 / ADR-5 — a separate boolean duplicated a capability the kernel already derives.**
  The kernel only guards invalidation with `this.hmr.invalidate?.(…)`; the boolean was declared and
  written but never read. **Resolved:** remove it. Optional `invalidate` is the sole
  capability signal, and `{}` is both `createNoopHmrAdapter()` and the Metro adapter shape. An
  adapter with `invalidate` continues to receive escalation calls without any redundant kernel
  guard. See issue #58.
- **§11 H2 — the generated hot block's Metro no-op is now measured rather than reasoned, and the
  mechanism is not the one the comment predicted.** The portability note on each generated
  `acceptHotUpdate` says Metro "does not have" `import.meta.hot`. Under Expo SDK 57 that is true
  but not by absence: `babel-preset-expo`'s `import-meta-transform-plugin` rewrites every
  `import.meta` to `globalThis.__ExpoImportMetaRegistry`, and `expo/src/winter/ImportMetaRegistry.ts`
  exposes exactly one member, `url`. So `import.meta.hot` is `undefined` rather than a syntax
  error, the literal self-accept block never runs, `selfAccept` stays `undefined`, and
  `acceptHotUpdate` returns at its `context === undefined` guard. **The comment's two supporting
  claims are both confirmed on the emitted bundle**: (a) Metro's `module` *is* shadowed — in the
  iOS bundle `@app/auth/module` is wrapped as `__d(function(g,r,i,a,_m,e,d){…})`, its `module`
  parameter renamed to `_m` because the file exports a binding of that name; (b) Metro's
  self-accept callback takes no arguments — `metro-runtime/src/polyfills/require.js` calls
  `hot._acceptCallback()` with none, so a shim forwarding `module.hot.accept(cb)` would hand
  `undefined` to the callback and silently do nothing. **No shim is shipped.** Under Metro the
  only file that could hold one is the composition root, and a self-accepting composition root is
  re-evaluated on update — constructing a second kernel and breaking R1's "exactly one
  `<AppKernel>` per kernel", which is worse than the reload it replaces. Per-module Metro
  self-acceptance needs a Metro-side entry file per module or a transform, and the generator emits
  neither. See issue #53.
- **§17 (tooling) — Metro needs no configuration at all for this workspace, and `apps/native` has
  no `metro.config.js`.** Issue #53 named "Metro + pnpm workspace + TypeScript-source `exports`
  maps" as its main integration risk and expected a `metro.config.js` enabling package exports and
  teaching Metro about the workspace. None of it is needed under Expo SDK 57 / Metro 0.84:
  `unstable_enablePackageExports` is `true` in `metro-config`'s own defaults, `unstable_enableSymlinks`
  has been the default since 0.79, and `expo/metro-config`'s `getDefaultConfig` already infers the
  monorepo's `watchFolders` and `nodeModulesPaths`. Measured by writing the file, removing each
  setting in turn, and then removing the file entirely — every variant bundles 1350 modules, the
  last with `--clear` against a cold cache. The file was deleted rather than kept as documentation:
  a configuration that looks load-bearing and does nothing is the shape of check this repository
  has been bitten by three times (#43's inert `no-cycle`, #46's non-self-accepting hot block, and
  #52's silently-ignored root-level Vitest `resolve`). `babel.config.js` is the same case and is
  likewise absent — with and without it the emitted Hermes bundle is byte-for-byte the same size.
  **Metro is therefore confirmed as the "free" resolver #52 predicted**: it is the sixth consumer
  of the platform-extension decision and the only one that needed no vocabulary of its own. See
  issue #53.
