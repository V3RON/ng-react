// The topological order this file produces is the sort key for every
// contribution collection, the activation order, and (reversed) the
// disposal order. It is a pure function of the *set* of modules: ties are
// broken by module id and every traversal iterates a sorted adjacency list,
// so adding an unrelated module to the composition root cannot silently
// reorder an existing collection.

import { DependencyCycleError, InvalidDescriptorError, UnknownModuleError } from '../errors';

/** One node of the graph: a module id and the ids it depends on. */
export interface ModuleGraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Options accepted by `dependenciesOf` / `dependentsOf`. */
export interface TraversalOptions {
  /**
   * Returns the full transitive closure, excluding the queried module
   * itself, instead of only direct neighbours.
   *
   * @default false
   */
  readonly transitive?: boolean;
}

/**
 * A validated, sorted dependency graph. Every returned array is frozen, and
 * every ordering is a function of the module set alone — a caller can never
 * observe the order the composition root listed its descriptors in.
 */
export interface ModuleGraph {
  /** Whether `moduleId` is a node of this graph. */
  has(moduleId: string): boolean;
  /** The activation order: every module after all of its dependencies. */
  topologicalOrder(): readonly string[];
  /** The disposal order: exactly `topologicalOrder()` reversed. */
  reverseTopologicalOrder(): readonly string[];
  /**
   * The position of `moduleId` in `topologicalOrder()`, and the key
   * contribution collections are ordered by.
   *
   * @returns `Number.NaN` for a module this graph does not know, which
   *   consumers treat as "sort last". Deliberately not `0`, which is the
   *   *first* position.
   */
  topologicalIndex(moduleId: string): number;
  /**
   * The modules `moduleId` depends on: its direct dependencies sorted by
   * id, or, with `transitive`, the whole closure in topological order.
   *
   * @returns an empty array for a module this graph does not know.
   */
  dependenciesOf(moduleId: string, options?: TraversalOptions): readonly string[];
  /**
   * The modules that depend on `moduleId`: its direct dependents sorted by
   * id, or, with `transitive`, the whole closure in topological order.
   *
   * @returns an empty array for a module this graph does not know.
   */
  dependentsOf(moduleId: string, options?: TraversalOptions): readonly string[];
}

/** A `dependsOn` edge, from the dependent module to its dependency. */
interface Edge {
  readonly from: string;
  readonly to: string;
}

/**
 * Builds and validates a dependency graph.
 *
 * A missing module is reported before any cycle: a composition root that
 * forgot a descriptor has no meaningful cycle to report, because the graph
 * it describes is not the graph it meant.
 *
 * @throws {InvalidDescriptorError} if two nodes share an id. The kernel
 *   checks this first with a better message; this is the backstop for any
 *   other caller, since every algorithm here assumes ids are unique keys.
 * @throws {UnknownModuleError} for a `dependsOn` id with no node of its own,
 *   naming both the missing module and its dependent. Deterministic:
 *   dependents are checked in id order, each module's `dependsOn` in
 *   declaration order.
 * @throws {DependencyCycleError} with the full cycle path, starting from the
 *   lowest id in the cycle so the message is stable across input orderings.
 */
export function buildModuleGraph(nodes: readonly ModuleGraphNode[]): ModuleGraph {
  const dependsOn = new Map<string, readonly string[]>();
  for (const node of nodes) {
    if (dependsOn.has(node.id)) {
      throw new InvalidDescriptorError(
        `buildModuleGraph(): duplicate module id '${node.id}'. Module ids must be unique.`,
        node.id,
      );
    }
    dependsOn.set(node.id, node.dependsOn);
  }

  const ids = [...dependsOn.keys()].sort();

  // Checked before edges are built: an edge to a node that does not exist
  // is not a graph.
  for (const id of ids) {
    for (const dependency of dependsOn.get(id) ?? []) {
      if (!dependsOn.has(dependency)) {
        throw new UnknownModuleError(dependency, id);
      }
    }
  }

  // Sorted adjacency, in both directions. Every traversal below iterates
  // these, which together with the min-selection in `topologicallySort` is
  // where determinism comes from.
  const dependencies = new Map<string, readonly string[]>();
  const dependents = new Map<string, string[]>();
  const edges: Edge[] = [];
  for (const id of ids) {
    dependents.set(id, []);
  }
  for (const id of ids) {
    const direct = [...new Set(dependsOn.get(id) ?? [])].sort();
    dependencies.set(id, Object.freeze(direct));
    for (const dependency of direct) {
      dependents.get(dependency)?.push(id);
      edges.push({ from: id, to: dependency });
    }
  }
  for (const id of ids) {
    dependents.get(id)?.sort();
  }

  // Cycles are fatal, and must be found before any order can be produced.
  const cycle = findCycle(ids, dependencies);
  if (cycle !== undefined) {
    throw new DependencyCycleError(cycle);
  }

  const order = topologicallySort(ids, dependencies);
  const indexById = new Map<string, number>();
  order.forEach((id, index) => indexById.set(id, index));
  const reversed = Object.freeze([...order].reverse());

  /** Sorts `collected` into topological order. */
  const inTopologicalOrder = (collected: Iterable<string>): readonly string[] =>
    Object.freeze([...collected].sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0)));

  const closure = (start: string, adjacency: Map<string, readonly string[]>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(adjacency.get(start) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) {
        continue;
      }
      seen.add(next);
      queue.push(...(adjacency.get(next) ?? []));
    }
    // A module never appears in its own closure: the graph is acyclic by
    // the time this runs, so `start` is unreachable from itself.
    return seen;
  };

  const frozenDependents = new Map<string, readonly string[]>(
    [...dependents].map(([id, list]) => [id, Object.freeze(list)]),
  );

  return {
    has: (moduleId) => dependencies.has(moduleId),
    topologicalOrder: () => order,
    reverseTopologicalOrder: () => reversed,
    topologicalIndex: (moduleId) => indexById.get(moduleId) ?? Number.NaN,
    dependenciesOf: (moduleId, options) =>
      options?.transitive === true
        ? inTopologicalOrder(closure(moduleId, dependencies))
        : (dependencies.get(moduleId) ?? EMPTY),
    dependentsOf: (moduleId, options) =>
      options?.transitive === true
        ? inTopologicalOrder(closure(moduleId, frozenDependents))
        : (frozenDependents.get(moduleId) ?? EMPTY),
  };
}

/** Shared frozen empty result for an unknown module id. */
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * Kahn's algorithm with a deterministic tie-break: whenever more than one
 * module has all of its dependencies placed, the lowest id goes next. That
 * makes the result a pure function of the edge set.
 *
 * Requires an acyclic graph — `findCycle` runs first — so the loop always
 * drains and needs no leftover check.
 */
function topologicallySort(
  ids: readonly string[],
  dependencies: Map<string, readonly string[]>,
): readonly string[] {
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    remaining.set(id, (dependencies.get(id) ?? []).length);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const dependency of dependencies.get(id) ?? []) {
      dependents.get(dependency)?.push(id);
    }
  }

  const ready = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const next = ready.shift();
    if (next === undefined) {
      break;
    }
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
      }
    }
  }
  return Object.freeze(order);
}

/**
 * Finds a cycle, or `undefined` if there is none.
 *
 * Deterministic in two ways. When a graph contains several cycles, the one
 * reported runs through the lowest module id lying on any cycle. The path
 * through it is the shortest way back to that module, and among equally
 * short ways the one a breadth-first walk over sorted adjacency lists finds
 * first. It must be breadth-first: a depth-first walk with visited-pruning
 * can miss a genuine cycle entirely.
 *
 * @returns the distinct modules in the cycle, in order, starting from that
 *   lowest id. `DependencyCycleError` repeats the first at the end to close
 *   the loop.
 */
function findCycle(
  ids: readonly string[],
  dependencies: Map<string, readonly string[]>,
): readonly string[] | undefined {
  for (const start of ids) {
    const parent = new Map<string, string>();
    const visited = new Set<string>([start]);
    const queue: string[] = [start];
    // `closesCycle` is the first-discovered node with an edge straight back
    // to `start`. Because the walk visits by increasing distance, the first
    // one found lies on a shortest cycle through `start`.
    let closesCycle: string | undefined;
    while (queue.length > 0 && closesCycle === undefined) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const next of dependencies.get(current) ?? []) {
        if (next === start) {
          closesCycle = current;
          break;
        }
        if (!visited.has(next)) {
          visited.add(next);
          parent.set(next, current);
          queue.push(next);
        }
      }
    }
    if (closesCycle === undefined) {
      continue;
    }

    // Walk parents back to `start`, then reverse: `start → … → closesCycle`.
    const path = [closesCycle];
    let cursor = closesCycle;
    while (cursor !== start) {
      const previous = parent.get(cursor);
      if (previous === undefined) {
        break;
      }
      path.push(previous);
      cursor = previous;
    }
    return Object.freeze(path.reverse());
  }
  return undefined;
}
