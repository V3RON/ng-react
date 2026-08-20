import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { InvalidDescriptorError } from './errors';
import { contribute, provide } from './provider';
import type { ProviderOptions, ProviderRecord } from './provider';
import { allOf, createToken, optional } from './token';
import type { Token } from './token';

describe('provider', () => {
  it('C3: provide() stores factory but never calls it', () => {
    const token = createToken<string>('orders/Value');
    const factory = vi.fn(() => 'value');

    const record = provide(token, { factory });

    expect(factory).not.toHaveBeenCalled();
    expect(record.factory).toBe(factory);
  });

  it('C3: contribute() stores factory but never calls it', () => {
    const token = createToken<string>('orders/Value');
    const factory = vi.fn(() => 'value');

    contribute(token, { factory });

    expect(factory).not.toHaveBeenCalled();
  });

  it('provide(): defaults scope to singleton, deps to [], and override/persistent to false', () => {
    const token = createToken<string>('orders/Value');
    const record = provide(token, { factory: () => 'value' });

    expect(record.scope).toBe('singleton');
    expect(record.deps).toEqual([]);
    expect(record.override).toBe(false);
    expect(record.persistent).toBe(false);
    expect(record.onDispose).toBeUndefined();
    expect(record.transfer).toBeUndefined();
  });

  it('provide(): records kind "provide"; contribute() records kind "contribute"', () => {
    const token = createToken<string>('orders/Value');
    expect(provide(token, { factory: () => 'value' }).kind).toBe('provide');
    expect(contribute(token, { factory: () => 'value' }).kind).toBe('contribute');
  });

  it('ProviderRecord: is frozen, and carries no provenance/owner field (C9)', () => {
    const token = createToken<string>('orders/Value');
    const record = provide(token, { factory: () => 'value' });

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.deps)).toBe(true);
    expect(record).not.toHaveProperty('module');
    expect(record).not.toHaveProperty('owner');
    expect(Object.keys(record).sort()).toEqual(
      ['deps', 'factory', 'kind', 'onDispose', 'override', 'persistent', 'scope', 'token', 'transfer'].sort(),
    );
  });

  it('C2: provide rejects an unknown scope', () => {
    const token = createToken<string>('orders/Value');
    expect(() =>
      provide(token, {
        // @ts-expect-error -- deliberately passing an invalid scope to test the runtime guard.
        scope: 'global',
        factory: () => 'value',
      }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      provide(token, {
        // @ts-expect-error -- deliberately passing an invalid scope to test the runtime guard.
        scope: 'global',
        factory: () => 'value',
      }),
    ).toThrow(/invalid scope/);
  });

  it('C2: provide accepts each of the three flat scopes', () => {
    const token = createToken<string>('orders/Value');
    expect(provide(token, { scope: 'singleton', factory: () => 'value' }).scope).toBe('singleton');
    expect(provide(token, { scope: 'module', factory: () => 'value' }).scope).toBe('module');
    expect(provide(token, { scope: 'transient', factory: () => 'value' }).scope).toBe('transient');
  });

  it('C2: provide rejects a deps element that is not a Token, optional() or allOf() wrapper', () => {
    const httpToken = createToken<string>('orders/Http');
    let error: unknown;
    try {
      provide(httpToken, {
        // Deliberately including a non-Dep element ('storage' is a plain string, not a
        // Token/optional()/allOf() wrapper). No `@ts-expect-error` here: this is exactly the
        // gap the task 1.1 handoff note describes — ResolvedDeps' `unknown[]` constraint means
        // this compiles (the mismatched element infers as `never` downstream) instead of
        // failing to compile, which is why this runtime guard is the only thing that catches it.
        deps: [httpToken, 'storage'],
        factory: (_http: string, _storage: never) => 'value',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidDescriptorError);
    expect((error as InvalidDescriptorError).message).toBe(
      "provide(orders/Http): deps[1] is not a Token, optional() or allOf() wrapper, got string 'storage'.",
    );
  });

  it('provide(): accepts optional() and allOf() wrapped deps alongside plain tokens', () => {
    const a = createToken<string>('orders/A');
    const b = createToken<number>('orders/B');
    const c = createToken<boolean>('orders/C');

    const record = provide(a, {
      deps: [a, optional(b), allOf(c)],
      factory: (_a: string, _b: number | undefined, _c: readonly boolean[]) => 'value',
    });

    expect(record.deps).toHaveLength(3);
  });

  it('C7: onDispose on a transient provider is a declaration-time error', () => {
    const token = createToken<{ dispose(): void }>('orders/Thing');
    expect(() =>
      provide(token, {
        scope: 'transient',
        factory: () => ({ dispose: () => {} }),
        onDispose: () => {},
      }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      provide(token, {
        scope: 'transient',
        factory: () => ({ dispose: () => {} }),
        onDispose: () => {},
      }),
    ).toThrow(/transient/);
  });

  it('C7: onDispose is accepted on singleton and module scopes', () => {
    const token = createToken<string>('orders/Value');
    expect(() =>
      provide(token, { scope: 'singleton', factory: () => 'value', onDispose: () => {} }),
    ).not.toThrow();
    expect(() => provide(token, { scope: 'module', factory: () => 'value', onDispose: () => {} })).not.toThrow();
  });

  it('ADR-3: transfer without persistent is a declaration-time error', () => {
    const token = createToken<string>('orders/Value');
    expect(() =>
      provide(token, {
        scope: 'singleton',
        factory: () => 'value',
        transfer: (_old: string, next: string) => next,
      }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      provide(token, {
        scope: 'singleton',
        factory: () => 'value',
        transfer: (_old: string, next: string) => next,
      }),
    ).toThrow(/persistent: true/);
  });

  it('ADR-3: persistent on a transient provider is a declaration-time error', () => {
    const token = createToken<string>('orders/Value');
    expect(() =>
      provide(token, { scope: 'transient', factory: () => 'value', persistent: true }),
    ).toThrow(InvalidDescriptorError);
    expect(() =>
      provide(token, { scope: 'transient', factory: () => 'value', persistent: true }),
    ).toThrow(/transient/);
  });

  it('ADR-3: persistent: true with transfer is accepted on singleton/module scope', () => {
    const token = createToken<string>('orders/Value');
    expect(() =>
      provide(token, {
        scope: 'singleton',
        factory: () => 'value',
        persistent: true,
        transfer: (_old: string, next: string) => next,
      }),
    ).not.toThrow();
  });

  it('provide()/contribute() reject a non-Token first argument', () => {
    expect(() =>
      // @ts-expect-error -- deliberately passing a non-Token to test the runtime guard.
      provide('orders/Value', { factory: () => 'value' }),
    ).toThrow(InvalidDescriptorError);
  });

  it('type-level: factory arity and parameter types are inferred from deps', () => {
    const httpToken = createToken<{ get(url: string): Promise<unknown> }>('orders/Http');
    const storageToken = createToken<{ get(key: string): unknown }>('orders/Storage');

    provide(createToken<string>('orders/Service'), {
      deps: [httpToken, storageToken],
      factory: (http, storage) => {
        expectTypeOf(http).toEqualTypeOf<{ get(url: string): Promise<unknown> }>();
        expectTypeOf(storage).toEqualTypeOf<{ get(key: string): unknown }>();
        return 'value';
      },
    });
  });

  it('type-level: an explicit empty deps array requires a niladic factory', () => {
    const token = createToken<string>('orders/Value');
    provide(token, { deps: [], factory: () => 'value' });
    provide(token, {
      deps: [],
      // @ts-expect-error -- deps: [] means factory must take zero parameters.
      factory: (extra: string) => extra,
    });
  });

  it('type-level: ProviderOptions.factory receives ResolvedDeps<D> positionally', () => {
    interface Deps {
      a: Token<number>;
      b: Token<string>;
    }
    type D = readonly [Deps['a'], Deps['b']];
    expectTypeOf<ProviderOptions<boolean, D>['factory']>().toEqualTypeOf<
      (a: number, b: string) => boolean
    >();
  });

  it('type-level: provide() return type is ProviderRecord<T> for the token’s T', () => {
    const token = createToken<number>('orders/Count');
    expectTypeOf(provide(token, { factory: () => 1 })).toEqualTypeOf<ProviderRecord<number>>();
  });
});
