/**
 * Shared types for the search algorithms. A search problem is a road graph
 * in CSR form plus an edge-cost function, a start and a goal. Every
 * algorithm reports what it does through an optional event callback, so the
 * UI can animate it step by step without changing the algorithm.
 */

export interface SearchGraph {
  /** Number of nodes. */
  n: number;
  /** Node coordinates, metres. */
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Neighbours of v: adjNode[adjStart[v] .. adjStart[v+1]), via edge adjEdge[...]. */
  adjStart: Int32Array;
  adjNode: Int32Array;
  adjEdge: Int32Array;
}

export interface SearchProblem {
  graph: SearchGraph;
  start: number;
  goal: number;
  /** Cost of traversing edge e (seconds). Infinity means the edge is impassable. */
  cost: (e: number) => number;
  /** Estimated cost from v to the goal. Needed by Greedy and A*. */
  heuristic?: (v: number) => number;
  /** Stop after this many expansions (keeps the UI responsive on huge graphs). */
  maxExpansions?: number;
}

export type SearchEvent =
  /** A node was taken off the frontier and its neighbours examined. */
  | { type: 'expand'; node: number; g: number; f: number }
  /** A node was added to (or improved on) the frontier. */
  | { type: 'frontier'; node: number; from: number; g: number; f: number }
  /** The goal was reached. */
  | { type: 'goal'; path: number[]; cost: number }
  /** The frontier ran out (or the budget did) without reaching the goal. */
  | { type: 'fail'; reason: string };

export interface SearchCounters {
  /** Nodes taken off the frontier. */
  expanded: number;
  /** Nodes pushed onto the frontier (including re-pushes). */
  generated: number;
  /** Largest frontier size seen. */
  frontierMax: number;
}

export interface SearchResult extends SearchCounters {
  found: boolean;
  /** Node sequence from start to goal (empty if not found). */
  path: number[];
  /** Edge ids along the path. */
  edges: number[];
  /** Sum of edge costs along the path (seconds); Infinity if not found. */
  cost: number;
  /** Wall-clock time of the search, ms. */
  ms: number;
  reason?: string;
}

export type OnEvent = (e: SearchEvent) => void;

/** Rebuild the path from a parent array. `parentEdge[v]` is the edge used to reach v. */
export function reconstruct(problem: SearchProblem, parentNode: Int32Array, parentEdge: Int32Array): { path: number[]; edges: number[]; cost: number } {
  const path: number[] = [];
  const edges: number[] = [];
  let v = problem.goal;
  let guard = problem.graph.n + 1;
  while (v !== -1 && guard-- > 0) {
    path.push(v);
    if (v === problem.start) break;
    edges.push(parentEdge[v]);
    v = parentNode[v];
  }
  path.reverse();
  edges.reverse();
  let cost = 0;
  for (const e of edges) cost += problem.cost(e);
  return { path, edges, cost };
}

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Result for the trivial and failure cases, shared by every algorithm. */
export function trivial(problem: SearchProblem, onEvent?: OnEvent): SearchResult | null {
  const { graph, start, goal } = problem;
  if (start < 0 || goal < 0 || start >= graph.n || goal >= graph.n) {
    onEvent?.({ type: 'fail', reason: 'start or goal is not on the road network' });
    return { found: false, path: [], edges: [], cost: Infinity, ms: 0, expanded: 0, generated: 0, frontierMax: 0, reason: 'start or goal is not on the road network' };
  }
  if (start === goal) {
    onEvent?.({ type: 'goal', path: [start], cost: 0 });
    return { found: true, path: [start], edges: [], cost: 0, ms: 0, expanded: 0, generated: 0, frontierMax: 0 };
  }
  return null;
}
