/**
 * Assignment: who goes to which relief centre.
 *
 *   1. The whole basin as a CSP: every evacuee group must get a centre that
 *      is open, reachable, safe enough and within the deadline, and no
 *      centre may be over capacity. Solved by backtracking with forward
 *      checking and MRV / degree / LCV (each switchable). Changing the flood,
 *      the deadline or the centres re-solves at once (warm-started from the
 *      previous plan) and lists what changed. When there is no solution the
 *      page says why and shows a relaxed plan.
 *   2. A small instance whose search tree is drawn step by step.
 *   3. Simulated annealing against hill climbing, both starting from the
 *      CSP plan, with the energy plot and a final comparison.
 *
 * All the algorithms live in src/ai/csp and src/ai/local; this file only
 * drives them and draws what they report.
 */
import { solveCSP, type CSPEvent, type CSPResult, type SolveOptions } from '../ai/csp/backtracking';
import { UNASSIGNED } from '../ai/csp/model';
import { explainInfeasibility, maximisePartial, smallestRelaxation, type Explanation } from '../ai/csp/relax';
import type { Cooling } from '../ai/local/cooling';
import { HillClimber, type HCVariant } from '../ai/local/hillClimbing';
import { summarise, type PlanSummary } from '../ai/local/objective';
import { Annealer, type TracePoint } from '../ai/local/simulatedAnnealing';
import { replaceParams, type Page } from '../core/router';
import { clamp, fmtInt, fmtMinutes, fmtNum, parseClamped } from '../core/units';
import { shelterGlyph } from '../render/canvas/overlays';
import type { DrawCtx } from '../render/canvas/types';
import { FONT_MONO } from '../render/canvas/types';
import { css, mix } from '../render/theme';
import { buildInstance, explainGroup, prepareNetwork, Reason, type Instance, type InstanceParams, type PreparedNetwork } from '../sim/assignment';
import { buildEdgeTable, type EdgeTable } from '../sim/hydrology';
import { barChart } from '../ui/charts/bars';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { createToggle } from '../ui/controls/toggle';
import { announce, h } from '../ui/dom';
import { createMapView, type Selection } from '../ui/mapView';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { World } from '../world/types';
import { loadMumbai } from '../world/worldClient';
import { pageHead } from './_shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FULL_BUDGET = { maxNodes: 50_000, maxMs: 1_200 };
const LAB_BUDGET = { maxNodes: 2_000, maxMs: 1_000 };
/** The small instance: three neighbourhoods and their four nearest centres. */
const LAB_HOODS = [/^mahim/i, /matunga west/i, /indira nagar/i];

const SETTINGS: { label: string; o: Omit<SolveOptions, 'maxNodes' | 'maxMs'> }[] = [
  { label: 'Plain backtracking', o: { forwardChecking: false, mrv: false, degree: false, lcv: false } },
  { label: 'Backtracking + MRV', o: { forwardChecking: false, mrv: true, degree: false, lcv: false } },
  { label: 'Forward checking', o: { forwardChecking: true, mrv: false, degree: false, lcv: false } },
  { label: 'Forward checking + MRV', o: { forwardChecking: true, mrv: true, degree: false, lcv: false } },
  { label: 'FC + MRV + degree', o: { forwardChecking: true, mrv: true, degree: true, lcv: false } },
  { label: 'FC + MRV + degree + LCV', o: { forwardChecking: true, mrv: true, degree: true, lcv: true } },
];

type PlanKey = 'csp' | 'hc' | 'sa';

const page: Page = {
  title: 'Assignment',
  mount({ root, params: query, signal }) {
    let world: World | null = null;
    let table: EdgeTable | null = null;
    let prep: PreparedNetwork | null = null;
    let inst: Instance | null = null;
    let result: CSPResult | null = null;
    let explanation: Explanation | null = null;
    /** The plan shown: one centre index per group (-1 = none). */
    let plan: Int32Array | null = null;
    /** Previous plan by group id -> world shelter index (for the warm start and the diff). */
    let previous: Map<number, number> | null = null;
    let level = parseClamped(query.get('level'), 0, 0, 3);
    let deadline = parseClamped(query.get('deadline'), 40, 10, 120);
    let maxRisk = parseClamped(query.get('risk'), 1, 0.05, 1);
    let capScale = parseClamped(query.get('cap'), 1, 0.6, 1.5);
    const closed = new Set<number>(
      (query.get('closed') ?? '')
        .split(',')
        .map((s) => Number(s) - 1)
        .filter((i) => Number.isInteger(i) && i >= 0 && i < 20),
    );
    const opts = { forwardChecking: true, mrv: true, degree: true, lcv: true };
    let shown: PlanKey = 'csp';
    let selectedHood = -1;

    // ── Map ──
    const status = h('div', { class: 'map-status', role: 'status' }, 'Loading the Mumbai road network');
    const map = createMapView({
      label: 'Map of the evacuation plan: lines run from each neighbourhood to its relief centres, thicker for more people',
      onSelect: (sel) => onMapSelect(sel),
      drawExtra: (d) => drawPlan(d),
    });
    map.setLayers({ streets: false, labels: true });
    const mapNote = h('div', { class: 'asg-mapnote', 'aria-live': 'polite' }, h('p', { class: 'small muted' }, 'Tap a neighbourhood to see where its people go, or a relief centre to close or reopen it.'));

    // ── Controls ──
    const levelSlider = createSlider({
      label: 'Flood water level',
      min: 0, max: 3, step: 0.25, value: level, ticks: 13,
      format: (v) => (v === 0 ? 'dry (planning before the storm)' : `${v.toFixed(2)} m above sea`),
      onChange: (v) => {
        level = v;
        prepare();
        solve('The water level changed');
      },
    });
    const deadlineSlider = createSlider({
      label: 'Deadline (longest allowed trip)',
      min: 10, max: 120, step: 5, value: deadline,
      format: (v) => `${v} min`,
      onChange: (v) => {
        deadline = v;
        solve('The deadline changed');
      },
    });
    const riskSlider = createSlider({
      label: 'Highest flood risk allowed at a centre',
      min: 0.05, max: 1, step: 0.05, value: maxRisk,
      format: (v) => (v >= 1 ? 'no limit' : `P(high) at most ${v.toFixed(2)}`),
      onChange: (v) => {
        maxRisk = v;
        solve('The centre risk limit changed');
      },
    });
    const capSlider = createSlider({
      label: 'Centre capacity',
      min: 0.6, max: 1.5, step: 0.05, value: capScale,
      format: (v) => `${Math.round(v * 100)}% of the planned places`,
      onChange: (v) => {
        capScale = v;
        solve('Centre capacities changed');
      },
    });
    const centreWords = h('div', { class: 'wordset', role: 'group', 'aria-label': 'Relief centres: pressed means closed' });
    const toggles = (
      [
        ['forwardChecking', 'Forward checking'],
        ['mrv', 'MRV (fewest values left)'],
        ['degree', 'Degree (most constraints)'],
        ['lcv', 'LCV (least constraining value)'],
      ] as const
    ).map(([k, label]) =>
      createToggle({
        label,
        value: opts[k],
        onChange: (v) => {
          opts[k] = v;
          solve('The solver settings changed', false);
        },
      }),
    );

    const controls = h(
      'div',
      { class: 'algo-controls' },
      h('div', null, levelSlider.el, deadlineSlider.el),
      h('div', null, riskSlider.el, capSlider.el),
      h('div', null, h('div', { class: 'ctl' }, h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, 'Close a relief centre')), centreWords)),
      h('div', null, ...toggles.map((t) => t.el)),
    );

    // ── Result ──
    const verdict = h('p', { class: 'asg-verdict' });
    const why = h('div', { class: 'asg-why' });
    const relaxHost = h('div', { class: 'cluster' });
    const figuresHost = h('div', { class: 'figures asg-figures' });
    const diffHost = h('div', { class: 'asg-diff', 'aria-live': 'polite' });
    const compareBtn = h('button', { class: 'btn', type: 'button' }, 'Compare all six solver settings');
    const compareHost = h('div', { class: 'table-scroll' });
    compareBtn.addEventListener('click', () => compareSettings());

    // ── Search tree lab ──
    let labSetting = 0;
    let labDeadline = 18;
    let labRatio = 1.15;
    let labRate = 20;
    let labEvents: CSPEvent[] = [];
    let labResult: CSPResult | null = null;
    let labInst: Instance | null = null;
    let labCursor = 0;
    let labRaf = 0;
    let labLast = 0;
    const treeWrap = h('div', { class: 'tree-wrap' });
    const treeFacts = h('dl', { class: 'facts tree-facts' });
    const treePath = h('p', { class: 'small tree-path' });
    const treeVerdict = h('p', { class: 'asg-verdict small-verdict', 'aria-live': 'polite' });
    const labIntro = h('p', { class: 'small muted' });
    const labSettingCtl = createSegmented<string>({
      label: 'Solver',
      value: '0',
      options: [0, 2, 3, 5].map((i) => ({ value: String(i), label: SETTINGS[i].label })),
      onChange: (v) => {
        labSetting = Number(v);
        runLab();
      },
    });
    const labDeadlineSlider = createSlider({ label: 'Deadline', min: 12, max: 30, step: 1, value: labDeadline, format: (v) => `${v} min`, onChange: (v) => { labDeadline = v; runLab(); } });
    const labRatioSlider = createSlider({ label: 'Places for every person', min: 0.9, max: 1.5, step: 0.05, value: labRatio, format: (v) => `${v.toFixed(2)}`, onChange: (v) => { labRatio = v; runLab(); } });
    const labSpeedCtl = createSegmented<string>({
      label: 'Replay',
      value: '20',
      options: [
        { value: '5', label: 'Slow' },
        { value: '20', label: 'Normal' },
        { value: '120', label: 'Fast' },
        { value: '1000000', label: 'Instant' },
      ],
      onChange: (v) => {
        labRate = Number(v);
        if (labRate > 1e5) showLabTo(labEvents.length);
      },
    });
    const labPlay = h('button', { class: 'btn btn-primary', type: 'button' }, 'Replay');
    const labStep = h('button', { class: 'btn', type: 'button' }, 'Step');
    labPlay.addEventListener('click', () => playLab());
    labStep.addEventListener('click', () => {
      cancelAnimationFrame(labRaf);
      showLabTo(Math.min(labEvents.length, nextVisibleEvent(labCursor)));
    });

    // ── Local search ──
    let cooling: Cooling = 'geometric';
    let iterations = 300_000;
    let restarts = 1;
    let hcVariant: HCVariant = 'steepest';
    let lsSeed = 1;
    let sa: Annealer | null = null;
    let hc: HillClimber | null = null;
    let lsRaf = 0;
    let summaries: Partial<Record<PlanKey, PlanSummary>> = {};
    let plans: Partial<Record<PlanKey, Int32Array>> = {};
    const coolCtl = createSegmented<Cooling>({ label: 'Cooling', value: cooling, options: [{ value: 'geometric', label: 'Geometric', hint: 'T = T0 x alpha^k' }, { value: 'linear', label: 'Linear', hint: 'T = T0 x (1 - k/K)' }], onChange: (v) => (cooling = v) });
    const iterSlider = createSlider({ label: 'Annealing iterations', min: 20_000, max: 600_000, step: 20_000, value: iterations, format: (v) => fmtInt(v), onChange: (v) => (iterations = v) });
    const restartCtl = createSegmented<string>({ label: 'Restarts', value: '1', options: [{ value: '1', label: 'None' }, { value: '2', label: '2 runs' }, { value: '4', label: '4 runs' }], onChange: (v) => (restarts = Number(v)) });
    const hcCtl = createSegmented<HCVariant>({ label: 'Hill climbing', value: hcVariant, options: [{ value: 'steepest', label: 'Steepest', hint: 'Scan every neighbour, take the best' }, { value: 'first', label: 'First-choice', hint: 'Take the first random neighbour that is better' }], onChange: (v) => (hcVariant = v) });
    const lsRun = h('button', { class: 'btn btn-primary btn-large', type: 'button' }, 'Improve the plan');
    const lsSeedBtn = h('button', { class: 'btn', type: 'button' }, 'New random seed');
    lsRun.addEventListener('click', () => runLocal());
    lsSeedBtn.addEventListener('click', () => {
      lsSeed++;
      runLocal();
    });
    const lsSeedNote = h('span', { class: 'small muted mono' });
    const energyHost = h('div', { class: 'energy-chart' });
    const lsLive = h('p', { class: 'small', 'aria-live': 'polite' });
    const lsResults = h('div');
    const showCtl = createSegmented<PlanKey>({
      label: 'Plan on the map',
      value: 'csp',
      options: [{ value: 'csp', label: 'CSP' }, { value: 'hc', label: 'CSP + hill climbing' }, { value: 'sa', label: 'CSP + annealing' }],
      onChange: (v) => {
        if (!plans[v]) {
          showCtl.set(shown, true);
          announce('Run the local search first.');
          return;
        }
        shown = v;
        map.requestRender();
        renderHoodNote();
      },
    });

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Constraint satisfaction and local search', 'Who goes where', 'About 411,000 people in the low-lying parts of the Mithi basin are split into groups of up to 2,500. Each group needs a relief centre it can reach in time, and no centre may overflow. A constraint solver finds a valid plan; local search then makes it better.'),
        h('div', { class: 'algo-map' }, map.el, status),
        mapNote,
        controls,
        h(
          'section',
          { class: 'section margin-grid', 'aria-label': 'The constraint problem' },
          h('p', { class: 'marker' }, 'csp'),
          h(
            'div',
            null,
            h('h2', null, 'A plan that satisfies every constraint'),
            h('p', null, 'Variables are the evacuee groups, values are the ten relief centres. A group may only use a centre that is open, not flooded, reachable on roads that are still open, below the risk limit, and within the deadline: those are removed from its domain before the search starts. Capacity is the one constraint that ties groups together, and it is what the search has to juggle.'),
            verdict,
            why,
            relaxHost,
            figuresHost,
            diffHost,
            h('div', { class: 'cluster', style: 'margin-top: var(--s-4)' }, compareBtn),
            compareHost,
          ),
          h('p', { class: 'annot' }, `The search stops after ${fmtInt(FULL_BUDGET.maxNodes)} nodes or ${fmtNum(FULL_BUDGET.maxMs / 1000, 1)} s and keeps the best partial plan, so the page never freezes. When the world changes, the solver first tries each group's previous centre, so the new plan moves as few people as possible.`),
        ),
        h(
          'section',
          { class: 'section', 'aria-label': 'Search tree' },
          h(
            'div',
            { class: 'margin-grid' },
            h('p', { class: 'marker' }, 'tree'),
            h('div', null, h('h2', null, 'Watching the search'), h('p', null, 'On a small instance the whole search tree fits on screen. Each level assigns one group; each branch is one centre tried for it. Plain backtracking only notices a dead end when a group has nowhere left to go, and then backs up one level at a time. Forward checking crosses out options as soon as they become impossible, and MRV picks the group with the fewest options left, so trouble is found near the root.'), labIntro),
            h('p', { class: 'annot' }, 'A solid thick line is the current path. A dashed branch was rejected: the centre was already too full for that group. A hatched ring marks a wipeout: assigning it left some other group with no centre at all.'),
          ),
          h('div', { class: 'algo-controls' }, h('div', null, labSettingCtl.el), h('div', null, labDeadlineSlider.el, labRatioSlider.el), h('div', null, labSpeedCtl.el, h('div', { class: 'cluster', style: 'margin-top: var(--s-3)' }, labPlay, labStep))),
          treeVerdict,
          h('div', { class: 'tree-layout' }, treeWrap, h('div', null, treeFacts, treePath)),
        ),
        h(
          'section',
          { class: 'section', 'aria-label': 'Local search' },
          h(
            'div',
            { class: 'margin-grid' },
            h('p', { class: 'marker' }, 'local'),
            h(
              'div',
              null,
              h('h2', null, 'Making a valid plan a good one'),
              h('p', null, 'The constraint solver stops at the first plan that satisfies everything. Local search starts from that plan and keeps changing it a little: move one group to another allowed centre, or swap the centres of two groups. Each plan has an energy in person-minutes: travel time, time spent on flood-prone roads (times lambda = 2), a heavy charge for every person over capacity, a charge for uneven filling, and a charge for every extra centre a neighbourhood is split across.'),
              h('p', null, 'Hill climbing only accepts a change that lowers the energy, so it stops at the first dip it finds. Simulated annealing sometimes accepts a change for the worse, with probability exp(-dE / T); the temperature T falls as it goes, so it explores early and settles late.'),
            ),
            h('p', { class: 'annot' }, 'Both start from the CSP plan, use the same moves and are seeded, so a run is reproducible. The x axis counts moves evaluated, which is fair to both: steepest hill climbing evaluates thousands of moves for every step it takes.'),
          ),
          h('div', { class: 'algo-controls' }, h('div', null, coolCtl.el, restartCtl.el), h('div', null, iterSlider.el), h('div', null, hcCtl.el), h('div', null, h('div', { class: 'cluster' }, lsRun), h('div', { class: 'cluster', style: 'margin-top: var(--s-2)' }, lsSeedBtn, lsSeedNote))),
          energyHost,
          lsLive,
          lsResults,
          h('div', { style: 'margin-top: var(--s-5)' }, showCtl.el),
        ),
      ),
    );

    // ─────────────────────────── Full instance ───────────────────────────

    function params(): InstanceParams {
      return { deadline, maxRisk, capacityScale: capScale, closed: [...closed] };
    }

    function prepare() {
      if (!world || !table) return;
      prep = prepareNetwork(world, level, 'vehicle', table);
      map.setDepth(prep.depth, null, { reset: true, intervalMs: 0 });
      map.setEdgeState(level > 0 ? prep.edgeState : undefined);
    }

    function syncURL() {
      const p: Record<string, string> = {};
      if (level > 0) p.level = String(level);
      if (deadline !== 40) p.deadline = String(deadline);
      if (maxRisk < 1) p.risk = String(maxRisk);
      if (capScale !== 1) p.cap = String(capScale);
      if (closed.size) p.closed = [...closed].sort((a, b) => a - b).map((i) => i + 1).join(',');
      replaceParams(p);
    }

    /** Build the instance, check it, search, relax if needed, and report. */
    function solve(cause: string | null, worldChanged = true) {
      if (!prep) return;
      syncURL();
      inst = buildInstance(prep, params());
      const I = inst;
      explanation = explainInfeasibility(I.csp);
      // Warm start: each group's previous centre first.
      const prefer = new Int32Array(I.G).fill(UNASSIGNED);
      if (previous) I.groups.forEach((g, x) => {
        const s = previous!.get(g.id);
        if (s !== undefined && s >= 0) prefer[x] = I.centres.findIndex((c) => c.shelter === s);
      });
      // When counting already proves there is no plan, searching cannot help
      // (it would only run into its budget), so skip straight to relaxation.
      result = explanation.feasibleByCounting
        ? solveCSP(I.csp, { ...opts, ...FULL_BUDGET, prefer: previous ? prefer : undefined })
        : { status: 'infeasible', assignment: new Int32Array(I.G).fill(UNASSIGNED), placed: 0, nodes: 0, assignments: 0, backtracks: 0, prunes: 0, wipeouts: 0, maxDepth: 0, ms: 0, reason: 'proved by counting' };
      // No solution: show the relaxed plan that places as many people as possible.
      plan = result.status === 'solved' ? result.assignment : maximisePartial(I.csp, previous ? prefer : undefined).assignment;
      const before = previous;
      previous = new Map(I.groups.map((g, x) => [g.id, plan![x] >= 0 ? I.centres[plan![x]].shelter : -1]));
      renderCentreWords();
      renderVerdict();
      renderFigures();
      renderDiff(cause, worldChanged ? before : null);
      resetLocal();
      compareHost.replaceChildren();
      map.requestRender();
      renderHoodNote();
    }

    function renderCentreWords() {
      const w = world;
      if (!w || !prep) return;
      centreWords.replaceChildren(
        ...w.shelters.map((s, i) => {
          const b = h('button', { class: 'opt', type: 'button', 'aria-pressed': String(closed.has(i)), title: `${s.name}${prep!.centreFlooded[i] ? ' (flooded at this level)' : ''}` }, `S${i + 1}${prep!.centreFlooded[i] ? ' flooded' : ''}`);
          b.addEventListener('click', () => toggleCentre(i));
          return b;
        }),
      );
    }

    function toggleCentre(i: number) {
      const w = world;
      if (!w) return;
      const name = w.shelters[i].name;
      if (closed.has(i)) closed.delete(i);
      else closed.add(i);
      solve(closed.has(i) ? `${name} was closed` : `${name} reopened`);
      announce(closed.has(i) ? `${name} closed.` : `${name} reopened.`);
    }

    function renderVerdict() {
      const I = inst, r = result, ex = explanation;
      if (!I || !r || !ex || !plan) return;
      const s = summarise(I.model, plan);
      const total = ex.demand;
      relaxHost.replaceChildren();
      why.replaceChildren();
      if (r.status === 'solved') {
        verdict.dataset.state = 'ok';
        verdict.textContent = `Solved. All ${fmtInt(total)} people have a relief centre, the longest trip is ${fmtMinutes(s.maxTime)}, and no centre is over capacity.`;
        return;
      }
      verdict.dataset.state = 'fail';
      const reasons: HTMLElement[] = [];
      if (ex.emptyDomains.length) {
        const people = ex.stranded;
        reasons.push(h('p', null, h('strong', null, `${ex.emptyDomains.length} group${ex.emptyDomains.length > 1 ? 's' : ''} (${fmtInt(people)} people) have an empty domain`), `: no centre satisfies their constraints, so no plan can include them. For example, ${explainGroup(I, ex.emptyDomains[0])}`));
      }
      if (ex.capacity) {
        const c = ex.capacity;
        const names = c.values.map((v) => I.centres[v].short).join(', ');
        reasons.push(h('p', null, h('strong', null, 'Not enough places. '), c.values.length === I.S ? `The groups that can reach any centre need ${fmtInt(c.demand)} places, but all the open centres together have ${fmtInt(c.capacity)}.` : `${c.vars.length} group${c.vars.length > 1 ? 's' : ''} can only use ${names}. They need ${fmtInt(c.demand)} places, but ${c.values.length > 1 ? 'those centres have' : 'that centre has'} ${fmtInt(c.capacity)}.`, ' This is proved by counting, without any search.'));
      }
      if (r.status === 'budget') {
        verdict.textContent = ex.feasibleByCounting
          ? `No plan found within the search budget (${fmtInt(r.nodes)} nodes). A plan may exist; try forward checking and MRV.`
          : `No plan exists, and the search ran out of budget (${fmtInt(r.nodes)} nodes) before it could prove that by itself.`;
      } else {
        verdict.textContent = r.reason === 'proved by counting' ? 'No plan satisfies every constraint. Counting proves it, so no search was run.' : 'No plan satisfies every constraint: every branch of the search failed.';
      }
      why.replaceChildren(...reasons);
      const placed = s.sheltered;
      const relaxedNote = h('p', { class: 'asg-relaxed' }, `Relaxed plan shown: ${fmtInt(placed)} people sheltered, ${fmtInt(total - placed)} without a centre. No plan can shelter more than ${fmtInt(Math.min(total, ex.bound))} (an upper bound from the max-flow / min-cut argument).`);
      why.append(relaxedNote);
      // Offer the deadline relaxation only when the deadline actually rules something out.
      if (I.reason.some((r) => r === Reason.TooFar)) {
        const relaxBtn = h('button', { class: 'btn', type: 'button' }, 'Find the shortest deadline that works');
        relaxBtn.addEventListener('click', () => relaxDeadline());
        relaxHost.append(relaxBtn);
      } else {
        relaxHost.append(h('p', { class: 'small muted' }, 'The deadline excludes nothing here, so relaxing it cannot help: lower the water, reopen a centre or add capacity.'));
      }
    }

    function relaxDeadline() {
      if (!prep) return;
      const levels: number[] = [];
      for (let d = deadline + 5; d <= 180; d += 5) levels.push(d);
      const found = smallestRelaxation(levels, (d) => buildInstance(prep!, { ...params(), deadline: d }).csp, { ...opts, ...FULL_BUDGET });
      if (!found) {
        const msg = 'No deadline up to 3 hours helps: the problem is cut-off roads or too few places, not distance. Try lowering the water, reopening a centre or adding capacity.';
        relaxHost.replaceChildren(h('p', { class: 'small' }, msg));
        announce(msg);
        return;
      }
      if (found.level > 120) {
        relaxHost.replaceChildren(h('p', { class: 'small' }, `It only becomes solvable with a ${found.level} min deadline, beyond the slider's range.`));
        return;
      }
      deadline = found.level;
      deadlineSlider.set(deadline, true);
      solve(`The deadline was relaxed to ${deadline} min`);
      announce(`Solvable with a ${deadline} minute deadline.`);
    }

    function renderFigures() {
      const r = result, I = inst;
      if (!r || !I || !plan) return;
      const s = summarise(I.model, plan);
      const fig = (v: string, label: string) => h('div', null, h('div', { class: 'figure' }, v), h('p', { class: 'figure-label' }, label));
      figuresHost.replaceChildren(
        fig(fmtInt(r.nodes), 'nodes (values tried)'),
        fig(fmtInt(r.backtracks), 'backtracks'),
        fig(fmtInt(r.prunes), 'values pruned by forward checking'),
        fig(fmtInt(r.wipeouts), 'wipeouts'),
        fig(`${fmtNum(r.ms, r.ms < 10 ? 1 : 0)} ms`, 'search time'),
        fig(fmtInt(s.sheltered), `of ${fmtInt(s.sheltered + s.unsheltered)} people placed`),
        fig(fmtMinutes(s.meanTime), 'mean trip, by person'),
        fig(fmtMinutes(s.maxTime), 'longest trip'),
      );
    }

    function renderDiff(cause: string | null, before: Map<number, number> | null) {
      const I = inst;
      if (!I || !plan || !before || !cause || !world) {
        diffHost.replaceChildren();
        return;
      }
      const moved: string[] = [];
      let movedPeople = 0, lost = 0, gained = 0;
      I.groups.forEach((g, x) => {
        const was = before.get(g.id) ?? -1;
        const now = plan![x] >= 0 ? I.centres[plan![x]].shelter : -1;
        if (was === now) return;
        if (now < 0) lost += g.size;
        else if (was < 0) gained += g.size;
        else movedPeople += g.size;
        moved.push(`${g.name}: ${was < 0 ? 'no centre' : `S${was + 1}`} → ${now < 0 ? 'no centre' : `S${now + 1}`}`);
      });
      if (!moved.length) {
        diffHost.replaceChildren(h('p', { class: 'small muted' }, `${cause}. The plan did not change.`));
        return;
      }
      const parts = [movedPeople ? `${fmtInt(movedPeople)} people moved to another centre` : '', gained ? `${fmtInt(gained)} people newly placed` : '', lost ? `${fmtInt(lost)} people lost their place` : ''].filter(Boolean);
      diffHost.replaceChildren(
        h('p', { class: 'small' }, h('strong', null, `${cause}. `), `${moved.length} group${moved.length > 1 ? 's' : ''} changed: ${parts.join(', ')}.`),
        h('ul', { class: 'notes diff-list' }, ...moved.slice(0, 10).map((m) => h('li', { class: 'mono' }, m)), moved.length > 10 ? h('li', null, `and ${moved.length - 10} more`) : null),
      );
    }

    function compareSettings() {
      const I = inst;
      if (!I) return;
      const rows = SETTINGS.map((st) => {
        const r = solveCSP(I.csp, { ...st.o, ...FULL_BUDGET });
        const s = r.status === 'solved' ? summarise(I.model, r.assignment) : null;
        return { st, r, s };
      });
      const head = ['Settings', 'Result', 'Nodes', 'Backtracks', 'Pruned', 'Wipeouts', 'Time', 'Mean trip'];
      compareHost.replaceChildren(
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, ...head.map((t, i) => h('th', { class: i > 1 ? 'num' : null, scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            ...rows.map(({ st, r, s }) =>
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, st.label),
                h('td', null, r.status === 'solved' ? 'solved' : r.status === 'budget' ? 'out of budget' : 'proved impossible'),
                h('td', { class: 'num' }, fmtInt(r.nodes)),
                h('td', { class: 'num' }, fmtInt(r.backtracks)),
                h('td', { class: 'num' }, fmtInt(r.prunes)),
                h('td', { class: 'num' }, fmtInt(r.wipeouts)),
                h('td', { class: 'num' }, `${fmtNum(r.ms, 1)} ms`),
                h('td', { class: 'num' }, s ? fmtMinutes(s.meanTime) : 'n/a'),
              ),
            ),
          ),
        ),
        barChart(
          'Nodes searched (hatched: no plan found)',
          rows.map(({ st, r }) => ({ label: st.label.replace('Forward checking', 'FC').replace('Backtracking', 'BT'), value: r.nodes, text: fmtInt(r.nodes), flag: r.status !== 'solved' })),
          { width: 620 },
        ),
      );
    }

    // ─────────────────────────── Map drawing ───────────────────────────

    function shownPlan(): Int32Array | null {
      return (shown !== 'csp' && plans[shown]) || plan;
    }

    function drawPlan(d: DrawCtx) {
      const w = world, I = inst, P = shownPlan();
      if (!w || !I || !P) return;
      const { ctx, cam, pal } = d;
      const z = clamp(Math.sqrt(cam.zoom), 0.8, 3);
      // People per (hood, centre) and unplaced per hood.
      const flows = new Map<string, { hood: number; s: number; people: number }>();
      const unplaced = new Map<number, number>();
      const load = new Float64Array(I.S);
      I.groups.forEach((g, x) => {
        const s = P[x];
        if (s < 0) {
          unplaced.set(g.hood, (unplaced.get(g.hood) ?? 0) + g.size);
          return;
        }
        load[s] += g.size;
        const k = `${g.hood}:${s}`;
        const f = flows.get(k) ?? { hood: g.hood, s, people: 0 };
        f.people += g.size;
        flows.set(k, f);
      });
      let maxP = 1;
      for (const f of flows.values()) maxP = Math.max(maxP, f.people);
      ctx.save();
      ctx.lineCap = 'round';
      const ink = css(mix(pal.primary, pal.text, 0.35), 0.8);
      const inkSel = css(mix(pal.primary, pal.text, 0.15));
      const halo = css(pal.background, 0.75);
      for (const f of flows.values()) {
        const hd = w.hoods[f.hood], nd = w.graph.nodes[I.centres[f.s].node];
        const [ax, ay] = cam.toScreen(hd.cx, hd.cy);
        const [bx, by] = cam.toScreen(nd.x, nd.y);
        // A gentle arc, bending to the right of the direction of travel.
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = bx - ax, dy = by - ay;
        const cx = mx - dy * 0.15, cy = my + dx * 0.15;
        const width = (1.2 + 7 * Math.sqrt(f.people / maxP)) * z;
        const sel = selectedHood === f.hood;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cx, cy, bx, by);
        ctx.strokeStyle = halo;
        ctx.lineWidth = width + 3;
        ctx.stroke();
        ctx.strokeStyle = sel ? inkSel : selectedHood >= 0 ? css(mix(pal.primary, pal.background, 0.3), 0.5) : ink;
        ctx.lineWidth = width;
        ctx.stroke();
      }
      // Neighbourhood origins.
      const origins = new Set<number>(I.groups.map((g) => g.hood));
      for (const hId of origins) {
        const hd = w.hoods[hId];
        const [x, y] = cam.toScreen(hd.cx, hd.cy);
        ctx.beginPath();
        ctx.arc(x, y, 3.2 * z, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.text);
        ctx.fill();
      }
      // People with no centre: a hatched ring and the count.
      for (const [hId, people] of unplaced) {
        const hd = w.hoods[hId];
        const [x, y] = cam.toScreen(hd.cx, hd.cy);
        const r = (9 + 10 * Math.sqrt(people / 50_000)) * z;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = css(mix(pal.accent, pal.text, 0.45), 0.85);
        ctx.lineWidth = 1.4;
        for (let k = -r * 2; k < r * 2; k += 5) {
          ctx.beginPath();
          ctx.moveTo(x + k - r, y - r);
          ctx.lineTo(x + k + r, y + r);
          ctx.stroke();
        }
        ctx.restore();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = css(pal.text, 0.85);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, `${fmtInt(people)} without a centre`, x + r + 6, y + 4, pal, true);
      }
      // Centres: glyph, fill ring, load / capacity.
      I.centres.forEach((c, s) => {
        const nd = w.graph.nodes[c.node];
        const [x, y] = cam.toScreen(nd.x, nd.y);
        const R = 14 * Math.min(z, 1.6);
        const out = c.closed || c.flooded;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.background, 0.92);
        ctx.fill();
        ctx.strokeStyle = css(pal.text, 0.25);
        ctx.lineWidth = 3;
        ctx.stroke();
        if (!out && c.capacity > 0) {
          const f = Math.min(1, load[s] / c.capacity);
          ctx.beginPath();
          ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
          ctx.strokeStyle = load[s] > c.capacity ? css(pal.text) : css(mix(pal.primary, pal.text, 0.25));
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.fillStyle = css(pal.text);
        shelterGlyph(ctx, x, y, 7);
        if (out) {
          ctx.beginPath();
          ctx.moveTo(x - R, y - R);
          ctx.lineTo(x + R, y + R);
          ctx.moveTo(x + R, y - R);
          ctx.lineTo(x - R, y + R);
          ctx.strokeStyle = css(pal.text, 0.85);
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        const txt = out ? `${c.short} ${c.flooded ? 'flooded' : 'closed'}` : `${c.short} ${fmtK(load[s])} / ${fmtK(c.capacity)}`;
        label(ctx, txt, x + R + 5, y + 4, pal, false);
      });
      ctx.restore();
    }

    function onMapSelect(sel: Selection) {
      if (!sel) {
        selectedHood = -1;
        renderHoodNote();
        map.requestRender();
        return;
      }
      if (sel.kind === 'shelter') {
        selectedHood = -1;
        renderShelterNote(sel.id);
      } else if (sel.kind === 'hood') {
        selectedHood = sel.id;
        renderHoodNote();
      }
      map.requestRender();
    }

    function renderShelterNote(si: number) {
      const w = world, I = inst, P = shownPlan();
      if (!w || !I || !P || !prep) return;
      const s = I.centres.findIndex((c) => c.shelter === si);
      const c = I.centres[s];
      let load = 0, groups = 0;
      I.groups.forEach((g, x) => {
        if (P[x] === s) {
          load += g.size;
          groups++;
        }
      });
      const btn = h('button', { class: 'btn', type: 'button' }, closed.has(si) ? 'Reopen this centre' : 'Close this centre');
      btn.addEventListener('click', () => toggleCentre(si));
      mapNote.replaceChildren(
        h('p', null, h('strong', null, w.shelters[si].name), ` takes ${groups} group${groups === 1 ? '' : 's'}, ${fmtInt(load)} of ${fmtInt(c.capacity)} places. Ground ${fmtNum(w.shelters[si].elev, 1)} m; flood risk P(high) ${fmtNum(c.risk, 2)}${c.flooded ? '; flooded at this water level' : ''}.`),
        btn,
      );
    }

    function renderHoodNote() {
      const w = world, I = inst, P = shownPlan();
      if (!w || !I || !P || selectedHood < 0) {
        mapNote.replaceChildren(h('p', { class: 'small muted' }, 'Tap a neighbourhood to see where its people go, or a relief centre to close or reopen it.'));
        return;
      }
      const hd = w.hoods[selectedHood];
      const per = new Map<number, number>();
      let total = 0, none = 0;
      I.groups.forEach((g, x) => {
        if (g.hood !== selectedHood) return;
        total += g.size;
        if (P[x] < 0) none += g.size;
        else per.set(P[x], (per.get(P[x]) ?? 0) + g.size);
      });
      if (!total) {
        mapNote.replaceChildren(h('p', null, h('strong', null, hd.name), ': nobody here needs to leave (high ground or no homes below 6 m).'));
        return;
      }
      const parts = [...per].sort((a, b) => b[1] - a[1]).map(([s, p]) => `${fmtInt(p)} to ${I.centres[s].short} ${I.centres[s].name}`);
      mapNote.replaceChildren(h('p', null, h('strong', null, hd.name), `: ${fmtInt(total)} people. ${parts.join('; ')}${none ? `; ${fmtInt(none)} without a centre` : ''}.`));
    }

    // ─────────────────────────── Search tree lab ───────────────────────────

    function labInstance(): Instance | null {
      const w = world;
      if (!w || !prep) return null;
      const hoods = LAB_HOODS.map((re) => w.hoods.findIndex((hd) => re.test(hd.name))).filter((i) => i >= 0);
      const full = buildInstance(prep, { deadline: 999, maxRisk: 1, capacityScale: 1, closed: [], hoods });
      const total = (s: number) => full.groups.reduce((a, _, g) => a + full.time[g * full.S + s], 0);
      const cs = [...Array(full.S).keys()].sort((a, b) => total(a) - total(b)).slice(0, 4);
      const demand = full.groups.reduce((a, g) => a + g.size, 0);
      const cw = cs.reduce((a, s) => a + w.shelters[s].capacity, 0);
      const capacities = cs.map((s) => Math.round((labRatio * demand * w.shelters[s].capacity) / cw / 100) * 100);
      return buildInstance(prep, { deadline: labDeadline, maxRisk: 1, capacityScale: 1, closed: [], hoods, centres: cs, capacities });
    }

    function runLab() {
      cancelAnimationFrame(labRaf);
      labInst = labInstance();
      if (!labInst) return;
      const I = labInst;
      labEvents = [];
      labResult = solveCSP(I.csp, { ...SETTINGS[labSetting].o, ...LAB_BUDGET }, (e) => labEvents.push(e));
      const doms = I.csp.domains.map((d, x) => `${I.groups[x].name} ${d.length ? d.map((v) => I.centres[v].short).join('/') : 'none'}`);
      const w = world!;
      labIntro.textContent = `${I.G} groups from ${[...new Set(I.groups.map((g) => w.hoods[g.hood].name))].join(', ')}; centres ${I.centres.map((c) => `${c.short} (${fmtInt(c.capacity)} places)`).join(', ')}. Allowed centres within ${labDeadline} min: ${doms.join('; ')}.`;
      playLab();
    }

    function playLab() {
      cancelAnimationFrame(labRaf);
      if (labRate > 1e5) {
        showLabTo(labEvents.length);
        return;
      }
      labCursor = 0;
      labLast = performance.now();
      let acc = 0;
      const tick = (t: number) => {
        acc += ((t - labLast) / 1000) * labRate;
        labLast = t;
        let target = labCursor;
        while (acc >= 1 && target < labEvents.length) {
          target = nextVisibleEvent(target);
          acc -= 1;
        }
        if (target !== labCursor) showLabTo(target);
        if (labCursor < labEvents.length && !signal.aborted) labRaf = requestAnimationFrame(tick);
      };
      showLabTo(0);
      labRaf = requestAnimationFrame(tick);
    }

    /** Index just after the next event that changes the drawing (prunes are batched with their assignment). */
    function nextVisibleEvent(from: number): number {
      let i = from;
      while (i < labEvents.length) {
        const e = labEvents[i++];
        if (e.type !== 'prune') {
          while (i < labEvents.length && labEvents[i].type === 'prune') i++;
          break;
        }
      }
      return i;
    }

    function showLabTo(upTo: number) {
      labCursor = upTo;
      const I = labInst;
      if (!I || !labResult) return;
      const tree = buildTree(labEvents, upTo);
      treeWrap.replaceChildren(drawTree(tree, I));
      const c = tree.counts;
      const finished = upTo >= labEvents.length;
      treeFacts.replaceChildren(
        ...([
          ['Nodes (values tried)', fmtInt(c.nodes)],
          ['Assignments', fmtInt(c.assign)],
          ['Rejected as too full', fmtInt(c.reject)],
          ['Values pruned', fmtInt(c.prune)],
          ['Wipeouts', fmtInt(c.wipe)],
          ['Backtracks', fmtInt(c.backtrack)],
          ['Events shown', `${fmtInt(upTo)} / ${fmtInt(labEvents.length)}`],
        ] as [string, string][]).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
      );
      const path = tree.path.map((id) => tree.nodes[id]).filter((n) => n.kind !== 'root');
      treePath.textContent = path.length ? `Current path: ${path.map((n) => `${I.groups[n.x].name} → ${I.centres[n.v].short}`).join(', ')}.` : 'Current path: nothing assigned yet.';
      if (finished) {
        const r = labResult;
        treeVerdict.textContent =
          r.status === 'solved'
            ? `${SETTINGS[labSetting].label}: solved after trying ${fmtInt(r.nodes)} values, with ${fmtInt(r.backtracks)} backtracks${r.wipeouts ? ` and ${fmtInt(r.wipeouts)} wipeouts caught early` : ''}.`
            : r.status === 'budget'
              ? `${SETTINGS[labSetting].label}: stopped at the ${fmtInt(LAB_BUDGET.maxNodes)}-node budget. ${explainInfeasibility(I.csp).feasibleByCounting ? '' : 'Counting shows there is no plan at all.'}`
              : `${SETTINGS[labSetting].label}: no plan exists. ${r.reason ?? ''}`;
      } else {
        treeVerdict.textContent = `${SETTINGS[labSetting].label}: searching...`;
      }
    }

    // ─────────────────────────── Local search ───────────────────────────

    function resetLocal() {
      cancelAnimationFrame(lsRaf);
      sa = hc = null;
      plans = plan ? { csp: plan } : {};
      summaries = inst && plan ? { csp: summarise(inst.model, plan) } : {};
      if (shown !== 'csp') {
        shown = 'csp';
        showCtl.set('csp', true);
      }
      energyHost.replaceChildren(h('p', { class: 'small muted' }, 'Press "Improve the plan" to run simulated annealing and hill climbing from the plan above.'));
      lsLive.textContent = '';
      lsResults.replaceChildren();
    }

    function runLocal() {
      const I = inst;
      if (!I || !plan) return;
      cancelAnimationFrame(lsRaf);
      const start = plan;
      const seed = `assign-${lsSeed}`;
      lsSeedNote.textContent = `seed ${seed}`;
      sa = new Annealer(I.model, start, { iterations, cooling, seed, restarts });
      hc = new HillClimber(I.model, start, { variant: hcVariant, seed, maxEvaluations: 3_000_000 });
      const frames = 150;
      const saPer = Math.ceil(iterations / frames);
      const hcPer = Math.max(saPer, 4000);
      const startE = summaries.csp?.energy ?? sa.energy;
      const tick = () => {
        const t0 = performance.now();
        if (sa && !sa.done) sa.step(saPer);
        if (hc && !hc.done) while (!hc.done && performance.now() - t0 < 14) hc.step(hcPer);
        drawEnergy(startE);
        const doneAll = (!sa || sa.done) && (!hc || hc.done);
        lsLive.textContent = sa && hc ? `Annealing: ${fmtInt(sa.iteration)} of ${fmtInt(iterations)} moves, T = ${fmtK(sa.temperatureNow)}, best ${fmtK(sa.bestEnergy)} person-min. Hill climbing: ${fmtInt(hc.evaluations)} moves evaluated, ${fmtInt(hc.steps)} steps, ${fmtK(hc.energy)} person-min${hc.done ? ` (stopped: ${hc.stopReason})` : ''}.` : '';
        if (!doneAll && !signal.aborted) lsRaf = requestAnimationFrame(tick);
        else finishLocal();
      };
      lsRaf = requestAnimationFrame(tick);
    }

    function finishLocal() {
      const I = inst;
      if (!I || !sa || !hc) return;
      plans.sa = sa.bestAssign;
      plans.hc = hc.assignment;
      summaries.sa = summarise(I.model, plans.sa);
      summaries.hc = summarise(I.model, plans.hc);
      const rows: [PlanKey, string][] = [['csp', 'CSP only'], ['hc', `CSP + hill climbing (${hcVariant === 'steepest' ? 'steepest' : 'first-choice'})`], ['sa', `CSP + annealing (${cooling}${restarts > 1 ? `, ${restarts} runs` : ''})`]];
      const S = summaries as Record<PlanKey, PlanSummary>;
      const head = ['Plan', 'Energy', 'Travel', 'Risk', 'Imbalance', 'Splits', 'Mean trip', 'Longest', 'Fullest centre', 'Placed'];
      const best = Math.min(...rows.map(([k]) => S[k].energy));
      const tbl = h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, ...head.map((t, i) => h('th', { class: i > 0 ? 'num' : null, scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          ...rows.map(([k, label]) => {
            const s = S[k];
            return h(
              'tr',
              null,
              h('th', { scope: 'row' }, label),
              h('td', { class: 'num' }, `${fmtK(s.energy)}${s.energy === best ? ' (best)' : ''}`),
              h('td', { class: 'num' }, fmtK(s.parts.travel)),
              h('td', { class: 'num' }, fmtK(s.parts.risk)),
              h('td', { class: 'num' }, fmtK(s.parts.imbalance)),
              h('td', { class: 'num' }, `${s.splitHoods} hoods`),
              h('td', { class: 'num' }, fmtNum(s.meanTime, 1) + ' min'),
              h('td', { class: 'num' }, fmtMinutes(s.maxTime)),
              h('td', { class: 'num' }, `${Math.round(s.maxFill * 100)}%`),
              h('td', { class: 'num' }, fmtInt(s.sheltered)),
            );
          }),
        ),
      );
      const csp = S.csp.energy, hcE = S.hc.energy, saE = S.sa.energy;
      const pct = (a: number) => fmtNum(((csp - a) / csp) * 100, 1);
      const words =
        saE < hcE - 1
          ? `Annealing lowered the energy by ${pct(saE)}% and hill climbing by ${pct(hcE)}%. Hill climbing stopped (${hc.stopReason}); annealing's occasional uphill moves (${fmtInt(sa.acceptedUphill)} accepted) let it get past that.`
          : saE > hcE + 1
            ? `This time hill climbing did better (${pct(hcE)}% against ${pct(saE)}%). Annealing is random: try more iterations, geometric cooling, or another seed. ${cooling === 'linear' ? 'Linear cooling stays hot for most of the run and leaves little time to settle.' : ''}`
            : `Both reached the same energy, ${pct(saE)}% below the CSP plan.`;
      lsResults.replaceChildren(
        h('p', { class: 'lede', style: 'max-width: 68ch' }, words),
        h('div', { class: 'table-scroll', style: 'margin: var(--s-4) 0' }, tbl),
        barChart('Energy, thousand person-minutes (lower is better)', rows.map(([k, label]) => ({ label: label.split(' (')[0], value: S[k].energy / 1000, text: fmtK(S[k].energy) })), { width: 620, note: 'Energy units are person-minutes: one person travelling for one minute. Every term is converted to that unit so they can be added.' }),
      );
      shown = 'sa';
      showCtl.set('sa', true);
      map.requestRender();
      renderHoodNote();
      announce(words);
    }

    function drawEnergy(startE: number) {
      if (!sa || !hc) return;
      energyHost.replaceChildren(energyPlot(sa, hc, startE, iterations));
    }

    // ─────────────────────────── Load ───────────────────────────

    loadMumbai({ ...DEFAULT_MUMBAI, gridSize: 128 }).then(
      (w) => {
        if (signal.aborted) return;
        world = w;
        table = buildEdgeTable(w);
        map.setWorld(w);
        status.hidden = true;
        prepare();
        solve(null);
        runLab();
      },
      (err) => {
        status.textContent = `The road network could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
      },
    );

    return () => {
      cancelAnimationFrame(labRaf);
      cancelAnimationFrame(lsRaf);
      map.destroy();
    };
  },
};

// ─────────────────────────── Search tree ───────────────────────────

interface TreeNode {
  id: number;
  parent: number;
  x: number;
  v: number;
  kind: 'root' | 'assign' | 'reject' | 'wipe';
  /** Wiped-out variable (for 'wipe'). */
  y: number;
  failed: boolean;
  solution: boolean;
  children: number[];
  depth: number;
}

interface Tree {
  nodes: TreeNode[];
  path: number[];
  counts: { nodes: number; assign: number; reject: number; prune: number; wipe: number; backtrack: number };
  truncated: boolean;
}

const TREE_MAX = 1500;

function buildTree(events: CSPEvent[], upTo: number): Tree {
  const nodes: TreeNode[] = [{ id: 0, parent: -1, x: -1, v: -1, kind: 'root', y: -1, failed: false, solution: false, children: [], depth: 0 }];
  const counts = { nodes: 0, assign: 0, reject: 0, prune: 0, wipe: 0, backtrack: 0 };
  let cur = 0;
  let truncated = false;
  const add = (x: number, v: number, kind: TreeNode['kind']) => {
    const n: TreeNode = { id: nodes.length, parent: cur, x, v, kind, y: -1, failed: kind === 'reject', solution: false, children: [], depth: nodes[cur].depth + 1 };
    nodes.push(n);
    nodes[cur].children.push(n.id);
    return n.id;
  };
  for (let i = 0; i < upTo; i++) {
    const e = events[i];
    switch (e.type) {
      case 'assign':
        counts.nodes++;
        counts.assign++;
        if (nodes.length >= TREE_MAX) truncated = true;
        cur = truncated ? cur : add(e.x, e.v, 'assign');
        break;
      case 'reject':
        counts.nodes++;
        counts.reject++;
        if (nodes.length < TREE_MAX) add(e.x, e.v, 'reject');
        break;
      case 'prune':
        counts.prune++;
        break;
      case 'wipeout':
        counts.wipe++;
        if (!truncated) {
          nodes[cur].kind = 'wipe';
          nodes[cur].y = e.y;
        }
        break;
      case 'unassign':
        if (!truncated) {
          nodes[cur].failed = true;
          cur = nodes[cur].parent;
        }
        break;
      case 'backtrack':
        counts.backtrack++;
        break;
      case 'solution':
        for (let k = cur; k > 0; k = nodes[k].parent) nodes[k].solution = true;
        break;
    }
  }
  const path: number[] = [];
  for (let k = cur; k >= 0; k = nodes[k].parent) path.unshift(k);
  return { nodes, path, counts, truncated };
}

function drawTree(t: Tree, I: Instance): SVGSVGElement {
  // Leaves get consecutive x slots; a parent sits over the middle of its children.
  const px = new Float64Array(t.nodes.length);
  let leaf = 0;
  const place = (id: number): void => {
    const n = t.nodes[id];
    if (!n.children.length) {
      px[id] = leaf++;
      return;
    }
    for (const c of n.children) place(c);
    px[id] = (px[n.children[0]] + px[n.children[n.children.length - 1]]) / 2;
  };
  place(0);
  const maxDepth = I.G;
  const dx = leaf > 120 ? 9 : leaf > 60 ? 13 : 22;
  const dy = 34;
  const L = 16, T = 16;
  const W = Math.max(320, L * 2 + Math.max(1, leaf - 1) * dx);
  const H = T * 2 + maxDepth * dy + 18;
  const X = (id: number) => L + px[id] * dx;
  const Y = (id: number) => T + t.nodes[id].depth * dy;
  const onPath = new Set(t.path);
  const small = t.nodes.length < 160;
  const parts: string[] = [];
  parts.push(`<defs><pattern id="tree-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="var(--background)"/><path d="M0 0v4" stroke="var(--accent-ink)" stroke-width="1.6"/></pattern></defs>`);
  for (let d = 1; d <= maxDepth; d++) parts.push(`<line class="t-level" x1="0" x2="${W}" y1="${T + d * dy}" y2="${T + d * dy}"/>`);
  for (const n of t.nodes) {
    if (n.parent < 0) continue;
    const cls = onPath.has(n.id) ? 't-edge path' : n.solution ? 't-edge path' : n.kind === 'reject' || n.kind === 'wipe' ? 't-edge dead' : 't-edge';
    parts.push(`<line class="${cls}" x1="${X(n.parent).toFixed(1)}" y1="${Y(n.parent)}" x2="${X(n.id).toFixed(1)}" y2="${Y(n.id)}"/>`);
  }
  for (const n of t.nodes) {
    const x = X(n.id).toFixed(1), y = Y(n.id);
    const title = n.kind === 'root' ? 'start: nothing assigned' : `${I.groups[n.x].name} → ${I.centres[n.v].short}${n.kind === 'reject' ? ' (rejected: not enough room left)' : n.kind === 'wipe' ? ` (wipeout: ${I.groups[n.y].name} has no centre left)` : n.failed ? ' (failed below)' : ''}`;
    parts.push(`<g><title>${esc(title)}</title>`);
    if (n.kind === 'reject') {
      parts.push(`<path class="t-x" d="M${+x - 3.5} ${y - 3.5}l7 7M${+x + 3.5} ${y - 3.5}l-7 7"/>`);
    } else if (n.kind === 'wipe') {
      parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="url(#tree-hatch)" class="t-wipe"/>`);
    } else {
      const cls = n.kind === 'root' ? 't-node root' : onPath.has(n.id) || n.solution ? 't-node path' : n.failed ? 't-node failed' : 't-node';
      parts.push(`<circle class="${cls}" cx="${x}" cy="${y}" r="${n.kind === 'root' ? 6 : 5}"/>`);
      if (n.solution && !t.nodes[n.id].children.some((c) => t.nodes[c].solution)) parts.push(`<circle class="t-goal" cx="${x}" cy="${y}" r="9"/>`);
    }
    if (n.kind !== 'root' && (small || onPath.has(n.id))) parts.push(`<text class="t-label" x="${x}" y="${y - 9}" text-anchor="middle">${esc(I.centres[n.v].short)}</text>`);
    parts.push('</g>');
  }
  if (t.truncated) parts.push(`<text class="t-label" x="${L}" y="${H - 4}">The tree is cut off after ${TREE_MAX} nodes; the counters keep going.</text>`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('class', 'tree');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Search tree with ${t.nodes.length - 1} nodes. Current path: ${t.path.length - 1} groups assigned.`);
  svg.innerHTML = parts.join('');
  return svg;
}

// ─────────────────────────── Energy plot ───────────────────────────

function energyPlot(sa: Annealer, hc: HillClimber, startE: number, iterations: number): HTMLElement {
  const W = 760, H = 300, L = 62, R = 62, T = 14, B = 40;
  const xMax = Math.max(iterations, hc.evaluations, 1);
  const all = [...sa.trace.map((p) => p.energy), ...hc.trace.map((p) => p.energy), startE];
  const lo = Math.min(...all), hiRaw = Math.max(...all);
  const hi = Math.min(hiRaw, startE + (startE - lo) * 1.2 + 1);
  const pad = (hi - lo) * 0.05 + 1;
  const y0 = lo - pad, y1 = hi + pad;
  const x = (i: number) => L + (i / xMax) * (W - L - R);
  const y = (e: number) => T + (1 - (Math.min(e, y1) - y0) / (y1 - y0)) * (H - T - B);
  const Tmax = sa.T0, Tmin = sa.T0 * 1e-3;
  const yT = (t: number) => T + (1 - (Math.log10(Math.max(t, Tmin)) - Math.log10(Tmin)) / (Math.log10(Tmax) - Math.log10(Tmin) || 1)) * (H - T - B);
  const parts: string[] = [];
  for (let k = 0; k <= 4; k++) {
    const e = y0 + ((y1 - y0) * k) / 4;
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(e)}" y2="${y(e)}"/><text class="tick" x="${L - 8}" y="${y(e) + 4}" text-anchor="end">${fmtK(e)}</text>`);
  }
  for (let k = 0; k <= 4; k++) {
    const i = (xMax * k) / 4;
    parts.push(`<text class="tick" x="${x(i)}" y="${H - B + 18}" text-anchor="middle">${fmtK(i)}</text>`);
  }
  parts.push(`<text class="tick" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">moves evaluated</text>`);
  parts.push(`<text class="tick" x="${L - 8}" y="${T - 2}" text-anchor="end">energy</text><text class="tick" x="${W - R + 8}" y="${T - 2}">temperature (log)</text>`);
  for (const t of [Tmax, Math.sqrt(Tmax * Tmin), Tmin]) parts.push(`<text class="tick" x="${W - R + 8}" y="${yT(t) + 4}">${fmtK(t)}</text>`);
  // Uphill moves the annealer accepted: a rug of ticks along the bottom.
  const ups = sa.uphill;
  const step = Math.max(1, Math.floor(ups.length / 500));
  const rug: string[] = [];
  for (let k = 0; k < ups.length; k += step) rug.push(`M${x(ups[k].i).toFixed(1)} ${H - B}v-7`);
  if (rug.length) parts.push(`<path class="uphill" d="${rug.join('')}"/>`);
  const line = (pts: TracePoint[], f: (p: TracePoint) => number, fy: (v: number) => number) => pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${fy(f(p)).toFixed(1)}`).join('');
  parts.push(`<path class="temp" d="${line(sa.trace, (p) => p.T, yT)}"/>`);
  parts.push(`<path class="sa-cur" d="${line(sa.trace, (p) => p.energy, y)}"/>`);
  parts.push(`<path class="sa-best" d="${line(sa.trace, (p) => p.best, y)}"/>`);
  const hcPts = hc.trace.concat(hc.done ? [] : [{ i: hc.evaluations, energy: hc.energy, best: hc.energy, T: 0 }]);
  parts.push(`<path class="hc" d="${hcPts.map((p, k) => `${k ? `H${x(p.i).toFixed(1)}V` : `M${x(p.i).toFixed(1)} `}${y(p.energy).toFixed(1)}`).join('')}"/>`);
  parts.push(`<line class="start" x1="${L}" x2="${W - R}" y1="${y(startE)}" y2="${y(startE)}"/><text class="tick" x="${W - R - 4}" y="${y(startE) - 6}" text-anchor="end">CSP plan ${fmtK(startE)}</text>`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Energy against moves evaluated. Annealing best ${fmtK(sa.bestEnergy)}, hill climbing ${fmtK(hc.energy)}, starting from ${fmtK(startE)} person-minutes.`);
  svg.innerHTML = parts.join('');
  const legend = `<ul class="marker-legend">
    <li><svg viewBox="0 0 22 14"><path d="M1 7h20" class="sa-best"/></svg>Annealing, best so far</li>
    <li><svg viewBox="0 0 22 14"><path d="M1 7h20" class="sa-cur"/></svg>Annealing, current</li>
    <li><svg viewBox="0 0 22 14"><path d="M1 7h20" class="hc"/></svg>Hill climbing</li>
    <li><svg viewBox="0 0 22 14"><path d="M1 7h20" class="temp"/></svg>Temperature</li>
    <li><svg viewBox="0 0 22 14"><path d="M11 12V3" class="uphill"/></svg>Uphill move accepted</li>
  </ul>`;
  const holder = h('div', null, svg);
  holder.insertAdjacentHTML('beforeend', legend);
  return holder;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, pal: DrawCtx['pal'], strong: boolean) {
  ctx.font = `${strong ? 600 : 500} 12px ${FONT_MONO}`;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(pal.background, 0.9);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = css(pal.text);
  ctx.fillText(text, x, y);
}

/** 412,300 -> "412k"; 9,481,000 -> "9.48M". */
function fmtK(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export default page;
