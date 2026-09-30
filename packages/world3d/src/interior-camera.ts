import * as THREE from "three";
import { ENCLOSURE } from "./interior-enclosure";
import type { InteriorView } from "./layout";

/**
 * The interior camera: one fixed eye per room and aspect, the way Coral Island / The Sims show a
 * room. It looks straight at the back wall from in front of the open front, pitched down like the
 * street camera (INTERIOR_PITCH_RANGE), and may stand above the ceiling and in front of the room:
 * the enclosure (interior-enclosure.ts ENCLOSURE) carries the walls up and forward, the ceiling is
 * single-sided, so every frame ray lands on the floor or a wall face. The frame fits the room's
 * depth exactly: its bottom edge meets the floor just inside the open front, its top edge the back
 * wall just above the ceiling. Only a gentle sideways pan (dead zone) when the room is wider than
 * the frame; otherwise the camera does not move.
 */
export const INTERIOR_PITCH_RANGE: readonly [number, number] = [40, 45];
/** Pitch preferred on a tie (the street camera's, camera.ts CAMERA.elevationDeg). */
const PITCH_PREFERRED = 42;
/** The player's size the frame aims for (fraction of the frame height; body 1.7 m x 0.5 m). */
export const PLAYER_SIZE: readonly [number, number] = [0.3, 0.4];
/** The frame's bottom edge meets the floor this far inside the open front; its top edge the back
 * wall this far above the ceiling (the whole back wall in view). */
const FRONT_MARGIN = 0.1, TOP_MARGIN = 0.05;
/** The eye keeps this far from the enclosure's top and front end. */
const KEEP = 0.3;
/** Pan dead zone: the camera pans only once the player's centre passes this NDC x. */
export const PAN_DEAD_ZONE = 0.45;
/** Pan follow rate (1/s) is the rig's (camera.ts CAMERA.interiorFollow). */
const HEAD_UP = 1.7, BODY = 0.25;
/** Floor share (from the eye at the room's centre line) below which a frame is heavily penalised. */
const FLOOR_MIN = 0.8;

export interface InteriorFrame {
  /** vertical fov and pitch, degrees */
  fov: number;
  pitch: number;
  /** the eye: height and depth fixed, x pans within [xMin, xMax] (equal: no pan) */
  y: number;
  z: number;
  xMin: number;
  xMax: number;
  /** floor and back wall in view from the eye at the room's centre line (0-1) */
  floorShare: number;
  backShare: number;
}

interface Basis { F: THREE.Vector3; R: THREE.Vector3; U: THREE.Vector3 }
function basis(pitchDeg: number): Basis {
  const p = THREE.MathUtils.degToRad(pitchDeg), s = Math.sin(p), c = Math.cos(p);
  return { F: new THREE.Vector3(0, -s, -c), R: new THREE.Vector3(1, 0, 0), U: new THREE.Vector3(0, c, -s) };
}

/** Screen position (NDC) of a point from `eye` (straight-on view, pitch in `b`). */
function ndc(b: Basis, eye: THREE.Vector3, tx: number, ty: number, x: number, y: number, z: number) {
  const vx = x - eye.x, vy = y - eye.y, vz = z - eye.z;
  const depth = vy * b.F.y + vz * b.F.z;
  if (depth <= 0.05) return undefined;
  return { x: vx / (depth * tx), y: (vy * b.U.y + vz * b.U.z) / (depth * ty) };
}

/** The player's height on screen (fraction of the frame height) at `focus` from `eye`. */
export function playerSize(frame: { fov: number; pitch: number }, aspect: number, eye: THREE.Vector3, focus: THREE.Vector3) {
  const b = basis(frame.pitch), ty = Math.tan(THREE.MathUtils.degToRad(frame.fov) / 2), tx = ty * aspect;
  let lo = Infinity, hi = -Infinity;
  for (const up of [0, HEAD_UP]) for (const k of [-BODY, BODY]) {
    const p = ndc(b, eye, tx, ty, focus.x, focus.y + up, focus.z - k);
    if (!p) return 1;
    lo = Math.min(lo, p.y); hi = Math.max(hi, p.y);
  }
  return (hi - lo) / 2;
}

/** The room's inside (the walls' inner faces) and the enclosure around it. */
function volume(room: InteriorView) {
  const t = room.wall ?? 0, { min, max } = room.bounds;
  return { xi0: min[0] + t, xi1: max[0] - t, zi0: min[1] + t, z1: max[1], zf: max[1] + ENCLOSURE.front, top: room.floor + ENCLOSURE.top };
}

/**
 * Where a frame ray from `eye` leaves the enclosure: "floor" (inside the room), "wall" (the back
 * wall, a side wall or their extensions) or null (the floor's missing in front of the room, the
 * enclosure's open end or top: the outside). The eye must be inside the enclosure.
 */
export function rayLanding(room: InteriorView, eye: THREE.Vector3, d: THREE.Vector3): "floor" | "wall" | null {
  const v = volume(room);
  if (eye.x <= v.xi0 || eye.x >= v.xi1 || eye.z <= v.zi0 || eye.z >= v.zf || eye.y >= v.top || eye.y <= room.floor) return null;
  if (d.y >= 0) return null;
  const tFloor = (room.floor - eye.y) / d.y;
  const tx = d.x < 0 ? (v.xi0 - eye.x) / d.x : d.x > 0 ? (v.xi1 - eye.x) / d.x : Infinity;
  const tz = d.z < 0 ? (v.zi0 - eye.z) / d.z : d.z > 0 ? (v.zf - eye.z) / d.z : Infinity;
  const t = Math.min(tFloor, tx, tz);
  if (t === tFloor) return eye.z + d.z * t < v.z1 ? "floor" : null;
  if (t === tx) return "wall";
  return d.z < 0 ? "wall" : null;
}

/** Frame rays checked: corners and three more along each edge (NDC). */
const RAYS: [number, number][] = [-1, -0.5, 0, 0.5, 1].flatMap((t) => [[t, -1], [t, 1], [-1, t], [1, t]] as [number, number][])
  .filter(([x, y], i, all) => all.findIndex(([a, c]) => a === x && c === y) === i);

function validEye(room: InteriorView, b: Basis, tx: number, ty: number, eye: THREE.Vector3) {
  return RAYS.every(([sx, sy]) => rayLanding(room, eye, b.F.clone().addScaledVector(b.R, sx * tx).addScaledVector(b.U, sy * ty)) !== null);
}

/** Share of the floor (inside the walls, 0.25 m grid) and of the back wall's width in view. */
function coverage(room: InteriorView, b: Basis, tx: number, ty: number, eye: THREE.Vector3) {
  const v = volume(room);
  let n = 0, seen = 0;
  for (let x = v.xi0 + 0.1; x <= v.xi1 - 0.1; x += 0.25) for (let z = v.zi0 + 0.1; z <= v.z1 - 0.1; z += 0.25) {
    n++;
    const p = ndc(b, eye, tx, ty, x, room.floor, z);
    if (p && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) seen++;
  }
  let bn = 0, bs = 0;
  for (let x = v.xi0 + 0.05; x <= v.xi1 - 0.05; x += 0.1) {
    bn++;
    const lo = ndc(b, eye, tx, ty, x, room.floor, v.zi0), hi = ndc(b, eye, tx, ty, x, room.ceiling, v.zi0);
    if (lo && hi && Math.abs(lo.x) <= 1 && Math.abs(hi.x) <= 1 && lo.y >= -1 && hi.y <= 1) bs++;
  }
  return { floor: n ? seen / n : 0, back: bn ? bs / bn : 0 };
}

/** The frame for one pitch and fov: depth fitted exactly, x pan range, or undefined if the eye
 * would leave the enclosure or any frame ray would miss it. */
function frameFor(room: InteriorView, aspect: number, pitch: number, fov: number): (InteriorFrame & { size: number }) | undefined {
  const b = basis(pitch), v = volume(room);
  const ty = Math.tan(THREE.MathUtils.degToRad(fov) / 2), tx = ty * aspect;
  const low = THREE.MathUtils.degToRad(pitch + fov / 2), high = THREE.MathUtils.degToRad(pitch - fov / 2);
  if (low >= Math.PI / 2 - 0.05 || high <= 0.05) return undefined;
  const tb = Math.tan(low), tt = Math.tan(high);
  const zb = v.z1 - FRONT_MARGIN, C = room.ceiling - room.floor + TOP_MARGIN, D = zb - v.zi0;
  const H = (C + D * tt) / (1 - tt / tb), z = zb + H / tb, y = room.floor + H;
  if (y > v.top - KEEP || z > v.zf - KEEP) return undefined;
  const cx = (v.xi0 + v.xi1) / 2;
  const centre = new THREE.Vector3(cx, y, z);
  const cover = coverage(room, b, tx, ty, centre);
  // Pan range: only when the room is wider than the frame. The frame's half-width at the front
  // floor edge (its nearest floor): the eye may pan until that edge reaches a side wall.
  const near = (z - zb) * -b.F.z + (y - room.floor) * -b.F.y; // view depth of the front floor edge
  const half = near * tx;
  const slack = Math.max(0, (v.xi1 - v.xi0) / 2 - half);
  const xMin = cx - slack, xMax = cx + slack;
  for (const x of slack > 0 ? [xMin, cx, xMax] : [cx]) if (!validEye(room, b, tx, ty, new THREE.Vector3(x, y, z))) return undefined;
  const middle = new THREE.Vector3(cx, room.floor, (v.zi0 + v.z1) / 2);
  return { fov, pitch, y, z, xMin, xMax, floorShare: cover.floor, backShare: cover.back, size: playerSize({ fov, pitch }, aspect, centre, middle) };
}

/**
 * The room's frame for one aspect (cached): every pitch in INTERIOR_PITCH_RANGE and fov 20-70°
 * (1° steps, a few ms in all), scored: the player PLAYER_SIZE at the room's centre, then at least
 * FLOOR_MIN of the floor in view without panning, then the most floor and back wall, then a pitch
 * near the street's.
 */
const frames = new WeakMap<InteriorView, Map<number, InteriorFrame>>();
export function interiorFrame(room: InteriorView, aspect: number): InteriorFrame {
  aspect = Math.max(0.1, aspect);
  const cache = frames.get(room) ?? new Map<number, InteriorFrame>();
  frames.set(room, cache);
  const hit = cache.get(aspect);
  if (hit) return hit;
  let best: InteriorFrame | undefined, bestScore = -Infinity;
  for (let pitch = INTERIOR_PITCH_RANGE[0]; pitch <= INTERIOR_PITCH_RANGE[1]; pitch += 1)
    for (let fov = 20; fov <= 70; fov += 1) {
      const f = frameFor(room, aspect, pitch, fov);
      if (!f) continue;
      const off = Math.max(0, f.size - PLAYER_SIZE[1]) + Math.max(0, PLAYER_SIZE[0] - f.size);
      const score = -off * 1e4 - Math.max(0, FLOOR_MIN - f.floorShare) * 5e3 + f.floorShare * 100 + f.backShare * 50 - Math.abs(pitch - PITCH_PREFERRED);
      if (score > bestScore) { bestScore = score; best = f; }
    }
  const frame = best ?? { fov: 50, pitch: PITCH_PREFERRED, y: room.ceiling - 0.2, z: room.bounds.max[1] - 0.05, xMin: 0, xMax: 0, floorShare: 0, backShare: 0 };
  cache.set(aspect, frame);
  return frame;
}

/** Fit the camera to the room: the fixed eye, panned sideways only when the player leaves the dead
 * zone (and the room is wider than the frame). `blend` is the pan step (1: snap, centring the
 * player within the pan range). */
export function applyInteriorCamera(camera: THREE.PerspectiveCamera, room: InteriorView, focus: THREE.Vector3, blend = 1) {
  const aspect = Math.max(0.1, camera.aspect);
  const frame = interiorFrame(room, aspect);
  const b = basis(frame.pitch);
  camera.fov = frame.fov;
  camera.near = 0.04;
  if (camera.view) camera.clearViewOffset(); // scene UI lifting must not break the enclosure fit
  const clampX = (x: number) => THREE.MathUtils.clamp(x, frame.xMin, frame.xMax);
  let x: number;
  if (blend >= 1 || camera.position.y !== frame.y || camera.position.z !== frame.z) x = clampX(focus.x);
  else {
    x = clampX(camera.position.x);
    const ty = Math.tan(THREE.MathUtils.degToRad(frame.fov) / 2), tx = ty * aspect;
    const eye = new THREE.Vector3(x, frame.y, frame.z);
    const p = ndc(b, eye, tx, ty, focus.x, focus.y + HEAD_UP / 2, focus.z);
    if (p && Math.abs(p.x) > PAN_DEAD_ZONE) {
      const depth = (focus.y + HEAD_UP / 2 - frame.y) * b.F.y + (focus.z - frame.z) * b.F.z;
      const goal = clampX(focus.x - Math.sign(p.x) * PAN_DEAD_ZONE * depth * tx);
      x = Math.abs(goal - x) < 0.002 ? goal : x + (goal - x) * blend; // lands: no endless creep
    }
  }
  camera.position.set(x, frame.y, frame.z);
  camera.lookAt(camera.position.clone().add(b.F));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
