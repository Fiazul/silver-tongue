// The real look's environment layers (look.ts `?look=real&env=...`), built by reallook.ts for each
// space the first time it renders; nothing here is reachable without `?look=real`. Town layers:
//   ground    the terrain's grass / path materials take world-projected, generated textures
//             (grass, packed dirt, a detail normal), dirt worn in along the path edges (a distance
//             field rasterised from the terrain's own triangles) and in noise patches;
//   grass     instanced blade cards (2 tris each) on the grass cells round the player, coloured from
//             the ground under them, swaying in the wind, fading out with distance;
//   leaves    alpha-cut leaf-cluster cards over every tree canopy (the solid canopy stays, darker, as
//             the crown's core; the cards cast the shadows, a speckle on the ground);
//   sky       a gradient sky with a sun disc, glow and drifting cloud wisps in place of the dome,
//             from the day's sky colours (the environment map takes the sun's glow too: reallook.ts);
//   particles dust motes round the player, steam off the noodle shop's counter, leaves falling.
// Renderer layers (reallook.ts): bloom (evening emissives here: lanterns, lamp glass, windows) and
// the colour grade. Imports nothing of the main bundle but three (a shared module would split it).
import * as THREE from "three";
import type { LookGround, LookSky } from "./look";

export interface EnvDeps {
  /** seethrough.ts patchSeeThrough (passed in: importing it would split it off the main bundle) */
  seeThrough: (m: THREE.Material) => void;
  /** seethrough.ts SEE_ATTR: the per-vertex fade id the leaf cards copy from their canopy */
  seeAttr: string;
  /** materials the AO pass must not see (reallook.ts hides them for its normal / depth pass) */
  aoHidden: THREE.Material[];
}

/** The terrain field: a top-down raster of the town's ground, [-70, 70]^2 (terrain_town's extent). */
export const FIELD = { min: -70, size: 140, n: 512 };
/** Grass: two toroidal tiles of blades round the player (near: dense, far: sparser, wider blades). */
const GRASS = {
  near: { tile: 26, n: 200, fade: [9, 12.5], size: [0.065, 0.27] },
  far: { tile: 72, n: 200, fade: [27, 35], size: [0.12, 0.34] },
};
const LEAVES = { max: 14000, perM2: 1.1, size: [0.9, 1.5], minY: 1.6 };
const GRASS_RE = /^grass_/;
const GROUND_RE = /^land_(path|dirt|plaza|plaza_ring|stone_edge|bank_stone|coping)$/;
const WATER_RE = /^water_/;
/** seethrough.ts CANOPIES' parts (not imported: the main bundle's) */
const CANOPY_RE = /^(canopy_green|leaf_green|leaf_dark|leaf_pale|town_willow)$/;

// ---------------------------------------------------------------------------------------------
// Generated textures (tileable value noise; no binary assets)
// ---------------------------------------------------------------------------------------------

function hash(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** periodic value noise, `period` lattice cells across the tile */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const m = (v: number) => ((v % period) + period) % period;
  const a = hash(m(xi), m(yi), seed);
  const b = hash(m(xi + 1), m(yi), seed);
  const c = hash(m(xi), m(yi + 1), seed);
  const d = hash(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** tileable fbm over [0,1)^2 (u, v), `period` cells at the first octave */
function fbm(u: number, v: number, period: number, seed: number, octaves = 4): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(u * p, v * p, p, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return s / norm;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dataTexture(data: Uint8Array, n: number, opts: { repeat?: boolean; srgb?: boolean } = {}): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = opts.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

interface GroundTextures {
  /** grass colour variation, x2 = a multiplier on the material's colour (mean ~1) */
  grass: THREE.DataTexture;
  /** packed dirt / gravel variation, x2 multiplier */
  dirt: THREE.DataTexture;
  /** detail normal slopes: RG grass, BA dirt (0.5 = flat) */
  normal: THREE.DataTexture;
  /** macro noise: R broad patches, G tone, B gusts */
  macro: THREE.DataTexture;
}

function groundTextures(): GroundTextures {
  const N = 256;
  const rnd = makeRng(7);
  const gh = new Float32Array(N * N); // grass height
  const dh = new Float32Array(N * N); // dirt height
  const grass = new Uint8Array(N * N * 4);
  const dirt = new Uint8Array(N * N * 4);
  const gv = new Float32Array(N * N); // grass value
  const gy = new Float32Array(N * N); // grass dryness
  const dv = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N;
      const v = y / N;
      gv[i] = (fbm(u, v, 6, 1) - 0.5) * 0.5 + (fbm(u, v, 24, 2, 2) - 0.5) * 0.35;
      gy[i] = fbm(u, v, 4, 3, 3);
      gh[i] = fbm(u, v, 32, 4, 2) * 0.3;
      dv[i] = (fbm(u, v, 8, 5) - 0.5) * 0.45 + (fbm(u, v, 48, 6, 2) - 0.5) * 0.35;
      dh[i] = fbm(u, v, 40, 7, 3) * 0.35;
    }
  const wrap = (x: number, y: number) => ((((y % N) + N) % N) * N + (((x % N) + N) % N));
  // grass: short blade strokes, lighter and darker, mostly upright-ish in any direction (top-down)
  for (let s = 0; s < 5200; s++) {
    const x0 = rnd() * N;
    const y0 = rnd() * N;
    const a = rnd() * Math.PI * 2;
    const len = 3 + rnd() * 7;
    const dv0 = (rnd() - 0.45) * 0.55;
    for (let t = 0; t < len; t++) {
      const i = wrap(Math.round(x0 + Math.cos(a) * t), Math.round(y0 + Math.sin(a) * t));
      const k = 1 - t / len;
      gv[i] += dv0 * (0.5 + 0.5 * k);
      gh[i] += 0.5 * k;
    }
  }
  // dirt: pebbles (a lit dome, a dark rim), a few fine cracks of darker grit
  for (let s = 0; s < 900; s++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const r = 0.8 + rnd() * rnd() * 2.6;
    const tone = (rnd() - 0.35) * 0.22;
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        const i = wrap(x, y);
        if (d < 1) {
          dv[i] += tone * (1 - 0.3 * ((x - cx + (y - cy)) / r));
          dh[i] += Math.sqrt(1 - d * d) * r * 0.12;
        } else if (d < 1.3) dv[i] -= 0.03;
      }
  }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const g = gv[i];
      const dry = Math.max(0, gy[i] - 0.55) * 1.6;
      const o = i * 4;
      const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v * 127.5)));
      grass[o] = cl(1 + g + dry * 0.35);
      grass[o + 1] = cl(1 + g * 0.9 + dry * 0.12);
      grass[o + 2] = cl(1 + g * 0.8 - dry * 0.25);
      grass[o + 3] = 255;
      const d = dv[i];
      dirt[o] = cl(1 + d);
      dirt[o + 1] = cl(1 + d * 0.95);
      dirt[o + 2] = cl(1 + d * 0.88);
      dirt[o + 3] = 255;
    }
  const normal = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      const sl = (h: Float32Array, k: number) => [(h[wrap(x + 1, y)] - h[wrap(x - 1, y)]) * k, (h[wrap(x, y + 1)] - h[wrap(x, y - 1)]) * k];
      const [gx, gz] = sl(gh, 0.5);
      const [dx, dz] = sl(dh, 0.5);
      const e = (v: number) => Math.max(0, Math.min(255, Math.round((0.5 + v * 0.5) * 255)));
      normal[o] = e(gx);
      normal[o + 1] = e(gz);
      normal[o + 2] = e(dx);
      normal[o + 3] = e(dz);
    }
  const M = 128;
  const macro = new Uint8Array(M * M * 4);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      const o = (y * M + x) * 4;
      const u = x / M;
      const v = y / M;
      macro[o] = Math.round(fbm(u, v, 3, 11, 4) * 255);
      macro[o + 1] = Math.round(fbm(u, v, 5, 12, 3) * 255);
      macro[o + 2] = Math.round(fbm(u, v, 4, 13, 3) * 255);
      macro[o + 3] = 255;
    }
  return { grass: dataTexture(grass, N), dirt: dataTexture(dirt, N), normal: dataTexture(normal, N), macro: dataTexture(macro, M) };
}

/** A leaf-cluster card: ~40 small leaves in a rough round clump, alpha-cut. */
function leafTexture(): THREE.DataTexture {
  const N = 256;
  const rnd = makeRng(21);
  const data = new Uint8Array(N * N * 4);
  const leaves = Array.from({ length: 40 }, () => {
    // denser toward the middle; each leaf points roughly away from the clump's centre
    const r = Math.sqrt(rnd()) * N * 0.36;
    const t = rnd() * Math.PI * 2;
    const cx = N / 2 + Math.cos(t) * r;
    const cy = N / 2 + Math.sin(t) * r;
    return { cx, cy, a: t + (rnd() - 0.5) * 1.6, len: 13 + rnd() * 9, wid: 5.5 + rnd() * 3, tone: 0.72 + rnd() * 0.4, hue: rnd() };
  });
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      let best = 0;
      let col: [number, number, number] = [0, 0, 0];
      for (const l of leaves) {
        const dx = x - l.cx;
        const dy = y - l.cy;
        const c = Math.cos(l.a);
        const s = Math.sin(l.a);
        const lu = (dx * c + dy * s) / l.len; // along the leaf
        const lv = (-dx * s + dy * c) / l.wid;
        // a pointed ellipse: narrower toward the tip
        const w = 1 - Math.abs(lu);
        if (w <= 0) continue;
        const shape = 1 - (lv * lv) / (w * (1.3 - 0.3 * lu));
        if (shape <= 0) continue;
        const a = Math.min(1, shape * 6);
        if (a > best) {
          best = a;
          const rib = Math.abs(lv) < 0.08 ? 0.82 : 1;
          const edge = 0.8 + 0.2 * Math.min(1, shape * 2.5);
          const t = l.tone * rib * edge;
          col = [t * (0.86 + l.hue * 0.2), t, t * (0.7 + l.hue * 0.12)];
        }
      }
      data[o] = Math.round(Math.min(1, col[0]) * 255);
      data[o + 1] = Math.round(Math.min(1, col[1]) * 255);
      data[o + 2] = Math.round(Math.min(1, col[2]) * 255);
      data[o + 3] = Math.round(best * 255);
    }
  const t = dataTexture(data, N, { repeat: false, srgb: true });
  // DataTexture rows: row 0 is v = 0 (the card's bottom): the twig at the bottom
  t.flipY = false;
  return t;
}

// ---------------------------------------------------------------------------------------------
// The terrain field: grass (1) / other ground, distance to the nearest non-grass (m), top height,
// the ground's colour; rasterised from the terrain's triangles (top surface wins) + the footprints
// ---------------------------------------------------------------------------------------------

export interface Field {
  /** RGBA half float: R grass 0/1, G distance to non-grass (m, capped 8), B surface y */
  tex: THREE.DataTexture;
  /** RGBA8: the surface's own colour (linear), for the blades */
  albedo: THREE.DataTexture;
  grass: Uint8Array;
  height: Float32Array;
}

function meshName(m: THREE.Mesh): string {
  return Array.isArray(m.material) ? "" : (m.material as THREE.Material).name;
}

export function buildField(scene: THREE.Scene, ground: LookGround): Field {
  const { min, size, n } = FIELD;
  const cell = size / n;
  const kind = new Uint8Array(n * n); // 0 nothing, 1 grass, 2 ground, 3 water
  const top = new Float32Array(n * n).fill(-1e9);
  const alb = new Float32Array(n * n * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.outline || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const name = meshName(mesh);
    const k = GRASS_RE.test(name) ? 1 : GROUND_RE.test(name) ? 2 : WATER_RE.test(name) ? 3 : 0;
    if (!k) return;
    const colour = (mesh.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.index;
    const tris = index ? index.count / 3 : pos.count / 3;
    const w = mesh.matrixWorld;
    for (let t = 0; t < tris; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(w);
      b.fromBufferAttribute(pos, i1).applyMatrix4(w);
      c.fromBufferAttribute(pos, i2).applyMatrix4(w);
      // top-facing only (a steep bank or a wall never claims the cell)
      const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
      const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9 || Math.abs(ny) < 0.35 * len) continue;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - min) / cell));
      const x1 = Math.min(n - 1, Math.ceil((Math.max(a.x, b.x, c.x) - min) / cell));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - min) / cell));
      const z1 = Math.min(n - 1, Math.ceil((Math.max(a.z, b.z, c.z) - min) / cell));
      if (x0 > x1 || z0 > z1) continue;
      const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(det) < 1e-12) continue;
      for (let j = z0; j <= z1; j++)
        for (let i = x0; i <= x1; i++) {
          const px = min + (i + 0.5) * cell;
          const pz = min + (j + 0.5) * cell;
          const l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / det;
          const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
          const y = l1 * a.y + l2 * b.y + l3 * c.y;
          const q = j * n + i;
          // the top surface wins; a tie (within 5 cm) goes to the non-grass (a path laid over the lawn)
          if (k === 1 ? y <= top[q] + 0.05 : y <= top[q] - 0.05) continue;
          top[q] = y;
          kind[q] = k;
          alb[q * 3] = colour.r;
          alb[q * 3 + 1] = colour.g;
          alb[q * 3 + 2] = colour.b;
        }
    }
  });
  // anything else standing on the ground (a bench, the tree's roots, a lamp post, a flower bed): its
  // faces within 0.9 m of the surface take the cell (no blades through them; the ground wears there)
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || mesh.userData.outline || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || Array.isArray(mesh.material)) return;
    const mat = mesh.material as THREE.Material;
    const name = mat.name;
    if (!mat.visible || (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial || GRASS_RE.test(name) || GROUND_RE.test(name) || WATER_RE.test(name) || name.startsWith("env_")) return;
    const g = mesh.geometry;
    g.computeBoundingBox();
    const bb = g.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    if (bb.min.y > 9 || bb.max.x < min || bb.min.x > min + size || bb.max.z < min || bb.min.z > min + size) return;
    const pos = g.getAttribute("position");
    const index = g.index;
    const tris = index ? index.count / 3 : pos.count / 3;
    const w = mesh.matrixWorld;
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(pos, index ? index.getX(t * 3) : t * 3).applyMatrix4(w);
      b.fromBufferAttribute(pos, index ? index.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(w);
      c.fromBufferAttribute(pos, index ? index.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(w);
      if (Math.min(a.y, b.y, c.y) > 9) continue;
      const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(det) < 1e-6) continue; // on edge from above
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - min) / cell));
      const x1 = Math.min(n - 1, Math.ceil((Math.max(a.x, b.x, c.x) - min) / cell));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - min) / cell));
      const z1 = Math.min(n - 1, Math.ceil((Math.max(a.z, b.z, c.z) - min) / cell));
      for (let j = z0; j <= z1; j++)
        for (let i = x0; i <= x1; i++) {
          const q = j * n + i;
          if (kind[q] !== 1) continue;
          const px = min + (i + 0.5) * cell;
          const pz = min + (j + 0.5) * cell;
          const l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / det;
          const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
          const y = l1 * a.y + l2 * b.y + l3 * c.y;
          if (y > top[q] - 0.3 && y < top[q] + 0.9) kind[q] = 2;
        }
    }
  });
  // what blocks walking (building footprints, the tree's trunk, stalls): no grass there
  const DEG = Math.PI / 180;
  for (const bl of ground.blockers) {
    const x0 = Math.max(0, Math.floor((bl.min[0] - min) / cell));
    const x1 = Math.min(n - 1, Math.ceil((bl.max[0] - min) / cell));
    const z0 = Math.max(0, Math.floor((bl.min[1] - min) / cell));
    const z1 = Math.min(n - 1, Math.ceil((bl.max[1] - min) / cell));
    for (let j = z0; j <= z1; j++)
      for (let i = x0; i <= x1; i++) {
        const px = min + (i + 0.5) * cell;
        const pz = min + (j + 0.5) * cell;
        if (px < bl.min[0] || px > bl.max[0] || pz < bl.min[1] || pz > bl.max[1]) continue;
        const o = bl.obb;
        if (o) {
          const an = o.rotY * DEG;
          const dx = px - o.centre[0];
          const dz = pz - o.centre[1];
          const lx = dx * Math.cos(an) - dz * Math.sin(an);
          const lz = dx * Math.sin(an) + dz * Math.cos(an);
          if (Math.abs(lx) > o.half[0] || Math.abs(lz) > o.half[1]) continue;
        }
        if (kind[j * n + i] === 1) kind[j * n + i] = 2;
      }
  }
  // distance (m) from each grass cell to the nearest non-grass one: two-pass chamfer (3-4)
  const INF = 1e9;
  const dist = new Float32Array(n * n);
  for (let q = 0; q < n * n; q++) dist[q] = kind[q] === 1 ? INF : 0;
  const d1 = cell;
  const d2 = cell * Math.SQRT2;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const q = j * n + i;
      let d = dist[q];
      if (d === 0) continue;
      if (i > 0) d = Math.min(d, dist[q - 1] + d1);
      if (j > 0) {
        d = Math.min(d, dist[q - n] + d1);
        if (i > 0) d = Math.min(d, dist[q - n - 1] + d2);
        if (i < n - 1) d = Math.min(d, dist[q - n + 1] + d2);
      }
      dist[q] = d;
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const q = j * n + i;
      let d = dist[q];
      if (d === 0) continue;
      if (i < n - 1) d = Math.min(d, dist[q + 1] + d1);
      if (j < n - 1) {
        d = Math.min(d, dist[q + n] + d1);
        if (i < n - 1) d = Math.min(d, dist[q + n + 1] + d2);
        if (i > 0) d = Math.min(d, dist[q + n - 1] + d2);
      }
      dist[q] = d;
    }
  const half = new Uint16Array(n * n * 4);
  const albedo = new Uint8Array(n * n * 4);
  const grass = new Uint8Array(n * n);
  const height = new Float32Array(n * n);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let q = 0; q < n * n; q++) {
    const g = kind[q] === 1 ? 1 : 0;
    grass[q] = g;
    height[q] = top[q] > -1e8 ? top[q] : 0;
    half[q * 4] = toHalf(g);
    half[q * 4 + 1] = toHalf(Math.min(8, dist[q]));
    half[q * 4 + 2] = toHalf(height[q]);
    half[q * 4 + 3] = toHalf(1);
    for (let ch = 0; ch < 3; ch++) albedo[q * 4 + ch] = Math.round(Math.min(1, alb[q * 3 + ch]) * 255);
    albedo[q * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(half, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const at = new THREE.DataTexture(albedo, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  at.magFilter = THREE.LinearFilter;
  at.minFilter = THREE.LinearFilter;
  at.colorSpace = THREE.NoColorSpace;
  at.needsUpdate = true;
  return { tex, albedo: at, grass, height };
}

// ---------------------------------------------------------------------------------------------
// Shader patching helpers
// ---------------------------------------------------------------------------------------------

type Shader = THREE.WebGLProgramParametersWithUniforms;

function inject(src: string, anchor: string, add: string, where: "before" | "after" | "replace" = "after"): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`envlook: no "${anchor}" in the shader`);
  if (where === "replace") return src.slice(0, i) + add + src.slice(i + anchor.length);
  return where === "before" ? src.slice(0, i) + add + src.slice(i) : src.slice(0, i + anchor.length) + add + src.slice(i + anchor.length);
}

/** Chains `patch` after the material's own onBeforeCompile (the see-through's), with its own program key. */
function chain(m: THREE.Material, key: string, patch: (s: Shader) => void) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    patch(s);
  };
  m.customProgramCacheKey = () => `${prevKey}|env-${key}`;
  m.needsUpdate = true;
}

const NOISE_GLSL = /* glsl */ `
float envHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

// ---------------------------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------------------------

/** One space's layers; update() once per frame before the composer renders. */
export interface EnvScene {
  readonly layers: readonly string[];
  /** 0 by day .. 1 in the evening (for the bloom and the grade) */
  readonly evening: number;
  update(camera: THREE.Camera, focus: THREE.Vector3 | undefined, time: number): void;
}

export function buildEnv(scene: THREE.Scene, want: ReadonlySet<string>, deps: EnvDeps): EnvScene {
  const ground = scene.userData.lookGround as LookGround | undefined;
  const sky = () => scene.userData.lookSky as LookSky | undefined;
  const town = !!ground?.town;
  const built: string[] = [];
  const updates: ((camera: THREE.Camera, focus: THREE.Vector3, time: number, evening: number) => void)[] = [];
  const U = {
    envTime: { value: 0 },
    envCenter: { value: new THREE.Vector2() },
    envFieldMin: { value: new THREE.Vector2(FIELD.min, FIELD.min) },
    envFieldSize: { value: FIELD.size },
    envWind: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  };
  let tex: GroundTextures | undefined;
  const textures = () => (tex ??= groundTextures());
  let field: Field | undefined;
  const getField = () => (field ??= buildField(scene, ground!));

  if (town && want.has("ground")) {
    const t = textures();
    const f = getField();
    const uniforms = {
      ...U,
      envGrassTex: { value: t.grass },
      envDirtTex: { value: t.dirt },
      envDetailN: { value: t.normal },
      envMacro: { value: t.macro },
      envField: { value: f.tex },
      envDirtColor: { value: new THREE.Color(0.36, 0.27, 0.16) },
    };
    const done = new Set<THREE.Material>();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.outline || Array.isArray(mesh.material)) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (done.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
      const isGrass = GRASS_RE.test(m.name);
      if (!isGrass && !GROUND_RE.test(m.name)) return;
      done.add(m);
      const detail = /plaza|coping|stone/.test(m.name) ? 0.45 : 0.85;
      chain(m, isGrass ? "grass" : `path${detail}`, (s) => {
        Object.assign(s.uniforms, uniforms);
        s.vertexShader = inject(s.vertexShader, "void main() {", "varying vec3 vEnvW;\n", "before");
        s.vertexShader = inject(s.vertexShader, "#include <begin_vertex>", "\n  vEnvW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        s.fragmentShader = inject(
          s.fragmentShader,
          "void main() {",
          /* glsl */ `
${isGrass ? "#define ENV_GRASS" : ""}
#define ENV_DETAIL ${detail.toFixed(2)}
varying vec3 vEnvW;
uniform sampler2D envGrassTex, envDirtTex, envDetailN, envMacro, envField;
uniform vec2 envFieldMin;
uniform float envFieldSize;
uniform vec3 envDirtColor;
`,
          "before",
        );
        s.fragmentShader = inject(
          s.fragmentShader,
          "#include <color_fragment>",
          /* glsl */ `
  vec2 envP = vEnvW.xz;
  float envNear = 1.0 - smoothstep(45.0, 160.0, length(vEnvW - cameraPosition));
  vec4 envM = texture2D(envMacro, envP / 41.0);
  vec4 envM2 = texture2D(envMacro, envP / 6.7 + 0.37);
  vec3 envD = texture2D(envDirtTex, envP / 3.1).rgb * 2.0;
  float envMix = 1.0;
#ifdef ENV_GRASS
  vec3 envG = texture2D(envGrassTex, envP / 2.3).rgb * 2.0;
  vec2 envFuv = (envP - envFieldMin) / envFieldSize;
  bool envIn = all(greaterThan(envFuv, vec2(0.002))) && all(lessThan(envFuv, vec2(0.998)));
  float envDist = envIn ? texture2D(envField, envFuv).g : 8.0;
  // worn dirt along the path edges (a ragged line: the noise moves it), and a few bare patches
  float envWear = 1.0 - smoothstep(0.1, 1.25, envDist + (envM2.r - 0.5) * 1.5);
  float envPatch = smoothstep(0.64, 0.76, envM.r) * 0.7 * smoothstep(0.52, 0.62, envM2.g);
  envMix = clamp(max(envWear, envPatch), 0.0, 1.0);
  vec3 envGrass = diffuseColor.rgb * mix(vec3(1.0), envG, envNear) * mix(vec3(0.84, 0.88, 0.86), vec3(1.14, 1.1, 0.88), envM.g);
  vec3 envDirt = envDirtColor * mix(vec3(1.0), envD, envNear) * mix(0.9, 1.1, envM2.b);
  diffuseColor.rgb = mix(envGrass, envDirt, envMix);
#else
  diffuseColor.rgb *= mix(vec3(1.0), envD, ENV_DETAIL * envNear) * mix(0.93, 1.07, envM.g);
#endif
`,
        );
        if (isGrass) s.fragmentShader = inject(s.fragmentShader, "#include <roughnessmap_fragment>", "\n  roughnessFactor = mix(0.95, 0.88, envMix);");
        s.fragmentShader = inject(
          s.fragmentShader,
          "#include <normal_fragment_maps>",
          /* glsl */ `
  {
    vec2 envSG = texture2D(envDetailN, envP / 2.3).rg * 2.0 - 1.0;
    vec2 envSD = texture2D(envDetailN, envP / 3.1).ba * 2.0 - 1.0;
#ifdef ENV_GRASS
    vec2 envS = mix(envSG * 0.9, envSD * 1.4, envMix) * envNear;
#else
    vec2 envS = envSD * 0.8 * ENV_DETAIL * envNear;
#endif
    normal = normalize(normal + mat3(viewMatrix) * vec3(-envS.x, 0.0, -envS.y));
  }
`,
        );
      });
    });
    built.push("ground");
  }

  if (town && want.has("grass")) {
    const t = textures();
    const f = getField();
    const grassUniforms = { ...U, envField: { value: f.tex }, envAlbedo: { value: f.albedo }, envGrassTex: { value: t.grass }, envMacro: { value: t.macro } };
    const rnd = makeRng(99);
    for (const [key, spec] of Object.entries(GRASS)) {
      const geo = new THREE.InstancedBufferGeometry();
      // a tapered blade: 4 vertices, 2 triangles; y = the height fraction
      geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.12, 1, 0, -0.12, 1, 0], 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const count = spec.n * spec.n;
      const blades = new Float32Array(count * 4);
      const step = spec.tile / spec.n;
      for (let j = 0, k = 0; j < spec.n; j++)
        for (let i = 0; i < spec.n; i++, k++) {
          blades[k * 4] = (i + rnd()) * step;
          blades[k * 4 + 1] = (j + rnd()) * step;
          blades[k * 4 + 2] = rnd() * Math.PI * 2;
          blades[k * 4 + 3] = rnd();
        }
      geo.setAttribute("aBlade", new THREE.InstancedBufferAttribute(blades, 4));
      geo.instanceCount = count;
      const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, name: `env_grass_${key}` });
      m.onBeforeCompile = (s) => {
        Object.assign(s.uniforms, grassUniforms, {
          envTile: { value: spec.tile },
          envFade: { value: new THREE.Vector2(spec.fade[0], spec.fade[1]) },
          envSize: { value: new THREE.Vector2(spec.size[0], spec.size[1]) },
        });
        s.vertexShader = inject(
          s.vertexShader,
          "void main() {",
          /* glsl */ `
attribute vec4 aBlade;
uniform float envTime, envTile, envFieldSize;
uniform vec2 envCenter, envFade, envSize, envFieldMin, envWind;
uniform sampler2D envField, envAlbedo, envGrassTex, envMacro;
varying vec3 vBlade;
`,
          "before",
        );
        s.vertexShader = inject(s.vertexShader, "#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 1.0, 0.0);", "replace");
        s.vertexShader = inject(
          s.vertexShader,
          "#include <begin_vertex>",
          /* glsl */ `
  // the tile's copy of this blade nearest the player (the tile wraps round them as they walk)
  vec2 bp = aBlade.xy + envTile * floor((envCenter - aBlade.xy) / envTile + 0.5);
  float bd = distance(bp, envCenter);
  vec2 fuv = (bp - envFieldMin) / envFieldSize;
  float inside = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
  vec4 fld = textureLod(envField, fuv, 0.0);
  float r = aBlade.w;
  float keep = fld.r * inside * smoothstep(0.12, 0.7, fld.g + r * 0.35) * (1.0 - smoothstep(envFade.x, envFade.y, bd + r * 1.5));
  keep = keep > 0.08 ? keep : 0.0;
  float h = envSize.y * (0.55 + 0.9 * r) * keep;
  float w = envSize.x * (0.7 + 0.6 * fract(r * 7.13)) * step(0.001, keep);
  float ca = cos(aBlade.z), sa = sin(aBlade.z);
  float bend = position.y * position.y;
  float t = envTime;
  float gust = textureLod(envMacro, bp / 29.0 + vec2(t * 0.031, t * 0.017), 0.0).b;
  float sway = sin(t * 1.8 + bp.x * 0.41 + bp.y * 0.27 + r * 6.2832) * 0.3 + (gust - 0.45) * 1.6;
  vec3 transformed = vec3(bp.x + ca * position.x * w, fld.b + position.y * h, bp.y + sa * position.x * w);
  transformed.xz += (envWind * sway + vec2(-sa, ca) * (r - 0.5) * 0.8) * bend * h * 0.5;
  vec3 alb = textureLod(envAlbedo, fuv, 0.0).rgb;
  vec3 gt = textureLod(envGrassTex, bp / 2.3, 0.0).rgb * 2.0;
  float tone = textureLod(envMacro, bp / 41.0, 0.0).g;
  vBlade = alb * gt * mix(vec3(0.84, 0.88, 0.86), vec3(1.14, 1.1, 0.88), tone) * mix(0.42, 0.94 + 0.2 * fract(r * 3.7), position.y);
`,
          "replace",
        );
        s.fragmentShader = inject(s.fragmentShader, "void main() {", "varying vec3 vBlade;\n", "before");
        s.fragmentShader = inject(s.fragmentShader, "#include <color_fragment>", "\n  diffuseColor.rgb *= vBlade;");
        // a blade is lit as the ground under it (its normal is up on both faces)
        s.fragmentShader = inject(s.fragmentShader, "#include <normal_fragment_begin>", "\n#ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n#endif");
      };
      m.customProgramCacheKey = () => `env-grass-${key}`;
      const mesh = new THREE.Mesh(geo, m);
      mesh.name = `env_grass_${key}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      deps.aoHidden.push(m);
    }
    built.push("grass");
  }

  if (town && want.has("leaves")) {
    const leaves = buildLeaves(scene, deps, U);
    if (leaves) built.push("leaves");
  }

  if (town && want.has("sky")) {
    buildSky(scene, ground!, sky, U, deps, updates, textures);
    built.push("sky");
  }

  if (town && want.has("particles")) {
    buildParticles(scene, U, deps, updates);
    built.push("particles");
  }

  if (want.has("bloom")) {
    const glow = emissives(scene);
    updates.push((_c, _f, _t, e) => glow(e));
    built.push("bloom");
  }
  if (want.has("grade")) built.push("grade");

  let evening = 0;
  let lastT = -1;
  const focus0 = new THREE.Vector3();
  const env: EnvScene = {
    layers: built,
    get evening() {
      return evening;
    },
    update(camera, focus, time) {
      const k = sky();
      const d = k?.daylight ?? 0;
      evening = THREE.MathUtils.smoothstep(d, 0.5, 0.95);
      const f = focus ?? focus0.copy(camera.position);
      U.envTime.value = time;
      U.envCenter.value.set(f.x, f.z);
      if (time !== lastT) for (const u of updates) u(camera, f, time, evening);
      lastT = time;
    },
  };
  return env;
}

function buildLeaves(scene: THREE.Scene, deps: EnvDeps, U: { envTime: { value: number }; envWind: { value: THREE.Vector2 } }): THREE.InstancedMesh | null {
  scene.updateMatrixWorld(true);
  const sources: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.outline || (mesh as THREE.InstancedMesh).isInstancedMesh || Array.isArray(mesh.material)) return;
    if (CANOPY_RE.test((mesh.material as THREE.Material).name)) sources.push(mesh);
  });
  if (!sources.length) return null;
  // area-weighted triangles, upper surfaces of the crowns only (a flower bed's leaf_dark stays low)
  interface Tri { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; n: THREE.Vector3; area: number; see: number; colour: THREE.Color }
  const tris: Tri[] = [];
  let total = 0;
  for (const mesh of sources) {
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const see = g.getAttribute(deps.seeAttr);
    const index = g.index;
    const count = index ? index.count / 3 : pos.count / 3;
    const colour = ((mesh.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0.2, 0.4, 0.1)).clone();
    for (let t = 0; t < count; t++) {
      const ids = [0, 1, 2].map((v) => (index ? index.getX(t * 3 + v) : t * 3 + v));
      const [a, b, c] = ids.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
      if ((a.y + b.y + c.y) / 3 < LEAVES.minY) continue;
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = n.length() / 2;
      if (area < 1e-5) continue;
      n.normalize();
      tris.push({ a, b, c, n, area, see: see ? see.getX(ids[0]) : 0, colour });
      total += area;
    }
    // the solid crown stays as the core (darker: the shade inside), the cards cast the shadow
    mesh.castShadow = false;
  }
  for (const m of new Set(sources.map((s) => s.material as THREE.MeshStandardMaterial))) m.color.multiplyScalar(0.62);
  const count = Math.min(LEAVES.max, Math.round(total * LEAVES.perM2));
  if (!count) return null;
  const rnd = makeRng(5);
  const cum: number[] = [];
  let acc = 0;
  for (const t of tris) cum.push((acc += t.area));
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.3, 0); // the twig end sits near the surface, the cluster reaches out
  const leafN = new Float32Array(count * 3);
  const seeIds = new Float32Array(count);
  const phase = new Float32Array(count);
  const material = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, alphaToCoverage: true, name: "env_leaves" });
  deps.seeThrough(material);
  const mesh = new THREE.InstancedMesh(geo, material, count);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qi = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const z = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const r = rnd() * acc;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    p.copy(t.a).addScaledVector(tmp.subVectors(t.b, t.a), u).addScaledVector(tmp.subVectors(t.c, t.a), v);
    p.addScaledVector(t.n, (rnd() - 0.3) * 0.35);
    // the card faces out along the surface, tilted up-ish, spun about it
    const dir = tmp.copy(t.n).lerp(up, 0.25).normalize();
    q.setFromUnitVectors(z, dir);
    q.multiply(qi.setFromAxisAngle(z, rnd() * Math.PI * 2));
    q.multiply(qi.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rnd() - 0.5) * 1.1));
    const size = LEAVES.size[0] + rnd() * (LEAVES.size[1] - LEAVES.size[0]);
    s.set(size, size, size);
    m4.compose(p, q, s);
    mesh.setMatrixAt(i, m4);
    // the lighting normal: the crown's (in the card's frame), so the clusters shade as one volume
    const ln = t.n.clone().applyQuaternion(q.clone().invert());
    leafN.set([ln.x, ln.y, ln.z], i * 3);
    seeIds[i] = t.see;
    phase[i] = rnd() * 6.2832;
    col.copy(t.colour).multiplyScalar(1.25 + rnd() * 0.6);
    col.offsetHSL((rnd() - 0.5) * 0.03, 0, 0);
    mesh.setColorAt(i, col);
  }
  geo.setAttribute("aLeafN", new THREE.InstancedBufferAttribute(leafN, 3));
  geo.setAttribute("aSeeId", new THREE.InstancedBufferAttribute(seeIds, 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
  chain(material, "leaves", (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = inject(sh.vertexShader, "void main() {", "attribute vec3 aLeafN;\nattribute float aSeeId;\nattribute float aPhase;\nuniform float envTime;\nuniform vec2 envWind;\n", "before");
    sh.vertexShader = inject(sh.vertexShader, "#include <beginnormal_vertex>", "\n  objectNormal = normalize(mix(objectNormal, aLeafN, 0.85));");
    sh.vertexShader = inject(
      sh.vertexShader,
      "#include <project_vertex>",
      /* glsl */ `vec4 mvPosition = vec4(transformed, 1.0);
  mvPosition = instanceMatrix * mvPosition;
  {
    // wind: the crown sways as a whole (world position), each cluster flutters on its own
    vec3 lw = instanceMatrix[3].xyz;
    float sway = sin(envTime * 0.9 + dot(lw.xz, vec2(0.07, 0.05))) * 0.12 + sin(envTime * 2.3 + aPhase) * 0.05;
    float flutter = sin(envTime * 4.1 + aPhase * 1.7) * 0.04 * uv.y;
    mvPosition.xz += envWind * (sway + flutter) * (0.5 + uv.y);
    mvPosition.y += flutter * 0.5;
  }
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`,
      "replace",
    );
    // the fade id is the crown's (the see-through fades the cards with their tree)
    sh.vertexShader = sh.vertexShader.replace(`vStId = ${deps.seeAttr};`, "vStId = aSeeId;");
    sh.fragmentShader = inject(sh.fragmentShader, "#include <normal_fragment_begin>", "\n#ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n#endif");
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = "env_leaves";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.computeBoundingSphere();
  scene.add(mesh);
  deps.aoHidden.push(material);
  return mesh;
}

function buildSky(
  scene: THREE.Scene,
  ground: LookGround,
  sky: () => LookSky | undefined,
  U: { envTime: { value: number } },
  deps: EnvDeps,
  updates: ((camera: THREE.Camera, focus: THREE.Vector3, time: number, evening: number) => void)[],
  textures: () => GroundTextures,
) {
  const dome = ground.sky ? scene.getObjectByName(ground.sky) : undefined;
  if (dome) dome.visible = false;
  const uniforms = {
    envTime: U.envTime,
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uEvening: { value: 0 },
    uMacro: { value: textures().macro },
  };
  const material = new THREE.ShaderMaterial({
    name: "env_sky",
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor;
uniform float envTime, uEvening;
uniform sampler2D uMacro;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  vec3 col = el >= 0.0 ? mix(uHorizon, uZenith, pow(smoothstep(0.0, 1.0, el), 0.5)) : mix(uHorizon, uGround, smoothstep(0.0, -0.25, el));
  float mu = max(dot(d, normalize(uSunDir)), 0.0);
  float sunL = max(max(uSunColor.r, uSunColor.g), max(uSunColor.b, 1e-3));
  vec3 sunTint = uSunColor / sunL;
  // the glow round the sun, wider and warmer low in the evening, and a warm band on its side of the horizon
  col += sunTint * (0.05 * pow(mu, 6.0) + 0.18 * pow(mu, 48.0)) * (1.0 + uEvening * 1.5);
  col += sunTint * uEvening * 0.18 * pow(mu, 2.0) * (1.0 - smoothstep(0.0, 0.35, abs(el)));
  // the disc (HDR: the bloom rounds it)
  col += sunTint * smoothstep(0.99935, 0.99965, mu) * 12.0;
  // wisps: noise on a plane above, drifting; lit toward the sun
  if (el > 0.0) {
    vec2 cp = d.xz / (el + 0.15) * 0.22 + vec2(envTime * 0.0035, envTime * 0.0011);
    float c = texture2D(uMacro, cp).r * 0.6 + texture2D(uMacro, cp * 2.7 + 0.3).g * 0.3 + texture2D(uMacro, cp * 7.1).b * 0.1;
    float cover = smoothstep(0.5, 0.78, c) * smoothstep(0.02, 0.22, el) * 0.7;
    float hl = dot(uHorizon, vec3(0.2126, 0.7152, 0.0722));
    vec3 cloud = mix(vec3(hl * 1.25), sunTint * hl * 1.5, 0.35 + 0.4 * uEvening) + sunTint * 0.35 * pow(mu, 4.0);
    col = mix(col, cloud, cover);
  }
  col += (envHash(gl_FragCoord.xy) - 0.5) / 255.0; // no banding in the gradient
  gl_FragColor = vec4(col, 1.0);
}`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), material);
  mesh.name = "env_sky";
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = false;
  scene.add(mesh);
  deps.aoHidden.push(material);
  let version = -1;
  updates.push((camera, _f, _t, evening) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
    const k = sky();
    if (!k || k.version === version) return;
    version = k.version;
    uniforms.uZenith.value.copy(k.zenith);
    uniforms.uHorizon.value.copy(k.horizon);
    uniforms.uGround.value.copy(k.ground);
    uniforms.uSunDir.value.copy(k.sun);
    uniforms.uSunColor.value.copy(k.sunColor);
    uniforms.uEvening.value = evening;
  });
}

function buildParticles(
  scene: THREE.Scene,
  U: { envTime: { value: number }; envCenter: { value: THREE.Vector2 }; envWind: { value: THREE.Vector2 } },
  deps: EnvDeps,
  updates: ((camera: THREE.Camera, focus: THREE.Vector3, time: number, evening: number) => void)[],
) {
  const day = { value: 1 };
  updates.push((_c, _f, _t, evening) => void (day.value = 1 - 0.75 * evening));
  const rnd = makeRng(33);
  const buffer = new THREE.Vector2();
  const seeds = (n: number) => {
    const a = new Float32Array(n * 4);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return a;
  };
  const points = (name: string, n: number, vert: string, frag: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds(n), 4));
    const material = new THREE.ShaderMaterial({
      name,
      uniforms: { ...U, uPx: { value: 1 }, ...uniforms },
      vertexShader: `attribute vec4 aSeed;\nuniform float envTime, uPx;\nuniform vec2 envCenter, envWind;\nvarying vec4 vP;\n${vert}`,
      fragmentShader: `varying vec4 vP;\n${frag}`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    const p = new THREE.Points(geo, material);
    p.name = name;
    p.frustumCulled = false;
    // point sizes are authored for a 720 px tall buffer
    p.onBeforeRender = (r) => void (material.uniforms.uPx.value = r.getDrawingBufferSize(buffer).y / 720);
    scene.add(p);
    deps.aoHidden.push(material);
  };
  // dust motes: a 16 m box of drifting specks round the player, catching the light
  points(
    "env_dust",
    520,
    /* glsl */ `
void main() {
  float t = envTime;
  vec2 o = aSeed.xy * 16.0 + envWind * t * (0.15 + 0.2 * aSeed.z) + vec2(sin(t * 0.3 + aSeed.w * 6.28), cos(t * 0.23 + aSeed.z * 6.28)) * 0.4;
  vec2 p = o + 16.0 * floor((envCenter - o) / 16.0 + 0.5);
  float y = 0.3 + aSeed.z * 3.2 + sin(t * 0.4 + aSeed.x * 12.0) * 0.25;
  vec4 mv = modelViewMatrix * vec4(p.x, y, p.y, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade = 1.0 - smoothstep(5.0, 8.0, distance(p, envCenter));
  gl_PointSize = uPx * (1.5 + aSeed.w * 2.0) * 22.0 / -mv.z;
  vP = vec4(fade * (0.5 + 0.5 * sin(t * 1.3 + aSeed.x * 40.0)), 0.0, 0.0, 0.0);
}`,
    /* glsl */ `
uniform float uDay;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, r) * vP.x * 0.55 * uDay;
  gl_FragColor = vec4(vec3(1.0, 0.92, 0.75) * a, a);
}`,
    { uDay: day },
    THREE.AdditiveBlending,
  );
  // steam off the noodle shop's counter (its front at z ~31.5, the pots on the counter's left)
  const shop = scene.getObjectByName("noodle_shop");
  if (shop) {
    const at = shop.position.clone().add(new THREE.Vector3(-0.7, 1.2, 1.5));
    points(
      "env_steam",
      160,
      /* glsl */ `
uniform vec3 uAt;
void main() {
  float life = fract(envTime * 0.22 + aSeed.x);
  vec3 p = uAt + vec3((aSeed.y - 0.5) * 0.5, 0.0, (aSeed.z - 0.5) * 0.3);
  p.y += life * 1.6;
  p.xz += (envWind * 0.35 + vec2(sin(envTime * 1.1 + aSeed.w * 6.28), cos(envTime * 0.9 + aSeed.y * 6.28)) * 0.12) * life * life * 1.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * (0.25 + life * 0.7) * 700.0 / -mv.z;
  vP = vec4(smoothstep(0.0, 0.12, life) * (1.0 - life), aSeed.w, 0.0, 0.0);
}`,
      /* glsl */ `
uniform float uDay;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, r) * vP.x * 0.16;
  gl_FragColor = vec4(vec3(0.96, 0.95, 0.93) * uDay, a);
}`,
      { uAt: { value: at }, uDay: day },
      THREE.NormalBlending,
    );
  }
  // leaves drifting down from the great tree
  const tree = scene.getObjectByName("great_tree");
  if (tree) {
    points(
      "env_falling_leaves",
      70,
      /* glsl */ `
uniform vec3 uAt;
void main() {
  float life = fract(envTime * 0.045 + aSeed.x);
  float a = aSeed.y * 6.2832 + envTime * (0.3 + aSeed.z * 0.3);
  float rad = 2.5 + aSeed.w * 8.0;
  vec3 p = uAt + vec3(cos(aSeed.y * 6.2832) * rad, 0.0, sin(aSeed.y * 6.2832) * rad);
  p.y += 11.0 * (1.0 - life) + 0.05;
  p.xz += vec2(cos(a), sin(a)) * 0.6 + envWind * life * 3.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * 120.0 / -mv.z;
  vP = vec4(smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.95, 1.0, life)), envTime * (1.0 + aSeed.z * 2.0) + aSeed.w * 6.28, aSeed.z, 0.0);
}`,
      /* glsl */ `
void main() {
  // a small leaf spinning as it falls (an ellipse in the point sprite)
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vP.y), co = cos(vP.y);
  vec2 q = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
  float e = (q.x * q.x) / 0.06 + (q.y * q.y) / (0.012 + 0.03 * abs(sin(vP.y * 0.7)));
  if (e > 1.0 || vP.x < 0.01) discard;
  gl_FragColor = vec4(mix(vec3(0.1, 0.2, 0.04), vec3(0.36, 0.27, 0.07), vP.z), 1.0);
}`,
      { uAt: { value: tree.position.clone() } },
      THREE.NormalBlending,
    );
  }
}

/** Evening glow: lanterns, lamp glass, windows take an emissive that rises toward evening (the bloom picks them up). */
function emissives(scene: THREE.Scene): (evening: number) => void {
  const found = new Map<THREE.MeshStandardMaterial, { base: THREE.Color; colour: THREE.Color; gain: number }>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // static world only (a character's clothes can share a palette name, never its material)
    if (!mesh.isMesh || mesh.userData.outline || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      if (!m.isMeshStandardMaterial || found.has(m)) continue;
      const name = m.name;
      let spec: { colour: THREE.Color; gain: number } | null = null;
      if (/^lantern_PBR$/.test(name)) {
        // the textured lantern glows its own colours
        if (m.map && !m.emissiveMap) {
          m.emissiveMap = m.map;
          m.needsUpdate = true;
        }
        spec = { colour: new THREE.Color(1, 0.35, 0.12), gain: 1.8 };
      } else if (/^lantern_red$/.test(name)) spec = { colour: new THREE.Color(1, 0.16, 0.04), gain: 2.2 };
      else if (/^glass$/.test(name)) spec = { colour: new THREE.Color(1, 0.6, 0.28), gain: 2.2 };
      // the filler shops' window panes
      else if (/^sky_blue$/.test(name)) spec = { colour: new THREE.Color(1, 0.55, 0.22), gain: 1.0 };
      if (spec) found.set(m, { base: m.emissive.clone(), ...spec });
    }
  });
  let last = -1;
  return (e) => {
    if (Math.abs(e - last) < 1e-3) return;
    last = e;
    for (const [m, s] of found) {
      if (e <= 0) {
        m.emissive.copy(s.base);
        m.emissiveIntensity = 1;
        continue;
      }
      m.emissive.copy(s.base).lerp(s.colour, Math.min(1, e * 1.5));
      m.emissiveIntensity = s.gain * e;
    }
  };
}
