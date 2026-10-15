/**
 * Bayes: the flood-risk Bayesian network, explorable.
 *
 *   - The network drawn as a graph. Every node shows its posterior as three
 *     small bars; click a state (or press 1-3 on a focused node) to observe
 *     it, click again (or press 0) to clear it.
 *   - Exact inference two ways, enumeration and variable elimination, with
 *     both numbers side by side and the work each did.
 *   - Likelihood weighting: the estimate against the number of samples, with
 *     the exact answer as a dashed line.
 *   - d-separation: "are A and B independent given Z?", every trail listed
 *     with why it is active or blocked, plus a numerical check.
 *   - The CPTs as editable tables, validated row by row.
 * The real neighbourhoods of the map can be loaded as evidence.
 */
import { mumbaiNetwork, V, drainClassIndex, elevClass } from '../ai/bayes/cpt';
import { dSeparated, explainTrails } from '../ai/bayes/dsep';
import { enumerationAsk, evidenceProbability, variableElimination, type Posterior, type VEResult } from '../ai/bayes/exact';
import { rowCount, rowParents, validate, type CptProblem, type Evidence, type Network } from '../ai/bayes/network';
import { likelihoodWeighting, type LWResult } from '../ai/bayes/sampling';
import { Rng } from '../core/rng';
import { replaceParams, type Page } from '../core/router';
import { fmtInt, fmtNum } from '../core/units';
import { createSegmented, type Segmented } from '../ui/controls/segmented';
import { announce, h } from '../ui/dom';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { Neighbourhood } from '../world/types';
import { loadMumbai } from '../world/worldClient';
import { pageHead } from './_shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 180;
const NODE_H = 92;
/** Top-left corner of each node in the 900 x 470 drawing. */
const LAYOUT: Record<number, [number, number]> = {
  [V.Rain]: [250, 10],
  [V.Drainage]: [520, 10],
  [V.Elevation]: [710, 150],
  [V.RainGauge]: [10, 170],
  [V.RiverLevel]: [250, 190],
  [V.RiverGauge]: [10, 370],
  [V.FloodRisk]: [520, 370],
};

const SCENES: { label: string; hint: string; rain: number; river: number }[] = [
  { label: 'Dry afternoon', hint: 'Rain gauge light, river gauge low', rain: 0, river: 0 },
  { label: 'Heavy shower', hint: 'Rain gauge moderate, river gauge normal', rain: 1, river: 1 },
  { label: '26 July 2005, peak', hint: 'Rain gauge heavy, river gauge high', rain: 2, river: 2 },
  { label: 'Gauges disagree', hint: 'Rain gauge heavy, but the river gauge reads low', rain: 2, river: 0 },
];

const HOOD_PICKS = [/dharavi/i, /kurla west/i, /bandra kurla/i, /kalina/i, /sion east/i, /^mahim/i, /bandra west/i, /chembur/i];

const LW_N = 100_000;
const LW_RUNS = 5;

const page: Page = {
  title: 'Bayes',
  mount({ root, params: query, signal }) {
    let net: Network = mumbaiNetwork();
    const evidence: Evidence = parseEvidence(query.get('ev'), net);
    let selected: number = V.FloodRisk;
    let problems: CptProblem[] = validate(net);
    let ve: VEResult[] = [];
    let en: Posterior[] = [];
    let priors: Posterior[] = [];
    let pEvidence = 1;
    let timings = { en: 0, ve: 0, enOps: 0, veOps: 0 };
    let lwQuery: number = V.FloodRisk, lwState = 2, lwSeed = 1;
    let dsA: number = V.Rain, dsB: number = V.Drainage;
    const dsZ = new Set<number>();
    let showTrail = true;
    let hoods: Neighbourhood[] = [];
    let lwTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Graph ──
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 900 470');
    svg.setAttribute('class', 'bn-graph');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'The flood-risk Bayesian network. Each node shows its current probabilities.');
    const graphNote = h('p', { class: 'small muted' }, 'Click a state to observe it; click it again to clear. With a node focused: 1, 2, 3 observe a state, 0 clears, Enter shows its table.');

    // ── Side panel ──
    const statusEl = h('div', { class: 'bn-status', role: 'status', 'aria-live': 'polite' });
    const nodeTitle = h('h3', { class: 'bn-node-title' });
    const nodeAbout = h('p', { class: 'small muted' });
    const evidenceHost = h('div');
    const nodeTable = h('div', { class: 'table-scroll' });
    const methodNote = h('p', { class: 'small muted' });
    const sceneCtl = createSegmented<string>({
      label: 'Gauge readings',
      value: '',
      options: SCENES.map((s, i) => ({ value: String(i), label: s.label, hint: s.hint })),
      onChange: (v) => {
        const s = SCENES[Number(v)];
        evidence.set(V.RainGauge, s.rain);
        evidence.set(V.RiverGauge, s.river);
        update();
        announce(`Gauges set: ${s.hint}.`);
      },
    });
    const hoodHost = h('div', null, h('p', { class: 'small muted' }, 'Loading the neighbourhoods of the map'));
    const hoodNote = h('p', { class: 'small muted', 'aria-live': 'polite' });
    const clearBtn = h('button', { class: 'btn', type: 'button' }, 'Clear all evidence');
    clearBtn.addEventListener('click', () => {
      evidence.clear();
      sceneCtl.set('' as string, true);
      hoodNote.textContent = '';
      update();
      announce('All evidence cleared.');
    });

    const side = h(
      'div',
      { class: 'bn-side' },
      statusEl,
      nodeTitle,
      nodeAbout,
      evidenceHost,
      nodeTable,
      methodNote,
      h('div', { class: 'bn-side-block' }, sceneCtl.el),
      h('div', { class: 'bn-side-block' }, hoodHost, hoodNote),
      h('div', { class: 'cluster', style: 'margin-top: var(--s-3)' }, clearBtn),
    );

    // ── Exact inference table ──
    const exactHost = h('div', { class: 'table-scroll' });
    const exactNote = h('p', { class: 'small muted' });

    // ── Likelihood weighting ──
    const lwVarCtl = createSegmented<string>({
      label: 'Estimate',
      value: String(lwQuery),
      options: net.vars.map((v, i) => ({ value: String(i), label: v.name })),
      onChange: (v) => {
        lwQuery = Number(v);
        lwState = Math.min(lwState, net.vars[lwQuery].states.length - 1);
        buildLwStateCtl();
        runLW();
      },
    });
    const lwStateHost = h('div');
    let lwStateCtl: Segmented<string> | null = null;
    const lwChart = h('div', { class: 'lw-chart' });
    const lwSummary = h('p', { class: 'small' });
    const resampleBtn = h('button', { class: 'btn', type: 'button' }, 'Draw new samples');
    resampleBtn.addEventListener('click', () => {
      lwSeed++;
      runLW();
    });

    // ── d-separation ──
    const dsACtl = createSegmented<string>({ label: 'Is', value: String(dsA), options: net.vars.map((v, i) => ({ value: String(i), label: v.name })), onChange: (v) => { dsA = Number(v); renderDsep(); renderGraph(); } });
    const dsBCtl = createSegmented<string>({ label: 'independent of', value: String(dsB), options: net.vars.map((v, i) => ({ value: String(i), label: v.name })), onChange: (v) => { dsB = Number(v); renderDsep(); renderGraph(); } });
    const zWords = h('div', { class: 'wordset', role: 'group', 'aria-label': 'Given (observed set Z)' });
    const zButtons = net.vars.map((v, i) => {
      const b = h('button', { class: 'opt', type: 'button', 'aria-pressed': 'false' }, v.name);
      b.addEventListener('click', () => {
        if (dsZ.has(i)) dsZ.delete(i);
        else dsZ.add(i);
        renderDsep();
        renderGraph();
      });
      zWords.append(b);
      return b;
    });
    const useEvBtn = h('button', { class: 'btn', type: 'button' }, 'Use the evidence above as Z');
    useEvBtn.addEventListener('click', () => {
      dsZ.clear();
      for (const k of evidence.keys()) dsZ.add(k);
      renderDsep();
      renderGraph();
    });
    const trailToggleBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'true' }, 'Show the trail on the graph');
    trailToggleBtn.addEventListener('click', () => {
      showTrail = !showTrail;
      trailToggleBtn.setAttribute('aria-pressed', String(showTrail));
      trailToggleBtn.textContent = showTrail ? 'Show the trail on the graph' : 'Trail hidden on the graph';
      renderGraph();
    });
    const dsVerdict = h('p', { class: 'ds-verdict', 'aria-live': 'polite' });
    const dsTrails = h('ol', { class: 'notes ds-trails' });
    const dsCheck = h('p', { class: 'small muted' });

    // ── CPT editor ──
    const cptVarCtl = createSegmented<string>({
      label: 'Table for',
      value: String(selected),
      options: net.vars.map((v, i) => ({ value: String(i), label: v.name })),
      onChange: (v) => selectNode(Number(v), false),
    });
    const cptErrors = h('div', { class: 'cpt-errors', 'aria-live': 'polite' });
    const cptHost = h('div', { class: 'cpt-scroll' });
    const normBtn = h('button', { class: 'btn', type: 'button' }, 'Normalise this table');
    const resetBtn = h('button', { class: 'btn', type: 'button' }, 'Reset every table to the defaults');
    normBtn.addEventListener('click', () => {
      const v = net.vars[selected];
      const k = v.states.length;
      for (let r = 0; r < rowCount(net, selected); r++) {
        let sum = 0;
        for (let s = 0; s < k; s++) sum += Math.max(0, Number.isFinite(v.cpt[r * k + s]) ? v.cpt[r * k + s] : 0);
        for (let s = 0; s < k; s++) {
          const x = Math.max(0, Number.isFinite(v.cpt[r * k + s]) ? v.cpt[r * k + s] : 0);
          v.cpt[r * k + s] = sum > 0 ? x / sum : 1 / k;
        }
      }
      renderCpt();
      cptChanged();
    });
    resetBtn.addEventListener('click', () => {
      net = mumbaiNetwork();
      renderCpt();
      cptChanged();
      announce('All tables reset to the default values.');
    });

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Reasoning under uncertainty', 'Bayes', 'Rain and the river level are hidden; we only see two noisy gauges. A Bayesian network turns those readings, plus what we know about each neighbourhood, into a probability of flooding.'),
        h('section', { class: 'bn-explorer', 'aria-label': 'Network explorer' }, h('div', { class: 'bn-graph-col' }, h('div', { class: 'bn-graph-wrap' }, svg), graphNote), side),
        h(
          'section',
          { class: 'section margin-grid' },
          h('p', { class: 'marker' }, 'exact'),
          h('div', null, h('h2', null, 'Exact inference, two ways'), h('p', null, 'Enumeration sums the full joint distribution over every hidden variable. Variable elimination sums the same thing, but multiplies only the factors that mention a variable before summing it out, so each sub-product is computed once. They must agree to the last digit; the work they do does not.'), exactHost, exactNote),
          h('p', { class: 'annot' }, 'Both normalise at the end; elimination also rescales every intermediate factor so long products cannot underflow. If the evidence has probability zero, both stop and say so instead of dividing by zero. On seven nodes the clock time is mostly bookkeeping; the operation count is what explodes for enumeration as networks grow.'),
        ),
        h(
          'section',
          { class: 'section margin-grid' },
          h('p', { class: 'marker' }, 'sampling'),
          h('div', null, h('h2', null, 'Likelihood weighting'), h('p', null, 'Draw samples top-down from the network, fixing the observed variables instead of sampling them, and weight each sample by how likely the observations were. The weighted fraction converges to the exact answer, roughly like one over the square root of the number of samples.'), lwVarCtl.el, lwStateHost, lwChart, lwSummary, h('div', { class: 'cluster' }, resampleBtn)),
          h('p', { class: 'annot' }, `Five independent runs of ${fmtInt(LW_N)} samples each, seeded so they are reproducible. When the evidence is unlikely, most weights are tiny and the effective sample size falls far below N.`),
        ),
        h(
          'section',
          { class: 'section margin-grid' },
          h('p', { class: 'marker' }, 'd-sep'),
          h(
            'div',
            null,
            h('h2', null, 'Conditional independence'),
            h('p', null, 'd-separation answers from the graph alone, for any numbers in the tables. A trail between two nodes carries influence unless some node on it blocks it: an observed node in a chain or fork blocks, an unobserved collider blocks, and observing a collider (or anything below it) opens it.'),
            dsACtl.el,
            dsBCtl.el,
            h('div', { class: 'ctl' }, h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, 'given (observed set Z)')), zWords),
            h('div', { class: 'cluster', style: 'margin: var(--s-2) 0 var(--s-4)' }, useEvBtn, trailToggleBtn),
            dsVerdict,
            dsTrails,
            dsCheck,
          ),
          h('p', { class: 'annot' }, 'The check is the efficient "Bayes-ball" search; the list of trails is enumerated separately to explain it. A test checks the two always agree.'),
        ),
        h(
          'section',
          { class: 'section' },
          h('div', { class: 'margin-grid' }, h('p', { class: 'marker' }, 'tables'), h('div', null, h('h2', null, 'Conditional probability tables'), h('p', null, 'Every row is a distribution over the node given one combination of its parents, so it must sum to 1. Edit any number; rows that do not sum to 1 are hatched and inference pauses until they do. The FloodRisk rows come from an ordered logistic score: rain and low ground weigh most.')), h('p', { class: 'annot' }, 'Edits here only affect this page. The Simulator always uses the default tables.')),
          cptVarCtl.el,
          cptErrors,
          cptHost,
          h('div', { class: 'cluster', style: 'margin-top: var(--s-3)' }, normBtn, resetBtn),
        ),
        h(
          'section',
          { class: 'section margin-grid' },
          h('p', { class: 'marker' }, 'live'),
          h('div', null, h('h2', null, 'In the Simulator'), h('p', null, 'Every 10 simulated minutes the two gauges report. Each misreads with exactly the probabilities in its table, drawn from a stream seeded by the scenario seed and the minute, so a rewind replays the same readings. The network then gives P(FloodRisk = high) for every combination of drainage and elevation; each neighbourhood is hatched by its own value, and each road gets a flood probability that combines its row with the water already on it. Risk-aware A* multiplies travel time by 1 + lambda times that probability.'), h('p', null, h('a', { href: '#/simulator?strategy=risk' }, 'Open the Simulator with risk-aware routing'))),
          h('p', { class: 'annot' }, 'On 26 July 2005 (default seed) risk-aware routing cuts the slowest 5% of trips from about 108 to 73 minutes compared with plain dynamic A*, sheltering the same number of people.'),
        ),
      ),
    );

    // ── Inference ──
    function compute() {
      problems = validate(net);
      if (problems.length) {
        ve = [];
        en = [];
        return;
      }
      const empty: Evidence = new Map();
      priors = net.vars.map((_, x) => variableElimination(net, x, empty));
      // Time each method over every query, a few repetitions for a stable figure.
      const reps = 10;
      let t0 = performance.now();
      for (let r = 0; r < reps; r++) en = net.vars.map((_, x) => enumerationAsk(net, x, evidence));
      const tEn = (performance.now() - t0) / reps;
      t0 = performance.now();
      for (let r = 0; r < reps; r++) ve = net.vars.map((_, x) => variableElimination(net, x, evidence));
      const tVe = (performance.now() - t0) / reps;
      timings = { en: tEn, ve: tVe, enOps: en.reduce((a, p) => a + p.ops, 0), veOps: ve.reduce((a, p) => a + p.ops, 0) };
      pEvidence = evidenceProbability(net, evidence);
    }

    const impossible = () => !problems.length && ve.some((p) => p.impossible);

    function update() {
      compute();
      renderStatus();
      renderGraph();
      renderSide();
      renderExact();
      renderDsep();
      scheduleLW();
      syncURL();
    }

    function syncURL() {
      const ev = [...evidence].sort((a, b) => a[0] - b[0]).map(([x, s]) => `${net.vars[x].name}.${net.vars[x].states[s]}`).join(',');
      replaceParams(ev ? { ev } : {});
    }

    function renderStatus() {
      if (problems.length) {
        statusEl.dataset.state = 'error';
        statusEl.textContent = `The network is invalid: ${problems.length} table row${problems.length > 1 ? 's do' : ' does'} not sum to 1. Inference is paused until the tables below are fixed.`;
      } else if (impossible()) {
        statusEl.dataset.state = 'error';
        statusEl.textContent = 'Impossible evidence: with these tables, no situation produces all of these observations together, so P(evidence) = 0 and there is nothing to normalise. Clear one observation.';
      } else {
        statusEl.dataset.state = 'ok';
        statusEl.textContent = evidence.size ? `${evidence.size} observation${evidence.size > 1 ? 's' : ''}. P(evidence) = ${fmtP(pEvidence, 5)}.` : 'No evidence yet: every node shows its prior.';
      }
    }

    // ── Graph drawing ──
    function renderGraph() {
      const parts: string[] = [];
      parts.push(`<defs><marker id="bn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9" fill="none" stroke="var(--text)" stroke-opacity=".55" stroke-width="1.4"/></marker><marker id="bn-arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L9 5L0 9" fill="none" stroke="var(--accent-ink)" stroke-width="1.8"/></marker></defs>`);
      // Which edges and nodes to highlight for d-separation.
      const ds = dsA !== dsB ? dSeparated(net, dsA, dsB, dsZ) : null;
      const hiEdges = new Set<string>();
      let blockedNode = -1;
      let dashed = false;
      if (showTrail && ds) {
        let trail = ds.trail;
        if (ds.separated) {
          const t = explainTrails(net, dsA, dsB, dsZ)[0];
          trail = t ? t.nodes : null;
          blockedNode = t ? t.blockedAt : -1;
          dashed = true;
        }
        if (trail) for (let i = 0; i + 1 < trail.length; i++) hiEdges.add(edgeKey(trail[i], trail[i + 1]));
      }
      net.vars.forEach((v, c) => {
        for (const p of v.parents) {
          const [a, b] = connector(p, c);
          const hi = hiEdges.has(edgeKey(p, c));
          parts.push(`<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" class="bn-edge${hi ? ' hi' : ''}${hi && dashed ? ' dashed' : ''}" marker-end="url(#${hi ? 'bn-arrow-hi' : 'bn-arrow'})"/>`);
        }
      });
      const bad = problems.length > 0 || impossible();
      net.vars.forEach((v, x) => {
        const [nx, ny] = LAYOUT[x];
        const obs = evidence.get(x);
        const dist = bad ? null : ve[x]?.dist;
        const prior = bad ? null : priors[x]?.dist;
        const isSel = x === selected;
        const inDs = showTrail && ds && (x === dsA || x === dsB);
        const label = `${v.name}${obs !== undefined ? `, observed ${v.states[obs]}` : ''}. ${dist ? v.states.map((s, i) => `${s} ${fmtNum(dist[i], 2)}`).join(', ') : 'no probabilities'}. Press 1 to ${v.states.length} to observe a state, 0 to clear.`;
        parts.push(`<g class="bn-node${isSel ? ' sel' : ''}${obs !== undefined ? ' obs' : ''}" data-node="${x}" tabindex="0" role="button" aria-label="${esc(label)}" transform="translate(${nx} ${ny})">`);
        parts.push(`<rect class="bn-hit" x="-6" y="-4" width="${NODE_W + 12}" height="${NODE_H + 8}"/>`);
        parts.push(`<text class="bn-name" x="0" y="17">${esc(v.name)}${obs !== undefined ? `<tspan class="bn-obs" dx="8">= ${esc(v.states[obs])}</tspan>` : ''}</text>`);
        if (inDs) parts.push(`<text class="bn-tag" x="${NODE_W}" y="17" text-anchor="end">${x === dsA ? 'A' : 'B'}</text>`);
        if (showTrail && dsZ.has(x)) parts.push(`<text class="bn-tag" x="${NODE_W}" y="${inDs ? 0 : 17}" text-anchor="end">in Z</text>`);
        parts.push(`<line class="bn-rule${isSel ? ' sel' : ''}" x1="0" y1="25" x2="${NODE_W}" y2="25"/>`);
        if (x === blockedNode) parts.push(`<line class="bn-block" x1="0" y1="${NODE_H + 2}" x2="${NODE_W}" y2="${NODE_H + 2}"/><text class="bn-tag" x="${NODE_W}" y="${NODE_H + 15}" text-anchor="end">blocks the trail</text>`);
        const bx = 74, bw = NODE_W - bx - 44;
        v.states.forEach((s, i) => {
          const y = 32 + i * 20;
          const p = dist ? dist[i] : 0;
          const on = obs === i;
          parts.push(`<g class="bn-state${on ? ' on' : ''}" data-state="${i}">`);
          parts.push(`<rect class="bn-hit" x="-4" y="${y - 2}" width="${NODE_W + 8}" height="20"/>`);
          parts.push(`<text class="bn-s" x="0" y="${y + 12}">${esc(s)}</text>`);
          parts.push(`<line class="bn-track" x1="${bx}" y1="${y + 8}" x2="${bx + bw}" y2="${y + 8}"/>`);
          if (dist) parts.push(`<rect class="bn-bar${on ? ' on' : ''}" x="${bx}" y="${y + 3}" width="${Math.max(p > 0 ? 1 : 0, p * bw).toFixed(1)}" height="10"/>`);
          if (prior && obs === undefined) parts.push(`<line class="bn-prior" x1="${(bx + prior[i] * bw).toFixed(1)}" y1="${y + 1}" x2="${(bx + prior[i] * bw).toFixed(1)}" y2="${y + 15}"/>`);
          parts.push(`<text class="bn-v" x="${NODE_W}" y="${y + 12}" text-anchor="end">${dist ? fmtNum(p, 2) : '–'}</text>`);
          parts.push('</g>');
        });
        parts.push('</g>');
      });
      // Re-rendering replaces the nodes; keep keyboard focus on the same one.
      const focusNode = svg.contains(document.activeElement) ? (document.activeElement as Element).getAttribute('data-node') : null;
      svg.innerHTML = parts.join('');
      if (focusNode) (svg.querySelector(`[data-node="${focusNode}"]`) as SVGGElement | null)?.focus();
    }

    function connector(p: number, c: number): [[number, number], [number, number]] {
      const [ax, ay] = LAYOUT[p], [bx, by] = LAYOUT[c];
      const ca: [number, number] = [ax + NODE_W / 2, ay + NODE_H / 2], cb: [number, number] = [bx + NODE_W / 2, by + NODE_H / 2];
      return [exitPoint(ca, cb, 10), exitPoint(cb, ca, 12)];
    }

    // Clicks and keys on the graph (event delegation; the SVG is re-rendered).
    svg.addEventListener('click', (e) => {
      const t = e.target as Element;
      const node = t.closest('[data-node]');
      if (!node) return;
      const x = Number(node.getAttribute('data-node'));
      const st = t.closest('[data-state]');
      if (st) toggleEvidence(x, Number(st.getAttribute('data-state')));
      else selectNode(x, true);
    });
    svg.addEventListener('keydown', (e) => {
      const node = (e.target as Element).closest('[data-node]');
      if (!node) return;
      const x = Number(node.getAttribute('data-node'));
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectNode(x, true);
      } else if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') {
        evidence.delete(x);
        selected = x;
        update();
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= net.vars[x].states.length) {
        selected = x;
        evidence.set(x, Number(e.key) - 1);
        update();
      }
    });

    function toggleEvidence(x: number, s: number) {
      if (evidence.get(x) === s) evidence.delete(x);
      else evidence.set(x, s);
      selected = x;
      update();
      const v = net.vars[x];
      announce(evidence.has(x) ? `${v.name} observed as ${v.states[s]}.` : `${v.name} is no longer observed.`);
    }

    function selectNode(x: number, syncCpt: boolean) {
      selected = x;
      if (syncCpt) cptVarCtl.set(String(x), true);
      renderGraph();
      renderSide();
      renderCpt();
    }

    // ── Side panel ──
    function renderSide() {
      const v = net.vars[selected];
      nodeTitle.textContent = v.name;
      nodeAbout.textContent = v.about;
      const opts = [{ value: '-1', label: 'unknown' }, ...v.states.map((s, i) => ({ value: String(i), label: s }))];
      const evCtl = createSegmented<string>({
        label: `Observe ${v.name}`,
        value: String(evidence.get(selected) ?? -1),
        options: opts,
        onChange: (val) => {
          const s = Number(val);
          if (s < 0) evidence.delete(selected);
          else evidence.set(selected, s);
          update();
        },
      });
      evidenceHost.replaceChildren(evCtl.el);
      const dist = ve[selected]?.dist, dEn = en[selected]?.dist, prior = priors[selected]?.dist;
      if (!dist || !dEn) {
        nodeTable.replaceChildren(h('p', { class: 'small muted' }, 'No probabilities until the problem above is fixed.'));
        methodNote.textContent = '';
        return;
      }
      nodeTable.replaceChildren(
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'State'), h('th', { class: 'num' }, 'Prior'), h('th', { class: 'num' }, 'Enumeration'), h('th', { class: 'num' }, 'Elimination'))),
          h('tbody', null, ...v.states.map((s, i) => h('tr', null, h('td', null, s), h('td', { class: 'num muted' }, prior ? fmtP(prior[i]) : ''), h('td', { class: 'num' }, fmtP(dEn[i])), h('td', { class: 'num' }, fmtP(dist[i]))))),
        ),
      );
      const r = ve[selected];
      const order = r.order.map((i) => net.vars[i].name);
      methodNote.textContent = `Elimination for ${v.name}: ${r.pruned.length ? `pruned ${r.pruned.map((i) => net.vars[i].name).join(', ')} as irrelevant; ` : ''}${order.length ? `summed out ${order.join(', ')} in that order (fewest neighbours first)` : 'nothing hidden to sum out'}; largest factor ${r.maxFactor} entries; ${fmtInt(r.ops)} operations against ${fmtInt(en[selected].ops)} for enumeration.`;
    }

    // ── Exact table ──
    function renderExact() {
      if (!ve.length || impossible()) {
        exactHost.replaceChildren(h('p', { class: 'small muted' }, problems.length ? 'Paused: the tables are invalid.' : 'No answer: the evidence is impossible.'));
        exactNote.textContent = '';
        return;
      }
      let maxDiff = 0;
      const rows: HTMLElement[] = [];
      net.vars.forEach((v, x) => {
        v.states.forEach((s, i) => {
          const a = en[x].dist![i], b = ve[x].dist![i];
          maxDiff = Math.max(maxDiff, Math.abs(a - b));
          rows.push(
            h(
              'tr',
              { class: i === 0 ? 'group-start' : null },
              h('td', null, i === 0 ? v.name + (evidence.has(x) ? ' (observed)' : '') : ''),
              h('td', null, s),
              h('td', { class: 'num muted' }, fmtP(priors[x].dist![i])),
              h('td', { class: 'num' }, fmtP(a)),
              h('td', { class: 'num' }, fmtP(b)),
              h('td', { class: 'num muted' }, Math.abs(a - b).toExponential(0)),
            ),
          );
        });
      });
      exactHost.replaceChildren(
        h(
          'table',
          { class: 'data exact-table' },
          h('thead', null, h('tr', null, h('th', null, 'Variable'), h('th', null, 'State'), h('th', { class: 'num' }, 'Prior'), h('th', { class: 'num' }, 'Enumeration'), h('th', { class: 'num' }, 'Elimination'), h('th', { class: 'num' }, 'Difference'))),
          h('tbody', null, ...rows),
        ),
      );
      exactNote.textContent = `All ${net.vars.length} posteriors: enumeration ${fmtInt(timings.enOps)} operations in ${fmtNum(timings.en, 3)} ms, variable elimination ${fmtInt(timings.veOps)} operations in ${fmtNum(timings.ve, 3)} ms. Largest difference ${maxDiff.toExponential(1)}.`;
    }

    // ── Likelihood weighting ──
    function buildLwStateCtl() {
      lwStateCtl = createSegmented<string>({
        label: `${net.vars[lwQuery].name} =`,
        value: String(lwState),
        options: net.vars[lwQuery].states.map((s, i) => ({ value: String(i), label: s })),
        onChange: (v) => {
          lwState = Number(v);
          runLW();
        },
      });
      lwStateHost.replaceChildren(lwStateCtl.el);
    }

    function scheduleLW() {
      if (lwTimer) clearTimeout(lwTimer);
      lwTimer = setTimeout(() => {
        lwTimer = null;
        if (!signal.aborted) runLW();
      }, 120);
    }

    function runLW() {
      if (problems.length || impossible()) {
        lwChart.replaceChildren(h('p', { class: 'small muted' }, problems.length ? 'Paused: the tables are invalid.' : 'No samples carry any weight: the evidence is impossible.'));
        lwSummary.textContent = '';
        return;
      }
      const exact = ve[lwQuery].dist![lwState];
      const runs: LWResult[] = [];
      for (let r = 0; r < LW_RUNS; r++) runs.push(likelihoodWeighting(net, lwQuery, evidence, LW_N, new Rng(`lw::${lwSeed}::${r}`)));
      lwChart.replaceChildren(lwPlot(runs, lwState, exact, `${net.vars[lwQuery].name} = ${net.vars[lwQuery].states[lwState]}`));
      const main = runs[0];
      const last = main.checkpoints[main.checkpoints.length - 1];
      const spread = runs.map((r) => r.dist![lwState]);
      lwSummary.textContent = `After ${fmtInt(LW_N)} samples: ${fmtP(last.dist[lwState])} (exact ${fmtP(exact)}); the five runs range from ${fmtP(Math.min(...spread))} to ${fmtP(Math.max(...spread))}. Effective sample size ${fmtInt(main.ess)} of ${fmtInt(LW_N)}.`;
    }

    // ── d-separation ──
    function renderDsep() {
      zButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(dsZ.has(i))));
      const A = net.vars[dsA].name, B = net.vars[dsB].name;
      const zText = dsZ.size ? `{${[...dsZ].sort((a, b) => a - b).map((i) => net.vars[i].name).join(', ')}}` : 'nothing';
      if (dsA === dsB) {
        dsVerdict.textContent = 'Pick two different variables.';
        dsTrails.replaceChildren();
        dsCheck.textContent = '';
        return;
      }
      if (dsZ.has(dsA) || dsZ.has(dsB)) {
        dsVerdict.textContent = `${dsZ.has(dsA) ? A : B} is itself in Z: once it is observed it is a constant, so the question is trivial (independent).`;
        dsTrails.replaceChildren();
        dsCheck.textContent = '';
        return;
      }
      const r = dSeparated(net, dsA, dsB, dsZ);
      const trails = explainTrails(net, dsA, dsB, dsZ);
      dsVerdict.replaceChildren(
        h('strong', null, r.separated ? 'Independent. ' : 'Not independent. '),
        r.separated ? `${A} and ${B} are d-separated given ${zText}: every trail between them is blocked.` : `${A} and ${B} are connected given ${zText} by at least one active trail.`,
      );
      dsTrails.replaceChildren(...trails.map((t) => h('li', null, h('span', { class: 'mono' }, trailText(t.nodes)), ` ${t.reason}`)));
      // Numerical check: does learning B change our belief about A?
      if (problems.length) {
        dsCheck.textContent = '';
        return;
      }
      const zEv: Evidence = new Map();
      for (const z of dsZ) zEv.set(z, evidence.get(z) ?? 0);
      const base = variableElimination(net, dsA, zEv);
      if (!base.dist) {
        dsCheck.textContent = 'Numerical check skipped: the observed values chosen for Z are impossible together.';
        return;
      }
      let maxDiff = 0;
      for (let b = 0; b < net.vars[dsB].states.length; b++) {
        const e2 = new Map(zEv);
        e2.set(dsB, b);
        const d = variableElimination(net, dsA, e2).dist;
        if (!d) continue;
        for (let i = 0; i < d.length; i++) maxDiff = Math.max(maxDiff, Math.abs(d[i] - base.dist[i]));
      }
      const zVals = [...zEv].map(([z, s]) => `${net.vars[z].name} = ${net.vars[z].states[s]}`).join(', ');
      dsCheck.textContent = `Numerical check${zVals ? ` (with ${zVals})` : ''}: the largest change in P(${A}) from also learning ${B} is ${maxDiff < 1e-12 ? '0' : fmtNum(maxDiff, 4)}.${r.separated ? '' : ' Not zero, as d-separation predicts it may not be.'}`;
    }

    function trailText(nodes: number[]): string {
      let s = net.vars[nodes[0]].name;
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1], b = nodes[i];
        s += net.vars[b].parents.includes(a) ? ' → ' : ' ← ';
        s += net.vars[b].name;
      }
      return s;
    }

    // ── CPT editor ──
    function renderCpt() {
      const x = selected;
      const v = net.vars[x];
      const k = v.states.length;
      const rows = rowCount(net, x);
      const badRows = new Map(problems.filter((p) => p.variable === x).map((p) => [p.row, p]));
      const head = h('tr', null, ...v.parents.map((p) => h('th', null, net.vars[p].name)), ...v.states.map((s) => h('th', { class: 'num' }, `P(${s})`)), h('th', { class: 'num' }, 'Sum'));
      const body: HTMLElement[] = [];
      for (let r = 0; r < rows; r++) {
        const ps = rowParents(net, x, r);
        const sumCell = h('td', { class: 'num sum' });
        const tr = h('tr', { class: badRows.has(r) ? 'bad' : null }, ...ps.map((s, i) => h('td', null, net.vars[v.parents[i]].states[s])));
        const inputs: HTMLInputElement[] = [];
        for (let s = 0; s < k; s++) {
          const inp = h('input', { class: 'cpt-cell', type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off', value: fmtCell(v.cpt[r * k + s]), 'aria-label': `P(${v.name} = ${v.states[s]}${ps.length ? ` | ${ps.map((ps_, i) => `${net.vars[v.parents[i]].name} = ${net.vars[v.parents[i]].states[ps_]}`).join(', ')}` : ''})` });
          inp.addEventListener('input', () => {
            const val = inp.value.trim() === '' ? NaN : Number(inp.value);
            v.cpt[r * k + s] = val;
            showSum();
            cptChanged(false);
          });
          inp.addEventListener('change', () => renderCpt());
          inputs.push(inp);
          tr.append(h('td', { class: 'num' }, inp));
        }
        const showSum = () => {
          let sum = 0;
          for (let s = 0; s < k; s++) sum += v.cpt[r * k + s];
          const ok = Number.isFinite(sum) && Math.abs(sum - 1) <= 1e-9 && inputs.every((_, s) => v.cpt[r * k + s] >= 0 && v.cpt[r * k + s] <= 1);
          sumCell.textContent = Number.isFinite(sum) ? sum.toFixed(sum === 1 ? 2 : 4) : 'not a number';
          if (!ok) sumCell.append(h('span', { class: 'must' }, ' must be 1'));
          tr.classList.toggle('bad', !ok);
        };
        showSum();
        tr.append(sumCell);
        body.push(tr);
      }
      cptHost.replaceChildren(h('table', { class: 'data cpt-table' }, h('caption', { class: 'visually-hidden' }, `Conditional probability table of ${v.name}`), h('thead', null, head), h('tbody', null, ...body)));
      renderCptErrors();
    }

    function renderCptErrors() {
      if (!problems.length) {
        cptErrors.replaceChildren(h('p', { class: 'small muted' }, `All ${net.vars.reduce((a, _, i) => a + rowCount(net, i), 0)} rows across the ${net.vars.length} tables are valid distributions.`));
        return;
      }
      const shown = problems.slice(0, 4);
      cptErrors.replaceChildren(h('p', { class: 'small cpt-error-line' }, `${problems.length} invalid row${problems.length > 1 ? 's' : ''}: ${shown.map((p) => p.message).join(' ')}${problems.length > shown.length ? ' And more.' : ''}`));
    }

    /** A table changed: re-validate and recompute everything except (optionally) the table itself. */
    function cptChanged(redrawTable = true) {
      compute();
      renderStatus();
      renderGraph();
      renderSide();
      renderExact();
      renderDsep();
      scheduleLW();
      if (redrawTable) renderCpt();
      else renderCptErrors();
    }

    // ── Neighbourhoods from the real map ──
    loadMumbai({ ...DEFAULT_MUMBAI, gridSize: 128 }).then(
      (w) => {
        if (signal.aborted) return;
        hoods = HOOD_PICKS.map((re) => w.hoods.find((hd) => re.test(hd.name))).filter((hd): hd is Neighbourhood => !!hd);
        const ctl = createSegmented<string>({
          label: 'Load a neighbourhood (sets Drainage and Elevation)',
          value: '',
          options: hoods.map((hd, i) => ({ value: String(i), label: hd.name, hint: `${hd.drainageClass} drainage, ${fmtNum(hd.meanElev, 1)} m` })),
          onChange: (v) => {
            const hd = hoods[Number(v)];
            const e = elevClass(hd.meanElev);
            evidence.set(V.Drainage, drainClassIndex(hd.drainageClass));
            evidence.set(V.Elevation, e);
            hoodNote.textContent = `${hd.name}: ${hd.drainageClass} drainage, mean ground ${fmtNum(hd.meanElev, 1)} m above sea, so Elevation = ${net.vars[V.Elevation].states[e]}. About ${fmtInt(hd.population)} people there would need a relief centre.`;
            update();
          },
        });
        hoodHost.replaceChildren(ctl.el);
      },
      () => hoodHost.replaceChildren(h('p', { class: 'small muted' }, 'The map could not be loaded, so neighbourhood evidence is unavailable. Everything else works.')),
    );

    buildLwStateCtl();
    update();
    renderCpt();
    runLW();

    return () => {
      if (lwTimer) clearTimeout(lwTimer);
    };
  },
};

// ─────────────────────────── Helpers ───────────────────────────

function lwPlot(runs: LWResult[], state: number, exact: number, what: string): SVGSVGElement {
  const W = 640, H = 260, L = 46, R = 14, T = 12, B = 34;
  const x = (n: number) => L + ((Math.log10(n) - 1) / (Math.log10(LW_N) - 1)) * (W - L - R);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const parts: string[] = [];
  for (const p of [0, 0.25, 0.5, 0.75, 1]) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="grid"/><text x="${L - 8}" y="${y(p) + 4}" text-anchor="end" class="tick">${p.toFixed(2)}</text>`);
  for (let e = 1; e <= Math.log10(LW_N); e++) parts.push(`<line x1="${x(10 ** e)}" x2="${x(10 ** e)}" y1="${T}" y2="${H - B}" class="grid"/><text x="${x(10 ** e)}" y="${H - B + 18}" text-anchor="middle" class="tick">${fmtInt(10 ** e)}</text>`);
  parts.push(`<text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" class="tick">samples N (log scale)</text>`);
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(exact)}" y2="${y(exact)}" class="exact"/><text x="${W - R}" y="${y(exact) - 6}" text-anchor="end" class="tick">exact ${exact.toFixed(4)}</text>`);
  runs.forEach((r, i) => {
    const pts = r.checkpoints.filter((c) => Number.isFinite(c.dist[state])).map((c) => `${x(c.n).toFixed(1)},${y(c.dist[state]).toFixed(1)}`);
    if (pts.length) parts.push(`<polyline points="${pts.join(' ')}" class="${i === 0 ? 'run main' : 'run'}"/>`);
    if (i === 0) for (const c of r.checkpoints) if (Number.isFinite(c.dist[state])) parts.push(`<circle cx="${x(c.n).toFixed(1)}" cy="${y(c.dist[state]).toFixed(1)}" r="2.6" class="dot"/>`);
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Likelihood weighting estimate of P(${what}) against the number of samples, five runs, converging to the exact value ${exact.toFixed(4)}.`);
  svg.innerHTML = parts.join('');
  return svg;
}

/** Where the line from `a` towards `b` leaves the node box centred on `a` (plus padding). */
function exitPoint(a: [number, number], b: [number, number], pad: number): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const hw = NODE_W / 2 + pad, hh = NODE_H / 2 + pad;
  const t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return [a[0] + dx * t, a[1] + dy * t];
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function fmtP(p: number, digits = 4): string {
  return Number.isFinite(p) ? p.toFixed(digits) : 'n/a';
}

function fmtCell(p: number): string {
  if (!Number.isFinite(p)) return '';
  return String(Math.round(p * 1e6) / 1e6);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Evidence from the URL, e.g. "RainGauge.heavy,Elevation.low". Unknown names are ignored. */
function parseEvidence(raw: string | null, net: Network): Evidence {
  const ev: Evidence = new Map();
  if (!raw) return ev;
  for (const part of raw.split(',')) {
    const [name, state] = part.split('.');
    const x = net.vars.findIndex((v) => v.name === name);
    if (x < 0) continue;
    const s = net.vars[x].states.indexOf(state);
    if (s >= 0) ev.set(x, s);
  }
  return ev;
}

export default page;
