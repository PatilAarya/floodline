# PROMPT FOR CLAUDE CODE: "Floodline", a Dynamic Flood Evacuation Planner

You are building a complete, deployable, front-end-only website for a college AI mini project (Artificial Intelligence course). The project will be defended in a viva, so every algorithm must be hand-written, readable, correct, and explainable. Do not wrap algorithms in black-box libraries.

Before writing code, read this whole prompt, then create `CLAUDE.md` in the repo root summarising the rules below (stack, design rules, algorithm list, folder structure, phase plan) so you keep them across sessions. Work phase by phase (see "Build phases"). After each phase, make sure the project compiles (`npm run build` / type-check passes) and the dev server starts without errors, then stop and tell me what to look at. Keep checking light: **do not write large test suites, do not run Playwright/Lighthouse or other heavy automated checks**. I will test the site myself and report problems. Only run the few small unit tests listed in section 10.

**Git and deployment rules (strict):** I create the repository, I commit, I push, and I deploy. **Never run `git init`, `git add`, `git commit`, `git push`, or any deploy command, and never create remotes, accounts or hosting projects.** When a phase is finished, tell me it is a good point to commit and give a suggested commit message; I will do it myself. Do not ask me to wait for anything else.

If something essential is unclear or missing (deploy account, repo name, anything), ask me once, in one batch, instead of guessing.

---

## 1. Product in one paragraph

A synthetic city is hit by rain. A river rises, water spreads across terrain, roads go under, and neighbourhoods must be evacuated to shelters. The system (a) estimates flood risk under uncertainty with a **Bayesian Network**, (b) assigns neighbourhood groups to shelters with a **CSP** (backtracking + forward checking + MRV/degree/LCV), (c) improves that assignment with **Simulated Annealing** (compared against Hill Climbing), and (d) routes evacuees with **A\*** that **re-plans live** when roads disappear (compared against BFS, DFS, Greedy Best-First and Uniform Cost Search). The viva one-liner: *"Navigation apps assume the road network is fixed. Ours handles roads that disappear and risk that is uncertain."*

The strongest deliverable is evidence: an **Experiment** page that runs many seeded scenarios and shows that risk-aware dynamic re-planning beats naive static routing, with numbers and charts.

## 2. Tech stack (fixed unless you ask me)

- Vite + TypeScript (strict), **vanilla TS, no UI framework**. Small hand-written state store plus hash router.
- Rendering: **WebGL2** (raw, no three.js) for terrain and water, **Canvas 2D** overlay for roads/agents/labels, with a **full Canvas 2D fallback** if WebGL2 is unavailable or the context is lost.
- Heavy work (flood simulation, experiments) in **Web Workers** with transferable typed arrays.
- Allowed small deps: `d3-delaunay` (Voronoi/Delaunay for city generation), `vitest`, `playwright` (dev only). Everything else (noise, PRNG, priority queue, graph, BN, CSP, SA, charts) you write yourself.
- Fonts self-hosted through `@fontsource` (no Google Fonts network calls): see section 4.
- No backend, no database, no API keys, no map tiles. Everything is generated procedurally and runs offline after first load.
- Deployment is **my job, not yours**. Just make sure the project is deploy-ready as a static site: `npm run build` outputs to `dist/`, hash-router so no server rewrites are needed, `base` configurable via an env var so it works on Vercel, Netlify, Cloudflare Pages or GitHub Pages. Add a short `DEPLOY.md` with the build command, output folder and click-by-click steps for Vercel and GitHub Pages so I can follow it myself. Do not run any deploy tooling.

## 3. Folder structure

```
/src
  /core        rng.ts (seeded PRNG: mulberry32/sfc32), noise.ts, pq.ts (binary heap), geometry.ts, store.ts, router.ts, units.ts
  /world       terrain.ts, cityGen.ts (graph, neighbourhoods, shelters), types.ts, presets.ts
  /sim         floodWorker.ts, floodModel.ts (shallow-water "virtual pipes"), rainfall.ts, hydrology.ts, agents.ts, scenario.ts
  /ai
    /search    bfs.ts dfs.ts ucs.ts greedy.ts astar.ts replanner.ts (all emit step events for animation)
    /bayes     network.ts cpt.ts exact.ts (enumeration + variable elimination) sampling.ts (likelihood weighting) dsep.ts
    /csp       model.ts backtracking.ts forwardChecking.ts heuristics.ts relax.ts
    /local     simulatedAnnealing.ts hillClimbing.ts cooling.ts objective.ts
  /render      gl/ (terrain.ts water.ts shaders/*.glsl), canvas/ (roads.ts agents.ts overlays.ts labels.ts), theme.ts, camera.ts
  /ui          layout, controls (custom slider, toggle, segmented text control, scrubber), charts/ (hand-drawn: line, step, heat, histogram, tree), glyphs/ (hand-drawn SVG marks)
  /pages       home.ts simulator.ts algorithms.ts bayes.ts assignment.ts experiments.ts viva.ts
  /styles      tokens.css base.css type.css layout.css motion.css
/tests         unit tests for every /ai module, /sim conservation tests, /world connectivity tests
/docs          VIVA.md (per algorithm: what, why, complexity, pseudocode, "why not X?", likely questions with answers)
CLAUDE.md  DEPLOY.md  README.md
```

All `/ai` modules must be **pure functions with no DOM access**, deterministic given a seed, and must expose a **step-event stream** (generator or callback) so the UI can animate the algorithm without changing it.

## 4. Design system (strict)

### Colour tokens (use exactly these; theme switches by `data-theme` on `<html>`, default from `prefers-color-scheme`, persisted with try/catch'd localStorage)

```css
:root[data-theme="light"] {
  --text: #101816; --background: #f9fbfb;
  --primary: #6c998d; --secondary: #a8b1c2; --accent: #8a8ead;
}
:root[data-theme="dark"] {
  --text: #e7efed; --background: #040606;
  --primary: #669387; --secondary: #3d4657; --accent: #525675;
}
```

- Derive every other shade with `color-mix(in oklab, ...)` from these five tokens (tints, shades, hairlines, overlays). Do not hard-code any other hex in components. WebGL and canvas code must read the tokens from CSS custom properties at runtime and re-read them on theme change (animate the transition, about 400 ms).
- **Forbidden:** default red, blue or green anywhere (UI, charts, map, status). Do not use stock "success/warning/error" colours.
- **Encoding hazard without red:** use luminance contrast, **hatching/stripe patterns**, dashed strokes, line weight, pulse/ripple motion, and the `--accent` vs `--primary` contrast. Examples: a blocked road is a broken dashed line with a cross-hatched halo that slowly pulses; high-risk areas get denser contour hatching; safe routes are solid, thick and glowing in `--primary`. Verify that every state is distinguishable in greyscale (colour-blind safe by construction). If you believe one extra hue is truly needed for legibility, **ask me before adding it**.
- Water: a depth ramp built only from the tokens (background, then secondary, accent, primary), plus animated contour lines and soft caustic shimmer. It must look good on both themes.

### Typography
- Headings: **Bricolage Grotesque**. Body and UI: **Instrument Sans**. Numbers, coordinates, code, CPTs: **JetBrains Mono**. Self-host, `font-display: swap`, preload the two main weights. If you judge a combination clearer, you may swap, but keep **exactly this three-role system consistently across the entire site**.
- Body 17-18px/1.6 on desktop, never below 16px on mobile; strong contrast; max line length about 68ch; fluid type with `clamp()`; tabular numerals for all data. Readability beats flair.

### Layout and component rules
- **No cards. No boxed tiles. No drop-shadowed containers.** Structure the page with whitespace, hairline rules (`1px` mixed from `--text` at low alpha), oversized typographic numerals, side margins with annotations, and full-bleed canvases. Controls dock in an open side rail or bottom strip that separates from the map by a hairline, not a box.
- **No default or stock icons** (no Material, Feather, emoji, hamburger, chevrons from libraries, no default favicon). Use words ("Menu", "Play", "Pause", "Reset") or **bespoke geometric glyphs you draw yourself in SVG** (for example a shelter = a small open arch, a pump = two nested arcs, blocked road = a broken bar). Create a custom favicon and OG image.
- No default form controls: custom range sliders (thin track, large hit target, live value in mono), custom toggles (typographic "On / Off" sliding underline), custom segmented controls (text with a sliding underline), custom scrubber with hydrograph behind it. All keyboard-accessible with visible custom focus rings (2px offset ring in `--accent`).
- Custom thin scrollbars, custom text selection colour, custom cursor states on the map (crosshair-like ring drawn in CSS/SVG, not the stock cursor).
- Motion: purposeful and consistent: one easing curve family, 200-500 ms for UI, page transitions as a soft water-line wipe. Respect `prefers-reduced-motion` (simulation still runs, decorative motion stops).
- Responsive from 320px to 4K: desktop = map with side rail; tablet = map with collapsible bottom drawer; phone = map first, controls in a swipe-up sheet (no stock bottom-nav). Touch: pinch zoom, drag pan, tap select; mouse: wheel zoom, drag pan, hover details. Handle `devicePixelRatio`, orientation change, resize observers, and iOS safe areas/100dvh.

## 5. The world (procedural, seeded, deterministic)

- A single `seed` (string or int) plus a few parameters regenerates the **exact** same city every time. Put `seed` and parameters in the URL hash so any scenario is shareable and reproducible.
- **Terrain:** heightmap grid (default 256x256, auto-drop to 192 or 128 on weak devices) from multi-octave noise with a river valley carved through it, a lowland floodplain, and higher ground in places for natural shelters.
- **River:** a meandering path across the map from an inflow edge to an outflow edge.
- **Road graph:** place nodes with Poisson-disc sampling biased to flatter land, connect with Delaunay then prune (relative-neighbourhood style) so it looks like real streets; add a few **bridges** across the river (critical single points of failure). Guarantee the graph is **connected at generation time** (repair if not). Edge attributes: length, free-flow speed, capacity, min elevation along the edge (flood vulnerability), `isBridge`.
- **Neighbourhoods:** Voronoi cells with population (varied), mean elevation, drainage quality, sensitivity (hospital/school flags are optional extras).
- **Shelters:** 4-8 nodes on high ground with capacities; total capacity is a parameter, so scenarios can be sufficient, tight, or **insufficient** (edge case below).
- Presets: "Calm Valley", "Two Bridges", "Delta Town", "Overcrowded" (capacity short), "Broken Network" (few alternatives). Plus a "Random seed" button.

## 6. Flood simulation (the heart: must look and behave convincingly)

Implement the **virtual-pipes shallow-water model** (grid cells with water depth `d`, outflow flux to 4 neighbours based on height-plus-depth difference, damping, and mass-conserving outflow scaling), in a **Web Worker**.

- Inputs over time: rainfall intensity curve (storm profile: ramp, peak, decay), river inflow hydrograph driven by rainfall with lag, drainage rate per cell from neighbourhood drainage quality, infiltration, and optional "pump failure" events.
- Numerical stability: adaptive or clamped time step (CFL condition), non-negative depth, no NaN/Infinity (assert in dev), mass conservation test (total water = inflow + rain - outflow - drainage within tolerance).
- The worker streams frames (depth field as `Float32Array`, transferred) at a fixed sim rate decoupled from render rate; the main thread interpolates for smoothness. Playback controls: play, pause, speed (0.25x to 16x), **scrub/rewind** (keep keyframes every N steps; recompute forward from the nearest keyframe), restart, step.
- Derive per-edge flooding: edge is **passable** if max depth along it is below a threshold (e.g. vehicle 0.3 m, on foot 0.5 m; configurable), **degraded** with speed penalty by depth, else **blocked**. Bridges block when river stage exceeds bridge deck level.
- **Rendering (must be spectacular):** hillshaded terrain, subtle contour lines, water as a depth-coloured surface with animated flow-direction streaks (use the flux field), shoreline foam line, soft caustic shimmer, depth-based opacity, rain streaks layer, and gentle camera drift on the home page. Water reflects theme tokens. Keep **60 fps on a mid laptop, 30+ on a mid phone**: use GPU textures for the depth field, render at a lower internal resolution when frame time exceeds budget, and expose a Quality setting (Auto/High/Low).

## 7. AI modules (all hand-written, tested, animated)

### 7.1 Bayesian Network (reasoning under uncertainty)
- Variables (discrete): `Rain` {light, moderate, heavy}, `RiverLevel` {low, normal, high}, `Drainage` {poor, fair, good}, `Elevation` {low, mid, high}, `FloodRisk` {low, medium, high}; plus noisy sensor nodes `RainGauge` and `RiverGauge` (observations can be wrong with some probability).
- Structure and CPTs are explicit, editable in the UI, and documented in `VIVA.md`. CPT rows must sum to 1 (validate; show an error state if not).
- **Exact inference** by enumeration **and** variable elimination (show both agree in tests). **Approximate inference** by likelihood weighting; the UI shows convergence versus number of samples.
- Per-neighbourhood posterior `P(FloodRisk | evidence)` updates **live** as the simulation produces noisy sensor readings; the map shows risk as contour hatching density. Road risk = max or combination of adjacent cell and neighbourhood risks.
- Page `Bayes`: draw the network, click a node to set evidence, watch posteriors change, toggle "show conditional independence" to highlight d-separation (implement d-separation check and a tiny "are A and B independent given C?" explainer).

### 7.2 Search and re-planning
- Implement BFS, DFS, Uniform Cost Search, Greedy Best-First, **A\***, each emitting events (`expand`, `frontier`, `goal`, `fail`) and counters (nodes expanded, frontier max, path cost, time).
- Edge cost for risk-aware routing: `cost = length / speed_effective * (1 + lambda * P_flood(edge))`, with a large finite penalty for degraded edges and infinity for blocked. Heuristic: straight-line distance / max speed (admissible and consistent because cost is never below that; **unit-test admissibility and consistency**, and assert A\* result cost equals UCS result cost).
- **Dynamic re-planner:** every evacuee group follows its path as a moving agent. Whenever an edge on its remaining path changes state (or periodically, or when posterior risk crosses a threshold), re-run A\* from its current position. Handle an agent that is **mid-edge** when the edge blocks: decide to continue if it can finish before the deadline, otherwise turn back to the nearest endpoint, and re-plan from there. Avoid thrashing with hysteresis (minimum interval, only re-plan if the new route is better by a margin).
- Page `Algorithms`: pick a start and goal on the map, press Race: all algorithms run on the same graph simultaneously in small synced map panels (open layout, no cards, divided by hairlines) with live counters and a final comparison table and bar chart. Also an "A\* with a bad heuristic" toggle (inadmissible, overestimating) to *show* suboptimality for the viva.

### 7.3 Constraint Satisfaction (shelter assignment)
- Variables: evacuee groups (split each neighbourhood into groups of at most G people so capacity constraints are satisfiable). Domains: shelters. Constraints: shelter capacity (global sum), reachability (a route must exist right now), maximum travel time/deadline, optional "don't send to a shelter that is itself at flood risk above X", optional "keep neighbourhood together" (soft).
- Algorithms: plain backtracking, **backtracking + forward checking**, **MRV, degree heuristic, LCV**. Toggle each one on or off; show counters (assignments tried, backtracks, nodes, time). Animate the search tree (open tree drawing, current assignment path highlighted, pruned branches as dashed, "wipeouts" shown when forward checking empties a domain).
- Re-run the CSP when the world changes (a road or shelter fails) and show the diff of what changed.
- If **no solution exists** (insufficient capacity or disconnected area): do not hang or crash. Detect it, report *why* (which constraint set fails, minimal explanation via the empty domain or a capacity argument), then offer **graceful relaxation** (`relax.ts`): allow partial assignment maximising people sheltered, or relax the deadline, and show the "unsheltered" count honestly.

### 7.4 Local search (optimising the assignment)
- Objective (minimise): total weighted evacuation time + risk exposure along routes + overload penalties + imbalance penalty.
- **Simulated Annealing**: neighbour moves (reassign a group, swap two groups), geometric and linear cooling selectable, acceptance `exp(-ΔE/T)`, seeded RNG, restarts optional. **Hill Climbing** (steepest and first-choice) for comparison. Always start from the CSP solution.
- UI: live energy-vs-iteration plot (hand-drawn) with temperature trace, accepted-uphill-move markers, current assignment drawn as flow lines from neighbourhoods to shelters, final comparison: CSP only vs CSP+HC vs CSP+SA with exact numbers.

## 8. Pages and information architecture

Top nav is text only: **Floodline** (wordmark, bespoke), Simulator, Algorithms, Bayes, Assignment, Experiments, Viva, and a custom Light/Dark switch.

1. **Home:** full-bleed live ambient flood simulation, huge typographic title, one sentence of value, one call-to-action in words, then a scroll-driven narrative (rain, river, roads vanish, plan reroutes) where the same canvas changes state as you scroll. Short "how it works" in four numbered chapters linking to the pages.
2. **Simulator (main page):** map fills the viewport. Side rail (desktop) contains scenario (preset, seed, rain intensity, duration, river inflow, drainage, shelter capacity), strategy selector (**Naive static shortest path / Dynamic A\* re-plan / Risk-aware + CSP + SA**), layers (water, risk, roads, shelters, agents, contours), playback + scrubber with hydrograph. Click a neighbourhood or road to see details in an open inspector (population, risk posterior, assigned shelter, route, ETA). Live ticker of: sheltered, en route, stranded, average evacuation time. Events log written as plain sentences ("Bridge B2 closed at t=41 min; 3 groups re-planned").
3. **Algorithms:** Race (7.2).
4. **Bayes:** network explorer (7.1).
5. **Assignment:** CSP and SA lab (7.3, 7.4).
6. **Experiments:** run N seeds (default 50, adjustable) times 3 strategies in workers with a progress indicator, no UI freeze. Output: paired comparison charts (mean and spread of people sheltered, average and 95th percentile evacuation time, stranded count, re-plan counts), a plain-language conclusion with numbers, and a CSV export. This page is the answer to "what is unique and does it work".
7. **Viva:** concise in-site explanations of each algorithm, complexity table, design decisions and "why not X?" answers, mirroring `docs/VIVA.md`, so I can revise from the site itself.

## 9. Edge cases (handle all, and add a test or manual check for each)

World: disconnected road graph after generation; shelter on low ground that floods; zero-population neighbourhood; neighbourhood with no road; duplicate nodes; extreme parameters (zero rain, extreme rain, huge duration); seed that yields degenerate terrain (regenerate with a derived seed and say so).
Simulation: numerical blow-up; mass drift; very fast speed with large steps (sub-stepping); scrubbing backwards then forwards gives identical results (determinism); worker crash/termination (show message, offer restart); hot-reload leaks (terminate old worker).
Routing: start node already flooded; goal unreachable; all roads blocked; path exists only through a degraded edge; agent mid-edge when blocked; two agents contend for a shelter that just filled (shelter reassignment, no oscillation); re-planning thrash (hysteresis); ties in A\*; floating-point equality in cost comparisons.
CSP: infeasible instance; instance with many solutions; domain becomes empty mid-search; time limit and node limit with a "search budget exceeded, returning best partial" fallback so the UI never freezes (also run in worker if needed).
Bayes: probabilities not summing to 1; evidence with zero probability (impossible evidence, show a clear message); numerical underflow (use log-space or normalise at each step).
UI/Platform: WebGL2 unsupported or context lost (fallback + restore); low-end device (auto quality); tab hidden (pause and resume correctly); window resize and orientation change; very small and very large screens; touch and mouse and keyboard; `prefers-reduced-motion`; theme switch mid-simulation without a glitch; localStorage unavailable (try/catch); invalid or malicious URL-hash params (validate and clamp); slow network (fonts swap, no layout shift); no-JS message in `<noscript>`.
Accessibility: semantic landmarks, keyboard-reachable controls, visible focus, ARIA labels for custom controls, text alternatives for the canvas (a live-updating plain-text summary of the simulation state in a visually-hidden region), contrast at least WCAG AA for all text.

## 10. Testing and quality gates

Keep testing **minimal**. I will do the browser and device testing myself.
- Write only a small Vitest file with the few checks that protect correctness and viva answers: A\* cost equals UCS cost, enumeration equals variable elimination on a small Bayesian network, the CSP solves a map-colouring instance and detects an infeasible one, and flood mass is conserved within tolerance. Run these once at the end of the relevant phase. Nothing more.
- No Playwright, no screenshot loops, no Lighthouse runs. Rely on a clean type-check/build and careful, defensive code instead (guards, clamps, fallbacks) so edge cases do not crash the UI.
- Performance by design, not by measurement: lazy-load pages and the experiments worker, keep the JS bundle lean, use the GPU for the depth field, and expose the Quality setting.

## 11. Documentation (needed for viva)

- `docs/VIVA.md`: for every algorithm: intuition, pseudocode, complexity (time/space), why chosen here, why not the alternatives, where it appears in the code (file and function), parameters that matter, 5 likely viva questions with short answers.
- Heavy inline comments in `/ai` modules explaining each step in plain English.
- `README.md`: what it is, screenshots, how to run (`npm i`, `npm run dev`, `npm test`, `npm run build`), deploy link placeholder, syllabus-mapping table (Module I search/local search, Module II CSP, Module III Bayesian networks and planning under uncertainty, Module IV learning is not core here, so mention optional extension only if time permits).

## 12. Build phases (stop at the end of each, summarise, and let me test and commit)

1. **Foundations:** repo, Vite + TS, tokens, fonts, theme switch, layout shell, router, custom controls kit, CLAUDE.md, CI-free test setup.
2. **World:** PRNG, noise, terrain, river, road graph, neighbourhoods, shelters, presets, connectivity tests, a static render of the city (Canvas 2D first).
3. **Flood sim + WebGL rendering:** worker model, mass-conservation tests, depth to graph edge states, spectacular water shader, playback and scrubber, quality scaling, fallback renderer.
4. **Search + agents:** all search algorithms with events, A\*, agents moving, live re-planner, Algorithms race page.
5. **Bayesian network:** model, inference, live evidence from sim, risk overlay, Bayes page.
6. **CSP + SA/HC:** model, heuristics, animation of search tree, relaxation, local search, Assignment page.
7. **Simulator integration:** strategies wired end to end, inspector, events log, metrics ticker.
8. **Experiments:** batch worker runner, charts, conclusion text, CSV export.
9. **Home page narrative, Viva page, polish:** motion, responsive audit, accessibility pass, performance pass, favicon/OG image, docs.
10. **Deploy-ready handoff:** confirm `npm run build` succeeds, write `DEPLOY.md` and `README.md`, and give me a final checklist. Do not deploy anything.

When a phase is finished, tell me in 3-5 lines: what works, what to look at in the browser, a suggested commit message for me to use, and what is next. Do not pad the summaries.

## 13. Definition of done

Everything runs from a fresh clone with `npm i && npm run dev`, and `npm run build` succeeds. The small test file passes. The code is written defensively so pages do not throw errors at any listed viewport (I will verify in my own browser). Flood visuals look excellent in both themes. Every state is distinguishable without red/blue/green. No cards, no stock icons, no default controls. The Experiments page shows Dynamic/Risk-aware strategies outperforming Naive with real numbers. The project is ready for me to push and deploy myself. I can explain every algorithm in `docs/VIVA.md`.
