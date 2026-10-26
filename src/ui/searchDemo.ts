/**
 * A small animated picture of how each search algorithm explores.
 *
 * A toy grid: start S, goal G, a wall of deep water (impassable) with one
 * gap, and a patch of shallow water that is slow to cross (cost 3 instead
 * of 1). The squares light up in the exact order the algorithm expands
 * them, then its route is drawn. It runs the project's real BFS, DFS, UCS,
 * Greedy and A* on this grid, so what you see is what the code does:
 *
 *   BFS     rings: one step further each time; ignores that water is slow
 *   DFS     plunges down one direction; a long, odd route
 *   UCS     a ripple by cost; cheapest route, explores a lot
 *   Greedy  heads straight for G (h only); fast, can get led astray
 *   A*      g + h: aimed at G, still the cheapest route
 */
import { astar } from '../ai/search/astar';
import { bfs } from '../ai/search/bfs';
import { dfs } from '../ai/search/dfs';
import { greedy } from '../ai/search/greedy';
import type { SearchGraph, SearchResult } from '../ai/search/types';
import { ucs } from '../ai/search/ucs';
import { css, mix, paletteAnimator } from '../render/theme';
import type { Algo } from '../sim/journey';
import { h } from './dom';

export const COLS = 17, ROWS = 9;
export const S = [1, 4], G = [15, 4];
/** 0 open, 1 shallow water (slow), 2 deep water (impassable). */
const CELLS: number[] = (() => {
  const c = new Array(COLS * ROWS).fill(0);
  // A wall of deep water down the middle with two gaps: one straight
  // ahead (row 4) and one at the bottom (row 8).
  for (let r = 0; r < ROWS; r++) if (r !== 4 && r !== 8) c[r * COLS + 8] = 2;
  // Behind the straight-ahead gap: a wide band of shallow, slow water.
  // Straight through: 14 steps but cost 24. The long way round the
  // bottom: 22 steps, cost 22, the cheapest.
  for (let r = 1; r <= 7; r++) for (let q = 9; q <= 13; q++) c[r * COLS + q] = 1;
  return c;
})();
const COST = [1, 3, Infinity];

export const DEMO_TEXT: Record<Algo, string> = {
  bfs: 'Breadth-First explores in rings: everything one step away, then two, then three. It finds the route with the fewest steps, but it ignores that shallow water is slow.',
  dfs: 'Depth-First dives down one direction as far as it can and only backs up at a dead end. It finds a route, often a long, strange one.',
  ucs: 'Uniform Cost spreads out by cost, like a ripple: it always explores the cheapest square so far. It finds the cheapest route, but explores almost everything.',
  greedy: 'Greedy Best-First always steps to the square that looks closest to G (straight-line distance h). It is fast, but it ignores the cost so far, so it can walk through slow water.',
  astar: 'A* explores the square with the smallest f = g + h: cost so far plus straight-line distance still to go. It heads for G and still finds the cheapest route.',
};

export const RUN: Record<Algo, typeof astar> = { astar, ucs, greedy, bfs, dfs };

/** The grid as a search graph; each move costs the square you step onto. */
export function gridGraph(): { g: SearchGraph; cost: (e: number) => number } {
  const n = COLS * ROWS;
  const adjStart = new Int32Array(n + 1);
  const adjNode: number[] = [], adjEdge: number[] = [], edgeCost: number[] = [];
  for (let v = 0; v < n; v++) {
    adjStart[v] = adjNode.length;
    if (CELLS[v] === 2) continue;
    const q = v % COLS, r = (v - q) / COLS;
    for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nq = q + dq, nr = r + dr;
      if (nq < 0 || nr < 0 || nq >= COLS || nr >= ROWS) continue;
      const u = nr * COLS + nq;
      if (CELLS[u] === 2) continue;
      adjEdge.push(edgeCost.length);
      edgeCost.push(COST[CELLS[u]]);
      adjNode.push(u);
    }
  }
  adjStart[n] = adjNode.length;
  return {
    g: { n, x: Float64Array.from({ length: n }, (_, v) => v % COLS), y: Float64Array.from({ length: n }, (_, v) => Math.floor(v / COLS)), adjStart, adjNode: Int32Array.from(adjNode), adjEdge: Int32Array.from(adjEdge) },
    cost: (e) => edgeCost[e],
  };
}

export interface SearchDemo {
  el: HTMLElement;
  play(algo: Algo): void;
  destroy(): void;
}

export function createSearchDemo(): SearchDemo {
  const canvas = h('canvas', { class: 'demo-canvas', role: 'img', 'aria-label': 'Animated grid showing the order in which the search explores squares' });
  const caption = h('p', { class: 'demo-caption' });
  const facts = h('p', { class: 'demo-facts mono' });
  const replay = h('button', { class: 'btn', type: 'button' }, 'Replay');
  const key = h(
    'p',
    { class: 'demo-key' },
    h('span', { class: 'k-start' }, 'S'), ' start ',
    h('span', { class: 'k-goal' }, 'G'), ' goal ',
    h('span', { class: 'k-deep' }), ' deep water ',
    h('span', { class: 'k-shallow' }), ' shallow (slow) ',
    h('span', { class: 'k-seen' }), ' explored',
  );
  const el = h('div', { class: 'search-demo' }, canvas, key, caption, facts, h('div', { class: 'cluster' }, replay));
  const { g, cost } = gridGraph();
  const s = S[1] * COLS + S[0], goal = G[1] * COLS + G[0];
  const heuristic = (v: number) => Math.hypot(g.x[v] - G[0], g.y[v] - G[1]);
  const best = ucs({ graph: g, start: s, goal, cost }).cost;
  let current: Algo = 'astar';
  let order: number[] = [];
  let result: SearchResult | null = null;
  let t0 = 0;
  let raf = 0;
  const DURATION = 2400;

  replay.addEventListener('click', () => play(current));

  function play(algo: Algo) {
    current = algo;
    order = [];
    result = RUN[algo]({ graph: g, start: s, goal, cost, heuristic }, (e) => {
      if (e.type === 'expand') order.push(e.node);
    });
    caption.textContent = DEMO_TEXT[algo];
    const r = result;
    facts.textContent = r.found ? `Explored ${order.length} squares · route cost ${r.cost}${r.cost > best ? ` (the cheapest is ${best})` : ' (the cheapest possible)'}` : 'No route';
    t0 = performance.now();
    cancelAnimationFrame(raf);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) t0 -= DURATION * 2;
    frame();
  }

  function frame() {
    const p = Math.min(1, (performance.now() - t0) / DURATION);
    draw(p);
    if (p < 1) raf = requestAnimationFrame(frame);
  }

  function draw(progress: number) {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(200, rect.width || 320);
    const cell = W / COLS;
    const H = cell * ROWS;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pal = paletteAnimator.get();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Squares.
    for (let v = 0; v < CELLS.length; v++) {
      const q = v % COLS, r = (v - q) / COLS;
      const x = q * cell, y = r * cell;
      if (CELLS[v] === 2) {
        ctx.fillStyle = css(mix(pal.primary, pal.text, 0.45));
        ctx.fillRect(x, y, cell, cell);
      } else if (CELLS[v] === 1) {
        ctx.fillStyle = css(mix(pal.background, pal.secondary, 0.55));
        ctx.fillRect(x, y, cell, cell);
        // Hatched: water you can wade through, slowly.
        ctx.strokeStyle = css(mix(pal.secondary, pal.text, 0.35), 0.6);
        ctx.lineWidth = 1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cell, cell);
        ctx.clip();
        ctx.beginPath();
        for (let k = -cell; k < 2 * cell; k += 5) {
          ctx.moveTo(x + k, y + cell);
          ctx.lineTo(x + k + cell, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    // Explored squares, in order, with the newest one ringed.
    const shown = Math.floor(order.length * Math.min(1, progress / 0.8));
    for (let k = 0; k < shown; k++) {
      const v = order[k];
      const q = v % COLS, r = (v - q) / COLS;
      ctx.fillStyle = css(mix(pal.accent, pal.text, 0.25), 0.55);
      ctx.fillRect(q * cell + 2, r * cell + 2, cell - 4, cell - 4);
    }
    if (shown > 0 && shown < order.length) {
      const v = order[shown - 1];
      const q = v % COLS, r = (v - q) / COLS;
      ctx.strokeStyle = css(pal.text);
      ctx.lineWidth = 2;
      ctx.strokeRect(q * cell + 1.5, r * cell + 1.5, cell - 3, cell - 3);
    }
    // Grid lines.
    ctx.strokeStyle = css(pal.text, 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let q = 0; q <= COLS; q++) {
      ctx.moveTo(q * cell + 0.5, 0);
      ctx.lineTo(q * cell + 0.5, H);
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.moveTo(0, r * cell + 0.5);
      ctx.lineTo(W, r * cell + 0.5);
    }
    ctx.stroke();
    // The route, once the search is done.
    if (progress >= 0.8 && result?.found) {
      const a = Math.min(1, (progress - 0.8) / 0.2);
      const pts = result.path.slice(0, Math.max(2, Math.ceil(result.path.length * a)));
      ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
      ctx.lineWidth = Math.max(3, cell * 0.28);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((v, i) => {
        const x = (v % COLS) * cell + cell / 2, y = Math.floor(v / COLS) * cell + cell / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // S and G.
    const mark = (q: number, r: number, label: string, filled: boolean) => {
      const x = q * cell + cell / 2, y = r * cell + cell / 2;
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = css(filled ? pal.text : pal.background);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = css(pal.text);
      ctx.stroke();
      ctx.fillStyle = css(filled ? pal.background : pal.text);
      ctx.font = `700 ${Math.round(cell * 0.5)}px "Instrument Sans", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 1);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    };
    mark(S[0], S[1], 'S', true);
    mark(G[0], G[1], 'G', false);
  }

  const ro = new ResizeObserver(() => draw(Math.min(1, (performance.now() - t0) / DURATION)));
  ro.observe(canvas);

  return {
    el,
    play,
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}
