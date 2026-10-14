/**
 * Simulator: the real Mumbai map (Mithi River basin) under a storm.
 *
 * Two ways to flood it:
 *   Storm     the physical model runs in a worker: rain, tide, drains and the
 *             upstream Mithi inflow move water across the terrain. Play, pause,
 *             change speed, drag the timeline back and forth, and move the rain
 *             slider while it runs.
 *   Level     an instant "what if": drag the water-level slider and the flood
 *             rises or recedes immediately across connected low ground.
 * Either way, roads close and reopen as the water moves.
 */
import { mumbaiNetwork, RAIN_STATES, RIVER_STATES, riverClass } from '../ai/bayes/cpt';
import { prefs, setQuality, type Quality } from '../core/prefs';
import { randomSeedString } from '../core/rng';
import { replaceParams, type Page } from '../core/router';
import { clamp, fmtClock, fmtInt, fmtMinutes, fmtNum, parseClamped, sanitizeSeed } from '../core/units';
import { AgentLayer } from '../render/canvas/agents';
import { hatchAlpha, hatchSpacing, RiskLayer } from '../render/canvas/risk';
import { Status, type AgentMetrics, type Strategy } from '../sim/agents';
import { buildAgentSetup } from '../sim/agentSetup';
import { pickGaugeCell, type FrameMsg, type RiskFrame } from '../sim/floodEngine';
import { FloodClient } from '../sim/floodClient';
import { buildEdgeTable, buildFloodSetup, buildForcing, computeEdgeStates, floodStats, waterLevelFlood, type EdgeTable, type TravelMode } from '../sim/hydrology';
import { rainSeries, totalRain } from '../sim/rainfall';
import { buildRiskSetup, hoodRisk, riskPosterior, type RiskSetup } from '../sim/riskModel';
import { resolveStorm, SCENARIO_IDS, SCENARIOS, scenarioFromURL, scenarioToURL, type ScenarioId, type ScenarioParams } from '../sim/scenario';
import { createScrubber } from '../ui/controls/scrubber';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { createToggle } from '../ui/controls/toggle';
import { announce, h } from '../ui/dom';
import { createMapView, type Layers, type Selection } from '../ui/mapView';
import { makeSheet } from '../ui/sheet';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { World } from '../world/types';
import { loadMumbai } from '../world/worldClient';

type Mode = 'storm' | 'level';
const SPEEDS = ['0.25', '0.5', '1', '2', '4', '8', '16'] as const;
type SpeedStr = (typeof SPEEDS)[number];

const LEGEND_SVG: Record<string, string> = {
  arterial: `<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="var(--background)" stroke-width="6" stroke-linecap="round"/><path d="M2 7h38" stroke="color-mix(in oklab, var(--text) 84%, var(--background))" stroke-width="3" stroke-linecap="round"/></svg>`,
  local: `<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="color-mix(in oklab, var(--text) 55%, var(--background))" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  degraded: `<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="color-mix(in oklab, var(--accent) 60%, var(--text))" stroke-width="2" stroke-dasharray="3 3"/></svg>`,
  blocked: `<svg viewBox="0 0 42 14"><defs><pattern id="lg-h" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 5L5 0M0 0l5 5" stroke="var(--text)" stroke-opacity=".55" stroke-width=".8"/></pattern></defs><rect x="2" y="2" width="38" height="10" fill="url(#lg-h)"/><path d="M2 7h38" stroke="var(--text)" stroke-width="2" stroke-dasharray="6 5"/></svg>`,
  bridge: `<svg viewBox="0 0 42 14"><path d="M4 7h34" stroke="var(--text)" stroke-width="7"/><path d="M4 7h34" stroke="var(--background)" stroke-width="4"/><path d="M8 2v10M34 2v10" stroke="var(--text)" stroke-width="1.4"/></svg>`,
  flyover: `<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="color-mix(in oklab, var(--text) 90%, var(--background))" stroke-width="6"/><path d="M2 7h38" stroke="color-mix(in oklab, var(--background) 75%, var(--secondary))" stroke-width="3.5"/></svg>`,
  tunnel: `<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="var(--background)" stroke-width="6"/><path d="M2 7h38" stroke="var(--text)" stroke-width="2.5" stroke-dasharray="1.5 3" stroke-linecap="round"/></svg>`,
  water: `<svg viewBox="0 0 42 14"><defs><linearGradient id="lg-w"><stop offset="0" stop-color="color-mix(in oklab, var(--background) 45%, var(--secondary))"/><stop offset=".5" stop-color="color-mix(in oklab, var(--accent) 65%, var(--primary))"/><stop offset="1" stop-color="color-mix(in oklab, var(--primary) 72%, var(--text))"/></linearGradient></defs><rect x="2" y="3" width="38" height="8" rx="2" fill="url(#lg-w)"/></svg>`,
  mangrove: `<svg viewBox="0 0 42 14"><defs><pattern id="lg-m" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r=".8" fill="color-mix(in oklab, var(--primary) 65%, var(--text))"/></pattern></defs><rect x="2" y="2" width="38" height="10" fill="url(#lg-m)" stroke="color-mix(in oklab, var(--primary) 50%, transparent)" stroke-width=".8"/></svg>`,
  shelter: `<svg viewBox="0 0 42 14"><path d="M15.5 13V7.5a5.5 5.5 0 0 1 11 0V13M12 13h18" fill="none" stroke="var(--text)" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  gMoving: `<svg viewBox="0 0 42 14"><circle cx="21" cy="7" r="5" fill="var(--background)" stroke="color-mix(in oklab, var(--primary) 65%, var(--text))" stroke-width="1.4"/><circle cx="21" cy="7" r="2.4" fill="var(--text)"/></svg>`,
  gWaiting: `<svg viewBox="0 0 42 14"><circle cx="21" cy="7" r="5" fill="var(--background)" stroke="color-mix(in oklab, var(--text) 65%, var(--background))" stroke-width="1.4"/></svg>`,
  gStuck: `<svg viewBox="0 0 42 14"><circle cx="21" cy="7" r="6.4" fill="none" stroke="var(--text)" stroke-width="1.2" stroke-dasharray="2 2"/><circle cx="21" cy="7" r="4" fill="var(--background)" stroke="color-mix(in oklab, var(--primary) 65%, var(--text))" stroke-width="1.3"/><circle cx="21" cy="7" r="2" fill="var(--text)"/></svg>`,
  gStranded: `<svg viewBox="0 0 42 14"><circle cx="21" cy="7" r="5" fill="var(--background)" stroke="color-mix(in oklab, var(--primary) 65%, var(--text))" stroke-width="1.4"/><path d="M18.8 4.8l4.4 4.4M23.2 4.8l-4.4 4.4" stroke="var(--text)" stroke-width="1.5"/></svg>`,
  route: `<svg viewBox="0 0 42 14"><path d="M2 10c10 0 12-6 20-6s12 4 18 4" fill="none" stroke="color-mix(in oklab, var(--primary) 80%, var(--text))" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  riskLow: riskSwatch(0.15),
  riskMid: riskSwatch(0.5),
  riskHigh: riskSwatch(0.9),
};

/** Legend swatch with the same hatch spacing the map uses for probability p. */
function riskSwatch(p: number): string {
  const sp = hatchSpacing(p).toFixed(1);
  const id = `lg-r${Math.round(p * 100)}`;
  const edge = p >= 2 / 3 ? `stroke="var(--text)" stroke-opacity=".55" stroke-width="1.4"` : `stroke="var(--text)" stroke-opacity=".28" stroke-dasharray="2 3"`;
  return `<svg viewBox="0 0 42 14"><defs><pattern id="${id}" width="${sp}" height="${sp}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v${sp}" stroke="var(--text)" stroke-opacity="${hatchAlpha(p).toFixed(2)}" stroke-width="1"/></pattern></defs><rect x="2" y="1" width="38" height="12" fill="url(#${id})" ${edge}/></svg>`;
}

const page: Page = {
  title: 'Simulator',
  mount({ root, params: query, signal }) {
    // ── State ──
    let sp: ScenarioParams = scenarioFromURL(query);
    let mode: Mode = query.get('mode') === 'level' ? 'level' : 'storm';
    let level = parseClamped(query.get('level'), 2.5, 0, 10);
    let travel: TravelMode = query.get('travel') === 'foot' ? 'foot' : 'vehicle';
    let speed: SpeedStr = '1';
    const strategyParam = query.get('strategy');
    let strategy: Strategy = strategyParam === 'naive' || strategyParam === 'risk' ? strategyParam : 'dynamic';
    const agentLayer = new AgentLayer();
    const riskLayer = new RiskLayer();
    const net = mumbaiNetwork();
    let riskSetup: RiskSetup | null = null;
    let lastRisk: RiskFrame | null = null;
    /** Per hood P(FloodRisk = low, medium, high), whichever mode produced it. */
    let hoodDist: Float32Array | null = null;
    let showRisk = true;
    let currentSel: Selection = null;
    let selectedGroup = -1;
    let frameAt = 0;
    let frameInterval = 1000;
    let lastReplans = 0;
    let announcedDone = false;
    let showAgents = true;
    let world: World | null = null;
    let table: EdgeTable | null = null;
    let client: FloodClient | null = null;
    let duration = SCENARIOS[sp.scenario].storm.duration;
    let minute = 0;
    let lastMinute = -1;
    let playing = false;
    let wasPlayingBeforeHide = false;
    let stage: number[] = [];
    let lastState: Uint8Array | null = null;
    let lastFrame: FrameMsg | null = null;
    let genToken = 0;
    const events: string[] = [];
    const quality = () => prefs.get().quality;
    const gridFor = (q: Quality) => (q === 'high' ? 256 : q === 'low' ? 128 : weakDevice() ? 128 : 192);

    // ── Map ──
    const status = h('div', { class: 'map-status', role: 'status' }, 'Loading the Mumbai map');
    const interp = () => clamp((performance.now() - frameAt) / Math.max(16, frameInterval), 0, 1);
    const map = createMapView({
      label: 'Flood map of the Mithi River basin, Mumbai',
      onSelect: (sel) => {
        selectedGroup = sel?.kind === 'group' ? sel.id : -1;
        currentSel = sel;
        showInspector(sel);
        if (sel) sheet.reveal(inspector);
      },
      drawExtra: (d) => {
        if (showRisk && world) riskLayer.draw(d, world);
        if (mode === 'storm' && showAgents && world) agentLayer.draw(d, world, interp(), selectedGroup);
      },
      hitExtra: (sx, sy) => {
        if (mode !== 'storm' || !showAgents) return null;
        const id = agentLayer.hitTest(map.camera, sx, sy, interp());
        return id >= 0 ? { kind: 'group', id } : null;
      },
    });
    const mapWrap = h('div', { class: 'map' }, map.el, status);

    // ── Rail: flood control ──
    const modeCtl = createSegmented<Mode>({
      label: 'Flood by',
      value: mode,
      options: [
        { value: 'storm', label: 'Storm simulation', hint: 'Physical model: rain, tide, drains and river inflow over time' },
        { value: 'level', label: 'Water level', hint: 'Instant: drag to raise or lower the water' },
      ],
      onChange: (m) => setMode(m),
    });

    const strategyCtl = createSegmented<Strategy>({
      label: 'Evacuation strategy',
      value: strategy,
      options: [
        { value: 'naive', label: 'Naive static', hint: 'Plan once on the dry map; never re-plan; wait at closed roads' },
        { value: 'dynamic', label: 'Dynamic A*', hint: 'A* on live road states, re-plans when roads close' },
        { value: 'risk', label: 'Risk-aware A*', hint: 'Dynamic A* that also avoids roads the Bayesian network rates likely to flood' },
      ],
      onChange: (st) => {
        strategy = st;
        lastReplans = 0;
        announcedDone = false;
        client?.send({ type: 'strategy', strategy: st });
        log(`Strategy changed to ${strategyWord(st)}; the run was recomputed from the start.`);
        syncURL();
      },
    });

    const stormCtl = createSegmented<ScenarioId>({
      label: 'Storm',
      value: sp.scenario,
      options: SCENARIO_IDS.map((id) => ({ value: id, label: SCENARIOS[id].label, hint: SCENARIOS[id].blurb })),
      onChange: (id) => {
        sp = { ...sp, scenario: id };
        restartSim();
      },
    });
    const stormBlurb = h('p', { class: 'small muted', style: 'margin: var(--s-2) 0 var(--s-3)' });
    const stormTotals = h('p', { class: 'small mono', style: 'margin: 0 0 var(--s-3)' });

    const seedInput = h('input', { type: 'text', id: 'seed-input', value: sp.seed, spellcheck: 'false', autocomplete: 'off', maxlength: 32, 'aria-label': 'Seed' });
    const applySeed = () => {
      const s = sanitizeSeed(seedInput.value, 'mumbai');
      seedInput.value = s;
      if (s === sp.seed) return;
      sp = { ...sp, seed: s };
      restartSim();
    };
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applySeed();
    });
    seedInput.addEventListener('change', applySeed);
    const randomBtn = h('button', { class: 'btn', type: 'button' }, 'Random seed');
    randomBtn.addEventListener('click', () => {
      seedInput.value = randomSeedString();
      applySeed();
    });
    const exactBtn = h('button', { class: 'btn', type: 'button' }, 'Historic (exact)');
    exactBtn.addEventListener('click', () => {
      seedInput.value = 'mumbai';
      applySeed();
    });

    const rainSlider = createSlider({
      label: 'Rain intensity (live)',
      min: 0, max: 2, step: 0.05, value: sp.rainScale, ticks: 5,
      format: (v) => `${Math.round(v * 100)}% of storm`,
      onChange: (v) => {
        sp = { ...sp, rainScale: v };
        client?.send({ type: 'rain', scale: v });
        log(`Rain set to ${Math.round(v * 100)}% of the storm from ${fmtClock(minute)}.`);
        syncURL();
      },
    });
    const tideSlider = createSlider({
      label: 'Storm surge / sea-level rise',
      min: -1, max: 2, step: 0.1, value: sp.tideOffset,
      format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`,
      onChange: (v) => {
        sp = { ...sp, tideOffset: v };
        client?.send({ type: 'forcing', tideOffset: sp.tideOffset, drainScale: sp.drainScale });
        syncURL();
      },
    });
    const drainSlider = createSlider({
      label: 'Storm-drain capacity',
      min: 0, max: 2, step: 0.1, value: sp.drainScale,
      format: (v) => (v === 0 ? 'blocked' : `${Math.round(v * 25)} mm/h`),
      onChange: (v) => {
        sp = { ...sp, drainScale: v };
        client?.send({ type: 'forcing', tideOffset: sp.tideOffset, drainScale: sp.drainScale });
        syncURL();
      },
    });

    // Playback
    const playBtn = h('button', { class: 'btn btn-primary', type: 'button', 'aria-pressed': 'false' }, 'Play');
    const stepBtn = h('button', { class: 'btn', type: 'button' }, 'Step 10 min');
    const restartBtn = h('button', { class: 'btn', type: 'button' }, 'Restart');
    playBtn.addEventListener('click', () => togglePlay());
    stepBtn.addEventListener('click', () => client?.send({ type: 'step', minutes: 10 }));
    restartBtn.addEventListener('click', () => {
      client?.send({ type: 'pause' });
      client?.send({ type: 'seek', minute: 0 });
    });
    const speedCtl = createSegmented<SpeedStr>({
      label: 'Speed (simulated minutes per second)',
      value: speed,
      options: SPEEDS.map((s) => ({ value: s, label: `${s}x` })),
      onChange: (s) => {
        speed = s;
        client?.send({ type: 'speed', speed: Number(s) });
      },
    });
    const scrubber = createScrubber({
      label: 'Timeline',
      duration,
      onScrub: (t, final) => {
        if (final) client?.send({ type: 'seek', minute: t });
      },
    });
    const lagNote = h('p', { class: 'small muted', style: 'margin: var(--s-2) 0 0', 'aria-live': 'polite' });

    const levelSlider = createSlider({
      label: 'Water level above mean sea level',
      min: 0, max: 10, step: 0.1, value: level, ticks: 11,
      format: (v) => `${v.toFixed(1)} m`,
      onInput: (v) => {
        level = v;
        applyLevel();
      },
      onChange: () => syncURL(),
    });
    const levelNote = h('p', { class: 'small muted' }, 'Water spreads instantly from the sea, Mahim Creek, the Mithi River and the nallahs to all connected ground below this level. Low spots shut in by higher ground stay dry. For scale: a spring high tide reaches about 2 m; 26 July 2005 put parts of Kurla and Kalina under 2 to 3 m of water.');

    const travelCtl = createSegmented<TravelMode>({
      label: 'Evacuating',
      value: travel,
      options: [
        { value: 'vehicle', label: 'By vehicle', hint: 'Roads close at 30 cm of water' },
        { value: 'foot', label: 'On foot', hint: 'Roads close at 50 cm of water' },
      ],
      onChange: (m) => {
        travel = m;
        client?.send({ type: 'mode', mode: m });
        if (mode === 'level') applyLevel();
        syncURL();
      },
    });

    const stormGroup = h(
      'div',
      null,
      strategyCtl.el,
      stormCtl.el,
      stormBlurb,
      stormTotals,
      h('div', { class: 'ctl' }, h('div', { class: 'ctl-row' }, h('label', { class: 'ctl-label', for: 'seed-input' }, 'Seed (varies the storm)')), h('div', { class: 'field' }, seedInput)),
      h('div', { class: 'cluster', style: 'margin: var(--s-2) 0 var(--s-3)' }, randomBtn, exactBtn),
      rainSlider.el,
      tideSlider.el,
      drainSlider.el,
      h('div', { class: 'cluster', style: 'margin-top: var(--s-4)' }, playBtn, stepBtn, restartBtn),
      speedCtl.el,
      h('div', { style: 'margin-top: var(--s-6)' }, scrubber.el),
      h('p', { class: 'small muted', style: 'margin: var(--s-2) 0 0' }, 'Shaded: rainfall. Line: Mithi River level at the gauge. Drag the timeline back and forth; the thick base bar shows how far has been computed.'),
      lagNote,
    );
    const levelGroup = h('div', null, levelSlider.el, levelNote);

    const control = h('section', { class: 'rail-section' }, h('h2', null, 'Flood'), modeCtl.el, h('div', { style: 'margin-top: var(--s-3)' }, stormGroup, levelGroup), travelCtl.el);

    // ── Rail: live figures ──
    const figClock = h('div', { class: 'figure' }, 't+00:00');
    const figClockLabel = h('div', { class: 'figure-label' }, 'simulated time');
    const figRain = h('div', { class: 'figure' }, '0');
    const figFlood = h('div', { class: 'figure' }, '0.0');
    const figRoads = h('div', { class: 'figure' }, '0');
    const liveFacts = h('dl', { class: 'facts' });
    const live = h(
      'section',
      { class: 'rail-section' },
      h('h2', null, 'Now'),
      h(
        'div',
        { class: 'big-figures' },
        h('div', null, figClock, figClockLabel),
        h('div', null, figRain, h('div', { class: 'figure-label' }, 'rain, mm/h')),
        h('div', null, figFlood, h('div', { class: 'figure-label' }, 'km² under 10 cm+')),
        h('div', null, figRoads, h('div', { class: 'figure-label' }, 'road segments closed')),
      ),
      liveFacts,
    );

    const evSheltered = h('div', { class: 'figure' }, '0');
    const evStranded = h('div', { class: 'figure' }, '0');
    const evFacts = h('dl', { class: 'facts' });
    const evacSec = h(
      'section',
      { class: 'rail-section' },
      h('h2', null, 'Evacuation'),
      h('div', { class: 'big-figures' }, h('div', null, evSheltered, h('div', { class: 'figure-label' }, 'people in relief centres')), h('div', null, evStranded, h('div', { class: 'figure-label' }, 'stuck or stranded'))),
      evFacts,
    );

    const eventsList = h('ol', { class: 'notes', reversed: true });
    const eventsSec = h('section', { class: 'rail-section' }, h('h2', null, 'Events'), eventsList);

    const inspectorBody = h('div', null, h('p', { class: 'small muted' }, 'Tap a neighbourhood, road, bridge, subway or relief centre on the map.'));
    const inspector = h('section', { class: 'rail-section', 'aria-live': 'polite' }, h('h2', null, 'Inspector'), inspectorBody);

    const cityFigures = h('div', { class: 'big-figures' });
    const cityFacts = h('dl', { class: 'facts' });
    const city = h('section', { class: 'rail-section' }, h('h2', null, 'Mithi River basin'), cityFigures, cityFacts);

    const layerDefs: [keyof Layers, string][] = [
      ['water', 'Water'],
      ['terrain', 'Relief'],
      ['contours', 'Contours (2 m)'],
      ['streets', 'Residential streets'],
      ['roads', 'Main roads'],
      ['hoods', 'Neighbourhoods'],
      ['shelters', 'Relief centres'],
      ['labels', 'Labels'],
    ];
    const qualityCtl = createSegmented<Quality>({
      label: 'Quality',
      value: quality(),
      options: [
        { value: 'auto', label: 'Auto', hint: '192 x 192 grid (128 on slower devices), adaptive resolution' },
        { value: 'high', label: 'High', hint: '256 x 256 grid, about 39 m cells' },
        { value: 'low', label: 'Low', hint: '128 x 128 grid, about 78 m cells' },
      ],
      onChange: (q) => {
        setQuality(q);
        map.setQuality(q);
        reloadWorld();
      },
    });
    const agentToggles = [
      createToggle({ label: 'Flood risk hatching (Bayes)', value: true, onChange: (v) => { showRisk = v; map.requestRender(); } }).el,
      createToggle({ label: 'Evacuee groups', value: true, onChange: (v) => { showAgents = v; map.requestRender(); } }).el,
      createToggle({ label: 'Planned routes', value: true, onChange: (v) => { agentLayer.showRoutes = v; map.requestRender(); } }).el,
    ];
    const layers = h('section', { class: 'rail-section' }, h('h2', null, 'Layers'), ...agentToggles, ...layerDefs.map(([k, label]) => createToggle({ label, value: true, onChange: (v) => map.setLayers({ [k]: v }) }).el), h('div', { style: 'margin-top: var(--s-3)' }, qualityCtl.el));

    const legend = h(
      'section',
      { class: 'rail-section' },
      h('h2', null, 'Legend'),
      h(
        'ul',
        { class: 'legend' },
        ...([
          ['water', 'Water, shallow to deep'],
          ['arterial', 'Main road (open)'],
          ['local', 'Other road (open)'],
          ['degraded', 'Flooded, passable slowly'],
          ['blocked', 'Closed by water'],
          ['bridge', 'Bridge over water'],
          ['flyover', 'Flyover (stays dry)'],
          ['tunnel', 'Subway or underpass (floods first)'],
          ['mangrove', 'Mangroves and wetland'],
          ['shelter', 'Relief centre (arc: how full)'],
          ['gMoving', 'Evacuee group on the move'],
          ['gWaiting', 'Group waiting to leave'],
          ['gStuck', 'Group stuck at a closed road'],
          ['gStranded', 'Group with no reachable centre'],
          ['route', 'Planned route'],
          ['riskLow', 'Flood risk: P(high) about 15%'],
          ['riskMid', 'Flood risk: about 50%'],
          ['riskHigh', 'Flood risk: about 90% (heavy edge above 2 in 3)'],
        ] as [string, string][]).map(([k, label]) => h('li', null, h('span', { html: LEGEND_SVG[k], 'aria-hidden': 'true' }), label)),
      ),
    );

    const notesList = h('ul', { class: 'notes' });
    const notes = h('section', { class: 'rail-section' }, h('h2', null, 'About this map'), notesList);

    const rail = h('aside', { class: 'rail', 'aria-label': 'Flood controls and map information' }, control, live, evacSec, eventsSec, inspector, city, layers, legend, notes);
    root.append(h('div', { class: 'map-layout' }, mapWrap, rail));
    const sheet = makeSheet(rail, 'Controls');

    // ── Helpers ──
    function syncURL() {
      replaceParams({ ...scenarioToURL(sp), ...(strategy !== 'dynamic' ? { strategy } : {}), ...(mode === 'level' ? { mode: 'level', level: level.toFixed(1) } : {}), ...(travel === 'foot' ? { travel } : {}) });
    }

    function log(sentence: string) {
      events.unshift(sentence);
      if (events.length > 60) events.length = 60;
      eventsList.replaceChildren(...events.map((e) => h('li', null, e)));
    }

    function setMode(m: Mode) {
      mode = m;
      stormGroup.hidden = m !== 'storm';
      levelGroup.hidden = m !== 'level';
      if (m === 'level') {
        client?.send({ type: 'pause' });
        applyLevel();
      } else if (lastFrame) {
        // Back to the simulation: show its current state again.
        lastRisk = null;
        setHoodDist(lastFrame.risk?.hood ?? null);
        client?.send({ type: 'seek', minute });
      }
      syncURL();
    }

    function renderCity(w: World) {
      cityFigures.replaceChildren(
        h('div', null, h('div', { class: 'figure' }, fmtInt(w.totalPopulation)), h('div', { class: 'figure-label' }, 'people in low-lying homes likely to need shelter')),
        h('div', null, h('div', { class: 'figure' }, fmtInt(w.totalCapacity)), h('div', { class: 'figure-label' }, `places in ${w.shelters.length} relief centres`)),
      );
      const kinds = { bridge: 0, flyover: 0, tunnel: 0 };
      for (const e of w.graph.edges) if (e.kind in kinds) kinds[e.kind as keyof typeof kinds]++;
      cityFacts.replaceChildren(
        ...[
          ['Residents (estimate)', fmtInt(w.residents)],
          ['Area', `${fmtNum((w.terrain.size / 1000) ** 2, 0)} km²`],
          ['Neighbourhoods', String(w.hoods.length)],
          ['Road junctions', fmtInt(w.graph.nodes.length)],
          ['Road segments', fmtInt(w.graph.edges.length)],
          ['Bridges / flyovers / subways', `${kinds.bridge} / ${kinds.flyover} / ${kinds.tunnel}`],
          ['Evacuee groups', `${fmtInt(Math.ceil(w.totalPopulation / w.groupSize))} of ${fmtInt(w.groupSize)}`],
          ['Grid', `${w.terrain.n} x ${w.terrain.n}, ${fmtNum(w.terrain.cell, 0)} m cells`],
          ['Renderer', map.renderer() === 'webgl' ? 'WebGL2' : 'Canvas 2D (fallback)'],
        ].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
      );
      notesList.replaceChildren(
        ...[
          'Roads, rivers, nallahs, mangroves, neighbourhood names and relief centres come from OpenStreetMap. Elevation is NASA SRTM, smoothed to remove building roofs.',
          'Residents are estimated from typical densities for each suburb, not counted. Demand is the share of residents in homes below 6 m above sea level who would seek a relief centre.',
          ...w.notes,
          w.attribution,
        ].map((n) => h('li', null, n)),
      );
    }

    function renderStormInfo() {
      const s = resolveStorm(sp);
      stormBlurb.textContent = SCENARIOS[sp.scenario].blurb;
      stormTotals.textContent = `about ${Math.round(totalRain(s))} mm over ${Math.round(s.duration / 60)} h, peak ${Math.round(s.peak)} mm/h at ${fmtClock(s.peakAt)}, high tide ${fmtClock(((s.highTideAt % 745) + 745) % 745)}`;
    }

    function updateFigures(stats: { rain: number; floodedKm2: number; blocked: number; degraded: number; maxDepth: number; tide?: number; gaugeStage?: number; drainEff?: number; inflow?: number; massError?: number }) {
      figClock.textContent = mode === 'storm' ? fmtClock(minute) : `${level.toFixed(1)} m`;
      figClockLabel.textContent = mode === 'storm' ? 'simulated time' : 'water level above sea';
      figRain.textContent = fmtInt(stats.rain);
      figFlood.textContent = fmtNum(stats.floodedKm2, 1);
      figRoads.textContent = fmtInt(stats.blocked);
      const rows: [string, string][] = [['Roads slowed by water', fmtInt(stats.degraded)], ['Deepest water on land', `${fmtNum(stats.maxDepth, 2)} m`]];
      if (mode === 'storm' && stats.tide !== undefined) {
        rows.push(
          ['Sea level (tide + surge)', `${stats.tide >= 0 ? '+' : ''}${fmtNum(stats.tide, 2)} m`],
          ['Mithi River at the gauge', `${fmtNum(stats.gaugeStage ?? 0, 2)} m`],
          ['Upstream inflow', `${fmtInt(stats.inflow ?? 0)} m³/s`],
          ['Drains working at', `${Math.round((stats.drainEff ?? 1) * 100)}%`],
          ['Water balance error', (stats.massError ?? 0).toExponential(1)],
        );
      }
      const r = mode === 'storm' ? lastRisk : null;
      if (r) {
        const rd = r.readings;
        rows.push(
          ['Rain gauge reads', `${RAIN_STATES[rd.rain]}${rd.rain !== rd.rainTrue ? ' (misread)' : ''}`],
          ['River gauge reads', `${RIVER_STATES[rd.river]}${rd.river !== rd.riverTrue ? ' (misread)' : ''}`],
          ['P(heavy rain | gauges)', fmtNum(r.pRain[2], 2)],
          ['P(river high | gauges)', fmtNum(r.pRiver[2], 2)],
        );
      }
      if (hoodDist && world) {
        let worst = 0, worstP = -1, over = 0;
        for (let i = 0; i < world.hoods.length; i++) {
          const ph = hoodDist[i * 3 + 2];
          if (ph >= 0.5) over += world.hoods[i].population;
          if (world.hoods[i].population > 0 && ph > worstP) {
            worstP = ph;
            worst = i;
          }
        }
        rows.push(['Highest flood risk', `${world.hoods[worst].name}, ${fmtNum(worstP, 2)}`], ['Demand in areas at 50%+ risk', fmtInt(over)]);
      }
      liveFacts.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
      map.setSummary(`${mode === 'storm' ? `At ${fmtClock(minute)}` : `Water at ${level.toFixed(1)} m`}: ${fmtNum(stats.floodedKm2, 1)} square kilometres flooded, ${stats.blocked} road segments closed, rain ${Math.round(stats.rain)} mm per hour.`);
    }

    /** Plain-sentence events for bridges, subways and big changes. Grouped by street name. */
    const floodedSubways = new Set<string>();
    function trackEvents(state: Uint8Array, when: string) {
      const w = world;
      if (!w) return;
      if (lastState && lastState.length === state.length) {
        const closedB = new Map<string, string[]>(), openedB = new Map<string, string[]>();
        const subways: string[] = [];
        let arterials = 0;
        for (let i = 0; i < state.length; i++) {
          if (state[i] === lastState[i]) continue;
          const e = w.graph.edges[i];
          const street = e.street || 'unnamed road';
          if (e.kind === 'bridge') {
            const target = state[i] === 2 ? closedB : lastState[i] === 2 ? openedB : null;
            if (target) target.set(street, [...(target.get(street) ?? []), e.name]);
          } else if (e.kind === 'tunnel') {
            const key = e.street || `underpass ${e.name}`;
            if (state[i] === 2 && !floodedSubways.has(key)) {
              floodedSubways.add(key);
              subways.push(e.street ? `${e.street}` : `An unnamed underpass (${e.name})`);
            } else if (state[i] === 0) floodedSubways.delete(key);
          } else if (e.cls === 'arterial' && state[i] === 2 && lastState[i] !== 2) arterials++;
        }
        const bridgeText = (m: Map<string, string[]>) => listOf([...m].map(([st, codes]) => `${st} (${codes.join(', ')})`));
        if (closedB.size) log(`Bridge${closedB.size > 1 ? 's' : ''} closed at ${when}: ${bridgeText(closedB)}. The water rose above the deck.`);
        if (openedB.size) log(`Bridge${openedB.size > 1 ? 's' : ''} reopened at ${when}: ${bridgeText(openedB)}.`);
        if (subways.length) log(`${listOf(subways)} flooded at ${when}: subways and underpasses fill first.`);
        if (arterials >= 5) log(`${arterials} main-road segments went under at ${when}.`);
      }
      lastState = state.slice();
    }

    function updateEvacuation(m: AgentMetrics, at: number, jump: boolean, p: Float32Array | null) {
      const total = m.sheltered + m.enRoute + m.waiting + m.stranded + m.noAccess;
      let stuck = 0;
      if (p) for (let o = 0; o < p.length; o += 6) if (p[o + 2] === Status.Stuck) stuck += p[o + 3];
      evSheltered.textContent = fmtInt(m.sheltered);
      evStranded.textContent = fmtInt(stuck + m.stranded + m.noAccess);
      evFacts.replaceChildren(
        ...([
          ['Strategy', strategyWord(strategy)],
          ['Sheltered', `${fmtInt(m.sheltered)} of ${fmtInt(total)} (${total ? Math.round((m.sheltered / total) * 100) : 0}%)`],
          ['On the move', fmtInt(m.enRoute - stuck)],
          ['Waiting at a closed road', fmtInt(stuck)],
          ['Not left yet', fmtInt(m.waiting)],
          ['No reachable centre', fmtInt(m.stranded + m.noAccess)],
          ['Mean trip (sheltered)', m.sheltered ? fmtMinutes(m.meanMinutes) : 'n/a'],
          ['95th percentile trip', m.sheltered ? fmtMinutes(m.p95Minutes) : 'n/a'],
          ['Re-plans so far', fmtInt(m.replans)],
        ] as [string, string][]).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
      );
      if (!jump && m.replans - lastReplans >= 3) log(`${m.replans - lastReplans} groups re-planned around closed roads at ${fmtClock(at)}.`);
      lastReplans = m.replans;
      if (!jump && !announcedDone && m.waiting === 0 && m.enRoute === 0 && m.sheltered > 0) {
        announcedDone = true;
        log(`Evacuation finished at ${fmtClock(at)}: ${fmtInt(m.sheltered)} people sheltered, ${fmtInt(m.stranded + m.noAccess)} could not reach a centre.`);
      }
    }

    function onFrame(f: FrameMsg) {
      if (signal.aborted || mode !== 'storm') {
        requestAnimationFrame(() => client?.send({ type: 'ack' }));
        return;
      }
      const prev = lastFrame;
      lastFrame = f;
      const jump = Math.abs(f.minute - lastMinute) !== 1;
      minute = f.minute;
      frameAt = performance.now();
      frameInterval = f.playing ? 1000 / Number(speed) : 0;
      map.setDepth(f.depth, f.flow, { reset: jump, intervalMs: frameInterval });
      agentLayer.setPositions(f.agents, !jump, world?.shelters.length ?? 0);
      if (f.metrics) updateEvacuation(f.metrics, f.minute, jump, f.agents);
      map.setEdgeState(f.edgeState);
      map.setRain(clamp(f.stats.rain / 120, 0, 1));
      applyRiskFrame(f.risk, jump, prev?.risk ?? null);
      scrubber.set(f.minute);
      scrubber.setBuffered(f.computed / duration);
      updateFigures(f.stats);
      if (!jump) trackEvents(f.edgeState, fmtClock(f.minute));
      else lastState = f.edgeState.slice();
      // Tide and rain milestones.
      const s = resolveStorm(sp);
      if (!jump && lastMinute < Math.round(s.peakAt) && f.minute >= Math.round(s.peakAt)) log(`Rain peaked at about ${Math.round(f.stats.rain)} mm/h at ${fmtClock(f.minute)}.`);
      if (!jump && f.stats.drainEff < 0.35 && (prev?.stats.drainEff ?? 1) >= 0.35) log(`High tide at ${fmtClock(f.minute)}: outfall gates are shut and drains are barely emptying.`);
      lastMinute = f.minute;
      setPlaying(f.playing);
      lagNote.textContent = f.lagging ? 'This device cannot keep up with this speed; the simulation is running as fast as it can.' : '';
      status.hidden = true;
      requestAnimationFrame(() => client?.send({ type: 'ack' }));
    }

    function setHoodDist(dist: Float32Array | null) {
      hoodDist = dist;
      if (!dist) {
        riskLayer.setRisk(null);
        return;
      }
      const ph = new Float32Array(dist.length / 3);
      for (let i = 0; i < ph.length; i++) ph[i] = dist[i * 3 + 2];
      riskLayer.setRisk(ph);
      map.requestRender();
    }

    /** New Bayesian posterior from the engine: overlay, events, live inspector. */
    function applyRiskFrame(r: RiskFrame | null, jump: boolean, prev: RiskFrame | null) {
      lastRisk = r;
      if (!r) return;
      const fresh = !prev || jump || prev.readings.minute !== r.readings.minute;
      if (!fresh) return;
      const before = hoodDist;
      setHoodDist(r.hood);
      const w = world;
      if (w && !jump && prev) {
        const rd = r.readings, when = fmtClock(rd.minute);
        if (rd.rain !== rd.rainTrue) log(`Rain gauge misread at ${when}: it reported ${RAIN_STATES[rd.rain]} rain, the truth was ${RAIN_STATES[rd.rainTrue]}. The network weighs it against the river gauge.`);
        if (rd.river !== rd.riverTrue) log(`River gauge misread at ${when}: it reported ${RIVER_STATES[rd.river]}, the river was ${RIVER_STATES[rd.riverTrue]}.`);
        if (before) {
          const up: string[] = [], down: string[] = [];
          for (let i = 0; i < w.hoods.length; i++) {
            const a = before[i * 3 + 2], b = r.hood[i * 3 + 2];
            if (a < 0.5 && b >= 0.5) up.push(w.hoods[i].name);
            else if (a >= 0.5 && b < 0.5) down.push(w.hoods[i].name);
          }
          if (up.length) log(`Flood risk rose above 50% at ${when} in ${listOf(up)}.`);
          if (down.length) log(`Flood risk fell below 50% at ${when} in ${listOf(down)}.`);
        }
      }
      if (currentSel && (currentSel.kind === 'hood' || currentSel.kind === 'edge')) showInspector(currentSel, false);
    }

    function setPlaying(p: boolean) {
      if (p === playing) return;
      playing = p;
      playBtn.textContent = p ? 'Pause' : 'Play';
      playBtn.setAttribute('aria-pressed', String(p));
      map.setAnimating(p);
    }

    function togglePlay() {
      if (mode !== 'storm') setMode('storm');
      if (playing) client?.send({ type: 'pause' });
      else {
        if (minute >= duration) client?.send({ type: 'seek', minute: 0 });
        client?.send({ type: 'play', speed: Number(speed) });
      }
    }

    function applyLevel() {
      const w = world;
      if (!w || !table) return;
      const depth = waterLevelFlood(w, level);
      const st = new Uint8Array(table.count), dep = new Float32Array(table.count);
      const es = computeEdgeStates(table, depth, w.terrain.height, w.ground, travel, st, dep);
      map.setDepth(depth, new Float32Array(depth.length * 2), { reset: true, intervalMs: 0 });
      map.setEdgeState(st);
      map.setRain(0);
      // The network in "what if" mode: no rain reading, and the river gauge
      // reads the standing water level (no sensor noise).
      if (riskSetup) {
        const rs = riskSetup;
        const river = riverClass(Math.max(level, rs.gaugeBed + 0.6), rs.gaugeBed, rs.gaugeBank);
        setHoodDist(hoodRisk(rs, riskPosterior(net, -1, river)));
      }
      const fs = floodStats(w, depth);
      updateFigures({ rain: 0, floodedKm2: fs.floodedKm2, blocked: es.blocked, degraded: es.degraded, maxDepth: fs.maxDepth });
    }

    function startClient(w: World) {
      client?.dispose();
      const c = new FloodClient();
      client = c;
      stage = [];
      lastState = null;
      lastMinute = -1;
      floodedSubways.clear();
      duration = resolveStorm(sp).duration;
      scrubber.setDuration(duration);
      scrubber.setHydrograph(rainSeries(resolveStorm(sp), 240));
      c.on('frame', onFrame);
      c.on('routes', (r) => {
        agentLayer.setRoutes(r.ids, r.offsets, r.nodes);
        map.requestRender();
      });
      c.on('series', (s) => {
        for (let i = 0; i < s.stage.length; i++) stage[s.from + i] = s.stage[i];
        drawHydrograph();
      });
      c.on('seriesTruncate', ({ keep }) => {
        stage.length = Math.min(stage.length, keep);
        drawHydrograph();
      });
      c.on('busy', ({ at, target }) => {
        status.hidden = false;
        status.textContent = `Computing ${fmtClock(at)} of ${fmtClock(target)}`;
      });
      c.on('error', ({ message, fatal }) => {
        log(message);
        if (fatal) {
          status.hidden = false;
          status.replaceChildren(h('span', null, `${message} `), restartSimBtn);
          setPlaying(false);
        }
      });
      const setup = buildFloodSetup(w);
      const notLand = new Uint8Array(w.terrain.n * w.terrain.n);
      for (let k = 0; k < notLand.length; k++) notLand[k] = w.sea[k] || w.terrain.channel[k] ? 1 : 0;
      agentLayer.clear();
      selectedGroup = -1;
      lastReplans = 0;
      announcedDone = false;
      const gaugeCell = pickGaugeCell(w);
      riskSetup = buildRiskSetup(w, sp.seed, gaugeCell);
      lastRisk = null;
      c.send({ type: 'init', setup, forcing: buildForcing(sp), edges: table!, ground: w.ground, gaugeCell, mode: travel, notLand, agents: buildAgentSetup(w, strategy, travel), risk: riskSetup });
      if (sp.rainScale !== 1) c.send({ type: 'rain', scale: sp.rainScale });
      renderStormInfo();
    }
    const restartSimBtn = h('button', { class: 'btn btn-primary', type: 'button', style: 'pointer-events: auto' }, 'Restart simulation');
    restartSimBtn.addEventListener('click', () => {
      status.hidden = true;
      if (world) startClient(world);
    });

    function drawHydrograph() {
      const n = 240;
      const line = new Float32Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        const m = Math.round((i / (n - 1)) * duration);
        if (stage[m] !== undefined) line[i] = stage[m];
      }
      scrubber.setHydrograph(rainSeries(resolveStorm(sp), n), line);
    }

    function restartSim() {
      syncURL();
      events.length = 0;
      eventsList.replaceChildren();
      setPlaying(false);
      if (world) startClient(world);
      if (mode === 'level') client?.send({ type: 'pause' });
    }

    function reloadWorld() {
      const token = ++genToken;
      status.hidden = false;
      status.textContent = 'Loading the Mumbai map';
      setPlaying(false);
      client?.dispose();
      client = null;
      loadMumbai({ ...DEFAULT_MUMBAI, gridSize: gridFor(quality()) }).then(
        (w) => {
          if (token !== genToken || signal.aborted) return;
          world = w;
          table = buildEdgeTable(w);
          map.setWorld(w);
          renderCity(w);
          showInspector(null);
          startClient(w);
          status.hidden = true;
          if (mode === 'level') applyLevel();
          announce(`Map loaded: ${w.title}. ${w.hoods.length} neighbourhoods, ${w.graph.edges.length} road segments.`);
        },
        (err) => {
          if (token !== genToken) return;
          status.hidden = false;
          status.textContent = `The map could not be loaded: ${err instanceof Error ? err.message : String(err)}. Check your connection and reload.`;
        },
      );
    }

    function showInspector(sel: Selection, speak = true) {
      const w = world;
      if (!w || !sel) {
        inspectorBody.replaceChildren(h('p', { class: 'small muted' }, 'Tap a neighbourhood, road, bridge, subway or relief centre on the map.'));
        return;
      }
      const rows: [string, string][] = [];
      let title = '';
      if (sel.kind === 'hood') {
        const hd = w.hoods[sel.id];
        title = hd.name;
        rows.push(
          ['Residents (estimate)', fmtInt(hd.residents)],
          ['Likely to need shelter', fmtInt(hd.population)],
          ['Mean elevation', `${fmtNum(hd.meanElev, 1)} m`],
          ['Drainage', `${hd.drainageClass} (${fmtNum(hd.drainage, 2)})`],
          ['Pick-up junction', hd.accessNode >= 0 ? `J${hd.accessNode}` : 'no road access'],
          ['Facilities', [hd.hasHospital ? 'hospital' : '', hd.hasSchool ? 'school' : ''].filter(Boolean).join(', ') || 'none mapped'],
        );
        if (hoodDist) {
          const o = sel.id * 3;
          const evid = mode === 'storm' && lastRisk ? `, rain gauge ${RAIN_STATES[lastRisk.readings.rain]}, river gauge ${RIVER_STATES[lastRisk.readings.river]}` : mode === 'level' ? `, water at ${level.toFixed(1)} m` : '';
          rows.push(
            ['Flood risk, Bayes', `P(high) ${fmtNum(hoodDist[o + 2], 2)}`],
            ['Low / medium / high', `${fmtNum(hoodDist[o], 2)} / ${fmtNum(hoodDist[o + 1], 2)} / ${fmtNum(hoodDist[o + 2], 2)}`],
            ['Evidence', `${hd.drainageClass} drains, ${hd.meanElev < 5 ? 'low' : hd.meanElev < 9 ? 'mid' : 'high'} ground${evid}`],
          );
        }
      } else if (sel.kind === 'group') {
        const gr = agentLayer.group(sel.id);
        title = `Evacuee group ${sel.id + 1}`;
        if (gr) {
          const statusWord = ['waiting to leave', 'on the move', 'in a relief centre', 'no reachable centre', 'waiting at a closed road', 'turning back from a flooded road', 'no road access'][gr.status] ?? 'unknown';
          rows.push(['People', fmtInt(gr.size)], ['Status', statusWord], ['Heading for', gr.shelter >= 0 ? w.shelters[gr.shelter].name : 'nowhere yet'], ['Re-plans', String(gr.replans)]);
        }
      } else if (sel.kind === 'shelter') {
        const s = w.shelters[sel.id];
        title = s.name;
        rows.push(['Capacity', `${fmtInt(s.capacity)} people`], ['Inside now', fmtInt(agentLayer.occupancyOf(s.id))], ['Elevation', `${fmtNum(s.elev, 1)} m`], ['Junction', `J${s.node}`], ['Ground', s.lowGround ? 'fairly low: may be cut off' : 'high']);
      } else {
        const e = w.graph.edges[sel.id];
        const kindWord = { road: e.cls === 'arterial' ? 'main road' : 'road', bridge: 'bridge over water', flyover: 'flyover', tunnel: 'subway / underpass' }[e.kind];
        title = e.street ? `${e.street}` : `${kindWord} ${e.name}`;
        const st = lastFrame?.edgeState[e.id] ?? 0;
        const dep = lastFrame?.edgeDepth[e.id] ?? 0;
        rows.push(
          ['Type', `${kindWord} (${e.name})`],
          ['Now', ['open', 'flooded, slow', 'closed'][st] + (dep > 0.01 ? `, ${fmtNum(dep, 2)} m of water` : '')],
          ['Length', `${fmtInt(e.length)} m`],
          ['Free-flow speed', `${fmtInt(e.speed * 3.6)} km/h`],
          ['Capacity', `${fmtInt(e.capacity)} veh/h`],
          ['Lowest point', e.kind === 'flyover' ? 'elevated' : `${fmtNum(e.minElev, 1)} m`],
        );
        if (e.isBridge) rows.push(['Deck level', `${fmtNum(e.deckLevel, 1)} m`]);
        if (mode === 'storm' && lastFrame?.risk) rows.push(['Flood risk P_flood', e.kind === 'flyover' ? '0 (elevated)' : fmtNum(lastFrame.edgeRisk[e.id] ?? 0, 2)]);
      }
      inspectorBody.replaceChildren(h('h3', { style: 'font-size: var(--step-1); margin-bottom: var(--s-3)' }, title), h('dl', { class: 'facts' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      if (speak) announce(`Selected ${title}`);
    }

    // ── Wiring ──
    stormGroup.hidden = mode !== 'storm';
    levelGroup.hidden = mode !== 'level';
    renderStormInfo();
    reloadWorld();

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === ' ' && (t === document.body || t.classList.contains('map-input'))) {
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener('keydown', onKey);
    // Pause while the tab is hidden; resume when it returns.
    const onVis = () => {
      if (document.hidden) {
        wasPlayingBeforeHide = playing;
        if (playing) client?.send({ type: 'pause' });
      } else if (wasPlayingBeforeHide) {
        client?.send({ type: 'play', speed: Number(speed) });
        wasPlayingBeforeHide = false;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      client?.dispose();
      map.destroy();
      scrubber.destroy();
      sheet.dispose();
    };
  },
};

function strategyWord(s: Strategy): string {
  return { naive: 'naive static routing', dynamic: 'dynamic A* re-planning', risk: 'risk-aware A*' }[s];
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length > 3) return `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function weakDevice(): boolean {
  try {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    return cores <= 4 || mem <= 2;
  } catch {
    return false;
  }
}

export default page;
