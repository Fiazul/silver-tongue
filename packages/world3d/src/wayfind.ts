// Wayfinding: the objective (objective.ts) as a place in the world, and the ways to show it. Pure
// (no three.js, no DOM), so tests walk it:
// - resolveTarget: the objective's goal as a point in the space the player is in: the NPC (their
//   stand), the bed, or the next hop towards them (a door in this space, else this interior's way
//   out), a travel-only place's stay spot. main.ts floats the marker over it, points the screen-edge
//   arrow at it and draws the ground path to it.
// - nextSteps: the current objective and up to two after it, projected from core state as if each
//   were done (the objective resolver run again on the projected state); daySteps: step n of N
//   today (one per slot, then the evening's sleep).
// - PathGrid + findPath: A* on the walk grid (8-neighbour, no corner cutting; path, plaza and
//   bridge cheaper than grass; blockers out); a start or goal on a blocked cell snaps to the
//   nearest open one.
// - edgeArrow: a clip-space point on screen, or clamped to the screen edge along the line from
//   the centre, turned to point at it (a point behind the camera too).
// - LostTimer: far from the target for a while with nothing else going on: repeat the objective.
import type { Course, GameState } from "@silver-tongue/core";
import type { Text } from "@silver-tongue/tui";
import type { Box2, Interactable, Trigger, Vec3 } from "./layout";
import { objective, type Objective, type ObjectiveGoal } from "./objective";
import type { Strings } from "./strings";

/** What resolveTarget needs of the layout (LayoutIndex has it all). */
export interface WayLayout {
  spaceOf(place: string): string;
  outerSpace(space: string): string | null;
  npcSpace(npc: string): string;
  npcStand(npc: string): { pos: Vec3 };
  talkStand(npc: string): { pos: Vec3 };
  space(id: string): { triggers: Trigger[]; interactables: Interactable[] };
  heightAt(space: string, x: number, z: number): number;
}

export type WayTargetKind = "npc" | "bed" | "door" | "exit" | "spot";

export interface WayTarget {
  kind: WayTargetKind;
  /** the NPC, or the place the door / way out / spot leads to (the bed: home) */
  ref: string;
  /** feet position in the current space (the marker floats over it) */
  at: Vec3;
  /** where the ground path ends (x, z): the talk stand for an NPC, else `at` */
  walk: [number, number];
  /** the objective's own target here (false: a hop on the way to it) */
  final: boolean;
}

/**
 * The goal as a point in `space` (the player's), `place`: core's current place. An NPC in this
 * space: them (a travel-only place's NPC stands in the town: them too). Else their place, as a
 * place: a door, stay spot or zone of it in this space; a place in another space: the door in this
 * space on the way there (spaces nest: town > interior > inner room), else this interior's way out.
 */
export function resolveTarget(L: WayLayout, goal: ObjectiveGoal | undefined, space: string, place: string): WayTarget | null {
  if (!goal) return null;
  const feet = (x: number, z: number): Vec3 => [x, L.heightAt(space, x, z), z];
  if (goal.kind === "npc" && L.npcSpace(goal.npc) === space) {
    const p = L.npcStand(goal.npc).pos;
    const w = L.talkStand(goal.npc).pos;
    return { kind: "npc", ref: goal.npc, at: feet(p[0], p[2]), walk: [w[0], w[2]], final: true };
  }
  const want = goal.place;
  const here = L.space(space);
  if (goal.kind === "bed" && place === want) {
    const bed = here.interactables.find((x) => x.kind === "sleep");
    if (bed) return { kind: "bed", ref: want, at: feet(bed.pos[0], bed.pos[2]), walk: [bed.pos[0], bed.pos[2]], final: true };
  }
  const trigger = (t: Trigger, final: boolean): WayTarget => {
    const kind: WayTargetKind = t.kind === "exit" ? "exit" : t.kind === "door" ? "door" : "spot";
    return { kind, ref: t.place, at: feet(t.at[0], t.at[2]), walk: [t.at[0], t.at[2]], final };
  };
  const target = L.spaceOf(want);
  if (target === space) {
    if (place === want) return null; // there, and nothing in particular to walk to
    const own = ["door", "stay", "zone"].map((k) => here.triggers.find((t) => t.place === want && t.kind === k)).find(Boolean);
    return own ? trigger(own, true) : null;
  }
  // The spaces from the target's out to the town: this space in the chain means its door on the way in.
  const chain: string[] = [target];
  for (let s = L.outerSpace(target); s && chain.length < 8; s = L.outerSpace(s)) chain.push(s);
  const i = chain.indexOf(space);
  if (i > 0) {
    const inner = chain[i - 1];
    const door = here.triggers.find((t) => t.kind === "door" && L.spaceOf(t.place) === inner);
    if (door) return trigger(door, false);
  }
  const exit = here.triggers.find((t) => t.kind === "exit");
  return exit ? trigger(exit, false) : null;
}

/** The objective's state after it is done well (the next objective is resolved on this). Null: nothing to project (the day ends). */
export function projectDone(course: Course, st: GameState, o: Objective): GameState | null {
  const w = course.world;
  const next: GameState = { ...st, scenesDone: { ...st.scenesDone }, trust: { ...st.trust }, notes: { ready: [...st.notes.ready], read: [...st.notes.read] } };
  switch (o.kind) {
    case "name":
      next.player = st.player || "-";
      return next;
    case "scene":
    case "story":
    case "work":
    case "practice":
    case "deliver": {
      const scene = course.scenes.find((x) => x.id === o.scene);
      if (!scene) return null;
      if (o.kind !== "scene") next.slot = st.slot + 1; // a running scene's slot is already taken
      next.run = null;
      next.place = scene.place;
      next.scenesDone[scene.id] = (st.scenesDone[scene.id] ?? 0) + 1;
      next.trust[scene.npc] = (st.trust[scene.npc] ?? 0) + scene.trustGain;
      if (scene.endsErrand) delete next.errand;
      return next;
    }
    case "mentor":
      next.slot = st.slot + 1;
      next.place = w.npcs[w.mentor!.npc]?.place ?? st.place;
      next.notes = { ready: [], read: [...st.notes.read, ...st.notes.ready] };
      return next;
    default:
      return null; // sleep: the day is over
  }
}

/** The current objective and up to `count - 1` after it today, each resolved on the state after the one before. */
export function nextSteps(course: Course, st: GameState, t: Text, s: Strings, needsName: boolean, count = 3): Objective[] {
  const out: Objective[] = [];
  let state: GameState | null = st;
  while (state && out.length < count) {
    const o = objective(course, state, t, s, needsName);
    const prev = out.at(-1);
    if (prev && prev.kind === o.kind && prev.scene === o.scene && prev.text === o.text) break; // no progress: stop
    out.push(o);
    state = projectDone(course, state, o);
  }
  return out;
}

/** Step n of N today: one step per slot, then the evening (sleep). A running scene is the step its slot started. */
export function daySteps(course: Course, st: GameState): { n: number; total: number } {
  const total = course.world.slotsPerDay + 1;
  const n = st.run ? st.slot : st.slot + 1;
  return { n: Math.max(1, Math.min(total, n)), total };
}

// ------------------------------------------------------------------------------------------------
// The ground path

/** Walking cost per grid class: 1 ground (grass), 2 path, 3 plaza, 4 pad, 5 bridge. */
export const CLASS_COST: Record<number, number> = { 1: 1.6, 2: 1, 3: 1, 4: 1.2, 5: 1 };

/** A cost grid over the x/z plane: `cost[j * cols + i]` for the cell [x0 + i*cell, +cell] x [z0 + j*cell, +cell]; 0 blocked. */
export interface PathGrid {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  cost: Float32Array;
}

/** A grid over `bounds` at `cell` m, each cell's cost from `costAt` (0: not walkable) at its centre, unless `blocked` there. */
export function buildPathGrid(bounds: Box2, cell: number, costAt: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean): PathGrid {
  const cols = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / cell));
  const rows = Math.max(1, Math.ceil((bounds.max[1] - bounds.min[1]) / cell));
  const cost = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = bounds.min[0] + (i + 0.5) * cell;
      const z = bounds.min[1] + (j + 0.5) * cell;
      const c = costAt(x, z);
      cost[j * cols + i] = c > 0 && !blocked(x, z) ? c : 0;
    }
  return { x0: bounds.min[0], z0: bounds.min[1], cell, cols, rows, cost };
}

const cellOf = (g: PathGrid, x: number, z: number): [number, number] => [Math.floor((x - g.x0) / g.cell), Math.floor((z - g.z0) / g.cell)];
const open = (g: PathGrid, i: number, j: number) => i >= 0 && j >= 0 && i < g.cols && j < g.rows && g.cost[j * g.cols + i] > 0;

/** The nearest open cell to (i, j) within `reach` cells (ring by ring), or null. */
function nearestOpen(g: PathGrid, i: number, j: number, reach: number): [number, number] | null {
  if (open(g, i, j)) return [i, j];
  for (let r = 1; r <= reach; r++) {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !open(g, i + di, j + dj)) continue;
        const d = di * di + dj * dj;
        if (d < bd) (bd = d), (best = [i + di, j + dj]);
      }
    if (best) return best;
  }
  return null;
}

/** A binary min-heap of cell indices by priority. */
class Heap {
  private items: number[] = [];
  private pri: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, p: number) {
    const a = this.items;
    const q = this.pri;
    a.push(item);
    q.push(p);
    let k = a.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (q[up] <= q[k]) break;
      [a[up], a[k]] = [a[k], a[up]];
      [q[up], q[k]] = [q[k], q[up]];
      k = up;
    }
  }
  pop(): number {
    const a = this.items;
    const q = this.pri;
    const top = a[0];
    const lastA = a.pop()!;
    const lastQ = q.pop()!;
    if (a.length) {
      a[0] = lastA;
      q[0] = lastQ;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && q[l] < q[m]) m = l;
        if (r < a.length && q[r] < q[m]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        [q[m], q[k]] = [q[k], q[m]];
        k = m;
      }
    }
    return top;
  }
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * A* from (x, z) to (x, z) on the grid: the cell centres on the way (world x/z; the first and last
 * are `from` and `to` themselves when their cells are open), or null when there is no way. A step
 * costs its length times the mean of the two cells' costs; diagonals never cut a blocked corner.
 * A blocked start or goal (standing in a doorway, an NPC's own stand) snaps to the nearest open
 * cell within `snap` m.
 */
export function findPath(g: PathGrid, from: [number, number], to: [number, number], snap = 3): [number, number][] | null {
  const reach = Math.ceil(snap / g.cell);
  const [si, sj] = cellOf(g, from[0], from[1]);
  const [gi, gj] = cellOf(g, to[0], to[1]);
  const s = nearestOpen(g, si, sj, reach);
  const e = nearestOpen(g, gi, gj, reach);
  if (!s || !e) return null;
  const { cols, cost } = g;
  const start = s[1] * cols + s[0];
  const goal = e[1] * cols + e[0];
  const best = new Float32Array(cost.length).fill(Infinity);
  const prev = new Int32Array(cost.length).fill(-1);
  const done = new Uint8Array(cost.length);
  let minCost = Infinity;
  for (const c of cost) if (c > 0 && c < minCost) minCost = c;
  const h = (k: number) => {
    const dx = Math.abs((k % cols) - e[0]);
    const dz = Math.abs(Math.floor(k / cols) - e[1]);
    return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * minCost;
  };
  const heap = new Heap();
  best[start] = 0;
  heap.push(start, h(start));
  while (heap.size) {
    const k = heap.pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === goal) break;
    const i = k % cols;
    const j = (k - i) / cols;
    for (const [di, dj, len] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (!open(g, ni, nj)) continue;
      if (di && dj && (!open(g, i + di, j) || !open(g, i, j + dj))) continue; // no corner cutting
      const n = nj * cols + ni;
      if (done[n]) continue;
      const d = best[k] + len * 0.5 * (cost[k] + cost[n]);
      if (d < best[n]) {
        best[n] = d;
        prev[n] = k;
        heap.push(n, d + h(n));
      }
    }
  }
  if (!done[goal]) return null;
  const cells: number[] = [];
  for (let k = goal; k !== -1; k = prev[k]) cells.unshift(k);
  const centre = (k: number): [number, number] => [g.x0 + ((k % cols) + 0.5) * g.cell, g.z0 + (Math.floor(k / cols) + 0.5) * g.cell];
  const pts = cells.map(centre);
  if (open(g, si, sj)) pts[0] = [from[0], from[1]];
  if (open(g, gi, gj)) pts[pts.length - 1] = [to[0], to[1]];
  return simplify(pts);
}

/** Drops the middle points of straight runs. */
function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1];
    const b = pts[k];
    const c = pts[k + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Points every `spacing` m along a polyline, from `skip` m in to `stopShort` m before its end (the breadcrumbs), with their distance along it. */
export function breadcrumbs(path: [number, number][], spacing: number, skip = 0.8, stopShort = 1): { x: number; z: number; d: number }[] {
  const out: { x: number; z: number; d: number }[] = [];
  let total = 0;
  for (let k = 1; k < path.length; k++) total += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  let along = 0;
  let next = skip;
  for (let k = 1; k < path.length && next <= total - stopShort; k++) {
    const [ax, az] = path[k - 1];
    const [bx, bz] = path[k];
    const len = Math.hypot(bx - ax, bz - az);
    while (next <= along + len && next <= total - stopShort) {
      const u = len ? (next - along) / len : 0;
      out.push({ x: ax + (bx - ax) * u, z: az + (bz - az) * u, d: next });
      next += spacing;
    }
    along += len;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The screen-edge arrow

export interface EdgeArrow {
  /** the point is in the viewport (no arrow) */
  onScreen: boolean;
  /** screen px: the point itself when on screen, else where the arrow sits on the edge */
  x: number;
  y: number;
  /** radians, screen space (0: pointing right, π/2: down) */
  angle: number;
}

export type EdgeInsets = { top: number; right: number; bottom: number; left: number };

/**
 * A clip-space point (x, y, w: before the divide) on a `view` px viewport. On screen: its pixel.
 * Else on the rectangle `inset` px inside the edges (one number, or per side: the HUD's corner),
 * along the line from the screen centre towards it. The direction is (x, y) as it stands, never
 * divided by w: a point behind the camera (w < 0) keeps its true side (the divide would mirror it).
 */
export function edgeArrow(clip: { x: number; y: number; w: number }, view: { w: number; h: number }, inset: number | EdgeInsets): EdgeArrow {
  const cx = view.w / 2;
  const cy = view.h / 2;
  if (clip.w > 1e-6) {
    const nx = clip.x / clip.w;
    const ny = clip.y / clip.w;
    if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) return { onScreen: true, x: cx + nx * cx, y: cy - ny * cy, angle: Math.PI / 2 };
  }
  const e = typeof inset === "number" ? { top: inset, right: inset, bottom: inset, left: inset } : inset;
  let dx = clip.x * cx;
  let dy = -clip.y * cy;
  if (Math.hypot(dx, dy) < 1e-9) (dx = 0), (dy = 1); // dead behind: straight down (towards the viewer)
  // The rectangle's sides, measured from the centre (at least 1 px each way, so the centre stays inside).
  const right = Math.max(1, view.w - e.right - cx);
  const left = Math.max(1, cx - e.left);
  const down = Math.max(1, view.h - e.bottom - cy);
  const up = Math.max(1, cy - e.top);
  const kx = dx > 0 ? right / dx : dx < 0 ? left / -dx : Infinity;
  const ky = dy > 0 ? down / dy : dy < 0 ? up / -dy : Infinity;
  const k = Math.min(kx, ky);
  return { onScreen: false, x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}

// ------------------------------------------------------------------------------------------------
// Never lost

/** Far from the target for a while (seconds), nothing else on: time to repeat the objective, at most every `every` s. */
export class LostTimer {
  private away = 0;
  private since = Infinity;

  constructor(
    readonly far = 40,
    readonly after = 20,
    readonly every = 60,
  ) {}

  /** `dist`: metres to the target (null: none); `busy`: a scene, a dialog, the fly-over. True: show the reminder now. */
  update(dt: number, dist: number | null, busy: boolean): boolean {
    this.since += dt;
    if (busy || dist === null || dist <= this.far) {
      this.away = 0;
      return false;
    }
    this.away += dt;
    if (this.away < this.after || this.since < this.every) return false;
    this.since = 0;
    return true;
  }
}
