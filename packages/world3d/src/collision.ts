// Collision: what stops walking is what is drawn. Every static piece's colliders are derived from
// its rendered triangles when a space loads (world.ts SceneSpace.buildStatic), and one resolver
// (a capsule of the player's radius pushed out of each shape, sliding along it) moves the player;
// the "Take me there" path grid (wayview.ts) tests the same shapes at the same radius.
//
// Derivation, per placed piece, in the piece's own frame (turned with it, so boxes stay boxes):
// - each triangle is clipped to the body's slab: from COLLIDE.step above the walking height under
//   it (lower things: floors, rugs, kerbs, steps are walked over) to COLLIDE.head above it (higher
//   things: awnings, roofs, lantern strings, branches, a lamp's arm never block);
// - a low wide platform the piece carries (a pavilion's floor: upward faces at most floorMax high,
//   a body wide, floorArea m² or more) raises the walking height over itself, so its rim and steps
//   don't block (a ring of kerb stones, a bench seat: no floor);
// - foliage (FOLIAGE materials: leaves, willow fronds, lotus pads) never blocks: the trunk, the pot,
//   the bed's stone kerb do;
// - what is left is projected to x/z and rasterised at COLLIDE.cell (edges too: a wall plane is a
//   line), enclosed holes filled (a closed ring is solid; a ring with a gap stays open), split into
//   connected parts; each part becomes its convex hull when the hull adds no more than a sliver
//   beyond COLLIDE.tol, a circle when it is a thin round pole (radius <= COLLIDE.pole), else its
//   cells merged into rectangles (a U of walls, an L-counter).
// Pure maths apart from reading three.js meshes (types only): no scene, no renderer.
import type * as THREE from "three";
import type { Blocker, Box2 } from "./layout";

export type P2 = [number, number];
/** A collider's exact outline in x/z: a circle, or a convex polygon (counter-clockwise in x/z). */
export type Shape = { kind: "circle"; c: P2; r: number } | { kind: "poly"; pts: P2[] };

export const COLLIDE = {
  /** geometry up to this far above the walking height is walked over (m) */
  step: 0.2,
  /** geometry above this over the walking height never blocks (m): head room */
  head: 1.8,
  /** a platform the piece carries: its upward faces at most this high (m) ... */
  floorMax: 0.5,
  /** ... covering at least this much (m²) */
  floorArea: 4,
  /** footprint raster (m) */
  cell: 0.025,
  /** the audit's and the tests' tolerance: collider and footprint agree within this (m) */
  tol: 0.05,
  /** a round part up to this radius (m) becomes a circle */
  pole: 0.45,
} as const;

/** Materials that never block: leaves, canopies, willow fronds, lotus pads (the trunk, stems' pots and kerbs do). */
export const FOLIAGE = /^(leaf_|canopy_|town_willow|town_lotus)/;

// ---------------------------------------------------------------------------------------------
// Shapes

/** The signed area of a polygon in x/z (positive: counter-clockwise). */
export function polyArea(pts: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

const ccw = (pts: P2[]): P2[] => (polyArea(pts) < 0 ? pts.reverse() : pts);

export function shapeArea(s: Shape): number {
  return s.kind === "circle" ? Math.PI * s.r * s.r : Math.abs(polyArea(s.pts));
}

export function shapeBox(s: Shape): Box2 {
  if (s.kind === "circle") return { min: [s.c[0] - s.r, s.c[1] - s.r], max: [s.c[0] + s.r, s.c[1] + s.r] };
  const xs = s.pts.map((p) => p[0]);
  const zs = s.pts.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...zs)], max: [Math.max(...xs), Math.max(...zs)] };
}

/** A blocker for a shape: its box, the shape, whose it is. */
export function shapeBlocker(shape: Shape, owner: string, source: NonNullable<Blocker["source"]>): Blocker {
  return { ...shapeBox(shape), shape, owner, source };
}

const DEG = Math.PI / 180;
const SHAPES = new WeakMap<Blocker, Shape>();

/** A blocker's exact shape: its own, else its oriented rect's (the town's), else its box. */
export function shapeOf(b: Blocker): Shape {
  if (b.shape) return b.shape;
  let s = SHAPES.get(b);
  if (s) return s;
  const o = b.obb;
  if (o) {
    // the rect's frame -> world (the inverse of movement's world -> frame turn)
    const a = o.rotY * DEG;
    const c = Math.cos(a);
    const n = Math.sin(a);
    const w = (lx: number, lz: number): P2 => [o.centre[0] + lx * c + lz * n, o.centre[1] - lx * n + lz * c];
    const [hx, hz] = o.half;
    s = { kind: "poly", pts: ccw([w(-hx, -hz), w(hx, -hz), w(hx, hz), w(-hx, hz)]) };
  } else {
    s = { kind: "poly", pts: ccw([[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]]]) };
  }
  SHAPES.set(b, s);
  return s;
}

/** Signed distance from (x, z) to a shape's outline (< 0 inside) and the outward direction there. */
export interface Sd {
  d: number;
  nx: number;
  nz: number;
}

export function sdShape(s: Shape, x: number, z: number, out: Sd = { d: 0, nx: 0, nz: 0 }): Sd {
  if (s.kind === "circle") {
    const dx = x - s.c[0];
    const dz = z - s.c[1];
    const l = Math.hypot(dx, dz);
    out.d = l - s.r;
    if (l > 1e-9) (out.nx = dx / l), (out.nz = dz / l);
    else (out.nx = 1), (out.nz = 0);
    return out;
  }
  const p = s.pts;
  let plane = -Infinity;
  let pnx = 1;
  let pnz = 0;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ax = p[j][0];
    const az = p[j][1];
    const ex = p[i][0] - ax;
    const ez = p[i][1] - az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-18) continue;
    const len = Math.sqrt(len2);
    // counter-clockwise: the outward normal is the edge turned clockwise
    const nx = ez / len;
    const nz = -ex / len;
    const h = (x - ax) * nx + (z - az) * nz;
    if (h > plane) (plane = h), (pnx = nx), (pnz = nz);
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
    const qx = ax + ex * t;
    const qz = az + ez * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) (best = d), (bx = qx), (bz = qz);
  }
  if (plane <= 0 || best < 1e-9) {
    out.d = plane <= 0 ? plane : 0;
    out.nx = pnx;
    out.nz = pnz;
  } else {
    out.d = best;
    out.nx = (x - bx) / best;
    out.nz = (z - bz) / best;
  }
  return out;
}

const near = (b: Box2, x: number, z: number, r: number) => x > b.min[0] - r && x < b.max[0] + r && z > b.min[1] - r && z < b.max[1] + r;

/** Whether a disc of radius `r` at (x, z) overlaps any blocker. */
export function overlaps(x: number, z: number, blockers: readonly Blocker[], r: number): boolean {
  const sd: Sd = { d: 0, nx: 0, nz: 0 };
  for (const b of blockers) if (near(b, x, z, r) && sdShape(shapeOf(b), x, z, sd).d < r - 1e-9) return true;
  return false;
}

/** The blockers overlapping a disc of radius `r` at (x, z). */
export function overlapping(x: number, z: number, blockers: readonly Blocker[], r: number): Blocker[] {
  const sd: Sd = { d: 0, nx: 0, nz: 0 };
  return blockers.filter((b) => near(b, x, z, r) && sdShape(shapeOf(b), x, z, sd).d < r - 1e-9);
}

/**
 * The disc of radius `r` at (x, z) pushed out of every blocker it overlaps (deepest first, a few
 * rounds: a corner between two pieces settles); null if it can't get clear.
 */
export function pushOut(x: number, z: number, blockers: readonly Blocker[], r: number, rounds = 8): P2 | null {
  const sd: Sd = { d: 0, nx: 0, nz: 0 };
  for (let k = 0; k < rounds; k++) {
    let pen = 0;
    let nx = 0;
    let nz = 0;
    for (const b of blockers) {
      if (!near(b, x, z, r)) continue;
      sdShape(shapeOf(b), x, z, sd);
      const p = r - sd.d;
      if (p > pen) (pen = p), (nx = sd.nx), (nz = sd.nz);
    }
    if (pen <= 1e-9) return [x, z];
    x += nx * (pen + 1e-6);
    z += nz * (pen + 1e-6);
  }
  return overlaps(x, z, blockers, r) ? null : [x, z];
}

/** A bucket grid over blockers (the path grid asks it a few hundred thousand times). */
export class BlockerIndex {
  private buckets = new Map<number, Blocker[]>();
  constructor(
    readonly blockers: readonly Blocker[],
    private size = 2,
  ) {
    for (const b of blockers) {
      const [i0, j0] = this.key(b.min[0], b.min[1]);
      const [i1, j1] = this.key(b.max[0], b.max[1]);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = this.hash(i, j);
          const list = this.buckets.get(k);
          if (list) list.push(b);
          else this.buckets.set(k, [b]);
        }
    }
  }
  private key(x: number, z: number): P2 {
    return [Math.floor(x / this.size), Math.floor(z / this.size)];
  }
  private hash(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  /** The blockers that can be within `r` of (x, z). */
  near(x: number, z: number, r: number): Blocker[] {
    const [i0, j0] = this.key(x - r, z - r);
    const [i1, j1] = this.key(x + r, z + r);
    if (i0 === i1 && j0 === j1) return this.buckets.get(this.hash(i0, j0)) ?? [];
    const out = new Set<Blocker>();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const b of this.buckets.get(this.hash(i, j)) ?? []) out.add(b);
    return [...out];
  }
}

// ---------------------------------------------------------------------------------------------
// Footprints: a piece's cells in its own frame

/** A raster in a piece's frame: local = world - origin turned by -rotY (layout.ts anchorToWorld's inverse). */
export interface Frame {
  ox: number;
  oz: number;
  /** cos / sin of the piece's rotY */
  c: number;
  s: number;
}

export interface Raster {
  frame: Frame;
  /** the cell [x0 + i*cell, +cell] x [z0 + j*cell, +cell], local */
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  cells: Uint8Array;
}

export const frameOf = (origin: P2, rotY: number): Frame => ({ ox: origin[0], oz: origin[1], c: Math.cos(rotY * DEG), s: Math.sin(rotY * DEG) });
const toLocal = (f: Frame, x: number, z: number): P2 => {
  const dx = x - f.ox;
  const dz = z - f.oz;
  return [dx * f.c - dz * f.s, dx * f.s + dz * f.c];
};
const toWorld = (f: Frame, lx: number, lz: number): P2 => [f.ox + lx * f.c + lz * f.s, f.oz - lx * f.s + lz * f.c];

function raster(frame: Frame, min: P2, max: P2, cell: number, pad = 3): Raster {
  const x0 = Math.floor(min[0] / cell - pad) * cell;
  const z0 = Math.floor(min[1] / cell - pad) * cell;
  const cols = Math.ceil((max[0] - x0) / cell + pad);
  const rows = Math.ceil((max[1] - z0) / cell + pad);
  return { frame, x0, z0, cell, cols, rows, cells: new Uint8Array(cols * rows) };
}

/** Marks a convex polygon (local x/z) in the raster: cells whose centre is inside, and every cell an edge crosses. Returns one marked cell, or -1. */
function markPoly(r: Raster, pts: P2[], visit: (k: number) => void = (k) => (r.cells[k] = 1)): number {
  const { x0, z0, cell, cols, rows } = r;
  let first = -1;
  const mark = (x: number, z: number) => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return;
    const k = j * cols + i;
    visit(k);
    if (first < 0) first = k;
  };
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [px, pz] = pts[b];
    const [qx, qz] = pts[a];
    const n = Math.max(1, Math.ceil((Math.hypot(qx - px, qz - pz) / cell) * 2));
    for (let t = 0; t <= n; t++) mark(px + ((qx - px) * t) / n, pz + ((qz - pz) * t) / n);
  }
  if (pts.length >= 3 && Math.abs(polyArea(pts)) > cell * cell * 0.25) {
    const p = polyArea(pts) < 0 ? [...pts].reverse() : pts;
    let lx = Infinity, lz = Infinity, hx = -Infinity, hz = -Infinity;
    for (const [x, z] of p) (lx = Math.min(lx, x)), (lz = Math.min(lz, z)), (hx = Math.max(hx, x)), (hz = Math.max(hz, z));
    const i0 = Math.max(0, Math.floor((lx - x0) / cell));
    const i1 = Math.min(cols - 1, Math.floor((hx - x0) / cell));
    const j0 = Math.max(0, Math.floor((lz - z0) / cell));
    const j1 = Math.min(rows - 1, Math.floor((hz - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      // the convex polygon's span along this row's centre line
      const cz = z0 + (j + 0.5) * cell;
      let a = Infinity;
      let b = -Infinity;
      for (let e = 0, f = p.length - 1; e < p.length; f = e++) {
        const [px, pz] = p[f];
        const [qx, qz] = p[e];
        if ((pz <= cz && qz >= cz) || (qz <= cz && pz >= cz)) {
          if (Math.abs(qz - pz) < 1e-12) (a = Math.min(a, px, qx)), (b = Math.max(b, px, qx));
          else {
            const x = px + ((cz - pz) / (qz - pz)) * (qx - px);
            (a = Math.min(a, x)), (b = Math.max(b, x));
          }
        }
      }
      if (a > b) continue;
      for (let i = Math.max(i0, Math.ceil((a - x0) / cell - 0.5)); i <= Math.min(i1, Math.floor((b - x0) / cell - 0.5)); i++) {
        const k = j * cols + i;
        visit(k);
        if (first < 0) first = k;
      }
    }
  }
  return first;
}

/** Fills every empty region the border can't reach (4-connected), in place. */
function fillHoles(r: Raster) {
  const { cols, rows, cells } = r;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (k: number) => {
    if (!cells[k] && !seen[k]) (seen[k] = 1), stack.push(k);
  };
  for (let i = 0; i < cols; i++) push(i), push((rows - 1) * cols + i);
  for (let j = 0; j < rows; j++) push(j * cols), push(j * cols + cols - 1);
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % cols;
    const j = (k - i) / cols;
    if (i > 0) push(k - 1);
    if (i < cols - 1) push(k + 1);
    if (j > 0) push(k - cols);
    if (j < rows - 1) push(k + cols);
  }
  for (let k = 0; k < cells.length; k++) if (!cells[k] && !seen[k]) cells[k] = 1;
}

/** 8-connected parts: a label per cell (0: empty), and how many. */
function label(r: Raster): { labels: Int32Array; count: number } {
  const { cols, rows, cells } = r;
  const labels = new Int32Array(cols * rows);
  let count = 0;
  const stack: number[] = [];
  for (let k0 = 0; k0 < cells.length; k0++) {
    if (!cells[k0] || labels[k0]) continue;
    labels[k0] = ++count;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % cols;
      const j = (k - i) / cols;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const n = nj * cols + ni;
          if (cells[n] && !labels[n]) (labels[n] = count), stack.push(n);
        }
    }
  }
  return { labels, count };
}

/** Cells within `k` cells (a disc) of a marked one. */
function dilate(r: Raster, k: number): Uint8Array {
  const { cols, rows, cells } = r;
  const out = new Uint8Array(cells.length);
  const offs: P2[] = [];
  for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) if (di * di + dj * dj <= k * k) offs.push([di, dj]);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!cells[j * cols + i]) continue;
      for (const [di, dj] of offs) {
        const ni = i + di;
        const nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < cols && nj < rows) out[nj * cols + ni] = 1;
      }
    }
  return out;
}

/** Andrew's monotone chain: the convex hull, counter-clockwise, collinear points dropped. */
export function hull(points: P2[]): P2[] {
  // snapped to 0.1 µm and deduplicated: float noise (-1.0000000000000004 vs -1) never reorders a corner away
  const seen = new Set<string>();
  const p: P2[] = [];
  for (const [x, z] of points) {
    const q: P2 = [Math.round(x * 1e7) / 1e7, Math.round(z * 1e7) / 1e7];
    const k = `${q[0]},${q[1]}`;
    if (!seen.has(k)) seen.add(k), p.push(q);
  }
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drops hull vertices within `eps` of the chord past them (keeps the hull containing the points to eps). */
function simplifyHull(h: P2[], eps: number): P2[] {
  let pts = h;
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const ex = c[0] - a[0];
      const ez = c[1] - a[1];
      const len = Math.hypot(ex, ez);
      if (len < 1e-9 || Math.abs((b[0] - a[0]) * ez - (b[1] - a[1]) * ex) / len < eps) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
      }
    }
  }
  return pts;
}

/** Merges a part's cells into rectangles (rows first, then down): local [x0, z0, x1, z1] each. */
function rects(r: Raster, labels: Int32Array, id: number): [number, number, number, number][] {
  const { cols, rows, x0, z0, cell } = r;
  const used = new Uint8Array(cols * rows);
  const out: [number, number, number, number][] = [];
  const free = (i: number, j: number) => labels[j * cols + i] === id && !used[j * cols + i];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!free(i, j)) continue;
      let i1 = i;
      while (i1 + 1 < cols && free(i1 + 1, j)) i1++;
      let j1 = j;
      for (;;) {
        if (j1 + 1 >= rows) break;
        let full = true;
        for (let q = i; q <= i1 && full; q++) full = free(q, j1 + 1);
        if (!full) break;
        j1++;
      }
      for (let jj = j; jj <= j1; jj++) for (let ii = i; ii <= i1; ii++) used[jj * cols + ii] = 1;
      out.push([x0 + i * cell, z0 + j * cell, x0 + (i1 + 1) * cell, z0 + (j1 + 1) * cell]);
    }
  return out;
}

/**
 * A connected part's shapes, local: its convex hull (from `exact`, the clipped triangles' corners,
 * else its cells' centres) when that adds no cell more than COLLIDE.tol from the part (a thin
 * round one: the circle round it); else the part cut in two across its longer side, each half
 * fitted the same way (a U of walls: three boxes); a few cells, or cut deep enough: rectangles.
 */
function fitPart(r: Raster, cells: number[], exact?: P2[]): Shape[] {
  const { cols, x0, z0, cell } = r;
  const tolCells = Math.round(COLLIDE.tol / cell);
  // the part's own raster (padded by the tolerance): cells, and cells near one
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (const k of cells) {
    const i = k % cols;
    const j = (k - i) / cols;
    (i0 = Math.min(i0, i)), (j0 = Math.min(j0, j)), (i1 = Math.max(i1, i)), (j1 = Math.max(j1, j));
  }
  const pad = tolCells + 1;
  const sub: Raster = { frame: r.frame, x0: x0 + (i0 - pad) * cell, z0: z0 + (j0 - pad) * cell, cell, cols: i1 - i0 + 1 + 2 * pad, rows: j1 - j0 + 1 + 2 * pad, cells: new Uint8Array(0) };
  sub.cells = new Uint8Array(sub.cols * sub.rows);
  const subOf = (k: number) => ((k - (k % cols)) / cols - j0 + pad) * sub.cols + ((k % cols) - i0 + pad);
  for (const k of cells) sub.cells[subOf(k)] = 1;
  const near1 = dilate(sub, tolCells);
  const cornersOf = (q: number): P2[] => {
    const x = sub.x0 + (q % sub.cols) * cell;
    const z = sub.z0 + Math.floor(q / sub.cols) * cell;
    return [[x, z], [x + cell, z], [x + cell, z + cell], [x, z + cell]];
  };
  /** the hull's cells more than tol from the part */
  const extra = (h: P2[]) => {
    let lx = Infinity, lz = Infinity, hx = -Infinity, hz = -Infinity;
    for (const [x, z] of h) (lx = Math.min(lx, x)), (lz = Math.min(lz, z)), (hx = Math.max(hx, x)), (hz = Math.max(hz, z));
    let n = 0;
    for (let j = Math.max(0, Math.floor((lz - sub.z0) / cell)); j <= Math.min(sub.rows - 1, Math.floor((hz - sub.z0) / cell)); j++) {
      // the convex hull's span along this row's centre line
      const cz = sub.z0 + (j + 0.5) * cell;
      let a = Infinity, b = -Infinity;
      for (let e = 0, f = h.length - 1; e < h.length; f = e++) {
        const [px, pz] = h[f];
        const [qx, qz] = h[e];
        if ((pz <= cz && qz >= cz) || (qz <= cz && pz >= cz)) {
          const x = Math.abs(qz - pz) < 1e-12 ? Math.min(px, qx) : px + ((cz - pz) / (qz - pz)) * (qx - px);
          const x2 = Math.abs(qz - pz) < 1e-12 ? Math.max(px, qx) : x;
          (a = Math.min(a, x)), (b = Math.max(b, x2));
        }
      }
      if (a > b) continue;
      for (let i = Math.max(0, Math.ceil((a - sub.x0) / cell - 0.5)); i <= Math.min(sub.cols - 1, Math.floor((b - sub.x0) / cell - 0.5)); i++) if (!near1[j * sub.cols + i]) n++;
    }
    // outside the part's raster: all of it beyond tol (a hull reaching past the pad)
    return n + (lx < sub.x0 || lz < sub.z0 || hx > sub.x0 + sub.cols * cell || hz > sub.z0 + sub.rows * cell ? 1e9 : 0);
  };
  const boxes = (qs: number[]): Shape[] => {
    const lab = new Int32Array(sub.cells.length);
    for (const q of qs) lab[q] = 1;
    return rects(sub, lab, 1).map(([a, b, c, d]): Shape => ({ kind: "poly", pts: [[a, b], [c, b], [c, d], [a, d]] }));
  };
  const out: Shape[] = [];
  /** the cells of a set with a 4-neighbour outside it: the hull needs no others */
  const stamp = new Int32Array(sub.cells.length);
  let mark = 0;
  const edgeCells = (qs: number[]) => {
    mark++;
    for (const q of qs) stamp[q] = mark;
    const w = sub.cols;
    return qs.filter((q) => stamp[q - 1] !== mark || stamp[q + 1] !== mark || stamp[q - w] !== mark || stamp[q + w] !== mark);
  };
  const fit = (qs: number[], pts: P2[] | undefined, depth: number) => {
    // a cut piece: its edge cells' corners (the hull covers every cell it holds, so no seam opens between the halves)
    let h = hull(pts && pts.length >= 3 ? pts : edgeCells(qs).flatMap((q) => cornersOf(q)));
    if (h.length >= 3) h = simplifyHull(h, 0.003);
    if (h.length >= 3 && Math.abs(polyArea(h)) > 1e-8 && extra(h) <= 4) {
      out.push(roundOrPoly(h));
      return;
    }
    if (h.length < 3 || qs.length <= 12 || depth >= 8) {
      out.push(...boxes(qs));
      return;
    }
    // cut across the longer side of its box, at the middle
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const q of qs) {
      const i = q % sub.cols;
      const j = (q - i) / sub.cols;
      (a = Math.min(a, i)), (b = Math.min(b, j)), (c = Math.max(c, i)), (d = Math.max(d, j));
    }
    const alongI = c - a >= d - b;
    const mid = alongI ? (a + c + 1) / 2 : (b + d + 1) / 2;
    const lo: number[] = [];
    const hi: number[] = [];
    for (const q of qs) ((alongI ? q % sub.cols : Math.floor(q / sub.cols)) < mid ? lo : hi).push(q);
    if (!lo.length || !hi.length) return void out.push(...boxes(qs));
    fit(lo, undefined, depth + 1);
    fit(hi, undefined, depth + 1);
  };
  fit(cells.map(subOf), exact, 0);
  return out;
}

/** A convex hull as a circle when it is a thin round part (a pole, a post, a trunk), else itself. */
function roundOrPoly(h: P2[]): Shape {
  const A = polyArea(h);
  let cx = 0, cz = 0;
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
    const f = h[j][0] * h[i][1] - h[i][0] * h[j][1];
    cx += (h[j][0] + h[i][0]) * f;
    cz += (h[j][1] + h[i][1]) * f;
  }
  cx /= 6 * A;
  cz /= 6 * A;
  const R = Math.max(...h.map(([x, z]) => Math.hypot(x - cx, z - cz)));
  return R <= COLLIDE.pole && Math.PI * R * R <= 1.2 * Math.abs(A) ? { kind: "circle", c: [cx, cz], r: R } : { kind: "poly", pts: h };
}

// ---------------------------------------------------------------------------------------------
// Derivation

/** A placed static piece to derive colliders from. */
export interface Part {
  owner: string;
  asset?: string;
  /** placed in the scene (its world matrices are refreshed here) */
  object: THREE.Object3D;
  /** the piece's frame: its position and turn (deg) */
  origin: P2;
  rotY: number;
  /** its feet height (the placement's y) */
  y?: number;
  /** meshes that never block (besides outline hulls and FOLIAGE materials) */
  skip?: (mesh: THREE.Mesh) => boolean;
  /**
   * what makes two placements the same shape in their own frames (asset, scale, tilt): on flat
   * ground, a second placement with the same key reuses the first's derivation, turned and moved
   */
  key?: string;
}

/** Derivations by shape key (Part.key + the ground's height under it), in the piece's own frame. */
export type DeriveCache = Map<string, { colliders: Shape[]; footprint: Raster | null }>;

const shapeFrame = (s: Shape, f: (x: number, z: number) => P2): Shape => (s.kind === "circle" ? { kind: "circle", c: f(s.c[0], s.c[1]), r: s.r } : { kind: "poly", pts: ccw(s.pts.map(([x, z]) => f(x, z))) });

/** The ground's height under a box when it is flat there (every 0.25 m within 1 mm), else null. */
function flatGround(ground: GroundFn, min: P2, max: P2): number | null {
  const g0 = ground(min[0], min[1]);
  const nx = Math.max(1, Math.ceil((max[0] - min[0]) / 0.25));
  const nz = Math.max(1, Math.ceil((max[1] - min[1]) / 0.25));
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) if (Math.abs(ground(min[0] + ((max[0] - min[0]) * i) / nx, min[1] + ((max[1] - min[1]) * j) / nz) - g0) > 1e-3) return null;
  return g0;
}

export interface Derived {
  owner: string;
  asset?: string;
  colliders: Blocker[];
  /** the piece's real footprint (its body's slab, holes filled), null when nothing of it blocks */
  footprint: Raster | null;
}

const materialName = (m: THREE.Material | THREE.Material[], group?: number) => (Array.isArray(m) ? (m[group ?? 0]?.name ?? "") : m.name);

/** Every blocking triangle of the part, world x, y, z per corner (9 numbers each). */
function triangles(part: Part): number[] {
  const out: number[] = [];
  part.object.updateWorldMatrix(true, true);
  part.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.outline || (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || part.skip?.(mesh)) return;
    const soup = meshSoup(mesh);
    const e = mesh.matrixWorld.elements;
    for (let q = 0; q < soup.length; q += 3) {
      const x = soup[q];
      const y = soup[q + 1];
      const z = soup[q + 2];
      out.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
  });
  return out;
}

/** A mesh's blocking triangles in its own space (x, y, z per corner), read once per geometry (instances share it). */
const SOUPS = new WeakMap<THREE.BufferGeometry, { material: string; soup: Float32Array }>();
function meshSoup(mesh: THREE.Mesh): Float32Array {
  const geo = mesh.geometry;
  const names = Array.isArray(mesh.material) ? mesh.material.map((m) => m.name).join("|") : mesh.material.name;
  const hit = SOUPS.get(geo);
  if (hit && hit.material === names) return hit.soup;
  const pos = geo.attributes.position;
  const out: number[] = [];
  if (pos) {
    const index = geo.index;
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    for (const g of groups) {
      if (FOLIAGE.test(materialName(mesh.material, g.materialIndex))) continue;
      const end = Math.min(g.start + g.count, index ? index.count : pos.count);
      for (let t = g.start; t + 2 < end; t += 3)
        for (let v = 0; v < 3; v++) {
          const k = index ? index.getX(t + v) : t + v;
          out.push(pos.getX(k), pos.getY(k), pos.getZ(k));
        }
    }
  }
  const soup = new Float32Array(out);
  SOUPS.set(geo, { material: names, soup });
  return soup;
}

/** Clips a polygon (x, y, z per point) to lo <= y <= hi (Sutherland-Hodgman). */
function clipSlab(poly: number[][], lo: number, hi: number): number[][] {
  const clip = (pts: number[][], keep: (y: number) => boolean, at: number) => {
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = keep(a[1]);
      const ib = keep(b[1]);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (at - a[1]) / (b[1] - a[1]);
        out.push([a[0] + (b[0] - a[0]) * t, at, a[2] + (b[2] - a[2]) * t]);
      }
    }
    return out;
  };
  return clip(clip(poly, (y) => y >= lo, lo), (y) => y <= hi, hi);
}

/** Walking height under a point: the space's (layout.ts heightAt). */
export type GroundFn = (x: number, z: number) => number;

/** A piece's colliders and real footprint from its triangles (see the file comment). */
export function derive(part: Part, ground: GroundFn, cache?: DeriveCache): Derived {
  const tris = triangles(part);
  const frame = frameOf(part.origin, part.rotY);
  const none: Derived = { owner: part.owner, asset: part.asset, colliders: [], footprint: null };
  if (!tris.length) return none;
  let key: string | null = null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let q = 0; q < tris.length; q += 3) (x0 = Math.min(x0, tris[q])), (z0 = Math.min(z0, tris[q + 2])), (x1 = Math.max(x1, tris[q])), (z1 = Math.max(z1, tris[q + 2]));
  const g = flatGround(ground, [x0, z0], [x1, z1]);
  if (cache && part.key) {
    if (g !== null) {
      key = `${part.key}|${(g - (part.y ?? 0)).toFixed(3)}`;
      const hit = cache.get(key);
      if (hit)
        return {
          owner: part.owner,
          asset: part.asset,
          colliders: hit.colliders.map((s) => shapeBlocker(shapeFrame(s, (x, z) => toWorld(frame, x, z)), part.owner, "geometry")),
          footprint: hit.footprint && { ...hit.footprint, frame },
        };
    }
  }
  // flat under it: one height; else each corner's own (asked once per corner: triangles share them)
  const memo = new Map<number, number>();
  const under: GroundFn =
    g !== null
      ? () => g
      : (x, z) => {
          const k = Math.round(x * 200) * 1e6 + Math.round(z * 200);
          let h = memo.get(k);
          if (h === undefined) memo.set(k, (h = ground(x, z)));
          return h;
        };
  const out = deriveFresh(part, under, tris, frame);
  if (key) cache!.set(key, { colliders: out.colliders.map((b) => shapeFrame(b.shape!, (x, z) => toLocal(frame, x, z))), footprint: out.footprint });
  return out;
}

function deriveFresh(part: Part, ground: GroundFn, tris: number[], frame: Frame): Derived {
  const none: Derived = { owner: part.owner, asset: part.asset, colliders: [], footprint: null };
  // nothing of it reaches the body's slab (a plaza, a rug, a deck): nothing to do
  let reaches = false;
  for (let q = 0; q < tris.length && !reaches; q += 9) {
    const g = ground(tris[q], tris[q + 2]);
    const top = Math.max(tris[q + 1], tris[q + 4], tris[q + 7]);
    reaches = top >= g + COLLIDE.step && Math.min(tris[q + 1], tris[q + 4], tris[q + 7]) <= g + COLLIDE.head + COLLIDE.floorMax;
  }
  if (!reaches) return none;
  const n = tris.length / 9;
  const local: number[] = new Array(n * 6);
  const lmin: P2 = [Infinity, Infinity];
  const lmax: P2 = [-Infinity, -Infinity];
  for (let t = 0; t < n; t++)
    for (let v = 0; v < 3; v++) {
      const q = t * 9 + v * 3;
      const dx = tris[q] - frame.ox;
      const dz = tris[q + 2] - frame.oz;
      const lx = dx * frame.c - dz * frame.s;
      const lz = dx * frame.s + dz * frame.c;
      local[t * 6 + v * 2] = lx;
      local[t * 6 + v * 2 + 1] = lz;
      if (lx < lmin[0]) lmin[0] = lx;
      if (lz < lmin[1]) lmin[1] = lz;
      if (lx > lmax[0]) lmax[0] = lx;
      if (lz > lmax[1]) lmax[1] = lz;
    }
  const groundOf = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const q = t * 9;
    let g = ground((tris[q] + tris[q + 3] + tris[q + 6]) / 3, (tris[q + 2] + tris[q + 5] + tris[q + 8]) / 3);
    for (let v = 0; v < 3; v++) g = Math.max(g, ground(tris[q + v * 3], tris[q + v * 3 + 2]));
    groundOf[t] = g;
  }

  // A platform the piece carries: its upward faces low over the ground, wide enough to stand on.
  const FC = 0.1;
  const floor = raster(frame, lmin, lmax, FC, 2);
  const floorTop = new Float32Array(floor.cells.length).fill(-Infinity);
  for (let t = 0; t < n; t++) {
    const q = t * 9;
    const ux = tris[q + 3] - tris[q], uy = tris[q + 4] - tris[q + 1], uz = tris[q + 5] - tris[q + 2];
    const vx = tris[q + 6] - tris[q], vy = tris[q + 7] - tris[q + 1], vz = tris[q + 8] - tris[q + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-12 || Math.abs(cy) / len < 0.9) continue;
    const top = Math.max(tris[q + 1], tris[q + 4], tris[q + 7]);
    if (top - groundOf[t] > COLLIDE.floorMax) continue;
    const pts: P2[] = [0, 1, 2].map((v) => [local[t * 6 + v * 2], local[t * 6 + v * 2 + 1]]);
    markPoly(floor, pts, (k) => (floorTop[k] = Math.max(floorTop[k], top)));
  }
  for (let k = 0; k < floor.cells.length; k++) if (floorTop[k] > -Infinity) floor.cells[k] = 1;
  // only what a body can stand on: the upward faces opened by the player's reach (a floor keeps its
  // middle; a ring of kerb stones or a bench's seat, narrower than a body, drops out)
  const reachCells = Math.round(0.3 / FC);
  const inside: Raster = { ...floor, cells: floor.cells.map((v) => (v ? 0 : 1)) };
  const eroded = dilate(inside, reachCells).map((v, k) => (v || !floor.cells[k] ? 0 : 1));
  const opened = dilate({ ...floor, cells: eroded }, reachCells);
  for (let k = 0; k < floor.cells.length; k++) floor.cells[k] = floor.cells[k] && opened[k] ? 1 : 0;
  const fl = label(floor);
  const sizes = new Float64Array(fl.count + 1);
  for (let k = 0; k < fl.labels.length; k++) sizes[fl.labels[k]] += FC * FC;
  let anyFloor = false;
  for (let k = 0; k < fl.labels.length; k++) {
    if (fl.labels[k] && sizes[fl.labels[k]] >= COLLIDE.floorArea) anyFloor = true;
    else floorTop[k] = -Infinity;
  }
  /** the platform's top at a local point (a cell's reach round it), else -Infinity */
  const platformAt = (lx: number, lz: number) => {
    const i = Math.floor((lx - floor.x0) / FC);
    const j = Math.floor((lz - floor.z0) / FC);
    let h = -Infinity;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < floor.cols && jj < floor.rows) h = Math.max(h, floorTop[jj * floor.cols + ii]);
      }
    return h;
  };

  // The body: each triangle within its slab, projected.
  const polys: P2[][] = [];
  for (let t = 0; t < n; t++) {
    const q = t * 9;
    let g = groundOf[t];
    if (anyFloor) for (let v = 0; v < 3; v++) g = Math.max(g, platformAt(local[t * 6 + v * 2], local[t * 6 + v * 2 + 1]));
    const lo = g + COLLIDE.step;
    const hi = g + COLLIDE.head;
    const ys = [tris[q + 1], tris[q + 4], tris[q + 7]];
    if (Math.max(...ys) < lo || Math.min(...ys) > hi) continue;
    const clipped = clipSlab(
      [0, 1, 2].map((v) => [local[t * 6 + v * 2], ys[v], local[t * 6 + v * 2 + 1]]),
      lo,
      hi,
    );
    if (clipped.length) polys.push(clipped.map((p) => [p[0], p[2]] as P2));
  }
  if (!polys.length) return none;
  let bmin: P2 = [Infinity, Infinity];
  let bmax: P2 = [-Infinity, -Infinity];
  for (const p of polys) for (const [x, z] of p) (bmin = [Math.min(bmin[0], x), Math.min(bmin[1], z)]), (bmax = [Math.max(bmax[0], x), Math.max(bmax[1], z)]);
  const r = raster(frame, bmin, bmax, COLLIDE.cell);
  const firsts = polys.map((p) => markPoly(r, p));
  fillHoles(r);
  const { labels, count } = label(r);
  const pointsOf: P2[][] = Array.from({ length: count + 1 }, () => []);
  polys.forEach((p, i) => {
    if (firsts[i] >= 0) pointsOf[labels[firsts[i]]].push(...p);
  });
  const colliders: Blocker[] = [];
  const world = (pts: P2[]): P2[] => ccw(pts.map(([x, z]) => toWorld(frame, x, z)));
  const cellsOf: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let k = 0; k < labels.length; k++) if (labels[k]) cellsOf[labels[k]].push(k);
  for (let id = 1; id <= count; id++) {
    for (const s of fitPart(r, cellsOf[id], pointsOf[id]))
      colliders.push(shapeBlocker(s.kind === "circle" ? { kind: "circle", c: toWorld(frame, s.c[0], s.c[1]), r: s.r } : { kind: "poly", pts: world(s.pts) }, part.owner, "geometry"));
  }
  const footprint: Raster = { ...r, cells: new Uint8Array(labels.length) };
  for (let k = 0; k < labels.length; k++) footprint.cells[k] = labels[k] ? 1 : 0;
  return { owner: part.owner, asset: part.asset, colliders, footprint };
}

// ---------------------------------------------------------------------------------------------
// Measuring: a collider set against a footprint

export interface Mismatch {
  /** the real footprint (m²) */
  footprint: number;
  /** what the colliders cover (m²) */
  collider: number;
  /** collider more than tol from the footprint: an invisible wall (m²) */
  over: number;
  /** footprint more than tol from any collider: walking into what is drawn (m²) */
  under: number;
}

/** How far a set of colliders is from a piece's footprint (either may be missing), at `tol`. */
export function mismatch(footprint: Raster | null, colliders: readonly Blocker[], origin: P2 = [0, 0], rotY = 0, tol = COLLIDE.tol): Mismatch {
  const frame = footprint?.frame ?? frameOf(origin, rotY);
  const cell = footprint?.cell ?? COLLIDE.cell;
  let lmin: P2 = [Infinity, Infinity];
  let lmax: P2 = [-Infinity, -Infinity];
  const grow = (x: number, z: number) => ((lmin = [Math.min(lmin[0], x), Math.min(lmin[1], z)]), (lmax = [Math.max(lmax[0], x), Math.max(lmax[1], z)]));
  if (footprint) grow(footprint.x0, footprint.z0), grow(footprint.x0 + footprint.cols * cell, footprint.z0 + footprint.rows * cell);
  for (const b of colliders) {
    const s = shapeOf(b);
    const pts: P2[] = s.kind === "circle" ? [[s.c[0] - s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] + s.r], [s.c[0] - s.r, s.c[1] + s.r]] : s.pts;
    for (const [x, z] of pts) grow(...toLocal(frame, x, z));
  }
  if (lmin[0] === Infinity) return { footprint: 0, collider: 0, over: 0, under: 0 };
  const f = raster(frame, lmin, lmax, cell, 4);
  const c: Raster = { ...f, cells: new Uint8Array(f.cells.length) };
  /** every cell the colliders touch (the footprint marks every cell an edge crosses): under-blocking is measured against it */
  const touch: Raster = { ...f, cells: new Uint8Array(f.cells.length) };
  if (footprint)
    for (let j = 0; j < footprint.rows; j++)
      for (let i = 0; i < footprint.cols; i++) {
        if (!footprint.cells[j * footprint.cols + i]) continue;
        const ii = Math.round((footprint.x0 - f.x0) / cell) + i;
        const jj = Math.round((footprint.z0 - f.z0) / cell) + j;
        f.cells[jj * f.cols + ii] = 1;
      }
  const sd: Sd = { d: 0, nx: 0, nz: 0 };
  const shapes = colliders.map(shapeOf);
  for (let j = 0; j < f.rows; j++)
    for (let i = 0; i < f.cols; i++) {
      const [x, z] = toWorld(frame, f.x0 + (i + 0.5) * cell, f.z0 + (j + 0.5) * cell);
      for (const s of shapes) {
        const d = sdShape(s, x, z, sd).d;
        if (d <= cell * Math.SQRT1_2) touch.cells[j * f.cols + i] = 1;
        if (d <= 0) {
          c.cells[j * f.cols + i] = 1;
          break;
        }
      }
    }
  const k = Math.round(tol / cell);
  const fn = dilate(f, k);
  const cn = dilate(touch, k);
  const a = cell * cell;
  const out: Mismatch = { footprint: 0, collider: 0, over: 0, under: 0 };
  for (let q = 0; q < f.cells.length; q++) {
    if (f.cells[q]) out.footprint += a;
    if (c.cells[q]) out.collider += a;
    if (c.cells[q] && !fn[q]) out.over += a;
    if (f.cells[q] && !cn[q]) out.under += a;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A space's blockers

/** Whose an authored blocker is: the placement id before its ":" (town.json `tea_house:body`). */
export const authoredOwner = (b: Blocker): string => b.owner ?? (b.obb?.id ?? "").split(":")[0];

/**
 * A space's blockers: every piece's derived colliders, then the authored ones (the town's rects)
 * only for a piece that derived none (its geometry never stands in the way, e.g. over water).
 */
export function spaceBlockers(derived: readonly Derived[], authored: readonly Blocker[]): Blocker[] {
  const owners = new Set(derived.filter((d) => d.colliders.length).map((d) => d.owner));
  const kept = authored.filter((b) => !owners.has(authoredOwner(b))).map((b): Blocker => ({ ...b, owner: authoredOwner(b), source: "authored" }));
  return [...derived.flatMap((d) => d.colliders), ...kept];
}

/** Where an NPC stands: a disc the size of a body. */
export const NPC_RADIUS = 0.25;
export const npcBlocker = (npc: string, pos: readonly number[]): Blocker => shapeBlocker({ kind: "circle", c: [pos[0], pos[2]], r: NPC_RADIUS }, npc, "npc");
