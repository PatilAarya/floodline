/**
 * d-separation: are A and B conditionally independent given the observed
 * set Z, judging from the graph alone?
 *
 * A trail (a path ignoring arrow directions) between A and B is ACTIVE when
 * every node M in its middle lets information through:
 *   chain    X -> M -> Y   or  X <- M <- Y   active unless M is observed
 *   fork     X <- M -> Y                     active unless M is observed
 *   collider X -> M <- Y                     active ONLY IF M or one of its
 *                                            descendants is observed
 * A and B are d-separated by Z when no trail is active; then the network
 * guarantees P(A | B, Z) = P(A | Z) for EVERY choice of CPT numbers.
 *
 * Two implementations:
 *   - `dSeparated`: the efficient "Bayes-ball" reachability search (Koller &
 *     Friedman, Algorithm 3.1), O(nodes + edges). It also returns one active
 *     trail, for highlighting.
 *   - `explainTrails`: lists every simple trail and, for a blocked one, the
 *     node that blocks it and why. Fine for a 7-node network; used for the
 *     one-line explanations on the Bayes page.
 */
import { children, type Network } from './network';

/** Observed nodes and all their ancestors (a collider is opened by an observed descendant). */
function ancestorsOf(net: Network, z: Set<number>): Set<number> {
  const out = new Set<number>();
  const stack = [...z];
  while (stack.length) {
    const v = stack.pop()!;
    if (out.has(v)) continue;
    out.add(v);
    stack.push(...net.vars[v].parents);
  }
  return out;
}

export interface DSepResult {
  separated: boolean;
  /** One active trail from A to B (node indices), when not separated. */
  trail: number[] | null;
}

/**
 * Bayes-ball. The search state is (node, direction): "up" means we arrived
 * from a child, "down" from a parent. Rules:
 *   arrived up at an unobserved node:   go up to parents and down to children
 *   arrived down at an unobserved node: go down to children only
 *   arrived down at a node in anc(Z):   go up to parents (collider opened)
 *   arrived up at an observed node:     stop (chain or fork blocked)
 */
export function dSeparated(net: Network, a: number, b: number, z: Set<number>): DSepResult {
  if (a === b) return { separated: false, trail: [a] };
  if (z.has(a) || z.has(b)) return { separated: true, trail: null };
  const anc = ancestorsOf(net, z);
  const UP = 0, DOWN = 1;
  const key = (v: number, d: number) => v * 2 + d;
  const prev = new Map<number, number>();
  const seen = new Set<number>([key(a, UP)]);
  const queue: [number, number][] = [[a, UP]];
  const push = (from: number, v: number, d: number) => {
    const k = key(v, d);
    if (seen.has(k)) return;
    seen.add(k);
    prev.set(k, from);
    queue.push([v, d]);
  };
  while (queue.length) {
    const [v, d] = queue.shift()!;
    const here = key(v, d);
    if (v === b) {
      // Rebuild the trail from the predecessor links.
      const trail: number[] = [];
      let k: number | undefined = here;
      while (k !== undefined) {
        trail.push(k >> 1);
        k = prev.get(k);
      }
      return { separated: false, trail: trail.reverse() };
    }
    const observed = z.has(v);
    if (d === UP && !observed) {
      for (const p of net.vars[v].parents) push(here, p, UP);
      for (const c of children(net, v)) push(here, c, DOWN);
    } else if (d === DOWN) {
      if (!observed) for (const c of children(net, v)) push(here, c, DOWN);
      if (anc.has(v)) for (const p of net.vars[v].parents) push(here, p, UP);
    }
  }
  return { separated: true, trail: null };
}

export type JunctionKind = 'chain' | 'fork' | 'collider';

export interface TrailInfo {
  nodes: number[];
  active: boolean;
  /** Kind of each middle node (index i is nodes[i + 1]). */
  kinds: JunctionKind[];
  /** The first blocking node, or -1 if active. */
  blockedAt: number;
  /** One sentence: why it is blocked or active. */
  reason: string;
}

/** Every simple trail between A and B, each with its verdict and a one-line reason. */
export function explainTrails(net: Network, a: number, b: number, z: Set<number>): TrailInfo[] {
  const n = net.vars.length;
  const nb: number[][] = Array.from({ length: n }, () => []);
  net.vars.forEach((v, c) => {
    for (const p of v.parents) {
      nb[p].push(c);
      nb[c].push(p);
    }
  });
  const anc = ancestorsOf(net, z);
  const isParent = (p: number, c: number) => net.vars[c].parents.includes(p);
  const name = (i: number) => net.vars[i].name;
  const out: TrailInfo[] = [];
  const path = [a];
  const on = new Set([a]);
  const walk = (v: number) => {
    if (v === b) {
      out.push(judge([...path]));
      return;
    }
    for (const w of nb[v]) {
      if (on.has(w)) continue;
      on.add(w);
      path.push(w);
      walk(w);
      path.pop();
      on.delete(w);
    }
  };
  const judge = (nodes: number[]): TrailInfo => {
    const kinds: JunctionKind[] = [];
    let blockedAt = -1, reason = '';
    for (let i = 1; i < nodes.length - 1; i++) {
      const x = nodes[i - 1], m = nodes[i], y = nodes[i + 1];
      const kind: JunctionKind = isParent(x, m) && isParent(y, m) ? 'collider' : isParent(m, x) && isParent(m, y) ? 'fork' : 'chain';
      kinds.push(kind);
      if (blockedAt >= 0) continue;
      if (kind === 'collider') {
        if (!anc.has(m)) {
          blockedAt = m;
          reason = `blocked at ${name(m)}: two arrows meet there (a collider) and neither ${name(m)} nor anything below it is observed.`;
        }
      } else if (z.has(m)) {
        blockedAt = m;
        reason = kind === 'fork'
          ? `blocked at ${name(m)}: it is the common cause and it is observed, so it explains the link away.`
          : `blocked at ${name(m)}: it sits in the middle of a chain and it is observed.`;
      }
    }
    if (blockedAt < 0) {
      const opened = nodes.slice(1, -1).filter((_, i) => kinds[i] === 'collider');
      reason = opened.length
        ? `active: the collider ${opened.map(name).join(' and ')} is observed (or has an observed descendant), which opens it; every other middle node is unobserved.`
        : nodes.length === 2
          ? 'active: the two are directly connected.'
          : 'active: every node in the middle is unobserved and none is a collider.';
    }
    return { nodes, active: blockedAt < 0, kinds, blockedAt, reason };
  };
  walk(a);
  return out.sort((p, q) => p.nodes.length - q.nodes.length);
}
