// The 3D world: one asset loader (shared cache, clone per instance), the toon look, and SceneSpace:
// the town and every interior instantiated by one class from layout.ts's SpaceLayout through the
// one anchor helper, with blockers, picking, street life and the time-of-day light. The town adds
// its landscape (at the origin), the sky dome, the sun from town.json and a far haze.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CharacterActor, type ActorOptions } from "./actor";
import { turnToward } from "./anim";
import { anchorToWorld, heldProp, yawFor, type Blocker, type Box2, type HeldPropSpec, type LayoutIndex, type Placement, type SpaceLayout, type Vec3 } from "./layout";
import type { WalkArea } from "./player";
import { ScatterMotion, WalkerMotion } from "./streetlife";

const DEG = Math.PI / 180;
export const BACKGROUND = "#EDD9B8";

// ---------------------------------------------------------------------------------------------
// Toon look
// ---------------------------------------------------------------------------------------------

/** 3-step gradient: shadow, mid, lit. Nearest filtering keeps the bands hard. */
function gradientMap(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Outline: inverted hull. Each outlined mesh gets a child drawing the same shape pushed out along
 * smoothed normals, back faces only, in one shared flat material. Chosen over OutlineEffect because
 * OutlineEffect re-renders the whole scene a second time every frame and swaps materials on every
 * object; the hull is one extra draw per outlined mesh, and flat ground (tiles, forecourt) simply
 * doesn't get one. Smoothed normals (vertices merged first) keep the hull closed at the hard edges
 * of these flat-shaded low-poly assets. A skinned mesh gets a skinned hull bound to the same
 * skeleton; the shader pushes out in bind space, then skins (three sets USE_SKINNING for it).
 */
const OUTLINE_THICKNESS = 0.022; // m
const outlineMaterial = new THREE.ShaderMaterial({
  uniforms: { thickness: { value: OUTLINE_THICKNESS }, color: { value: new THREE.Color("#2A2320") } },
  vertexShader: /* glsl */ `
    uniform float thickness;
    attribute vec3 hullNormal;
    #include <common>
    #include <skinning_pars_vertex>
    void main() {
      vec3 transformed = position + normalize(hullNormal) * thickness;
      #include <skinbase_vertex>
      #include <skinning_vertex>
      gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    void main() { gl_FragColor = vec4(color, 1.0); }`,
  side: THREE.BackSide,
});

/** Outline width multiplier (phones draw a thicker line, camera.ts outlineScale). */
export function setOutlineScale(k: number) {
  outlineMaterial.uniforms.thickness.value = OUTLINE_THICKNESS * k;
}

function hullGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", src.getAttribute("position"));
  for (const a of ["skinIndex", "skinWeight"]) if (src.getAttribute(a)) g.setAttribute(a, src.getAttribute(a));
  if (src.index) g.setIndex(src.index);
  // Average the normals of vertices at the same position, then map them back per original vertex.
  const merged = mergeVertices(new THREE.BufferGeometry().setAttribute("position", src.getAttribute("position").clone()), 1e-4);
  merged.computeVertexNormals();
  const mp = merged.getAttribute("position");
  const mn = merged.getAttribute("normal");
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const smooth = new Map<string, [number, number, number]>();
  for (let i = 0; i < mp.count; i++) {
    const k = key(mp.getX(i), mp.getY(i), mp.getZ(i));
    const n = smooth.get(k) ?? [0, 0, 0];
    smooth.set(k, [n[0] + mn.getX(i), n[1] + mn.getY(i), n[2] + mn.getZ(i)]);
  }
  const pos = src.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const n = smooth.get(key(pos.getX(i), pos.getY(i), pos.getZ(i))) ?? [0, 1, 0];
    out.set(n, i * 3);
  }
  g.setAttribute("hullNormal", new THREE.BufferAttribute(out, 3));
  return g;
}

class Toon {
  private gradient = gradientMap();
  private materials = new Map<string, THREE.MeshToonMaterial>();

  /** One toon material per source colour (palette colours: few materials, shared everywhere). */
  material(src: THREE.Material): THREE.MeshToonMaterial {
    const m = src as THREE.MeshStandardMaterial;
    const color = m.color ?? new THREE.Color(1, 1, 1);
    const emissive = m.emissive ?? new THREE.Color(0, 0, 0);
    const key = `${color.getHexString()}|${emissive.getHexString()}|${m.opacity}|${m.side}|${m.vertexColors ? "vc" : ""}`;
    let toon = this.materials.get(key);
    if (!toon) {
      toon = new THREE.MeshToonMaterial({
        color,
        emissive,
        vertexColors: m.vertexColors,
        gradientMap: this.gradient,
        transparent: m.transparent || m.opacity < 1,
        opacity: m.opacity,
        side: m.side,
        name: m.name,
      });
      this.materials.set(key, toon);
    }
    return toon;
  }

  flat(hex: string): THREE.MeshToonMaterial {
    let toon = this.materials.get(hex);
    if (!toon) {
      toon = new THREE.MeshToonMaterial({ color: new THREE.Color(hex), gradientMap: this.gradient });
      this.materials.set(hex, toon);
    }
    return toon;
  }

  /** Toon materials on every mesh of a template, plus outline hulls unless `outline` is false. */
  apply(root: THREE.Object3D, outline: boolean) {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const mesh of meshes) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.material(m)) : this.material(mesh.material);
      if (!outline) continue;
      const skinned = mesh as THREE.SkinnedMesh;
      let hull: THREE.Mesh;
      if (skinned.isSkinnedMesh) {
        const h = new THREE.SkinnedMesh(hullGeometry(mesh.geometry), outlineMaterial);
        h.bind(skinned.skeleton, skinned.bindMatrix);
        hull = h;
      } else hull = new THREE.Mesh(hullGeometry(mesh.geometry), outlineMaterial);
      hull.name = `${mesh.name}_outline`;
      hull.userData.outline = true;
      hull.raycast = () => {}; // never picked
      mesh.add(hull);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One mesh per character: its palette primitives merged, colours in the vertices
// ---------------------------------------------------------------------------------------------

/** The material a merged mesh uses (its colours are per vertex), one per side mode (Toon turns it into one toon material). */
const vertexColourSources = new Map<THREE.Side, THREE.MeshStandardMaterial>();
function vertexColourSource(side: THREE.Side): THREE.MeshStandardMaterial {
  let m = vertexColourSources.get(side);
  if (!m) vertexColourSources.set(side, (m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, name: "vertex_colours", side })));
  return m;
}

/**
 * A glTF mesh with one primitive per palette colour loads as a group of meshes, one draw each (a
 * rigged human is 5-7; with its outline hulls twice that, and they can't be batched: they move).
 * Merges each such group into one mesh, the colour of each primitive's material written into its
 * vertices: one draw (and one hull) per character or held prop, drawn exactly as before (toon
 * colour x vertex colour). Only opaque, untextured, non-emissive primitives sharing one skeleton /
 * transform and one attribute layout are merged; anything else stays as it is.
 */
export function mergePrimitives(root: THREE.Object3D): number {
  let merged = 0;
  const groups: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.children.filter((c) => (c as THREE.Mesh).isMesh).length > 1) groups.push(o);
  });
  for (const g of groups) {
    const meshes = g.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && !c.children.length);
    const first = meshes[0] as THREE.SkinnedMesh | undefined;
    if (!first || meshes.length < 2) continue;
    const attrs = (m: THREE.Mesh) => Object.keys(m.geometry.attributes).sort().join(",");
    const plain = (m: THREE.Mesh) => {
      const mat = m.material as THREE.MeshStandardMaterial;
      return !Array.isArray(m.material) && !mat.map && mat.opacity === 1 && !mat.transparent && !(mat.emissive && mat.emissive.getHex()) && !Object.keys(m.geometry.morphAttributes).length;
    };
    const same = (m: THREE.Mesh) => {
      const sk = m as THREE.SkinnedMesh;
      return (
        !!sk.isSkinnedMesh === !!first.isSkinnedMesh &&
        (!first.isSkinnedMesh || (sk.skeleton === first.skeleton && sk.bindMatrix.equals(first.bindMatrix))) &&
        m.matrix.equals(first.matrix) &&
        (m.material as THREE.Material).side === (first.material as THREE.Material).side &&
        attrs(m) === attrs(first) &&
        !!m.geometry.index === !!first.geometry.index
      );
    };
    if (!meshes.every((m) => plain(m) && same(m))) continue;
    const geoms = meshes.map((m) => {
      const geo = m.geometry.clone();
      const c = (m.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
      const n = geo.getAttribute("position").count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      return geo;
    });
    const geo = mergeGeometries(geoms, false);
    if (!geo) continue;
    const mat = vertexColourSource((first.material as THREE.Material).side);
    let one: THREE.Mesh;
    if (first.isSkinnedMesh) {
      const sk = new THREE.SkinnedMesh(geo, mat);
      sk.bind(first.skeleton, first.bindMatrix);
      one = sk;
    } else one = new THREE.Mesh(geo, mat);
    one.name = first.name;
    one.matrix.copy(first.matrix);
    one.matrix.decompose(one.position, one.quaternion, one.scale);
    one.frustumCulled = first.frustumCulled;
    for (const m of meshes) m.removeFromParent();
    g.add(one);
    merged += meshes.length - 1;
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// The one asset loader
// ---------------------------------------------------------------------------------------------

/** Flat ground assets get no outline: it would only draw a line round every tile (the landscape: terrain, water, hills, sky). */
const NO_OUTLINE_SETS = new Set(["tiles", "landscape"]);
const isFlat = (name: string) => /^(road_|pavement_|manhole|drain_grate)/.test(name);

export class AssetCache {
  private loader = new GLTFLoader();
  private templates = new Map<string, Promise<THREE.Object3D>>();
  readonly toon = new Toon();

  constructor(
    private base: string,
    private L: LayoutIndex,
  ) {}

  /** The processed template for an asset, loaded once. */
  template(name: string): Promise<THREE.Object3D> {
    let p = this.templates.get(name);
    if (!p) {
      const entry = this.L.asset(name);
      p = this.loader.loadAsync(`${this.base}/${entry.path}`).then((gltf) => {
        const root = gltf.scene;
        root.name = name;
        root.animations = gltf.animations; // kept through clone(): the actor's clips
        // Characters and what they hold move, so they can't be batched: one mesh each instead.
        if (entry.set === "characters") mergePrimitives(root);
        this.toon.apply(root, !NO_OUTLINE_SETS.has(entry.set) && !isFlat(name));
        return root;
      });
      this.templates.set(name, p);
    }
    return p;
  }

  /**
   * A new instance: geometry and materials shared with the template. SkeletonUtils' clone, so a
   * skinned mesh (and its outline hull) binds to the instance's own bones, not the template's.
   */
  async instance(name: string): Promise<THREE.Object3D> {
    return cloneSkinned(await this.template(name));
  }

  /** Actor settings from the asset's index entry: walk stride and the no-bone head height. */
  actorOptions(name: string): ActorOptions {
    const e = this.L.asset(name);
    return { strideM: e.rig?.stride_m, headTopY: (e.anchors?.head_top as Vec3 | undefined)?.[1] ?? (e.anchors?.top as Vec3 | undefined)?.[1] };
  }

  /** Loads every template in parallel (the layout's assets), reporting progress. */
  async preload(onProgress?: (done: number, total: number) => void) {
    const names = this.L.assetNames();
    let done = 0;
    await Promise.all(names.map((n) => this.template(n).then(() => onProgress?.(++done, names.length))));
  }

  /** A new animated character. */
  async actor(name: string): Promise<CharacterActor> {
    return new CharacterActor(await this.instance(name), this.actorOptions(name));
  }
}

// ---------------------------------------------------------------------------------------------
// Static batching: fewer draw calls
// ---------------------------------------------------------------------------------------------

/** What a merged batch must share: the material, the attribute layout, indexed or not. */
function batchKey(mesh: THREE.Mesh): string | null {
  const g = mesh.geometry;
  if (Array.isArray(mesh.material) || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return null;
  if (Object.keys(g.morphAttributes).length || !mesh.visible) return null;
  const attrs = Object.keys(g.attributes)
    .sort()
    .map((n) => {
      const a = g.getAttribute(n) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const arr = (a as THREE.BufferAttribute).array ?? (a as THREE.InterleavedBufferAttribute).data.array;
      return `${n}:${a.itemSize}:${a.normalized}:${arr.constructor.name}`;
    })
    .join(",");
  return `${mesh.material.uuid}|${attrs}|${g.index ? "i" : "n"}`;
}

/** A copy of the mesh's geometry in world space (plain attributes; the hull's push-out normals turned too). */
function worldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, (a as THREE.BufferAttribute).clone());
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(mesh.matrixWorld); // position, normal, tangent
  const hn = g.getAttribute("hullNormal") as THREE.BufferAttribute | undefined;
  if (hn) hn.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
  return g;
}

/**
 * Merges every static mesh under `roots` (ground, tiles, buildings, props: never characters or
 * anything they hold) into one mesh per batch key, added to `scene`; the source meshes go. The
 * roots themselves stay (empty, named: scene lookups by name still work). Returns the number of
 * meshes merged away. Frustum culling then works per batch, not per prop: fine for one street.
 */
export function mergeStatic(scene: THREE.Object3D, roots: THREE.Object3D[]): number {
  scene.updateMatrixWorld(true);
  const batches = new Map<string, THREE.Mesh[]>();
  for (const root of roots)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const key = batchKey(mesh);
      if (!key) return;
      const list = batches.get(key) ?? [];
      list.push(mesh);
      batches.set(key, list);
    });
  const gone = new Set<THREE.Object3D>();
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const merged = mergeGeometries(meshes.map(worldGeometry), false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const src = meshes[0];
    const batch = new THREE.Mesh(merged, src.material);
    batch.name = `batch:${(src.material as THREE.Material).name || src.name}`;
    batch.matrixAutoUpdate = false;
    batch.userData.batch = meshes.length;
    if (src.userData.outline) {
      batch.userData.outline = true;
      batch.raycast = () => {};
    }
    scene.add(batch);
    for (const m of meshes) gone.add(m);
  }
  for (const m of gone) {
    // A merged mesh's children that weren't merged (an unbatchable hull) keep their place in the world.
    for (const c of [...m.children]) if (!gone.has(c)) m.parent?.attach(c);
    m.removeFromParent();
  }
  return gone.size;
}

/** Draw calls a render of `root` would issue with nothing culled: one per visible mesh (per group for multi-material). */
export function drawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (Array.isArray(m.material)) {
      const mats = m.material;
      n += m.geometry.groups.length ? m.geometry.groups.filter((g) => mats[g.materialIndex ?? 0]?.visible).length : mats.filter((x) => x.visible).length;
    } else if (m.material.visible) n += 1;
  });
  return n;
}

// ---------------------------------------------------------------------------------------------
// Scene spaces: the street and every interior, built by one class from layout.ts's SpaceLayout
// ---------------------------------------------------------------------------------------------

export interface NpcView {
  npc: string;
  actor: CharacterActor;
  /** the stand's facing, turned back to when the player walks off */
  homeYaw: number;
}

export interface WalkerView {
  actor: CharacterActor;
  motion: WalkerMotion;
}

export interface ScatterView {
  actor: CharacterActor;
  motion: ScatterMotion;
}

/** NPCs turn to the player inside this range (m), and always during their scene. */
export const FACE_RANGE = 3;
const NPC_TURN_RATE = 5; // 1/s, yaw easing
const WALKER_TURN_RATE = 8;

/** Asset kinds (index.json) that are characters: animated with an actor, idle when standing about. */
const CHARACTER_KINDS = new Set(["human", "recolour", "pet"]);

/** Pick proxies: raycast, never drawn. */
const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Time of day, 4 keyframes evenly spaced over 0 (morning) .. 1 (evening): morning (cool, bright) ->
 * midday (neutral, brightest, sun high) -> afternoon (warming) -> evening (orange, dimmer, sun low
 * for a longer-shadow feel) so each quarter-day slot reads as a distinct step, not a barely-moved
 * 2-stop lerp. `sunAngle`: degrees of the sun above the horizon (only its height changes; its
 * azimuth is fixed so the outline / toon shading direction doesn't spin).
 */
const DAY = {
  sky: [new THREE.Color("#DCEBFF"), new THREE.Color("#FFF4E0"), new THREE.Color("#FFD9A0"), new THREE.Color("#FF9E5E")],
  ground: [new THREE.Color("#7C8A99"), new THREE.Color("#8A7A66"), new THREE.Color("#8C6A4E"), new THREE.Color("#4A3A52")],
  sun: [new THREE.Color("#D8E8FF"), new THREE.Color("#FFFFFF"), new THREE.Color("#FFD9A0"), new THREE.Color("#FF7A3D")],
  sunIntensity: [2.4, 2.2, 1.85, 1.1],
  sunAngle: [35, 55, 40, 12],
  background: [new THREE.Color("#CFE3F5"), new THREE.Color(BACKGROUND), new THREE.Color("#F2C79A"), new THREE.Color("#8C6270")],
  fog: [new THREE.Color("#CFE3F5"), new THREE.Color(BACKGROUND), new THREE.Color("#F2C79A"), new THREE.Color("#6E4E5A")],
  /** the town's sky dome (and its haze) times this: cool morning, clear midday, warm afternoon, orange evening */
  skyTint: [new THREE.Color("#E6EEFF"), new THREE.Color("#FFFFFF"), new THREE.Color("#FFE0B8"), new THREE.Color("#FF9F72")],
};
/** The midday stop of DAY.sunAngle: the town's `sun.elevationDeg` lands there. */
const MIDDAY_SUN = 55;
/** Fixed horizontal offset (m) the sun keeps as it swings from high (morning/midday) to low (evening). */
const SUN_HORIZ: [number, number] = [-6, 9];

/** The town's sun: compass bearing (from north, -z, toward east, +x) -> the same horizontal offset length. */
function sunHoriz(azimuthDeg: number): [number, number] {
  const r = Math.hypot(...SUN_HORIZ);
  return [Math.sin(azimuthDeg * DEG) * r, -Math.cos(azimuthDeg * DEG) * r];
}

/** `stops[0..n]` at k=0..1, evenly spaced: which two stops `k` falls between, and how far (0..1). */
function stopIndex(stops: readonly unknown[], k: number): { i: number; t: number } {
  const n = stops.length - 1;
  const scaled = Math.max(0, Math.min(1, k)) * n;
  const i = Math.min(n - 1, Math.floor(scaled));
  return { i, t: scaled - i };
}

function lerpStops(stops: THREE.Color[], k: number, out: THREE.Color): THREE.Color {
  const { i, t } = stopIndex(stops, k);
  return out.copy(stops[i]).lerp(stops[i + 1], t);
}

function lerpNums(nums: number[], k: number): number {
  const { i, t } = stopIndex(nums, k);
  return nums[i] + (nums[i + 1] - nums[i]) * t;
}

export type PickHit = { npc: string } | { target: string } | { ground: THREE.Vector3 };

export class SceneSpace {
  readonly scene = new THREE.Scene();
  readonly blockers: Blocker[] = [];
  readonly npcs = new Map<string, NpcView>();
  /** street extras and pets from the dressing list: idle in place */
  readonly extras: CharacterActor[] = [];
  readonly walkers: WalkerView[] = [];
  readonly scatterers: ScatterView[] = [];
  readonly layout: SpaceLayout;
  private pickables: THREE.Object3D[] = [];
  private groundPlane: THREE.Plane;
  private ray = new THREE.Raycaster();
  private hemi = new THREE.HemisphereLight(0xfff4e0, 0x8a7a66, 1.1);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private background: THREE.Color;
  /** the sun's fixed horizontal offset: the town's bearing, else the street default */
  private sunHoriz: [number, number];
  /** the town's sky dome materials and their own colours (tinted through the day), and the haze colour it starts from */
  private sky: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[] = [];
  private horizon?: THREE.Color;
  /** static batching (mergeStatic): draw calls before / after, meshes merged away */
  batching = { before: 0, after: 0, merged: 0 };

  private constructor(
    readonly L: LayoutIndex,
    readonly assets: AssetCache,
    readonly id: string,
  ) {
    this.layout = L.space(id);
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.layout.surfaces.default);
    this.background = new THREE.Color(this.layout.background ?? BACKGROUND);
    this.sunHoriz = this.layout.town ? sunHoriz(this.layout.town.sun.azimuthDeg) : SUN_HORIZ;
  }

  static async create(L: LayoutIndex, assets: AssetCache, id: string): Promise<SceneSpace> {
    const w = new SceneSpace(L, assets, id);
    await w.build();
    return w;
  }

  /** The walking area for the player (player.ts). */
  get area(): WalkArea {
    return {
      bounds: this.layout.bounds,
      blockers: this.blockers,
      walkable: this.layout.town ? (x, z) => this.L.walkable(this.id, x, z) : undefined,
      heightAt: (x, z) => this.L.heightAt(this.id, x, z),
    };
  }

  private place(obj: THREE.Object3D, p: Pick3<Placement>) {
    obj.position.set(p.pos[0], p.pos[1], p.pos[2]);
    obj.rotation.set((p.tiltX ?? 0) * DEG, p.rotY * DEG, 0, "YXZ");
    obj.scale.setScalar(p.scale ?? 1);
  }

  private async build() {
    const { L, scene, layout } = this;
    scene.background = this.background.clone();
    const town = layout.town;
    // A soft depth fog outdoors only (interiors are enclosed, small; no far plane to fade into):
    // cheap (no shadow maps, just a colour that lerps with the sky in setDaylight) atmospheric depth.
    // The town's is a far haze (town.json fog): clear over the 140 m plateau, a veil on the mountains.
    if (!layout.interior) scene.fog = town ? new THREE.Fog(this.background.clone(), town.fog.near, town.fog.far) : new THREE.Fog(this.background.clone(), 26, 90);
    scene.add(this.hemi);
    this.sun.position.set(this.sunHoriz[0], 14, this.sunHoriz[1]);
    scene.add(this.sun);
    /** everything that never moves: batched by material at the end */
    const statics: THREE.Object3D[] = [];

    if (town) {
      // The landscape GLBs share the world origin; the sky dome is drawn unlit and unfogged, behind everything.
      for (const name of town.landscape) {
        const o = await this.assets.instance(name);
        o.name = name;
        scene.add(o);
        statics.push(o);
      }
      if (town.sky) await this.addSky(town.sky);
    } else if (!layout.interior) {
      // Endless ground under everything, then the mock-up's forecourt / road-extension boxes.
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.assets.toon.flat("#C8C1B2"));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      scene.add(floor);
      statics.push(floor);
    }
    for (const g of layout.ground) {
      const size = [0, 1, 2].map((i) => g.max[i] - g.min[i]);
      const box = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), this.assets.toon.flat(g.colour));
      box.position.set((g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2);
      box.name = g.name;
      scene.add(box);
      statics.push(box);
    }

    for (const t of layout.tiles) {
      const o = await this.assets.instance(t.asset);
      this.place(o, t);
      scene.add(o);
      statics.push(o);
    }
    for (const b of layout.pieces) {
      const o = await this.assets.instance(b.asset);
      this.place(o, b);
      o.name = b.id;
      scene.add(o);
      statics.push(o);
      const blocker = b.block === "footprint" ? this.buildingBlocker(b, await this.assets.template(b.asset)) : b.block === "size" ? L.sizeBlocker(b) : null;
      if (blocker) this.blockers.push(blocker);
    }
    this.blockers.push(...layout.blockers); // the town's own (oriented rects)
    for (const d of layout.dressing) {
      const e = L.asset(d.asset);
      if (e.set === "characters" && CHARACTER_KINDS.has(e.kind ?? "")) {
        const a = await this.assets.actor(d.asset);
        this.place(a.root, d);
        scene.add(a.root);
        if (d.behaviour === "scatter") this.scatterers.push({ actor: a, motion: new ScatterMotion([d.pos[0], d.pos[2]], d.rotY * DEG) });
        else this.extras.push(a);
        continue;
      }
      const o = await this.assets.instance(d.asset);
      this.place(o, d);
      scene.add(o);
      statics.push(o);
    }
    for (const w of layout.walkers) {
      const a = await this.assets.actor(w.character);
      await this.holdProp(a, w.heldProp);
      const motion = new WalkerMotion(w.path, w.speed);
      a.root.position.set(motion.x, L.heightAt(this.id, motion.x, motion.z), motion.z);
      a.root.rotation.y = motion.yaw;
      scene.add(a.root);
      this.walkers.push({ actor: a, motion });
    }
    for (const npc of layout.npcs) {
      const n = L.npc(npc);
      const stand = L.npcStand(npc);
      const actor = await this.assets.actor(n.character);
      const o = actor.root;
      o.position.set(...stand.pos);
      o.rotation.y = yawFor(stand.facing);
      await this.holdProp(actor, n.heldProp);
      // A generous invisible cylinder to tap, so a thumb doesn't have to hit the thin model.
      const proxy = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.1, 8), pickMaterial);
      proxy.position.y = 1.05;
      o.add(proxy);
      o.traverse((c) => (c.userData.npc = npc));
      scene.add(o);
      this.pickables.push(proxy);
      this.npcs.set(npc, { npc, actor, homeYaw: o.rotation.y });
      this.blockers.push({ min: [stand.pos[0] - 0.25, stand.pos[2] - 0.25], max: [stand.pos[0] + 0.25, stand.pos[2] + 0.25] });
    }
    // Things to use (bed, notebook): a tap box each, with the prompt target's id.
    layout.interactables.forEach((x, i) => {
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), pickMaterial);
      proxy.position.set(x.pos[0], x.pos[1], x.pos[2]);
      proxy.userData.target = `${x.kind}:${i}`;
      scene.add(proxy);
      this.pickables.push(proxy);
    });
    // Characters (NPCs, walkers, extras, pigeons) and what they hold stay separate: they animate.
    this.batching.before = drawCalls(scene);
    this.batching.merged = mergeStatic(scene, statics);
    this.batching.after = drawCalls(scene);
  }

  /**
   * The sky dome: each of its colours as an unlit, unfogged material (drawn first, never writing
   * depth), kept to tint through the day; its horizon colour is the haze's.
   */
  private async addSky(name: string) {
    const o = await this.assets.instance(name);
    o.name = name;
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.outline) return;
      const src = mesh.material as THREE.MeshToonMaterial;
      const base = src.color.clone();
      const mat = new THREE.MeshBasicMaterial({ color: base.clone(), fog: false, side: THREE.DoubleSide, depthWrite: false, name: src.name });
      mesh.material = mat;
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;
      this.sky.push({ mat, base });
    });
    // The horizon band is the lighter, less saturated colour of the two.
    const hsl = { h: 0, s: 0, l: 0 };
    this.horizon = this.sky.map((x) => x.base).sort((a, b) => b.getHSL(hsl).l - a.getHSL(hsl).l)[0]?.clone();
    if (this.horizon) {
      this.background.copy(this.horizon);
      (this.scene.background as THREE.Color).copy(this.horizon);
      if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.horizon);
    }
    this.scene.add(o);
  }

  /** The one held-prop path (NPCs and walkers): the carry pose only for `carry: true` props. */
  private async holdProp(actor: CharacterActor, spec: HeldPropSpec | undefined) {
    const prop = heldProp(spec);
    if (prop) actor.hold(await this.assets.instance(prop.asset), { carry: prop.carry });
  }

  /**
   * A building blocks its footprint, cut short 0.35 m before its player_stand so the player can
   * always reach where they talk from (awnings, steps and the warehouse dock stick out in front).
   */
  private buildingBlocker(b: Placement, template: THREE.Object3D): Box2 {
    const box = new THREE.Box3().setFromObject(template);
    const stand = this.L.asset(b.asset).anchors?.player_stand as { pos: Vec3 } | undefined;
    const maxZ = stand ? Math.min(box.max.z, stand.pos[2] - 0.35) : box.max.z;
    const corners: Vec3[] = [
      [box.min.x, 0, box.min.z],
      [box.max.x, 0, box.min.z],
      [box.min.x, 0, maxZ],
      [box.max.x, 0, maxZ],
    ].map((c) => anchorToWorld(b, c as Vec3));
    const xs = corners.map((c) => c[0]);
    const zs = corners.map((c) => c[2]);
    return { min: [Math.min(...xs), Math.min(...zs)], max: [Math.max(...xs), Math.max(...zs)] };
  }

  /** What's under a screen point: an NPC, a thing to use, else a spot on the ground (the town's: on its walking height). */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): PickHit | null {
    this.ray.setFromCamera(ndc, camera);
    const hit = this.ray.intersectObjects(this.pickables, false)[0];
    if (hit?.object.userData.npc) return { npc: hit.object.userData.npc as string };
    if (hit?.object.userData.target) return { target: hit.object.userData.target as string };
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.groundPlane, p)) return null;
    // Uneven ground: slide the hit to the walking height under it (a few steps settle on gentle slopes and decks).
    if (this.layout.town) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      for (let i = 0; i < 4; i++) {
        plane.constant = -this.L.heightAt(this.id, p.x, p.z);
        if (!this.ray.ray.intersectPlane(plane, p)) break;
      }
    }
    return { ground: p };
  }

  /** An NPC's head top in world space (HeadTop bone), for anchoring the speech bubble. */
  head(npc: string, out = new THREE.Vector3()): THREE.Vector3 | undefined {
    return this.npcs.get(npc)?.actor.headTop(out);
  }

  /** The NPC whose line is on screen in a scene plays `talk`; everyone else stops. */
  setTalking(npc: string | null) {
    for (const v of this.npcs.values()) v.actor.talking = v.npc === npc;
  }

  /** A mix-up: the NPC shrugs (talk + head shake: the rigs have no shrug clip). */
  shrug(npc: string) {
    this.npcs.get(npc)?.actor.shrug();
  }

  /**
   * Time of day, 0 (morning) .. 1 (evening): steps the hemisphere sky/ground, the sun's colour,
   * intensity and height, and (outdoors) the background and fog through 4 keyframes (morning ->
   * midday -> afternoon -> evening) so each quarter-day slot is a visibly different look, not a
   * barely-moved 2-colour lerp. Interiors shift less (a window's worth of light) and keep their own
   * wall colour instead of the sky.
   */
  setDaylight(f: number) {
    const k = Math.max(0, Math.min(1, f)) * (this.layout.interior ? 0.45 : 1);
    lerpStops(DAY.sky, k, this.hemi.color);
    lerpStops(DAY.ground, k, this.hemi.groundColor);
    lerpStops(DAY.sun, k, this.sun.color);
    this.sun.intensity = lerpNums(DAY.sunIntensity, k);
    // The sun swings low toward evening (grazing light, a longer-shadow feel) without moving its
    // azimuth, so the toon shading's light direction only dips, never spins. The town's sun
    // (town.json) sits at its own bearing and reaches its own elevation at midday.
    const town = this.layout.town;
    const angle = lerpNums(DAY.sunAngle, k) * (town ? town.sun.elevationDeg / MIDDAY_SUN : 1) * DEG;
    const horiz = Math.hypot(...this.sunHoriz);
    this.sun.position.set(this.sunHoriz[0], Math.tan(angle) * horiz, this.sunHoriz[1]);
    if (this.horizon) {
      // The town: the dome and the haze (and the background behind them) take the day's tint.
      const tint = lerpStops(DAY.skyTint, k, new THREE.Color());
      for (const s of this.sky) s.mat.color.copy(s.base).multiply(tint);
      (this.scene.background as THREE.Color).copy(this.horizon).multiply(tint);
      if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.horizon).multiply(tint);
    } else if (!this.layout.interior) {
      lerpStops(DAY.background, k, this.scene.background as THREE.Color);
      if (this.scene.fog instanceof THREE.Fog) lerpStops(DAY.fog, k, this.scene.fog.color);
    }
  }

  /**
   * Per frame: NPCs face the player when within FACE_RANGE or in their scene (`sceneNpc`), else
   * turn back to their stand's facing; walkers pace, pigeons scatter; every character animates.
   */
  update(dt: number, player: THREE.Vector3, sceneNpc: string | null) {
    for (const v of this.npcs.values()) {
      const p = v.actor.root.position;
      const dx = player.x - p.x;
      const dz = player.z - p.z;
      const look = v.npc === sceneNpc || Math.hypot(dx, dz) <= FACE_RANGE;
      const yaw = look && Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : v.homeYaw;
      v.actor.root.rotation.y = turnToward(v.actor.root.rotation.y, yaw, NPC_TURN_RATE * dt);
      v.actor.update(dt, 0);
    }
    for (const w of this.walkers) {
      const speed = w.motion.update(dt, player.x, player.z);
      const r = w.actor.root;
      r.position.set(w.motion.x, r.position.y + (this.L.heightAt(this.id, w.motion.x, w.motion.z) - r.position.y) * Math.min(1, dt * 12), w.motion.z);
      r.rotation.y = turnToward(r.rotation.y, w.motion.yaw, WALKER_TURN_RATE * dt);
      w.actor.update(dt, speed);
    }
    for (const s of this.scatterers) {
      const speed = s.motion.update(dt, player.x, player.z);
      const r = s.actor.root;
      // A little hop while darting away (pigeons only have an idle clip).
      const hop = speed > 0.8 ? Math.abs(Math.sin(performance.now() / 55)) * 0.06 : 0;
      r.position.set(s.motion.x, this.L.heightAt(this.id, s.motion.x, s.motion.z) + hop, s.motion.z);
      r.rotation.y = turnToward(r.rotation.y, s.motion.yaw, WALKER_TURN_RATE * dt);
      s.actor.update(dt, 0);
    }
    for (const a of this.extras) a.update(dt, 0);
  }
}

type Pick3<T extends Placement> = Pick<T, "pos" | "rotY" | "tiltX" | "scale">;
