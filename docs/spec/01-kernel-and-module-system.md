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

The descriptor is created with `defineModule` and is the complete kernel-facing surface of a module. It has exactly six fields; each future addition is a permanent contract and requires justification against principle 1.

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

**A3.** `init` may be async. The kernel imposes a configurable timeout per module (default 10 s); on timeout the failure policy (section 10) applies. Eager critical modules' `init` completion gates splash-screen dismissal; this hook point is specified here, its use by a startup orchestration service in spec 05.

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

**F2.** If `critical: true` and the failure occurs during startup activation, startup fails visibly (dev: red screen with the module id and error; prod: configurable fatal handler). Critical modules are expected to be few.

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
