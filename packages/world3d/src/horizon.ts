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
// Then the countryside over it all (below): no green disc on a flat plain from any camera.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { poseAt } from "./cutscene";
import { gridClass, gridHeight, type CameraKey, type Vec3, type WalkGrid } from "./layout";

export const HORIZON = {
  /**
   * A flat ring under the apron's rim (its 48-gon's inscribed radius is 758.4 m) out past every
   * view's haze (the fly-over starts 393 m out; the haze is full at town.json fog.far): drawn lit
   * and fogged in the apron's far grass (the countryside ramp's far colour), so nothing below the
   * horizon is ever background.
   */
  skirt: { inner: 757, outer: 3200, y: -0.8, segments: 64 },
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
  /**
   * The countryside round the town (see Countryside below): the ground's colour runs from the
   * plateau's grass (measured: the apron's faces inside r `inner`) to the apron's own far grass
   * (its faces past `full`) by radius, baked into vertex colours of the apron, the skirt and the
   * mountains' feet; low hills (hills_ring's mounds) and willow clumps stand out on it.
   */
  countryside: {
    /** the colour ramp's radii: plateau grass up to `inner` (the hill ring's outer edge), the far grass from `full` */
    inner: 140,
    full: 400,
    /** mountains: their own colour from this height up, the ground's colour at their feet (y <= 0) */
    mountainBlend: [10, 150] as [number, number],
    /** mountain materials that keep their own colour all the way down (the snow caps) */
    mountainKeep: /snow/,
    hills: {
      count: 34,
      /** the first `belt` placed one per sector near the ring (r up to beltMax), the rest anywhere, denser near */
      belt: 16,
      beltMax: 235,
      rMin: 150,
      rMax: 600,
      scale: [0.6, 1.6] as [number, number],
      /** no hill's footprint nearer the centre than this (the plateau's corners reach 99 m; the rim camera ~115 m) */
      ringClear: 125,
      /** nor out past this (the apron's rim is 758 m) */
      edgeClear: 720,
      /** a mountain vertex higher than this (m) is its body: no hill within 0.85 of its footprint radius of one */
      mountainY: 4,
      seed: 0x51c7e1,
    },
    trees: {
      asset: "willow_small",
      clumps: 12,
      perClump: [3, 5] as [number, number],
      scale: [2.2, 3.2] as [number, number],
      rMin: 170,
      rMax: 470,
      seed: 0x7a11e5,
    },
  },
  /**
   * The checks' limits (test/horizon.test.ts, scripts/horizon-report.ts). `disc`: the largest
   * colour step (sRGB 0-1, any channel, after the haze) between neighbouring 2 m samples along a
   * screen column's line across the ground, in the band `band` (the hill ring's outer edge at
   * 140 m and the old apron's green edge at 165 m, with 10 m either side; discStep). `shape`: the share of the circle r `r`
   * with no extra hill within `within` m.
   */
  disc: { band: [130, 175] as [number, number], maxStep: 0.01 },
  shape: { r: 140, within: 60, maxOpen: 0.25 },
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

// ---------------------------------------------------------------------------------------------
// Countryside: the land round the town reads as one country, no disc (built at load, world.ts)
// ---------------------------------------------------------------------------------------------
//
// Measured (scripts/horizon-report.ts, section C): ground_apron is two meshes, grass_hill
// (#78A152, the plateau's own grass, from the plateau's edge out to a 96-gon at r 165 m) and
// grass_far (#93AF86, from there out to the 48-gon at r 760 m, a fan of 144 long triangles). From
// the air the first read as a green disc on a blue-grey plain, a hard colour step at r 165 m, with
// nothing but flat ground between the hill ring (r 63-140 m) and the mountains. So: the apron,
// the skirt and the mountains' feet take one radial colour ramp (vertex colours: the apron is
// split where the ramp needs it), and the hill ring's own mounds and willow clumps stand about
// the plain, all in one vertex-coloured material (one batch).

/** A mesh's geometry, its placement in the world and its material's colour (linear). */
export interface Part {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  colour: THREE.Color;
  /** its material's name (mountainKeep) */
  material?: string;
}

/** The ramp's two colours (linear): the plateau's grass and the apron's far grass. */
export interface Palette {
  near: THREE.Color;
  far: THREE.Color;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How far along the ramp radius `r` is: 0 inside `inner`, 1 from `full`. */
export function rampAt(r: number, c = HORIZON.countryside): number {
  return smoothstep(c.inner, c.full, r);
}

/** The ground's colour at radius `r`. */
export function groundColour(r: number, pal: Palette, out = new THREE.Color()): THREE.Color {
  return out.copy(pal.near).lerp(pal.far, rampAt(r));
}

/** What a colour at radius `r` is multiplied by to drift as the ground does (1 inside `inner`, far / near from `full`). */
export function rampTint(r: number, pal: Palette, out = new THREE.Color()): THREE.Color {
  const t = rampAt(r);
  return out.setRGB(1 + (pal.far.r / pal.near.r - 1) * t, 1 + (pal.far.g / pal.near.g - 1) * t, 1 + (pal.far.b / pal.near.b - 1) * t);
}

function triangles(g: THREE.BufferGeometry, fn: (a: number, b: number, c: number) => void) {
  const idx = g.index;
  const n = idx ? idx.count : g.getAttribute("position").count;
  for (let t = 0; t + 2 < n; t += 3) idx ? fn(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)) : fn(t, t + 1, t + 2);
}

/** A part's vertex colour times its material colour (linear). */
function partColour(p: Part, i: number, out: THREE.Color): THREE.Color {
  const c = p.geometry.getAttribute("color");
  out.copy(p.colour);
  if (c) out.multiply(new THREE.Color(c.getX(i), c.getY(i), c.getZ(i)));
  return out;
}

/** The colour seen from above: the parts' faces whose centroid passes `keep`, weighted by their area on the ground (linear). */
export function meanColour(parts: Part[], keep: (centroid: THREE.Vector3) => boolean): THREE.Color {
  const sum = [0, 0, 0];
  let area = 0;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const c = new THREE.Color();
  for (const p of parts) {
    const pos = p.geometry.getAttribute("position");
    triangles(p.geometry, (a, b, d) => {
      [a, b, d].forEach((i, k) => v[k].fromBufferAttribute(pos, i).applyMatrix4(p.matrix));
      const cen = v[0].clone().add(v[1]).add(v[2]).divideScalar(3);
      if (!keep(cen)) return;
      const A = Math.abs((v[1].x - v[0].x) * (v[2].z - v[0].z) - (v[2].x - v[0].x) * (v[1].z - v[0].z)) / 2;
      for (const i of [a, b, d]) {
        partColour(p, i, c);
        sum[0] += (c.r * A) / 3;
        sum[1] += (c.g * A) / 3;
        sum[2] += (c.b * A) / 3;
      }
      area += A;
    });
  }
  return area ? new THREE.Color(sum[0] / area, sum[1] / area, sum[2] / area) : new THREE.Color(0, 0, 0);
}

/**
 * The geometry cut along circles every `step` m between the ramp's radii (each face clipped into
 * the bands it crosses, each band fanned into triangles), so the vertex colours can follow the
 * ramp. A cut point on an edge depends only on the edge's two ends (interpolated in index order),
 * so neighbouring faces share it and no crack opens. Flat faces stay flat; normals interpolated.
 * Local frame kept; `matrix` places it in the world (the ramp is by world radius).
 */
export function subdivideForRamp(src: THREE.BufferGeometry, matrix: THREE.Matrix4, step = 13, c = HORIZON.countryside): THREE.BufferGeometry {
  const sp = src.getAttribute("position");
  const sn = src.getAttribute("normal");
  const levels: number[] = [];
  for (let r = c.inner; r < c.full + step / 2; r += (c.full - c.inner) / Math.round((c.full - c.inner) / step)) levels.push(r);
  const w = new THREE.Vector3();
  const radius: number[] = [];
  for (let i = 0; i < sp.count; i++) {
    w.fromBufferAttribute(sp, i).applyMatrix4(matrix);
    radius.push(Math.hypot(w.x, w.z));
  }
  // a vertex of the clipped polygons: a source vertex, or a point on the edge (i, j) at radius level L
  type V = { i: number; j: number; s: number };
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const made = new Map<string, number>();
  const emit = (v: V) => {
    const key = v.j < 0 ? `${v.i}` : `${v.i},${v.j},${v.s}`;
    let k = made.get(key);
    if (k !== undefined) return k;
    k = pos.length / 3;
    const f = v.j < 0 ? 0 : v.s;
    const lerp = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, n: number) => {
      const x = a.getComponent(v.i, n);
      return v.j < 0 ? x : x + (a.getComponent(v.j, n) - x) * f;
    };
    pos.push(lerp(sp, 0), lerp(sp, 1), lerp(sp, 2));
    if (sn) {
      const n = [lerp(sn, 0), lerp(sn, 1), lerp(sn, 2)];
      const l = Math.hypot(...n) || 1;
      nor.push(n[0] / l, n[1] / l, n[2] / l);
    } else nor.push(0, 1, 0);
    made.set(key, k);
    return k;
  };
  const rOf = (v: V) => (v.j < 0 ? radius[v.i] : radius[v.i] + (radius[v.j] - radius[v.i]) * v.s);
  // the point on edge a-b at radius L (a, b source vertices only: every cut lies on a source edge)
  const cut = (a: V, b: V, L: number): V => {
    // both ends of a clipped edge lie on one source edge (or are its ends): express on that edge in index order
    const ends = [a, b].flatMap((v) => (v.j < 0 ? [v.i] : [v.i, v.j]));
    const lo = Math.min(...ends);
    const hi = Math.max(...ends);
    const s = (L - radius[lo]) / (radius[hi] - radius[lo]);
    return { i: lo, j: hi, s };
  };
  const clip = (poly: V[], L: number, keepAbove: boolean): V[] => {
    const out: V[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const ia = keepAbove ? rOf(a) >= L : rOf(a) <= L;
      const ib = keepAbove ? rOf(b) >= L : rOf(b) <= L;
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b, L));
    }
    return out;
  };
  triangles(src, (a, b, d) => {
    const tri: V[] = [a, b, d].map((i) => ({ i, j: -1, s: 0 }));
    const lo = Math.min(radius[a], radius[b], radius[d]);
    const hi = Math.max(radius[a], radius[b], radius[d]);
    const inside = levels.filter((L) => L > lo && L < hi);
    if (!inside.length) {
      idx.push(emit(tri[0]), emit(tri[1]), emit(tri[2]));
      return;
    }
    const bounds = [-Infinity, ...inside, Infinity];
    for (let k = 0; k + 1 < bounds.length; k++) {
      let poly = tri;
      if (bounds[k] > -Infinity) poly = clip(poly, bounds[k], true);
      if (bounds[k + 1] < Infinity) poly = clip(poly, bounds[k + 1], false);
      if (poly.length < 3) continue;
      const ids = poly.map(emit);
      for (let q = 1; q + 1 < ids.length; q++) if (ids[0] !== ids[q] && ids[q] !== ids[q + 1] && ids[0] !== ids[q + 1]) idx.push(ids[0], ids[q], ids[q + 1]);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Writes the vertex colours: `colour(world position, vertex index)` per vertex. */
function bake(g: THREE.BufferGeometry, matrix: THREE.Matrix4, colour: (w: THREE.Vector3, i: number, out: THREE.Color) => THREE.Color) {
  const p = g.getAttribute("position");
  const out = new Float32Array(p.count * 3);
  const w = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    colour(w.fromBufferAttribute(p, i).applyMatrix4(matrix), i, c);
    out[3 * i] = c.r;
    out[3 * i + 1] = c.g;
    out[3 * i + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(out, 3));
  return g;
}

/** Ground: the ramp's colour at each vertex's radius. */
export function bakeGround(g: THREE.BufferGeometry, matrix: THREE.Matrix4, pal: Palette): THREE.BufferGeometry {
  return bake(g, matrix, (w, _i, out) => groundColour(Math.hypot(w.x, w.z), pal, out));
}

/** A mountain: the ground's colour at its feet (y <= blend[0]), its own colour from `blend[1]` up. */
export function bakeMountain(g: THREE.BufferGeometry, matrix: THREE.Matrix4, own: THREE.Color, pal: Palette, blend = HORIZON.countryside.mountainBlend): THREE.BufferGeometry {
  return bake(g, matrix, (w, _i, out) => groundColour(Math.hypot(w.x, w.z), pal, out).lerp(own, smoothstep(blend[0], blend[1], w.y)));
}

/** Anything standing on the ground (hills, trees): its own colour (the geometry's colour attribute) times the ramp's tint where it stands. */
export function bakeTinted(g: THREE.BufferGeometry, matrix: THREE.Matrix4, pal: Palette): THREE.BufferGeometry {
  const src = g.getAttribute("color");
  const tint = new THREE.Color();
  return bake(g, matrix, (w, i, out) => out.setRGB(src.getX(i), src.getY(i), src.getZ(i)).multiply(rampTint(Math.hypot(w.x, w.z), pal, tint)));
}

/** The parts' faces in the world frame as one indexed geometry, each vertex coloured by its part's material. */
export function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const p of parts) {
    const m = p.matrix;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const sp = p.geometry.getAttribute("position");
    const sn = p.geometry.getAttribute("normal");
    triangles(p.geometry, (a, b, d) => {
      for (const i of [a, b, d]) {
        v.fromBufferAttribute(sp, i).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(sn, i).applyMatrix3(nm).normalize();
        nor.push(v.x, v.y, v.z);
        partColour(p, i, c);
        col.push(c.r, c.g, c.b);
      }
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return mergeVertices(g, 1e-4);
}

/** One of hills_ring's mounds on its own: centred on its top in x/z (y as built: its base at -2, sunk), coloured by its materials. */
export interface Mound {
  geometry: THREE.BufferGeometry;
  /** footprint radius and top height, m */
  radius: number;
  height: number;
  /** its lowest y (the sunk base) */
  base: number;
}

/** hills_ring cut into its mounds: each face goes with the hill top (index.json hill_tops) its centroid is nearest. */
export function splitMounds(parts: Part[], tops: Vec3[]): Mound[] {
  const faces = tops.map(() => [] as { p: Part; a: number; b: number; c: number }[]);
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geometry.getAttribute("position");
    triangles(p.geometry, (a, b, c) => {
      const cen = [a, b, c].reduce((s, i) => s.add(v.fromBufferAttribute(pos, i).applyMatrix4(p.matrix)), new THREE.Vector3()).divideScalar(3);
      let k = 0;
      tops.forEach((t, j) => {
        if ((t[0] - cen.x) ** 2 + (t[2] - cen.z) ** 2 < (tops[k][0] - cen.x) ** 2 + (tops[k][2] - cen.z) ** 2) k = j;
      });
      faces[k].push({ p, a, b, c });
    });
  }
  return faces.map((fs, k) => {
    const shift = new THREE.Matrix4().makeTranslation(-tops[k][0], 0, -tops[k][2]);
    const one = new Map<Part, number[]>();
    for (const f of fs) (one.get(f.p) ?? one.set(f.p, []).get(f.p)!).push(f.a, f.b, f.c);
    const sub: Part[] = [...one.entries()].map(([p, idx]) => {
      const g = p.geometry.clone();
      g.setIndex(idx);
      return { geometry: g, matrix: shift.clone().multiply(p.matrix), colour: p.colour };
    });
    const geometry = mergeParts(sub);
    const pos = geometry.getAttribute("position");
    let radius = 0;
    let height = -Infinity;
    let base = Infinity;
    for (let i = 0; i < pos.count; i++) {
      radius = Math.max(radius, Math.hypot(pos.getX(i), pos.getZ(i)));
      height = Math.max(height, pos.getY(i));
      base = Math.min(base, pos.getY(i));
    }
    return { geometry, radius, height, base };
  });
}

/** A seeded generator in [0, 1) (mulberry32): the countryside is the same on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HillPlacement {
  mound: number;
  x: number;
  z: number;
  rotY: number;
  scale: number;
  /** its footprint radius and top height at this scale, m */
  radius: number;
  height: number;
}

/** Where the scatter may not go: the mountains' bodies (x/z of every vertex above `mountainY`) and the fly-over's sight lines. */
export interface Obstacles {
  peaks: [number, number][];
  views: View[];
}

/** The hill's surface height over the ground at distance `d` from its centre (a dome; 0 outside). */
export function domeHeight(h: { radius: number; height: number }, d: number): number {
  return d >= h.radius ? 0 : h.height * (1 - (d / h.radius) ** 2);
}

/** Whether a hill stands in a view's way: its dome within 6 m of the camera's line to what it looks at. */
export function blocksView(h: { x: number; z: number; radius: number; height: number }, views: View[], margin = 6): boolean {
  for (const v of views) {
    const [px, py, pz] = v.pos;
    const [lx, ly, lz] = v.lookAt;
    // the segment's nearest x/z approach first (cheap reject)
    const dx = lx - px;
    const dz = lz - pz;
    const L2 = dx * dx + dz * dz;
    const s0 = L2 ? Math.max(0, Math.min(1, ((h.x - px) * dx + (h.z - pz) * dz) / L2)) : 0;
    if (Math.hypot(px + dx * s0 - h.x, pz + dz * s0 - h.z) > h.radius + margin) continue;
    const len = Math.hypot(dx, ly - py, dz);
    const n = Math.max(2, Math.ceil(len / 3));
    for (let k = 0; k <= n; k++) {
      const s = k / n;
      const x = px + dx * s;
      const y = py + (ly - py) * s;
      const z = pz + dz * s;
      const d = Math.hypot(x - h.x, z - h.z);
      if (d < h.radius + margin && y < domeHeight(h, Math.max(0, d - margin)) + margin) return true;
    }
  }
  return false;
}

class PointGrid {
  private cells = new Map<string, [number, number][]>();
  constructor(
    points: [number, number][],
    private cell = 20,
  ) {
    for (const p of points) {
      const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(p);
    }
  }
  /** any point within `r` of (x, z) */
  near(x: number, z: number, r: number): boolean {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++)
        for (const p of this.cells.get(`${i},${j}`) ?? []) if ((p[0] - x) ** 2 + (p[1] - z) ** 2 < r * r) return true;
    return false;
  }
}

/**
 * The extra hills: `belt` of them one per sector of the circle just outside the ring (so every
 * bearing has one near), the rest anywhere out to `rMax`, denser near the ring. Each a random
 * mound, turned and scaled; clear of the ring (its footprint), of the apron's rim, of the
 * mountains' bodies, of each other (overlapping by at most a quarter) and of the fly-over's
 * sight lines. Deterministic (the seed).
 */
export function placeHills(mounds: Mound[], obstacles: Obstacles, o = HORIZON.countryside.hills): HillPlacement[] {
  const rnd = seeded(o.seed);
  const peaks = new PointGrid(obstacles.peaks);
  const out: HillPlacement[] = [];
  const candidate = (bearingDeg: number, r: number, scale: number, mound: number): HillPlacement => {
    const m = mounds[mound];
    return { mound, x: Math.sin(bearingDeg * DEG) * r, z: -Math.cos(bearingDeg * DEG) * r, rotY: rnd() * 2 * Math.PI, scale, radius: m.radius * scale, height: m.height * scale };
  };
  const ok = (h: HillPlacement) => {
    const r = Math.hypot(h.x, h.z);
    if (r < o.rMin || r > o.rMax || r - h.radius < o.ringClear || r + h.radius > o.edgeClear) return false;
    if (peaks.near(h.x, h.z, h.radius * 0.85)) return false;
    if (out.some((p) => Math.hypot(p.x - h.x, p.z - h.z) < 0.75 * (p.radius + h.radius))) return false;
    return !blocksView(h, obstacles.views);
  };
  const scale = () => o.scale[0] + rnd() * (o.scale[1] - o.scale[0]);
  const pick = () => Math.min(mounds.length - 1, Math.floor(rnd() * mounds.length));
  for (let k = 0; k < o.belt && out.length < o.count; k++) {
    const sector = 360 / o.belt;
    for (let a = 0; a < 60; a++) {
      const s = scale();
      const m = pick();
      const R = mounds[m].radius * s;
      const lo = Math.max(o.rMin, o.ringClear + R);
      const h = candidate((k + 0.5 + (rnd() - 0.5) * 0.9) * sector, lo + rnd() * Math.max(0, o.beltMax - lo), s, m);
      if (ok(h)) {
        out.push(h);
        break;
      }
    }
  }
  for (let a = 0; a < 6000 && out.length < o.count; a++) {
    const h = candidate(rnd() * 360, o.rMin + (o.rMax - o.rMin) * rnd() ** 1.7, scale(), pick());
    if (ok(h)) out.push(h);
  }
  return out;
}

export interface TreePlacement {
  x: number;
  z: number;
  rotY: number;
  scale: number;
}

/** Willow clumps on the plain: clear of the hills, the mountains and the fly-over's camera, 60 m apart. Deterministic. */
export function placeTrees(hills: HillPlacement[], obstacles: Obstacles, o = HORIZON.countryside.trees): TreePlacement[] {
  const rnd = seeded(o.seed);
  const peaks = new PointGrid(obstacles.peaks);
  const clumps: [number, number][] = [];
  const out: TreePlacement[] = [];
  for (let a = 0; a < 3000 && clumps.length < o.clumps; a++) {
    const b = rnd() * 2 * Math.PI;
    const r = o.rMin + (o.rMax - o.rMin) * rnd() ** 1.3;
    const x = Math.sin(b) * r;
    const z = -Math.cos(b) * r;
    if (hills.some((h) => Math.hypot(h.x - x, h.z - z) < h.radius + 12)) continue;
    if (peaks.near(x, z, 25) || clumps.some((c) => Math.hypot(c[0] - x, c[1] - z) < 60)) continue;
    if (obstacles.views.some((v) => Math.hypot(v.pos[0] - x, v.pos[2] - z) < 40 && v.pos[1] < 60)) continue;
    clumps.push([x, z]);
    const n = o.perClump[0] + Math.floor(rnd() * (o.perClump[1] - o.perClump[0] + 1));
    for (let k = 0; k < n; k++) {
      const a2 = rnd() * 2 * Math.PI;
      const d = k === 0 ? 0 : 4 + rnd() * 7;
      out.push({ x: x + Math.cos(a2) * d, z: z + Math.sin(a2) * d, rotY: rnd() * 2 * Math.PI, scale: o.scale[0] + rnd() * (o.scale[1] - o.scale[0]) });
    }
  }
  return out;
}

/**
 * The ground seen from above: every face of the parts (world frame) bucketed in x/z; `at` gives
 * the topmost face's height and colour (linear: material x vertex colour) at a point. Outside
 * `extent` (or on no face) nothing.
 */
export class Surface {
  private tri: Float32Array;
  private col: Float32Array;
  /** per cell, its faces: cellStart[k] .. cellStart[k + 1] in cellTris */
  private cellStart: Int32Array;
  private cellTris: Int32Array;
  private n: number;
  constructor(
    parts: Part[],
    private extent = 800,
    private cell = 10,
  ) {
    let count = 0;
    for (const p of parts) count += (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute("position").count) / 3;
    const T = (this.tri = new Float32Array(count * 9));
    const C = (this.col = new Float32Array(count * 9));
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    let o = 0;
    for (const p of parts) {
      const pos = p.geometry.getAttribute("position");
      const vc = p.geometry.getAttribute("color");
      triangles(p.geometry, (a, b, d) => {
        for (const i of [a, b, d]) {
          v.fromBufferAttribute(pos, i).applyMatrix4(p.matrix);
          c.copy(p.colour);
          if (vc) c.setRGB(c.r * vc.getX(i), c.g * vc.getY(i), c.b * vc.getZ(i));
          T[o] = v.x;
          T[o + 1] = v.y;
          T[o + 2] = v.z;
          C[o] = c.r;
          C[o + 1] = c.g;
          C[o + 2] = c.b;
          o += 3;
        }
      });
    }
    const n = (this.n = Math.ceil((2 * extent) / cell));
    const range = (t: number) => {
      const q = 9 * t;
      const cl = (x: number) => Math.min(n - 1, Math.max(0, Math.floor((x + extent) / cell)));
      return [cl(Math.min(T[q], T[q + 3], T[q + 6])), cl(Math.max(T[q], T[q + 3], T[q + 6])), cl(Math.min(T[q + 2], T[q + 5], T[q + 8])), cl(Math.max(T[q + 2], T[q + 5], T[q + 8]))];
    };
    const outside = (t: number) => {
      const q = 9 * t;
      return Math.max(T[q], T[q + 3], T[q + 6]) < -extent || Math.min(T[q], T[q + 3], T[q + 6]) > extent || Math.max(T[q + 2], T[q + 5], T[q + 8]) < -extent || Math.min(T[q + 2], T[q + 5], T[q + 8]) > extent;
    };
    const start = new Int32Array(n * n + 1);
    for (let t = 0; t < count; t++) {
      if (outside(t)) continue;
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * n + i + 1]++;
    }
    for (let k = 0; k < n * n; k++) start[k + 1] += start[k];
    const fill = start.slice(0, n * n);
    const tris = new Int32Array(start[n * n]);
    for (let t = 0; t < count; t++) {
      if (outside(t)) continue;
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) tris[fill[j * n + i]++] = t;
    }
    this.cellStart = start;
    this.cellTris = tris;
  }

  /** the topmost face at (x, z): its height there and colour (into `out`), or null */
  at(x: number, z: number, out = new THREE.Color()): { y: number; colour: THREE.Color } | null {
    const i = Math.floor((x + this.extent) / this.cell);
    const j = Math.floor((z + this.extent) / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return null;
    let best = -Infinity;
    const T = this.tri;
    const k = j * this.n + i;
    for (let e = this.cellStart[k]; e < this.cellStart[k + 1]; e++) {
      const o = 9 * this.cellTris[e];
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const y = w0 * T[o + 1] + w1 * T[o + 4] + w2 * T[o + 7];
      if (y <= best) continue;
      best = y;
      const C = this.col;
      out.setRGB(w0 * C[o] + w1 * C[o + 3] + w2 * C[o + 6], w0 * C[o + 1] + w1 * C[o + 4] + w2 * C[o + 7], w0 * C[o + 2] + w1 * C[o + 5] + w2 * C[o + 8]);
    }
    return best === -Infinity ? null : { y: best, colour: out };
  }

  height(x: number, z: number, fallback = 0): number {
    return this.at(x, z)?.y ?? fallback;
  }
}

/**
 * The hills and trees as one world-frame geometry, coloured (their materials times the ramp's
 * tint where each vertex stands), each hill's base sunk under `ground` (its lowest vertices 0.1 m
 * below the ground under them, its own ground level no higher than the ground at its centre).
 */
export function scatterGeometry(mounds: Mound[], hills: HillPlacement[], tree: THREE.BufferGeometry | null, trees: TreePlacement[], ground: Surface, pal: Palette): THREE.BufferGeometry {
  const items: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  const v = new THREE.Vector3();
  const place = (x: number, y: number, z: number, rotY: number, s: number) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(s, s, s));
  for (const h of hills) {
    const m = mounds[h.mound];
    const flat = place(h.x, 0, h.z, h.rotY, h.scale);
    const p = m.geometry.getAttribute("position");
    let y = ground.height(h.x, h.z);
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > m.base + 0.1) continue;
      v.fromBufferAttribute(p, i).applyMatrix4(flat);
      y = Math.min(y, ground.height(v.x, v.z) - v.y - 0.1);
    }
    items.push({ g: m.geometry, m: place(h.x, y, h.z, h.rotY, h.scale) });
  }
  if (tree) for (const t of trees) items.push({ g: tree, m: place(t.x, ground.height(t.x, t.z) - 0.3 * t.scale, t.z, t.rotY, t.scale) });
  let nv = 0;
  let ni = 0;
  for (const it of items) {
    nv += it.g.getAttribute("position").count;
    ni += it.g.index ? it.g.index.count : it.g.getAttribute("position").count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const idx = new Uint32Array(ni);
  const tint = new THREE.Color();
  let ov = 0;
  let oi = 0;
  for (const { g, m } of items) {
    const gp = g.getAttribute("position");
    const gn = g.getAttribute("normal");
    const gc = g.getAttribute("color");
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(m);
      const k = 3 * (ov + i);
      pos[k] = v.x;
      pos[k + 1] = v.y;
      pos[k + 2] = v.z;
      rampTint(Math.hypot(v.x, v.z), pal, tint);
      col[k] = gc.getX(i) * tint.r;
      col[k + 1] = gc.getY(i) * tint.g;
      col[k + 2] = gc.getZ(i) * tint.b;
      v.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      nor[k] = v.x;
      nor[k + 1] = v.y;
      nor[k + 2] = v.z;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[oi++] = ov + g.index.getX(i);
    else for (let i = 0; i < gp.count; i++) idx[oi++] = ov + i;
    ov += gp.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** What world.ts gives the countryside: the landscape's meshes as loaded (world matrices, material colours). */
export interface CountrysideInput {
  apron: Part[];
  /** both mountain rings' meshes */
  mountains: Part[];
  hillsRing: Part[];
  hillTops: Vec3[];
  /** the tree asset's meshes (its own frame, feet at the origin), or none */
  tree: Part[];
  /** the fly-over's frames (placement keeps out of their sight lines) */
  views: View[];
}

export interface Countryside {
  palette: Palette;
  /** the apron's meshes split for the ramp and coloured, each in its part's own frame (input order) */
  apron: THREE.BufferGeometry[];
  /** the mountains' meshes coloured (input order, own frame) */
  mountains: THREE.BufferGeometry[];
  /** the skirt, coloured */
  skirt: THREE.BufferGeometry;
  mounds: Mound[];
  hills: HillPlacement[];
  trees: TreePlacement[];
  /** hills and trees, world frame */
  scatter: THREE.BufferGeometry;
  /** the ground it changed, coloured (the apron, world frame, and the skirt): with the plateau, what the disc check samples */
  ground: Part[];
}

/** Everything the countryside adds or changes, from the landscape as loaded (pure: the tests and the report run it on the GLBs). */
export function buildCountryside(input: CountrysideInput, c = HORIZON.countryside): Countryside {
  const palette: Palette = {
    near: meanColour(input.apron, (p) => Math.hypot(p.x, p.z) < c.inner),
    far: meanColour(input.apron, (p) => Math.hypot(p.x, p.z) > c.full),
  };
  const apron = input.apron.map((p) => bakeGround(subdivideForRamp(p.geometry, p.matrix), p.matrix, palette));
  const mountains = input.mountains.map((p) => bakeMountain(p.geometry.clone(), p.matrix, p.colour, palette, c.mountainKeep.test(p.material ?? "") ? [-2e9, -1e9] : c.mountainBlend));
  const skirt = bakeGround(skirtGeometry(), new THREE.Matrix4(), palette);
  const white = new THREE.Color(1, 1, 1);
  const ground: Part[] = [...input.apron.map((p, i) => ({ geometry: apron[i], matrix: p.matrix, colour: white })), { geometry: skirt, matrix: new THREE.Matrix4(), colour: white }];
  // the hills and trees stand on the apron only (none nearer than ringClear, none past the apron's rim)
  const under = new Surface(ground.slice(0, -1), c.hills.edgeClear + 20, 40);
  const peaks: [number, number][] = [];
  const w = new THREE.Vector3();
  for (const p of input.mountains) {
    const pos = p.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      w.fromBufferAttribute(pos, i).applyMatrix4(p.matrix);
      if (w.y > c.hills.mountainY) peaks.push([w.x, w.z]);
    }
  }
  const obstacles: Obstacles = { peaks, views: input.views };
  const mounds = splitMounds(input.hillsRing, input.hillTops);
  const hills = placeHills(mounds, obstacles, c.hills);
  const tree = input.tree.length ? mergeParts(input.tree) : null;
  const trees = tree ? placeTrees(hills, obstacles, c.trees) : [];
  const scatter = scatterGeometry(mounds, hills, tree, trees, under, palette);
  return { palette, apron, mountains, skirt, mounds, hills, trees, scatter, ground };
}

// ---------------------------------------------------------------------------------------------
// The countryside's checks (pure: the ground's colours, no GPU)
// ---------------------------------------------------------------------------------------------

/** The haze: its colour (linear; the sky dome's lighter colour, as world.ts) and the town's near/far. */
export interface Haze {
  colour: THREE.Color;
  near: number;
  far: number;
}

/** The sky dome's horizon colour: the lighter (HSL) of its colours (world.ts addSky). */
export function hazeColour(sky: THREE.Color[]): THREE.Color | undefined {
  const hsl = { h: 0, s: 0, l: 0 };
  const l = (c: THREE.Color) => c.getHSL(hsl).l;
  return [...sky].sort((a, b) => l(b) - l(a))[0]?.clone();
}

export interface DiscReport {
  /** the largest colour step (sRGB 0-1, any channel) between neighbouring 2 m samples in the band, after the haze */
  step: number;
  /** the same in luma (Rec. 601) */
  luma: number;
  /** sample pairs in the band */
  pairs: number;
}

/**
 * Whether a view sees the ground's colour step at the ring. Down each of `cols` screen columns,
 * `rows` rays to the ground (y 0, the plain): the column's hits lie on one line across the ground,
 * walked in `stepM` m steps wherever it runs through `band` (radius, m); each step's colour (sRGB)
 * from `ground` (its topmost face there), its haze as three's Fog has it (linear by view depth,
 * interpolated between the rows). The largest colour change between neighbouring steps, times what
 * the haze leaves of it: the ground's own step as seen, not the haze's gradient (steep near the
 * horizon, the same over any ground), and the same at any screen resolution (a hard edge is its
 * full step, a ramp over 260 m a fraction of a level per step).
 */
export function discStep(v: View, ground: Surface, haze: Haze, band = HORIZON.disc.band, cols = 33, rows = 360, stepM = 2): DiscReport {
  const cam = cameraFor(v);
  const origin = cam.position.clone();
  const fwd = new THREE.Vector3(...v.lookAt).sub(origin).normalize();
  // the camera's basis: a ray through NDC (x, y) is fwd + x tan(fov/2) aspect right + y tan(fov/2) up
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  const ty = Math.tan((v.fovDeg * DEG) / 2);
  const tx = ty * v.aspect;
  const c = new THREE.Color();
  const p = new THREE.Vector3();
  const inBand = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    return r >= band[0] && r <= band[1];
  };
  let step = 0;
  let luma = 0;
  let pairs = 0;
  for (let i = 0; i < cols; i++) {
    let prev: { x: number; z: number; f: number } | null = null;
    for (let j = 0; j < rows; j++) {
      const nx = ((2 * i) / (cols - 1) - 1) * tx;
      const ny = (1 - (2 * j) / (rows - 1)) * ty;
      p.set(fwd.x + nx * right.x + ny * up.x, fwd.y + nx * right.y + ny * up.y, fwd.z + nx * right.z + ny * up.z).normalize();
      if (p.y >= -1e-6) {
        prev = null;
        continue;
      }
      const t = -origin.y / p.y;
      const depth = t * p.dot(fwd);
      const cur = { x: origin.x + p.x * t, z: origin.z + p.z * t, f: Math.min(1, Math.max(0, (depth - haze.near) / (haze.far - haze.near))) };
      if (prev) {
        // the stretch of ground between the two rows' hits inside the band's outer circle
        const dx = cur.x - prev.x;
        const dz = cur.z - prev.z;
        const A = dx * dx + dz * dz;
        const B = 2 * (prev.x * dx + prev.z * dz);
        const C = prev.x * prev.x + prev.z * prev.z - band[1] * band[1];
        const disc = B * B - 4 * A * C;
        const s0 = disc > 0 && A > 1e-12 ? Math.max(0, (-B - Math.sqrt(disc)) / (2 * A)) : 1;
        const s1 = disc > 0 && A > 1e-12 ? Math.min(1, (-B + Math.sqrt(disc)) / (2 * A)) : 0;
        if (s1 > s0) {
          const n = Math.max(1, Math.ceil((Math.sqrt(A) * (s1 - s0)) / stepM));
          let last: { c: THREE.Color; f: number } | null = null;
          for (let k = 0; k <= n; k++) {
            const s = s0 + ((s1 - s0) * k) / n;
            const x = prev.x + (cur.x - prev.x) * s;
            const z = prev.z + (cur.z - prev.z) * s;
            if (!inBand(x, z)) {
              last = null;
              continue;
            }
            const hit = ground.at(x, z, c);
            if (!hit) {
              last = null;
              continue;
            }
            const here = { c: hit.colour.clone().convertLinearToSRGB(), f: prev.f + (cur.f - prev.f) * s };
            if (last) {
              pairs++;
              const keep = 1 - (here.f + last.f) / 2;
              const d = keep * Math.max(Math.abs(here.c.r - last.c.r), Math.abs(here.c.g - last.c.g), Math.abs(here.c.b - last.c.b));
              const l = keep * Math.abs(0.299 * (here.c.r - last.c.r) + 0.587 * (here.c.g - last.c.g) + 0.114 * (here.c.b - last.c.b));
              step = Math.max(step, d);
              luma = Math.max(luma, l);
            }
            last = here;
          }
        }
      }
      prev = cur;
    }
  }
  return { step, luma, pairs };
}

/** The share of the circle r `s.r` with no hill's footprint within `s.within` m (1° steps). */
export function ringOpen(hills: { x: number; z: number; radius: number }[], s = HORIZON.shape, steps = 360): number {
  let open = 0;
  for (let k = 0; k < steps; k++) {
    const a = (2 * Math.PI * k) / steps;
    const x = Math.sin(a) * s.r;
    const z = -Math.cos(a) * s.r;
    if (!hills.some((h) => Math.hypot(h.x - x, h.z - z) - h.radius <= s.within)) open++;
  }
  return open / steps;
}

/** ringOpen over the part of the circle a view has in its frame (null: none of it in frame). */
export function ringOpenInView(v: View, hills: { x: number; z: number; radius: number }[], s = HORIZON.shape, steps = 360): number | null {
  const cam = cameraFor(v);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const p = new THREE.Vector3();
  let seen = 0;
  let open = 0;
  for (let k = 0; k < steps; k++) {
    const a = (2 * Math.PI * k) / steps;
    p.set(Math.sin(a) * s.r, 0, -Math.cos(a) * s.r);
    if (!frustum.containsPoint(p)) continue;
    seen++;
    if (!hills.some((h) => Math.hypot(h.x - p.x, h.z - p.z) - h.radius <= s.within)) open++;
  }
  return seen ? open / seen : null;
}
