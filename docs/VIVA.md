# Floodline: viva notes

Revision notes for every algorithm in Floodline: what it does, why it is here, how expensive it is, where it lives in the code, and short answers to the questions an examiner is likely to ask. The Viva page on the site shows this same file.

## The project in one minute

Mumbai's Mithi River basin (Kurla, BKC, Dharavi, Sion, Kalina, Santacruz, Bandra, Mahim; about 10 x 10 km) floods every monsoon. Floodline simulates that flood on the real map and evacuates about 411,000 people from low-lying homes to 10 relief centres.

- A **Bayesian network** turns two noisy gauges (rain and river) into a flood-risk probability for every neighbourhood and road.
- A **CSP** (backtracking, forward checking, MRV, degree, LCV) assigns evacuee groups to relief centres within capacity, reachability and a deadline, and explains itself when no plan exists.
- **Simulated annealing** improves that plan (compared against **hill climbing**).
- **A\*** routes every group and **re-plans live** when roads go under (compared against BFS, DFS, UCS and Greedy Best-First).
- A **shallow-water flood model** (virtual pipes) moves the water; everything runs in the browser.

The one-liner: *navigation apps assume the road network is fixed; ours handles roads that disappear and risk that is uncertain.*

The evidence (Experiments page, 50 seeded storms shaped like 26 July 2005, by vehicle): risk-aware + CSP + SA sheltered more people than naive static routing in 50 of 50 storms (97.9% against 69.7% of the people needing a centre, sign test p < 0.001). Against dynamic A* it sheltered the same number in 46 storms; its gain there is speed: the slowest 5% of trips were shorter in 40 storms and longer in 8 (mean 95th percentile 147 against 169 minutes).

## Syllabus map

| Module | Topic | Where in Floodline |
|---|---|---|
| I | Uninformed search: BFS, DFS, UCS | Algorithms page; `src/ai/search/bfs.ts`, `dfs.ts`, `ucs.ts` |
| I | Informed search: Greedy Best-First, A*, heuristics, admissibility, consistency | Algorithms page; `greedy.ts`, `astar.ts`, `cost.ts` |
| I | Local search: hill climbing, simulated annealing | Assignment page; `src/ai/local/` |
| II | Constraint satisfaction: backtracking, forward checking, MRV, degree, LCV | Assignment page; `src/ai/csp/` |
| III | Bayesian networks: exact inference (enumeration, variable elimination), approximate inference (likelihood weighting), d-separation | Bayes page; `src/ai/bayes/` |
| III | Planning and acting under uncertainty: re-planning when the world changes | Simulator; `src/ai/search/replanner.ts`, `src/sim/agents.ts` |
| IV | Learning | Not part of this project. An optional extension would be learning the CPTs from recorded gauge data by maximum likelihood. |

## Search: the shared setup

### The problem

The road graph comes from OpenStreetMap: 3,520 junctions (nodes) and 4,927 road segments (edges), stored in compressed adjacency form (CSR). A search problem is a start node, a goal node and an edge cost function. Every algorithm reports `expand`, `frontier`, `goal` and `fail` events through a callback, so the page can animate it without changing it.

### Cost model

```
cost(e) = length(e) / v_eff(e) * (1 + lambda * P_flood(e))      seconds
        + 300 s                                                  if e is degraded (partly flooded)
cost(e) = Infinity                                               if e is blocked
```

`v_eff` is the free-flow speed slowed by the water on the road. `P_flood` comes from the Bayesian network combined with the water already on the road. `lambda` is the risk weight (0 = fastest route; 2 in the Simulator). A road is degraded from 15 cm of water and blocked from 30 cm for vehicles (25 cm and 50 cm on foot).

### Heuristic and why it is admissible and consistent

```
h(n) = straight-line distance(n, goal) / v_max
```

- Admissible: every route is at least as long as the straight line, no road is faster than `v_max`, and every multiplier in the cost is at least 1, so the true cost is never below `h`.
- Consistent: for an edge u to v, `h(u) - h(v) <= |uv| / v_max <= length / v_max <= cost(u, v)` by the triangle inequality. So f never decreases along a path and A\* never needs to reopen a closed node.

Both properties are unit-tested on the real map, dry and flooded (`tests/search.test.ts`).

### In the code

`src/ai/search/types.ts` (problem, events, path reconstruction), `cost.ts` (`makeCost`, `makeHeuristic`, `maxSpeed`), `src/core/pq.ts` (binary min-heap with FIFO tie-break).

## Breadth-First Search

### Intuition

Explore in rings: everything one road away, then two, then three. It finds the route with the fewest road segments, not the fastest.

### Pseudocode

```
frontier <- FIFO queue [start];  visited <- {start}
while frontier not empty:
    n <- pop front
    if n = goal: return path
    for each neighbour m of n (edge open):
        if m not visited: visited += m; parent[m] <- n; push back m
return failure
```

### Complexity

Time O(V + E), space O(V). Complete. Optimal only when every edge costs the same.

### Why here, why not

Here as the baseline uninformed search. Not used for evacuation because road segments have very different lengths and speeds: fewest segments is not fastest.

### In the code

`src/ai/search/bfs.ts`, function `bfs`.

### Likely questions

1. **Is BFS optimal here?** No. It minimises the number of edges; travel times differ per edge, so its route is usually slower.
2. **When is BFS optimal?** When all step costs are equal (or a non-decreasing function of depth).
3. **Why mark visited when pushing, not when popping?** So a node enters the queue only once; marking on pop allows duplicates and wastes memory.
4. **Memory problem of BFS?** The frontier can hold a whole level of the graph: O(b^d) in a tree search.
5. **Does BFS handle closed roads?** Yes: an edge with infinite cost is simply not followed.

## Depth-First Search

### Intuition

Follow one road as far as it goes, back up only at a dead end. Cheap in memory, but the path is whatever it stumbles into.

### Pseudocode

```
stack <- [start]
while stack not empty:
    n <- pop
    if n visited: continue
    visited += n
    if n = goal: return path
    push unvisited neighbours (nearest-to-goal pushed last, so explored first)
return failure
```

### Complexity

Time O(V + E), space O(V) with the visited set (O(b m) in a tree search). Complete on a finite graph with a visited set. Not optimal.

### Why here, why not

A contrast case on the race page. Never used for routing: its routes are long and winding.

### In the code

`src/ai/search/dfs.ts`, function `dfs`. Neighbours are ordered by straight-line distance to the goal to make it deterministic and a little less erratic; this does not make it optimal.

### Likely questions

1. **Why is DFS not optimal?** It returns the first path found, with no regard to cost.
2. **Is DFS complete?** On a finite graph with a visited set, yes. In an infinite space or without cycle checking, no.
3. **Its advantage?** Memory: only the current path and the siblings along it.
4. **What would make it optimal?** Nothing simple; iterative deepening gives the shallowest goal, still not the cheapest with varying costs.
5. **Why order neighbours by distance to the goal?** Determinism and a fairer demo; it is a tie-break, not a heuristic search.

## Uniform Cost Search

### Intuition

Dijkstra's algorithm with a goal test: always expand the cheapest-so-far node. It ripples outwards in every direction until the goal is reached.

### Pseudocode

```
frontier <- min-heap [(0, start)];  g[start] <- 0
while frontier not empty:
    (d, n) <- pop min
    if d > g[n]: continue                       # stale entry (lazy deletion)
    if n = goal: return path
    for each edge n -> m with cost c < Infinity:
        if g[n] + c < g[m]: g[m] <- g[n] + c; parent[m] <- n; push (g[m], m)
return failure
```

### Complexity

Time O((V + E) log V), space O(V). Complete and optimal for non-negative costs.

### Why here, why not

The optimal reference: the tests check that A\* always returns exactly the UCS cost. Not the default router because A\* finds the same cost while expanding far fewer nodes.

### In the code

`src/ai/search/ucs.ts`, function `ucs`; `COST_EPS` treats costs within 1e-9 s as equal.

### Likely questions

1. **Why is UCS optimal?** With non-negative costs, the first time the goal is popped its g is minimal: any other path would have to pass through a frontier node with g at least as large.
2. **What is lazy deletion?** Instead of decrease-key, push the node again with the better cost and skip stale entries when popped.
3. **UCS vs Dijkstra?** Same algorithm; UCS stops at the goal, Dijkstra usually computes all shortest paths.
4. **Negative edge costs?** UCS breaks; costs here are travel times, never negative.
5. **Where else is it used?** The multi-goal search for the nearest relief centre with room (`nearestShelter` in `replanner.ts`) is UCS that stops at the first acceptable goal.

## Greedy Best-First Search

### Intuition

Always go to the node that looks closest to the goal (smallest h). Fast, but it can be lured towards the goal and then forced round a long detour.

### Pseudocode

```
frontier <- min-heap by h(n), [start]
while frontier not empty:
    n <- pop min h
    if n = goal: return path
    for each unvisited neighbour m: parent[m] <- n; push m with priority h(m)
return failure
```

### Complexity

Time and space O(V log V) on a finite graph (O(b^m) in the worst case for tree search). Complete with a visited set on a finite graph. Not optimal.

### Why here, why not

Shows what the heuristic alone does. Not used because a river or a closed bridge between start and goal makes it head straight for the water and then backtrack.

### In the code

`src/ai/search/greedy.ts`, function `greedy`.

### Likely questions

1. **Difference from A\*?** Greedy uses f = h; A\* uses f = g + h. Ignoring g means ignoring what the path already cost.
2. **Is Greedy optimal with an admissible heuristic?** No: admissibility only helps when g is in f.
3. **When is it good?** When the straight line is a good guide (open grid, no barriers) and speed matters more than quality.
4. **Why does the Mithi river hurt it?** Few bridges: the closest-looking nodes are on the wrong bank.
5. **Can it fail to find a path that exists?** Not with a visited set on a finite graph; it may find a bad one.

## A* search

### Intuition

Expand the node with the smallest f = g + h: cost so far plus an optimistic estimate of the rest. The heuristic pulls the search towards the goal, so it does a fraction of UCS's work and still returns the optimal route.

### Pseudocode

```
frontier <- min-heap by f, [start];  g[start] <- 0
while frontier not empty:
    n <- pop min f   (ties: larger g first, then insertion order)
    if n = goal: return path
    if n was already closed with a smaller g: continue
    close n
    for each edge n -> m with cost c < Infinity:
        if g[n] + c < g[m]:
            g[m] <- g[n] + c; parent[m] <- n; push m with f = g[m] + h(m)
            (reopen m if it was closed: only matters for an inadmissible h)
return failure
```

### Complexity

Worst case like UCS, O((V + E) log V); in practice it expands a corridor between start and goal, far fewer nodes than UCS (the race page prints the exact saving for every start and goal). Space O(V). Complete; optimal with an admissible heuristic.

### Why here, why not

The router for every evacuee group: optimal and fast enough to re-run whenever a road on a route closes. Why not Dijkstra from every group? A\* toward one known centre is cheaper per query. Why not D\* Lite (incremental re-planning)? It would reuse work between re-plans, but plain A\* on 3,520 junctions runs in milliseconds and groups re-plan rarely, so the extra complexity buys little here and is harder to defend.

### In the code

`src/ai/search/astar.ts`, function `astar`; heuristic in `cost.ts` (`makeHeuristic`). The race page's "bad heuristic" multiplies h by 4 to show an inadmissible heuristic returning a slower route.

### Parameters

`lambda` (risk weight), the degraded-road penalty (300 s), the closing depths (30 cm vehicle, 50 cm foot), `v_max` (fastest road speed; walking speed on foot).

### Likely questions

1. **Prove A\* is optimal.** With admissible h, when the goal is popped with cost C, every frontier node n has f(n) >= C; since h never overestimates, no unexplored path can cost less than C.
2. **Admissible vs consistent?** Admissible: h <= true cost. Consistent: h(u) <= c(u,v) + h(v). Consistent implies admissible (with h(goal) = 0) and means no node needs reopening.
3. **What if h = 0?** A\* becomes UCS.
4. **What if h overestimates?** It may return a suboptimal path faster (weighted A\*). The race page demonstrates it.
5. **Is your heuristic still valid on flooded roads?** Yes: water only slows roads or closes them, which raises costs, so the straight line over the fastest speed stays a lower bound. Tested on the flooded map.

## Dynamic re-planner

### Intuition

Each evacuee group follows its A\* route through the flooding city. When a road ahead closes, the group must re-plan; when things merely get worse, or every 20 minutes, it may re-plan, but only if the new route is clearly better (hysteresis, so it does not flip between two similar routes).

### Pseudocode

```
every simulated minute, for each moving group:
    if a road under the group just closed:
        if little of it is left: push on, else turn back to the previous junction
    if any road ahead is now blocked:            re-plan (mandatory)
    else if a road ahead got worse, or 20 min since the last check:
        new <- A* from the next junction to the same centre
        adopt new only if cost(new) < (1 - 0.12) * cost(rest of current route)
               and at least 10 min since the last switch
    if the centre itself is cut off: nearest centre with room (multi-goal UCS),
        skipping centres it was turned away from in the last hour (taboo)
```

### Complexity

One A\* per re-plan, O((V + E) log V). Re-plans are rare (about 29 per storm on average across 178 groups for dynamic A\*), so the cost is negligible next to the flood model.

### Why here, why not

This is the point of the project: the road network changes while people are on it. Why not re-plan every minute? Thrashing (routes flipping back and forth) and wasted work; hysteresis with a margin and a minimum interval prevents it.

### In the code

`src/ai/search/replanner.ts` (`shouldAdoptOptional`, `midEdgeDecision`, `nearestShelter`, `routeTo`; constants `MARGIN` 0.12, `MIN_INTERVAL` 10, `PERIODIC_EVERY` 20, push on if at most 120 m or 30% left), used by `src/sim/agents.ts` (`AgentSim.step`).

### Likely questions

1. **What happens to a group in the middle of a road that closes?** If the end is close (at most 120 m or 30% of the road) it pushes on; otherwise it turns back to the junction it came from and re-plans there.
2. **How do you stop two groups ping-ponging over a full centre?** Groups book places when they plan, and a centre that turned a group away is taboo for that group for an hour.
3. **What is hysteresis here?** An optional switch must be at least 12% cheaper and at least 10 minutes after the last switch.
4. **Why not plan once and stick to it?** That is the naive strategy: it shelters about 30% fewer people because groups wait at closed roads.
5. **Is it deterministic?** Yes: every decision depends only on the simulation state, so rewinding the timeline replays identically (tested).

## Bayesian network: the model

### Structure

Seven discrete variables, three states each. Rain and RiverLevel are hidden; we see only two noisy sensors. Drainage and Elevation are known per neighbourhood.

```
Rain -> RiverLevel,  Rain -> RainGauge,  RiverLevel -> RiverGauge
Rain, RiverLevel, Drainage, Elevation -> FloodRisk
```

### Where the numbers come from

- Rain states use Mumbai's storm-drain design standard: light below 25 mm/h, moderate 25-60, heavy 60 and above.
- River states are fractions of the way from the channel bed to the bank top at the Mithi gauge: low below 0.3, normal to 0.6, high above.
- Elevation: low below 5 m above sea, mid to 9 m, high above.
- The gauges are right about 80-90% of the time and usually one state off when wrong. The simulation injects exactly this noise, so the sensor model is honest.
- FloodRisk has 81 rows. They come from an ordered logistic score `z = 1.8 rain + 1.2 river + 0.6 (poor drainage) + 2.0 (lowness)`, with `P(risk >= medium) = sigmoid(z - 4.5)` and `P(high) = sigmoid(z - 7.5)`, rounded and shown as an editable table. Every row is validated to sum to 1.

### Live use

Every 10 simulated minutes both gauges report (truth plus seeded misreads). Variable elimination gives P(FloodRisk | gauges, Drainage, Elevation) for all 9 drainage/elevation combinations; each neighbourhood looks up its own. A road's flood probability is a noisy-OR of the network's P(high) for that road and how close the water on it is to the closing depth. Risk-aware A\* uses it.

### In the code

`src/ai/bayes/network.ts` (types, CPT layout, validation), `cpt.ts` (`mumbaiNetwork`, thresholds, `RISK_WEIGHTS`), `src/sim/riskModel.ts` (`readGauges`, `riskPosterior`, `edgeRisk`).

### Likely questions

1. **Why a Bayesian network and not a fixed rule?** The sensors are noisy and the causes are hidden; the network combines both readings with what we know about each place, and says how sure it is.
2. **Why is RiverLevel a child of Rain?** Rain raises the river; the edge carries that dependence, so a heavy rain reading also raises our belief in a high river.
3. **How many parameters?** Rain 3, RiverLevel 9, Drainage 3, Elevation 3, RainGauge 9, RiverGauge 9, FloodRisk 243: 279 numbers (fewer free ones, since rows sum to 1), against 3^7 = 2,187 for the full joint.
4. **Why generate FloodRisk from a logistic score?** 81 rows invented by hand would be inconsistent; the score gives monotone, explainable rows with only four weights and two cut points.
5. **What if a CPT row does not sum to 1?** `validate` reports it; the Bayes page hatches the row and pauses inference until it is fixed.

## Inference by enumeration

### Intuition

P(Q | e) is proportional to the sum, over every assignment of the hidden variables, of the product of all CPT entries. Exact but exponential.

### Pseudocode

```
for each value q of Q:
    total[q] <- sum over all hidden assignments h of  prod over X of P(x | parents(x))   (with Q = q, evidence fixed)
return total / sum(total)          (if the sum is 0: impossible evidence)
```

### Complexity

O(n * d^h): n variables, d states, h hidden variables. Here at most 3^6 = 729 terms of 7 factors each.

### Why here, why not

The definition of the answer: the test checks variable elimination against it on seven evidence sets (to 1e-9). Not used live because variable elimination does the same with less work.

### In the code

`src/ai/bayes/exact.ts`, function `enumerationAsk`.

### Likely questions

1. **Why normalise at the end?** We compute P(Q, e); dividing by P(e) = sum over q gives P(Q | e).
2. **What is impossible evidence?** Observations with probability 0 under the model; there is nothing to normalise, so the code says so instead of dividing by zero.
3. **Why does it repeat work?** The same sub-products appear in many terms; variable elimination computes each once.
4. **Complexity in a polytree?** Still exponential for enumeration; VE is linear in a polytree.
5. **Underflow?** With 7 variables it is fine; VE also rescales intermediate factors.

## Variable elimination

### Intuition

Push the sums inside the product: multiply only the factors that mention a variable, sum that variable out, and keep the smaller factor. Each sub-product is computed once.

### Pseudocode

```
factors <- one factor per CPT, restricted to the evidence
drop variables that are not ancestors of the query or the evidence (barren)
order <- hidden variables, fewest neighbours first (min-neighbours)
for each hidden X in order:
    F <- product of the factors that mention X
    replace them by  sum over X of F      (rescale to avoid underflow)
result <- product of the remaining factors; normalise
```

### Complexity

Exponential only in the size of the largest factor created, which depends on the elimination order (finding the best order is NP-hard; min-neighbours is a good greedy rule). On this network the largest factor has at most 81 entries.

### Why here, why not

The live inference engine: 9 queries every 10 simulated minutes, cheap. Why not junction-tree propagation? It would give all marginals at once, but for a 7-node network VE is simpler to explain and fast enough.

### In the code

`src/ai/bayes/exact.ts`: `variableElimination`, `multiply`, `sumOut`, `relevantVars` (barren pruning), `minNeighboursOrder`.

### Likely questions

1. **Why does the order matter?** It decides how big the intermediate factors get; a bad order can create a factor over many variables.
2. **What is a barren variable?** An unobserved leaf that is not the query: summing it out gives 1, so it can be removed before starting.
3. **Is VE exact?** Yes, identical to enumeration (tested to 1e-9).
4. **Complexity class of exact inference in general?** NP-hard (#P-hard) in general networks; linear in polytrees.
5. **How do you avoid underflow?** Intermediate factors are rescaled; the final normalisation removes the scale.

## Likelihood weighting

### Intuition

Sample the network top-down, but never sample the evidence: fix it and multiply the sample's weight by how likely that evidence was. The weighted fraction converges to the exact answer.

### Pseudocode

```
for i in 1..N:
    w <- 1
    for X in topological order:
        if X is evidence: x <- observed; w <- w * P(x | parents)
        else: x <- sample from P(X | parents)
    W[value of Q] += w
return W / sum(W)
```

### Complexity

O(N * n). Error shrinks roughly like 1 / sqrt(N_eff), where N_eff = (sum w)^2 / sum w^2.

### Why here, why not

Shows approximate inference converging (Bayes page: five seeded runs of 100,000 samples against the exact value). Not used live because VE is exact and fast here. Why not rejection sampling? It throws away every sample that disagrees with the evidence; with unlikely evidence almost all of them.

### In the code

`src/ai/bayes/sampling.ts`, function `likelihoodWeighting` (seeded `Rng`, log-spaced checkpoints, effective sample size).

### Likely questions

1. **Why is it better than rejection sampling?** Every sample is used, weighted, instead of discarding those that contradict the evidence.
2. **When does it struggle?** Unlikely evidence, especially evidence low in the network: weights become tiny and a few samples dominate (low N_eff).
3. **Is it unbiased?** It is consistent: the ratio estimate converges to the true posterior as N grows.
4. **Why seed it?** Reproducible plots and tests.
5. **What is Gibbs sampling and why not use it?** MCMC that resamples one variable at a time; it handles downstream evidence better but needs burn-in and is harder to explain. Not needed for 7 nodes.

## d-separation

### Intuition

Read independence off the graph. A trail between A and B carries influence unless some node blocks it: an observed node in a chain or fork blocks; a collider blocks unless it or a descendant is observed.

### Pseudocode (Bayes-ball)

```
reachable from A, tracking direction of arrival:
    arrived from a child at an unobserved node:  go to parents and children
    arrived from a parent at an unobserved node: go to children only
    arrived from a parent at a node that is observed or has an observed descendant: go to parents (collider opened)
    arrived from a child at an observed node:    stop
A and B are d-separated given Z  iff  B is never reached
```

### Complexity

O(V + E) for Bayes-ball. Listing every trail (used only for the explanations) is exponential in general but trivial for 7 nodes.

### Why here

Explains the network's assumptions: e.g. Rain and Drainage are independent, but become dependent once FloodRisk is observed (explaining away). The page also checks numerically that d-separated pairs show zero change in probability.

### In the code

`src/ai/bayes/dsep.ts`: `dSeparated` (Bayes-ball), `explainTrails`. Tested: both agree on every pair.

### Likely questions

1. **Give an example of explaining away here.** Observe FloodRisk = high; now learning the drainage is good makes heavy rain more likely. Rain and Drainage are dependent given their common child.
2. **Are RainGauge and RiverGauge independent?** Not unconditionally (both depend on Rain); yes given Rain and RiverLevel.
3. **Does d-separation depend on the CPT numbers?** No, only on the graph; it guarantees independence for every choice of numbers.
4. **Can two nodes be independent without being d-separated?** Yes, by numerical coincidence in the CPTs; d-separation captures the independences the structure guarantees.
5. **Why does observing a descendant of a collider open it?** It carries information about the collider, which in turn links its parents.

## CSP: the shelter-assignment model

### Formulation

- **Variables:** evacuee groups. Each neighbourhood's demand is split into groups of at most 2,500 people so whole groups can fit a centre: 178 groups for about 411,000 people.
- **Domains:** the 10 relief centres, listed nearest first.
- **Unary constraints** (applied once, before search: node consistency): the centre is open (not closed by hand, not flooded), reachable over open roads, below the flood-risk limit, and within the deadline.
- **Global capacity constraint:** the people assigned to a centre must fit inside it. Groups whose domains share a centre compete for it, so they are neighbours in the constraint graph.
- **Soft "keep neighbourhoods together":** not a hard constraint; it is a term in the local-search objective.

Travel times come from one Dijkstra search from each centre (roads are two-way), so 10 searches give every junction's time to every centre.

### In the code

`src/ai/csp/model.ts` (generic CSP, `mapColouring`, `capacityNeighbours`, `consistent`), `src/sim/assignment.ts` (`prepareNetwork`, `buildInstance`, reasons per pair), `src/sim/planner.ts` (the same inside the simulation).

### Likely questions

1. **Why split neighbourhoods into groups?** A neighbourhood of 100,000 people fits no single centre; groups of 2,500 make the capacity constraint satisfiable and the plan realistic (one bus convoy).
2. **Why are reachability and deadline unary?** They depend on one group and one centre only, so they shrink domains up front.
3. **Is capacity binary?** No, it is a global (n-ary) sum constraint; forward checking handles it by removing a centre from a group that no longer fits.
4. **How many states in the search space?** 10^178 in principle; MRV and forward checking solve the default instance in 178 nodes (no backtracking).
5. **Where is the map-colouring test?** `tests/csp.test.ts`: Australia with 3 colours is solved under all 16 heuristic combinations, and a 4-clique with 3 colours is proved infeasible.

## Backtracking search

### Pseudocode

```
BACKTRACK(assignment):
    if complete: return assignment
    X <- SELECT-UNASSIGNED-VARIABLE        (first, or MRV + degree)
    for v in ORDER-DOMAIN-VALUES(X)          (as listed, or LCV)
        if X = v is consistent:
            assign; (forward check; on wipeout undo and continue)
            result <- BACKTRACK(assignment)
            if result != failure: return result
            undo
    return failure
```

### Complexity

O(d^n) in the worst case (d values, n variables). Budgets keep the page responsive: 50,000 nodes or 1.2 s on the Assignment page; inside the simulation a node budget only (6,000), because a time budget would make results depend on the machine.

### Why here, why not

The textbook complete method; with the heuristics it solves the real instance instantly. Why not an integer linear program? It would also work, but it is a black box to explain and needs a solver library; the project must be hand-written.

### In the code

`src/ai/csp/backtracking.ts`, function `solveCSP` (events: assign, reject, prune, wipeout, unassign, backtrack, solution, fail, budget). When the budget runs out it returns the best partial assignment (most people placed).

### Likely questions

1. **What is chronological backtracking's weakness?** It backs up one level at a time even when the real culprit was assigned much earlier (thrashing). Conflict-directed backjumping would fix that.
2. **What did plain backtracking do on the full instance?** With a 40-minute deadline it ran out of its 50,000-node budget; with forward checking and MRV it solved it in 178 nodes.
3. **Why a node budget and a time budget?** The UI must never freeze; inside the simulation only the node budget is used, for determinism.
4. **What is a node in your counters?** One value tried for one variable.
5. **What does the search tree on the page show?** A small real instance (12 groups, 4 centres): solid path = current assignment, dashed = rejected value, hatched ring = wipeout.

## Forward checking

### Intuition

After each assignment, cross out the neighbours' values that are no longer possible. If someone is left with nothing, back up now instead of many levels later.

### Pseudocode

```
after X = v:
    for each unassigned neighbour Y:
        remove every b from dom(Y) with  not compatible(X = v, Y = b)
        if Y no longer fits in what is left of v: remove v from dom(Y)
        if dom(Y) is empty: wipeout -> reject X = v
record every removal on a trail; undo them exactly on backtrack
```

### Complexity

O(sum of neighbours' domain sizes) per assignment. It does not detect every dead end (arc consistency would catch more), but it is cheap.

### In the code

`src/ai/csp/forwardChecking.ts`: `forwardCheck`, `undoTo` (trail of removals).

### Likely questions

1. **FC vs arc consistency (AC-3)?** FC only checks constraints between the new assignment and unassigned variables; AC-3 propagates between all pairs of unassigned variables too. Stronger but more expensive.
2. **What is a wipeout?** A domain that forward checking empties: proof that the current partial assignment cannot be completed.
3. **How is undo done?** Removals are pushed onto a trail; backtracking pops back to the mark taken before the assignment.
4. **Effect on the lab instance?** Plain backtracking tried 152 values with 95 backtracks; FC tried 97 and caught 15 wipeouts early.
5. **Does FC help with capacity?** Yes: when a centre's free places drop below a group's size, that centre leaves the group's domain at once.

## MRV, degree and LCV

### Intuition

- **MRV** (minimum remaining values, fail-first): assign the group with the fewest options left; if it is about to run out, find out near the root.
- **Degree** (tie-break): the variable in the most constraints with unassigned variables.
- **LCV** (least constraining value, succeed-first): try first the centre that removes the fewest options from others; ties go to the shorter trip.

### Complexity

MRV and degree cost O(n) per selection (O(n d) without FC, where legal values must be counted); LCV costs O(d * neighbours * d) per variable.

### In the code

`src/ai/csp/heuristics.ts`: `selectVariable`, `legalCount`, `dynamicDegree`, `orderValues`, `constrainingScore`. Each can be switched on or off on the Assignment page; "Compare all six solver settings" runs them side by side.

### Likely questions

1. **Why does MRV pick the most constrained variable but LCV the least constraining value?** We must assign every variable anyway, so failing early on variables is cheap; but we only need one value to work, so we try the most promising first.
2. **When does LCV not matter?** When proving infeasibility: every value must be tried anyway.
3. **On the lab instance?** FC + MRV solved it in 12 nodes, with no backtracking.
4. **Degree heuristic on its own?** Useful at the very start when all domains are the same size (e.g. map colouring: start with South Australia).
5. **Does the warm start change correctness?** No; `prefer` only changes the order in which values are tried (previous plan first), so re-plans move few people.

## Infeasibility and relaxation

### Intuition

Never hang, never crash: first explain why there is no plan, then offer the best plan that does exist.

### Method

- **Empty domain:** a group with no allowed centre (cut off by water, every centre too far). Reported in words, with the nearest centre's time.
- **Counting (Hall's condition):** for every set T of centres (2^10 = 1,024 sets), the groups that can only use centres in T must fit in T's capacity. The smallest violated T is reported ("72 groups can only use S5, S6, S7, S9: they need 172,400 places, those centres have 158,000"). Proved without search; the page then skips the search.
- **Upper bound (max-flow / min-cut):** min over T of capacity(T) + people whose domain is not inside T equals the maximum flow, the most people any plan could place.
- **Relaxation 1:** place as many people as possible (fewest options first, nearest centre with room, then a one-step "move someone over" repair), reported against the bound.
- **Relaxation 2:** loosen the deadline in 5-minute steps until the problem is solvable.

### In the code

`src/ai/csp/relax.ts`: `explainInfeasibility`, `maximisePartial`, `smallestRelaxation`.

### Likely questions

1. **Why is Hall's condition necessary?** Groups confined to T can only use T's places; if they need more, no assignment exists.
2. **Is it sufficient?** For splittable groups yes (max-flow); for whole groups not quite (bin packing), so the search still runs when counting passes.
3. **How good is the partial plan?** At 1 m of water it placed 406,900 people, exactly the upper bound.
4. **Why not let the search prove infeasibility?** It can take exponential time on symmetric instances (many equal groups); counting proves it at once.
5. **Which relaxation is offered when?** The deadline relaxation only when the deadline actually excludes something; otherwise the page says lowering the water, reopening a centre or adding capacity is needed.

## The objective for local search

Energy, in person-minutes, so every term can be added and explained:

```
E = sum of size x travel time
  + lambda (2) x sum of size x exposure          (P_flood x minutes on each road of the route)
  + 600 per person over a centre's capacity
  + 500 x sum over centres of capacity x (fill - mean fill)^2
  + 15,000 per extra centre a neighbourhood is split across
  + 1,000 per person left without a centre (when some centre was allowed)
  + 30 per person moved from their previous centre (re-planning in the simulation only)
```

`AssignmentState` keeps running totals and applies a move in O(number of centres), so a neighbour's energy is cheap: apply, read, undo. Moves: reassign one group to another allowed centre, or swap the centres of two groups.

In the code: `src/ai/local/objective.ts` (`AssignmentState`, `randomMove`, `summarise`, `DEFAULT_WEIGHTS`).

## Hill climbing

### Pseudocode

```
steepest:      repeat: evaluate every reassignment and swap; take the best if it lowers E, else stop
first-choice:  repeat: draw random neighbours until one lowers E and take it; stop after 4,000 failures in a row
```

### Complexity

Steepest: O(G * S + G^2) evaluations per step (about 15,000 here); first-choice: cheap steps, many of them.

### Why here

The baseline: it can only go downhill, so it stops at the first local minimum.

### In the code

`src/ai/local/hillClimbing.ts`, class `HillClimber`.

### Likely questions

1. **What stops hill climbing?** A local minimum: no single move improves, though a better plan exists.
2. **Plateaus and ridges?** Plateaus give no direction; ridges need two moves at once (the swap move helps).
3. **Steepest vs first-choice?** Steepest scans everything per step; first-choice is cheaper per step and works well when there are many neighbours.
4. **Random restarts?** Run from several starts and keep the best; the annealer supports restarts.
5. **Result on the default plan?** Steepest stopped at 9.73 million person-minutes after 51 steps; annealing reached 9.48 million.

## Simulated annealing

### Intuition

Like hill climbing, but sometimes accept a change for the worse, with probability exp(-dE / T). The temperature T falls as it runs: early on it explores and can climb out of local minima; late it behaves like hill climbing and settles.

### Pseudocode

```
current <- CSP plan;  best <- current
for k in 0 .. K-1:
    T <- T0 * endRatio^(k/K)            (geometric)   or   T0 * (1 - k/K)   (linear)
    next <- random neighbour (reassign or swap)
    dE <- E(next) - E(current)
    if dE <= 0 or random() < exp(-dE / T): current <- next
    if E(current) < E(best): best <- current
return best
```

T0 is set from the problem: the median uphill step of 300 random moves, accepted with probability 0.6 at the start (T0 = -median / ln 0.6).

### Complexity

O(K * S) for K iterations (300,000 on the Assignment page, about 0.3 s; 40,000 inside the simulation).

### Why here, why not

Improves the valid but greedy CSP plan (13.8 million to 9.48 million person-minutes on the default instance, against 9.73 million for steepest hill climbing). Why not a genetic algorithm? Harder to explain, more parameters, no clear gain for a single assignment vector. Why not solve the whole thing exactly as an integer program? Not hand-writable within the project; local search is the syllabus topic.

### In the code

`src/ai/local/simulatedAnnealing.ts` (`Annealer`, a stepper so the page can animate it), `cooling.ts` (`temperature`, `acceptProbability`, `autoT0`).

### Likely questions

1. **Why accept worse moves?** To escape local minima; the probability falls as the temperature drops.
2. **Geometric vs linear cooling?** Geometric spends most of the run cool (fine tuning); linear stays hot longer. Here linear was consistently worse: it leaves too little time to settle.
3. **What if T0 is too high or too low?** Too high: a random walk for most of the run; too low: plain hill climbing.
4. **Does SA guarantee the optimum?** Only with an impractically slow (logarithmic) cooling schedule; in practice it finds a good minimum.
5. **Why start from the CSP solution?** It is feasible already; annealing only has to improve quality, and it keeps capacity respected (overload is heavily penalised).

## Strategy 3 inside the simulation

At the evacuation warning (t+45 min) every group gets a centre from the CSP solver and simulated annealing, using live road states and the network's flood risk; then groups travel by risk-aware A\* with the same live re-planning as dynamic A\*. Every 10 minutes a breadth-first search from each centre checks that every group can still reach its centre. If one cannot (or a group without a centre now could reach one), the assignment is re-run, warm-started from the current plan and with a cost of 30 person-minutes per person moved, so only the groups that need it change (typically 1 to 11 groups per re-plan). The CSP uses a node budget only and the annealer is seeded with (seed, minute), so rewinding replays identically.

In the code: `src/sim/planner.ts` (`planAssignment`), `src/sim/agents.ts` (`runAssignment`, `checkAssignment`).

## The flood model: virtual pipes

### Intuition

The terrain is a grid of water columns joined by pipes to their four neighbours. Water accelerates down the slope of the water surface, friction slows it, and each cell's depth changes by what flows in minus what flows out.

### Pseudocode (one sub-step)

```
add rain; remove storm-drain flow (25 mm/h x drainage quality, less at high tide) and infiltration; add the Mithi inflow
for each pipe k -> m:
    q <- (q + dt g hf (H_k - H_m) / l) / (1 + dt g n^2 q / hf^(7/3))      (local inertial form, Manning friction)
    q <- max(q, 0)
if a cell's pipes would drain more than it holds: scale them all by K = volume / outflow
d += dt (inflows - outflows) / l
sea cells held at the tide level; land cells on the map edge drain freely
```

### Stability and conservation

The time step obeys the CFL condition dt <= 0.7 l / sqrt(g h_max); each minute is split into equal sub-steps, so the state at minute m is identical however you got there. The outflow scaling means depth can never go negative and no water is created. The budget `volume = initial + rain + inflow - drained - infiltrated - outflow + sea exchange` is tested to stay within tolerance.

### Why here, why not

Fast (about 20 million cell updates per second in a worker), stable, mass-conserving, and it shows water spreading over real terrain. Why not full 2D shallow-water equations (Saint-Venant) with a finite-volume solver? More accurate for fast flows and shocks, much more code and slower; urban pluvial flooding is slow, and the local-inertial approximation is what LISFLOOD-FP uses for it.

### In the code

`src/sim/floodModel.ts` (`FloodModel.stepMinute`), `src/sim/hydrology.ts` (drains, infiltration, roughness, road states, the instant water-level mode), `src/sim/floodEngine.ts` (playback, keyframes every 30 minutes, seeking), `src/sim/floodWorker.ts`.

### Likely questions

1. **What is the CFL condition?** Information must not travel more than one cell per step: dt <= l / sqrt(g h). We use a safety factor of 0.7.
2. **How is mass conserved?** Every source and sink is booked; the outflow scaling never lets a cell give more than it has; the test checks the budget.
3. **Why does rewinding give identical results?** Whole-minute steps with equal sub-steps and seeded randomness; keyframes store the full state including the evacuees.
4. **What does the tide do?** Sea cells follow a semi-diurnal tide (plus surge); at high tide the drains' outfall gates close, so drains barely work: the 26 July 2005 story.
5. **Limitations?** 128-256 grid cells (39-78 m) blur narrow streets; buildings are not modelled; the drainage network is a per-cell rate, not pipes.

## Mumbai modelling decisions and their limits

- **Map:** OpenStreetMap roads (tertiary and above for routing: 3,520 junctions, 4,927 segments, 36 bridges, 235 flyovers, 12 subways), waterways, suburbs, schools and colleges (relief-centre candidates). (c) OpenStreetMap contributors (ODbL).
- **Elevation:** NASA SRTM 30 m via OpenTopoData. SRTM measures roofs and trees, so the surface is smoothed (a 5 x 5 grey-scale opening and two box blurs) to approximate the ground. Enclosed pits are limited to 1.2 m deep (priority-flood), and channels are carved and then filled from the sea so they always drain.
- **Bridges and flyovers:** a bridge deck sits 2 m above the higher of its ends and banks and closes when the river surface reaches it; flyovers never flood; subways fill about four times faster.
- **Demand:** residents are estimated from typical densities per suburb (not a census); demand = residents in homes below 6 m x 0.22 participation, about 411,000 people. Relief-centre capacity is 1.1 x demand in total.
- **Traffic:** evacuation vehicles move at 0.35 x free-flow speed (monsoon traffic); groups board for 15 minutes and leave in a staggered order, lowest areas first.
- **Storms:** presets shaped like 26 July 2005 (about 944 mm in 24 h, compressed to the run), 29 August 2017, 2 July 2019 and a heavy shower; seeds shift the peak, its timing and the tide phase.
- **Honest limits:** SRTM is coarse for a dense city; the drainage network is a rate per cell; no building-level flooding; demand and capacities are estimates; evacuees do not cause congestion on roads.

## Experiments: method and results

- Each seed is a storm. In each storm the flood is simulated once and the three strategies evacuate through exactly the same water and the same sensor misreads: a paired comparison. Seed 1 is the historic storm exactly.
- Runs in a pool of Web Workers; one storm (three strategies) takes 10 to 30 seconds per worker.
- Default: 50 storms shaped like 26 July 2005, by vehicle, grid 128.

| Measure (mean over 50 storms) | Naive static | Dynamic A* | Risk-aware + CSP + SA |
|---|---|---|---|
| Share of people sheltered | 69.7% | 97.9% | 97.9% |
| People sheltered | 286,362 | 402,396 | 402,340 |
| Mean trip of sheltered groups | 113.6 min | 40.1 min | 38.4 min |
| 95th percentile trip | 464 min | 169 min | 147 min |
| Minutes until 90% sheltered | never | 304 | 273 |
| Re-plans per storm | 150 | 28.7 | 27.3 |

- Risk-aware + CSP + SA sheltered more people than naive in 50 of 50 storms (115,978 more on average; sign test p < 0.001).
- Against dynamic A\*: more people in 1 storm, fewer in 3, the same in 46. The slowest 5% of trips were shorter in 40 storms and longer in 8 (sign test p < 0.001).
- What to say: re-planning is what saves people (naive vs dynamic); risk-awareness and planned assignment mostly make the evacuation faster and its worst cases less bad.

**The sign test:** for each storm, did A beat B? Ties are dropped. If there were no difference, wins would follow Binomial(n, 1/2); the p-value is the chance of a split at least as lopsided.

## Complexity summary

| Algorithm | Time | Space | Complete | Optimal |
|---|---|---|---|---|
| BFS | O(V + E) | O(V) | yes | only for equal costs |
| DFS | O(V + E) | O(V) | yes (finite, visited set) | no |
| UCS | O((V + E) log V) | O(V) | yes | yes |
| Greedy Best-First | O((V + E) log V) | O(V) | yes (finite, visited set) | no |
| A* | O((V + E) log V) worst | O(V) | yes | yes (admissible h) |
| Enumeration | O(n d^h) | O(n) | exact | exact |
| Variable elimination | exponential in largest factor | same | exact | exact |
| Likelihood weighting | O(N n) | O(n) | converges | approximate |
| d-separation (Bayes-ball) | O(V + E) | O(V) | exact | exact |
| Backtracking (+FC, MRV, LCV) | O(d^n) worst | O(n d) | yes (without budget) | first solution |
| Hall check / min-cut bound | O(2^m n) | O(n) | exact for its claim | bound |
| Hill climbing (steepest) | O(G S + G^2) per step | O(G) | no | local minimum |
| Simulated annealing | O(K S) | O(G) | no | good, not guaranteed |
| Flood model | O(cells) per sub-step | O(cells) | n/a | conserves mass |

V junctions, E road segments, n variables, d domain size, h hidden variables, N samples, m centres, G groups, S centres, K iterations.

## Rapid-fire questions

1. **Why is A\* faster than UCS but just as good?** The admissible heuristic only removes nodes that cannot be on a cheaper path.
2. **Why not just use Google Maps routing?** It assumes the network is fixed and ignores uncertain risk and shelter capacity.
3. **What does the Bayesian network add over reading the water depth?** It anticipates: a heavy rain reading in a low, poorly drained area raises risk before the water arrives, and two noisy gauges are weighed against each other.
4. **What is the single most important result?** Re-planning shelters about 116,000 more people than naive routing in every one of 50 storms.
5. **What would you do with more time?** Model road congestion caused by the evacuees themselves, learn the CPTs from real gauge data, and use incremental search (D\* Lite) for re-planning.
6. **Is everything deterministic?** Yes: every random choice is seeded, so a URL reproduces the exact storm, readings and plans, and rewinding replays identically.
7. **Which libraries did you use?** None for the algorithms. Only Vite and TypeScript to build, Vitest for the small tests, d3-delaunay for the synthetic test city, and self-hosted fonts.
