import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineModule } from './define-module';
import type { DefineModuleInput, ModuleDescriptor } from './define-module';
import { InvalidDescriptorError } from './errors';
import { moduleRef } from './module-ref';
import type { ModuleRef } from './module-ref';

describe('defineModule', () => {
  it('D2: defineModule rejects a string id at runtime and at type level', () => {
    expect(() =>
      defineModule({
        // @ts-expect-error -- id must be a ModuleRef, not a bare string (D2).
        id: 'orders',
      }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      defineModule({
        // @ts-expect-error -- id must be a ModuleRef, not a bare string (D2).
        id: 'orders',
      }),
    ).toThrow(/ModuleRef/);

    expectTypeOf<DefineModuleInput['id']>().not.toEqualTypeOf<string>();
  });

  it('D2: defineModule() never re-states the module id string; id is taken from the ref', () => {
    const OrdersModule = moduleRef('orders');
    const descriptor = defineModule({ id: OrdersModule });
    expect(descriptor.id).toBe(OrdersModule);
    expect(descriptor.id.id).toBe('orders');
  });

  it('D3: dependsOn rejects a non-ref element', () => {
    const OrdersModule = moduleRef('orders');
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- dependsOn elements must be ModuleRefs (D3).
        dependsOn: ['payments'],
      }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- dependsOn elements must be ModuleRefs (D3).
        dependsOn: ['payments'],
      }),
    ).toThrow(/dependsOn\[0\] is not a ModuleRef/);
  });

  it('D3: dependsOn rejects self-dependency', () => {
    const OrdersModule = moduleRef('orders');
    expect(() => defineModule({ id: OrdersModule, dependsOn: [OrdersModule] })).toThrow(InvalidDescriptorError);
    expect(() => defineModule({ id: OrdersModule, dependsOn: [OrdersModule] })).toThrow(/depends on itself|own ref/);
  });

  it('D3: dependsOn rejects a duplicate ref', () => {
    const OrdersModule = moduleRef('orders');
    const AuthModule = moduleRef('auth');
    expect(() => defineModule({ id: OrdersModule, dependsOn: [AuthModule, AuthModule] })).toThrow(
      InvalidDescriptorError,
    );
    expect(() => defineModule({ id: OrdersModule, dependsOn: [AuthModule, AuthModule] })).toThrow(/duplicate/);
  });

  it('D3: dependsOn defaults to an empty array', () => {
    const OrdersModule = moduleRef('orders');
    const descriptor = defineModule({ id: OrdersModule });
    expect(descriptor.dependsOn).toEqual([]);
  });

  it('D3: dependsOn accepts distinct refs, in the order given', () => {
    const OrdersModule = moduleRef('orders');
    const AuthModule = moduleRef('auth');
    const PaymentsModule = moduleRef('payments');
    const descriptor = defineModule({ id: OrdersModule, dependsOn: [AuthModule, PaymentsModule] });
    expect(descriptor.dependsOn).toEqual([AuthModule, PaymentsModule]);
  });

  it('D1: descriptor construction never calls the providers/init/dispose thunks', () => {
    const OrdersModule = moduleRef('orders');
    const providers = vi.fn(() => []);
    const init = vi.fn();
    const dispose = vi.fn();

    defineModule({ id: OrdersModule, providers, init, dispose });

    expect(providers).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('D1: descriptor stores the thunks unchanged for the kernel to call later', () => {
    const OrdersModule = moduleRef('orders');
    const providers = vi.fn(() => []);
    const init = vi.fn();
    const dispose = vi.fn();

    const descriptor = defineModule({ id: OrdersModule, providers, init, dispose });

    expect(descriptor.providers).toBe(providers);
    expect(descriptor.init).toBe(init);
    expect(descriptor.dispose).toBe(dispose);
  });

  it('D1: providers/init/dispose must be functions when present', () => {
    const OrdersModule = moduleRef('orders');
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- providers must be a thunk function (D1).
        providers: 'not-a-function',
      }),
    ).toThrow(InvalidDescriptorError);
  });

  it('D4: init and dispose are optional', () => {
    const OrdersModule = moduleRef('orders');
    const descriptor = defineModule({ id: OrdersModule });
    expect(descriptor.init).toBeUndefined();
    expect(descriptor.dispose).toBeUndefined();
  });

  it('descriptor rejects unknown fields, naming the valid ones', () => {
    const OrdersModule = moduleRef('orders');
    let error: unknown;
    try {
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- deliberately adding a field the descriptor does not have.
        capabilities: [],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidDescriptorError);
    const message = (error as InvalidDescriptorError).message;
    expect(message).toContain("unknown field(s) 'capabilities'");
    for (const field of ['id', 'dependsOn', 'load', 'critical', 'providers', 'init', 'dispose']) {
      expect(message).toContain(`'${field}'`);
    }
  });

  it('defaults: load is "lazy" and critical is false', () => {
    const OrdersModule = moduleRef('orders');
    const descriptor = defineModule({ id: OrdersModule });
    expect(descriptor.load).toBe('lazy');
    expect(descriptor.critical).toBe(false);
  });

  it('load rejects a value other than "eager"/"lazy"', () => {
    const OrdersModule = moduleRef('orders');
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- load must be 'eager' or 'lazy'.
        load: 'immediate',
      }),
    ).toThrow(InvalidDescriptorError);
  });

  it('critical rejects a non-boolean value', () => {
    const OrdersModule = moduleRef('orders');
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- critical must be a boolean.
        critical: 'yes',
      }),
    ).toThrow(InvalidDescriptorError);
  });

  it('descriptor and its dependsOn array are frozen', () => {
    const OrdersModule = moduleRef('orders');
    const AuthModule = moduleRef('auth');
    const descriptor = defineModule({ id: OrdersModule, dependsOn: [AuthModule] });

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.dependsOn)).toBe(true);
  });

  it('type-level: ModuleDescriptor preserves the literal Id from moduleRef', () => {
    const OrdersModule = moduleRef('orders');
    const descriptor = defineModule({ id: OrdersModule, load: 'eager', critical: true });
    expectTypeOf(descriptor).toEqualTypeOf<ModuleDescriptor<'orders'>>();
    expectTypeOf(descriptor.id).toEqualTypeOf<ModuleRef<'orders'>>();
  });

  it('type-level: dependsOn rejects a bare string literal at the call site', () => {
    const OrdersModule = moduleRef('orders');
    expect(() =>
      defineModule({
        id: OrdersModule,
        // @ts-expect-error -- dependsOn must be ModuleRef[], a string literal does not compile (D3, acceptance criterion 2).
        dependsOn: ['payments'],
      }),
    ).toThrow(InvalidDescriptorError);
  });
});
