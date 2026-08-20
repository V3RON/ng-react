import { describe, expect, it } from 'vitest';
import {
  DuplicateProviderError,
  DuplicateRegistrationError,
  InvalidDescriptorError,
  ProviderKindConflictError,
} from '../errors';
import { contribute, provide } from '../provider';
import { createToken } from '../token';
import { ProviderRegistry } from './registry';

// Realistic, differently-typed domain shapes — deliberately not
// `Token<unknown>`. AGENTS.md §9 (ADR-10) now names exactly this weakening
// ("empty arrays", "Token<unknown> everywhere") as a reject reason: it is
// what let a real invariance defect in `Token<T>`/`ProviderRecord<T>`
// survive all of stage 1 undetected. A registry test suite that only ever
// registers `Token<unknown>` proves nothing about whether `register()` can
// actually hold the heterogeneous, concretely-typed collection a real
// module's `providers.ts` produces — so every token below carries its own
// distinct interface, the way `orders/OrderService` and `orders/AnalyticsSink`
// do in the spec's own §7.2 example.
interface OrderService {
  place(): Promise<string>;
}
interface RouteConfig {
  readonly path: string;
}
interface PaymentGateway {
  charge(cents: number): Promise<void>;
}
interface AnalyticsSink {
  track(event: string): void;
}
interface Thing {
  readonly value: number;
}

function orderService(): OrderService {
  return { place: async () => 'order-1' };
}
function routeConfig(path: string): RouteConfig {
  return { path };
}
function paymentGateway(): PaymentGateway {
  return { charge: async () => {} };
}
function analyticsSink(): AnalyticsSink {
  return { track: () => {} };
}

describe('ProviderRegistry', () => {
  describe('C9: provenance is kernel-assigned', () => {
    it('assigns owner from the register() argument, never from the record', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      const record = provide(token, { factory: orderService });

      registry.register('orders', [record]);

      const registered = registry.getProvider(token);
      expect(registered?.owner).toBe('orders');
      expect(registered?.record).toBe(record);
      // ProviderRecord itself never carries an owner/module field (pinned
      // again here, not just in provider.test.ts, because C9 is precisely
      // about the *registry* being the sole source of truth for it).
      expect(record).not.toHaveProperty('owner');
      expect(record).not.toHaveProperty('module');
    });

    it('assigns the same owner to every record in one register() call, regardless of kind', () => {
      const registry = new ProviderRegistry();
      const provided = createToken<OrderService>('orders/OrderService');
      const contributed = createToken<RouteConfig>('orders/RouteConfig');

      registry.register('orders', [
        provide(provided, { factory: orderService }),
        contribute(contributed, { factory: () => routeConfig('/orders') }),
      ]);

      expect(registry.getProvider(provided)?.owner).toBe('orders');
      expect(registry.getContributions(contributed)[0]?.owner).toBe('orders');
    });

    it('holds a heterogeneous batch of concretely-typed provide() and contribute() records (ADR-10)', () => {
      // The array literal below is exactly the shape that did not
      // type-check before ADR-10: differently-typed ProviderRecords in one
      // array passed to a `readonly AnyProviderRecord[]` parameter.
      const registry = new ProviderRegistry();
      const orderServiceToken = createToken<OrderService>('orders/OrderService');
      const analyticsSinkToken = createToken<AnalyticsSink>('orders/AnalyticsSink');
      const paymentGatewayToken = createToken<PaymentGateway>('payments/PaymentGateway');

      registry.register('orders', [
        provide(orderServiceToken, { factory: orderService }),
        contribute(analyticsSinkToken, { factory: analyticsSink }),
      ]);
      registry.register('payments', [provide(paymentGatewayToken, { factory: paymentGateway })]);

      expect(registry.getProvider(orderServiceToken)?.owner).toBe('orders');
      expect(registry.getContributions(analyticsSinkToken)[0]?.owner).toBe('orders');
      expect(registry.getProvider(paymentGatewayToken)?.owner).toBe('payments');
    });
  });

  describe('C6: duplicate provide()', () => {
    it('rejects a second unconditional provide() for the same token, naming both modules', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      registry.register('orders', [provide(token, { factory: orderService })]);

      let caught: unknown;
      try {
        registry.register('billing', [provide(token, { factory: orderService })]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DuplicateProviderError);
      // Exact string per issue #11 — asserted verbatim (AGENTS.md: "errors
      // are a feature", assert the exact string, no snapshot testing).
      expect((caught as Error).message).toBe(
        "Token 'orders/OrderService' is already provided by 'orders'; 'billing' cannot provide it again. " +
          'Use provide(token, { override: true, ... }) in the composition root or a test if this is intentional.',
      );
    });

    it('rejects a duplicate provide() within the same register() call (self-conflict)', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');

      expect(() =>
        registry.register('orders', [provide(token, { factory: orderService }), provide(token, { factory: orderService })]),
      ).toThrow(DuplicateProviderError);
    });
  });

  describe('C6: override precedence is order-independent', () => {
    it('order A — plain registered first, override registered second: override wins', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');

      registry.register('orders', [provide(token, { factory: orderService })]);
      registry.register('billing', [provide(token, { override: true, factory: orderService })]);

      const registered = registry.getProvider(token);
      expect(registered?.owner).toBe('billing');
      expect(registered?.record.override).toBe(true);
      expect(registry.inspect().providers).toContainEqual({
        tokenLabel: 'orders/OrderService',
        kind: 'provide',
        scope: 'singleton',
        owner: 'billing',
        override: true,
      });
    });

    it('order B — override registered first, plain registered second: override still wins (later plain is rejected)', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');

      registry.register('billing', [provide(token, { override: true, factory: orderService })]);

      expect(() => registry.register('orders', [provide(token, { factory: orderService })])).toThrow(
        DuplicateProviderError,
      );

      // The override registration from 'billing' is still the effective
      // provider — the later plain registration never took effect.
      const registered = registry.getProvider(token);
      expect(registered?.owner).toBe('billing');
      expect(registered?.record.override).toBe(true);
    });

    it('registering override: true when nothing exists yet succeeds without error', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');

      expect(() =>
        registry.register('orders', [provide(token, { override: true, factory: orderService })]),
      ).not.toThrow();
      expect(registry.getProvider(token)?.owner).toBe('orders');
    });
  });

  describe('C5: kind conflicts', () => {
    it('rejects provide() on a token that already has contributions, naming both modules and kinds', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('orders', [contribute(token, { factory: () => routeConfig('/orders') })]);

      let caught: unknown;
      try {
        registry.register('billing', [provide(token, { factory: () => routeConfig('/billing') })]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ProviderKindConflictError);
      expect((caught as Error).message).toBe(
        "Token 'nav/RouteConfig': 'orders' registered it via contribute(), but 'billing' is trying to provide() it. " +
          'provide() and contribute() cannot be mixed for the same token.',
      );
    });

    it('rejects contribute() on a token that was provide()d, naming both modules and kinds', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      registry.register('orders', [provide(token, { factory: orderService })]);

      let caught: unknown;
      try {
        registry.register('billing', [contribute(token, { factory: orderService })]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ProviderKindConflictError);
      expect((caught as Error).message).toBe(
        "Token 'orders/OrderService': 'orders' registered it via provide(), but 'billing' is trying to contribute() it. " +
          'provide() and contribute() cannot be mixed for the same token.',
      );
    });

    it('a batch mixing provide() and contribute() for the same token conflicts with itself', () => {
      const registry = new ProviderRegistry();
      const token = createToken<AnalyticsSink>('orders/Mixed');

      expect(() =>
        registry.register('orders', [
          contribute(token, { factory: analyticsSink }),
          provide(token, { factory: analyticsSink }),
        ]),
      ).toThrow(ProviderKindConflictError);
    });

    it('does not reject provide() on an unrelated token, nor a second contribute() on the same token', () => {
      const registry = new ProviderRegistry();
      const routeToken = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('orders', [contribute(routeToken, { factory: () => routeConfig('/orders') })]);

      expect(() =>
        registry.register('billing', [contribute(routeToken, { factory: () => routeConfig('/billing') })]),
      ).not.toThrow();
      expect(registry.getContributions(routeToken)).toHaveLength(2);
    });
  });

  describe('registration atomicity', () => {
    it('rolls back the whole batch when a later record in it fails validation', () => {
      const registry = new ProviderRegistry();
      const okToken = createToken<OrderService>('orders/OrderService');
      const conflictToken = createToken<RouteConfig>('orders/RouteConfig');
      registry.register('nav', [contribute(conflictToken, { factory: () => routeConfig('/nav') })]);

      expect(() =>
        registry.register('orders', [
          provide(okToken, { factory: orderService }),
          provide(conflictToken, { factory: () => routeConfig('/conflict') }),
        ]),
      ).toThrow(ProviderKindConflictError);

      // okToken must NOT have been committed even though it appeared first
      // in the batch and would have been valid on its own.
      expect(registry.getProvider(okToken)).toBeUndefined();
      expect(registry.hasToken(okToken)).toBe(false);
      // A retry of just the module (after fixing the conflicting record)
      // must be possible — i.e. the failed attempt must not have marked
      // 'orders' as registered.
      expect(() => registry.register('orders', [provide(okToken, { factory: orderService })])).not.toThrow();
    });
  });

  describe('idempotence / re-registration', () => {
    it('throws DuplicateRegistrationError when registering the same module id twice without withdraw', () => {
      const registry = new ProviderRegistry();
      registry.register('orders', []);

      expect(() => registry.register('orders', [])).toThrow(DuplicateRegistrationError);
    });

    it('allows re-registration after withdraw (the HMR path)', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      const v1Factory = (): OrderService => orderService();
      const v2Factory = (): OrderService => orderService();
      registry.register('orders', [provide(token, { factory: v1Factory })]);

      registry.withdraw('orders');

      expect(() => registry.register('orders', [provide(token, { factory: v2Factory })])).not.toThrow();
      // The re-activated provider's factory is the new (v2) one, not v1 —
      // proves withdraw() actually replaced the entry rather than merging.
      expect(registry.getProvider(token)?.record.factory).toBe(v2Factory);
    });

    it('rejects a non-string or empty module id', () => {
      const registry = new ProviderRegistry();
      expect(() => registry.register('', [])).toThrow(InvalidDescriptorError);
      // @ts-expect-error -- deliberately passing a non-string to test the runtime guard.
      expect(() => registry.register(42, [])).toThrow(InvalidDescriptorError);
    });
  });

  describe('withdraw()', () => {
    it('removes every provider and contribution owned by the module and returns the affected tokens', () => {
      const registry = new ProviderRegistry();
      const ownToken = createToken<OrderService>('orders/OrderService');
      const sharedToken = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('orders', [
        provide(ownToken, { factory: orderService }),
        contribute(sharedToken, { factory: () => routeConfig('/orders') }),
      ]);
      registry.register('billing', [contribute(sharedToken, { factory: () => routeConfig('/billing') })]);

      const affected = registry.withdraw('orders');

      expect([...affected].sort((a, b) => a.label.localeCompare(b.label))).toEqual(
        [ownToken, sharedToken].sort((a, b) => a.label.localeCompare(b.label)),
      );
      expect(registry.getProvider(ownToken)).toBeUndefined();
      expect(registry.hasToken(ownToken)).toBe(false);
      // billing's contribution to the shared token must survive.
      const remaining = registry.getContributions(sharedToken);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.owner).toBe('billing');
    });

    it('withdrawing an unknown module is a no-op that returns an empty set', () => {
      const registry = new ProviderRegistry();
      const affected = registry.withdraw('never-registered');
      expect(affected.size).toBe(0);
    });

    it('withdrawing the same module twice is a no-op the second time', () => {
      const registry = new ProviderRegistry();
      const token = createToken<OrderService>('orders/OrderService');
      registry.register('orders', [provide(token, { factory: orderService })]);

      registry.withdraw('orders');
      const second = registry.withdraw('orders');

      expect(second.size).toBe(0);
    });
  });

  describe('getProvider / getContributions / hasToken / ownerOf', () => {
    it('getProvider returns undefined for an unregistered token', () => {
      const registry = new ProviderRegistry();
      expect(registry.getProvider(createToken<OrderService>('orders/Missing'))).toBeUndefined();
    });

    it('getContributions returns an empty array for a token with no contributions', () => {
      const registry = new ProviderRegistry();
      expect(registry.getContributions(createToken<RouteConfig>('orders/Missing'))).toEqual([]);
    });

    it('getContributions preserves registration order', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('a', [contribute(token, { factory: () => routeConfig('/a') })]);
      registry.register('b', [contribute(token, { factory: () => routeConfig('/b') })]);
      registry.register('c', [contribute(token, { factory: () => routeConfig('/c') })]);

      expect(registry.getContributions(token).map((entry) => entry.owner)).toEqual(['a', 'b', 'c']);
    });

    it('hasToken is true for both a provided and a contributed token, false otherwise', () => {
      const registry = new ProviderRegistry();
      const provided = createToken<OrderService>('orders/OrderService');
      const contributed = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('orders', [
        provide(provided, { factory: orderService }),
        contribute(contributed, { factory: () => routeConfig('/orders') }),
      ]);

      expect(registry.hasToken(provided)).toBe(true);
      expect(registry.hasToken(contributed)).toBe(true);
      expect(registry.hasToken(createToken<OrderService>('orders/Unknown'))).toBe(false);
    });

    it('ownerOf returns the provider owner, and undefined for a contribution-only or unknown token', () => {
      const registry = new ProviderRegistry();
      const provided = createToken<OrderService>('orders/OrderService');
      const contributed = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('orders', [
        provide(provided, { factory: orderService }),
        contribute(contributed, { factory: () => routeConfig('/orders') }),
      ]);

      expect(registry.ownerOf(provided)).toBe('orders');
      expect(registry.ownerOf(contributed)).toBeUndefined();
      expect(registry.ownerOf(createToken<OrderService>('orders/Unknown'))).toBeUndefined();
    });
  });

  describe('C5: getContributions collection identity (task 2.3 change-detection)', () => {
    // Task 2.3's reactive contribution collections need to tell "unchanged"
    // from "changed" cheaply, by comparing the array reference they cached
    // last time against the one a fresh getContributions() call returns.
    // That only works if the registry gives out a *stable* reference while
    // nothing has changed and a *fresh* one the instant something has —
    // which in turn requires the stored array to never be mutated in place
    // (a mutate-in-place bug here would make every comparison see the same
    // object and silently disable reactivity, with no failing test to catch
    // it — see the copy-on-write comment in registry.ts's register()).

    it('returns a new array reference when a contribution is added, and the stale snapshot is unaffected', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('a', [contribute(token, { factory: () => routeConfig('/a') })]);

      const before = registry.getContributions(token);
      expect(before).toHaveLength(1);

      registry.register('b', [contribute(token, { factory: () => routeConfig('/b') })]);
      const after = registry.getContributions(token);

      expect(Object.is(before, after)).toBe(false);
      expect(after).toHaveLength(2);
      // The stale snapshot must still report its length at the time it was
      // taken — proof the registry didn't mutate the array `before` still
      // points at.
      expect(before).toHaveLength(1);
    });

    it('returns a stable reference when nothing changed', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('a', [contribute(token, { factory: () => routeConfig('/a') })]);

      const first = registry.getContributions(token);
      const second = registry.getContributions(token);

      expect(Object.is(first, second)).toBe(true);
    });

    it('returns a new array reference after a withdraw() removes a contribution', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('a', [contribute(token, { factory: () => routeConfig('/a') })]);
      registry.register('b', [contribute(token, { factory: () => routeConfig('/b') })]);

      const before = registry.getContributions(token);
      registry.withdraw('b');
      const after = registry.getContributions(token);

      expect(Object.is(before, after)).toBe(false);
      expect(before).toHaveLength(2);
      expect(after).toHaveLength(1);
    });

    it('the returned contribution array is frozen, both when non-empty and when empty', () => {
      const registry = new ProviderRegistry();
      const token = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('a', [contribute(token, { factory: () => routeConfig('/a') })]);

      const populated = registry.getContributions(token);
      expect(Object.isFrozen(populated)).toBe(true);
      expect(() => (populated as unknown[]).push({})).toThrow(TypeError);

      const empty = registry.getContributions(createToken<RouteConfig>('nav/Missing'));
      expect(Object.isFrozen(empty)).toBe(true);
    });
  });

  describe('findModuleByTokenLabelPrefix (C8 suggestion support)', () => {
    it('returns the module id when the label prefix is a known module', () => {
      const registry = new ProviderRegistry();
      registry.setKnownModules(['payments', 'orders']);
      expect(registry.findModuleByTokenLabelPrefix('payments/PaymentGateway')).toBe('payments');
    });

    it('returns undefined when the prefix is not a known module, even if it looks module-shaped', () => {
      const registry = new ProviderRegistry();
      registry.setKnownModules(['payments']);
      expect(registry.findModuleByTokenLabelPrefix('unknown/Thing')).toBeUndefined();
    });

    it('returns undefined for a label with no "/" or an empty prefix', () => {
      const registry = new ProviderRegistry();
      registry.setKnownModules(['payments']);
      expect(registry.findModuleByTokenLabelPrefix('kernel/MODULE_ID')).toBeUndefined();
      expect(registry.findModuleByTokenLabelPrefix('NoSlash')).toBeUndefined();
      expect(registry.findModuleByTokenLabelPrefix('/LeadingSlash')).toBeUndefined();
    });

    it('setKnownModules replaces the previous set rather than merging with it', () => {
      const registry = new ProviderRegistry();
      registry.setKnownModules(['payments']);
      registry.setKnownModules(['orders']);
      expect(registry.findModuleByTokenLabelPrefix('payments/PaymentGateway')).toBeUndefined();
      expect(registry.findModuleByTokenLabelPrefix('orders/OrderService')).toBe('orders');
    });
  });

  describe('G3: inspect() is deterministic', () => {
    it('produces identical output regardless of module registration order', () => {
      const ordersProvided = createToken<OrderService>('orders/OrderService');
      const paymentsProvided = createToken<PaymentGateway>('payments/PaymentGateway');
      const routeContributed = createToken<RouteConfig>('nav/RouteConfig');

      const forward = new ProviderRegistry();
      forward.register('orders', [
        provide(ordersProvided, { factory: orderService }),
        contribute(routeContributed, { factory: () => routeConfig('/orders') }),
      ]);
      forward.register('payments', [provide(paymentsProvided, { factory: paymentGateway })]);
      forward.register('nav', [contribute(routeContributed, { factory: () => routeConfig('/nav') })]);

      const backward = new ProviderRegistry();
      backward.register('nav', [contribute(routeContributed, { factory: () => routeConfig('/nav') })]);
      backward.register('payments', [provide(paymentsProvided, { factory: paymentGateway })]);
      backward.register('orders', [
        contribute(routeContributed, { factory: () => routeConfig('/orders') }),
        provide(ordersProvided, { factory: orderService }),
      ]);

      expect(forward.inspect()).toEqual(backward.inspect());
    });

    it('sorts providers by token label then owner, and modules by module id', () => {
      const registry = new ProviderRegistry();
      const sharedToken = createToken<RouteConfig>('nav/RouteConfig');
      registry.register('zeta', [contribute(sharedToken, { factory: () => routeConfig('/zeta') })]);
      registry.register('alpha', [
        contribute(sharedToken, { factory: () => routeConfig('/alpha') }),
        provide(createToken<Thing>('alpha/Thing'), { factory: () => ({ value: 1 }) }),
      ]);

      const snapshot = registry.inspect();

      expect(snapshot.providers.map((row) => `${row.tokenLabel}:${row.owner}`)).toEqual([
        'alpha/Thing:alpha',
        'nav/RouteConfig:alpha',
        'nav/RouteConfig:zeta',
      ]);
      expect(snapshot.modules.map((row) => row.moduleId)).toEqual(['alpha', 'zeta']);
    });

    it('includes a module registered with zero providers in the per-module list', () => {
      const registry = new ProviderRegistry();
      registry.register('empty', []);

      const snapshot = registry.inspect();
      expect(snapshot.modules).toEqual([{ moduleId: 'empty', tokenLabels: [] }]);
    });

    it('returns a frozen snapshot', () => {
      const registry = new ProviderRegistry();
      const snapshot = registry.inspect();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.providers)).toBe(true);
      expect(Object.isFrozen(snapshot.modules)).toBe(true);
    });
  });
});
