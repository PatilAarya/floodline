/**
 * Algorithms: a race between BFS, DFS, Uniform Cost Search, Greedy
 * Best-First and A* on the real Mumbai road graph, optionally flooded.
 *
 * Each algorithm is run once with its event callback recording every step;
 * the panels then replay those steps at the same rate, so you can watch A*
 * head straight for the goal while UCS ripples out in every direction.
 * Timings in the table come from separate runs without the recording.
 */
import { astar } from '../ai/search/astar';
import { bfs } from '../ai/search/bfs';
import { graphOf, makeCost, makeHeuristic, maxSpeed } from '../ai/search/cost';
import { dfs } from '../ai/search/dfs';
import { greedy } from '../ai/search/greedy';
import type { SearchEvent, SearchGraph, SearchProblem, SearchResult } from '../ai/search/types';
import { ucs } from '../ai/search/ucs';
import { replaceParams, type Page } from '../core/router';
import { clamp, fmtInt, fmtMinutes, fmtNum, parseClamped } from '../core/units';
import { edgeToPath } from '../render/canvas/roads';
import type { DrawCtx } from '../render/canvas/types';
import { css, mix, paletteAnimator } from '../render/theme';
import { buildEdgeTable, computeEdgeStates, waterLevelFlood, type EdgeTable, type TravelMode } from '../sim/hydrology';
import { barChart } from '../ui/charts/bars';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { createToggle } from '../ui/controls/toggle';
import { announce, h } from '../ui/dom';
import { createMapView } from '../ui/mapView';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { World } from '../world/types';
import { loadMumbai } from '../world/worldClient';
import { pageHead } from './_shared';

type AlgoId = 'bfs' | 'dfs' | 'ucs' | 'greedy' | 'astar' | 'bad';

interface AlgoInfo {
  id: AlgoId;
  name: string;
  how: string;
  run: (p: SearchProblem, on?: (e: SearchEvent) => void) => SearchResult;
  usesH: boolean;
  dash: number[];
}

const INFLATE = 4;

const ALGOS: AlgoInfo[] = [
  { id: 'bfs', name: 'Breadth-First', how: 'FIFO queue. Fewest road segments, ignores travel time.', run: bfs, usesH: false, dash: [7, 4] },
  { id: 'dfs', name: 'Depth-First', how: 'LIFO stack. Follows one road as far as it can.', run: dfs, usesH: false, dash: [2, 3] },
  { id: 'ucs', name: 'Uniform Cost', how: 'Cheapest g first. Optimal, but searches every direction.', run: ucs, usesH: false, dash: [] },
  { id: 'greedy', name: 'Greedy Best-First', how: 'Smallest h first. Fast, can be lured the wrong way.', run: greedy, usesH: true, dash: [9, 3, 2, 3] },
  { id: 'astar', name: 'A*', how: 'Smallest g + h first. Optimal and focused.', run: astar, usesH: true, dash: [] },
  { id: 'bad', name: `A*, h x ${INFLATE}`, how: 'Overestimating heuristic: inadmissible, may miss the best route.', run: astar, usesH: true, dash: [4, 2] },
];

/** Start/goal presets on real places: neighbourhood -> relief centre. */
const PRESETS: { label: string; from: RegExp; to: RegExp }[] = [
  { label: 'Dharavi to SIES College', from: /dharavi/i, to: /SIES/i },
  { label: 'Kurla West to TISS', from: /kurla west/i, to: /TISS|Tata Institute/i },
  { label: 'Bandra East to NMIMS', from: /bandra east/i, to: /Narsee|NMIMS/i },
  { label: 'Kalina to Dadar Vidya Mandir', from: /kalina/i, to: /Dadar Vidya/i },
];

/** Recorded events, compactly: kind (0 expand, 1 frontier) and node. */
interface Recording {
  kind: Uint8Array;
  node: Int32Array;
  result: SearchResult;
  timedMs: number;
}

const page: Page = {
  title: 'Algorithms',
  mount({ root, params: query, signal }) {
    let world: World | null = null;
    let graph: SearchGraph | null = null;
    let table: EdgeTable | null = null;
    let state: Uint8Array | undefined;
    let depthOver: Float32Array | undefined;
    let start = -1, goal = -1;
    let picking: 'start' | 'goal' = 'start';
    let level = parseClamped(query.get('level'), 0, 0, 6);
    // Cars: roads close at 30 cm of water.
    const travel: TravelMode = 'vehicle';
    let showBad = query.get('bad') === '1';
    let rate = 12;
    let recordings: Partial<Record<AlgoId, Recording>> = {};
    let raf = 0;
    let cursor = 0;

    // ── Map (pick start and goal) ──
    const status = h('div', { class: 'map-status', role: 'status' }, 'Loading the Mumbai road network');
    const map = createMapView({
      label: 'Map for choosing a start and a goal',
      onTap: (wx, wy) => {
        if (!world) return true;
        const v = nearestNode(wx, wy);
        if (v < 0) return true;
        if (picking === 'start') {
          start = v;
          picking = 'goal';
        } else {
          goal = v;
          picking = 'start';
        }
        pickNote.textContent = picking === 'start' ? 'Next tap sets the start.' : 'Next tap sets the goal.';
        clearRace();
        return true;
      },
      drawExtra: (d) => drawMainOverlay(d),
    });
    map.setLayers({ hoods: false, streets: true });
    const pickNote = h('p', { class: 'small muted', 'aria-live': 'polite' }, 'Tap the map to set a start, then a goal, or choose a preset.');

    // ── Controls ──
    const presetCtl = createSegmented<string>({
      label: 'Preset',
      value: '0',
      options: PRESETS.map((p, i) => ({ value: String(i), label: p.label })),
      onChange: (v) => applyPreset(Number(v)),
    });
    const levelSlider = createSlider({
      label: 'Flood water level',
      min: 0, max: 6, step: 0.5, value: level, ticks: 13,
      format: (v) => (v === 0 ? 'dry roads' : `${v.toFixed(1)} m above sea`),
      onChange: (v) => {
        level = v;
        applyFlood();
        syncURL();
      },
    });
    const badToggle = createToggle({
      label: `Add A* with a bad heuristic (h x ${INFLATE})`,
      value: showBad,
      onChange: (v) => {
        showBad = v;
        buildPanels();
        clearRace();
        syncURL();
      },
    });
    const speedCtl = createSegmented<string>({
      label: 'Replay speed',
      value: '12',
      options: [
        { value: '3', label: 'Slow' },
        { value: '12', label: 'Normal' },
        { value: '60', label: 'Fast' },
        { value: '1000000', label: 'Instant' },
      ],
      onChange: (v) => (rate = Number(v)),
    });
    const raceBtn = h('button', { class: 'btn btn-primary btn-large', type: 'button' }, 'Race');
    const resetBtn = h('button', { class: 'btn', type: 'button' }, 'Clear');
    raceBtn.addEventListener('click', () => race());
    resetBtn.addEventListener('click', () => clearRace());

    const controls = h(
      'div',
      { class: 'algo-controls' },
      h('div', null, presetCtl.el, pickNote),
      h('div', null, levelSlider.el),
      h('div', null, badToggle.el),
      h('div', null, speedCtl.el, h('div', { class: 'cluster', style: 'margin-top: var(--s-3)' }, raceBtn, resetBtn)),
    );

    // ── Panels ──
    const raceEl = h('div', { class: 'race', 'aria-label': 'Search algorithms racing on the same graph' });
    interface Panel {
      algo: AlgoInfo;
      base: HTMLCanvasElement;
      over: HTMLCanvasElement;
      facts: HTMLElement;
      verdict: HTMLElement;
      drawn: number;
      expanded: number;
      generated: number;
      done: boolean;
    }
    let panels: Panel[] = [];
    function buildPanels() {
      const algos = ALGOS.filter((a) => a.id !== 'bad' || showBad);
      panels = algos.map((algo) => {
        const base = h('canvas', { 'aria-hidden': 'true' });
        const over = h('canvas', { 'aria-hidden': 'true' });
        const facts = h('dl', { class: 'facts' });
        const verdict = h('p', { class: 'verdict' });
        return { algo, base, over, facts, verdict, drawn: 0, expanded: 0, generated: 0, done: false };
      });
      raceEl.replaceChildren(
        ...panels.map((p) => h('section', { class: 'race-panel', 'aria-label': p.algo.name }, h('h3', null, p.algo.name), h('p', { class: 'how' }, p.algo.how), h('div', { class: 'race-canvas' }, p.base, p.over), p.facts, p.verdict)),
      );
    }
    buildPanels();

    const results = h('section', { class: 'section', 'aria-live': 'polite' });
    const markerLegend = h(
      'ul',
      { class: 'marker-legend' },
      h('li', null, h('span', { html: `<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5" fill="var(--text)"/><circle cx="11" cy="7" r="2" fill="var(--background)"/></svg>` }), 'Start'),
      h('li', null, h('span', { html: `<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5.5" fill="var(--background)" stroke="var(--text)" stroke-width="2"/><circle cx="11" cy="7" r="1.6" fill="var(--text)"/></svg>` }), 'Goal'),
      h('li', null, h('span', { html: `<svg viewBox="0 0 22 14"><circle cx="7" cy="7" r="2" fill="color-mix(in oklab, var(--accent) 60%, var(--text))"/><circle cx="15" cy="7" r="2" fill="color-mix(in oklab, var(--accent) 60%, var(--text))"/></svg>` }), 'Expanded node'),
      h('li', null, h('span', { html: `<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="3" fill="none" stroke="var(--primary)" stroke-width="1.3"/></svg>` }), 'On the frontier'),
      h('li', null, h('span', { html: `<svg viewBox="0 0 22 14"><path d="M1 7h20" stroke="color-mix(in oklab, var(--primary) 80%, var(--text))" stroke-width="3.5"/></svg>` }), 'Path found'),
    );

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Search', 'Five searches, one flooded road network', 'Pick a start and a goal on the real Mumbai road graph, flood it if you like, and race Breadth-First, Depth-First, Uniform Cost, Greedy Best-First and A*. Costs are travel times; closed roads cannot be used.'),
        h('div', { class: 'algo-map' }, map.el, status),
        controls,
        h('div', { style: 'padding: var(--s-3) 0' }, markerLegend),
        raceEl,
        results,
      ),
    );

    // ── Logic ──
    function syncURL() {
      const p: Record<string, string> = {};
      if (level > 0) p.level = String(level);
      if (showBad) p.bad = '1';
      replaceParams(p);
    }

    function nearestNode(x: number, y: number): number {
      if (!world) return -1;
      let best = -1, bestD = Infinity;
      for (const nd of world.graph.nodes) {
        if (world.graph.adjStart[nd.id + 1] === world.graph.adjStart[nd.id]) continue;
        const d = (nd.x - x) ** 2 + (nd.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = nd.id;
        }
      }
      return best;
    }

    function applyPreset(i: number) {
      const w = world;
      if (!w) return;
      const p = PRESETS[i];
      const hood = w.hoods.find((hd) => p.from.test(hd.name));
      const shelter = w.shelters.find((s) => p.to.test(s.name));
      start = hood && hood.accessNode >= 0 ? hood.accessNode : nearestNode(w.terrain.size * 0.3, w.terrain.size * 0.6);
      goal = shelter ? shelter.node : nearestNode(w.terrain.size * 0.7, w.terrain.size * 0.4);
      picking = 'start';
      pickNote.textContent = `${p.label}. Tap the map to choose your own start and goal.`;
      clearRace();
    }

    function applyFlood() {
      const w = world;
      if (!w || !table) return;
      if (level <= 0) {
        state = undefined;
        depthOver = undefined;
        map.setDepth(new Float32Array(w.terrain.n * w.terrain.n), null, { reset: true, intervalMs: 0 });
        map.setEdgeState(undefined);
      } else {
        const depth = waterLevelFlood(w, level);
        state = new Uint8Array(table.count);
        depthOver = new Float32Array(table.count);
        computeEdgeStates(table, depth, w.terrain.height, w.ground, travel, state, depthOver);
        map.setDepth(depth, null, { reset: true, intervalMs: 0 });
        map.setEdgeState(state);
      }
      clearRace();
    }

    function clearRace() {
      cancelAnimationFrame(raf);
      recordings = {};
      cursor = 0;
      for (const p of panels) {
        p.drawn = p.expanded = p.generated = 0;
        p.done = false;
        p.verdict.textContent = '';
        p.facts.replaceChildren();
      }
      results.replaceChildren();
      drawPanelBases();
      map.requestRender();
    }

    function problem(algo: AlgoInfo): SearchProblem {
      const w = world!, g = graph!;
      const cost = makeCost(w, { mode: travel, state, depth: depthOver });
      const vmax = maxSpeed(w, travel);
      const p: SearchProblem = { graph: g, start, goal, cost };
      if (algo.usesH) p.heuristic = makeHeuristic(g, goal, vmax, algo.id === 'bad' ? INFLATE : 1);
      return p;
    }

    function race() {
      if (!world || !graph || start < 0 || goal < 0) return;
      clearRace();
      for (const p of panels) {
        const kinds: number[] = [], nodes: number[] = [];
        const prob = problem(p.algo);
        const result = p.algo.run(prob, (e) => {
          if (e.type === 'expand') {
            kinds.push(0);
            nodes.push(e.node);
          } else if (e.type === 'frontier') {
            kinds.push(1);
            nodes.push(e.node);
          }
        });
        // Time a clean run (no recording overhead), best of three.
        let timed = Infinity;
        for (let k = 0; k < 3; k++) timed = Math.min(timed, p.algo.run(problem(p.algo)).ms);
        recordings[p.algo.id] = { kind: Uint8Array.from(kinds), node: Int32Array.from(nodes), result, timedMs: timed };
      }
      cursor = 0;
      animate();
      announce('Race started.');
    }

    function animate() {
      cursor += rate;
      let allDone = true;
      for (const p of panels) {
        const rec = recordings[p.algo.id];
        if (!rec) continue;
        drawPanelSteps(p, rec, Math.min(cursor, rec.kind.length));
        if (!p.done) allDone = false;
      }
      map.requestRender();
      if (!allDone && !signal.aborted) raf = requestAnimationFrame(animate);
      else showResults();
    }

    // Each panel shows the square around start and goal.
    function panelView() {
      const w = world!;
      const A = w.graph.nodes[start], B = w.graph.nodes[goal];
      const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2;
      const half = Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)) * 0.95 + 700;
      return { cx, cy, half };
    }

    function sizeCanvas(c: HTMLCanvasElement) {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const ctx = c.getContext('2d')!;
      const v = panelView();
      const s = Math.min(r.width, r.height) / (2 * v.half);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (r.width / 2 - v.cx * s), dpr * (r.height / 2 - v.cy * s));
      return { ctx, px: 1 / s, w: r.width, h: r.height };
    }

    function drawPanelBases() {
      const w = world;
      if (!w || start < 0 || goal < 0) {
        for (const p of panels) {
          for (const c of [p.base, p.over]) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
        }
        return;
      }
      const pal = paletteAnimator.get();
      const v = panelView();
      for (const p of panels) {
        const { ctx, px } = sizeCanvas(p.base);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = css(mix(pal.background, pal.secondary, 0.12));
        ctx.fillRect(0, 0, p.base.width, p.base.height);
        ctx.restore();
        const open = new Path2D(), blocked = new Path2D();
        for (const e of w.graph.edges) {
          const A = w.graph.nodes[e.a], B = w.graph.nodes[e.b];
          if (Math.max(A.x, B.x) < v.cx - v.half * 1.2 || Math.min(A.x, B.x) > v.cx + v.half * 1.2 || Math.max(A.y, B.y) < v.cy - v.half * 1.2 || Math.min(A.y, B.y) > v.cy + v.half * 1.2) continue;
          edgeToPath(state && state[e.id] === 2 ? blocked : open, w.graph, e);
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = css(pal.text, 0.28);
        ctx.lineWidth = 1 * px;
        ctx.stroke(open);
        ctx.setLineDash([3 * px, 3 * px]);
        ctx.strokeStyle = css(pal.text, 0.75);
        ctx.lineWidth = 1.4 * px;
        ctx.stroke(blocked);
        ctx.setLineDash([]);
        const o = sizeCanvas(p.over);
        o.ctx.save();
        o.ctx.setTransform(1, 0, 0, 1, 0, 0);
        o.ctx.clearRect(0, 0, p.over.width, p.over.height);
        o.ctx.restore();
        drawEndpoints(o.ctx, o.px);
      }
    }

    function drawEndpoints(ctx: CanvasRenderingContext2D, px: number) {
      const w = world!, pal = paletteAnimator.get();
      const A = w.graph.nodes[start], B = w.graph.nodes[goal];
      ctx.beginPath();
      ctx.arc(A.x, A.y, 6 * px, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.text);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(A.x, A.y, 2.4 * px, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.background);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(B.x, B.y, 6.5 * px, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.background);
      ctx.fill();
      ctx.lineWidth = 2.2 * px;
      ctx.strokeStyle = css(pal.text);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(B.x, B.y, 1.8 * px, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.text);
      ctx.fill();
    }

    function drawPanelSteps(p: Panel, rec: Recording, upTo: number) {
      if (p.done) return;
      const w = world!, pal = paletteAnimator.get();
      const { ctx, px } = sizeCanvas(p.over);
      const exp = css(mix(pal.accent, pal.text, 0.4), 0.75);
      const fr = css(pal.primary, 0.9);
      for (let i = p.drawn; i < upTo; i++) {
        const nd = w.graph.nodes[rec.node[i]];
        ctx.beginPath();
        if (rec.kind[i] === 0) {
          p.expanded++;
          ctx.arc(nd.x, nd.y, 2 * px, 0, Math.PI * 2);
          ctx.fillStyle = exp;
          ctx.fill();
        } else {
          p.generated++;
          ctx.arc(nd.x, nd.y, 2.8 * px, 0, Math.PI * 2);
          ctx.strokeStyle = fr;
          ctx.lineWidth = 1 * px;
          ctx.stroke();
        }
      }
      p.drawn = upTo;
      const r = rec.result;
      const finished = upTo >= rec.kind.length;
      p.facts.replaceChildren(
        ...([
          ['Nodes expanded', fmtInt(p.expanded)],
          ['Pushed to frontier', fmtInt(p.generated)],
          ['Travel time', finished ? (r.found ? fmtMinutes(r.cost / 60) : 'no route') : '...'],
          ['Road segments', finished && r.found ? String(r.edges.length) : '...'],
        ] as [string, string][]).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
      );
      if (finished) {
        p.done = true;
        if (r.found) {
          const path = new Path2D();
          for (const e of r.edges) edgeToPath(path, w.graph, w.graph.edges[e], w.graph.edges[e].a !== r.path[r.edges.indexOf(e)]);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = css(pal.background, 0.95);
          ctx.lineWidth = 6 * px;
          ctx.stroke(path);
          ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
          ctx.lineWidth = 3.5 * px;
          ctx.stroke(path);
        }
        drawEndpoints(ctx, px);
      }
    }

    function showResults() {
      const recs = panels.map((p) => ({ p, r: recordings[p.algo.id] })).filter((x) => x.r) as { p: Panel; r: Recording }[];
      if (!recs.length) return;
      const best = recordings.ucs?.result.cost ?? Infinity;
      const isOpt = (c: number) => Number.isFinite(c) && Number.isFinite(best) && Math.abs(c - best) <= 1e-6 * Math.max(1, best);
      for (const { p, r } of recs) {
        const c = r.result.cost;
        p.verdict.textContent = !r.result.found ? 'no route' : isOpt(c) ? 'optimal' : `${fmtNum(((c - best) / best) * 100, 0)}% slower than optimal`;
      }
      const lengthKm = (r: SearchResult) => r.edges.reduce((s, e) => s + world!.graph.edges[e].length, 0) / 1000;
      const head = ['Algorithm', 'Route', 'Travel time', 'Distance', 'Segments', 'Expanded', 'Max frontier', 'Time'];
      const tbl = h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, ...head.map((t, i) => h('th', { class: i > 1 ? 'num' : null, scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          ...recs.map(({ p, r }) =>
            h(
              'tr',
              null,
              h('th', { scope: 'row' }, p.algo.name),
              h('td', null, !r.result.found ? 'none' : isOpt(r.result.cost) ? 'optimal' : 'not optimal'),
              h('td', { class: 'num' }, r.result.found ? fmtMinutes(r.result.cost / 60) : 'n/a'),
              h('td', { class: 'num' }, r.result.found ? `${fmtNum(lengthKm(r.result), 2)} km` : 'n/a'),
              h('td', { class: 'num' }, r.result.found ? String(r.result.edges.length) : 'n/a'),
              h('td', { class: 'num' }, fmtInt(r.result.expanded)),
              h('td', { class: 'num' }, fmtInt(r.result.frontierMax)),
              h('td', { class: 'num' }, `${fmtNum(r.timedMs, 2)} ms`),
            ),
          ),
        ),
      );
      const ast = recordings.astar?.result, uc = recordings.ucs?.result;
      const saving = ast && uc && uc.expanded > 0 ? Math.round((1 - ast.expanded / uc.expanded) * 100) : 0;
      const summary =
        uc && !uc.found
          ? 'No algorithm can reach the goal: every route is cut by floodwater. Lower the water level or pick another goal.'
          : `A* and Uniform Cost both found the optimal ${uc ? fmtMinutes(uc.cost / 60) : ''} route, but A* expanded ${saving}% fewer nodes because the heuristic points it at the goal. Breadth-First minimised road segments, not time; Depth-First took the first route it stumbled into; Greedy went straight for the goal and ${recordings.greedy && isOpt(recordings.greedy.result.cost) ? 'happened to be optimal this time' : 'paid for it in travel time'}.${showBad ? ` With the heuristic inflated ${INFLATE}x, A* ${recordings.bad && isOpt(recordings.bad.result.cost) ? 'was lucky and still optimal here; try another pair or a flood' : 'was no longer guaranteed optimal and indeed returned a slower route'}.` : ''}`;
      results.replaceChildren(
        h('p', { class: 'eyebrow' }, 'Result'),
        h('p', { class: 'lede', style: 'max-width: 68ch' }, summary),
        h('div', { style: 'overflow-x: auto; margin: var(--s-5) 0' }, tbl),
        barChart('Nodes expanded (lower is less work)', recs.map(({ p, r }) => ({ label: p.algo.name, value: r.result.expanded, text: fmtInt(r.result.expanded) }))),
        barChart(
          'Travel time of the route found (hatched: not optimal)',
          recs.map(({ p, r }) => ({ label: p.algo.name, value: r.result.found ? r.result.cost / 60 : NaN, text: r.result.found ? fmtMinutes(r.result.cost / 60) : 'no route', flag: r.result.found && !isOpt(r.result.cost) })),
        ),
      );
      announce(summary);
    }

    function drawMainOverlay(d: DrawCtx) {
      const w = world;
      if (!w) return;
      const { ctx, cam, pal } = d;
      const z = clamp(Math.sqrt(cam.zoom), 1, 3);
      // Paths found, A* strongest; others dashed so they can be told apart.
      for (const algo of [...ALGOS].reverse()) {
        const rec = recordings[algo.id];
        if (!rec?.result.found) continue;
        const p = new Path2D();
        rec.result.path.forEach((v, i) => {
          const [x, y] = cam.toScreen(w.graph.nodes[v].x, w.graph.nodes[v].y);
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        });
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (algo.id === 'astar') {
          ctx.strokeStyle = css(pal.background, 0.9);
          ctx.lineWidth = 6 * z;
          ctx.stroke(p);
          ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
          ctx.lineWidth = 4 * z;
        } else {
          ctx.setLineDash(algo.dash.map((x) => x * z));
          ctx.strokeStyle = css(mix(pal.accent, pal.text, 0.45));
          ctx.lineWidth = 2 * z;
        }
        ctx.stroke(p);
        ctx.restore();
      }
      for (const [v, isGoal] of [[start, false], [goal, true]] as [number, boolean][]) {
        if (v < 0) continue;
        const [x, y] = cam.toScreen(w.graph.nodes[v].x, w.graph.nodes[v].y);
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = css(isGoal ? pal.background : pal.text);
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = css(pal.text);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, isGoal ? 2.5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = css(isGoal ? pal.text : pal.background);
        ctx.fill();
      }
    }

    // ── Load ──
    loadMumbai({ ...DEFAULT_MUMBAI, gridSize: 128 }).then(
      (w) => {
        if (signal.aborted) return;
        world = w;
        graph = graphOf(w);
        table = buildEdgeTable(w);
        map.setWorld(w);
        status.hidden = true;
        applyPreset(0);
        applyFlood();
      },
      (err) => {
        status.textContent = `The road network could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
      },
    );

    const ro = new ResizeObserver(() => {
      drawPanelBases();
      for (const p of panels) {
        const rec = recordings[p.algo.id];
        if (rec) {
          p.drawn = p.expanded = p.generated = 0;
          p.done = false;
          drawPanelSteps(p, rec, Math.min(cursor, rec.kind.length));
        }
      }
    });
    ro.observe(raceEl);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      map.destroy();
    };
  },
};

export default page;
