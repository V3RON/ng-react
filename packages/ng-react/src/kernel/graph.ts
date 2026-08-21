// The module dependency graph (task 3.1): edges from `dependsOn`, G2
// validation, G1 cycle detection, and a topological order that is a pure
// function of the *set* of modules — never of the order the composition
// root happened to list them in.
//
// Nothing here knows about descriptors, providers, statuses or activation:
// the input is `(id, dependsOn)` pairs of plain strings, which is exactly
// what the kernel can hand over without evaluating any implementation code
// (D1). `ModuleGraph` is internal — it is not exported from `index.ts`;
// `kernel.ts` is its only intended caller.
//
// ---
//
// **Why determinism is a hard requirement here, not a nicety.**
//
// The topological order is the sort key for every contribution collection
// (C5, via `ContributionCollections.getTopologicalIndex`), the activation
// order (§6), and the reverse disposal order (A4). If it depended on the
// composition root's array order, then adding an unrelated module to that
// array could silently reorder e.g. the navigation module's routes or the
// order in which error sinks see an error. So: ties are broken by module
// id, and every traversal below iterates a *sorted* adjacency list. Two
// composition roots holding the same descriptors in different orders
// produce byte-identical output from every method on this file, and
// `graph.test.ts` pins that with shuffled inputs rather than with one
// hand-picked expected ordering.

import { DependencyCycleError, InvalidDescriptorError, UnknownModuleError } from '../errors';

/**
 * One node of the graph as the kernel hands it over: a module id and the
 * ids it depends on. Plain strings — refs (M1) stay in `kernel.ts`, because
 * a graph algorithm has no use for value identity and every diagnostic this
 * file produces is a string message.
 */
export interface ModuleGraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Options accepted by `dependenciesOf` / `dependentsOf`. */
export interface TraversalOptions {
  /**
   * `false` (default) returns only direct neighbours; `true` returns the
   * full transitive closure, excluding `id` itself. One function with a
   * flag rather than two functions (principle 5).
   */
  readonly transitive?: boolean;
}

/**
 * The validated, sorted dependency graph. Every returned array is frozen
 * and in topological order (or, for `reverseTopologicalOrder`, its exact
 * reverse), so callers never have to re-sort and can never observe
 * registration order.
 */
export interface ModuleGraph {
  /** Whether `moduleId` is a node of this graph. */
  has(moduleId: string): boolean;
  /** §6: the activation order — every module after all of its dependencies. */
  topologicalOrder(): readonly string[];
  /** A4: the disposal order — exactly `topologicalOrder()` reversed. */
  reverseTopologicalOrder(): readonly string[];
  /**
   * C5: the position of `moduleId` in `topologicalOrder()`, and the
   * callback `ContributionCollections` orders contribution collections by.
   *
   * Returns `Number.NaN` for a module this graph does not know, which
   * `orderContributions` already treats as "sort last, then by
   * registration order" — a non-finite index is its documented
   * unknown-module contract, so this deliberately does not invent `0` (the
   * *first* position) for a module the graph never saw.
   */
  topologicalIndex(moduleId: string): number;
  /** D3: the modules `moduleId` depends on, in topological order. */
  dependenciesOf(moduleId: string, options?: TraversalOptions): readonly string[];
  /** A4/F3: the modules that depend on `moduleId`, in topological order. */
  dependentsOf(moduleId: string, options?: TraversalOptions): readonly string[];
}

/** A `dependsOn` edge, from the dependent module to its dependency. */
interface Edge {
  readonly from: string;
  readonly to: string;
}

/**
 * Builds and validates the graph (spec §6 steps 2-4).
 *
 * Validation runs in the spec's order, and the order matters: a missing
 * module (G2) is reported before any cycle (G1), because a composition root
 * that forgot a descriptor has no meaningful cycle to report — the graph it
 * describes is not the graph it meant.
 *
 * @throws {InvalidDescriptorError} if two nodes share an id. The kernel
 *   checks this first and raises the M3 error with both descriptor
 *   positions; this is the defensive backstop for any other caller, since
 *   every algorithm below assumes ids are unique keys.
 * @throws {UnknownModuleError} G2 — a `dependsOn` id with no node of its
 *   own, naming both the missing module and its dependent. Deterministic:
 *   dependents are checked in id order, and each module's `dependsOn` in
 *   declaration order.
 * @throws {DependencyCycleError} G1 — with the full cycle path, reported
 *   from the lowest id in the cycle so the message is stable across input
 *   orderings.
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

  // G2 — a dependsOn id with no descriptor. Checked before edges are built:
  // an edge to a node that does not exist is not a graph.
  for (const id of ids) {
    for (const dependency of dependsOn.get(id) ?? []) {
      if (!dependsOn.has(dependency)) {
        throw new UnknownModuleError(dependency, id);
      }
    }
  }

  // Sorted adjacency, in both directions. Every traversal below iterates
  // these, which is where determinism actually comes from — the sort here
  // and the min-selection in `topologicallySort`.
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

  // G1 — cycles are fatal, before any order can be produced.
  const cycle = findCycle(ids, dependencies);
  if (cycle !== undefined) {
    throw new DependencyCycleError(cycle);
  }

  const order = topologicallySort(ids, dependencies);
  const indexById = new Map<string, number>();
  order.forEach((id, index) => indexById.set(id, index));
  const reversed = Object.freeze([...order].reverse());

  /** Sorts `collected` into topological order — the one ordering this file hands out. */
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
    // the time this runs, so `start` is genuinely unreachable from itself.
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
 * module has all of its dependencies already placed, the one with the
 * lowest id goes next. That makes the result a pure function of the edge
 * set — the input array order is never consulted, because `ready` is
 * seeded from `ids` (already sorted) and re-sorted on every insertion.
 *
 * Precondition: the graph is acyclic (`findCycle` ran first), so the loop
 * always drains and no leftover check is needed here.
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
 * G1: finds a cycle, or `undefined` if there is none.
 *
 * Deterministic in two independent ways, both of which matter because the
 * message is spec-quoted verbatim and asserted character for character:
 *
 *  - **Which cycle.** When a graph contains several, the one reported is
 *    the one through the lowest module id that lies on any cycle. "Lies on
 *    a cycle" is `id` being reachable from `id`, which is a property of the
 *    edge set alone.
 *  - **Which path through it.** A BFS from that module gives the *shortest*
 *    way back to it, and among equally short ways the one BFS discovers
 *    first over sorted adjacency lists. A depth-first walk would instead
 *    report whichever branch it wandered into, and with visited-pruning it
 *    can miss a genuine cycle entirely, which is why this is a BFS.
 *
 * The returned array holds the distinct modules in the cycle, in order and
 * starting from that lowest id; `DependencyCycleError` repeats the first
 * one at the end to close the loop.
 */
function findCycle(
  ids: readonly string[],
  dependencies: Map<string, readonly string[]>,
): readonly string[] | undefined {
  for (const start of ids) {
    const parent = new Map<string, string>();
    const visited = new Set<string>([start]);
    const queue: string[] = [start];
    // BFS from `start`. `closesCycle` is the first-discovered node with an
    // edge straight back to `start`; because BFS visits by increasing
    // distance, the first one found is on a shortest cycle through `start`.
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
