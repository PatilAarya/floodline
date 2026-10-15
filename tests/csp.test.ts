import { describe, expect, it } from 'vitest';
import { solveCSP, type SolveOptions } from '../src/ai/csp/backtracking';
import { capacityNeighbours, isSolution, mapColouring, type CSP } from '../src/ai/csp/model';
import { explainInfeasibility, maximisePartial } from '../src/ai/csp/relax';

/** Every on/off combination of forward checking, MRV, degree and LCV. */
const CONFIGS: SolveOptions[] = [];
for (let k = 0; k < 16; k++) CONFIGS.push({ forwardChecking: !!(k & 1), mrv: !!(k & 2), degree: !!(k & 4), lcv: !!(k & 8) });

const australia = () =>
  mapColouring(
    ['WA', 'NT', 'SA', 'Q', 'NSW', 'V', 'T'],
    [['WA', 'NT'], ['WA', 'SA'], ['NT', 'SA'], ['NT', 'Q'], ['SA', 'Q'], ['SA', 'NSW'], ['SA', 'V'], ['Q', 'NSW'], ['NSW', 'V']],
    ['red', 'green', 'blue'],
  );

describe('CSP', () => {
  it('colours the map of Australia with 3 colours, with every heuristic combination', () => {
    const csp = australia();
    for (const o of CONFIGS) {
      const r = solveCSP(csp, o);
      expect(r.status).toBe('solved');
      expect(isSolution(csp, r.assignment)).toBe(true);
    }
  });

  it('detects that a 4-clique cannot be 3-coloured', () => {
    const k4 = mapColouring(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']], ['1', '2', '3']);
    for (const o of CONFIGS) {
      const r = solveCSP(k4, o);
      expect(r.status).toBe('infeasible');
    }
    // With a fourth colour it becomes solvable.
    expect(solveCSP(mapColouring(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']], ['1', '2', '3', '4']), CONFIGS[15]).status).toBe('solved');
  });

  it('respects capacity, and explains a capacity shortfall without search', () => {
    // Five groups of 30 people, three centres; group 4 can only reach centre 0.
    const domains = [[0, 1, 2], [0, 1], [1, 2], [0, 2], [0]];
    const make = (cap: number[]): CSP => ({ names: ['g0', 'g1', 'g2', 'g3', 'g4'], valueNames: ['c0', 'c1', 'c2'], domains, neighbours: capacityNeighbours(domains), size: [30, 30, 30, 30, 30], capacity: cap });
    const ok = make([60, 60, 30]);
    const r = solveCSP(ok, CONFIGS[15]);
    expect(r.status).toBe('solved');
    expect(isSolution(ok, r.assignment)).toBe(true);
    // 150 people, 140 places: infeasible, and the counting argument says so.
    const tight = make([50, 60, 30]);
    const e = explainInfeasibility(tight);
    expect(e.feasibleByCounting).toBe(false);
    expect(e.capacity).not.toBeNull();
    expect(solveCSP(tight, CONFIGS[0]).status).toBe('infeasible');
    expect(solveCSP(tight, CONFIGS[15]).status).toBe('infeasible');
    // Partial relaxation never beats the min-cut bound.
    const p = maximisePartial(tight);
    expect(p.placed).toBeLessThanOrEqual(p.bound);
    expect(p.placed).toBe(120);
  });

  it('stops on the node budget and returns a partial assignment', () => {
    // 12 variables, 3 colours, all mutually different: infeasible and large for plain backtracking.
    const names = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const borders: [string, string][] = [];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) borders.push([names[i], names[j]]);
    const csp = mapColouring(names, borders, ['a', 'b', 'c']);
    const r = solveCSP(csp, { forwardChecking: false, mrv: false, degree: false, lcv: false, maxNodes: 50 });
    expect(['budget', 'infeasible']).toContain(r.status);
    expect(r.nodes).toBeLessThanOrEqual(50);
  });
});
