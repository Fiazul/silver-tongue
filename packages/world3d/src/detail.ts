// Tiling detail maps for the textured assets (README "Real look", "Detail maps"): the library ships one
// small unique atlas per asset (buildings 28 px/m), which at game distance reads flat and clean.
// Here a small set of tiling detail textures, generated at startup (no files, 256² each, once per
// page), adds surface detail at 0.5-2.4 m scale on top, independent of the atlas: brick courses and
// mortar, plaster grain and blotch, wood grain, brushed-metal scratches, irregular stone flags. Each
// texture packs an albedo multiplier (R: grey, mean 1, about +-15 %) and a tangent-space normal
// (GB: the height field's slopes). Real look only (Full / Lite: world.ts Toon.material's real-look
// branch); Classic never builds a texture or patches a material.
//
// The shader (onBeforeCompile, chained after the see-through's) projects the textures in world
// space (triplanar, weights from the world normal; so tiling never depends on the atlas's UVs), with
// no vertex changes: the fragment rebuilds the world position from vViewPosition. `diffuse *=
// albedo`, the normal is bent along the projection's world axes (no tangents), and the detail
// fades out with distance: the normal first, all of it gone past DETAIL_FADE.end (28 m) (the far pixels
// skip the texture reads). Mipmaps, anisotropic filtering and the derivative-based textureGrad
// (derivatives taken before the branch) keep it from shimmering.
import * as THREE from "three";

/** the detail textures */
export const DETAIL_KINDS = ["brick", "plaster", "wood", "metal", "stone"] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

/** texture size (px, square) */
export const DETAIL_N = 256;

/** metres of world one texture tile covers (brick: 4 bricks of 0.32 m x 10 courses of 0.128 m) */
export const DETAIL_TILE_M: Record<DetailKind, number> = { brick: 1.28, plaster: 2.0, wood: 1.0, metal: 0.6, stone: 2.4 };

/**
 * Distance fade (m from the camera): the albedo detail full to `albedo`, gone at `end`; the
 * normal full to `normal[0]`, gone at `normal[1]` (the default street camera is ~19 m from the
 * player: the facades there keep the albedo detail and a little relief).
 */
export const DETAIL_FADE = { albedo: 21, end: 28, normal: [8, 24] as [number, number] };

/** One material's detail: its texture and how strongly (0-1) each part applies. */
export interface DetailSpec {
  kind: DetailKind;
  albedo: number;
  normal: number;
  /** the library family it came from (make-it-in-china tools/blender/lib/textures.py), or "default" */
  family: string;
}

// ---------------------------------------------------------------------------------------------
// The family table
// ---------------------------------------------------------------------------------------------

/**
 * Palette name -> library family (make-it-in-china tools/blender/lib/textures.py NAME_FAMILY: the
 * library bakes each textured material by its family, so the detail matches what was baked).
 */
export const NAME_FAMILY: Record<string, string> = {
  plaster: "plaster", dado_green: "plaster", i_offwhite: "plaster",
  concrete: "concrete",
  brick: "brick",
  tile_white: "tile", bld_tile: "tile",
  roof_tile: "roof",
  wood: "wood", wood_dark: "wood", bamboo_dark: "wood", straw: "wood", town_bark: "wood", town_bamboo: "wood",
  metal: "metal", slate: "metal", bld_iron: "metal", bld_zinc: "metal", pi_steel: "metal", gold: "metal", st_brass: "metal",
  cloth_white: "cloth", cloth_grey: "cloth", cloth_oat: "cloth", red: "cloth", lantern_red: "cloth", st_cream: "cloth",
  denim: "cloth", navy: "cloth", khaki_brown: "cloth", purple: "cloth", pink: "cloth",
  town_stone: "stone", town_stone_dark: "stone", land_path_edge: "stone", land_path_stone: "stone", land_bank_wet: "stone",
  paving: "paving",
  asphalt: "asphalt",
  formica: "plastic", pi_ink: "plastic", st_rubber: "plastic", npc_hard: "plastic", charcoal: "plastic", hivis_orange: "plastic",
  yellow: "paint", work_blue: "paint", st_paint_blue: "paint", door_red: "paint", pi_lacquer: "paint", pi_band: "paint",
  pi_ceramic: "ceramic", clay: "ceramic", egg_shell: "organic",
  paper: "paper", cardboard: "paper",
  dark_green: "organic", broth: "organic", pi_banana: "organic", pi_melon: "organic", ginger: "organic", dog_tan: "organic",
};

/** the library's per-set overrides (palette names mean different things per set: a props / interiors "brick" is a teapot) */
export const SET_FAMILY: Record<string, Record<string, string>> = {
  props: { red: "organic", brick: "ceramic" },
  interiors: { brick: "ceramic", red: "paint" },
};

/** the library's per-asset overrides */
export const ASSET_FAMILY: Record<string, Record<string, string>> = {
  hand_truck: { red: "paint" },
  stool_plastic: { red: "plastic" },
  ac_unit: { tile_white: "plastic" },
  bin_public: { st_paint_blue: "plastic" },
  freezer_chest: { tile_white: "plastic" },
  sign_lightbox: { paper: "plastic" },
  road_straight: { concrete: "paving" },
  road_crossing: { concrete: "paving" },
};

/**
 * Surfaces the game shades itself (envlook.ts: grass, the ground, water, canopies; the glass / sky
 * panes the evening lights) and far scenery: never any detail (as the library's GAME_OWNED).
 */
export const GAME_OWNED = /^(grass_.*|land_(path|dirt|plaza|plaza_ring|stone_edge|bank_stone|coping)|water_.*|canopy_green|leaf_green|leaf_dark|leaf_pale|town_willow|town_lotus_pad|glass|pi_glass|sky_blue|mtn_.*|land_sky_.*|land_cloud.*)$/;

/**
 * Library family -> detail. Ceramic (glazed) and organic (food, eggs) take none: grain there reads
 * as dirt. Strengths keep the whole stylised-realistic: the pattern families (brick, wood, stone,
 * metal) full, plaster / concrete full, the painted and soft ones a faint grain.
 */
export const FAMILY_DETAIL: Record<string, { kind: DetailKind; albedo: number; normal: number } | null> = {
  brick: { kind: "brick", albedo: 1, normal: 1 },
  plaster: { kind: "plaster", albedo: 1, normal: 0.8 },
  concrete: { kind: "plaster", albedo: 0.9, normal: 1 },
  tile: { kind: "plaster", albedo: 0.4, normal: 0.3 },
  roof: { kind: "plaster", albedo: 0.6, normal: 0.5 },
  wood: { kind: "wood", albedo: 1, normal: 0.8 },
  paint: { kind: "plaster", albedo: 0.35, normal: 0.3 },
  metal: { kind: "metal", albedo: 1, normal: 0.7 },
  cloth: { kind: "plaster", albedo: 0.35, normal: 0.25 },
  stone: { kind: "stone", albedo: 1, normal: 1 },
  paving: { kind: "stone", albedo: 0.9, normal: 0.9 },
  asphalt: { kind: "plaster", albedo: 0.8, normal: 0.6 },
  plastic: { kind: "plaster", albedo: 0.2, normal: 0.15 },
  paper: { kind: "plaster", albedo: 0.3, normal: 0.2 },
  ceramic: null,
  organic: null,
};

/** unknown names: plaster grain, low */
export const DEFAULT_DETAIL = { kind: "plaster" as DetailKind, albedo: 0.3, normal: 0.25 };

/** A palette name's library family (overrides first), "flat" for the game-owned names, null when the table doesn't know it. */
export function familyOf(name: string, set?: string, asset?: string): string | null {
  const base = name.split(".")[0];
  const over = (asset ? ASSET_FAMILY[asset]?.[base] : undefined) ?? (set ? SET_FAMILY[set]?.[base] : undefined);
  if (over) return over;
  if (GAME_OWNED.test(base)) return "flat";
  return NAME_FAMILY[base] ?? null;
}

/** The detail a textured material takes (null: none: game-owned, ceramic, organic). */
export function detailFor(name: string, set?: string, asset?: string): DetailSpec | null {
  const family = familyOf(name, set, asset);
  if (family === "flat") return null;
  if (family === null) return { ...DEFAULT_DETAIL, family: "default" };
  const d = FAMILY_DETAIL[family];
  if (d === undefined) return { ...DEFAULT_DETAIL, family: "default" };
  return d ? { ...d, family } : null;
}

// ---------------------------------------------------------------------------------------------
// The textures (deterministic, tileable: every pattern's period divides the tile)
// ---------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** tileable value-noise fbm (0..1, mean ~0.5) at every texel centre: pu x pv lattice cells at the first octave, `octaves` doubling */
function field(pu: number, pv: number, seed: number, octaves: number): Float32Array {
  const N = DETAIL_N;
  const out = new Float32Array(N * N);
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cu = pu << o;
    const cv = pv << o;
    const r = rng(seed * 7919 + o * 104729 + cu * 31 + cv);
    const lat = new Float32Array(cu * cv);
    for (let k = 0; k < lat.length; k++) lat[k] = r();
    const xs = new Int32Array(N);
    const ws = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      const t = ((x + 0.5) / N) * cu;
      const x0 = Math.floor(t);
      const f = t - x0;
      xs[x] = x0;
      ws[x] = f * f * (3 - 2 * f);
    }
    for (let y = 0; y < N; y++) {
      const t = ((y + 0.5) / N) * cv;
      const y0 = Math.floor(t);
      const f = t - y0;
      const sy = f * f * (3 - 2 * f);
      const r0 = (y0 % cv) * cu;
      const r1 = ((y0 + 1) % cv) * cu;
      for (let x = 0; x < N; x++) {
        const x0 = xs[x] % cu;
        const x1 = (xs[x] + 1) % cu;
        const sx = ws[x];
        const a = lat[r0 + x0];
        const b = lat[r0 + x1];
        const c = lat[r1 + x0];
        const d = lat[r1 + x1];
        out[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let k = 0; k < out.length; k++) out[k] /= norm;
  return out;
}

/** the fields one texture asks for, each built once */
function fields() {
  const memo = new Map<string, Float32Array>();
  return (pu: number, pv: number, seed: number, octaves: number) => {
    const key = `${pu},${pv},${seed},${octaves}`;
    let f = memo.get(key);
    if (!f) memo.set(key, (f = field(pu, pv, seed, octaves)));
    return f;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** one kind's fields: albedo multiplier (mean 1) and height (m-ish, scaled by `bump` into slopes) */
interface Fields {
  albedo: Float32Array;
  height: Float32Array;
  /** slope gain: height difference per texel -> tangent tilt */
  bump: number;
}

function brickFields(): Fields {
  const F = fields();
  const n0 = F(64, 64, 5, 1);
  const n1 = F(48, 48, 3, 2);
  const n2 = F(8, 8, 7, 2);
  const n3 = F(96, 96, 9, 1);
  const n4 = F(32, 32, 13, 2);
  const N = DETAIL_N;
  const T = DETAIL_TILE_M.brick;
  const COLS = 4;
  const ROWS = 10;
  const bw = T / COLS;
  const bh = T / ROWS;
  const mortar = 0.0065; // half the joint (m)
  const bevel = 0.007;
  const albedo = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const row = Math.floor(v * ROWS);
      const fv = v * ROWS - row;
      const cu = u * COLS + (row % 2) * 0.5;
      const col = ((Math.floor(cu) % COLS) + COLS) % COLS;
      const fu = cu - Math.floor(cu);
      // a slightly irregular joint: each brick's edges wander a few mm
      const jit = (n0[i] - 0.5) * 0.004;
      const e = Math.min(Math.min(fu, 1 - fu) * bw, Math.min(fv, 1 - fv) * bh) + jit;
      const face = smooth(mortar, mortar + bevel, e);
      const tone = hash2(col, row, 11) - 0.5; // per brick
      const burnt = hash2(col, row, 23) > 0.9 ? -0.06 : 0;
      const speck = (n1[i] - 0.5) * 0.08;
      const brick = 1 + tone * 0.2 + burnt + speck + (n2[i] - 0.5) * 0.06;
      const joint = 1.14 + (n3[i] - 0.5) * 0.06;
      albedo[i] = joint + (brick - joint) * face;
      height[i] = face * (1 + (n4[i] - 0.5) * 0.25);
    }
  return { albedo, height, bump: 0.45 };
}

function plasterFields(): Fields {
  const F = fields();
  const n0 = F(3, 3, 41, 3);
  const n1 = F(64, 64, 43, 2);
  const n2 = F(96, 96, 47, 2);
  const N = DETAIL_N;
  const albedo = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const blotch = n0[i] - 0.5;
      const grain = n1[i] - 0.5;
      albedo[i] = 1 + blotch * 0.22 + grain * 0.08;
      height[i] = (n2[i] - 0.5) * 1.0 + blotch * 0.6;
    }
  return { albedo, height, bump: 0.5 };
}

function woodFields(): Fields {
  const F = fields();
  const n0 = F(3, 1, 61, 3);
  const n1 = F(6, 2, 63, 2);
  const n2 = F(24, 2, 65, 2);
  const n3 = F(16, 1, 67, 2);
  const n4 = F(4, 4, 69, 2);
  // grain lines along v (world up on the walls: posts, doors, boards stand; along z on the tops)
  const N = DETAIL_N;
  const LINES = 36;
  const albedo = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const warp = (n0[i] - 0.5) * 2.4 + (n1[i] - 0.5) * 0.5;
      const g = u * LINES + warp;
      const f = g - Math.floor(g);
      const line = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * f), 5) * (0.4 + 1.2 * n2[i]);
      const band = n3[i] - 0.5; // long streaks along the grain
      const knot = n4[i] - 0.5;
      albedo[i] = 1 + band * 0.16 - line * 0.13 + knot * 0.06;
      height[i] = -line * 0.6 + band * 0.3;
    }
  return { albedo, height, bump: 0.4 };
}

function metalFields(): Fields {
  const F = fields();
  const n0 = F(2, 128, 81, 2);
  const n1 = F(3, 3, 83, 2);
  // brushed along u (horizontal), a few fine scratches near it, faint blotch
  const N = DETAIL_N;
  const albedo = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const brush = n0[i] - 0.5;
      const blotch = n1[i] - 0.5;
      albedo[i] = 1 + brush * 0.1 + blotch * 0.1;
      height[i] = brush * 0.5;
    }
  const r = rng(85);
  const wrap = (i: number) => ((i % N) + N) % N;
  for (let s = 0; s < 420; s++) {
    const x0 = r() * N;
    const y0 = r() * N;
    const a = (r() - 0.5) * 0.25;
    const len = 6 + r() * r() * 60;
    const k = 0.05 + r() * 0.06;
    for (let t = 0; t < len; t++) {
      const j = wrap(Math.round(y0 + Math.sin(a) * t)) * N + wrap(Math.round(x0 + Math.cos(a) * t));
      const fade = Math.sin((Math.PI * t) / len);
      albedo[j] += k * fade;
      height[j] -= 0.5 * fade;
    }
  }
  return { albedo, height, bump: 0.3 };
}

function stoneFields(): Fields {
  const F = fields();
  const n0 = F(16, 16, 105, 1);
  const n1 = F(16, 16, 107, 1);
  const n2 = F(48, 48, 111, 2);
  const n3 = F(6, 6, 113, 2);
  // irregular flags: a jittered 4 x 4 cell grid of seeds (0.6 m), joints on the Voronoi edges
  const N = DETAIL_N;
  const G = 4;
  const T = DETAIL_TILE_M.stone;
  const pts: [number, number][] = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([(i + 0.5 + (hash2(i, j, 101) - 0.5) * 0.7) / G, (j + 0.5 + (hash2(i, j, 103) - 0.5) * 0.7) / G]);
  const albedo = new Float32Array(N * N);
  const height = new Float32Array(N * N);
  const cand = new Float64Array(18);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N + (n0[i] - 0.5) * 0.012;
      const v = (y + 0.5) / N + (n1[i] - 0.5) * 0.012;
      const cu = Math.floor(u * G);
      const cv = Math.floor(v * G);
      let d1 = 9;
      let id = 0;
      let k1 = 0;
      for (let dj = -1, k = 0; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++, k++) {
          const ci = cu + di;
          const cj = cv + dj;
          const ii = ((ci % G) + G) % G;
          const jj = ((cj % G) + G) % G;
          const p = pts[jj * G + ii];
          const px = p[0] + Math.floor(ci / G);
          const py = p[1] + Math.floor(cj / G);
          cand[k * 2] = px;
          cand[k * 2 + 1] = py;
          const d = (u - px) * (u - px) + (v - py) * (v - py);
          if (d < d1) {
            d1 = d;
            id = jj * G + ii;
            k1 = k;
          }
        }
      // the distance to the nearest Voronoi edge (tile units): the bisector distance to each other seed
      const ax = cand[k1 * 2];
      const ay = cand[k1 * 2 + 1];
      let edge = 9;
      for (let k = 0; k < 9; k++) {
        if (k === k1) continue;
        const dx = cand[k * 2] - ax;
        const dy = cand[k * 2 + 1] - ay;
        const l = Math.sqrt(dx * dx + dy * dy);
        const e = -(dx * (u - (ax + cand[k * 2]) / 2) + dy * (v - (ay + cand[k * 2 + 1]) / 2)) / l;
        if (e < edge) edge = e;
      }
      const em = edge * T;
      const face = smooth(0.006, 0.02, em);
      const tone = hash2(id, 7, 109) - 0.5;
      const grain = n2[i] - 0.5;
      const flag = 1 + tone * 0.16 + grain * 0.09 + (n3[i] - 0.5) * 0.08;
      const joint = 0.9;
      albedo[i] = joint + (flag - joint) * face;
      height[i] = face * (1 + grain * 0.3 + tone * 0.2);
    }
  return { albedo, height, bump: 0.35 };
}

const FIELDS: Record<DetailKind, () => Fields> = { brick: brickFields, plaster: plasterFields, wood: woodFields, metal: metalFields, stone: stoneFields };

/** albedo multiplier range the R channel encodes: mult = ALBEDO_LO + ALBEDO_SPAN * r */
export const ALBEDO_LO = 0.75;
export const ALBEDO_SPAN = 0.5;
/** the albedo multiplier's hard limits (mean 1: +-18 % at the extremes, the bulk within +-15 %) */
export const ALBEDO_CLAMP = [0.82, 1.18];

/**
 * One kind's texture data: RGBA8, DETAIL_N², R = albedo multiplier ((mult - ALBEDO_LO) / ALBEDO_SPAN,
 * mean normalised to 1), G / B = the height field's -slope along u / v (0.5 = flat), A = 255.
 */
export function detailTextureData(kind: DetailKind): Uint8Array {
  const N = DETAIL_N;
  const f = FIELDS[kind]();
  let mean = 0;
  for (let i = 0; i < N * N; i++) mean += f.albedo[i];
  mean /= N * N;
  const out = new Uint8Array(N * N * 4);
  const at = (x: number, y: number) => f.height[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = Math.min(ALBEDO_CLAMP[1], Math.max(ALBEDO_CLAMP[0], f.albedo[i] / mean));
      const sx = -(at(x + 1, y) - at(x - 1, y)) * f.bump;
      const sy = -(at(x, y + 1) - at(x, y - 1)) * f.bump;
      out[i * 4] = byte((a - ALBEDO_LO) / ALBEDO_SPAN);
      out[i * 4 + 1] = byte(0.5 + Math.max(-1, Math.min(1, sx)) * 0.5);
      out[i * 4 + 2] = byte(0.5 + Math.max(-1, Math.min(1, sy)) * 0.5);
      out[i * 4 + 3] = 255;
    }
  return out;
}

const textures = new Map<DetailKind, THREE.DataTexture>();
/** ms spent generating the textures this page (world3d.look() could report it; the tests read it) */
export const detailStats = { ms: 0, textures: 0 };

/** One kind's texture, generated on first use and shared (repeat, mipmapped, anisotropic, linear data). */
export function detailTexture(kind: DetailKind): THREE.DataTexture {
  let t = textures.get(kind);
  if (!t) {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    t = new THREE.DataTexture(detailTextureData(kind), DETAIL_N, DETAIL_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.colorSpace = THREE.NoColorSpace;
    t.name = `detail_${kind}`;
    t.needsUpdate = true;
    textures.set(kind, t);
    detailStats.ms += (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    detailStats.textures++;
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// The shader patch
// ---------------------------------------------------------------------------------------------

/** the program key the patch adds (one program for every detailed material: the kind is a uniform) */
export const DETAIL_KEY = "detail-v1";

const FRAG_PARS = /* glsl */ `
uniform sampler2D dtMap;
uniform vec4 dtParams; // x: 1 / tile (1/m), y: albedo strength, z: normal strength
uniform vec4 dtFade;   // x: albedo full to, y: end, z / w: normal full to / gone at (m)
`;

// before <map_fragment>: sample (world triplanar; skipped past the fade and on weights < 0.02)
const FRAG_SAMPLE = /* glsl */ `
  float dtMul = 1.0;
  vec3 dtBend = vec3(0.0);
  {
    float dtD = length(vViewPosition);
    vec3 dtQ = (cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz) * dtParams.x;
    vec3 dtQx = dFdx(dtQ);
    vec3 dtQy = dFdy(dtQ);
    float dtFa = 1.0 - smoothstep(dtFade.x, dtFade.y, dtD);
    float dtFn = 1.0 - smoothstep(dtFade.z, dtFade.w, dtD);
    if (dtFa > 0.0) {
      vec3 dtNw = abs((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
      vec3 dtW = dtNw * dtNw;
      dtW *= dtW;
      dtW /= dtW.x + dtW.y + dtW.z;
      float dtA = 0.0;
      vec3 dtB = vec3(0.0);
      if (dtW.x > 0.02) {
        vec3 t = textureGrad(dtMap, dtQ.zy, dtQx.zy, dtQy.zy).rgb;
        vec2 n = t.gb * 2.0 - 1.0;
        dtA += dtW.x * (t.r - ${((1 - ALBEDO_LO) / ALBEDO_SPAN).toFixed(4)});
        dtB += dtW.x * vec3(0.0, n.y, n.x);
      }
      if (dtW.y > 0.02) {
        vec3 t = textureGrad(dtMap, dtQ.xz, dtQx.xz, dtQy.xz).rgb;
        vec2 n = t.gb * 2.0 - 1.0;
        dtA += dtW.y * (t.r - ${((1 - ALBEDO_LO) / ALBEDO_SPAN).toFixed(4)});
        dtB += dtW.y * vec3(n.x, 0.0, n.y);
      }
      if (dtW.z > 0.02) {
        vec3 t = textureGrad(dtMap, dtQ.xy, dtQx.xy, dtQy.xy).rgb;
        vec2 n = t.gb * 2.0 - 1.0;
        dtA += dtW.z * (t.r - ${((1 - ALBEDO_LO) / ALBEDO_SPAN).toFixed(4)});
        dtB += dtW.z * vec3(n.x, n.y, 0.0);
      }
      dtMul = 1.0 + dtA * ${ALBEDO_SPAN.toFixed(4)} * dtParams.y * dtFa;
      dtBend = dtB * dtParams.z * dtFn;
    }
  }
`;

const FRAG_ALBEDO = /* glsl */ `
  diffuseColor.rgb *= dtMul;
`;

const FRAG_NORMAL = /* glsl */ `
  normal = normalize(normal + mat3(viewMatrix) * dtBend);
`;

function inject(src: string, anchor: string, add: string, where: "before" | "after"): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`detail: no "${anchor}" in the shader`);
  return where === "before" ? src.slice(0, i) + add + src.slice(i) : src.slice(0, i + anchor.length) + add + src.slice(i + anchor.length);
}

/** The fragment patch on a MeshStandardMaterial's shader (exported for the tests). */
export function detailShader(s: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, spec: DetailSpec) {
  s.uniforms.dtMap = { value: detailTexture(spec.kind) };
  s.uniforms.dtParams = { value: new THREE.Vector4(1 / DETAIL_TILE_M[spec.kind], spec.albedo, spec.normal, 0) };
  s.uniforms.dtFade = { value: new THREE.Vector4(DETAIL_FADE.albedo, DETAIL_FADE.end, DETAIL_FADE.normal[0], DETAIL_FADE.normal[1]) };
  let f = inject(s.fragmentShader, "void main() {", FRAG_PARS, "before");
  f = inject(f, "#include <map_fragment>", FRAG_SAMPLE, "before");
  f = inject(f, "#include <map_fragment>", FRAG_ALBEDO, "after");
  f = inject(f, "#include <normal_fragment_maps>", FRAG_NORMAL, "after");
  s.fragmentShader = f;
}

/**
 * Adds the detail to a real-look material: chained after its own onBeforeCompile (the see-through's),
 * with its own program key. Fragment only: no vertex change, no new pass.
 */
export function applyDetail(m: THREE.MeshStandardMaterial, spec: DetailSpec): THREE.MeshStandardMaterial {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    detailShader(s, spec);
  };
  m.customProgramCacheKey = () => `${prevKey}|${DETAIL_KEY}`;
  m.userData.detail = spec;
  m.needsUpdate = true;
  return m;
}
