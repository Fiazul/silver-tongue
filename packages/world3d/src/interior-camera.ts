import * as THREE from "three";
import type { InteriorView } from "./layout";

/** Pitch for the small rooms: high enough to see the floor plan, low enough to read the far walls. */
export const INTERIOR_PITCH_DEG = 42;
const PITCH = THREE.MathUtils.degToRad(INTERIOR_PITCH_DEG);
const SIN = Math.sin(PITCH), COS = Math.cos(PITCH), DIAGONAL = Math.SQRT1_2;
const FORWARD = new THREE.Vector3(-COS * DIAGONAL, -SIN, -COS * DIAGONAL);
const RIGHT = new THREE.Vector3(DIAGONAL, 0, -DIAGONAL);
const UP = new THREE.Vector3(-SIN * DIAGONAL, COS, -SIN * DIAGONAL);
/** Eye inset from the outer wall planes. The near walls are not drawn and the shell is front-side
 * only, so the eye may sit (almost) on the near wall planes without showing a wall edge. */
const EDGE = 0.02;
/** Floor hits stay this far inside the footprint (inside the authored wall thickness). */
const FLOOR = 0.05;
/** Eye below the ceiling plane. */
const HEAD = 0.12;
/** The solver keeps at least this much eye region (m, each axis) for the follow. */
const SLACK = 0.5;
/** Frame limits: the top edge stays this far below the horizon; vertical / horizontal fov caps. */
const TOP_DROP = THREE.MathUtils.degToRad(8);
const VFOV_MAX = THREE.MathUtils.degToRad(72), HFOV_MAX = THREE.MathUtils.degToRad(84);
const VFOV_MIN = THREE.MathUtils.degToRad(24);

export interface InteriorFrame {
  /** vertical fov, degrees */
  fov: number;
  /** eye height above the floor */
  height: number;
  /** the valid eye region: every frustum corner lands on the floor or a far wall */
  x: [number, number];
  z: [number, number];
}

/** Floor hits (per metre of eye height) of the four frustum corner rays. */
function cornerOffsets(tangent: number, aspect: number) {
  const out: { x: number; z: number; bottom: boolean; dy: number }[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const ray = FORWARD.clone().addScaledVector(RIGHT, sx * tangent * aspect).addScaledVector(UP, sy * tangent);
    out.push({ x: -ray.x / ray.y, z: -ray.z / ray.y, bottom: sy < 0, dy: ray.y });
  }
  return out;
}

/** The eye region for one fov and height (empty when lo > hi). Every corner ray descends, so the
 * frustum's floor footprint is the convex quad of the corner hits: keeping those hits off the near
 * (+x, +z) side keeps every ray off the near walls, and the bottom hits on the floor keep the
 * lower edge off the outside. Rays towards -x / -z meet the far walls, which are drawn. */
function region(room: InteriorView, tangent: number, aspect: number, height: number) {
  const { min, max } = room.bounds;
  const hits = cornerOffsets(tangent, aspect);
  const bottom = hits.filter((h) => h.bottom);
  const x: [number, number] = [
    Math.max(min[0] + EDGE, min[0] + FLOOR - height * Math.min(...bottom.map((h) => h.x))),
    Math.min(max[0] - EDGE, max[0] - FLOOR - height * Math.max(...hits.map((h) => h.x))),
  ];
  const z: [number, number] = [
    Math.max(min[1] + EDGE, min[1] + FLOOR - height * Math.min(...bottom.map((h) => h.z))),
    Math.min(max[1] - EDGE, max[1] - FLOOR - height * Math.max(...hits.map((h) => h.z))),
  ];
  return { x, z };
}

/** The room's frame (fov, eye height, eye region) for one aspect: solveFrame, cached. */
const frames = new WeakMap<InteriorView, Map<number, InteriorFrame>>();
export function interiorFrame(room: InteriorView, aspect: number): InteriorFrame {
  aspect = Math.max(0.1, aspect);
  const cache = frames.get(room) ?? new Map<number, InteriorFrame>();
  frames.set(room, cache);
  const hit = cache.get(aspect);
  if (hit) return hit;
  const frame = solveFrame(room, aspect);
  cache.set(aspect, frame);
  return frame;
}

/** Heights tried below the highest eye (m, in steps) and the fov step (degrees): ~15 ms a solve,
 * once per room and aspect (interiorFrame caches it; room entry solves under the fade). */
const DROP = 1.0, DROP_STEP = 0.2, FOV_STEP = 2;

/** Foci the frame should be able to hold: the arrival point (must) and a grid over the room,
 * inset from the far walls by a body width and from the near walls by the strip the camera
 * stands over (at least FOCI_SHARE of the grid). */
const FOCI_SHARE = 0.9;
function framedFoci(room: InteriorView) {
  const { min, max } = room.bounds, n = 4;
  const x0 = min[0] + 0.6, x1 = max[0] - 1.5, z0 = min[1] + 0.6, z1 = max[1] - 1.5;
  const grid: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++)
    grid.push(new THREE.Vector3(x0 + ((x1 - x0) * i) / n, room.floor, z0 + ((z1 - z0) * j) / n));
  return { entry: room.entry && new THREE.Vector3(room.entry[0], room.floor, room.entry[1]), grid };
}

/** How well a frame holds the foci: the arrival point (and the player's screen height there,
 * 0-1 of the frame), and the share of the grid. */
function focusFit(room: InteriorView, frame: InteriorFrame, aspect: number) {
  const band = BANDS[BANDS.length - 1], { entry, grid } = framedFoci(room);
  const eye = entry && bestEye(frame, room, entry, aspect, band, 8);
  return {
    entry: !entry || !!eye,
    size: entry && eye ? playerSize(frame, eye, entry) : 1,
    share: grid.filter((f) => bestEye(frame, room, f, aspect, band, 8)).length / grid.length,
  };
}

/** The player's height on screen (fraction of the frame) seen from `eye`. */
function playerSize(frame: InteriorFrame, eye: THREE.Vector3, focus: THREE.Vector3) {
  const ty = Math.tan(THREE.MathUtils.degToRad(frame.fov) / 2);
  const ndc = (up: number) => {
    const vx = focus.x - eye.x, vy = focus.y + up - eye.y, vz = focus.z - eye.z;
    return (vx * UP.x + vy * UP.y + vz * UP.z) / ((vx * FORWARD.x + vy * FORWARD.y + vz * FORWARD.z) * ty);
  };
  return (ndc(HEAD_UP) - ndc(0)) / 2;
}

function solveFrame(room: InteriorView, aspect: number): InteriorFrame {
  const vMax = Math.min(VFOV_MAX, 2 * (PITCH - TOP_DROP), 2 * Math.atan(Math.tan(HFOV_MAX / 2) / aspect));
  const top = room.ceiling - room.floor - HEAD;
  let best: InteriorFrame | undefined, bestScore = -Infinity;
  for (let drop = 0; drop <= DROP + 1e-6; drop += DROP_STEP) {
    const height = top - drop;
    for (let deg = THREE.MathUtils.radToDeg(vMax); deg >= THREE.MathUtils.radToDeg(VFOV_MIN); deg -= FOV_STEP) {
      const r = region(room, Math.tan(THREE.MathUtils.degToRad(deg) / 2), aspect, height);
      if (r.x[1] - r.x[0] < SLACK || r.z[1] - r.z[0] < SLACK) continue;
      const frame = { fov: deg, height, x: r.x, z: r.z };
      const fit = focusFit(room, frame, aspect);
      const score = (fit.entry ? 1e4 : 0) + Math.min(fit.share, FOCI_SHARE) * 1e3 - fit.size * 300 - drop * 10;
      if (score > bestScore) { bestScore = score; best = frame; }
    }
  }
  if (best) return best;
  // No fov keeps SLACK: the widest region-valid frame at the highest eye.
  for (let deg = THREE.MathUtils.radToDeg(vMax); deg > 1; deg -= 1) {
    const r = region(room, Math.tan(THREE.MathUtils.degToRad(deg) / 2), aspect, top);
    if (r.x[1] >= r.x[0] && r.z[1] >= r.z[0]) return { fov: deg, height: top, x: r.x, z: r.z };
  }
  return { fov: THREE.MathUtils.radToDeg(VFOV_MIN), height: top, x: [0, 0], z: [0, 0] };
}

/** Screen bands (NDC) the player must stay in: strict first, then relaxed. Head 1.7 m up. */
const BANDS = [{ x: 0.6, top: 0.55, bottom: -0.8 }, { x: 0.88, top: 0.9, bottom: -0.94 }];
const HEAD_UP = 1.7;
const GRID = 24;
type Band = (typeof BANDS)[number];

/** The farthest eye (from the focus) in the region that keeps the player's feet and head in `band`. */
function bestEye(frame: InteriorFrame, room: InteriorView, focus: THREE.Vector3, aspect: number, band: Band, grid = GRID) {
  const y = room.floor + frame.height;
  const ty = Math.tan(THREE.MathUtils.degToRad(frame.fov) / 2), tx = ty * aspect;
  const [x0, x1] = [frame.x[0], Math.max(frame.x[0], frame.x[1])], [z0, z1] = [frame.z[0], Math.max(frame.z[0], frame.z[1])];
  const inBand = (ex: number, ez: number) => {
    for (const up of [0, HEAD_UP]) {
      const vx = focus.x - ex, vy = focus.y + up - y, vz = focus.z - ez;
      const depth = vx * FORWARD.x + vy * FORWARD.y + vz * FORWARD.z;
      if (depth <= 0.1) return false;
      const sx = (vx * RIGHT.x + vz * RIGHT.z) / (depth * tx);
      const sy = (vx * UP.x + vy * UP.y + vz * UP.z) / (depth * ty);
      if (Math.abs(sx) > band.x || sy > band.top || sy < band.bottom) return false;
    }
    return true;
  };
  let best: THREE.Vector3 | undefined, far = -1;
  for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
    const ex = x0 + ((x1 - x0) * i) / grid, ez = z0 + ((z1 - z0) * j) / grid;
    const d = Math.hypot(ex - focus.x, ez - focus.z);
    if (d > far + 1e-6 && inBand(ex, ez)) { far = d; best = new THREE.Vector3(ex, y, ez); }
  }
  return best;
}

/** The eye for `focus`: as far from the player as the room allows with them inside a screen band
 * (strict, then relaxed); centring (clamped) when no point qualifies. */
function target(frame: InteriorFrame, room: InteriorView, focus: THREE.Vector3, aspect: number) {
  for (const band of BANDS) {
    const eye = bestEye(frame, room, focus, aspect, band);
    if (eye) return eye;
  }
  const y = room.floor + frame.height, back = (y - (focus.y + 1)) / SIN; // centre 1 m above the feet
  return new THREE.Vector3(
    THREE.MathUtils.clamp(focus.x - FORWARD.x * back, frame.x[0], Math.max(frame.x[0], frame.x[1])), y,
    THREE.MathUtils.clamp(focus.z - FORWARD.z * back, frame.z[0], Math.max(frame.z[0], frame.z[1])));
}

/** Fit the camera to the room: every frustum ray lands on the floor or a far wall (never a near
 * wall, the ceiling or outside); within that, the eye stands as far from the player as the room
 * allows with them whole in the frame. `blend` is the follow step (1: snap). */
export function applyInteriorCamera(camera: THREE.PerspectiveCamera, room: InteriorView, focus: THREE.Vector3, blend = 1) {
  const frame = interiorFrame(room, camera.aspect);
  camera.fov = frame.fov;
  camera.near = 0.04;
  if (camera.view) camera.clearViewOffset(); // scene UI lifting must not break the enclosure clamp
  const goal = target(frame, room, focus, Math.max(0.1, camera.aspect));
  const eye = blend >= 1 ? goal : camera.position.clone().lerp(goal, blend);
  // Clamp after blending too: a resize can shrink the region under a moving camera.
  eye.x = THREE.MathUtils.clamp(eye.x, frame.x[0], Math.max(frame.x[0], frame.x[1]));
  eye.z = THREE.MathUtils.clamp(eye.z, frame.z[0], Math.max(frame.z[0], frame.z[1]));
  eye.y = goal.y;
  camera.position.copy(eye);
  camera.lookAt(camera.position.clone().add(FORWARD));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
