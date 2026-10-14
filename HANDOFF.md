# Floodline: handoff for the next session

Read this file and `CLAUDE.md` before doing anything. `CLAUDE.md` holds the
rules; this file holds the current state, the architecture as actually
built, the gotchas we hit, and a precise plan for phases 5 to 10.
The original brief is `flood-evacuation-claude-code-prompt.md`.

---

## 0. Ground rules (repeat of the most important ones)

- **Never run any git command that changes anything** (`git init/add/commit/push/checkout/reset/stash`...). The user commits and pushes. At the end of each phase, give them a commit message and these three commands, one per code block: `git add .`, `git commit -m "..."`, `git push`.
- **No deploy commands**, no accounts, no hosting projects.
- Work **one phase at a time**. At the end of a phase: `npx tsc --noEmit -p .`, `npx vitest run`, `npm run build` must all pass. Then stop and summarise briefly (what works, what to look at in the browser, commit message, what's next) and wait for the user.
- Testing stays minimal: only small Vitest checks (see section 5). No Playwright, Lighthouse or screenshot loops. A quick look in the Browser pane to confirm a page renders is fine.
- **Light theme only. No red/blue/green. No cards/boxes/shadows. No stock icons or default form controls.** Five colour tokens in `src/styles/tokens.css`; derive everything else with `color-mix(in oklab, ...)` (CSS) or `mix()` from `src/render/theme.ts` (canvas/WebGL). Hazards are shown with hatching, dashes, weight, pulse, luminance; must read in greyscale.
- The user is a student preparing a viva: keep `/ai` code hand-written, pure (no DOM), deterministic, and heavily commented in plain English.
- User's GitHub repo: `https://github.com/PatilAarya/floodline` (branch `main`), already pushed through phase 4.

---

## 1. Status

| Phase | State |
|---|---|
| 1 Foundations | done |
| 2 World (synthetic generator, kept for tests) | done |
| (scope change) Real Mumbai map, light theme only, water-level slider | done |
| 3 Flood sim + WebGL | done |
| 4 Search + agents + re-planner + Algorithms race | done |
| 5 Bayesian network | done |
| **6 CSP + SA/HC (Assignment page)** | **next** |
| 7 Simulator integration | todo (much already exists, see section 4) |
| 8 Experiments | todo |
| 9 Home narrative, Viva page, polish, docs | todo |
| 10 Deploy-ready handoff | todo |

Current numbers (26 July 2005 storm, default seed `mumbai`, 128 grid, vehicles):
naive static 298,600 sheltered / 112,400 stuck, mean trip 122 min, p95 497;
dynamic A* 406,000 sheltered, mean 38, p95 108; risk-aware A* (BN posterior) 406,000, mean 38, p95 73.

---

## 2. How to run

```
npm i
npm run dev          # http://localhost:5173 (also .claude/launch.json "floodline-dev")
npx vitest run       # 20 tests, ~4 s
npm run build        # tsc --noEmit && vite build -> dist/
npm run fetch:mumbai # re-download raw OSM + SRTM (only if needed; slow, rate-limited)
npm run build:mumbai # rebuild src/data/mumbai.json from scripts/.cache
```

Versions installed: Vite 8, TypeScript 7, Vitest 5, Node 22. Windows machine (PowerShell + Git Bash).

---

## 3. Architecture as built

### Data: the real Mumbai map
- `scripts/fetch-mumbai.mjs` downloaded OSM (Overpass) roads/water/places and SRTM 30 m elevation (OpenTopoData, 128x128, 1 req/s) into `scripts/.cache/` (gitignored). Open-Meteo was tried first and hit its daily limit.
- `scripts/build-mumbai.mjs` builds `src/data/mumbai.json` (~1 MB, gzip ~300 KB): bbox lat 19.025-19.115, lon 72.822-72.917 (~10 x 10 km). Routing graph = tertiary and above + links + unclassified (3,520 junctions, 4,927 segments: 36 bridges over water, 235 flyovers, 12 tunnels/subways). Residential streets are background-only lines. 32 suburbs become neighbourhoods; schools/colleges become relief-centre candidates.
- `src/world/mumbai.ts` turns that JSON into the same `World` type as the synthetic generator: 5x5 grey-scale opening + 2 box blurs on the DEM (removes building roofs), sea = low cells connected to the map edge (seabed -2.5 m), enclosed pits limited to 1.2 m (priority-flood), channels carved per waterway kind then priority-flood filled from the sea so they always drain, bridges' deck = max(ends, banks) + 2 m, flyovers never flood, tunnels flood ~4x faster. Residents estimated from per-suburb densities; **demand** (`hood.population`) = residents in homes below 6 m x participation 0.22 (~417k people). 10 relief centres (real names: TISS, SIES, SNDT, NMIMS...), capacity = 1.1 x demand. `groupSize` 2,500.
- Credits shown on the map: "Map data (c) OpenStreetMap contributors (ODbL). Elevation: NASA SRTM via OpenTopoData."
- `src/world/worldWorker.ts` + `worldClient.ts`: `loadMumbai(params)` builds the world in a worker (fetches the JSON via `?url`), with inline fallback and a small cache.

### Key types (`src/world/types.ts`)
`World { source, title, params, terrain{n,cell,size,height(bed),channel,bankLevel,riverDist,minH,maxH}, ground (pre-carve), sea, river, graph{nodes,edges,adjStart,adjNode,adjEdge (CSR)}, hoods, cellHood, shelters, waterLines, waterAreas, minorStreets, residents, groupSize, attribution, notes }`.
`RoadEdge { id,a,b,length,speed (m/s),capacity,cls,minElev,isBridge,deckLevel,cells (grid cells sampled),name (code B3/U12/R40),geom (interior polyline),kind 'road'|'bridge'|'flyover'|'tunnel',street (OSM name) }`.
`Neighbourhood { id,name,residents,population (= evacuation demand),polygon,cx,cy,meanElev,drainage 0..1,drainageClass,accessNode,nodes,hasHospital,hasSchool,area }`.

### Flood simulation (`src/sim/`)
- `floodModel.ts`: virtual pipes with flow depth at the pipe and Manning friction (LISFLOOD-FP local-inertial form), outflow scaling K, CFL dt = 0.7 l / sqrt(g hmax) (sea excluded), advances in **whole minutes** split into equal sub-steps (determinism), sea cells held at tide level (booked as `budget.sea`), land map edges are free outfalls (`budget.outflow`), inflow cells walled. Budget: `volume == initial + rain + inflow - drained - infiltrated - outflow + sea`.
- `rainfall.ts` (storm hyetograph, semi-diurnal tide), `scenario.ts` (presets `jul2005`, `aug2017`, `jul2019`, `shower`; `resolveStorm()` jitters by seed unless seed is `mumbai`; URL params `storm, seed, rain, tide, drains`).
- `hydrology.ts`: `buildFloodSetup(world)` (drain capacity 25 mm/h x quality, infiltration, roughness, channels start at 0.6 m, lakes full), `buildForcing(params)`, `EdgeTable` + `computeEdgeStates()` (0 open / 1 degraded / 2 blocked; vehicle 0.15/0.30 m, foot 0.25/0.50 m), `speedFactor()`, `waterLevelFlood(world, L)` (instant connected "bathtub" fill from sea + channels), `floodStats()`. Drain efficiency drops with tide (outfall flap gates).
- `floodEngine.ts`: playback loop, keyframes every 30 min (flood + agents), seek, live rain override (truncates the future), `forcing`/`mode`/`strategy` changes recompute from minute 0, frame backpressure (`ack`), frames carry depth, flow, edge states/depths, stats, agent positions and metrics; `routes` messages carry changed routes. `floodWorker.ts` hosts it; `floodClient.ts` wraps the worker (falls back to main thread, reports crashes, HMR cleanup).
- `agents.ts`: `AgentSim` (groups: waiting, moving, sheltered, stranded, stuck, recovering, no-access). Strategies `naive | dynamic | risk`. `agentSetup.ts`: `buildNet()` (MONSOON_TRAFFIC 0.35 on vehicle speeds), `buildGroups()` (warning t+45, boarding 15 min, staggered departures lowest areas first), `buildAgentSetup(world, strategy, mode, lambda=2)`.
- Risk input to the agents: `floodEngine.updateRoads()` uses `src/sim/riskModel.ts` when `InitMsg.risk` is set (the Simulator always sets it): every `READ_EVERY` = 10 min the rain and river gauges report (truth discretised, then a misread drawn from the sensor CPT row with `Rng(seed::gauge::name::minute)`, so rewinds replay identically), VE gives P(FloodRisk | gauges, Drainage, Elevation) for the 9 (d, e) combos, hoods/edges look up their row; edge P_flood = noisy-OR(BN P(high), depth / blocking depth), flyovers 0, subways count as low ground. Frames carry `risk` (readings, P(Rain), P(River), per-hood 3-way dist) and `edgeRisk`. `riskFromDepth` remains the fallback (Algorithms page).

### Bayesian network (`src/ai/bayes/`)
`network.ts` (types, CPT layout: first parent most significant, `validate` rows sum to 1 within 1e-9, `topoOrder`), `cpt.ts` (`mumbaiNetwork()`, `V` indices, thresholds: rain 25/60 mm/h, river 0.3/0.6 of bed-to-bank at the gauge, elevation 5/9 m; FloodRisk rows from an ordered-logistic score `RISK_WEIGHTS`), `exact.ts` (enumeration, VE with barren pruning + min-neighbours order + factor rescaling, impossible evidence -> `{impossible: true}`), `sampling.ts` (likelihood weighting with log checkpoints + ESS), `dsep.ts` (Bayes-ball + trail enumeration with reasons). `pages/bayes.ts`: SVG network (click state = evidence, keys 1-3/0), enumeration vs VE table, LW convergence plot (5 seeded runs x 100k), d-separation explainer with numerical check, editable CPTs with hatched invalid rows, scene + neighbourhood evidence presets, evidence in the URL (`?ev=RainGauge.heavy,...`). Simulator: "Flood risk hatching (Bayes)" layer (`src/render/canvas/risk.ts`, density = P(high), cached offscreen), Now figures (gauge readings, misreads), inspector rows, events for misreads and 50% crossings; Water-level mode runs the BN with the river reading from the level.

### Search (`src/ai/search/`)
`types.ts` (SearchGraph CSR, SearchProblem, events `expand|frontier|goal|fail`, counters), `bfs.ts`, `dfs.ts`, `ucs.ts` (Dijkstra, lazy deletion, `COST_EPS`), `greedy.ts`, `astar.ts` (reopen-on-improvement, tie-break towards larger g), `cost.ts` (`makeCost`, `makeCostFromArrays`, `makeHeuristic(g, goal, vmax, inflate)`, `maxSpeed`, `riskFromDepth`, `DEGRADED_PENALTY` 300 s), `replanner.ts` (MARGIN 0.12, MIN_INTERVAL 10 min, PERIODIC_EVERY 20, mid-edge push-on rule, `nearestShelter` multi-goal UCS with capacity + taboo, `routeTo` via A*).

### Rendering
- `src/ui/mapView.ts`: three stacked canvases (WebGL base / static 2D / dynamic 2D), camera (`src/render/camera.ts`: drag, wheel, pinch, keyboard), custom SVG cursor, hit-testing (shelters, roads by polyline, hoods; `hitExtra` for groups; `onTap` raw), `setDepth(depth, flow, {reset, intervalMs})` with interpolation, `setEdgeState`, `setRain`, `setQuality`, `drawExtra(d)` hook for page overlays. Handles WebGL context loss (falls back to Canvas 2D).
- `src/render/gl/floodGL.ts` + `shaders/flood.frag.glsl` (terrain hillshade, contours, OKLab depth ramp from tokens, flow streaks, foam, caustics, rain streaks). R16F textures, depth A/B interpolation.
- `src/render/canvas/`: `roads.ts` (`RoadLayer` cached world-space Path2D per state; `edgeToPath`, `worldTransform`), `overlays.ts` (hoods, shelters, mangroves, edge highlight), `labels.ts`, `agents.ts` (`AgentLayer`), `terrain.ts`/`water2d.ts`/`contours.ts` (2D fallback).
- `src/render/theme.ts`: reads the five tokens, OKLab `mix()`, `css()`, `paletteAnimator` (static palette source now).

### UI kit and pages
- Controls: `src/ui/controls/{slider,toggle,segmented,scrubber}.ts`; `src/ui/sheet.ts` (bottom sheet <= 1024px, `reveal(target)`), `src/ui/charts/bars.ts` (hand-drawn SVG bars, `flag` = hatched), `src/ui/dom.ts` (`h()`, `announce()`), `src/ui/layout.ts` (header, nav, phone menu, water-line page wipe), `src/ui/glyphs.ts`.
- Router: `src/core/router.ts` (hash routes, lazy pages, `replaceParams()` to update URL silently). Pages export `{ title, mount({root, params, signal}) => cleanup }`.
- `pages/simulator.ts`: Flood panel (strategy, storm preset, seed, live rain/surge/drain sliders, play/step/restart, speed 0.25x-16x, scrubber with rain + river-stage hydrograph, Water level mode slider 0-10 m, travel mode), Now figures, Evacuation figures, Events log (plain sentences grouped by street), Inspector (hood/road/bridge/subway/shelter/group), Mithi basin facts, Layers + Quality (Auto 192 grid / High 256 / Low 128), Legend, About.
- `pages/algorithms.ts`: race page (presets on real places, flood level, travel mode, lambda, bad-heuristic toggle, replay speed, 5-6 panels, table, bar charts).
- `pages/home.ts` (simple hero + 4 chapters; phase 9 adds the scroll narrative), `pages/kit.ts` (unlisted `#/kit`), placeholders: `bayes.ts`, `assignment.ts`, `experiments.ts`, `viva.ts` (use `pageHead()` / `comingInPhase()` from `_shared.ts`).

### Tests (`tests/`)
`world.test.ts` (synthetic connectivity/determinism), `flood.test.ts` (mass conservation x2, rewind determinism), `bayes.test.ts` (CPTs valid, enumeration == VE to 1e-9 on 7 evidence sets, impossible evidence, LW within 0.02 at 50k, d-separation cases + Bayes-ball == trail enumeration), `search.test.ts` (A* == UCS dry and flooded on Mumbai, admissible + consistent heuristic, BFS/DFS/Greedy never cheaper, clean failure). Tests read `src/data/mumbai.json` with `fs`.

---

## 4. Gotchas learned the hard way

- **Bash heredocs with complex quoting broke** ("unexpected EOF"). For big code edits, write a Python patch script to the scratchpad with the Write tool and run it, or use Edit/Write directly. Never use `cat > file` without a heredoc (it waits on stdin forever).
- **TypeScript 7 typed-array generics**: a default param like `out = new Float32Array(n)` infers `Float32Array<ArrayBuffer>` and then rejects `Float32Array<ArrayBufferLike>`. Annotate: `out: Float32Array = new Float32Array(n)`.
- No `const enum` (isolatedModules); use `as const` objects (see `EdgeState`, `Status`).
- The Browser pane is often hidden: rAF, ResizeObserver and WAAPI `finished` don't fire then. The page wipe already has a timeout fallback; screenshots may time out; use `javascript_tool` / `get_page_text` to inspect state.
- Performance: the flood model runs ~20 M cell-updates/s; 12 h storm at 128 grid ~17-25 s with agents. Don't add per-cell work to the hot loop in `floodModel.substep`. Agents re-plan only when an edge on their route changes or every 20 min.
- Determinism matters (rewind must replay identically): anything that steps per minute in the engine must be included in keyframes (`Keyframe { flood, agents }`). If you add BN state that evolves over time (e.g. sensor readings), make it a pure function of (seed, minute, flood state) or snapshot it.
- `npm run build` runs `tsc --noEmit` first.

---

## 5. Plan for the remaining phases

### Phase 5: Bayesian network (`src/ai/bayes/`, `pages/bayes.ts`)
- `network.ts`: discrete BN structure. Variables: `Rain {light, moderate, heavy}`, `RiverLevel {low, normal, high}`, `Drainage {poor, fair, good}`, `Elevation {low, mid, high}`, `FloodRisk {low, medium, high}`, plus noisy sensors `RainGauge` (child of Rain) and `RiverGauge` (child of RiverLevel). Suggested edges: Rain -> RiverLevel, Rain -> FloodRisk, RiverLevel -> FloodRisk, Drainage -> FloodRisk, Elevation -> FloodRisk, Rain -> RainGauge, RiverLevel -> RiverGauge. Optionally a Tide node (Mumbai-specific; tide -> RiverLevel and Drainage effectiveness) if it stays explainable.
- `cpt.ts`: explicit, documented CPTs (Mumbai-flavoured: drains designed for 25 mm/h; low ground < 6 m). Validate rows sum to 1 (tolerance 1e-9) and show an error state in the UI if not. CPTs editable on the Bayes page.
- `exact.ts`: inference by **enumeration** and by **variable elimination** (factor product, sum-out, normalise; choose elimination order by min-neighbours). Normalise at each step or work in log space to avoid underflow. Detect **zero-probability evidence** and return a clear error ("impossible evidence").
- `sampling.ts`: **likelihood weighting**, seeded RNG (`src/core/rng.ts`), returns estimates for N = 10..100k so the UI can plot convergence.
- `dsep.ts`: d-separation (Bayes-ball / reachability), with a one-line explanation of the active/blocked trail.
- Live evidence from the simulation: per neighbourhood, discretise Elevation (meanElev) and Drainage (hood.drainageClass) as fixed evidence; RainGauge/RiverGauge readings come from the sim (rain mm/h, gauge stage) **with seeded noise** (a sensor misreads with some probability). Compute `P(FloodRisk = high | evidence)` per hood each simulated minute or every few minutes. Do it inside the flood engine (pure function of state + seed so rewinds stay deterministic) and send per-hood posteriors in frames.
- Road risk P_flood(edge) = max (or noisy-OR) of the adjacent neighbourhood's P(high) and a depth term; feed it to the agents instead of `riskFromDepth` (`floodEngine.updateRoads`).
- Map overlay: **risk as contour hatching density** per neighbourhood (denser hatch = higher risk), a "Risk" layer toggle in the Simulator. No colour hue.
- Bayes page: draw the network as an SVG graph (bespoke nodes, hairline edges), click a node to set or clear evidence (segmented states), show posterior bars for every node (exact enumeration vs VE agree; show both numbers), a likelihood-weighting convergence plot (hand-drawn line chart: estimate vs log N with the exact value as a dashed line), CPT tables in JetBrains Mono (editable with validation), and a d-separation explainer ("Are A and B independent given C?" with the trail highlighted). A neighbourhood picker can load a real hood's evidence.
- Test (required): enumeration == variable elimination on the network for several evidence sets (within 1e-9). Optionally: LW converges within tolerance for large N.

### Phase 6: CSP + local search (`src/ai/csp/`, `src/ai/local/`, `pages/assignment.ts`)
- Variables = evacuee groups (`buildGroups(world)` already makes them), domains = relief centres. Constraints: capacity (sum of sizes <= capacity), reachability (a route exists now, from road states), max travel time / deadline, optional "don't use a centre whose own risk > X", soft "keep neighbourhood together".
- `backtracking.ts` (plain), `forwardChecking.ts`, `heuristics.ts` (MRV, degree, LCV), each toggleable; counters (assignments tried, backtracks, nodes, time); step events for an animated search tree (assignment path highlighted, pruned branches dashed, wipeouts marked). Node/time budget with "search budget exceeded, returning best partial".
- `relax.ts`: when infeasible, explain why (empty domain for group X; or total demand > total capacity reachable), then offer relaxation: maximise people sheltered (partial assignment) or relax the deadline; report the unsheltered count honestly. The "Overcrowded" situation: a capacity slider (or `capacityRatio`) below 1.
- Re-run the CSP when the world changes (a road or centre fails) and show a diff.
- `objective.ts` (total weighted travel time + risk exposure + overload penalty + imbalance penalty), `simulatedAnnealing.ts` (reassign / swap moves, geometric and linear cooling in `cooling.ts`, acceptance exp(-dE/T), seeded, optional restarts), `hillClimbing.ts` (steepest and first-choice). Always start from the CSP solution. The CSP map can be large (~170 groups x 10 centres): precompute group -> centre travel times with one multi-target Dijkstra per centre.
- Assignment page: CSP lab (toggles, counters, search tree on a small instance, e.g. one or two neighbourhoods, plus the full instance with counters only), energy-vs-iteration plot with temperature trace and uphill-accept markers, flow lines neighbourhood -> centre on a map, final comparison CSP vs CSP+HC vs CSP+SA.
- Test (required): CSP solves a map-colouring instance (e.g. Australia, 3 colours) and detects an infeasible one (e.g. a 4-clique with 3 colours).

### Phase 7: Simulator integration
Already in place: strategies naive/dynamic/risk, inspector, events log, live ticker, agents, routes. Remaining:
- Make strategy 3 = **"Risk-aware + CSP + SA"**: at the warning time, assign groups to centres with the CSP and improve with SA (using BN risk), then route with risk-aware A* (lambda) and dynamic re-planning; re-run the assignment (warm-started) when a centre becomes unreachable. Run this inside the engine/worker so it stays deterministic and is snapshotted.
- Add BN risk layer and per-hood posterior to the inspector; show "assigned centre" and ETA for groups; route of the selected group (exists).
- Events log entries for CSP re-assignments and relaxations.
- Make sure the water-level mode also shows which neighbourhoods can still reach a centre (optional).

### Phase 8: Experiments (`pages/experiments.ts`, an experiments worker)
- Run N seeds (default 50) x 3 strategies in a worker (reuse `FloodEngine` headless with `buildAgentSetup`; grid 128 for speed; seeds vary storm via `resolveStorm`). Progress indicator, cancel button, no UI freeze; the run takes a while, so stream partial results.
- Charts (hand-drawn SVG): paired comparison per seed (sheltered, mean and p95 trip time, stranded, re-plans), mean and spread (box/strip plots), plus a plain-language conclusion with numbers ("risk-aware sheltered X% more people than naive in 48 of 50 storms...").
- CSV export (download via Blob; no network).

### Phase 9: Home narrative, Viva page, polish
- Home: full-bleed ambient flood behind a huge title (reuse `FloodGL` with a precomputed/water-level animation on the Mumbai map, gentle camera drift), scroll-driven chapters (rain, river, roads vanish, plan re-routes) changing the same canvas.
- Viva page mirroring `docs/VIVA.md`: per algorithm (A*, UCS, BFS, DFS, Greedy, re-planner, BN enumeration/VE/LW/d-sep, CSP backtracking/FC/MRV/degree/LCV, SA, HC, virtual-pipes flood model): intuition, pseudocode, time/space complexity, why chosen, why not X, file/function, key parameters, 5 likely questions with short answers. Include the Mumbai-specific modelling decisions (SRTM opening, pit limit, priority-flood channels, tide-gated drains, monsoon traffic factor, demand estimate) and their limitations honestly.
- Polish: responsive audit 320px to 4K, keyboard and screen-reader pass (live summaries exist on the map), reduced motion, favicon exists (`public/favicon.svg`), add an OG image (`public/og.png`, referenced in `index.html`), noscript exists.

### Phase 10: Deploy-ready handoff
- `README.md` (what it is, screenshots placeholder, how to run, deploy link placeholder, syllabus mapping table: Module I search/local search, Module II CSP, Module III Bayesian networks / planning under uncertainty, Module IV learning only as an optional extension), `DEPLOY.md` (build command `npm run build`, output `dist/`, click-by-click Vercel and GitHub Pages steps; `base` is `./` by default, override with `BASE_PATH`), final checklist. **Do not deploy.**
