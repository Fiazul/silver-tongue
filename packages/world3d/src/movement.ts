// Straight-line walking with blocker slide. Pure maths, no three.js: x/z plane only.
import type { Blocker, Box2 } from "./layout";

export const WALK_SPEED = 3.2; // m/s
export const PLAYER_RADIUS = 0.28;
const DEG = Math.PI / 180;

/** Within `r` of a blocker: its box, and for an oriented rect (the town's) the rect itself, in its own frame. */
const hits = (x: number, z: number, b: Blocker, r: number) => {
  if (!(x > b.min[0] - r && x < b.max[0] + r && z > b.min[1] - r && z < b.max[1] + r)) return false;
  const o = b.obb;
  if (!o) return true;
  // world -> the rect's frame (the inverse of layout.ts anchorToWorld's turn)
  const a = o.rotY * DEG;
  const dx = x - o.centre[0];
  const dz = z - o.centre[1];
  const lx = dx * Math.cos(a) - dz * Math.sin(a);
  const lz = dx * Math.sin(a) + dz * Math.cos(a);
  return Math.abs(lx) < o.half[0] + r && Math.abs(lz) < o.half[1] + r;
};

/** Where the ground itself lets you stand (the town's walk grid and decks, layout.ts walkable); default: everywhere. */
export type WalkableFn = (x: number, z: number) => boolean;

export function blocked(x: number, z: number, blockers: Blocker[], bounds: Box2, r = PLAYER_RADIUS, walkable?: WalkableFn): boolean {
  if (x < bounds.min[0] || x > bounds.max[0] || z < bounds.min[1] || z > bounds.max[1]) return true;
  if (walkable && !walkable(x, z)) return true;
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
  blockers: Blocker[],
  bounds: Box2,
  walkable?: WalkableFn,
): [number, number] {
  const nx = x + dx * dist;
  const nz = z + dz * dist;
  const no = (px: number, pz: number) => blocked(px, pz, blockers, bounds, PLAYER_RADIUS, walkable);
  if (!no(nx, nz)) return [nx, nz];
  if (Math.abs(dx) > 1e-6 && !no(nx, z)) return [nx, z];
  if (Math.abs(dz) > 1e-6 && !no(x, nz)) return [x, nz];
  return [x, z];
}
