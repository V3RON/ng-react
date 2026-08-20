import { describe, expect, expectTypeOf, it } from 'vitest';
import { InvalidDescriptorError, ReservedModuleIdError } from './errors';
import { isModuleRef, moduleRef } from './module-ref';
import type { ModuleRef } from './module-ref';

describe('module-ref', () => {
  it('M1: two moduleRef calls with the same id are distinct values', () => {
    const a = moduleRef('orders');
    const b = moduleRef('orders');
    expect(a).not.toBe(b);
    expect(a.id).toBe('orders');
    expect(b.id).toBe('orders');
  });

  it('M1: distinct ids produce refs that carry their own id unchanged', () => {
    const orders = moduleRef('orders');
    const payments = moduleRef('payments');
    expect(orders.id).toBe('orders');
    expect(payments.id).toBe('payments');
    expect(orders).not.toBe(payments);
  });

  it('M1: refs are frozen and stringify readably', () => {
    const ref = moduleRef('orders');

    expect(Object.isFrozen(ref)).toBe(true);
    expect(() => {
      // @ts-expect-error -- id is readonly; this line exists to prove the runtime is also frozen.
      ref.id = 'payments';
    }).toThrow();

    expect(ref.toString()).toBe('ModuleRef(orders)');
    expect(String(ref)).toBe('ModuleRef(orders)');
    expect(`${ref}`).toBe('ModuleRef(orders)');
  });

  it('isModuleRef: true only for values produced by moduleRef()', () => {
    const ref = moduleRef('orders');
    expect(isModuleRef(ref)).toBe(true);
    expect(isModuleRef({ id: 'orders' })).toBe(false);
    expect(isModuleRef('orders')).toBe(false);
    expect(isModuleRef(null)).toBe(false);
    expect(isModuleRef(undefined)).toBe(false);
  });

  it("ADR-2: moduleRef('app') throws ReservedModuleIdError", () => {
    expect(() => moduleRef('app')).toThrow(ReservedModuleIdError);
  });

  it("ADR-2: only the exact id 'app' is reserved", () => {
    expect(() => moduleRef('application')).not.toThrow();
  });

  it('moduleRef(): rejects an empty string', () => {
    expect(() => moduleRef('')).toThrow(InvalidDescriptorError);
  });

  it('moduleRef(): rejects a whitespace-only string', () => {
    expect(() => moduleRef('   ')).toThrow(InvalidDescriptorError);
  });

  it('moduleRef(): rejects a non-string id', () => {
    // @ts-expect-error -- deliberately passing a non-string to test the runtime guard.
    expect(() => moduleRef(42)).toThrow(InvalidDescriptorError);
  });

  it('acceptance criterion 2 (type-level): a bare string is not assignable to ModuleRef', () => {
    expectTypeOf<string>().not.toExtend<ModuleRef>();
  });

  it('type-level: moduleRef() returns a ModuleRef parameterized by the literal id', () => {
    expectTypeOf(moduleRef('orders')).toEqualTypeOf<ModuleRef<'orders'>>();
    expectTypeOf(moduleRef('orders').id).toEqualTypeOf<'orders'>();
  });
});
