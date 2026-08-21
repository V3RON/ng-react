import { describe, expect, it } from 'vitest';

import { DependencyCycleError, InvalidDescriptorError, UnknownModuleError } from '../errors';
import { buildModuleGraph } from './graph';
import type { ModuleGraphNode } from './graph';

/** Shorthand for a node; `dependsOn` defaults to none. */
const node = (id: string, ...dependsOn: string[]): ModuleGraphNode => ({ id, dependsOn });

/**
 * Every distinct permutation of `items`, capped at `limit` so a six-module
 * fixture does not turn into 720 assertions. Determinism claims in this
 * file are made against these, never against one hand-picked input order:
 * an assertion on a single ordering is also satisfied by an implementation
 * that just echoes insertion order, which is precisely the bug.
 */
function permutations<T>(items: readonly T[], limit = 24): T[][] {
  const out: T[][] = [];
  const walk = (rest: readonly T[], acc: T[]): void => {
    if (out.length >= limit) {
      return;
    }
    if (rest.length === 0) {
      out.push(acc);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      const picked = rest[i];
      if (picked === undefined) {
        continue;
      }
      walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, picked]);
    }
  };
  walk(items, []);
  return out;
}

describe('buildModuleGraph', () => {
  it('G2: a dependsOn id missing from the composition root names the missing module and the dependent', () => {
    expect(() => buildModuleGraph([node('orders', 'payments')])).toThrow(UnknownModuleError);
    try {
      buildModuleGraph([node('orders', 'payments')]);
      expect.unreachable('expected UnknownModuleError');
    } catch (error) {
      expect((error as Error).message).toBe(
        "Module 'orders' depends on 'payments', which was not registered with the kernel. " +
          'Add its descriptor to the composition root.',
      );
    }
  });

  it('G2: the reported missing dependency is deterministic across shuffled input', () => {
    const nodes = [node('zeta', 'ghost'), node('alpha', 'phantom'), node('beta')];
    const messages = new Set<string>();
    for (const permutation of permutations(nodes)) {
      try {
        buildModuleGraph(permutation);
        expect.unreachable('expected UnknownModuleError');
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect([...messages]).toEqual([
      "Module 'alpha' depends on 'phantom', which was not registered with the kernel. " +
        'Add its descriptor to the composition root.',
    ]);
  });

  it('G1: a two-module cycle produces the verbatim spec message', () => {
    try {
      buildModuleGraph([node('orders', 'payments'), node('payments', 'orders')]);
      expect.unreachable('expected DependencyCycleError');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as Error).message).toBe(
        'Module dependency cycle: orders → payments → orders. ' +
          'Break it by moving the shared surface into a contract.',
      );
    }
  });

  it('G1: a three-module cycle prints every module in the cycle, in order, verbatim', () => {
    try {
      buildModuleGraph([node('orders', 'payments'), node('payments', 'risk'), node('risk', 'orders')]);
      expect.unreachable('expected DependencyCycleError');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Module dependency cycle: orders → payments → risk → orders. ' +
          'Break it by moving the shared surface into a contract.',
      );
    }
  });

  it('G1: the reported cycle is identical across every shuffled input order', () => {
    const nodes = [
      node('orders', 'payments'),
      node('payments', 'risk'),
      node('risk', 'orders'),
      node('shipping', 'orders'),
    ];
    const messages = new Set<string>();
    const cycles = new Set<string>();
    for (const permutation of permutations(nodes)) {
      try {
        buildModuleGraph(permutation);
        expect.unreachable('expected DependencyCycleError');
      } catch (error) {
        messages.add((error as Error).message);
        cycles.add((error as DependencyCycleError).cycle.join(','));
      }
    }
    expect([...cycles]).toEqual(['orders,payments,risk']);
    expect([...messages]).toEqual([
      'Module dependency cycle: orders → payments → risk → orders. ' +
        'Break it by moving the shared surface into a contract.',
    ]);
  });

  it('G1: with several disjoint cycles, the one through the lowest module id is reported', () => {
    const nodes = [
      node('yak', 'zebra'),
      node('zebra', 'yak'),
      node('ant', 'bee'),
      node('bee', 'ant'),
    ];
    for (const permutation of permutations(nodes)) {
      try {
        buildModuleGraph(permutation);
        expect.unreachable('expected DependencyCycleError');
      } catch (error) {
        expect((error as DependencyCycleError).cycle).toEqual(['ant', 'bee']);
      }
    }
  });

  it('G3: the topological order is identical across every shuffled input order', () => {
    const nodes = [
      node('ui', 'orders', 'auth'),
      node('orders', 'auth', 'payments'),
      node('payments', 'auth'),
      node('auth'),
      node('telemetry'),
    ];
    const orders = new Set<string>();
    for (const permutation of permutations(nodes, 120)) {
      orders.add(buildModuleGraph(permutation).topologicalOrder().join(','));
    }
    expect(orders.size).toBe(1);
    // Ties are broken by id, which makes the result the lexicographically
    // smallest valid topological order: 'telemetry' depends on nothing and
    // could legally come first, but 'auth' sorts before it, and once 'auth'
    // is placed 'payments' becomes available and sorts before 'telemetry'.
    expect([...orders]).toEqual(['auth,payments,orders,telemetry,ui']);
  });

  it('G3: every module appears after all of its dependencies', () => {
    const nodes = [
      node('ui', 'orders', 'auth'),
      node('orders', 'auth', 'payments'),
      node('payments', 'auth'),
      node('auth'),
    ];
    for (const permutation of permutations(nodes)) {
      const graph = buildModuleGraph(permutation);
      for (const entry of permutation) {
        for (const dependency of entry.dependsOn) {
          expect(graph.topologicalIndex(dependency)).toBeLessThan(graph.topologicalIndex(entry.id));
        }
      }
    }
  });

  it('reverseTopologicalOrder is exactly the topological order reversed (A4 disposal)', () => {
    const graph = buildModuleGraph([node('orders', 'auth'), node('auth'), node('ui', 'orders')]);
    expect(graph.reverseTopologicalOrder()).toEqual([...graph.topologicalOrder()].reverse());
    expect(graph.reverseTopologicalOrder()).toEqual(['ui', 'orders', 'auth']);
  });

  it('topologicalIndex is the position in the topological order, and NaN for an unknown module', () => {
    const graph = buildModuleGraph([node('orders', 'auth'), node('auth')]);
    expect(graph.topologicalIndex('auth')).toBe(0);
    expect(graph.topologicalIndex('orders')).toBe(1);
    expect(Number.isNaN(graph.topologicalIndex('nope'))).toBe(true);
    expect(graph.has('nope')).toBe(false);
    expect(graph.has('auth')).toBe(true);
  });

  it('dependenciesOf and dependentsOf return direct and transitive neighbours in topological order', () => {
    const graph = buildModuleGraph([
      node('ui', 'orders'),
      node('orders', 'payments', 'auth'),
      node('payments', 'auth'),
      node('auth'),
    ]);

    expect(graph.dependenciesOf('orders')).toEqual(['auth', 'payments']);
    expect(graph.dependenciesOf('orders', { transitive: true })).toEqual(['auth', 'payments']);
    expect(graph.dependenciesOf('ui')).toEqual(['orders']);
    expect(graph.dependenciesOf('ui', { transitive: true })).toEqual(['auth', 'payments', 'orders']);
    expect(graph.dependenciesOf('auth')).toEqual([]);

    expect(graph.dependentsOf('auth')).toEqual(['orders', 'payments']);
    expect(graph.dependentsOf('auth', { transitive: true })).toEqual(['payments', 'orders', 'ui']);
    expect(graph.dependentsOf('ui')).toEqual([]);
    expect(graph.dependentsOf('nope')).toEqual([]);
  });

  it('rejects duplicate ids defensively (the kernel raises M3 with both descriptor positions first)', () => {
    expect(() => buildModuleGraph([node('orders'), node('orders')])).toThrow(InvalidDescriptorError);
    expect(() => buildModuleGraph([node('orders'), node('orders')])).toThrow(
      "buildModuleGraph(): duplicate module id 'orders'. Module ids must be unique.",
    );
  });

  it('an empty module list is a valid, empty graph', () => {
    const graph = buildModuleGraph([]);
    expect(graph.topologicalOrder()).toEqual([]);
    expect(graph.reverseTopologicalOrder()).toEqual([]);
  });

  it('a self-dependency is reported as a one-module cycle (defineModule rejects it earlier)', () => {
    try {
      buildModuleGraph([node('orders', 'orders')]);
      expect.unreachable('expected DependencyCycleError');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Module dependency cycle: orders → orders. Break it by moving the shared surface into a contract.',
      );
    }
  });
});
