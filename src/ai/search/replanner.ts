/**
 * What a car does when the road it is on goes under water.
 *
 * Re-planning itself is just running the search again from the next junction
 * (see src/sim/journey.ts). The one special case is a car part-way along a
 * road that closes: if it is nearly through (at most PUSH_ON_METRES, or
 * PUSH_ON_FRACTION of the road, left) it pushes on slowly, because the water
 * has only just arrived; otherwise it turns back to the junction it came
 * from and re-plans there.
 */

/** Push on through a newly closed road if at most this much of it is left. */
export const PUSH_ON_METRES = 120;
export const PUSH_ON_FRACTION = 0.3;

/** Decide what to do when the road a car is on becomes closed. */
export function midEdgeDecision(position: number, length: number): 'continue' | 'turnBack' {
  const left = length - position;
  return left <= PUSH_ON_METRES || left <= length * PUSH_ON_FRACTION ? 'continue' : 'turnBack';
}
