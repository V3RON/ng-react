# ng-react

**ng-react brings Angular-style modules and dependency injection to React and React Native.**

React gives you components, but nothing to organize the code *behind* them: services get
wired together by hand, singletons leak across the app, and there's no clean way to load a
feature only when it's needed. ng-react fills that gap. You describe your app as
**modules** with explicit dependencies, register **providers** for the things they expose,
and let a small **kernel** activate them in the right order — lazily, where declared. Modules
can depend on each other but never reach into each other's internals, so boundaries stay
real as the app grows. Every provider is resolved through a typed **token** instead of a
concrete import, so swapping an implementation — for tests, for a feature flag, for a
platform variant — never means editing the consumer. It's fast to hot-reload, easy to test
without a renderer, and has zero decorators or reflection to fight with your bundler.

## Getting started

Install the kernel package:

```bash
npm install @ng-react/kernel
```

Wrap your app in the kernel provider:

```tsx
import { AppKernel } from '@ng-react/kernel';

export function App() {
  return (
    <AppKernel modules={[ordersModule, authModule]}>
      <YourApp />
    </AppKernel>
  );
}
```

Define a module — its public contract, what it provides, and how it's wired up:

```ts
// contract.ts — the module's public surface
import { createToken, moduleRef } from '@ng-react/kernel';

export const OrdersModule = moduleRef('orders');
export interface OrderService { place(amountMinor: number): Promise<string> }
export const OrderServiceToken = createToken<OrderService>('orders/OrderService');
```

```ts
// providers.ts — how the service is built, and what it needs
import { provide } from '@ng-react/kernel';
import { OrderServiceToken } from './contract';

export const providers = [
  provide(OrderServiceToken, {
    scope: 'singleton',
    deps: [PaymentGatewayToken],
    factory: (gateway) => createOrderService(gateway),
  }),
];
```

```ts
// module.ts — ties the contract and providers together for the kernel
import { defineModule } from '@ng-react/kernel';
import { OrdersModule } from './contract';

export const ordersModule = defineModule({
  id: OrdersModule,
  load: 'lazy',
  providers: () => import('./providers').then((m) => m.providers),
});
```

Then use it from a component — no prop drilling, no manual wiring:

```tsx
import { useService } from '@ng-react/kernel';
import { OrderServiceToken } from './contract';

export function PlaceOrderButton() {
  const orders = useService(OrderServiceToken);
  return <button onClick={() => void orders.place(2500)}>Place order</button>;
}
```

## The building blocks

- **Module** — a self-contained unit of your app (a feature, a domain), with its own
  providers and lifecycle. Modules declare what they depend on and load eagerly or lazily.
- **Token** — a typed identifier for something a module provides. Consumers ask for a
  token, never a concrete class or file, so implementations can be swapped freely.
- **Provider** — the recipe for building the thing behind a token: its scope
  (`singleton`, `module`, or `transient`) and its own dependencies, also expressed as tokens.
- **Kernel** — the runtime that activates modules in dependency order, resolves tokens,
  and tears everything down cleanly when a module deactivates.
