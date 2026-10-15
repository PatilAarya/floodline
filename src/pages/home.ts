/**
 * Home: the story of the project told on the real map.
 *
 * The Mithi basin fills the screen behind the text (a passive MapView: no
 * pointer or wheel handling, so it never steals the scroll). As you scroll,
 * each chapter changes the same canvas:
 *
 *   0  calm: sea, creek and river at their normal level
 *   1  rain: streaks, water starting to rise
 *   2  river and tide: the Bayesian flood-risk hatching appears
 *   3  roads disappear: closed roads pulse, subways fill
 *   4  the plan: CSP + simulated annealing assign every group a centre,
 *      drawn as arcs from neighbourhoods to relief centres
 *
 * Water rises and falls smoothly between chapters (the instant water-level
 * model, re-run in small steps), and the camera drifts slowly. With reduced
 * motion the water jumps straight to each chapter's level and nothing drifts.
 * Every number in the text is computed from the map, not typed in.
 */
import { mumbaiNetwork, riverClass } from '../ai/bayes/cpt';
import { solveCSP } from '../ai/csp/backtracking';
import { maximisePartial } from '../ai/csp/relax';
import { Annealer } from '../ai/local/simulatedAnnealing';
import type { Page } from '../core/router';
import { fmtInt, fmtNum } from '../core/units';
import { shelterGlyph } from '../render/canvas/overlays';
import { RiskLayer } from '../render/canvas/risk';
import type { DrawCtx } from '../render/canvas/types';
import { css, mix } from '../render/theme';
import { buildInstance, prepareNetwork } from '../sim/assignment';
import { pickGaugeCell } from '../sim/floodEngine';
import { buildEdgeTable, computeEdgeStates, waterLevelFlood, type EdgeTable } from '../sim/hydrology';
import { buildRiskSetup, hoodRisk, riskPosterior } from '../sim/riskModel';
import { fromHTML, h } from '../ui/dom';
import { glyph } from '../ui/glyphs';
import { createMapView } from '../ui/mapView';
import { DEFAULT_MUMBAI } from '../world/mumbai';
import type { World } from '../world/types';
import { loadMumbai } from '../world/worldClient';

/** Water level of the "roads" and "plan" chapters, metres above sea. */
const PLAN_LEVEL = 2;

interface Step {
  level: number;
  rain: number;
  risk: boolean;
  plan: boolean;
  label: string;
}

const STEPS: Step[] = [
  { level: 0.6, rain: 0, risk: false, plan: false, label: 'a normal monsoon tide' },
  { level: 1.2, rain: 0.9, risk: false, plan: false, label: 'rain on a high tide' },
  { level: 1.6, rain: 0.6, risk: true, plan: false, label: 'the Mithi over its banks' },
  { level: PLAN_LEVEL, rain: 0.3, risk: false, plan: false, label: 'roads under water' },
  { level: PLAN_LEVEL, rain: 0, risk: false, plan: true, label: 'the plan' },
];

const CHAPTERS = [
  { n: '01', title: 'Rain becomes risk', body: 'A Bayesian network turns noisy rain and Mithi River gauges into a flood-risk posterior for every neighbourhood, from Dharavi to Kurla.', href: '#/bayes', cta: 'Explore the network' },
  { n: '02', title: 'People meet shelters', body: 'A constraint solver assigns evacuee groups to relief centres on high ground within capacity and deadline, then simulated annealing improves the plan.', href: '#/assignment', cta: 'Open the assignment lab' },
  { n: '03', title: 'Roads disappear', body: 'Rain, tide and the Mithi spread water across real Mumbai terrain. Subways fill, bridges close, roads go under. A* re-plans every group from where it stands.', href: '#/algorithms', cta: 'Race the search algorithms' },
  { n: '04', title: 'Evidence, not claims', body: 'Fifty seeded monsoon storms, three strategies, the same water for each: risk-aware dynamic re-planning against naive static routing.', href: '#/experiments', cta: 'See the experiments' },
];

const page: Page = {
  title: 'Floodline',
  mount({ root, signal }) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let world: World | null = null;
    let table: EdgeTable | null = null;
    let active = 0;
    let level = STEPS[0].level;
    let target = level;
    let stageVisible = true;
    let levelTimer: ReturnType<typeof setTimeout> | null = null;
    let driftRaf = 0;
    let driftT0 = performance.now();
    let base: { cx: number; cy: number } | null = null;
    const riskLayer = new RiskLayer();
    let plan: { flows: { hood: number; centre: number; people: number }[]; centres: number[]; placed: number; total: number; mean: number } | null = null;
    let lastDrift = 0;

    const map = createMapView({ label: 'The Mithi River basin', interactive: false, drawExtra: (d) => drawExtra(d) });
    map.setLayers({ labels: false, hoods: false, streets: false, contours: false, shelters: false });
    const levelFigure = h('div', { class: 'figure home-level' }, '0.6 m');
    const levelLabel = h('div', { class: 'figure-label' }, STEPS[0].label);
    const stage = h('div', { class: 'home-stage', 'aria-hidden': 'true' }, map.el, h('div', { class: 'home-scrim' }), h('div', { class: 'home-gauge' }, levelFigure, levelLabel));

    // Numbers filled in once the map is loaded.
    const nums = {
      riskHoods: h('span', { class: 'mono' }, '…'),
      riskPeople: h('span', { class: 'mono' }, '…'),
      roads: h('span', null, 'Computing the closures…'),
      planLine: h('span', null, 'Computing the plan on this device…'),
    };

    const step = (i: number, ...content: (Node | string)[]) => h('section', { class: `home-step${i === 0 ? ' home-hero is-active' : ''}`, 'data-step': i, 'aria-labelledby': i === 0 ? 'home-title' : null }, h('div', { class: 'home-copy' }, ...content));
    const steps = [
      step(
        0,
        h('p', { class: 'eyebrow' }, 'Dynamic flood evacuation planner · Mithi River basin, Mumbai'),
        h('h1', { class: 'display', id: 'home-title' }, 'Floodline'),
        h('p', { class: 'lede' }, 'Navigation apps assume the road network is fixed. Floodline handles roads that disappear and risk that is uncertain.'),
        h('p', { class: 'cluster' }, h('a', { class: 'btn btn-primary btn-large', href: '#/simulator' }, 'Flood Mumbai', fromHTML(glyph('arrow'))), h('a', { class: 'btn', href: '#/viva' }, 'Viva notes')),
        h('p', { class: 'small muted home-scroll-hint' }, 'Scroll to watch the basin flood.'),
      ),
      step(
        1,
        h('p', { class: 'marker' }, '01 · rain'),
        h('h2', null, 'It starts with rain'),
        h('p', null, 'On 26 July 2005 about 944 mm of rain fell on Mumbai in 24 hours. The storm drains are designed for 25 mm an hour; at its peak the storm brought about six times as much, just as a high tide shut the outfalls to the sea.'),
        h('p', null, 'Floodline does not see the rain directly. It hears two noisy gauges, one for rain and one for the Mithi River, which are right only 80 to 90% of the time.'),
      ),
      step(
        2,
        h('p', { class: 'marker' }, '02 · risk'),
        h('h2', null, 'Risk you cannot see yet'),
        h('p', null, 'A Bayesian network weighs both gauges against what is known about each neighbourhood: how low it lies and how well it drains. With the rain gauge reading heavy and the river gauge high, ', nums.riskHoods, ' neighbourhoods, home to ', nums.riskPeople, ' people who would need a relief centre, are more likely than not to flood. The hatching is denser where the risk is higher.'),
        h('a', { class: 'btn', href: '#/bayes' }, 'Explore the network', fromHTML(glyph('arrow'))),
      ),
      step(
        3,
        h('p', { class: 'marker' }, '03 · roads'),
        h('h2', null, 'Roads disappear'),
        h('p', null, nums.roads, ' A route planned an hour ago may now end in water.'),
        h('a', { class: 'btn', href: `#/algorithms?level=${PLAN_LEVEL}` }, 'Race the searches on this flood', fromHTML(glyph('arrow'))),
      ),
      step(
        4,
        h('p', { class: 'marker' }, '04 · plan'),
        h('h2', null, 'The plan re-routes'),
        h('p', null, 'A constraint solver gives every group a relief centre it can still reach, with room for it; simulated annealing then shortens the trips and spreads the load. ', nums.planLine),
        h('p', null, 'In the running simulation the same plan is re-made whenever a centre is cut off, and every group re-plans its route with A* as roads close.'),
        h('p', { class: 'cluster' }, h('a', { class: 'btn btn-primary btn-large', href: '#/simulator?strategy=risk' }, 'Run the storm', fromHTML(glyph('arrow'))), h('a', { class: 'btn', href: '#/assignment' }, 'Open the assignment lab')),
      ),
    ];

    root.append(
      h(
        'div',
        { class: 'home page-enter' },
        h('div', { class: 'home-scrolly' }, stage, h('div', { class: 'home-steps' }, ...steps)),
        h(
          'div',
          { class: 'page home-after' },
          h(
            'section',
            { class: 'section', 'aria-label': 'How it works' },
            h('p', { class: 'eyebrow' }, 'How it works'),
            ...CHAPTERS.map((c) =>
              h(
                'div',
                { class: 'margin-grid', style: 'padding: var(--s-5) 0; border-top: 1px solid var(--hairline)' },
                h('p', { class: 'marker figure', style: 'font-size: var(--step-3)' }, c.n),
                h('div', null, h('h2', { style: 'font-size: var(--step-2)' }, c.title), h('p', null, c.body), h('a', { class: 'btn', href: c.href }, c.cta, fromHTML(glyph('arrow')))),
              ),
            ),
          ),
          h('section', { class: 'section margin-grid' }, h('p', { class: 'marker' }, 'data'), h('p', { class: 'small muted' }, 'Map data © OpenStreetMap contributors (ODbL). Elevation: NASA SRTM via OpenTopoData. Storms are modelled on real Mumbai monsoon events. Everything runs in your browser; nothing is sent anywhere.')),
        ),
      ),
    );

    // ── Chapters: the step nearest the middle of the screen is active ──
    const scrolly = root.querySelector('.home-scrolly') as HTMLElement;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    function onScroll() {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        const mid = innerHeight / 2;
        let best = 0, bestD = Infinity;
        steps.forEach((st, i) => {
          const r = st.getBoundingClientRect();
          const d = Math.abs((r.top + r.bottom) / 2 - mid);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        const vis = scrolly.getBoundingClientRect().bottom > 0;
        if (vis !== stageVisible) {
          stageVisible = vis;
          map.setAnimating(vis && !reduce.matches);
          if (vis) startDrift();
        }
        setStep(best);
      }, 60);
    }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    const onResize = () => setTimeout(frame, 50);
    addEventListener('resize', onResize);
    map.setAnimating(!reduce.matches);

    function setStep(i: number) {
      if (!Number.isFinite(i) || i === active) return;
      active = i;
      steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
      const st = STEPS[i];
      target = st.level;
      levelLabel.textContent = st.label;
      map.setRain(reduce.matches ? 0 : st.rain);
      map.requestRender();
      if (st.plan) ensurePlan();
      moveWater();
    }

    /** Move the water towards the chapter's level in small steps (or at once with reduced motion). */
    function moveWater() {
      if (levelTimer) clearTimeout(levelTimer);
      levelTimer = null;
      if (!world) return;
      const diff = target - level;
      if (Math.abs(diff) < 1e-3) return;
      const jump = reduce.matches;
      level = jump ? target : level + Math.sign(diff) * Math.min(Math.abs(diff), 0.1);
      applyLevel(jump ? 0 : 110);
      if (!jump && Math.abs(target - level) > 1e-3) levelTimer = setTimeout(moveWater, 110);
    }

    function applyLevel(interval: number) {
      const w = world;
      if (!w || !table) return;
      const depth = waterLevelFlood(w, level);
      const st = new Uint8Array(table.count), dep = new Float32Array(table.count);
      computeEdgeStates(table, depth, w.terrain.height, w.ground, 'vehicle', st, dep);
      map.setDepth(depth, null, { reset: interval === 0, intervalMs: interval });
      map.setEdgeState(st);
      levelFigure.textContent = `${level.toFixed(1)} m`;
    }

    // ── Overlays ──
    function drawExtra(d: DrawCtx) {
      const w = world;
      if (!w) return;
      if (STEPS[active].risk) riskLayer.draw(d, w);
      if (STEPS[active].plan && plan) drawPlan(d, w);
    }

    function drawPlan(d: DrawCtx, w: World) {
      const p = plan!;
      const { ctx, cam, pal } = d;
      let maxP = 1;
      for (const f of p.flows) maxP = Math.max(maxP, f.people);
      ctx.save();
      ctx.lineCap = 'round';
      for (const f of p.flows) {
        const hd = w.hoods[f.hood], nd = w.graph.nodes[w.shelters[f.centre].node];
        const [ax, ay] = cam.toScreen(hd.cx, hd.cy), [bx, by] = cam.toScreen(nd.x, nd.y);
        const cx = (ax + bx) / 2 - (by - ay) * 0.15, cy = (ay + by) / 2 + (bx - ax) * 0.15;
        const width = 1.2 + 6 * Math.sqrt(f.people / maxP);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cx, cy, bx, by);
        ctx.strokeStyle = css(pal.background, 0.7);
        ctx.lineWidth = width + 3;
        ctx.stroke();
        ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.35), 0.85);
        ctx.lineWidth = width;
        ctx.stroke();
      }
      for (const s of p.centres) {
        const nd = w.graph.nodes[w.shelters[s].node];
        const [x, y] = cam.toScreen(nd.x, nd.y);
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.background, 0.92);
        ctx.fill();
        ctx.strokeStyle = css(pal.text, 0.6);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = css(pal.text);
        ctx.strokeStyle = css(pal.text);
        shelterGlyph(ctx, x, y, 6);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
    }

    /** The CSP + SA plan at 3 m (computed once, on first reaching chapter 4). */
    function ensurePlan() {
      const w = world;
      if (plan || !w || !table) return;
      setTimeout(() => {
        if (signal.aborted || plan) return;
        const prep = prepareNetwork(w, PLAN_LEVEL, 'vehicle', table!);
        const inst = buildInstance(prep, { deadline: 90, maxRisk: 1, capacityScale: 1, closed: [] });
        const r = solveCSP(inst.csp, { forwardChecking: true, mrv: true, degree: true, lcv: true, maxNodes: 20_000, maxMs: 800 });
        const start = r.status === 'solved' ? r.assignment : maximisePartial(inst.csp).assignment;
        const sa = new Annealer(inst.model, start, { iterations: 60_000, cooling: 'geometric', seed: 'home' }).finish();
        const a = sa.bestAssign;
        const flows = new Map<string, { hood: number; centre: number; people: number }>();
        let placed = 0, total = 0, tSum = 0;
        inst.groups.forEach((g, x) => {
          total += g.size;
          if (a[x] < 0) return;
          placed += g.size;
          tSum += g.size * inst.time[x * inst.S + a[x]];
          const centre = inst.centres[a[x]].shelter;
          const k = `${g.hood}:${centre}`;
          const f = flows.get(k) ?? { hood: g.hood, centre, people: 0 };
          f.people += g.size;
          flows.set(k, f);
        });
        plan = { flows: [...flows.values()], centres: [...new Set([...flows.values()].map((f) => f.centre))], placed, total, mean: placed ? tSum / placed : NaN };
        nums.planLine.textContent = `Made now, with the water at ${PLAN_LEVEL} m, it can place ${fmtInt(placed)} of ${fmtInt(total)} people, in ${plan.centres.length} centres ${fmtNum(plan.mean, 0)} minutes away on average by bus in monsoon traffic; the others are already cut off, and the plan says so instead of pretending. Made at the warning, before the water arrives, the same solver places everyone. That is why Floodline plans early and re-plans as roads close.`;
        map.requestRender();
      }, 30);
    }

    // ── Camera drift ──
    function startDrift() {
      if (driftRaf || reduce.matches || !world) return;
      const tick = (t: number) => {
        driftRaf = 0;
        if (!stageVisible || signal.aborted || reduce.matches || !base) return;
        if (t - lastDrift > 33) {
          lastDrift = t;
          const s = (t - driftT0) / 1000;
          const cam = map.camera;
          const r = Math.min(cam.width, cam.height) / cam.scale;
          cam.cx = base.cx + Math.sin(s / 23) * r * 0.05;
          cam.cy = base.cy + Math.cos(s / 31) * r * 0.035;
          map.redraw();
        }
        driftRaf = requestAnimationFrame(tick);
      };
      driftRaf = requestAnimationFrame(tick);
    }

    // ── Load the map, then compute the chapter numbers ──
    loadMumbai({ ...DEFAULT_MUMBAI, gridSize: 128 }).then(
      (w) => {
        if (signal.aborted) return;
        world = w;
        table = buildEdgeTable(w);
        map.setWorld(w);
        frame();
        driftT0 = performance.now();
        level = STEPS[active].level;
        target = level;
        applyLevel(0);
        map.setRain(reduce.matches ? 0 : STEPS[active].rain);
        computeNumbers(w);
        startDrift();
      },
      () => {
        stage.classList.add('home-stage-empty');
      },
    );

    /**
     * Put the basin where the text is not: its centre at about two thirds of
     * the width on wide screens (text on the left); on phones the map covers
     * the whole stage and the text sits on a scrim at the bottom.
     */
    function frame() {
      const w = world;
      if (!w) return;
      const cam = map.camera;
      // The map measures itself a moment after mounting; wait for a real size.
      if (cam.width < 50 || cam.height < 50) {
        setTimeout(frame, 100);
        return;
      }
      cam.fit();
      const wide = cam.width > 760;
      const b = w.bounds;
      const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
      // Wide: fit the basin, a little enlarged. Narrow (portrait): cover the
      // whole stage, so the text never hangs over an empty edge.
      cam.scale = wide ? cam.scale * 1.08 : Math.max(cam.width / bw, cam.height / bh) * 1.05;
      const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
      cam.cx = mx - (cam.width * (wide ? 0.66 : 0.5) - cam.width / 2) / cam.scale;
      cam.cy = my;
      base = { cx: cam.cx, cy: cam.cy };
      map.redraw();
    }

    function computeNumbers(w: World) {
      // Chapter 2: the network with the river gauge reading the 2.2 m level.
      const rs = buildRiskSetup(w, 'mumbai', pickGaugeCell(w));
      const river = riverClass(Math.max(STEPS[2].level, rs.gaugeBed + 0.6), rs.gaugeBed, rs.gaugeBank);
      // Rain gauge heavy (the rain chapter), river gauge from the water level.
      const dist = hoodRisk(rs, riskPosterior(mumbaiNetwork(), 2, river));
      const pHigh = new Float32Array(w.hoods.length);
      let hoods = 0, people = 0;
      w.hoods.forEach((hd, i) => {
        pHigh[i] = dist[i * 3 + 2];
        if (pHigh[i] >= 0.5) {
          hoods++;
          people += hd.population;
        }
      });
      riskLayer.setRisk(pHigh);
      nums.riskHoods.textContent = String(hoods);
      nums.riskPeople.textContent = fmtInt(people);
      // Chapter 3: roads and people cut off at PLAN_LEVEL.
      setTimeout(() => {
        if (signal.aborted || !table) return;
        const prep = prepareNetwork(w, PLAN_LEVEL, 'vehicle', table);
        let closed = 0, subways = 0, bridges = 0;
        prep.edgeState.forEach((s, e) => {
          if (s !== 2) return;
          closed++;
          if (w.graph.edges[e].kind === 'tunnel') subways++;
          if (w.graph.edges[e].kind === 'bridge') bridges++;
        });
        let cut = 0;
        const inst = buildInstance(prep, { deadline: 999, maxRisk: 1, capacityScale: 1, closed: [] });
        inst.groups.forEach((g, x) => {
          if (!inst.csp.domains[x].length) cut += g.size;
        });
        const extras = [bridges ? `${bridges} bridge span${bridges > 1 ? 's' : ''}` : '', subways ? `${subways} subway${subways > 1 ? 's' : ''}` : ''].filter(Boolean);
        nums.roads.textContent = `With the water ${PLAN_LEVEL} m above sea level, ${fmtInt(closed)} road segments are closed${extras.length ? `, among them ${extras.join(' and ')}` : ''}, and ${fmtInt(cut)} people can no longer reach any relief centre by road.`;
      }, 50);
    }

    const onMotion = () => {
      map.setRain(reduce.matches ? 0 : STEPS[active].rain);
      map.setAnimating(stageVisible && !reduce.matches);
      startDrift();
    };
    reduce.addEventListener('change', onMotion);

    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      removeEventListener('resize', onResize);
      if (scrollTimer) clearTimeout(scrollTimer);
      reduce.removeEventListener('change', onMotion);
      if (levelTimer) clearTimeout(levelTimer);
      cancelAnimationFrame(driftRaf);
      map.destroy();
    };
  },
};

export default page;
