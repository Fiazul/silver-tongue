// Straight-line walking: the player's disc pushed out of each blocker and sliding along it
// (collision.ts has the shapes). Pure maths, no three.js: x/z plane only.
import { overlaps, pushOut } from "./collision";
import type { Blocker, Box2 } from "./layout";

export const WALK_SPEED = 3.2; // m/s
export const PLAYER_RADIUS = 0.28;
/** the longest single move (m): shorter than any collider is thick once grown by the radius, so nothing is walked through */
const SUBSTEP = 0.05;

/** Where the ground itself lets you stand (the town's walk grid and decks, layout.ts walkable); default: everywhere. */
export type WalkableFn = (x: number, z: number) => boolean;

const inBounds = (x: number, z: number, b: Box2) => x >= b.min[0] && x <= b.max[0] && z >= b.min[1] && z <= b.max[1];

/** Whether a disc of radius `r` can stand at (x, z): inside the bounds, on walkable ground, clear of every blocker's exact shape. */
export function blocked(x: number, z: number, blockers: readonly Blocker[], bounds: Box2, r = PLAYER_RADIUS, walkable?: WalkableFn): boolean {
  if (!inBounds(x, z, bounds)) return true;
  if (walkable && !walkable(x, z)) return true;
  return overlaps(x, z, blockers, r);
}

/** A move to (x, z): kept inside the bounds, pushed clear of the blockers; null where it can't stand. */
function settle(x: number, z: number, blockers: readonly Blocker[], bounds: Box2, walkable?: WalkableFn): [number, number] | null {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const p = pushOut(clamp(x, bounds.min[0], bounds.max[0]), clamp(z, bounds.min[1], bounds.max[1]), blockers, PLAYER_RADIUS);
  if (!p) return null;
  const [px, pz] = p;
  return blocked(px, pz, blockers, bounds, PLAYER_RADIUS, walkable) ? null : [px, pz];
}

/**
 * `dist` metres from (x, z) along the unit direction (dx, dz), in short moves: each one pushed out
 * of whatever it runs into, so the player slides along a surface (round a corner, along a row of
 * pieces) with whatever of the move runs along it. Where the pushed spot can't stand (the edge of
 * the walk grid, the bounds, a corner that won't settle): the move along x alone, else along z
 * alone, else stay. Returns the new position.
 */
export function step(
  x: number,
  z: number,
  dx: number,
  dz: number,
  dist: number,
  blockers: readonly Blocker[],
  bounds: Box2,
  walkable?: WalkableFn,
): [number, number] {
  const n = Math.max(1, Math.ceil(dist / SUBSTEP));
  const d = dist / n;
  let px = x;
  let pz = z;
  for (let k = 0; k < n; k++) {
    const mx = dx * d;
    const mz = dz * d;
    const q =
      settle(px + mx, pz + mz, blockers, bounds, walkable) ??
      (Math.abs(dx) > 1e-6 ? settle(px + mx, pz, blockers, bounds, walkable) : null) ??
      (Math.abs(dz) > 1e-6 ? settle(px, pz + mz, blockers, bounds, walkable) : null);
    if (!q) break;
    // never pushed back past where the move started from (a head-on wall: stay put)
    if ((q[0] - px) * dx + (q[1] - pz) * dz < -1e-9) break;
    [px, pz] = q;
  }
  return [px, pz];
}
