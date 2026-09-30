import * as THREE from "three";
import FRAMES from "./interior-frames.json";
import type { InteriorView } from "./layout";

/**
 * The view: straight at the back wall from the open front (Stardew-style: both side walls in
 * view, the front one never), pitched down PITCH_RANGE. Steeper than the
 * street: with the eye above the ceiling, the ray to a player's head crosses the ceiling height
 * (3 m - 1.7 m) / tan(pitch) nearer the eye, so a steeper view keeps the player whole closer to the
 * open front (the strip where no ray can reach the head through the ceiling opening).
 */
const AZIMUTH = 0;
const PITCHES = [55, 60, 65, 70];
const PITCH_RANGE: readonly [number, number] = [PITCHES[0], PITCHES[PITCHES.length - 1]];
const PITCH_PREFERRED = 60;
/** Exported for tests: the allowed pitch range (degrees). */
export const INTERIOR_PITCH_RANGE = PITCH_RANGE;
interface Basis { key: string; az: number; pitch: number; F: THREE.Vector3; R: THREE.Vector3; U: THREE.Vector3 }
function basis(azDeg: number, pitchDeg: number): Basis {
  const a = THREE.MathUtils.degToRad(azDeg), sa = Math.sin(a), ca = Math.cos(a);
  const p = THREE.MathUtils.degToRad(pitchDeg), SIN = Math.sin(p), COS = Math.cos(p);
  return {
    key: `${azDeg}/${pitchDeg}`, az: azDeg, pitch: pitchDeg,
    F: new THREE.Vector3(-COS * sa, -SIN, -COS * ca),
    R: new THREE.Vector3(ca, 0, -sa),
    U: new THREE.Vector3(-SIN * sa, COS, -SIN * ca),
  };
}
const BASES = new Map<string, Basis>();
/**
 * Where a frame ray crosses the ceiling height (eye above the ceiling), it stays this far inside
 * the room's outer wall planes: past the authored walls' thickness (shells 0.15 m; box rooms'
 * walls stand outside the bounds), so no wall top, cap or outside shows. The ceiling itself is
 * single-sided (interior-enclosure.ts): invisible from above.
 */
export const INTERIOR_WALL = 0.2;
/** Floor hits stay this far from the open front (its plane reaches just under the floor). */
const FRONT = 0.05;
/** Eye inside the room (at or below the ceiling): inset from the outer wall planes. */
const EDGE = 0.02;
/** The eye stays this far under the ceiling when it is inside the room (fallback frame only). */
const HEAD = 0.12;
/** Searched (solveFrame): eye height above the ceiling (m) and fov (degrees), with PITCHES.
 * About 0.3-3 s a room and aspect: precomputed (interiorFrame). */
const RISE_RANGE = [0.25, 5] as const, RISE_STEP = 0.25, FOV_RANGE = [30, 72] as const, FOV_STEP = 2;

/** Frame limits: the top edge stays this far below the horizon; fov range and step (degrees). */
const TOP_DROP = 8;
const VFOV_MAX = 72, HFOV_MAX = 84, VFOV_MIN = 8;
/** Eye positions tried per axis for one (azimuth, height, fov). */
const EYE_GRID = 12;
/** The player's height on screen the frame aims for (fraction of the frame height). */
export const PLAYER_SIZE: readonly [number, number] = [0.2, 0.35];
/** Head height above the feet for the framing checks. */
const HEAD_UP = 1.7;
/** Frame rays checked: corners and three more along each edge (NDC). */
const RAYS: [number, number][] = [-1, -0.5, 0, 0.5, 1].flatMap((t) => [[t, -1], [t, 1], [-1, t], [1, t]] as [number, number][])
  .filter(([x, y], i, all) => all.findIndex(([a, b]) => a === x && b === y) === i);

export interface InteriorFrame {
  /** vertical fov, degrees */
  fov: number;
  /** azimuth, degrees (AZIMUTH) */
  az: number;
  /** pitch, degrees (PITCH_RANGE) */
  pitch: number;
  /** eye height above the floor (may be above the ceiling) */
  height: number;
  /** eye positions checked valid: every frame ray lands on the floor or a far wall */
  eyes: THREE.Vector3[];
  /** the eye the room is framed from when the player needs no follow */
  home: THREE.Vector3;
  /** share of the floor in view from home */
  cover: number;
}

function rayDir(b: Basis, tx: number, ty: number, sx: number, sy: number) {
  return b.F.clone().addScaledVector(b.R, sx * tx).addScaledVector(b.U, sy * ty);
}

/**
 * Where one frame ray from `eye` first meets the room: "floor", "left", "back", "right" (the side
 * walls and the back wall face the camera; the +x side is the enclosure's inward plane) or null
 * (the open front's plane, the ceiling from below, a wall top, the outside). Above the ceiling the
 * ray must cross the ceiling height INTERIOR_WALL inside the outer wall planes; below it the eye
 * must be inside the room.
 */
export function rayLanding(room: InteriorView, eye: THREE.Vector3, d: THREE.Vector3): "floor" | "left" | "back" | "right" | null {
  const { min, max } = room.bounds;
  if (d.y >= -1e-6) return null;
  let px = eye.x, py = eye.y, pz = eye.z;
  if (eye.y > room.ceiling) {
    const t = (room.ceiling - eye.y) / d.y;
    px += d.x * t; pz += d.z * t; py = room.ceiling;
    if (px <= min[0] + INTERIOR_WALL || px >= max[0] - INTERIOR_WALL || pz <= min[1] + INTERIOR_WALL || pz >= max[1] - INTERIOR_WALL) return null;
  } else if (px <= min[0] + EDGE || px >= max[0] - EDGE || pz <= min[1] + EDGE || pz >= max[1] - EDGE) return null;
  const tFloor = (room.floor - py) / d.y;
  const tx = d.x < 0 ? (min[0] - px) / d.x : d.x > 0 ? (max[0] - px) / d.x : Infinity;
  const tz = d.z < 0 ? (min[1] - pz) / d.z : d.z > 0 ? (max[1] - pz) / d.z : Infinity;
  if (tFloor <= tx && tFloor <= tz) {
    const hx = px + d.x * tFloor, hz = pz + d.z * tFloor;
    return hx > min[0] && hx < max[0] && hz > min[1] && hz < max[1] - FRONT ? "floor" : null;
  }
  if (tx <= tz) return d.x < 0 ? "left" : "right";
  return d.z < 0 ? "back" : null;
}

/** Every checked frame ray lands on the room (floor or a far wall). */
function validEye(room: InteriorView, b: Basis, tx: number, ty: number, eye: THREE.Vector3) {
  for (const [sx, sy] of RAYS) if (!rayLanding(room, eye, rayDir(b, tx, ty, sx, sy))) return false;
  return true;
}

/** Screen position (NDC) of a world point seen from `eye` with the frame's orientation. */
function ndc(b: Basis, eye: THREE.Vector3, tx: number, ty: number, px: number, py: number, pz: number) {
  const vx = px - eye.x, vy = py - eye.y, vz = pz - eye.z;
  const depth = vx * b.F.x + vy * b.F.y + vz * b.F.z;
  if (depth <= 0.05) return undefined;
  return { x: (vx * b.R.x + vz * b.R.z) / (depth * tx), y: (vx * b.U.x + vy * b.U.y + vz * b.U.z) / (depth * ty) };
}

/** Screen bands (NDC) the player must stay in: strict first, then relaxed. */
const BANDS = [{ x: 0.8, top: 0.8, bottom: -0.85 }, { x: 0.92, top: 0.92, bottom: -0.95 }];
type Band = (typeof BANDS)[number];
type View = { fov: number; az: number; pitch: number };
const tangents = (v: View, aspect: number) => {
  const ty = Math.tan(THREE.MathUtils.degToRad(v.fov) / 2);
  const key = `${v.az}/${v.pitch}`;
  let b = BASES.get(key);
  if (!b) { b = basis(v.az, v.pitch); BASES.set(key, b); }
  return { tx: ty * aspect, ty, b };
};

function framed(v: View, aspect: number, eye: THREE.Vector3, focus: THREE.Vector3, band: Band) {
  const { tx, ty, b } = tangents(v, aspect);
  for (const up of [0, HEAD_UP]) {
    const p = ndc(b, eye, tx, ty, focus.x, focus.y + up, focus.z);
    if (!p || Math.abs(p.x) > band.x || p.y > band.top || p.y < band.bottom) return false;
  }
  return true;
}

/** Body radius for the framing checks and the size measure (m). */
const BODY = 0.25;

/** The player's height on screen (fraction of the frame height) at `focus`, seen from `eye`: the
 * screen extent of their body (1.7 m tall, BODY round), so a steep view still counts their depth. */
export function playerSize(v: View, aspect: number, eye: THREE.Vector3, focus: THREE.Vector3) {
  const { tx, ty, b } = tangents(v, aspect);
  const fx = b.F.x, fz = b.F.z, n = Math.hypot(fx, fz) || 1;
  let lo = Infinity, hi = -Infinity;
  for (const up of [0, HEAD_UP]) for (const k of [-BODY, BODY]) {
    const p = ndc(b, eye, tx, ty, focus.x + (fx / n) * k, focus.y + up, focus.z + (fz / n) * k);
    if (!p) return 1;
    lo = Math.min(lo, p.y); hi = Math.max(hi, p.y);
  }
  return (hi - lo) / 2;
}

/** Where the player can be: the floor inside the walls, on a `step` m grid (plus the arrival point). */
export function roomFoci(room: InteriorView, step = 0.5) {
  const { min, max } = room.bounds, inset = INTERIOR_WALL + 0.15, out: THREE.Vector3[] = [];
  const nx = Math.max(1, Math.round((max[0] - min[0] - 2 * inset) / step)), nz = Math.max(1, Math.round((max[1] - min[1] - 2 * inset) / step));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++)
    out.push(new THREE.Vector3(min[0] + inset + ((max[0] - min[0] - 2 * inset) * i) / nx, room.floor, min[1] + inset + ((max[1] - min[1] - 2 * inset) * j) / nz));
  if (room.entry) out.push(new THREE.Vector3(room.entry[0], room.floor, room.entry[1]));
  return out;
}

/** Share of the floor (inside the walls, 0.4 m grid) inside the frame from `eye`. */
function floorCoverage(room: InteriorView, v: View, aspect: number, eye: THREE.Vector3) {
  const { min, max } = room.bounds, { tx, ty, b } = tangents(v, aspect);
  let n = 0, seen = 0;
  for (let x = min[0] + INTERIOR_WALL; x <= max[0] - INTERIOR_WALL; x += 0.4) for (let z = min[1] + INTERIOR_WALL; z <= max[1] - INTERIOR_WALL; z += 0.4) {
    n++;
    const p = ndc(b, eye, tx, ty, x, room.floor, z);
    if (p && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) seen++;
  }
  return n ? seen / n : 0;
}

/** The foci scored (roomFoci) and the size probes: the room's centre and the arrival point. */
function focusSets(room: InteriorView) {
  const centre = new THREE.Vector3((room.bounds.min[0] + room.bounds.max[0]) / 2, room.floor, (room.bounds.min[1] + room.bounds.max[1]) / 2);
  return { foci: roomFoci(room), probes: [centre, ...(room.entry ? [new THREE.Vector3(room.entry[0], room.floor, room.entry[1])] : [])] };
}

/** Table key for a room: its camera volume (two rooms with the same volume share their frames). */
export function frameKey(room: InteriorView) {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [...room.bounds.min, ...room.bounds.max, room.floor, room.ceiling, ...(room.entry ?? [])].map(r).join(",");
}
/** Aspect buckets of the precomputed table (scripts/interior-frames.ts): phones in portrait 0.40 to
 * 0.80 in 0.02 steps, then to 2.50 in 0.05 steps, plus 16:9 exactly. */
export const FRAME_ASPECTS = [
  ...Array.from({ length: 20 }, (_, i) => 0.4 + i * 0.02),
  ...Array.from({ length: 35 }, (_, i) => 0.8 + i * 0.05),
  16 / 9,
].map((a) => Math.round(a * 10000) / 10000).sort((a, b) => a - b);
type FrameParams = { aspect: number; pitch: number; fov: number; height: number };
const NEAREST = 5;
const TABLE = FRAMES as Record<string, FrameParams[]>;

/**
 * The room's frame for one aspect, cached. The search (solveFrame) takes seconds, so its results
 * are precomputed per room and aspect bucket (src/interior-frames.json, scripts/interior-frames.ts).
 * A viewport scores the NEAREST buckets' pitch, eye height and fov at its own aspect (evaluate:
 * a few ms) and takes the best; its eyes are checked at that aspect, so every frame ray is valid
 * whatever the bucket. A room missing from the table (edited layout) solves live.
 */
const frames = new WeakMap<InteriorView, Map<number, InteriorFrame>>();
export function interiorFrame(room: InteriorView, aspect: number): InteriorFrame {
  aspect = Math.max(0.1, aspect);
  const cache = frames.get(room) ?? new Map<number, InteriorFrame>();
  frames.set(room, cache);
  const hit = cache.get(aspect);
  if (hit) return hit;
  const rows = [...(TABLE[frameKey(room)] ?? [])].sort((a, b) => Math.abs(a.aspect - aspect) - Math.abs(b.aspect - aspect)).slice(0, NEAREST);
  const { foci, probes } = focusSets(room);
  let best: Candidate | undefined;
  for (const r of rows) {
    const c = evaluate(room, aspect, r.pitch, r.height, r.fov, foci, probes, EYE_GRID, 0);
    if (c && (!best || c.score > best.score)) best = c;
  }
  const frame = best?.frame ?? solveFrame(room, aspect);
  cache.set(aspect, frame);
  return frame;
}

/** The eye window for one view and height: the bottom edge's floor hits (near side) and, above the
 * ceiling, the corner rays' ceiling crossings bound it (necessary conditions; validEye decides). */
function eyeWindow(room: InteriorView, b: Basis, tx: number, ty: number, height: number) {
  const { min, max } = room.bounds, above = height - (room.ceiling - room.floor);
  const lo = [-Infinity, -Infinity], hi = [Infinity, Infinity];
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const d = rayDir(b, tx, ty, sx, sy);
    if (d.y >= 0) return undefined;
    const o = [d.x / -d.y, d.z / -d.y];
    for (const i of [0, 1]) {
      if (sy === -1 && i === 1) hi[i] = Math.min(hi[i], max[i] - FRONT - height * o[i]);
      if (above > 0) { lo[i] = Math.max(lo[i], min[i] + INTERIOR_WALL - above * o[i]); hi[i] = Math.min(hi[i], max[i] - INTERIOR_WALL - above * o[i]); }
      else { lo[i] = Math.max(lo[i], min[i] + EDGE); hi[i] = Math.min(hi[i], max[i] - EDGE); }
    }
  }
  return lo[0] < hi[0] && lo[1] < hi[1] ? { lo, hi } : undefined;
}

/** The eye for `focus`: `home` when it frames the player, else the eye nearest to home that does
 * (strict band, then relaxed); undefined when none does. */
function eyeFor(v: View, aspect: number, eyes: THREE.Vector3[], home: THREE.Vector3, focus: THREE.Vector3) {
  for (const band of BANDS) {
    if (framed(v, aspect, home, focus, band)) return home;
    let best: THREE.Vector3 | undefined, near = Infinity;
    for (const p of eyes) {
      const d = p.distanceToSquared(home);
      if (d < near && framed(v, aspect, p, focus, band)) { near = d; best = p; }
    }
    if (best) return best;
  }
  return undefined;
}

interface Candidate { frame: InteriorFrame; score: number; share: number }

/** One (pitch, eye height, fov): its valid eyes, home eye (most floor in view) and score. */
/** The frame for one (pitch, eye height, fov) at this aspect: its valid eyes on a grid and its home
 * eye (the one that sees most of the floor); undefined when no eye is valid. */
export function buildFrame(room: InteriorView, aspect: number, pitch: number, height: number, deg: number, grid = EYE_GRID): InteriorFrame | undefined {
  const v = { fov: deg, az: AZIMUTH, pitch };
  const { tx, ty, b } = tangents(v, aspect);
  const w = eyeWindow(room, b, tx, ty, height);
  if (!w) return undefined;
  const eyes: THREE.Vector3[] = [];
  // cell centres, never the window's edges: an eye on a constraint's boundary is valid or not by
  // rounding, and a frame that needs one would not survive a slightly different viewport
  for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
    const e = new THREE.Vector3(w.lo[0] + ((w.hi[0] - w.lo[0]) * (i + 0.5)) / (grid + 1), room.floor + height, w.lo[1] + ((w.hi[1] - w.lo[1]) * (j + 0.5)) / (grid + 1));
    if (validEye(room, b, tx, ty, e)) eyes.push(e);
  }
  if (!eyes.length) return undefined;
  const some = eyes.filter((_, k) => k % Math.ceil(eyes.length / 20) === 0);
  let home = some[0], cover = -1;
  for (const p of some) { const c = floorCoverage(room, v, aspect, p); if (c > cover + 1e-9) { cover = c; home = p; } }
  return { ...v, height, eyes, home, cover };
}

function evaluate(room: InteriorView, aspect: number, pitch: number, height: number, deg: number, foci: THREE.Vector3[], probes: THREE.Vector3[], grid: number, floorShare: number): Candidate | undefined {
  const frame = buildFrame(room, aspect, pitch, height, deg, grid);
  if (!frame) return undefined;
  const { eyes, home, cover } = frame, v = frame;
  let fromHome = 0, fromAny = 0, missed = 0;
  const allowed = Math.floor((1 - floorShare) * foci.length + 1e-9) + 1; // worse than the best so far: stop
  for (const f of foci) {
    const e = eyeFor(v, aspect, eyes, home, f);
    if (e) { fromAny++; if (e === home) fromHome++; }
    else if (++missed > allowed) return undefined;
  }
  let off = 0; // the player's size at the room's centre and the arrival point
  for (const f of probes) {
    const e = eyeFor(v, aspect, eyes, home, f);
    const size = e ? playerSize(v, aspect, e, f) : 1;
    off += Math.max(0, size - PLAYER_SIZE[1]) + Math.max(0, PLAYER_SIZE[0] - size);
  }
  const share = fromAny / foci.length;
  const hc = room.ceiling - room.floor;
  const score = share * 1e6 - (off / probes.length) * 5e4 + (fromHome / foci.length) * 1e3 + cover * 200 - (height - hc) - Math.abs(pitch - PITCH_PREFERRED) * 2;
  return { frame, score, share };
}

/**
 * The frame: a coarse search over pitch, eye height and fov, then a finer one round the best,
 * scored (evaluate):
 * 1. the player whole (feet and head) over as much of the room as some valid eye allows;
 * 2. the player PLAYER_SIZE of the frame at the room's centre and the arrival point;
 * 3. the same from the home eye alone (the camera need not move); 4. the most floor in view;
 * then the lowest eye and a pitch near PITCH_PREFERRED.
 */
export function solveFrame(room: InteriorView, aspect: number): InteriorFrame {
  const hc = room.ceiling - room.floor;
  const { foci, probes } = focusSets(room);
  const vMax = (pitch: number) => Math.min(VFOV_MAX, 2 * (pitch - TOP_DROP), THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(HFOV_MAX) / 2) / aspect)));
  let best: Candidate | undefined;
  const consider = (pitch: number, height: number, deg: number, grid: number, foci: THREE.Vector3[]) => {
    const c = evaluate(room, aspect, pitch, height, deg, foci, probes, grid, best ? best.share : 0);
    if (!c) return;
    if (!best || c.score > best.score) best = c;
  };
  for (const pitch of PITCHES)
    for (let height = hc + RISE_RANGE[0]; height <= hc + RISE_RANGE[1] + 1e-6; height += RISE_STEP)
      for (let deg = FOV_RANGE[0]; deg <= Math.min(FOV_RANGE[1], vMax(pitch)); deg += FOV_STEP) consider(pitch, height, deg, EYE_GRID, foci);
  const found = best as Candidate | undefined;
  if (found) return found.frame;
  const top = hc - HEAD; // no valid frame at all (degenerate room): a narrow view from under the ceiling
  const home = new THREE.Vector3((room.bounds.min[0] + room.bounds.max[0]) / 2, room.floor + top, room.bounds.max[1] - EDGE);
  return { fov: VFOV_MIN, az: AZIMUTH, pitch: PITCH_PREFERRED, height: top, eyes: [home], home, cover: 0 };
}

/** The eye for `focus` (eyeFor), home when no valid eye frames the player. */
function target(frame: InteriorFrame, focus: THREE.Vector3, aspect: number) {
  return eyeFor(frame, aspect, frame.eyes, frame.home, focus) ?? frame.home;
}

/** Fit the camera to the room: every frame ray lands on the floor or a far wall (never a near wall,
 * a wall top, the ceiling or outside); the eye may stand above the single-sided ceiling. The room is
 * framed from one home eye; the camera moves (gently: `blend` is the follow step, 1 snaps) only when
 * the player would leave the frame. */
export function applyInteriorCamera(camera: THREE.PerspectiveCamera, room: InteriorView, focus: THREE.Vector3, blend = 1) {
  const aspect = Math.max(0.1, camera.aspect);
  const frame = interiorFrame(room, aspect);
  camera.fov = frame.fov;
  camera.near = 0.04;
  if (camera.view) camera.clearViewOffset(); // scene UI lifting must not break the enclosure clamp
  const goal = target(frame, focus, aspect);
  let eye = blend >= 1 ? goal.clone() : camera.position.clone().lerp(goal, blend);
  // Never frame from an unchecked point: a blend between two valid eyes (or across a resize) that
  // fails the check takes the valid eye nearest to it (a step of at most the eye grid's spacing).
  const { tx, ty, b } = tangents(frame, aspect);
  if (!validEye(room, b, tx, ty, eye)) {
    let near = Infinity, pick = goal;
    for (const p of frame.eyes) { const d = p.distanceToSquared(eye); if (d < near) { near = d; pick = p; } }
    eye = pick.clone();
  }
  camera.position.copy(eye);
  camera.lookAt(camera.position.clone().add(b.F));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
