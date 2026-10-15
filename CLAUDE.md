# Floodline: project rules

College AI mini project (viva-defended): a front-end-only dynamic flood evacuation planner.
Full original brief: `flood-evacuation-claude-code-prompt.md` (the source of truth if anything here is ambiguous).

## Current status (read first)
Phases 1-6 are done (plus the Mumbai/light-theme scope change). **Next: phase 7 (Simulator integration: strategy 3 = risk-aware + CSP + SA).**
`HANDOFF.md` has the full state, the architecture as built, gotchas, and the detailed plan for phases 6-10. Read it before starting.

## Hard rules
- **Never** run any git command that modifies the repo (`git init/add/commit/push/checkout/reset/stash`...), deploy commands, or create remotes/accounts/hosting. The user commits and pushes. At the end of a phase, give a commit message and the three commands (`git add .`, `git commit -m "..."`, `git push`), each in its own code block.
- Work **phase by phase** (below). After each phase: `npm run build` must pass and `npm run dev` must start. Then stop and summarise in 3-5 lines (what works, what to look at, commit message, what's next).
- Minimal testing: only the small Vitest checks (A* cost == UCS cost, enumeration == variable elimination, CSP map-colouring solve + infeasible detection, flood mass conservation). No Playwright, Lighthouse or screenshot loops.
- Ask once, in a batch, if something essential is unclear. Ask before adding any extra hue.

## Scope changes requested by the user (2026-10-14)
- **Light theme only.** No dark theme, no theme switch.
- **Real Mumbai map**: Mithi River basin (~10 x 10 km: Kurla, BKC, Dharavi, Sion, Kalina, Santacruz, Bandra, Mahim).
  Roads/water/places from OpenStreetMap (ODbL, credit "(c) OpenStreetMap contributors"), elevation from NASA SRTM 30 m via OpenTopoData (credit it).
  Fetched once by `scripts/fetch-mumbai.mjs` (raw cache in `scripts/.cache/`, not shipped), processed by `scripts/build-mumbai.mjs` into `src/data/mumbai.json`. Site stays offline.
- Storms are modelled on real events (26 July 2005 ~944 mm/24 h, heavy monsoon days) plus tide at the sea boundary. Seeds vary storm, tide phase, sensor noise, population jitter.
- **Two flood controls**: an instant "Water level" slider (flood rises/recedes immediately, roads close/reopen, agents re-route) and the physical rain simulation with a draggable timeline scrubber.
- The synthetic city generator (`src/world/cityGen.ts`) stays for tests only.

## Stack
- Vite + TypeScript strict, **vanilla TS, no UI framework**. Small store (`src/core/store.ts`) + hash router (`src/core/router.ts`).
- WebGL2 (raw) for terrain/water, Canvas 2D overlay for roads/agents/labels, full Canvas 2D fallback.
- Web Workers for flood sim and experiments (transferable typed arrays).
- Allowed deps: `d3-delaunay`, `vitest`, `@fontsource/*`. Everything else hand-written (noise, PRNG, PQ, graph, BN, CSP, SA, charts).
- Static build to `dist/`; `base` defaults to `./`, override with `BASE_PATH` env var. Hash routing, so no rewrites.

## Algorithms (all hand-written, pure, seeded, no DOM, step-event streams)
- Search: BFS, DFS, UCS, Greedy Best-First, A*, dynamic re-planner (mid-edge handling, hysteresis).
  Cost `length / v_eff * (1 + lambda * P_flood)`, degraded edges get a large finite penalty, blocked = Infinity. Heuristic = straight-line / v_max (admissible + consistent).
- Bayesian network: Rain, RiverLevel, Drainage, Elevation, FloodRisk, RainGauge, RiverGauge. Enumeration + variable elimination + likelihood weighting, d-separation.
- CSP: groups to shelters; backtracking, forward checking, MRV, degree, LCV; budgets; relaxation when infeasible.
- Local search: Simulated Annealing (geometric/linear cooling) vs Hill Climbing (steepest, first-choice), starting from the CSP solution.
- Flood: virtual-pipes shallow water in a worker, CFL-clamped, mass-conserving.

## Design rules (strict)
- Only five colour tokens, light theme only (`src/styles/tokens.css`); every other shade via `color-mix(in oklab, ...)` in CSS, or `src/render/theme.ts` (oklab mixing) in canvas/WebGL. No other hex in components.
- **No red/blue/green**, no stock success/warning/error colours. Hazard = luminance, hatching, dashes, weight, pulse, accent vs primary. Must read in greyscale.
- Fonts: Bricolage Grotesque (headings), Instrument Sans (body/UI), JetBrains Mono (numbers/code/CPTs). Body 17-18px/1.6, never under 16px; max ~68ch; tabular numerals for data.
- **No cards, boxed tiles or shadows.** Whitespace, hairlines, big numerals, margin annotations, full-bleed canvases.
- **No stock icons or default controls.** Words or bespoke SVG glyphs (`src/ui/glyphs.ts`). Custom slider/toggle/segmented/scrubber (`src/ui/controls/`), keyboard-accessible, 2px offset focus ring in accent.
- Motion: one easing family (`--ease`, `--ease-io`), 200-500 ms, water-line page wipe, respect `prefers-reduced-motion`.
- Responsive 320px to 4K: desktop side rail, tablet bottom drawer, phone swipe-up sheet.

## Folder structure
```
src/core     rng noise pq geometry store router units
src/world    terrain cityGen types presets
src/sim      floodWorker floodModel rainfall hydrology agents scenario
src/ai/search bfs dfs ucs greedy astar replanner
src/ai/bayes  network cpt exact sampling dsep
src/ai/csp    model backtracking forwardChecking heuristics relax
src/ai/local  simulatedAnnealing hillClimbing cooling objective
src/render   gl/ canvas/ theme camera
src/ui       layout controls/ charts/ glyphs
src/pages    home simulator algorithms bayes assignment experiments viva (+ kit: controls demo, unlisted)
src/styles   tokens base type layout motion
tests/  docs/VIVA.md  DEPLOY.md  README.md
```

## Phases
1. Foundations (Vite/TS, tokens, fonts, theme, shell, router, controls kit)
2. World (PRNG, noise, terrain, river, roads, neighbourhoods, shelters, presets, static Canvas render)
3. Flood sim + WebGL (worker, mass conservation, edge states, water shader, playback/scrubber, quality, fallback)
4. Search + agents (all searches, re-planner, Algorithms race page)
5. Bayesian network (inference, live evidence, risk overlay, Bayes page)
6. CSP + SA/HC (Assignment page, search tree, relaxation)
7. Simulator integration (strategies, inspector, events log, ticker)
8. Experiments (batch worker, charts, conclusion, CSV)
9. Home narrative, Viva page, polish, a11y, favicon/OG, docs
10. Deploy-ready handoff (DEPLOY.md, README.md, checklist)
