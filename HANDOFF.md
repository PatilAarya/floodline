# Floodline: handoff for the next session

Read this and `CLAUDE.md` before doing anything. `CLAUDE.md` holds the rules; this file holds the current state, the architecture as it is now, and the gotchas.

## 0. Ground rules (most important)

- **Never run any git command that changes anything.** The user commits and pushes. At the end of a piece of work give a commit message and `git add .` / `git commit -m "..."` / `git push`, one per code block.
- **No deploy commands**, no accounts, no hosting.
- Keep it **small and explainable**: it is a mini project defended in a viva. Do not add features the user did not ask for.
- Before stopping: `npx tsc --noEmit -p .`, `npx vitest run`, `npm run build` must pass.
- Light theme only; five colour tokens; no red/blue/green; no cards/shadows; no stock icons or default controls.

## 1. Status

Phases 1-9 were built, then on **2026-10-26 the user cut the scope down** to what can be explained easily. What remains:

| Page | Route | What it shows |
|---|---|---|
| **Simulator** (the main demo, also the home page) | `#/` and `#/simulator` | One car, start -> destination, during the 26 July 2005 storm: the chosen search algorithm finds the shortest route (the junctions it explored light up), two alternatives are shown, roads close as the water rises, the closed road is marked and explained, the car re-plans from where it is and arrives |
| **Algorithms** | `#/algorithms` | BFS, DFS, UCS, Greedy, A* (and A* with an inflated heuristic) raced side by side on the same flooded map, with expanded-node counts and route quality |
| **Bayes** | `#/bayes` | The flood-risk Bayesian network: click states to set evidence, gauge scenes, real neighbourhoods; enumeration and variable elimination side by side |

Deleted on purpose: the city-wide crowd simulator (178 groups, strategies, sliders, runs list), CSP assignment, simulated annealing / hill climbing, Experiments, Viva page and `docs/VIVA.md`, the Home scroll story, likelihood weighting, d-separation, editable CPTs. Git history has them if the user ever asks.

**Next: phase 10**: `README.md` (what it is, how to run, syllabus mapping: Module I search, Module III Bayesian networks), `DEPLOY.md` (build command `npm run build`, output `dist/`, click-by-click Vercel and GitHub Pages; `base` is `./`, override with `BASE_PATH`; after deploy make the `og:image` URL in `index.html` absolute), final checklist. **Do not deploy.**

## 2. How to run

```
npm i
npm run dev          # http://localhost:5173 (also .claude/launch.json "floodline-dev")
npx vitest run       # 18 tests
npm run build        # tsc --noEmit && vite build -> dist/
npm run og           # re-render public/og.png from scripts/og/og.html with a local Chrome/Edge
```

To share without deploying: `npm run build`, `npx vite preview --port 4173`, then `cloudflared tunnel --url http://localhost:4173` (Cloudflare quick tunnel; `vite.config.ts` allows `.trycloudflare.com` for `vite preview`). On this machine cloudflared is at `C:\Program Files (x86)\cloudflared\cloudflared.exe`.

## 3. Architecture

### Data
- `src/data/mumbai.json` (~1 MB) built by `scripts/build-mumbai.mjs` from OSM + SRTM. Routing graph: 3,520 junctions, 4,927 road segments (36 bridges, 235 flyovers, 12 subways). 10 relief centres (schools/colleges on higher ground).
- `src/world/mumbai.ts` turns it into the `World` type (terrain, graph in CSR form, neighbourhoods, shelters). `worldWorker.ts` / `worldClient.ts` build it in a worker.

### Flood (`src/sim/`)
- `floodModel.ts`: virtual-pipes shallow water (local-inertial, Manning friction), CFL time step, whole-minute steps, mass budget.
- `hydrology.ts`: drains, infiltration, roughness, road states from water depth (`computeEdgeStates`: vehicle degraded 0.15 m, closed 0.30 m; bridges close when the river reaches the deck; flyovers never flood; subways flood fast), `waterLevelFlood` (instant level, used by Algorithms).
- `rainfall.ts`, `scenario.ts` (storm presets; the Simulator uses `jul2005`, seed `mumbai`).
- `floodEngine.ts` (playback, keyframes every 30 min, seek), `floodWorker.ts`, `floodClient.ts`. Frames carry depth, flow, edge states, edge depths, stats. `riskModel.ts` is only used if `InitMsg.risk` is given (the Simulator does not give it).

### Search and the journey
- `src/ai/search/`: `bfs`, `dfs`, `ucs` (Dijkstra with lazy deletion), `greedy`, `astar` (tie-break towards larger g), `cost.ts` (`makeCost`, `makeCostFromArrays`, `makeHeuristic`, `maxSpeed`, degraded penalty 300 s), `replanner.ts` (`midEdgeDecision` only: push on if at most 120 m or 30% left, else turn back).
- `src/sim/journey.ts` (pure): `journeyNet(world)` (speeds x `MONSOON_TRAFFIC` 0.35), `planRoutes(net, from, to, conditions, algo)` (main route with the chosen algorithm + its expansion order, UCS/A* expansion counts for comparison, two alternatives by the penalty method filtered by 55% overlap and different main streets), `Journey.step(minute, dt, conditions)` returning events (`plan`, `blocked`, `depart`, `turnback`, `pushon`, `stuck`, `arrive`).
- `src/pages/simulator.ts`: FloodClient (no agents, no risk), each frame -> conditions -> `journey.step` -> log sentences and map drawing (explored junctions revealed 2 s then fade 4 s; given-up routes dashed with a crossed hatched ring and the road name; alternatives B/C dashed with time tags; route A thick; start, destination, car). Pauses the storm 2.6 s on each closure. One big button: Start / Pause / Resume / Run again. Presets (checked against the model on the 192 grid): Kalina -> Dadar Vidya Mandir leaving t+02:00 (Mahim Causeway bridge closes at t+01:24 before departure; Sion Bandra Link Road floods at t+02:08 mid-trip; arrives t+03:03), Bandra West -> SIES, Kurla East -> SNDT leaving t+03:30, Kalina leaving t+03:30 (no way through).

### Bayesian network
- `src/ai/bayes/network.ts` (types, validation), `cpt.ts` (`mumbaiNetwork`, thresholds: rain 25/60 mm/h, elevation 5/9 m; FloodRisk rows from an ordered logistic score), `exact.ts` (enumeration, variable elimination with barren pruning and min-neighbours order, impossible-evidence detection).

### Rendering and UI
- `src/ui/mapView.ts` (WebGL base + 2D static + 2D dynamic canvases, camera controls, `hint`, `drawExtra`, `onTap`, `redraw`), `src/render/gl/floodGL.ts` + shaders, `src/render/canvas/` (roads, overlays, labels, terrain/water fallback).
- Controls `src/ui/controls/{slider,toggle,segmented}.ts`, `src/ui/sheet.ts` (bottom sheet <= 1024 px), `src/ui/charts/bars.ts` (Algorithms page).

### Tests (`tests/`)
`world.test.ts` (synthetic connectivity/determinism), `flood.test.ts` (mass conservation, rewind determinism), `bayes.test.ts` (CPTs valid, enumeration == VE, impossible evidence), `search.test.ts` (A* == UCS dry and flooded on Mumbai, admissible + consistent heuristic, BFS/DFS/Greedy never cheaper, clean failure).

## 4. Gotchas

- Big code edits: write a Python patch script to the scratchpad with the Write tool and run it. Bash heredocs with backticks/quotes break.
- TypeScript 7 typed arrays: annotate defaults (`out: Float32Array = new Float32Array(n)`).
- No `const enum` (isolatedModules).
- The Browser pane is often hidden: rAF, ResizeObserver, IntersectionObserver and scroll events do not fire. Shim rAF with `window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16)`; a screenshot forces a render. The console log of a tab survives reloads; open a new tab for a clean console.
- Probe scripts: a temporary `tests/zz_*.test.ts` (vitest only includes `tests/**`), run with `--silent=false`, delete afterwards.
- `npm run build` runs `tsc --noEmit` first.
