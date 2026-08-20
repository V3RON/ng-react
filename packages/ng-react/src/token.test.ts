import { describe, expect, expectTypeOf, it } from 'vitest';
import { InvalidDescriptorError } from './errors';
import {
  MODULE_ID,
  allOf,
  createToken,
  isAllOfDep,
  isOptionalDep,
  isToken,
  optional,
} from './token';
import type { AllOfDep, Dep, OptionalDep, ResolvedDeps, Token } from './token';

describe('token', () => {
  it('C1: two createToken calls with the same label are distinct tokens', () => {
    const a = createToken<number>('orders/Count');
    const b = createToken<number>('orders/Count');
    expect(a).not.toBe(b);
    expect(a.label).toBe('orders/Count');
    expect(b.label).toBe('orders/Count');
  });

  it('C1: createToken() results are frozen and stringify readably', () => {
    const token = createToken<string>('orders/OrderService');
    expect(Object.isFrozen(token)).toBe(true);
    expect(token.toString()).toBe('Token(orders/OrderService)');
    expect(String(token)).toBe('Token(orders/OrderService)');
  });

  it('createToken(): rejects an empty or whitespace-only label', () => {
    expect(() => createToken('')).toThrow(InvalidDescriptorError);
    expect(() => createToken('   ')).toThrow(InvalidDescriptorError);
  });

  it('isToken: true only for values produced by createToken()', () => {
    const token = createToken<string>('orders/OrderService');
    expect(isToken(token)).toBe(true);
    expect(isToken({ label: 'orders/OrderService' })).toBe(false);
    expect(isToken('orders/OrderService')).toBe(false);
    expect(isToken(null)).toBe(false);
    expect(isToken(undefined)).toBe(false);
  });

  it('C4/ADR-2: MODULE_ID is a Token<string> labeled kernel/MODULE_ID', () => {
    expect(isToken(MODULE_ID)).toBe(true);
    expect(MODULE_ID.label).toBe('kernel/MODULE_ID');
    expectTypeOf(MODULE_ID).toEqualTypeOf<Token<string>>();
  });

  it('optional(): wraps a token in a frozen OptionalDep', () => {
    const token = createToken<string>('orders/OrderService');
    const dep = optional(token);
    expect(Object.isFrozen(dep)).toBe(true);
    expect(dep.token).toBe(token);
    expect(isOptionalDep(dep)).toBe(true);
    expect(isAllOfDep(dep)).toBe(false);
  });

  it('allOf(): wraps a token in a frozen AllOfDep', () => {
    const token = createToken<string>('orders/OrderService');
    const dep = allOf(token);
    expect(Object.isFrozen(dep)).toBe(true);
    expect(dep.token).toBe(token);
    expect(isAllOfDep(dep)).toBe(true);
    expect(isOptionalDep(dep)).toBe(false);
  });

  it('isOptionalDep/isAllOfDep: reject unrelated values', () => {
    expect(isOptionalDep(null)).toBe(false);
    expect(isOptionalDep({})).toBe(false);
    expect(isAllOfDep(null)).toBe(false);
    expect(isAllOfDep({})).toBe(false);
  });

  it('acceptance criterion 2 (type-level): Token<Cat> is not assignable to Token<Animal>, and vice versa', () => {
    interface Animal {
      name: string;
    }
    interface Cat extends Animal {
      meow(): void;
    }

    expectTypeOf<Token<Cat>>().not.toExtend<Token<Animal>>();
    expectTypeOf<Token<Animal>>().not.toExtend<Token<Cat>>();
  });

  it('type-level: ResolvedDeps maps [Token<A>, OptionalDep<B>, AllOfDep<C>] to [A, B | undefined, readonly C[]]', () => {
    interface A {
      a: 1;
    }
    interface B {
      b: 2;
    }
    interface C {
      c: 3;
    }

    type Deps = [Token<A>, OptionalDep<B>, AllOfDep<C>];
    type Expected = [A, B | undefined, readonly C[]];

    expectTypeOf<ResolvedDeps<Deps>>().toEqualTypeOf<Expected>();
  });

  it('type-level: ResolvedDeps accepts an empty deps tuple', () => {
    expectTypeOf<ResolvedDeps<[]>>().toEqualTypeOf<[]>();
  });

  it('type-level: Dep<T> covers Token<T>, OptionalDep<T>, and AllOfDep<T>', () => {
    expectTypeOf<Token<string>>().toExtend<Dep<string>>();
    expectTypeOf<OptionalDep<string>>().toExtend<Dep<string>>();
    expectTypeOf<AllOfDep<string>>().toExtend<Dep<string>>();
  });
});
