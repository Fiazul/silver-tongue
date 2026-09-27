// The town's far edge and its sky objects: what world.ts adds round the landscape GLBs so no
// camera sees past the ground or into a cloud, and the pure checks that prove it for every view
// the game has (the gameplay camera at every rim cell, the fly-over at 24 fps, desktop and phone).
//
// Measured from the GLBs (scripts/horizon-report.ts prints the table): the plateau (terrain_town)
// is a 140 m square, the apron runs from its edge out to r = 760 m (a 48-gon), the hills ring
// r 63-140 m, mountains_far covers only the bearings 300°-140° (r 130-604 m), the sky dome is
// r = 800 m, the clouds sat r 212-292 m at 70-123 m high, right across the fly-over's first
// seconds. So: a flat skirt of the apron's far grass from under its rim far past the haze, the
// mountains once more turned half round (the bearings 120°-320°), and the clouds moved up and out.
import * as THREE from "three";
import { poseAt } from "./cutscene";
import { gridClass, gridHeight, type CameraKey, type Vec3, type WalkGrid } from "./layout";

export const HORIZON = {
  /**
   * A flat ring under the apron's rim (its 48-gon's inscribed radius is 758.4 m) out past every
   * view's haze (the fly-over starts 393 m out; the haze is full at town.json fog.far): drawn lit
   * and fogged like the apron's far grass, so nothing below the horizon is ever background.
   */
  skirt: { inner: 757, outer: 3200, y: -0.8, colour: "#93AF86", segments: 64 },
  /**
   * Walls closing an open end where two landscape pieces meet at different heights (the seams
   * check in test/horizon.test.ts finds every such step on the plateau's rim): the canal's bed
   * runs out to the plateau's east edge at y -1.4 under the apron's rim at 0, a 5 m slot the
   * fly-over's canal shots looked through. Faces `facing` (toward the town), bank-stone grey.
   */
  caps: [{ name: "horizon_cap_canal_east", from: [70, -1.45, 15.5], to: [70, 0.02, 20.5], facing: [-1, 0, 0], colour: "#9D998E" }] as { name: string; from: Vec3; to: Vec3; facing: Vec3; colour: string }[],
  /** mountains_far again, turned about +y and scaled: fills the bearings the first ring leaves open */
  mountainEcho: { asset: "mountains_far", rotYDeg: 180, scale: 1.1 },
  /**
   * The clouds' new centres, by the source slot they replace (index.json clouds cloud_slots, the
   * same order): 150-190 m up (the plateau is at 0), 420-470 m out, none on the fly-over's bearing
   * (it comes in from 31°). Unfogged, as the sky dome: they sit in the sky, not on the ground.
   */
  clouds: [
    [-352, 170, -247], // was (-160, 95, -210)
    [-82, 190, -463], // was (60, 110, -260): the one the fly-over flew through
    [438, 160, -38], // was (230, 90, -120)
    [270, 150, 322], // was (250, 80, 90)
    [-352, 175, 247], // was (-240, 85, -40)
  ] as Vec3[],
  /** a cloud may not come nearer any camera than this, nor sit under the frame's centre */
  cloudClearance: 150,
};

const DEG = Math.PI / 180;

/** The skirt ring's geometry (y up, faces up), `segments` quads between the two radii. */
export function skirtGeometry(s = HORIZON.skirt): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < s.segments; k++) {
    const a = (2 * Math.PI * k) / s.segments;
    const c = Math.cos(a);
    const n = Math.sin(a);
    pos.push(s.inner * c, s.y, s.inner * n, s.outer * c, s.y, s.outer * n);
  }
  for (let k = 0; k < s.segments; k++) {
    const i = 2 * k;
    const j = 2 * ((k + 1) % s.segments);
    // wound so the normal is +y (inner k, inner k+1, outer k; inner k+1, outer k+1, outer k)
    idx.push(i, j, i + 1, j, j + 1, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Moves each cloud of a merged clouds mesh (one object, five clusters) to its new centre: every
 * vertex goes with the source slot nearest it (the clusters are 100+ m apart, each ~60 m across).
 * Works in the geometry's own frame (clouds.glb is at the origin, identity node transforms).
 */
export function moveClouds(geometry: THREE.BufferGeometry, from: Vec3[], to: Vec3[]): void {
  const p = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let best = 0;
    let bd = Infinity;
    from.forEach((s, k) => {
      const d = (s[0] - x) ** 2 + (s[1] - y) ** 2 + (s[2] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    const t = to[best] ?? from[best];
    p.setXYZ(i, x + t[0] - from[best][0], y + t[1] - from[best][1], z + t[2] - from[best][2]);
  }
  p.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

// ---------------------------------------------------------------------------------------------
// The checks (pure maths on three's camera; no renderer)
// ---------------------------------------------------------------------------------------------

/** A camera: where it is, what it looks at, its vertical fov and aspect. */
export interface View {
  name: string;
  pos: Vec3;
  lookAt: Vec3;
  fovDeg: number;
  aspect: number;
}

export function cameraFor(v: View, far = 2500): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(v.fovDeg, v.aspect, 0.5, far);
  cam.position.set(...v.pos);
  cam.lookAt(new THREE.Vector3(...v.lookAt));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** World-space ray directions over the image, an n x n grid of NDC points (edges included). */
export function viewRays(v: View, n = 17): THREE.Vector3[] {
  const cam = cameraFor(v);
  const out: THREE.Vector3[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3((2 * i) / (n - 1) - 1, (2 * j) / (n - 1) - 1, 0.5).unproject(cam);
      out.push(p.sub(cam.position).normalize());
    }
  return out;
}

/** The ground the views look over: a flat disc of `radius` at `y`, under a linear haze, to the far plane. */
export interface Backdrop {
  groundRadius: number;
  groundY: number;
  fogNear: number;
  fogFar: number;
  far: number;
}

export interface EdgeReport {
  /** rays below the horizon */
  below: number;
  /** of those, rays that cross the ground's edge where it still shows (haze under 99 %, inside the far plane) */
  open: number;
  /** the least haze at an edge crossing any ray saw (1: every crossing is lost in the haze) */
  minFog: number;
}

/**
 * Whether a view sees past the ground: for each ray below the horizon, where it leaves the ground
 * disc (hitting the plane further out than `groundRadius`), the view depth there (three's Fog is
 * by view depth) and the haze at that depth. A crossing under 99 % haze and nearer than the far
 * plane shows the disc's edge against the background. Hills and mountains in front are ignored
 * (conservative: they could only hide an edge).
 */
export function edgeExposure(v: View, b: Backdrop, n = 17): EdgeReport {
  const origin = new THREE.Vector3(...v.pos);
  const fwd = new THREE.Vector3(...v.lookAt).sub(origin).normalize();
  let below = 0;
  let open = 0;
  let minFog = 1;
  for (const d of viewRays(v, n)) {
    if (d.y >= -1e-6) continue;
    below++;
    const tHit = (b.groundY - origin.y) / d.y;
    const hx = origin.x + d.x * tHit;
    const hz = origin.z + d.z * tHit;
    if (Math.hypot(hx, hz) <= b.groundRadius) continue;
    // the far root of |o + t d|_xz = R: where the ray leaves the disc
    const a = d.x * d.x + d.z * d.z;
    const bb = 2 * (origin.x * d.x + origin.z * d.z);
    const c = origin.x * origin.x + origin.z * origin.z - b.groundRadius * b.groundRadius;
    const disc = bb * bb - 4 * a * c;
    const tEdge = disc < 0 || a < 1e-12 ? 0 : (-bb + Math.sqrt(disc)) / (2 * a);
    const depth = Math.max(0, tEdge) * d.dot(fwd);
    const fog = Math.min(1, Math.max(0, (depth - b.fogNear) / (b.fogFar - b.fogNear)));
    minFog = Math.min(minFog, depth >= b.far ? 1 : fog);
    if (fog < 0.99 && depth < b.far) open++;
  }
  return { below, open, minFog };
}

export interface CloudReport {
  /** the nearest any cloud's box comes to the camera, m */
  nearest: number;
  /** which cloud that is (index) */
  cloud: number;
  /** a cloud box in the frustum nearer than the clearance */
  close: boolean;
  /** the frame's centre ray passes through a cloud box (before the ground) */
  centre: boolean;
}

/** How near the clouds (world boxes) come to a view, and whether one is in the frame close up or at its centre. */
export function cloudExposure(v: View, boxes: THREE.Box3[], clearance = HORIZON.cloudClearance): CloudReport {
  const cam = cameraFor(v);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const origin = cam.position.clone();
  const ray = new THREE.Ray(origin, new THREE.Vector3(...v.lookAt).sub(origin).normalize());
  const toGround = ray.direction.y < 0 ? -origin.y / ray.direction.y : Infinity;
  let nearest = Infinity;
  let cloud = -1;
  let close = false;
  let centre = false;
  boxes.forEach((box, k) => {
    const d = box.distanceToPoint(origin);
    if (d < nearest) {
      nearest = d;
      cloud = k;
    }
    if (d < clearance && frustum.intersectsBox(box)) close = true;
    const hit = ray.intersectBox(box, new THREE.Vector3());
    if (hit && hit.distanceTo(origin) < toGround) centre = true;
  });
  return { nearest, cloud, close, centre };
}

/** The gameplay camera's pose (camera.ts CAMERA) aimed at a spot. */
export interface RigPose {
  elevationDeg: number;
  azimuthDeg: number;
  distance: number;
  aimHeight: number;
}

export function rigView(name: string, at: Vec3, rig: RigPose, fovDeg: number, aspect: number): View {
  const el = rig.elevationDeg * DEG;
  const az = rig.azimuthDeg * DEG;
  const aim: Vec3 = [at[0], at[1] + rig.aimHeight, at[2]];
  const off: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  return { name, pos: [aim[0] + off[0] * rig.distance, aim[1] + off[1] * rig.distance, aim[2] + off[2] * rig.distance], lookAt: aim, fovDeg, aspect };
}

/**
 * The rim of the walkable town: in each of `bins` bearings (from -z toward +x) the outermost grid
 * cell of class 1-5 (the town's edge there; the walkable area is no disc, so the rim is taken per
 * bearing, the outer 10 % of that bearing's reach).
 */
export function rimCells(grid: WalkGrid, bins = 36): { bearing: number; x: number; z: number; y: number; r: number }[] {
  const best = new Map<number, { x: number; z: number; r: number }>();
  for (let j = 0; j < grid.rows; j++)
    for (let i = 0; i < grid.cols; i++) {
      const x = grid.x0 + (i + 0.5) * grid.cell;
      const z = grid.z0 + (j + 0.5) * grid.cell;
      const c = gridClass(grid, x, z);
      if (c < 1 || c > 5) continue;
      const r = Math.hypot(x, z);
      const k = Math.floor(bearingOf(x, z) / (360 / bins));
      if (!best.has(k) || best.get(k)!.r < r) best.set(k, { x, z, r });
    }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, c]) => ({ bearing: (k + 0.5) * (360 / bins), x: c.x, z: c.z, y: gridHeight(grid, c.x, c.z), r: c.r }));
}

/** The fly-over at `fps` (the path's Hermite, as CameraPathPlayer), its fov scaled as the rig does on this screen. */
export function flyoverViews(keys: CameraKey[], aspect: number, fovScale: number, fps = 24, label = ""): View[] {
  const end = keys.at(-1)?.t ?? 0;
  const out: View[] = [];
  for (let f = 0; f <= Math.round(end * fps); f++) {
    const t = Math.min(end, f / fps);
    const p = poseAt(keys, t);
    out.push({ name: `${label}t=${t.toFixed(3)}`, pos: p.pos, lookAt: p.lookAt, fovDeg: p.fovDeg * fovScale, aspect });
  }
  return out;
}

/** The screens every check runs on: desktop landscape, phone portrait and landscape (the rig's fov rule, camera.ts resize). */
export const SCREENS = [
  { name: "desktop", aspect: 16 / 9 },
  { name: "phone-portrait", aspect: 390 / 844 },
  { name: "phone-landscape", aspect: 844 / 390 },
];

/** The play fov on a screen (camera.ts CameraRig.resize). */
export function playFov(baseFov: number, aspect: number): number {
  return aspect < 1 ? baseFov / Math.max(0.55, aspect) : baseFov;
}

/** A bearing in degrees (from -z toward +x, as town.json's sun) for a point. */
export function bearingOf(x: number, z: number): number {
  return ((Math.atan2(x, -z) / DEG) % 360 + 360) % 360;
}
