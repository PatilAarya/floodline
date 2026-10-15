/**
 * Experiments: the evidence. Many seeded storms, three strategies, and the
 * same water for all three in each storm (a paired comparison).
 *
 * Seeds run in a pool of Web Workers (src/sim/experimentClient.ts); each
 * worker simulates the flood once per seed and steps all three strategies'
 * evacuees through it (src/sim/experiment.ts). Results stream in as seeds
 * finish, the charts and the conclusion update as they arrive, and the run
 * can be cancelled at any time. Everything can be downloaded as CSV.
 */
import { mean, median, quantile, sd, signTest } from '../core/stats';
import { parseClamped, fmtInt, fmtNum } from '../core/units';
import { replaceParams, type Page } from '../core/router';
import type { Strategy } from '../sim/agents';
import type { SeedResult, SeedSpec, StrategyResult } from '../sim/experiment';
import { defaultWorkerCount, ExperimentPool } from '../sim/experimentClient';
import type { TravelMode } from '../sim/hydrology';
import { SCENARIO_IDS, SCENARIOS, type ScenarioId } from '../sim/scenario';
import { boxStrip, diffStrip, markerSwatch, pairedSeeds, type Marker, type Series } from '../ui/charts/strip';
import { createSegmented } from '../ui/controls/segmented';
import { createSlider } from '../ui/controls/slider';
import { announce, h } from '../ui/dom';
import { pageHead } from './_shared';

/** Grid used for experiments (the Simulator's "Low" quality): fast, and the same numbers as the Simulator there. */
const GRID = 128;
const ORDER: Strategy[] = ['naive', 'dynamic', 'risk'];
const NAMES: Record<Strategy, string> = { naive: 'Naive static', dynamic: 'Dynamic A*', risk: 'Risk-aware + CSP + SA' };
const MARKERS: Record<Strategy, Marker> = { naive: 'circle', dynamic: 'square', risk: 'diamond' };

type StormChoice = ScenarioId | 'mixed';

interface RunState {
  specs: SeedSpec[];
  results: (SeedResult | null)[];
  errors: string[];
  started: number;
  finished: number;
  cancelled: boolean;
}

/** The last run survives navigating away and back (but not a reload). */
let lastRun: RunState | null = null;

const page: Page = {
  title: 'Experiments',
  mount({ root, params: query, signal }) {
    let count = parseClamped(query.get('n'), 50, 5, 100);
    const stormParam = query.get('storm');
    let storm: StormChoice = stormParam === 'mixed' || (stormParam && stormParam in SCENARIOS) ? (stormParam as StormChoice) : 'jul2005';
    let travel: TravelMode = query.get('travel') === 'foot' ? 'foot' : 'vehicle';
    let pool: ExperimentPool | null = null;
    let run: RunState | null = lastRun;
    const partial = new Map<number, number>();
    let tick: ReturnType<typeof setInterval> | null = null;

    // ── Controls ──
    const countSlider = createSlider({ label: 'Storms (seeds)', min: 5, max: 100, step: 5, value: count, format: (v) => `${v} storms`, onChange: (v) => { count = v; syncURL(); } });
    const stormCtl = createSegmented<StormChoice>({
      label: 'Storm',
      value: storm,
      options: [...SCENARIO_IDS.map((id) => ({ value: id as StormChoice, label: SCENARIOS[id].label, hint: SCENARIOS[id].blurb })), { value: 'mixed', label: 'All four, in turn', hint: 'Seeds cycle through the four storm presets' }],
      onChange: (v) => { storm = v; syncURL(); },
    });
    const travelCtl = createSegmented<TravelMode>({ label: 'Evacuating', value: travel, options: [{ value: 'vehicle', label: 'By vehicle' }, { value: 'foot', label: 'On foot' }], onChange: (v) => { travel = v; syncURL(); } });
    const runBtn = h('button', { class: 'btn btn-primary btn-large', type: 'button' }, 'Run the experiment');
    const cancelBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Cancel');
    const csvBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Download CSV');
    runBtn.addEventListener('click', () => start());
    cancelBtn.addEventListener('click', () => stop(true));
    csvBtn.addEventListener('click', () => downloadCSV());
    const workers = defaultWorkerCount();

    const progressFill = h('div', { class: 'exp-progress-fill' });
    const progress = h('div', { class: 'exp-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0, 'aria-label': 'Experiment progress' }, h('div', { class: 'exp-progress-track' }), progressFill);
    const progressText = h('p', { class: 'small mono', 'aria-live': 'polite' });
    const results = h('div', { class: 'exp-results' });

    root.append(
      h(
        'div',
        { class: 'page page-enter' },
        pageHead('Evidence', 'Does dynamic planning actually help?', 'Each seed is a different storm: the same historic rainfall shape, with the peak, its timing and the tide shifted, and different sensor misreads. In every storm the three strategies evacuate through exactly the same water, so each storm is a fair head-to-head.'),
        h(
          'section',
          { class: 'margin-grid' },
          h('p', { class: 'marker' }, 'setup'),
          h(
            'div',
            null,
            h('ul', { class: 'legend exp-legend' }, ...ORDER.map((s) => h('li', null, h('span', { html: markerSwatch(MARKERS[s]) }), h('strong', null, NAMES[s]), ` ${{ naive: 'plans once on the dry map and never re-plans', dynamic: 'A* on live road states, re-plans when roads close', risk: 'CSP + annealing assign centres, risk-aware A* routes, re-assigns when centres are cut off' }[s]}.`))),
          ),
          h('p', { class: 'annot' }, `Runs in ${workers} background worker${workers > 1 ? 's' : ''}, so the page stays responsive. One storm takes 10 to 30 seconds per worker. Seed 1 is the historic storm exactly, the one the Simulator shows by default. Leaving this page stops the run; results so far are kept until you reload.`),
        ),
        h('div', { class: 'algo-controls' }, h('div', null, countSlider.el), h('div', null, stormCtl.el), h('div', null, travelCtl.el), h('div', null, h('div', { class: 'cluster' }, runBtn), h('div', { class: 'cluster', style: 'margin-top: var(--s-2)' }, cancelBtn, csvBtn))),
        h('div', { class: 'exp-progress-wrap' }, progress, progressText),
        results,
      ),
    );

    function syncURL() {
      const p: Record<string, string> = {};
      if (count !== 50) p.n = String(count);
      if (storm !== 'jul2005') p.storm = storm;
      if (travel !== 'vehicle') p.travel = travel;
      replaceParams(p);
    }

    function specs(): SeedSpec[] {
      return Array.from({ length: count }, (_, i) => {
        const scenario: ScenarioId = storm === 'mixed' ? SCENARIO_IDS[i % SCENARIO_IDS.length] : storm;
        return { scenario, seed: i === 0 ? 'mumbai' : `run-${i + 1}`, mode: travel };
      });
    }

    function start() {
      stop(false);
      const sp = specs();
      run = { specs: sp, results: sp.map(() => null), errors: [], started: performance.now(), finished: 0, cancelled: false };
      lastRun = run;
      partial.clear();
      const r = run;
      pool = new ExperimentPool(GRID, workers, {
        onProgress: (id, f) => partial.set(id, f),
        onResult: (id, res) => {
          if (r !== run) return;
          r.results[id] = res;
          r.finished++;
          partial.delete(id);
          renderResults();
          updateProgress();
        },
        onError: (id, message) => {
          if (r !== run) return;
          r.errors.push(id >= 0 ? `Storm ${id + 1}: ${message}` : message);
          if (id >= 0) {
            r.finished++;
            partial.delete(id);
          }
          updateProgress();
        },
        onDone: () => {
          if (r !== run) return;
          finish();
        },
      });
      pool.run(sp);
      runBtn.setAttribute('disabled', '');
      cancelBtn.removeAttribute('disabled');
      tick = setInterval(updateProgress, 500);
      renderResults();
      updateProgress();
      announce(`Experiment started: ${sp.length} storms.`);
    }

    function stop(byUser: boolean) {
      if (tick) clearInterval(tick);
      tick = null;
      if (pool) {
        pool.cancel();
        pool = null;
        if (run && run.finished < run.specs.length) {
          run.cancelled = true;
          if (byUser) announce(`Cancelled after ${run.finished} storms.`);
        }
      }
      runBtn.removeAttribute('disabled');
      cancelBtn.setAttribute('disabled', '');
      updateProgress();
      renderResults();
    }

    function finish() {
      if (tick) clearInterval(tick);
      tick = null;
      pool = null;
      runBtn.removeAttribute('disabled');
      cancelBtn.setAttribute('disabled', '');
      updateProgress();
      renderResults();
      announce('Experiment finished.');
    }

    function updateProgress() {
      const r = run;
      if (!r) {
        progressText.textContent = 'Not run yet. Press "Run the experiment".';
        progressFill.style.width = '0%';
        return;
      }
      const n = r.specs.length;
      let done = r.finished;
      for (const f of partial.values()) done += f;
      const frac = n ? done / n : 0;
      progressFill.style.width = `${(frac * 100).toFixed(1)}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      const running = !!pool;
      const elapsed = (performance.now() - r.started) / 1000;
      const left = running && frac > 0.02 ? (elapsed / frac) * (1 - frac) : NaN;
      const parts = [`${r.finished} of ${n} storms done`];
      if (running) parts.push(Number.isFinite(left) ? `about ${fmtDuration(left)} left` : 'warming up the workers');
      else if (r.cancelled) parts.push('cancelled');
      else parts.push(`finished in ${fmtDuration(elapsed)}`);
      if (r.errors.length) parts.push(`${r.errors.length} error${r.errors.length > 1 ? 's' : ''}: ${r.errors[0]}`);
      progressText.textContent = parts.join(' · ');
      csvBtn.toggleAttribute('disabled', r.finished === 0);
    }

    // ── Results ──
    function done(): SeedResult[] {
      return (run?.results ?? []).filter((x): x is SeedResult => !!x);
    }

    function col(rs: SeedResult[], s: Strategy, f: (r: StrategyResult, seed: SeedResult) => number): number[] {
      return rs.map((seed) => {
        const r = seed.results.find((x) => x.strategy === s);
        return r ? f(r, seed) : NaN;
      });
    }

    function series(rs: SeedResult[], f: (r: StrategyResult, seed: SeedResult) => number): Series[] {
      return ORDER.map((s) => ({ label: NAMES[s], marker: MARKERS[s], values: col(rs, s, f) }));
    }

    function renderResults() {
      const rs = done();
      if (!rs.length) {
        results.replaceChildren(run && pool ? h('p', { class: 'small muted' }, 'The first results appear when the first storm finishes.') : h('p', { class: 'small muted' }, ''));
        return;
      }
      const pct = (r: StrategyResult, s: SeedResult) => (s.demand > 0 ? (r.sheltered / s.demand) * 100 : NaN);
      const sh = Object.fromEntries(ORDER.map((s) => [s, col(rs, s, pct)])) as Record<Strategy, number[]>;
      const p95 = Object.fromEntries(ORDER.map((s) => [s, col(rs, s, (r) => r.p95Minutes)])) as Record<Strategy, number[]>;
      const people = Object.fromEntries(ORDER.map((s) => [s, col(rs, s, (r) => r.sheltered)])) as Record<Strategy, number[]>;
      const n = rs.length;
      const fig = (s: Strategy) => h('div', null, h('div', { class: 'figure' }, `${fmtNum(mean(sh[s]), 1)}%`), h('p', { class: 'figure-label' }, h('span', { html: markerSwatch(MARKERS[s]) }), ` ${NAMES[s]}: mean share sheltered`));
      results.replaceChildren(
        h(
          'section',
          { class: 'section' },
          h('p', { class: 'eyebrow' }, `${n} storm${n > 1 ? 's' : ''}${pool ? ' so far' : ''}`),
          h('div', { class: 'figures exp-figures' }, ...ORDER.map(fig)),
          h('p', { class: 'lede exp-conclusion' }, conclusion(rs, sh, p95, people)),
        ),
        h(
          'section',
          { class: 'section' },
          h('h2', null, 'Storm by storm'),
          pairedSeeds('Share of people sheltered by the end of the storm, %', rs.map((r) => r.seed), series(rs, pct), { format: (v) => `${fmtNum(v, 0)}%`, sortBy: 0, note: 'Each column is one storm; the vertical line joins its three results. Higher is better.' }),
          diffStrip("People sheltered: risk-aware + CSP + SA minus naive, per storm", people.risk.map((v, i) => v - people.naive[i]), { format: (v) => signed(v, fmtInt), good: 'more sheltered by risk-aware', bad: 'more by naive', marker: 'diamond' }),
          diffStrip('Slowest 5% of trips (p95): dynamic A* minus risk-aware, minutes', p95.dynamic.map((v, i) => v - p95.risk[i]), { format: (v) => signed(v, (x) => fmtNum(x, 0)), good: 'faster with risk-aware', bad: 'faster with dynamic', marker: 'diamond' }),
        ),
        h(
          'section',
          { class: 'section' },
          h('h2', null, 'Spread over all storms'),
          boxStrip('Share sheltered, %', series(rs, pct), { format: (v) => `${fmtNum(v, 0)}%`, better: 'high' }),
          boxStrip('Mean trip time of sheltered groups, minutes', series(rs, (r) => r.meanMinutes), { format: (v) => fmtNum(v, 0), better: 'low' }),
          boxStrip('95th percentile trip time, minutes', series(rs, (r) => r.p95Minutes), { format: (v) => fmtNum(v, 0), better: 'low' }),
          boxStrip('Minutes until 90% of people were in a centre', series(rs, (r) => r.t90), { format: (v) => fmtNum(v, 0), better: 'low', note: 'Storms where a strategy never reached 90% are left out of its row; naive routing usually never does.' }),
          boxStrip('Re-plans (route changes) per storm', series(rs, (r) => r.replans), { format: (v) => fmtNum(v, 0), note: 'Naive groups never re-plan by choice; their count is the times they were turned away from a full centre.' }),
          h('p', { class: 'small muted' }, 'Box: middle half of the storms. Heavy tick: median. Whiskers: best and worst storm. Every storm is drawn as a marker.'),
        ),
        h('section', { class: 'section' }, h('h2', null, 'Numbers'), h('div', { class: 'table-scroll' }, summaryTable(rs))),
      );
    }

    function conclusion(rs: SeedResult[], sh: Record<Strategy, number[]>, p95: Record<Strategy, number[]>, people: Record<Strategy, number[]>): string {
      const n = rs.length;
      const vsNaive = signTest(people.risk, people.naive, (a, b) => a > b);
      const vsDyn = signTest(people.risk, people.dynamic, (a, b) => a > b);
      const p95Dyn = signTest(p95.risk, p95.dynamic, (a, b) => a < b, 0.5);
      const storms = (k: number) => `${k} storm${k === 1 ? '' : 's'}`;
      const avgGain = mean(people.risk.map((v, i) => v - people.naive[i]));
      let s = `Across ${storms(n)}, risk-aware + CSP + SA sheltered on average ${fmtNum(mean(sh.risk), 1)}% of the people who needed a relief centre, against ${fmtNum(mean(sh.dynamic), 1)}% for dynamic A* and ${fmtNum(mean(sh.naive), 1)}% for naive static routing. `;
      s += `It sheltered more people than naive routing in ${vsNaive.wins} of ${n} storms (${fmtInt(avgGain)} more people on average${vsNaive.losses ? `; fewer in ${vsNaive.losses}` : ''}${vsNaive.ties ? `; tied in ${vsNaive.ties}` : ''}${n >= 6 ? `; sign test ${fmtP(vsNaive.p)}` : ''}). `;
      if (vsDyn.wins + vsDyn.losses === 0) s += `Against dynamic A* it sheltered exactly the same number of people in every storm, so the difference is speed: `;
      else s += `Against dynamic A* it sheltered more in ${vsDyn.wins}, fewer in ${vsDyn.losses} and the same in ${vsDyn.ties} storms. On speed, `;
      s += `the slowest 5% of trips were shorter in ${p95Dyn.wins} storms and longer in ${p95Dyn.losses} (p95 averaged over storms ${fmtNum(mean(p95.risk), 0)} against ${fmtNum(mean(p95.dynamic), 0)} min, median ${fmtNum(median(p95.risk), 0)} against ${fmtNum(median(p95.dynamic), 0)}${n >= 6 && p95Dyn.wins + p95Dyn.losses > 0 ? `; sign test ${fmtP(p95Dyn.p)}` : ''}).`;
      if (pool) s += ' The run is still going; these numbers will change.';
      return s;
    }

    function summaryTable(rs: SeedResult[]): HTMLElement {
      const metrics: [string, (r: StrategyResult, s: SeedResult) => number, number][] = [
        ['People sheltered', (r) => r.sheltered, 0],
        ['People without a centre', (r) => r.unsheltered, 0],
        ['Mean trip, min', (r) => r.meanMinutes, 1],
        ['95th percentile trip, min', (r) => r.p95Minutes, 0],
        ['Minutes to 90% sheltered', (r) => r.t90, 0],
        ['Re-plans', (r) => r.replans, 1],
        ['CSP + SA plans', (r) => r.assignRuns, 1],
      ];
      const f = (v: number, d: number) => (Number.isFinite(v) ? (d === 0 ? fmtInt(v) : fmtNum(v, d)) : 'n/a');
      return h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Measure'), h('th', { scope: 'col' }, 'Strategy'), h('th', { class: 'num', scope: 'col' }, 'Mean'), h('th', { class: 'num', scope: 'col' }, 'Std dev'), h('th', { class: 'num', scope: 'col' }, 'Median'), h('th', { class: 'num', scope: 'col' }, 'Worst storm'), h('th', { class: 'num', scope: 'col' }, 'Storms counted'))),
        h(
          'tbody',
          null,
          ...metrics.flatMap(([name, get, d]) =>
            ORDER.map((s, i) => {
              const v = col(rs, s, get);
              const lowerBetter = name !== 'People sheltered';
              const fin = v.filter(Number.isFinite);
              const worst = fin.length ? (lowerBetter ? Math.max(...fin) : Math.min(...fin)) : NaN;
              return h('tr', { class: i === 0 ? 'group-start' : null }, h('td', null, i === 0 ? name : ''), h('td', null, NAMES[s]), h('td', { class: 'num' }, f(mean(v), d)), h('td', { class: 'num muted' }, f(sd(v), d)), h('td', { class: 'num' }, f(quantile(v, 0.5), d)), h('td', { class: 'num' }, f(worst, d)), h('td', { class: 'num muted' }, `${fin.length} / ${rs.length}`));
            }),
          ),
        ),
      );
    }

    function downloadCSV() {
      const rs = done();
      if (!rs.length) return;
      const head = ['seed', 'storm', 'travel', 'rain_mm', 'peak_mm_per_h', 'max_flooded_km2', 'max_closed_roads', 'demand', 'strategy', 'sheltered', 'unsheltered', 'mean_trip_min', 'p95_trip_min', 'minutes_to_90pct', 'replans', 'csp_sa_plans', 'groups_reassigned'];
      const lines = [head.join(',')];
      for (const s of rs)
        for (const r of s.results)
          lines.push([s.seed, s.scenario, s.mode, s.rainMm.toFixed(0), s.peakMmH.toFixed(1), s.maxFloodedKm2.toFixed(2), s.maxClosedRoads, s.demand, r.strategy, r.sheltered, r.unsheltered, r.meanMinutes.toFixed(2), r.p95Minutes, Number.isFinite(r.t90) ? r.t90 : '', r.replans, r.assignRuns, r.reassigned].join(','));
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `floodline-experiment-${rs.length}-storms.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // A previous run (from before navigating away) is shown again.
    if (run) {
      if (!run.cancelled && run.finished < run.specs.length) run.cancelled = true;
    }
    updateProgress();
    renderResults();

    signal.addEventListener('abort', () => stop(false));
    return () => stop(false);
  },
};

function signed(v: number, f: (x: number) => string): string {
  return v > 0 ? `+${f(v)}` : v < 0 ? `-${f(-v)}` : f(0);
}

function fmtP(p: number): string {
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}

function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return 'n/a';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
}

export default page;
