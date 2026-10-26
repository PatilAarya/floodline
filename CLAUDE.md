# Floodline: project rules

College AI mini project (viva-defended): a front-end-only flood evacuation route planner on the real Mumbai map.
Original brief: `flood-evacuation-claude-code-prompt.md` (historical: the scope has since been cut down, see below).

## Current status (read first)
**Scope reduced on 2026-10-26 at the user's request** (it is a mini project; everything must be easy to explain).
The site has three pages: **Simulator** (the main demo: source -> destination, shortest path, roads close, re-plan), **Algorithms** (search race) and **Bayes** (flood-risk network).
Deleted on purpose (do not bring back unless asked): the city-wide crowd simulator, CSP assignment, simulated annealing / hill climbing, the Experiments page, the Viva page and `docs/VIVA.md`, the Home scroll story, likelihood weighting, d-separation, editable CPTs.
**Next: phase 10** (README.md, DEPLOY.md, final checklist; do not deploy). `HANDOFF.md` has the state, architecture and gotchas.

## Hard rules
- **Never** run any git command that modifies the repo (`git init/add/commit/push/checkout/reset/stash`...), deploy commands, or create remotes/accounts/hosting. The user commits and pushes. At the end of a phase, give a commit message and the three commands (`git add .`, `git commit -m "..."`, `git push`), each in its own code block.
- After each piece of work: `npx tsc --noEmit -p .`, `npx vitest run` and `npm run build` must pass and `npm run dev` must start. Then stop and summarise briefly.
- Minimal testing: only the small Vitest checks (A* cost == UCS cost, enumeration == variable elimination, flood mass conservation, map connectivity). No Playwright, Lighthouse or screenshot loops.
- Keep it small and explainable: do not add features the user did not ask for. Ask once, in a batch, if something essential is unclear. Ask before adding any extra hue.

## Scope
- **Light theme only.**
- **Real Mumbai map**: Mithi River basin (~10 x 10 km). Roads/water/places from OpenStreetMap (credit "(c) OpenStreetMap contributors", ODbL), elevation from NASA SRTM via OpenTopoData (credit it). Built once into `src/data/mumbai.json` by `scripts/fetch-mumbai.mjs` + `scripts/build-mumbai.mjs`. Site stays offline.
- The storm in the Simulator is 26 July 2005 (fixed). The physical flood model runs in a worker; roads close as water rises.
- The synthetic city generator (`src/world/cityGen.ts`) stays for tests only.

## Stack
- Vite + TypeScript strict, **vanilla TS, no UI framework**. Hash router (`src/core/router.ts`).
- WebGL2 (raw) for terrain/water, Canvas 2D overlay for roads/routes/labels, full Canvas 2D fallback.
- Web Worker for the flood simulation (transferable typed arrays).
- Allowed deps: `d3-delaunay`, `vitest`, `@fontsource/*`. Everything else hand-written.
- Static build to `dist/`; `base` defaults to `./`, override with `BASE_PATH`. Hash routing, so no rewrites.

## Algorithms (hand-written, pure, no DOM)
- Search: BFS, DFS, UCS, Greedy Best-First, A* (`src/ai/search/`), each reporting expand/frontier events.
  Cost = travel time (length / speed, slowed by water); degraded roads get a 300 s penalty; closed roads = Infinity. Heuristic = straight-line distance / fastest speed (admissible + consistent).
- Re-planning (`src/sim/journey.ts`): before departure keep the plan valid; on the way, if a road ahead closes, search again from the next junction; if the road under the car closes, push on (nearly through) or turn back. Alternatives B and C by the penalty method (re-run A* with used roads made more expensive).
- Bayesian network (`src/ai/bayes/`): Rain, RiverLevel, Drainage, Elevation, FloodRisk, RainGauge, RiverGauge; inference by enumeration and variable elimination.
- Flood: virtual-pipes shallow water in a worker, CFL-clamped, mass-conserving.

## Design rules (strict)
- Only five colour tokens (`src/styles/tokens.css`); every other shade via `color-mix(in oklab, ...)` in CSS, or `src/render/theme.ts` in canvas/WebGL. No other hex in components.
- **No red/blue/green**, no stock success/warning/error colours. Hazard = luminance, hatching, dashes, weight, pulse, accent vs primary. Must read in greyscale.
- Fonts: Bricolage Grotesque (headings), Instrument Sans (body/UI), JetBrains Mono (numbers). Body never under 16px; tabular numerals for data.
- **No cards, boxed tiles or shadows.** Whitespace, hairlines, big numerals, full-bleed canvases.
- **No stock icons or default controls.** Words or bespoke SVG glyphs; custom slider/toggle/segmented (`src/ui/controls/`), keyboard-accessible, 2px offset focus ring in accent.
- Motion 200-500 ms, one easing family, respect `prefers-reduced-motion`.
- Responsive 320px to 4K: desktop side rail, tablet/phone bottom sheet.

## Folder structure
```
src/core      rng noise pq geometry store router units prefs
src/world     terrain cityGen types presets mumbai worldClient worldWorker
src/sim       floodModel floodEngine floodWorker floodClient hydrology rainfall scenario riskModel journey
src/ai/search bfs dfs ucs greedy astar cost types replanner
src/ai/bayes  network cpt exact
src/render    gl/ canvas/ theme camera
src/ui        layout mapView sheet dom glyphs searchDemo controls/ charts/bars
src/pages     simulator algorithms bayes
src/styles    tokens base type layout motion
tests/  scripts/  DEPLOY.md  README.md
```
