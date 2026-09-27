// See-through: whatever stands between the fixed camera and the player (or the NPC they talk to)
// is cut away round them on screen, so they are never hidden. Screen-space, in the shared toon
// materials' fragment shader (onBeforeCompile) and the static outline hull's: no un-batching, no
// extra draw call, no transparency sorting (an ordered-dither cutout: fragments are discarded,
// depth writes kept), and the hole's edge reads as a soft dither.
//
// Two rules, one per-vertex attribute (`seeThru`, baked into every static batch at merge time):
//   0  never cut: flat ground (the landscape: terrain, water, hills; tiles, decals, ground boxes,
//      the horizon skirt and caps). Also the default for any mesh without the attribute (held props).
//   1  the hole: a fragment is cut when it is (a) nearer the camera than a focus point by more than
//      `margin`, (b) within `radius` m of it on screen (measured at the focus depth, `feather` soft)
//      and (c) above the focus's feet by `lift` (the ground and decks the player stands on stay).
//   2+k  the hole, and canopy cluster k: while a focus stands inside canopy k's footprint the whole
//      canopy dithers down to `canopyFade` (the great tree covers a 23 x 17 m patch of the plaza:
//      the player walks under it for long stretches, the hole alone would leave all round them dark).
// Characters' materials (and their outline hulls), the sky, clouds, the wayfinding trail and
// marker are never patched.
import * as THREE from "three";

export const SEE_THROUGH = {
  /** the hole's radius on screen, in metres at the focus depth (its half-fade point) */
  radius: 2.2,
  /** the soft band across the radius, metres */
  feather: 0.9,
  /** cut only what is this much nearer the camera than the focus point, metres */
  margin: 0.9,
  /** and fade in over this much more depth */
  ramp: 0.6,
  /** cut only above the feet by this much (ground, decks, steps underfoot stay), metres */
  lift: 0.3,
  /** fade in over this much height */
  liftRamp: 0.4,
  /** the focus point above the feet (the camera's aim height, camera.ts) */
  aimHeight: 1.0,
  /** a canopy the player stands under dithers down to this */
  canopyFade: 0.25,
  /** 1/s, easing of a canopy's fade */
  fadeRate: 4,
  /** canopy clusters a space may tag (the town has 19: the great tree, 8 willows, 7 small ones, 3 bamboo groves) */
  maxClusters: 24,
  /** focus points: the player, the one they talk to */
  maxFocus: 2,
};

export const SEE_ATTR = "seeThru";
export const SEE_NEVER = 0;
export const SEE_HOLE = 1;
export const SEE_CLUSTER0 = 2;

/**
 * Canopies by asset name (town.json's buildings; the manifest's town set): the parts that fade as
 * one cluster (by palette material name), and optionally the vertices above `above` m over the
 * root (the great tree's branches above its lanterns).
 */
export const CANOPIES: Record<string, { parts: RegExp; above?: number }> = {
  great_tree: { parts: /^(canopy_green|leaf_green|leaf_dark)$/, above: 3.4 },
  willow: { parts: /^(leaf_green|leaf_pale|town_willow)$/ },
  willow_small: { parts: /^(leaf_green|leaf_pale|town_willow)$/ },
  bamboo_grove: { parts: /^(leaf_green|leaf_dark)$/ },
};

/** How a static root's meshes are tagged: ground (never cut), or cut, optionally in canopy cluster `cluster`. */
export interface SeeSpec {
  tag: typeof SEE_NEVER | typeof SEE_HOLE;
  cluster?: number;
  /** the root's world y (for `above`) */
  baseY?: number;
}

/** Asset sets that are ground: the landscape, the tiles (roads, pavements, decals). */
const GROUND_SETS = new Set(["tiles", "landscape"]);
const FLAT = /^(road_|pavement_|manhole|drain_grate|decal_)/;

/** The tag for a static asset instance (by its index set and name). Canopy clusters are assigned by SceneSpace. */
export function seeSpecFor(set: string | undefined, name: string): SeeSpec {
  return { tag: (set && GROUND_SETS.has(set)) || FLAT.test(name) ? SEE_NEVER : SEE_HOLE };
}

/** The material that decides a mesh's canopy part: its own, or (an outline hull) its source mesh's. */
function partName(mesh: THREE.Mesh): string {
  const src = mesh.userData.outline && (mesh.parent as THREE.Mesh | null)?.isMesh ? (mesh.parent as THREE.Mesh) : mesh;
  const m = src.material as THREE.Material | THREE.Material[];
  return Array.isArray(m) ? "" : m.name;
}

/**
 * The `seeThru` attribute for one static mesh's geometry. `geo` is in world space when `world` is
 * true (a batch's copy), else local (then `mesh.matrixWorld` places it).
 */
export function seeAttribute(geo: THREE.BufferGeometry, mesh: THREE.Mesh, spec: SeeSpec | undefined, rootAsset: string | undefined, world: boolean): THREE.BufferAttribute {
  const n = geo.getAttribute("position").count;
  const out = new Float32Array(n).fill(spec?.tag ?? SEE_HOLE);
  const canopy = rootAsset ? CANOPIES[rootAsset] : undefined;
  if (spec?.tag === SEE_HOLE && spec.cluster !== undefined && canopy && spec.cluster < SEE_THROUGH.maxClusters) {
    const id = SEE_CLUSTER0 + spec.cluster;
    if (canopy.parts.test(partName(mesh))) out.fill(id);
    else if (canopy.above !== undefined) {
      const pos = geo.getAttribute("position");
      const v = new THREE.Vector3();
      const cut = (spec.baseY ?? 0) + canopy.above;
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i);
        if (!world) v.applyMatrix4(mesh.matrixWorld);
        if (v.y > cut) out[i] = id;
      }
    }
  }
  return new THREE.BufferAttribute(out, 1);
}

// ---------------------------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------------------------

/** One set of uniforms shared by every patched material (updated once per frame). */
export const seeUniforms = {
  /** focus points in view space (xyz); w 1 = on */
  stFocus: { value: Array.from({ length: SEE_THROUGH.maxFocus }, () => new THREE.Vector4()) },
  /** each focus's feet, world y */
  stFeetY: { value: new Array<number>(SEE_THROUGH.maxFocus).fill(0) },
  /** radius, feather, margin, ramp */
  stShape: { value: new THREE.Vector4(SEE_THROUGH.radius, SEE_THROUGH.feather, SEE_THROUGH.margin, SEE_THROUGH.ramp) },
  /** lift, lift ramp */
  stLift: { value: new THREE.Vector2(SEE_THROUGH.lift, SEE_THROUGH.liftRamp) },
  /** each canopy cluster's visibility (1: opaque) */
  stCluster: { value: new Array<number>(SEE_THROUGH.maxClusters).fill(1) },
};

export const SEE_VERT_PARS = /* glsl */ `
#define ST_MAX ${SEE_THROUGH.maxClusters}
attribute float ${SEE_ATTR};
uniform float stCluster[ST_MAX];
varying vec3 vStView;
varying float vStWorldY;
varying float vStHole;
varying float vStVis;
`;

/** after mvPosition (view space) and `transformed` (object space) are known */
export const SEE_VERT = /* glsl */ `
  vStView = mvPosition.xyz;
  vStWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
  int stId = int(${SEE_ATTR} + 0.5);
  vStHole = stId >= 1 ? 1.0 : 0.0;
  vStVis = stId >= 2 ? stCluster[min(stId - 2, ST_MAX - 1)] : 1.0;
`;

export const SEE_FRAG_PARS = /* glsl */ `
#define ST_FOCUS ${SEE_THROUGH.maxFocus}
uniform vec4 stFocus[ST_FOCUS];
uniform float stFeetY[ST_FOCUS];
uniform vec4 stShape;
uniform vec2 stLift;
varying vec3 vStView;
varying float vStWorldY;
varying float vStHole;
varying float vStVis;
float stBayer(vec2 p) {
  ivec2 i = ivec2(mod(floor(p), 4.0));
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}
float stHoleAt(vec4 f, float feetY) {
  if (f.w < 0.5) return 0.0;
  float fd = max(-f.z, 1e-3);
  float d = max(-vStView.z, 1e-3);
  float nearer = 1.0 - smoothstep(fd - stShape.z - stShape.w, fd - stShape.z, d);
  float r = length(vStView.xy / d - f.xy / fd) * fd;
  float radial = 1.0 - smoothstep(stShape.x - 0.5 * stShape.y, stShape.x + 0.5 * stShape.y, r);
  float above = smoothstep(feetY + stLift.x, feetY + stLift.x + stLift.y, vStWorldY);
  return nearer * radial * above;
}
void stSeeThrough() {
  float hole = 0.0;
  for (int k = 0; k < ST_FOCUS; k++) hole = max(hole, stHoleAt(stFocus[k], stFeetY[k]));
  float vis = (1.0 - hole * vStHole) * vStVis;
  if (vis < 0.999 && vis <= stBayer(gl_FragCoord.xy)) discard;
}
`;

export const SEE_FRAG = /* glsl */ `
  stSeeThrough();
`;

/** Inserts `add` after the first `anchor` (before it: `before`); throws when the anchor is gone (a three.js upgrade moved it). */
function inject(src: string, anchor: string, add: string, before = false): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`see-through: no "${anchor}" in the shader`);
  return before ? src.slice(0, i) + add + src.slice(i) : src.slice(0, i + anchor.length) + add + src.slice(i + anchor.length);
}

/** The onBeforeCompile of every patched toon material (one function: one program per variant). */
export function seeThroughCompile(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  Object.assign(shader.uniforms, seeUniforms);
  shader.vertexShader = inject(inject(shader.vertexShader, "void main() {", SEE_VERT_PARS, true), "#include <project_vertex>", SEE_VERT);
  shader.fragmentShader = inject(inject(shader.fragmentShader, "void main() {", SEE_FRAG_PARS, true), "#include <clipping_planes_fragment>", SEE_FRAG);
}

const patched = new WeakSet<THREE.Material>();

/** Whether a material cuts the see-through hole. */
export function isSeeThrough(m: THREE.Material): boolean {
  return patched.has(m);
}

/** Patches an opaque lit material (toon) for the see-through; a mesh without the attribute reads 0 (never cut). */
export function patchSeeThrough<M extends THREE.Material>(m: M): M {
  if (patched.has(m) || m.transparent) return m;
  m.onBeforeCompile = seeThroughCompile as THREE.Material["onBeforeCompile"];
  m.customProgramCacheKey = () => "see-through";
  markSeeThrough(m);
  return m;
}

/** A shader material written with the see-through chunks (the outline hull): recorded, its default attribute set. */
export function markSeeThrough(m: THREE.Material) {
  const d = m as THREE.Material & { defaultAttributeValues?: Record<string, number[]> };
  d.defaultAttributeValues = { ...(d.defaultAttributeValues ?? {}), [SEE_ATTR]: [SEE_NEVER] };
  patched.add(m);
}

// ---------------------------------------------------------------------------------------------
// The same maths in JS (tests, checks): what the fragment shader computes
// ---------------------------------------------------------------------------------------------

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface HoleShape {
  radius: number;
  feather: number;
  margin: number;
  ramp: number;
  lift: number;
  liftRamp: number;
}

/**
 * How much of the hole a fragment is in, 0..1 (stHoleAt): `frag` and `focus` in view space (the
 * camera looks down -z), `fragY` the fragment's world height, `feetY` the focus's feet.
 */
export function holeAt(frag: THREE.Vector3, fragY: number, focus: THREE.Vector3, feetY: number, s: HoleShape = SEE_THROUGH): number {
  const fd = Math.max(-focus.z, 1e-3);
  const d = Math.max(-frag.z, 1e-3);
  const nearer = 1 - smooth(fd - s.margin - s.ramp, fd - s.margin, d);
  const r = Math.hypot(frag.x / d - focus.x / fd, frag.y / d - focus.y / fd) * fd;
  const radial = 1 - smooth(s.radius - 0.5 * s.feather, s.radius + 0.5 * s.feather, r);
  const above = smooth(feetY + s.lift, feetY + s.lift + s.liftRamp, fragY);
  return nearer * radial * above;
}

/** A fragment's visibility (1: drawn), before the dither: its tag, the hole, its cluster's fade. */
export function visibility(tag: number, hole: number, clusters: readonly number[] = seeUniforms.stCluster.value): number {
  const id = Math.round(tag);
  const clusterVis = id >= SEE_CLUSTER0 ? (clusters[Math.min(id - SEE_CLUSTER0, clusters.length - 1)] ?? 1) : 1;
  return (1 - (id >= SEE_HOLE ? hole : 0)) * clusterVis;
}

// ---------------------------------------------------------------------------------------------
// Per frame
// ---------------------------------------------------------------------------------------------

/** A canopy in a space: its cluster, and its footprint on the ground (the XZ box of its canopy parts). */
export interface Canopy {
  id: string;
  asset: string;
  cluster: number;
  min: [number, number];
  max: [number, number];
}

export function underCanopy(c: Canopy, x: number, z: number): boolean {
  return x >= c.min[0] && x <= c.max[0] && z >= c.min[1] && z <= c.max[1];
}

/** Drives the uniforms from main.ts's frame loop. */
export class SeeThroughControl {
  on = true;
  /** each cluster's current visibility (eased) */
  readonly vis = new Array<number>(SEE_THROUGH.maxClusters).fill(1);
  private v = new THREE.Vector3();

  get radius(): number {
    return seeUniforms.stShape.value.x;
  }
  set radius(r: number) {
    seeUniforms.stShape.value.x = r;
  }

  /**
   * `focus`: the feet of whoever must stay visible (the player first, then the NPC talked to;
   * null: none). `active` false (the fly-over): no hole, canopies back to opaque.
   */
  update(dt: number, camera: THREE.Camera, focus: readonly (THREE.Vector3 | null | undefined)[], canopies: readonly Canopy[], active = true) {
    camera.updateMatrixWorld();
    const on = this.on && active;
    const f = seeUniforms.stFocus.value;
    for (let k = 0; k < f.length; k++) {
      const p = focus[k];
      if (!on || !p) {
        f[k].w = 0;
        continue;
      }
      this.v.set(p.x, p.y + SEE_THROUGH.aimHeight, p.z).applyMatrix4(camera.matrixWorldInverse);
      f[k].set(this.v.x, this.v.y, this.v.z, 1);
      seeUniforms.stFeetY.value[k] = p.y;
    }
    const want = new Array<number>(this.vis.length).fill(1);
    if (on)
      for (const c of canopies) {
        if (c.cluster >= want.length) continue;
        if (focus.some((p) => p && underCanopy(c, p.x, p.z))) want[c.cluster] = SEE_THROUGH.canopyFade;
      }
    const k = dt > 0 ? 1 - Math.exp(-SEE_THROUGH.fadeRate * dt) : 1;
    const out = seeUniforms.stCluster.value;
    for (let i = 0; i < this.vis.length; i++) {
      this.vis[i] += (want[i] - this.vis[i]) * k;
      if (Math.abs(want[i] - this.vis[i]) < 1e-3) this.vis[i] = want[i];
      out[i] = this.vis[i];
    }
  }

  /** for checks: on / off, the shape, the focus depths, the canopies faded now */
  status(canopies: readonly Canopy[] = []) {
    const [radius, feather, margin, ramp] = seeUniforms.stShape.value.toArray();
    return {
      on: this.on,
      radius,
      feather,
      margin,
      ramp,
      lift: seeUniforms.stLift.value.x,
      focusDepth: seeUniforms.stFocus.value.map((f) => (f.w ? -f.z : null)),
      faded: canopies.filter((c) => this.vis[c.cluster] < 0.999).map((c) => ({ id: c.id, vis: +this.vis[c.cluster].toFixed(3) })),
    };
  }
}
