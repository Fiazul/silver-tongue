// Straight-line walking with blocker slide. Pure maths, no three.js: x/z plane only.
import type { Box2 } from "./layout";

export const WALK_SPEED = 3.2; // m/s
export const PLAYER_RADIUS = 0.28;

const hits = (x: number, z: number, b: Box2, r: number) =>
  x > b.min[0] - r && x < b.max[0] + r && z > b.min[1] - r && z < b.max[1] + r;

export function blocked(x: number, z: number, blockers: Box2[], bounds: Box2, r = PLAYER_RADIUS): boolean {
  if (x < bounds.min[0] || x > bounds.max[0] || z < bounds.min[1] || z > bounds.max[1]) return true;
  return blockers.some((b) => hits(x, z, b, r));
}

/**
 * One step of `dist` metres from (x, z) along the unit direction (dx, dz). Blocked: slide along
 * whichever axis is still free; neither: stay. Returns the new position.
 */
export function step(
  x: number,
  z: number,
  dx: number,
  dz: number,
  dist: number,
  blockers: Box2[],
  bounds: Box2,
): [number, number] {
  const nx = x + dx * dist;
  const nz = z + dz * dist;
  if (!blocked(nx, nz, blockers, bounds)) return [nx, nz];
  if (Math.abs(dx) > 1e-6 && !blocked(nx, z, blockers, bounds)) return [nx, z];
  if (Math.abs(dz) > 1e-6 && !blocked(x, nz, blockers, bounds)) return [x, nz];
  return [x, z];
}
