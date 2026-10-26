/**
 * Bayes: the flood-risk Bayesian network, explorable.
 *
 * The network is drawn as a graph; every node shows its probabilities as
 * three small bars. Click a state to observe it (click again to clear), or
 * load a gauge scene or a real neighbourhood. The side panel shows the
 * selected node's probabilities computed two ways, by enumeration and by
 * variable elimination, which always agree.
 */
import { drainClassIndex, elevClass, mumbaiNetwork, V } from '../ai/bayes/cpt';
import { enumerationAsk, evidenceProbability, variableElimination, type Posterior, type VEResult } from '../ai/bayes/exact';
import type { Evidence, Network } from '../ai/bayes/network';
import { replaceParams, type Page } from '../core/router';
import { fmtInt, fmtNum } from '../core/units';
import { createSegmented } from '../ui/controls/segmented';
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

const page: Page = {
  title: 'Bayes',
  mount({ root, params: query, signal }) {
    const net: Network = mumbaiNetwork();
    const evidence: Evidence = parseEvidence(query.get('ev'), net);
    let selected: number = V.FloodRisk;
    let ve: VEResult[] = [];
    let en: Posterior[] = [];
    let priors: Posterior[] = [];
    let pEvidence = 1;
    let hoods: Neighbourhood[] = [];

    // ── Graph ──
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 900 470');
    svg.setAttribute('class', 'bn-graph');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'The flood-risk Bayesian network. Each node shows its current probabilities.');
    const graphNote = h('p', { class: 'small muted' }, 'Click a state to observe it; click it again to clear. With a node focused: 1, 2, 3 observe a state, 0 clears.');

    // ── Side panel ──
    const statusEl = h('div', { class: 'bn-status', role: 'status', 'aria-live': 'polite' });
    const nodeTitle = h('h3', { class: 'bn-node-title' });
    const nodeAbout = h('p', { class: 'small muted' });
    const nodeTable = h('div', { class: 'table-scroll' });
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

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Reasoning under uncertainty', 'Bayes', 'Rain and the river level are hidden; we only see two noisy gauges. A Bayesian network turns those readings, plus what we know about a neighbourhood (how low it lies, how well it drains), into a probability of flooding.'),
        h(
          'section',
          { class: 'bn-explorer', 'aria-label': 'Network explorer' },
          h('div', { class: 'bn-graph-col' }, h('div', { class: 'bn-graph-wrap' }, svg), graphNote),
          h('div', { class: 'bn-side' }, statusEl, nodeTitle, nodeAbout, nodeTable, h('div', { class: 'bn-side-block' }, sceneCtl.el), h('div', { class: 'bn-side-block' }, hoodHost, hoodNote), h('div', { class: 'cluster', style: 'margin-top: var(--s-3)' }, clearBtn)),
        ),
        h(
          'section',
          { class: 'section margin-grid' },
          h('p', { class: 'marker' }, 'how'),
          h(
            'div',
            null,
            h('h2', null, 'How the probabilities are computed'),
            h('p', null, 'Each arrow means "directly influences": rain raises the river; rain, a high river, poor drains and low ground all raise the flood risk; each gauge reads its hidden quantity, but not always correctly. Every node has a table of probabilities given its parents.'),
            h('p', null, 'To answer "how likely is a flood, given what the gauges say?", the network sums over everything it does not know (the true rain and river level). Enumeration does that sum term by term; variable elimination sums one hidden variable out at a time and reuses the partial results. Both give exactly the same numbers, shown side by side next to the graph; elimination just does less work.'),
          ),
          h('p', { class: 'annot' }, 'Rain classes follow Mumbai\'s storm-drain design standard of 25 mm/h; ground is "low" below 5 m above sea level. The gauges are right about 80 to 90% of the time.'),
        ),
      ),
    );

    // ── Inference ──
    function compute() {
      const empty: Evidence = new Map();
      priors = net.vars.map((_, x) => variableElimination(net, x, empty));
      en = net.vars.map((_, x) => enumerationAsk(net, x, evidence));
      ve = net.vars.map((_, x) => variableElimination(net, x, evidence));
      pEvidence = evidenceProbability(net, evidence);
    }

    const impossible = () => ve.some((p) => p.impossible);

    function update() {
      compute();
      renderStatus();
      renderGraph();
      renderSide();
      const ev = [...evidence].sort((a, b) => a[0] - b[0]).map(([x, s]) => `${net.vars[x].name}.${net.vars[x].states[s]}`).join(',');
      replaceParams(ev ? { ev } : {});
    }

    function renderStatus() {
      if (impossible()) {
        statusEl.dataset.state = 'error';
        statusEl.textContent = 'Impossible evidence: no situation produces all of these observations together, so there is nothing to compute. Clear one observation.';
        return;
      }
      statusEl.dataset.state = 'ok';
      const risk = ve[V.FloodRisk]?.dist;
      statusEl.textContent = evidence.size
        ? `${evidence.size} observation${evidence.size > 1 ? 's' : ''}.${risk ? ` P(flood risk high) = ${fmtNum(risk[2], 2)}.` : ''} P(evidence) = ${fmtP(pEvidence, 4)}.`
        : 'No evidence yet: every node shows its prior.';
    }

    function renderGraph() {
      const parts: string[] = [];
      parts.push(`<defs><marker id="bn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9" fill="none" stroke="var(--text)" stroke-opacity=".55" stroke-width="1.4"/></marker></defs>`);
      net.vars.forEach((v, c) => {
        for (const p of v.parents) {
          const [a, b] = connector(p, c);
          parts.push(`<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" class="bn-edge" marker-end="url(#bn-arrow)"/>`);
        }
      });
      const bad = impossible();
      net.vars.forEach((v, x) => {
        const [nx, ny] = LAYOUT[x];
        const obs = evidence.get(x);
        const dist = bad ? null : ve[x]?.dist;
        const prior = bad ? null : priors[x]?.dist;
        const isSel = x === selected;
        const label = `${v.name}${obs !== undefined ? `, observed ${v.states[obs]}` : ''}. ${dist ? v.states.map((s, i) => `${s} ${fmtNum(dist[i], 2)}`).join(', ') : 'no probabilities'}. Press 1 to ${v.states.length} to observe a state, 0 to clear.`;
        parts.push(`<g class="bn-node${isSel ? ' sel' : ''}${obs !== undefined ? ' obs' : ''}" data-node="${x}" tabindex="0" role="button" aria-label="${esc(label)}" transform="translate(${nx} ${ny})">`);
        parts.push(`<rect class="bn-hit" x="-6" y="-4" width="${NODE_W + 12}" height="${NODE_H + 8}"/>`);
        parts.push(`<text class="bn-name" x="0" y="17">${esc(v.name)}${obs !== undefined ? `<tspan class="bn-obs" dx="8">= ${esc(v.states[obs])}</tspan>` : ''}</text>`);
        parts.push(`<line class="bn-rule${isSel ? ' sel' : ''}" x1="0" y1="25" x2="${NODE_W}" y2="25"/>`);
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
      else {
        selected = x;
        renderGraph();
        renderSide();
      }
    });
    svg.addEventListener('keydown', (e) => {
      const node = (e.target as Element).closest('[data-node]');
      if (!node) return;
      const x = Number(node.getAttribute('data-node'));
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selected = x;
        renderGraph();
        renderSide();
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

    function renderSide() {
      const v = net.vars[selected];
      nodeTitle.textContent = v.name;
      nodeAbout.textContent = v.about;
      const dist = ve[selected]?.dist, dEn = en[selected]?.dist, prior = priors[selected]?.dist;
      if (!dist || !dEn) {
        nodeTable.replaceChildren(h('p', { class: 'small muted' }, 'No probabilities: the evidence is impossible.'));
        return;
      }
      nodeTable.replaceChildren(
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'State'), h('th', { class: 'num' }, 'Before evidence'), h('th', { class: 'num' }, 'Enumeration'), h('th', { class: 'num' }, 'Elimination'))),
          h('tbody', null, ...v.states.map((s, i) => h('tr', null, h('td', null, s), h('td', { class: 'num muted' }, prior ? fmtP(prior[i]) : ''), h('td', { class: 'num' }, fmtP(dEn[i])), h('td', { class: 'num' }, fmtP(dist[i]))))),
        ),
      );
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
            hoodNote.textContent = `${hd.name}: ${hd.drainageClass} drainage, mean ground ${fmtNum(hd.meanElev, 1)} m above sea, so Elevation = ${net.vars[V.Elevation].states[e]}. About ${fmtInt(hd.population)} people live in its low-lying homes.`;
            update();
          },
        });
        hoodHost.replaceChildren(ctl.el);
      },
      () => hoodHost.replaceChildren(h('p', { class: 'small muted' }, 'The map could not be loaded, so neighbourhood evidence is unavailable. Everything else works.')),
    );

    update();
  },
};

/** Where the line from `a` towards `b` leaves the node box centred on `a` (plus padding). */
function exitPoint(a: [number, number], b: [number, number], pad: number): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const hw = NODE_W / 2 + pad, hh = NODE_H / 2 + pad;
  const t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return [a[0] + dx * t, a[1] + dy * t];
}

function fmtP(p: number, digits = 4): string {
  return Number.isFinite(p) ? p.toFixed(digits) : 'n/a';
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
