/**
 * Simulator: one trip through the flood, explained.
 *
 *   1. Pick a start and a destination (click the map, or a preset trip).
 *   2. The chosen search algorithm finds the best route on the dry roads.
 *      The junctions it explored light up, in order, so you can see HOW it
 *      searched; two alternative routes are shown dashed, with their times.
 *   3. Start the storm. The real flood model runs; roads close as the water
 *      rises. When a road on the route closes, the map marks where and why,
 *      the old route is crossed out, and the algorithm re-plans from where
 *      the car is (or from the start, before it leaves).
 *   4. The car leaves at the chosen time and drives the current best route.
 *
 * Everything that decides is in src/sim/journey.ts (pure); this page only
 * draws it and narrates it.
 */
import { prefs } from '../core/prefs';
import { replaceParams, type Page } from '../core/router';
import { clamp, fmtClock, fmtInt, fmtMinutes, fmtNum, parseClamped } from '../core/units';
import { shelterGlyph } from '../render/canvas/overlays';
import type { DrawCtx } from '../render/canvas/types';
import { FONT_MONO } from '../render/canvas/types';
import { css, mix, type Palette } from '../render/theme';
import { FloodClient } from '../sim/floodClient';
import { pickGaugeCell, type FrameMsg } from '../sim/floodEngine';
import { buildEdgeTable, buildFloodSetup, buildForcing, type EdgeTable } from '../sim/hydrology';
import { ALGO_NAMES, Journey, journeyNet, type Algo, type Conditions, type JourneyEvent, type JourneyNet, type PlanResult, type RouteInfo } from '../sim/journey';
import { DEFAULT_SCENARIO } from '../sim/scenario';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { announce, h } from '../ui/dom';
import { createMapView } from '../ui/mapView';
import { makeSheet } from '../ui/sheet';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { World } from '../world/types';
import { loadMumbai } from '../world/worldClient';

/** Trips that meet the flood on 26 July 2005 (checked against the model). */
const PRESETS: { label: string; from: RegExp; to: RegExp; leave: number; story: string }[] = [
  { label: 'Kalina to Dadar Vidya Mandir', from: /kalina/i, to: /Dadar Vidya/i, leave: 120, story: 'A bridge closes before the car leaves, then a road floods while it is on the way: two re-plans.' },
  { label: 'Bandra West to SIES College', from: /bandra west/i, to: /SIES/i, leave: 120, story: 'Mahim Causeway closes before departure; a link road floods on the way.' },
  { label: 'Kurla East to SNDT College', from: /kurla east/i, to: /SNDT/i, leave: 210, story: 'A late departure: Ghatkopar Mahul Road floods mid-trip.' },
  { label: 'Kalina, leaving too late', from: /kalina/i, to: /Dadar Vidya/i, leave: 210, story: 'Leaving at t+03:30, every way out is under water: the planner says so honestly.' },
];

/** How long the search animation takes to reveal, then fade, ms. */
const REVEAL_MS = 2000;
const FADE_MS = 4000;
/** Hold the storm this long on each re-plan so it can be seen, ms. */
const HOLD_MS = 2600;

type Speed = '4' | '8' | '16';

const page: Page = {
  title: 'Simulator',
  mount({ root, params: query, signal }) {
    let world: World | null = null;
    let table: EdgeTable | null = null;
    let net: JourneyNet | null = null;
    let client: FloodClient | null = null;
    let start = -1, goal = -1;
    let nextPick: 'start' | 'goal' = 'start';
    let algo: Algo = (['astar', 'ucs', 'greedy', 'bfs', 'dfs'] as Algo[]).includes(query.get('algo') as Algo) ? (query.get('algo') as Algo) : 'astar';
    let leaveAt = parseClamped(query.get('leave'), 120, 0, 360);
    let speed: Speed = '8';
    let journey: Journey | null = null;
    let jMinute = 0;
    let minute = 0;
    let playing = false;
    let holding: ReturnType<typeof setTimeout> | null = null;
    let cond: Conditions | null = null;
    let anim: { nodes: Int32Array; at: number } | null = null;
    let goalName = '', startName = '';
    const logLines: { minute: number; text: string; strong?: boolean }[] = [];
    const reduce = () => prefs.get().reducedMotion;

    // ── Map ──
    const status = h('div', { class: 'map-status', role: 'status' }, 'Loading the Mumbai map');
    const map = createMapView({
      label: 'Map: tap to choose the start, then the destination',
      hint: 'Tap the map to choose the start, then the destination. Drag to pan, scroll or pinch to zoom.',
      onTap: (wx, wy) => {
        pickAt(wx, wy);
        return true;
      },
      drawExtra: (d) => draw(d),
    });
    map.setLayers({ hoods: false, streets: false, contours: false });
    const clockBig = h('div', { class: 'figure' }, 't+00:00');
    const clockLine = h('div', { class: 'map-clock-line' }, 'Choose a trip');
    const clockLine2 = h('div', { class: 'map-clock-line' });
    const mapClock = h('div', { class: 'map-clock', 'aria-hidden': 'true' }, clockBig, clockLine, clockLine2);
    const mapWrap = h('div', { class: 'map' }, map.el, mapClock, status);

    // ── Rail: the trip ──
    const presetCtl = createSegmented<string>({
      label: 'A trip that meets the flood',
      value: '0',
      options: PRESETS.map((p, i) => ({ value: String(i), label: p.label, hint: p.story })),
      onChange: (v) => applyPreset(Number(v)),
    });
    const tripLine = h('p', { class: 'trip-line', 'aria-live': 'polite' });
    const pickStartBtn = h('button', { class: 'btn', type: 'button' }, 'Choose the start on the map');
    const pickGoalBtn = h('button', { class: 'btn', type: 'button' }, 'Choose the destination');
    pickStartBtn.addEventListener('click', () => setNextPick('start'));
    pickGoalBtn.addEventListener('click', () => setNextPick('goal'));
    const pickNote = h('p', { class: 'small muted' });
    const algoCtl = createSegmented<Algo>({
      label: 'Search algorithm',
      value: algo,
      options: (Object.keys(ALGO_NAMES) as Algo[]).map((a) => ({ value: a, label: ALGO_NAMES[a] })),
      onChange: (a) => {
        algo = a;
        resetTrip('The search algorithm changed');
      },
    });
    const leaveSlider = createSlider({
      label: 'The car leaves at',
      min: 0, max: 360, step: 10, value: leaveAt, ticks: 7,
      format: (v) => `${fmtClock(v)} (${v === 0 ? 'at once' : `${fmtMinutes(v)} into the storm`})`,
      onChange: (v) => {
        leaveAt = v;
        resetTrip(`The car now leaves at ${fmtClock(v)}`);
      },
    });

    // ── Rail: the storm ──
    const runBtn = h('button', { class: 'btn btn-primary btn-large', type: 'button' }, 'Start the storm');
    const resetBtn = h('button', { class: 'btn', type: 'button' }, 'Back to t+00:00');
    runBtn.addEventListener('click', () => run());
    resetBtn.addEventListener('click', () => resetTrip(null));
    const speedCtl = createSegmented<Speed>({
      label: 'Speed (simulated minutes per second)',
      value: speed,
      options: [
        { value: '4', label: '4x' },
        { value: '8', label: '8x' },
        { value: '16', label: '16x' },
      ],
      onChange: (s) => {
        speed = s;
        if (playing) client?.send({ type: 'speed', speed: Number(s) });
      },
    });

    // ── Rail: results ──
    const routesList = h('ul', { class: 'route-list' });
    const searchNote = h('div', { class: 'search-note' });
    const logList = h('ol', { class: 'notes journey-log', 'aria-live': 'polite' });

    const rail = h(
      'aside',
      { class: 'rail', 'aria-label': 'Simulator controls and explanation' },
      h(
        'section',
        { class: 'rail-section' },
        h('h2', null, 'Plan a route'),
        presetCtl.el,
        tripLine,
        h('div', { class: 'cluster', style: 'margin: var(--s-2) 0' }, pickStartBtn, pickGoalBtn),
        pickNote,
        h('div', { class: 'run-block' }, runBtn, h('div', { class: 'cluster', style: 'margin-top: var(--s-2)' }, resetBtn)),
      ),
      h('section', { class: 'rail-section' }, h('h2', null, 'Routes now'), routesList, h('ul', { class: 'legend route-legend' }, ...legendItems())),
      h(
        'section',
        { class: 'rail-section' },
        h('h2', null, 'Settings'),
        algoCtl.el,
        leaveSlider.el,
        speedCtl.el,
      ),
      h('section', { class: 'rail-section' }, h('h2', null, 'How the route was found'), searchNote),
      h('section', { class: 'rail-section' }, h('h2', null, 'Journey'), logList),
    );
    root.append(h('h1', { class: 'visually-hidden' }, 'Simulator: one trip through the flood'), h('div', { class: 'map-layout' }, mapWrap, rail));
    const sheet = makeSheet(rail, 'Controls');

    // ── Choosing the trip ──
    function nearestNode(x: number, y: number): number {
      const w = world;
      if (!w) return -1;
      let best = -1, bestD = Infinity;
      for (const nd of w.graph.nodes) {
        if (w.graph.adjStart[nd.id + 1] === w.graph.adjStart[nd.id]) continue;
        const d = (nd.x - x) ** 2 + (nd.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = nd.id;
        }
      }
      return best;
    }

    function placeName(v: number): string {
      const w = world!;
      const s = w.shelters.find((sh) => sh.node === v);
      if (s) return s.name.replace(/^S\d+\s+/, '');
      const hd = w.graph.nodes[v].hood;
      return hd >= 0 ? `a junction in ${w.hoods[hd].name}` : `junction J${v}`;
    }

    function pickAt(wx: number, wy: number) {
      const w = world;
      if (!w) return;
      let v = nearestNode(wx, wy);
      if (v < 0) return;
      if (nextPick === 'goal') {
        // Snap to a relief centre if one is close: that is usually what you mean.
        for (const s of w.shelters) {
          const nd = w.graph.nodes[s.node];
          if (Math.hypot(nd.x - wx, nd.y - wy) < 450) v = s.node;
        }
        goal = v;
        nextPick = 'start';
      } else {
        start = v;
        nextPick = 'goal';
      }
      presetCtl.set('' as string, true);
      resetTrip(null);
    }

    function setNextPick(p: 'start' | 'goal') {
      nextPick = p;
      updatePickNote();
    }

    function updatePickNote() {
      pickNote.textContent = nextPick === 'start' ? 'Next tap on the map sets the START.' : 'Next tap on the map sets the DESTINATION (tap near a relief centre to choose it).';
      pickStartBtn.setAttribute('aria-pressed', String(nextPick === 'start'));
      pickGoalBtn.setAttribute('aria-pressed', String(nextPick === 'goal'));
    }

    function applyPreset(i: number) {
      const w = world;
      if (!w) return;
      const p = PRESETS[i];
      const hd = w.hoods.find((x) => p.from.test(x.name));
      const sh = w.shelters.find((x) => p.to.test(x.name));
      if (!hd || !sh || hd.accessNode < 0) return;
      start = hd.accessNode;
      goal = sh.node;
      leaveAt = p.leave;
      leaveSlider.set(leaveAt, true);
      nextPick = 'start';
      resetTrip(null);
      log(0, p.story);
    }

    // ── The storm ──
    function startClient() {
      const w = world;
      if (!w || !table) return;
      client?.dispose();
      const c = new FloodClient();
      client = c;
      // The storm of 26 July 2005, exactly as recorded.
      const sp = { ...DEFAULT_SCENARIO };
      const gaugeCell = pickGaugeCell(w);
      c.on('frame', onFrame);
      c.on('busy', ({ at, target }) => {
        status.hidden = false;
        status.textContent = `Going back: ${fmtClock(at)} of ${fmtClock(target)}`;
      });
      c.on('error', ({ message }) => {
        status.hidden = false;
        status.textContent = message;
      });
      c.send({ type: 'init', setup: buildFloodSetup(w), forcing: buildForcing(sp), edges: table, ground: w.ground, gaugeCell, mode: 'vehicle', notLand: notLand(w) });
      setPlaying(false);
      journey = null;
    }

    /** One button: start, pause, resume, or (after arriving) run again. */
    function run() {
      if (!client || start < 0 || goal < 0) return;
      if (journey?.status === 'arrived') {
        resetTrip(null, true);
        return;
      }
      if (holding) {
        clearTimeout(holding);
        holding = null;
      }
      if (playing) client.send({ type: 'pause' });
      else {
        client.send({ type: 'play', speed: Number(speed) });
        if (minute === 0) announce('Storm started.');
      }
    }

    /** Back to t+00:00 with the current trip and settings; optionally start playing. */
    function resetTrip(reason: string | null, play = false) {
      syncURL();
      if (holding) {
        clearTimeout(holding);
        holding = null;
      }
      journey = null;
      anim = null;
      logLines.length = 0;
      if (reason) log(0, `${reason}. The trip was planned again from t+00:00.`);
      renderTrip();
      if (!client) return;
      client.send({ type: 'pause' });
      client.send({ type: 'seek', minute: 0 });
      if (play) client.send({ type: 'play', speed: Number(speed) });
    }

    function setPlaying(p: boolean) {
      playing = p;
      runBtn.textContent = journey?.status === 'arrived' ? 'Run the storm again' : p ? 'Pause' : holding ? 'Continue' : minute > 0 ? 'Resume the storm' : 'Start the storm';
      map.setAnimating(p || !!anim);
    }

    function onFrame(f: FrameMsg) {
      if (signal.aborted) return;
      minute = f.minute;
      status.hidden = true;
      map.setDepth(f.depth, f.flow, { reset: true, intervalMs: 0 });
      map.setEdgeState(f.edgeState);
      map.setRain(clamp(f.stats.rain / 120, 0, 1));
      cond = { state: f.edgeState, depth: f.edgeDepth, risk: f.edgeRisk, lambda: 0 };
      if (net && start >= 0 && goal >= 0 && start !== goal) {
        if (!journey || f.minute < jMinute) {
          journey = new Journey(net, start, goal, leaveAt, algo);
          jMinute = f.minute;
          handle(journey.step(f.minute, 0, cond));
        } else if (f.minute > jMinute) {
          const dt = f.minute - jMinute;
          jMinute = f.minute;
          handle(journey.step(f.minute, dt, cond));
        }
      }
      updateClock(f);
      renderRoutes();
      setPlaying(f.playing);
      map.requestRender();
      requestAnimationFrame(() => client?.send({ type: 'ack' }));
    }

    /** Turn journey events into map marks, log lines and pauses. */
    function handle(events: JourneyEvent[]) {
      for (const e of events) {
        const when = e.minute;
        switch (e.kind) {
          case 'plan': {
            const p = e.plan;
            showSearch(p);
            if (!p.best) {
              log(when, e.reason === 'start' ? `No route exists from ${startName} to ${goalName} right now: every way is closed.` : 'No open route is left from here. The car waits for the water to drop.', true);
              break;
            }
            const b = p.best;
            if (e.reason === 'start') log(when, `${ALGO_NAMES[p.algo]} found the best route: ${fmtMinutes(b.minutes)}, ${fmtNum(b.km, 1)} km via ${b.via}. It explored ${fmtInt(p.expanded)} junctions.${p.alternatives.length ? ` Alternatives: ${p.alternatives.map((a, i) => `${'BC'[i]} ${fmtMinutes(a.minutes)} via ${a.via}`).join('; ')}.` : ''}`);
            else if (e.reason === 'blocked') log(when, `Re-planned with ${ALGO_NAMES[p.algo]} from ${journey?.status === 'driving' ? 'the car\'s position' : 'the start'}: new route ${fmtMinutes(b.minutes)} via ${b.via} (${fmtInt(p.expanded)} junctions explored).`, true);
            else if (e.reason === 'better') log(when, e.prev?.status === 'slow' ? `Water on the current route is slowing it down; switched to a drier route via ${b.via} (${fmtMinutes(b.minutes)}).` : `A clearly faster route opened: via ${b.via} (${fmtMinutes(b.minutes)}).`);
            else log(when, `A road reopened: new route via ${b.via} (${fmtMinutes(b.minutes)}).`, true);
            break;
          }
          case 'blocked': {
            const what = roadName(e.edge);
            const why = net!.kind[e.edge] === 'bridge' ? 'the river has risen above the bridge deck' : net!.kind[e.edge] === 'tunnel' ? 'the underpass has filled with water' : `${fmtNum(e.depth, 2)} m of water is over the road (cars stop at 0.30 m)`;
            log(when, `${capital(what)} is closed: ${why}. The current route through it can no longer be used.`, true);
            hold();
            break;
          }
          case 'depart':
            log(when, `The car leaves ${startName}.`);
            break;
          case 'turnback':
            log(when, `${capital(roadName(e.edge))} flooded under the car; it turns back to the last junction.`, true);
            break;
          case 'pushon':
            log(when, `${capital(roadName(e.edge))} flooded under the car, but it is nearly through, so it pushes on slowly.`);
            break;
          case 'stuck':
            log(when, `Stuck: no open road leads to ${goalName}. ${journey?.status === 'planning' ? 'The trip cannot start until the water drops.' : 'The car waits at a junction and the planner tries again every minute.'}`, true);
            break;
          case 'arrive':
            log(when, `Arrived at ${goalName} after ${fmtMinutes(e.tripMinutes)} on the road, with ${journey?.replans ?? 0} re-plan${journey?.replans === 1 ? '' : 's'}.`, true);
            client?.send({ type: 'pause' });
            announce(`Arrived after ${fmtMinutes(e.tripMinutes)}.`);
            break;
        }
      }
      renderLog();
    }

    /** Hold the storm briefly on a re-plan so people can see what happened. */
    function hold() {
      if (!playing || !client) return;
      client.send({ type: 'pause' });
      if (holding) clearTimeout(holding);
      holding = setTimeout(() => {
        holding = null;
        if (!signal.aborted && journey?.status !== 'arrived') client?.send({ type: 'play', speed: Number(speed) });
      }, HOLD_MS);
    }

    function roadName(e: number): string {
      const n = net!;
      const kind = n.kind[e] === 'bridge' ? 'bridge' : n.kind[e] === 'tunnel' ? 'underpass' : 'road';
      return n.street[e] ? `${n.street[e]}${kind !== 'road' ? ` (${kind})` : ''}` : `an unnamed ${kind} (${n.code[e]})`;
    }

    // ── Explaining the search ──
    function showSearch(p: PlanResult) {
      if (!reduce()) {
        anim = { nodes: p.explored, at: performance.now() };
        map.setAnimating(true);
      }
      const a = ALGO_NAMES[p.algo];
      const parts: HTMLElement[] = [];
      parts.push(h('p', null, h('strong', null, `${a} explored ${fmtInt(p.expanded)} junctions`), ' to find this route (the dots that light up on the map, in the order it visited them).'));
      if (p.algo === 'astar') {
        const saving = p.ucsExpanded > 0 ? Math.round((1 - p.expanded / p.ucsExpanded) * 100) : 0;
        parts.push(h('p', null, `Uniform Cost Search would explore ${fmtInt(p.ucsExpanded)} to find the same route. A* explores ${saving}% fewer because it adds the straight-line distance to the destination (divided by the fastest speed) to each junction's cost so far: f = g + h. It always tries the junction with the smallest f, so it heads towards the destination and never misses a faster route.`));
      } else if (p.algo === 'ucs') {
        parts.push(h('p', null, `Uniform Cost always expands the cheapest junction so far, in every direction, like a ripple. It finds the best route, but A* finds the same one exploring only ${fmtInt(p.astarExpanded)} junctions.`));
      } else {
        const worse = p.best && Number.isFinite(p.optimalCost) && p.optimalCost > 0 ? (p.best.cost - p.optimalCost) / p.optimalCost : 0;
        const how = p.algo === 'greedy' ? 'Greedy Best-First only looks at the straight-line distance to the destination (h), not the time already spent (g), so it rushes towards the goal and can be led down slow roads.' : p.algo === 'bfs' ? 'Breadth-First counts road segments, not minutes, so it finds the route with the fewest segments, not the fastest.' : 'Depth-First follows one road as far as it can and returns the first route it stumbles into.';
        parts.push(h('p', null, how, ' ', worse > 0.005 ? h('strong', null, `Its route is ${Math.round(worse * 100)}% slower than the best possible.`) : 'This time its route happens to be as good as the best one.', ` A* would explore ${fmtInt(p.astarExpanded)} junctions and always find the best route.`));
      }
      parts.push(h('p', { class: 'small muted' }, 'Alternatives B and C come from searching again with the roads of the earlier routes made more expensive, so the search prefers different roads.'));
      searchNote.replaceChildren(...parts);
    }

    // ── Panels ──
    function renderTrip() {
      const w = world;
      if (!w || start < 0 || goal < 0) {
        tripLine.textContent = 'Choose a trip above, or tap the map: first the start, then the destination.';
        updatePickNote();
        return;
      }
      startName = placeName(start);
      goalName = placeName(goal);
      tripLine.replaceChildren(h('span', { class: 'trip-dot start' }), ` From ${startName} `, h('span', { class: 'trip-dot goal' }), ` to ${goalName}, leaving at ${fmtClock(leaveAt)}.`);
      updatePickNote();
      fitTrip();
    }

    function renderRoutes() {
      const j = journey;
      if (!j || !j.route) {
        routesList.replaceChildren(h('li', null, j ? 'No open route right now.' : 'Choose a trip to see its routes.'));
        return;
      }
      const cur = cond ? (j.status === 'driving' ? remaining(j) : j.route) : j.route;
      const rows: HTMLElement[] = [];
      rows.push(routeRow('A', cur, j.status === 'driving' ? 'the car is following it' : j.status === 'arrived' ? 'the route it took' : 'the planned route', 'best'));
      j.alternatives.forEach((a, i) => rows.push(routeRow('BC'[i], a, a.status === 'blocked' ? 'closed by water' : `alternative, ${fmtMinutes(a.minutes - cur.minutes)} slower`, 'alt')));
      for (const ab of j.abandoned.slice(-2)) rows.push(routeRow('×', ab.route, `given up at ${fmtClock(ab.minute)}: ${roadName(ab.edge)} closed`, 'dead'));
      routesList.replaceChildren(...rows);
    }

    function remaining(j: Journey): RouteInfo {
      const r = j.route!;
      const from = j.pos > 0 ? j.i : j.i;
      let minutes = 0, km = 0;
      for (let k = from; k < r.edges.length; k++) {
        const e = r.edges[k];
        km += net!.length[e] / 1000;
        const s = cond!.state[e];
        minutes += s === 2 ? 0 : net!.length[e] / net!.speed[e] / 60;
      }
      return { ...r, minutes, km };
    }

    function routeRow(letter: string, r: RouteInfo, what: string, kind: 'best' | 'alt' | 'dead'): HTMLElement {
      return h(
        'li',
        { class: `route-row ${kind}` },
        h('span', { class: 'route-letter' }, letter),
        h('span', null, h('strong', null, kind === 'dead' ? 'Old route' : `${fmtMinutes(r.minutes)} · ${fmtNum(r.km, 1)} km`), ` via ${r.via}`, h('br'), h('span', { class: 'small muted' }, `${what}${kind !== 'dead' && r.status === 'slow' ? '; water slows part of it' : ''}`)),
      );
    }

    function log(minute: number, text: string, strong = false) {
      logLines.push({ minute, text, strong });
      renderLog();
    }

    function renderLog() {
      logList.replaceChildren(...[...logLines].reverse().map((l) => h('li', { class: l.strong ? 'strong' : null }, h('span', { class: 'mono' }, fmtClock(l.minute)), ` ${l.text}`)));
    }

    function updateClock(f: FrameMsg) {
      clockBig.textContent = fmtClock(f.minute);
      clockLine.textContent = `${fmtInt(f.stats.rain)} mm/h rain · ${fmtInt(f.stats.blocked)} roads closed`;
      const j = journey;
      clockLine2.textContent = !j
        ? 'Choose a trip'
        : j.status === 'planning'
          ? j.route
            ? `Car leaves at ${fmtClock(leaveAt)} · planned route ${fmtMinutes(j.route.minutes)}`
            : 'No open route from the start'
          : j.status === 'driving'
            ? `Driving · ${j.replans} re-plan${j.replans === 1 ? '' : 's'}`
            : j.status === 'stuck'
              ? 'Stuck: waiting for the water to drop'
              : `Arrived at ${fmtClock(j.arrivedAt)} · ${j.replans} re-plan${j.replans === 1 ? '' : 's'}`;
    }

    function syncURL() {
      const p: Record<string, string> = {};
      if (algo !== 'astar') p.algo = algo;
      if (leaveAt !== 120) p.leave = String(leaveAt);
      replaceParams(p);
    }

    // ── Drawing ──
    function draw(d: DrawCtx) {
      const w = world, j = journey;
      if (!w || !net) return;
      const { ctx, cam, pal } = d;
      const z = clamp(Math.sqrt(cam.zoom), 1, 2.4);
      const pt = (v: number) => cam.toScreen(w.graph.nodes[v].x, w.graph.nodes[v].y);
      const pathOf = (nodes: number[], from = 0) => {
        const p = new Path2D();
        for (let i = from; i < nodes.length; i++) {
          const [x, y] = pt(nodes[i]);
          if (i === from) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        return p;
      };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1. The search: explored junctions light up in order, then fade.
      if (anim) {
        const t = performance.now() - anim.at;
        const shown = reduce() ? anim.nodes.length : Math.floor(anim.nodes.length * Math.min(1, t / REVEAL_MS));
        const fade = t < REVEAL_MS ? 1 : 1 - (t - REVEAL_MS) / FADE_MS;
        if (fade <= 0) anim = null;
        else {
          ctx.fillStyle = css(mix(pal.accent, pal.text, 0.55), 0.85 * fade);
          for (let k = 0; k < shown; k++) {
            const [x, y] = pt(anim.nodes[k]);
            ctx.fillRect(x - 2.4 * z, y - 2.4 * z, 4.8 * z, 4.8 * z);
          }
          if (shown < anim.nodes.length && shown > 0) {
            const [x, y] = pt(anim.nodes[shown - 1]);
            ctx.beginPath();
            ctx.arc(x, y, 7 * z, 0, Math.PI * 2);
            ctx.strokeStyle = css(pal.text, 0.8);
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
          map.requestRender();
        }
      }

      if (j) {
        // 2. Routes given up: crossed out where the road closed.
        for (const ab of j.abandoned) {
          const p = pathOf(ab.route.nodes);
          ctx.strokeStyle = css(pal.background, 0.7);
          ctx.lineWidth = 6 * z;
          ctx.stroke(p);
          ctx.setLineDash([7 * z, 6 * z]);
          ctx.strokeStyle = css(pal.text, 0.8);
          ctx.lineWidth = 3 * z;
          ctx.stroke(p);
          ctx.setLineDash([]);
          blockMark(d, ab.edge, z, `${shortName(ab.edge)} closed`);
        }
        // 3. Alternatives, dashed and labelled.
        j.alternatives.forEach((a, i) => {
          const p = pathOf(a.nodes);
          ctx.setLineDash([9 * z, 6 * z]);
          ctx.strokeStyle = css(pal.background, 0.75);
          ctx.lineWidth = 5.5 * z;
          ctx.stroke(p);
          ctx.strokeStyle = css(mix(pal.accent, pal.text, 0.5), a.status === 'blocked' ? 0.45 : 0.95);
          ctx.lineWidth = 3.2 * z;
          ctx.stroke(p);
          ctx.setLineDash([]);
          const mid = a.nodes[Math.floor(a.nodes.length * (0.4 + 0.15 * i))];
          if (mid !== undefined) {
            const [x, y] = pt(mid);
            tag(ctx, pal, x, y, `${'BC'[i]} · ${a.status === 'blocked' ? 'closed' : fmtMinutes(a.minutes)}`, false);
          }
        });
        // 4. The route being followed: driven part faint, the rest strong.
        if (j.route && j.route.nodes.length > 1) {
          const from = j.status === 'driving' ? j.i : 0;
          if (from > 0) {
            ctx.setLineDash([2 * z, 5 * z]);
            ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.3), 0.8);
            ctx.lineWidth = 2.4 * z;
            ctx.stroke(pathOf(j.route.nodes.slice(0, from + 1)));
            ctx.setLineDash([]);
          }
          const rest = new Path2D();
          const [cx, cy] = j.status === 'driving' ? cam.toScreen(...j.position()) : pt(j.route.nodes[0]);
          rest.moveTo(cx, cy);
          for (let i = from + 1; i < j.route.nodes.length; i++) {
            const [x, y] = pt(j.route.nodes[i]);
            rest.lineTo(x, y);
          }
          ctx.strokeStyle = css(pal.background, 0.9);
          ctx.lineWidth = 10 * z;
          ctx.stroke(rest);
          ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
          ctx.lineWidth = 5.5 * z;
          ctx.stroke(rest);
          const mid = j.route.nodes[Math.floor((from + j.route.nodes.length) / 2)];
          if (mid !== undefined && j.status !== 'arrived') {
            const [x, y] = pt(mid);
            tag(ctx, pal, x, y, `A · ${fmtMinutes(j.status === 'driving' && cond ? remaining(j).minutes : j.route.minutes)}`, true);
          }
        }
      }

      // 5. Start, destination and the car.
      if (start >= 0) {
        const [x, y] = pt(start);
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.text);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.background);
        ctx.fill();
        tag(ctx, pal, x, y + 22, 'Start', false);
      }
      if (goal >= 0) {
        const [x, y] = pt(goal);
        ctx.beginPath();
        ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.background, 0.95);
        ctx.fill();
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = css(pal.text);
        ctx.stroke();
        ctx.strokeStyle = css(pal.text);
        ctx.lineWidth = 2;
        shelterGlyph(ctx, x, y, 7);
        ctx.stroke();
        tag(ctx, pal, x, y + 28, 'Destination', false);
      }
      if (j && j.status !== 'planning') {
        const [x, y] = cam.toScreen(...j.position());
        const pulse = d.reducedMotion ? 0 : 0.5 + 0.5 * Math.sin(d.time * 4);
        ctx.beginPath();
        ctx.arc(x, y, 13 + 4 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = css(pal.text, 0.35 + 0.3 * pulse);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.background);
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = css(pal.text);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.text);
        ctx.fill();
        tag(ctx, pal, x + 20, y - 14, j.status === 'stuck' ? 'Car: stuck' : j.status === 'arrived' ? 'Car: arrived' : 'Car', true);
      }
      ctx.restore();
    }

    /** A closed road: a heavy cross in a hatched ring, and its name. */
    function blockMark(d: DrawCtx, e: number, z: number, label: string) {
      const w = world!;
      const { ctx, cam, pal } = d;
      const ed = w.graph.edges[e];
      const A = w.graph.nodes[ed.a], B = w.graph.nodes[ed.b];
      const [x, y] = cam.toScreen((A.x + B.x) / 2, (A.y + B.y) / 2);
      const r = 11 * Math.min(z, 1.6);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.background);
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = css(pal.text, 0.35);
      ctx.lineWidth = 1;
      for (let k = -2 * r; k < 2 * r; k += 4) {
        ctx.beginPath();
        ctx.moveTo(x + k - r, y - r);
        ctx.lineTo(x + k + r, y + r);
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = css(pal.text);
      ctx.stroke();
      const k = r * 0.55;
      ctx.beginPath();
      ctx.moveTo(x - k, y - k);
      ctx.lineTo(x + k, y + k);
      ctx.moveTo(x + k, y - k);
      ctx.lineTo(x - k, y + k);
      ctx.lineWidth = 3;
      ctx.stroke();
      tag(ctx, pal, x, y - r - 12, label, true);
    }

    function shortName(e: number): string {
      const n = net!;
      return n.street[e] || (n.kind[e] === 'bridge' ? `bridge ${n.code[e]}` : n.kind[e] === 'tunnel' ? `underpass ${n.code[e]}` : `road ${n.code[e]}`);
    }

    /** Fit the camera around the start and the destination. */
    function fitTrip() {
      const w = world;
      if (!w || start < 0 || goal < 0) return;
      const cam = map.camera;
      if (cam.width < 50) {
        setTimeout(fitTrip, 120);
        return;
      }
      const A = w.graph.nodes[start], B = w.graph.nodes[goal];
      const bw = Math.abs(A.x - B.x) + 2500, bh = Math.abs(A.y - B.y) + 2500;
      cam.fit();
      const fitScale = cam.scale;
      cam.scale = clamp(Math.min(cam.width / bw, cam.height / bh), fitScale, fitScale * 6);
      cam.cx = (A.x + B.x) / 2;
      cam.cy = (A.y + B.y) / 2;
      map.redraw();
    }

    // ── Load ──
    const q = prefs.get().quality;
    loadMumbai({ ...DEFAULT_MUMBAI, gridSize: q === 'high' ? 256 : q === 'low' ? 128 : 192 }).then(
      (w) => {
        if (signal.aborted) return;
        world = w;
        table = buildEdgeTable(w);
        net = journeyNet(w, 'vehicle');
        map.setWorld(w);
        status.hidden = true;
        startClient();
        applyPreset(0);
      },
      (err) => {
        status.textContent = `The map could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
      },
    );
    renderTrip();
    renderRoutes();
    searchNote.replaceChildren(h('p', { class: 'small muted' }, 'When a route is found, this explains how the algorithm searched for it.'));

    return () => {
      if (holding) clearTimeout(holding);
      client?.dispose();
      map.destroy();
      sheet.dispose();
    };
  },
};

function notLand(w: World): Uint8Array {
  const out = new Uint8Array(w.terrain.n * w.terrain.n);
  for (let k = 0; k < out.length; k++) out[k] = w.sea[k] || w.terrain.channel[k] ? 1 : 0;
  return out;
}

function tag(ctx: CanvasRenderingContext2D, pal: Palette, x: number, y: number, text: string, strong: boolean) {
  ctx.font = `${strong ? 600 : 500} 12px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(pal.background, 0.95);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = css(pal.text);
  ctx.fillText(text, x, y);
  ctx.textAlign = 'start';
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function legendItems(): HTMLElement[] {
  const item = (svg: string, label: string) => h('li', null, h('span', { html: svg, 'aria-hidden': 'true' }), label);
  return [
    item(`<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="var(--background)" stroke-width="9"/><path d="M2 7h38" stroke="color-mix(in oklab, var(--primary) 80%, var(--text))" stroke-width="5" stroke-linecap="round"/></svg>`, 'A: the best route, the one being used'),
    item(`<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="color-mix(in oklab, var(--accent) 70%, var(--text))" stroke-width="2.6" stroke-dasharray="7 5"/></svg>`, 'B, C: alternative routes'),
    item(`<svg viewBox="0 0 42 14"><path d="M2 7h38" stroke="color-mix(in oklab, var(--text) 65%, var(--background))" stroke-width="2.4" stroke-dasharray="5 5"/><circle cx="21" cy="7" r="5.5" fill="var(--background)" stroke="var(--text)" stroke-width="1.8"/><path d="M18.3 4.3l5.4 5.4M23.7 4.3l-5.4 5.4" stroke="var(--text)" stroke-width="2"/></svg>`, 'A route given up, and the road that closed'),
    item(`<svg viewBox="0 0 42 14"><rect x="10" y="3" width="3" height="3" fill="color-mix(in oklab, var(--accent) 65%, var(--text))"/><rect x="17" y="8" width="3" height="3" fill="color-mix(in oklab, var(--accent) 65%, var(--text))"/><rect x="25" y="4" width="3" height="3" fill="color-mix(in oklab, var(--accent) 65%, var(--text))"/></svg>`, 'Junctions the search explored'),
    item(`<svg viewBox="0 0 42 14"><circle cx="21" cy="7" r="5" fill="var(--background)" stroke="var(--text)" stroke-width="2.2"/><circle cx="21" cy="7" r="2" fill="var(--text)"/></svg>`, 'The car'),
  ];
}

export default page;
