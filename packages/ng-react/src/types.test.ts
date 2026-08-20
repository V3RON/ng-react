import { describe, expectTypeOf, it } from 'vitest';
import type { Disposable, LoadStrategy, ModuleStatus, Scope, Unsubscribe } from './types';

describe('types', () => {
  it('A2: ModuleStatus is exactly the five spec-defined states', () => {
    expectTypeOf<ModuleStatus>().toEqualTypeOf<
      'registered' | 'activating' | 'ready' | 'failed' | 'disposed'
    >();
  });

  it('LoadStrategy is exactly eager | lazy', () => {
    expectTypeOf<LoadStrategy>().toEqualTypeOf<'eager' | 'lazy'>();
  });

  it('C2: Scope is exactly the three flat scopes', () => {
    expectTypeOf<Scope>().toEqualTypeOf<'singleton' | 'module' | 'transient'>();
  });

  it('C7: Disposable requires a dispose() returning void or Promise<void>', () => {
    expectTypeOf<Disposable>().toEqualTypeOf<{ dispose(): void | Promise<void> }>();
  });

  it('Unsubscribe is a niladic function returning void', () => {
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>();
  });
});
