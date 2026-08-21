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

---

## What works today

Stages 1–8 are merged: the kernel, the boundary lint preset, the module generator, a
four-module demo app, and a proof-of-concept navigation module built on public primitives
only. `docs/acceptance.md` maps every one of spec 01 §15's ten acceptance criteria to the
test that proves it — and marks the two that are only partially covered, with the reason.

- **Modules** — `defineModule` descriptors with seven fields, typed `dependsOn` refs, and
  `eager` / `lazy` load strategies. Nothing in a module's implementation is evaluated before
  its activation trigger.
- **DI** — three flat scopes (`singleton`, `module`, `transient`), no injector tree,
  explicit token arrays, kernel-assigned provenance, and multi-provider `contribute`
  collections that are reactive.
- **Lifecycle** — `init` and `dispose` only; `ctx.on` / `ctx.effect` make teardown structural.
  `deactivate` cascades to dependents in reverse topological order.
- **Failure policy** — critical failures fail startup visibly; non-critical ones are
  quarantined with their providers withdrawn, and every error is routed to contributed
  `ErrorSinkToken` sinks.
- **HMR** — editing a module's lifecycle, providers or services re-activates only the
  modules that actually consumed something from it, carries `persistent: true` store state
  across, and re-renders mounted components against the fresh instances. No page reload.
- **React** — `<AppKernel>`, `useService`, `useServiceOptional`, `useServiceAll`, `useModule`.
- **Testing** — `createTestKernel` runs in a plain Node environment with no React renderer,
  with provider overrides and listener/effect leak counters.
- **Boundaries** — package `exports` maps plus `@ng-react/eslint-config-modules`, which
  rejects cross-module deep imports, non-allowlisted contract exports, `override: true`
  inside a module package, and dependency cycles.

Not yet: the event bus, slots, platform services, and the real navigation module (specs
02–06). `packages/nav` is a proof of concept for criterion 10, not spec 03.

## Usage

Define a module's contract — types, tokens, and exactly one module ref, and nothing else:

```ts
// @app/orders — src/contract.ts
import { createToken, moduleRef } from '@ng-react/kernel';

export const OrdersModule = moduleRef('orders');
export interface OrderService { place(amountMinor: number): Promise<string> }
export const OrderServiceToken = createToken<OrderService>('orders/OrderService');
```

Provide the service, declaring its dependencies as tokens (no reflection, ever):

```ts
// @app/orders — src/providers.ts
import { provide, MODULE_ID } from '@ng-react/kernel';
import { PaymentGatewayToken } from '@app/payments/contract';
import { OrderServiceToken } from './contract';

export const providers = [
  provide(OrderServiceToken, {
    scope: 'singleton',
    deps: [PaymentGatewayToken, MODULE_ID],
    factory: (gateway, requester) => createOrderService(gateway, requester),
  }),
];
```

Describe the module to the kernel — statically, with thunks, so `lazy` means something:

```ts
// @app/orders — src/module.ts
import { defineModule } from '@ng-react/kernel';
import { AuthModule } from '@app/auth/contract';
import { OrdersModule } from './contract';

export const module = defineModule({
  id: OrdersModule,
  dependsOn: [AuthModule],
  load: 'lazy',
  critical: false,
  providers: () => import('./providers').then((m) => m.providers),
  init: (ctx) => import('./lifecycle').then((m) => m.init(ctx)),
});
```

Consume it from a component. `useService` returns the same instance across renders, and
re-resolves by itself when the owning module is hot-replaced:

```tsx
import { useService } from '@ng-react/kernel';
import { OrderServiceToken } from '@app/orders/contract';

export function PlaceOrderButton() {
  const orders = useService(OrderServiceToken);
  return <button onClick={() => void orders.place(2500)}>Place order</button>;
}
```

`pnpm create-module <id>` emits all of the above, plus a `createTestKernel` test and the
HMR hot block.
