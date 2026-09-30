// The 3D world: one asset loader (shared cache, clone per instance), the toon look, and SceneSpace:
// the town and every interior instantiated by one class from layout.ts's SpaceLayout through the
// one anchor helper, with blockers, picking, street life and the time-of-day light. The town adds
// its landscape (at the origin), the sky dome, the sun from town.json and a far haze.
import * as THREE from "three";
import { bandWalls, buildInteriorEnclosure, interiorFaces } from "./interior-enclosure";
import { buildInteriorBackdrop } from "./interior-backdrop";
import type { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CharacterActor, type ActorOptions } from "./actor";
import { turnToward } from "./anim";
import { buildCountryside, flyoverViews, hazeColour, HORIZON, moveClouds, type Part } from "./horizon";
import { canReadImages, packSources, readImage, sliced, type AtlasSource, type PackedAtlas, type PackRect } from "./atlas";
import { CANOPIES, isSeeThrough, markSeeThrough, patchSeeThrough, seeAttribute, SEE_ATTR, SEE_FRAG, SEE_FRAG_PARS, SEE_ID0, SEE_NEVER, SEE_OCCLUDER, SEE_VERT, SEE_VERT_PARS, SEE_THROUGH, seeSpecFor, seeUniforms, type Occluder, type SeeSpec } from "./seethrough";
import { ModuleLoadError } from "./boot";
import { applyDetail, detailFor, type DetailSpec } from "./detail";
import { figureId } from "./barks";
import { CHARACTER_KINDS, type LoadEvent } from "./loading";
import { anchorToWorld, heldProp, yawFor, type Blocker, type Box2, type HeldPropSpec, type LayoutIndex, type Placement, type SpaceLayout, type Vec3 } from "./layout";
import type { WalkArea } from "./player";
import { ScatterMotion, WalkerMotion } from "./streetlife";
import { LOOK, REAL_HEMI, REAL_SHADOW, REAL_SUN, SHADOW_CELL, ShadowScheduler, type LookGround, type LookSky } from "./look";

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
const outlineUniforms = { thickness: { value: OUTLINE_THICKNESS }, color: { value: new THREE.Color("#2A2320") } };
/** The hull shader; `see`: with the see-through cutout, so a fading root's outline fades with it. */
function outline(see: boolean): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: see ? { ...outlineUniforms, ...seeUniforms } : { ...outlineUniforms },
    vertexShader: /* glsl */ `
    uniform float thickness;
    attribute vec3 hullNormal;
    #include <common>
    #include <skinning_pars_vertex>
    ${see ? SEE_VERT_PARS : ""}
    void main() {
      vec3 transformed = position + normalize(hullNormal) * thickness;
      #include <skinbase_vertex>
      #include <skinning_vertex>
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      ${see ? SEE_VERT : ""}
      gl_Position = projectionMatrix * mvPosition;
    }`,
    fragmentShader: /* glsl */ `
    uniform vec3 color;
    ${see ? SEE_FRAG_PARS : ""}
    void main() {
      ${see ? SEE_FRAG : ""}
      gl_FragColor = vec4(color, 1.0);
    }`,
    side: THREE.BackSide,
    name: see ? "outline" : "outline_character",
  });
  if (see) markSeeThrough(m);
  return m;
}
/** the static world's hulls (cut by the see-through) */
const outlineMaterial = outline(true);
/** characters' hulls are never patched: they are what the object fade reveals */
const characterOutline = outline(false);
/** Every hull's material (the real look hides them from its AO pass: reallook.ts createRealLook). */
export const OUTLINE_MATERIALS: readonly THREE.Material[] = [outlineMaterial, characterOutline];

/** Outline width multiplier (phones draw a thicker line, camera.ts outlineScale). */
export function setOutlineScale(k: number) {
  outlineUniforms.thickness.value = OUTLINE_THICKNESS * k;
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

/**
 * A textured source material's maps (the textured assets: base colour, tangent-space normal, ORM =
 * occlusion R / roughness G / metalness B, all on TEXCOORD_0; docs/asset-conventions.md
 * "Textures"), as the toon and the real-look materials take them; null for the flat palette
 * materials, which then convert exactly as before. The textures are shared, not cloned, so each
 * keeps GLTFLoader's colour space, sampler, flipY and `channel` (the UV set: three 0.186 reads the
 * aoMap from its texture's channel, no uv2 needed). Toon has no roughness / metalness.
 */
function surfaceMaps(m: THREE.MeshStandardMaterial) {
  if (!m.map && !m.normalMap && !m.aoMap && !m.roughnessMap && !m.metalnessMap && !m.emissiveMap) return null;
  const shared = {
    map: m.map,
    normalMap: m.normalMap,
    normalMapType: m.normalMapType,
    normalScale: m.normalScale.clone(),
    aoMap: m.aoMap,
    aoMapIntensity: m.aoMapIntensity,
    emissiveMap: m.emissiveMap,
  };
  const ids = [m.map, m.normalMap, m.aoMap, m.roughnessMap, m.metalnessMap, m.emissiveMap].map((t) => t?.uuid ?? "-").join(",");
  return {
    key: `${ids}|${m.normalScale.x},${m.normalScale.y}|${m.aoMapIntensity}|${m.roughness},${m.metalness}`,
    toon: shared,
    standard: { ...shared, roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap },
  };
}

/** Where a source material comes from (its asset and the asset's set): the detail family's overrides (detail.ts familyOf). */
export interface MaterialSource {
  set?: string;
  asset?: string;
}

class Toon {
  private gradient = gradientMap();
  private materials = new Map<string, THREE.MeshToonMaterial>();

  /**
   * One toon material per source colour (palette colours: few materials, shared everywhere); the
   * world's are patched for the see-through (seethrough.ts), `character`'s kept apart and never.
   */
  material(src: THREE.Material, character = false, from?: MaterialSource): THREE.MeshToonMaterial {
    const m = src as THREE.MeshStandardMaterial;
    const color = m.color ?? new THREE.Color(1, 1, 1);
    const emissive = m.emissive ?? new THREE.Color(0, 0, 0);
    const maps = surfaceMaps(m);
    // real look: a textured (base colour mapped) world material takes its family's tiling detail (detail.ts); Classic / ramp never
    const detail = LOOK.real && !LOOK.ramp && maps?.standard.map && !character ? detailFor(m.name, from?.set, from?.asset) : null;
    const key = `${color.getHexString()}|${emissive.getHexString()}|${m.opacity}|${m.side}|${m.vertexColors ? "vc" : ""}${character ? "|character" : ""}${maps ? `|${maps.key}` : ""}${detail ? `|${m.name}|${detail.family}` : ""}`;
    let toon = this.materials.get(key);
    if (!toon && LOOK.real && !LOOK.ramp) {
      // real look (look.ts): a plain PBR surface in place of the toon ramp (typed as toon: the callers only read color / name);
      // a textured source keeps its maps and its own roughness / metalness factors (they scale the ORM map)
      toon = new THREE.MeshStandardMaterial({
        color,
        emissive,
        vertexColors: m.vertexColors,
        roughness: maps ? m.roughness : 0.8,
        metalness: maps ? m.metalness : 0,
        transparent: m.transparent || m.opacity < 1,
        opacity: m.opacity,
        side: m.side,
        name: m.name,
        ...maps?.standard,
      }) as unknown as THREE.MeshToonMaterial;
      if (!character) patchSeeThrough(toon);
      if (maps && from?.asset) toon.userData.asset = from.asset; // textured: one material per asset's atlas (envlook.ts's lantern glow reads it)
      if (detail) applyDetail(toon as unknown as THREE.MeshStandardMaterial, detail);
      this.materials.set(key, toon);
    }
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
        ...maps?.toon,
      });
      if (!character) patchSeeThrough(toon);
      this.materials.set(key, toon);
    }
    return toon;
  }

  /**
   * The material of a static family batch (StaticFamilies): white, its colours per vertex; with a
   * packed atlas page, that page's base colour as `map` and its ORM as `aoMap` (+ roughness /
   * metalness maps in the real look), exactly as Toon.material hands a textured source's maps on.
   * Plain toon / standard materials (the see-through patch, and in the real look the members' tiling detail: detail.ts applyDetail), one per key.
   */
  family(f: { key: string; name: string; side: THREE.Side; roughness: number; metalness: number; aoMapIntensity: number; page: { base: THREE.Texture; orm: THREE.Texture } | null; detail?: DetailSpec }): THREE.MeshToonMaterial {
    let m = this.materials.get(f.key);
    if (m) return m;
    const maps = f.page ? { map: f.page.base, aoMap: f.page.orm, aoMapIntensity: f.aoMapIntensity } : {};
    if (LOOK.real && !LOOK.ramp)
      m = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: f.roughness,
        metalness: f.metalness,
        side: f.side,
        name: f.name,
        ...maps,
        ...(f.page ? { roughnessMap: f.page.orm, metalnessMap: f.page.orm } : {}),
      }) as unknown as THREE.MeshToonMaterial;
    else m = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: this.gradient, side: f.side, name: f.name, ...maps });
    patchSeeThrough(m);
    // the same tiling detail its textured members had (real look only: Toon.material sets none elsewhere)
    if (f.detail && (m as unknown as THREE.MeshStandardMaterial).isMeshStandardMaterial) applyDetail(m as unknown as THREE.MeshStandardMaterial, f.detail);
    this.materials.set(f.key, m);
    return m;
  }

  flat(hex: string): THREE.MeshToonMaterial {
    let toon = this.materials.get(hex);
    if (!toon && LOOK.real && !LOOK.ramp) {
      toon = patchSeeThrough(new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.8, metalness: 0 })) as unknown as THREE.MeshToonMaterial;
      this.materials.set(hex, toon);
    }
    if (!toon) {
      toon = patchSeeThrough(new THREE.MeshToonMaterial({ color: new THREE.Color(hex), gradientMap: this.gradient }));
      this.materials.set(hex, toon);
    }
    return toon;
  }

  /** Toon materials on every mesh of a template, plus outline hulls unless `outline` is false; `character`: never cut by the see-through. */
  apply(root: THREE.Object3D, outline: boolean, character = false, from?: MaterialSource) {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const mesh of meshes) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.material(m, character, from)) : this.material(mesh.material, character, from);
      if (LOOK.real) mesh.castShadow = mesh.receiveShadow = true; // real look: sun shadows (hulls below never cast)
      const hullMaterial = character ? characterOutline : outlineMaterial;
      if (!outline) continue;
      const skinned = mesh as THREE.SkinnedMesh;
      let hull: THREE.Mesh;
      if (skinned.isSkinnedMesh) {
        const h = new THREE.SkinnedMesh(hullGeometry(mesh.geometry), hullMaterial);
        h.bind(skinned.skeleton, skinned.bindMatrix);
        hull = h;
      } else hull = new THREE.Mesh(hullGeometry(mesh.geometry), hullMaterial);
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
  /**
   * The GLTF loader with three's meshopt decoder (the GLBs are meshopt-compressed: scripts/meshopt.mjs),
   * imported on first use: its own chunk (build.mjs splitting), fetched while the page starts up.
   */
  private loader: Promise<GLTFLoader> | null = null;
  /** every GLB request's manager: abort() stops them all (a stalled start, boot.ts StartWatch) */
  private manager = new THREE.LoadingManager();
  private templates = new Map<string, Promise<THREE.Object3D>>();
  readonly toon = new Toon();
  /** the templates loaded so far */
  readonly loaded = new Set<string>();
  /** every file's progress (the loading screen's reducer, loading.ts) */
  onLoad?: (e: LoadEvent) => void;

  /** `read`: the file's bytes from somewhere else than fetch (the tests read the GLBs from disk) */
  constructor(
    private base: string,
    private L: LayoutIndex,
    private opts: { read?: (url: string) => ArrayBuffer | Promise<ArrayBuffer> } = {},
  ) {}

  private gltfLoader(): Promise<GLTFLoader> {
    this.loader ??= Promise.all([import("three/examples/jsm/loaders/GLTFLoader.js"), import("three/examples/jsm/libs/meshopt_decoder.module.js")]).then(
      ([{ GLTFLoader }, { MeshoptDecoder }]) => new GLTFLoader(this.manager).setMeshoptDecoder(MeshoptDecoder),
      (e: unknown) => {
        this.loader = null;
        // the browser keeps a failed module until the page reloads: the loading screen offers Reload
        throw new ModuleLoadError(`the GLTF loader didn't load: ${(e as Error)?.message ?? e}`);
      },
    );
    return this.loader;
  }

  /**
   * Stops every GLB on its way and forgets every template not loaded yet, so the next ask (a
   * Retry, the next door) fetches it again: three's LoadingManager.abort() only reaches fetches
   * where AbortSignal.any exists (Chrome 116, Safari 17.4, Firefox 124); elsewhere a hung promise
   * would otherwise be handed out again.
   */
  abort() {
    this.manager.abort();
    for (const name of [...this.templates.keys()]) if (!this.loaded.has(name)) this.templates.delete(name);
  }

  private async fetchGltf(url: string, name: string): Promise<GLTF> {
    const loader = await this.gltfLoader();
    const read = this.opts.read;
    if (read) return loader.parseAsync(await read(url), "");
    return loader.loadAsync(url, (ev) => this.onLoad?.({ type: "progress", name, loaded: ev.loaded, total: ev.lengthComputable ? ev.total : undefined }));
  }

  /** The processed template for an asset, loaded once. */
  template(name: string): Promise<THREE.Object3D> {
    let p = this.templates.get(name);
    if (!p) {
      const entry = this.L.asset(name);
      this.onLoad?.({ type: "start", name, bytes: entry.bytes });
      const url = `${this.base}/${entry.path}`;
      const loaded = this.fetchGltf(url, name);
      p = loaded.then(
        (gltf) => {
          const root = gltf.scene;
          root.name = name;
          root.animations = gltf.animations; // kept through clone(): the actor's clips
          // Characters and what they hold move, so they can't be batched: one mesh each instead.
          if (entry.set === "characters") mergePrimitives(root);
          this.toon.apply(root, !NO_OUTLINE_SETS.has(entry.set) && !isFlat(name), entry.set === "characters", { set: entry.set, asset: name });
          this.loaded.add(name);
          this.onLoad?.({ type: "done", name });
          return root;
        },
        (e: unknown) => {
          this.onLoad?.({ type: "fail", name });
          // asked for again (a Retry, the next door), it loads again; a newer try (after abort()) stays
          if (this.templates.get(name) === p) this.templates.delete(name);
          throw e;
        },
      );
      this.templates.set(name, p);
    }
    return p;
  }

  /** each space's packed atlas (packSpaceAtlas), packed once: a space built again reuses it */
  private atlases = new Map<string, Promise<SpaceAtlas | null>>();

  /** The space's atlas pages, packed on first ask (sliced), the same pages after. */
  spaceAtlas(space: string, roots: THREE.Object3D[]): Promise<SpaceAtlas | null> {
    let p = this.atlases.get(space);
    if (!p) {
      p = packSpaceAtlas(roots);
      this.atlases.set(space, p);
    }
    return p;
  }

  /**
   * After a space merged its statics: the per-asset textures its atlas took in and nothing in the
   * space draws any more are let go on the GPU (dispose; their decoded images stay for other
   * spaces and whatever else still draws them: three uploads a disposed texture again on its next use).
   */
  releaseSources(atlas: SpaceAtlas, scene: THREE.Object3D) {
    const inUse = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of (Array.isArray(mats) ? mats : [mats]) as THREE.MeshStandardMaterial[]) for (const t of [m.map, m.aoMap, m.roughnessMap, m.metalnessMap]) if (t) inUse.add(t);
    });
    for (const t of atlas.sources) if (!inUse.has(t)) t.dispose();
  }

  /** Whether an asset's template is loaded (or loading). */
  has(name: string): boolean {
    return this.templates.has(name);
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

  /** Loads templates in parallel, in the order given (the fetches start in that order): by default every asset the layout uses. */
  async preload(names: string[] = this.L.assetNames(), onProgress?: (done: number, total: number) => void) {
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

// ---------------------------------------------------------------------------------------------
// Static families: one draw per (space, atlas page, material family)
// ---------------------------------------------------------------------------------------------

/**
 * Materials something finds by name after the merge, kept on their own material and batched as
 * before: the environment layers (envlook.ts GRASS_RE / GROUND_RE / WATER_RE / CANOPY_RE, env_*),
 * the evening glow (envlook.ts `emissives`: lantern_*, glass, sky_blue), the interior windows
 * (interior-backdrop.ts pi_glass) and textured ground, the see-through's canopy parts
 * (seethrough.ts CANOPIES).
 */
const KEEP_APART = /^(grass_|land_|water_|canopy_green$|leaf_|town_willow$|lantern_|glass$|pi_glass$|sky_blue$|env_|interior_)/;

type SurfaceMaterial = THREE.MeshStandardMaterial & THREE.MeshToonMaterial;

/** A texture a packed atlas can take in: read on UV 0, no transform, not flipped, a decoded image. */
function packableTexture(t: THREE.Texture | null | undefined): boolean {
  if (!t) return true;
  const img = t.image as { width?: number; height?: number } | undefined;
  return (
    t.channel === 0 &&
    !t.flipY &&
    t.offset.x === 0 &&
    t.offset.y === 0 &&
    t.repeat.x === 1 &&
    t.repeat.y === 1 &&
    t.rotation === 0 &&
    !!img &&
    (img.width ?? 0) > 0 &&
    (img.height ?? 0) > 0
  );
}

/** The ORM image a textured surface reads (aoMap, and in the real look roughness / metalness): one image or none; undefined when they differ. */
function ormOf(m: SurfaceMaterial): THREE.Texture | null | undefined {
  const ts = [m.aoMap, m.roughnessMap, m.metalnessMap].filter((t): t is THREE.Texture => !!t);
  if (!ts.length) return null;
  return ts.every((t) => t.image === ts[0].image) ? ts[0] : undefined;
}

const imageIds = new WeakMap<object, number>();
let nextImageId = 0;
const imageId = (img: object) => {
  let id = imageIds.get(img);
  if (id === undefined) imageIds.set(img, (id = nextImageId++));
  return id;
};

/** An atlas source's key: its base-colour image and its ORM image. */
function sourceKey(m: SurfaceMaterial): string {
  const orm = ormOf(m);
  return `${imageId(m.map!.image as object)}|${orm ? imageId(orm.image as object) : "-"}`;
}

/** Whether a geometry's UVs all lie in [0, 1] (an atlas rect can't repeat): cached per geometry. */
const uvInside = new WeakMap<THREE.BufferGeometry, boolean>();
function uvsInUnit(g: THREE.BufferGeometry): boolean {
  let ok = uvInside.get(g);
  if (ok === undefined) {
    const uv = g.getAttribute("uv");
    ok = !!uv && uv.itemSize === 2;
    for (let i = 0; ok && i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) ok = false;
    }
    uvInside.set(g, ok);
  }
  return ok;
}

/**
 * A static mesh that can join a family: one opaque toon / standard surface (see-through
 * patched), no vertex colours of its own, no emission, no normal / emissive / light maps, not a
 * name something looks up; a textured one only with its maps on UV 0 and UVs in [0, 1]. Null:
 * it batches by its own material, as before.
 */
function familySurface(mesh: THREE.Mesh): SurfaceMaterial | null {
  if (Array.isArray(mesh.material) || !mesh.visible || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.userData.outline) return null;
  const m = mesh.material as SurfaceMaterial;
  if (!(m.isMeshToonMaterial || m.isMeshStandardMaterial) || !m.visible || !m.color) return null;
  if (m.transparent || m.opacity !== 1 || m.alphaTest > 0 || m.vertexColors || m.wireframe || !m.depthWrite || !m.depthTest || m.polygonOffset || !m.colorWrite) return null;
  if (m.emissive?.getHex() || m.emissiveMap || m.normalMap || m.lightMap || m.bumpMap || m.alphaMap || m.displacementMap || m.envMap) return null;
  // userData: only what Toon.material itself records (the textured source's asset, its detail: detail.ts applyDetail)
  if (KEEP_APART.test(m.name) || Object.keys(m.userData).some((k) => k !== "asset" && k !== "detail") || !isSeeThrough(m)) return null;
  const g = mesh.geometry;
  if (Object.keys(g.morphAttributes).length || !g.getAttribute("position") || !g.getAttribute("normal") || g.getAttribute("color")) return null;
  if (m.map) {
    if (!packableTexture(m.map) || ormOf(m) === undefined || !packableTexture(ormOf(m)) || !uvsInUnit(g)) return null;
  } else if (m.aoMap || m.roughnessMap || m.metalnessMap) return null;
  return m;
}

/** A space's packed atlas pages as textures, and each source's rect (atlas.ts packSources). */
export interface SpaceAtlas {
  pages: { w: number; h: number; base: THREE.DataTexture; orm: THREE.DataTexture }[];
  rects: Map<string, PackRect>;
  /** the per-asset textures now drawn from the pages (disposed once the space no longer uses them) */
  sources: Set<THREE.Texture>;
}

/** An RGBA page as a mipmapped texture (trilinear, mips generated on the GPU after the upload). */
function pageTexture(data: Uint8Array, w: number, h: number, like: THREE.Texture[]): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = like[0]?.colorSpace ?? THREE.NoColorSpace;
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.max(1, ...like.map((x) => x.anisotropy));
  // the CPU copy stays: a lost / restored WebGL context (a phone backgrounding the tab) uploads it again
  t.needsUpdate = true;
  return t;
}

/**
 * Packs the textured static surfaces under `roots` into atlas pages (atlas.ts): once per space,
 * in slices of <= 4 ms (the loading screen and the street keep drawing). Null when there is
 * nothing to pack or nothing can read the images (node: the tests' GLBs carry none). `read`: an
 * image's RGBA at a size (default: a 2D canvas, atlas.ts readImage).
 */
export async function packSpaceAtlas(roots: THREE.Object3D[], read?: (t: THREE.Texture, w: number, h: number) => Uint8Array | Uint8ClampedArray): Promise<SpaceAtlas | null> {
  const sources = new Map<string, AtlasSource<THREE.Texture>>();
  const textures = new Set<THREE.Texture>();
  const bases: THREE.Texture[] = [];
  const orms: THREE.Texture[] = [];
  for (const root of roots)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = familySurface(mesh);
      if (!m?.map) return;
      const key = sourceKey(m);
      const orm = ormOf(m) ?? null;
      for (const t of [m.map, m.aoMap, m.roughnessMap, m.metalnessMap]) if (t) textures.add(t);
      if (sources.has(key)) return;
      const img = m.map.image as { width: number; height: number };
      sources.set(key, { key, base: m.map, bw: img.width, bh: img.height, orm });
      bases.push(m.map);
      if (orm) orms.push(orm);
    });
  if (!sources.size || (!read && !canReadImages())) return null;
  const out: PackedAtlas = { pages: [], rects: new Map() };
  read ??= (t, w, h) => readImage(t.image as CanvasImageSource & { width: number; height: number }, w, h);
  await sliced(packSources([...sources.values()], read, out), 4);
  if (!out.rects.size) return null;
  const pages = out.pages.map((p) => ({ w: p.w, h: p.h, base: pageTexture(p.base, p.w, p.h, bases), orm: pageTexture(p.orm, p.ow, p.oh, orms) }));
  pages.forEach((p, i) => {
    p.base.name = `atlas_${i}_base`;
    p.orm.name = `atlas_${i}_orm`;
  });
  return { pages, rects: out.rects, sources: textures };
}

/** A family's draw: the material, the atlas page its UVs point into (null: flat, no UVs kept). */
interface Family {
  key: string;
  material: THREE.Material;
  rect: PackRect | null;
  page: { w: number; h: number } | null;
}

/**
 * Static families (mergeStatic): the static world's opaque surfaces merge across palette
 * colours, the colour written into the vertices (as mergePrimitives does for characters). A
 * family is (atlas page or flat, side, roughness / metalness factors, AO intensity, shadow
 * flags): textured surfaces keep their UVs, remapped into the page; flat ones drop theirs. The
 * see-through tag and the outline hulls (children with their own shared material) ride along
 * unchanged.
 */
export class StaticFamilies {
  constructor(
    private toon: Toon,
    private atlas: SpaceAtlas | null,
  ) {}

  /** The mesh's family, or null (it batches by its own material). */
  of(mesh: THREE.Mesh): Family | null {
    const m = familySurface(mesh);
    if (!m) return null;
    let rect: PackRect | null = null;
    let pageIndex = -1;
    if (m.map) {
      rect = this.atlas?.rects.get(sourceKey(m)) ?? null;
      if (!rect) return null;
      pageIndex = rect.page;
    }
    const page = pageIndex >= 0 ? this.atlas!.pages[pageIndex] : null;
    // the real look's flat surfaces are 0.8 / 0 (Toon.material); a textured one keeps its own factors (they scale the ORM)
    const roughness = m.isMeshStandardMaterial ? m.roughness : 0.8;
    const metalness = m.isMeshStandardMaterial ? m.metalness : 0;
    const ao = page ? m.aoMapIntensity : 1;
    const shadows = LOOK.real ? `${mesh.castShadow ? "c" : ""}${mesh.receiveShadow ? "r" : ""}` : "";
    // the real look's tiling detail (detail.ts, set by Toon.material on textured sources): one family per detail spec
    const detail = page ? (m.userData.detail as DetailSpec | undefined) : undefined;
    const name = `${page ? `atlas_${pageIndex}` : "flat"}${detail ? `_${detail.kind}` : ""}`;
    const key = `family|${page ? `${page.base.uuid}` : "flat"}|${m.side}|${roughness}|${metalness}|${ao}|${shadows}${detail ? `|${detail.kind},${detail.albedo},${detail.normal}` : ""}`;
    const material = this.toon.family({ key, name: `${name}${m.side === THREE.FrontSide ? "_front" : ""}`, side: m.side, roughness, metalness, aoMapIntensity: ao, page: page && { base: page.base, orm: page.orm }, detail });
    return { key, material, rect, page };
  }

  /**
   * A family member's world geometry (tagged) in the family's layout: float position, normal,
   * colour (its material's), the see-through tag, UVs remapped into the page when textured,
   * always indexed.
   */
  static layout(geo: THREE.BufferGeometry, mesh: THREE.Mesh, f: Family): THREE.BufferGeometry {
    const out = new THREE.BufferGeometry();
    const n = geo.getAttribute("position").count;
    const float = (name: string, size: number) => {
      const a = geo.getAttribute(name);
      const arr = new Float32Array(n * size);
      for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) arr[i * size + k] = a.getComponent(i, k);
      return arr;
    };
    out.setAttribute("position", new THREE.BufferAttribute(float("position", 3), 3));
    out.setAttribute("normal", new THREE.BufferAttribute(float("normal", 3), 3));
    const c = (mesh.material as THREE.MeshStandardMaterial).color;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    out.setAttribute("color", new THREE.BufferAttribute(col, 3));
    if (f.rect && f.page) {
      const uv = float("uv", 2);
      const { x, y, w, h } = f.rect;
      for (let i = 0; i < uv.length; i += 2) {
        uv[i] = (x + uv[i] * w) / f.page.w;
        uv[i + 1] = (y + uv[i + 1] * h) / f.page.h;
      }
      out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    out.setAttribute(SEE_ATTR, geo.getAttribute(SEE_ATTR));
    if (geo.index) out.setIndex(geo.index);
    else out.setIndex([...Array(n).keys()]);
    return out;
  }
}

/**
 * Merges every static mesh under `roots` (ground, tiles, buildings, props: never characters or
 * anything they hold) into one mesh per batch key, added to `scene`; the source meshes go. The
 * roots themselves stay (empty, named: scene lookups by name still work). Returns the number of
 * meshes merged away. Frustum culling then works per batch, not per prop: fine for one street.
 * Every static mesh (batched or not) gets the see-through tag (seethrough.ts `seeThru`) from its
 * root's `userData.see` (a SeeSpec; none: never fade) and `userData.seeAsset` (canopies): baked
 * per vertex, so one batch holds ground and many independently fading objects in one draw.
 * `families` (SceneSpace): opaque surfaces merge across colours too, one draw per family
 * (StaticFamilies); each batch lists its parts (`userData.parts`: material name, first vertex,
 * vertex count).
 */
export function mergeStatic(scene: THREE.Object3D, roots: THREE.Object3D[], families?: StaticFamilies): number {
  scene.updateMatrixWorld(true);
  const batches = new Map<string, THREE.Mesh[]>();
  const rootOf = new Map<THREE.Mesh, THREE.Object3D>();
  const familyOf = new Map<THREE.Mesh, Family>();
  const loose: THREE.Mesh[] = [];
  for (const root of roots)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      rootOf.set(mesh, root);
      const fam = families?.of(mesh);
      if (fam) familyOf.set(mesh, fam);
      const key = fam ? fam.key : batchKey(mesh);
      if (!key) return void loose.push(mesh);
      const list = batches.get(key) ?? [];
      list.push(mesh);
      batches.set(key, list);
    });
  const tag = (geo: THREE.BufferGeometry, mesh: THREE.Mesh, world: boolean) => {
    const root = rootOf.get(mesh)!;
    geo.setAttribute(SEE_ATTR, seeAttribute(geo, mesh, root.userData.see as SeeSpec | undefined, root.userData.seeAsset as string | undefined, world));
    return geo;
  };
  const gone = new Set<THREE.Object3D>();
  for (const meshes of batches.values()) {
    if (meshes.length < 2) {
      loose.push(...meshes);
      continue;
    }
    const fam = familyOf.get(meshes[0]);
    const parts = meshes.map((m) => {
      const g = tag(worldGeometry(m), m, true);
      return fam ? StaticFamilies.layout(g, m, familyOf.get(m)!) : g; // each part its own rect
    });
    const merged = mergeGeometries(parts, false);
    if (!merged) {
      loose.push(...meshes);
      continue;
    }
    merged.computeBoundingSphere();
    const src = meshes[0];
    const batch = new THREE.Mesh(merged, fam ? fam.material : src.material);
    let first = 0;
    batch.userData.parts = meshes.map((m, i) => {
      const count = parts[i].getAttribute("position").count;
      const part = { material: (m.material as THREE.Material).name, first, count };
      first += count;
      return part;
    });
    batch.name = `batch:${(batch.material as THREE.Material).name || src.name}`;
    batch.matrixAutoUpdate = false;
    batch.userData.batch = meshes.length;
    if (LOOK.real) batch.castShadow = meshes.some((m) => m.castShadow); // real look (look.ts): the batch keeps its parts' shadow flags
    if (LOOK.real) batch.receiveShadow = meshes.some((m) => m.receiveShadow);
    if (src.userData.outline) {
      batch.userData.outline = true;
      batch.raycast = () => {};
    }
    scene.add(batch);
    for (const m of meshes) gone.add(m);
  }
  // not batched: its own copy of the geometry (templates share theirs), tagged in place
  for (const m of loose) if (!m.geometry.hasAttribute(SEE_ATTR)) m.geometry = tag(m.geometry.clone(), m, false);
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

/** `figure`: a walker, extra or pet (src/barks.ts figureId): someone who barks */
export type PickHit = { npc: string } | { figure: string } | { target: string } | { ground: THREE.Vector3 };

/** A figure that barks, by its id (src/barks.ts figureId): its actor, and how it moves (walkers, pigeons). */
export interface FigureView {
  actor: CharacterActor;
  motion?: WalkerMotion | ScatterMotion;
}

export class SceneSpace {
  readonly scene = new THREE.Scene();
  readonly blockers: Blocker[] = [];
  readonly npcs = new Map<string, NpcView>();
  /** street extras and pets from the dressing list: idle in place */
  readonly extras: CharacterActor[] = [];
  readonly walkers: WalkerView[] = [];
  readonly scatterers: ScatterView[] = [];
  /**
   * Walkers, extras and pigeons by figure id (src/barks.ts figureId: kind + layout slot). The
   * arrays above fill as each actor loads (any order: populate streams them); this map is keyed
   * by the layout slot, so barks.ts's Figure.slot always finds its own actor.
   */
  readonly figures = new Map<string, FigureView>();
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
  private backdrop?: ReturnType<typeof buildInteriorBackdrop>;
  /** static roots that can block a focus, with baked ids */
  readonly occluders: Occluder[] = [];
  /** static batching (mergeStatic): draw calls before / after, meshes merged away */
  batching = { before: 0, after: 0, merged: 0 };
  /** the space's packed atlas pages (packSpaceAtlas; null: nothing textured, or no images to read) */
  atlas: SpaceAtlas | null = null;

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

  /**
   * Builds a space. Its ground and everything that never moves first (batched: the first frame
   * needs it); then its characters (NPCs nearest the spawn first, walkers, pets, with what they
   * hold), each added as it lands. `stream`: resolve after the first part, the characters keep
   * coming (`ready` resolves when they are all in); else resolve with everything in.
   */
  static async create(L: LayoutIndex, assets: AssetCache, id: string, opts: { stream?: boolean } = {}): Promise<SceneSpace> {
    const w = new SceneSpace(L, assets, id);
    await w.buildStatic();
    w.ready = w.populate();
    if (!opts.stream) await w.ready;
    else w.ready.catch((e: unknown) => console.error(`${id}: a character didn't load`, e));
    return w;
  }

  /** resolves once every character of the space is in the scene */
  ready: Promise<void> = Promise.resolve();

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

  private async buildStatic() {
    const { L, scene, layout } = this;
    scene.background = this.background.clone();
    const town = layout.town;
    // Outdoor depth fog; the shared interior backdrop supplies its own shorter haze:
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
        if (name === "clouds") this.placeClouds(o);
        o.userData.see = seeSpecFor(L.asset(name).set, name);
        scene.add(o);
        statics.push(o);
      }
      if (town.sky) await this.addSky(town.sky);
      await this.addHorizon(statics);
    } else if (!layout.interior) {
      // Endless ground under everything, then the mock-up's forecourt / road-extension boxes.
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.assets.toon.flat("#C8C1B2"));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      floor.userData.see = { tag: SEE_NEVER } satisfies SeeSpec;
      if (LOOK.real) floor.receiveShadow = true;
      scene.add(floor);
      statics.push(floor);
    }
    const enclosure = buildInteriorEnclosure(scene, layout, (colour) => this.assets.toon.flat(colour));
    this.backdrop = buildInteriorBackdrop(scene, layout, LOOK.real, (colour) => this.assets.toon.flat(colour));
    for (const g of layout.ground) {
      const size = [0, 1, 2].map((i) => g.max[i] - g.min[i]);
      const box = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), this.assets.toon.flat(g.colour));
      box.position.set((g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2);
      box.name = g.name;
      // Explicit ground/deck boxes never fade. Interior walls and roofs live in their shell asset.
      box.userData.see = { tag: SEE_NEVER } satisfies SeeSpec;
      if (LOOK.real) box.castShadow = box.receiveShadow = true;
      scene.add(box);
      statics.push(box);
    }

    for (const t of layout.tiles) {
      const o = await this.assets.instance(t.asset);
      this.place(o, t);
      o.userData.see = seeSpecFor(L.asset(t.asset).set, t.asset);
      scene.add(o);
      statics.push(o);
    }
    for (const b of layout.pieces) {
      const o = await this.assets.instance(b.asset);
      this.place(o, b);
      o.name = b.id;
      if (layout.interior && L.asset(b.asset).origin === "shell") { interiorFaces(o); o.userData.shell = true; }
      this.backdrop?.dressWindows(o);
      o.userData.see = this.seeSpec(o, b.id, b.asset);
      scene.add(o);
      statics.push(o);
      const blocker = b.block === "footprint" ? this.buildingBlocker(b, await this.assets.template(b.asset)) : b.block === "size" ? L.sizeBlocker(b) : null;
      if (blocker) this.blockers.push(blocker);
    }
    this.blockers.push(...layout.blockers); // the town's own (oriented rects)
    // Static dressing (the characters among it animate: populate()).
    for (const d of layout.dressing) {
      const e = L.asset(d.asset);
      if (e.set === "characters" && CHARACTER_KINDS.has(e.kind ?? "")) continue;
      const o = await this.assets.instance(d.asset);
      this.place(o, d);
      this.backdrop?.dressWindows(o);
      // hung on a building (port-town.mjs HUNG): fades with it, one object, never on its own
      const host = d.mounted ? (scene.getObjectByName(d.mounted)?.userData.see as SeeSpec | undefined) : undefined;
      o.userData.see = host ? { ...host } : this.seeSpec(o, d.asset, d.asset);
      scene.add(o);
      statics.push(o);
    }
    // Things to use (bed, notebook): a tap box each, with the prompt target's id.
    layout.interactables.forEach((x, i) => {
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), pickMaterial);
      proxy.position.set(x.pos[0], x.pos[1], x.pos[2]);
      proxy.userData.target = `${x.kind}:${i}`;
      scene.add(proxy);
      this.pickables.push(proxy);
    });
    bandWalls(enclosure, layout, statics, (colour) => this.assets.toon.flat(colour));
    // Real look: the enclosure takes the room's shadows like the authored walls it continues.
    if (LOOK.real) enclosure?.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.receiveShadow = true; });
    this.batching.before = drawCalls(scene);
    // textured statics: their atlases packed into this space's pages (sliced), then one draw per family
    this.atlas = await this.assets.spaceAtlas(this.id, statics);
    this.batching.merged = mergeStatic(scene, statics, new StaticFamilies(this.assets.toon, this.atlas));
    this.batching.after = drawCalls(scene);
    if (this.atlas) this.assets.releaseSources(this.atlas, scene);
    this.staticCalls = { before: this.batching.before, after: this.batching.after };
    if (LOOK.real) this.setupRealLook();
  }

  /** real look (look.ts) only: the sun's direction; its shadow box follows the player along it (followSun) */
  private sunDir!: THREE.Vector3;
  private lookSky?: LookSky;

  /** Real look only: the sun casts (a tight ortho box, followSun), the hemisphere steps back for the environment map. */
  private setupRealLook() {
    const s = this.sun;
    s.castShadow = true;
    // the tier's map (look.ts RenderBudget.shadowSize: full 2048, lite 1024)
    s.shadow.mapSize.set(LOOK.budget.shadowSize, LOOK.budget.shadowSize);
    const c = s.shadow.camera;
    c.left = c.bottom = -REAL_SHADOW.half;
    c.right = c.top = REAL_SHADOW.half;
    c.near = 1;
    c.far = REAL_SHADOW.distance * 2;
    c.updateProjectionMatrix();
    s.shadow.bias = REAL_SHADOW.bias;
    s.shadow.normalBias = REAL_SHADOW.normalBias;
    s.shadow.autoUpdate = false; // followSun says when (ShadowScheduler)
    s.shadow.needsUpdate = true;
    s.shadow.radius = 3;
    this.scene.add(s.target);
    this.hemi.intensity *= REAL_HEMI;
    s.intensity *= REAL_SUN;
    this.sunDir = s.position.clone().normalize();
    const c0 = () => new THREE.Color();
    this.lookSky = { zenith: c0(), horizon: c0(), ground: c0(), sun: new THREE.Vector3(), sunColor: c0(), daylight: 0, version: 0 };
    this.scene.userData.lookSky = this.lookSky;
    // for the environment layers (envlook.ts): the town's ground, its footprints (the array itself: NPC stands join it as they load), its sky dome
    this.scene.userData.lookGround = { town: !!this.layout.town, blockers: this.blockers, sky: this.layout.town?.sky } satisfies LookGround;
    this.writeLookSky();
  }

  /** Real look only: the sky colours now (dome zenith, horizon / background, the hemisphere's ground) for reallook.ts's environment map. */
  private writeLookSky(daylight?: number) {
    const k = this.lookSky;
    if (!k) return;
    if (daylight !== undefined) k.daylight = daylight;
    const bg = this.scene.background as THREE.Color;
    k.horizon.copy(bg);
    // the dome's darker colour is its zenith (hazeColour picked the lighter for the horizon)
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const top = this.sky.reduce<THREE.Color | null>((a, x) => (!a || lum(x.mat.color) < lum(a) ? x.mat.color : a), null);
    k.zenith.copy(this.backdrop?.top ?? top ?? bg);
    k.ground.copy(this.hemi.groundColor);
    k.sun.copy(this.sunDir);
    k.sunColor.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    k.version++;
  }

  /**
   * Real look only: the sun and its shadow box on the player, in steps of SHADOW_CELL (a whole
   * number of shadow texels in the light's frame: no shimmer), and whether the map redraws this
   * frame (look.ts ShadowScheduler: the sun or the box moved, else every shadowEvery frames with
   * the animated player in it). A map not redrawn keeps the matrix it was drawn with: consistent.
   */
  private followSun(p: THREE.Vector3) {
    const z = this.sunDir;
    const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const texel = (2 * REAL_SHADOW.half) / this.sun.shadow.mapSize.x;
    const step = Math.max(1, Math.round(SHADOW_CELL / texel)) * texel;
    const snap = (v: number) => Math.round(v / step) * step;
    const sx = snap(p.dot(x));
    const sy = snap(p.dot(y));
    const sz = snap(p.dot(z));
    const t = this.sun.target.position;
    t.copy(x).multiplyScalar(sx).addScaledVector(y, sy).addScaledVector(z, sz);
    this.sun.position.copy(t).addScaledVector(z, REAL_SHADOW.distance);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.needsUpdate = this.shadowPlan.due(this.lookSky?.version ?? 0, `${sx},${sy},${sz}`, true);
  }
  /** Real look only: when the sun's map redraws (followSun) */
  readonly shadowPlan = new ShadowScheduler(LOOK.budget.shadowEvery);

  /** Assigns one bounded id to a fadeable static root. */
  private seeSpec(o: THREE.Object3D, id: string, asset: string): SeeSpec {
    const spec = seeSpecFor(this.L.asset(asset).set, asset);
    if (spec.tag !== SEE_OCCLUDER) return spec;
    const occluderId = this.occluders.length;
    if (occluderId >= SEE_THROUGH.maxOccluders) throw new Error(`${this.id}: more than ${SEE_THROUGH.maxOccluders} see-through occluders`);
    o.updateMatrixWorld(true);
    const canopy = CANOPIES[asset];
    let eligible = false;
    const point = new THREE.Vector3();
    const cut = o.position.y + (canopy?.above ?? 0);
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.outline) return;
      const material = mesh.material as THREE.Material | THREE.Material[];
      const namedPart = canopy && !Array.isArray(material) && canopy.parts.test(material.name);
      const position = mesh.geometry.getAttribute("position");
      if (!position) return;
      if (!canopy || namedPart) eligible ||= position.count > 0;
      else if (canopy.above !== undefined) {
        for (let i = 0; i < position.count && !eligible; i++) {
          point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
          if (point.y > cut) eligible = true;
        }
      }
    });
    if (!eligible) return { tag: SEE_NEVER };
    if (canopy) o.userData.seeAsset = asset;
    this.occluders.push({ id: occluderId, asset });
    return { tag: SEE_ID0 + occluderId, baseY: o.position.y };
  }

  /** draw calls of the static part before / after batching (populate adds the characters' to both) */
  private staticCalls = { before: 0, after: 0 };

  /**
   * The characters: NPCs (nearest the town's spawn first), walkers, pets and extras, each with what
   * it holds, added to the scene (and to picking, blockers, NpcView) as each one lands. The fetches
   * start in that order and run in parallel.
   */
  private async populate() {
    const { L, scene, layout } = this;
    const spawn = layout.town ? L.spawn(layout.defaultPlace).pos : null;
    const near = (p: Vec3) => (spawn ? Math.hypot(p[0] - spawn[0], p[2] - spawn[2]) : 0);
    const npcs = [...layout.npcs].sort((a, b) => near(L.npcStand(a).pos) - near(L.npcStand(b).pos));
    const jobs: Promise<void>[] = [];
    for (const npc of npcs)
      jobs.push(
        (async () => {
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
        })(),
      );
    layout.walkers.forEach((w, i) =>
      jobs.push(
        (async () => {
          const a = await this.assets.actor(w.character);
          await this.holdProp(a, w.heldProp);
          const motion = new WalkerMotion(w.path, w.speed);
          a.root.position.set(motion.x, L.heightAt(this.id, motion.x, motion.z), motion.z);
          a.root.rotation.y = motion.yaw;
          scene.add(a.root);
          this.walkers.push({ actor: a, motion });
          this.addFigure(figureId("walker", i), { actor: a, motion }, false);
        })(),
      ),
    );
    // Slots counted here, in layout order (as barks.ts spaceFigures counts them), before any load finishes.
    let extraSlot = 0;
    let scatterSlot = 0;
    for (const d of layout.dressing) {
      const e = L.asset(d.asset);
      if (!(e.set === "characters" && CHARACTER_KINDS.has(e.kind ?? ""))) continue;
      const scatter = d.behaviour === "scatter";
      const id = scatter ? figureId("scatter", scatterSlot++) : figureId("extra", extraSlot++);
      const small = e.kind === "pet";
      jobs.push(
        (async () => {
          const a = await this.assets.actor(d.asset);
          this.place(a.root, d);
          scene.add(a.root);
          if (scatter) {
            const view = { actor: a, motion: new ScatterMotion([d.pos[0], d.pos[2]], d.rotY * DEG) };
            this.scatterers.push(view);
            this.addFigure(id, view, small);
          } else {
            this.extras.push(a);
            this.addFigure(id, { actor: a }, small);
          }
        })(),
      );
    }
    await Promise.all(jobs);
    // Characters (NPCs, walkers, extras, pigeons) and what they hold stay separate: they animate.
    const chars = drawCalls(scene) - this.staticCalls.after;
    this.batching.before = this.staticCalls.before + chars;
    this.batching.after = this.staticCalls.after + chars;
  }

  /**
   * The town's far edge (horizon.ts): a skirt of the apron's far grass out past the haze, a cap on
   * every open end where two landscape pieces meet at different heights, and mountains_far again,
   * turned, where the first ring leaves the horizon open; then the countryside over all of it. All
   * static: batched with the rest.
   */
  private async addHorizon(statics: THREE.Object3D[]) {
    const town = this.layout.town!;
    for (const c of HORIZON.caps) {
      const w = Math.hypot(c.to[0] - c.from[0], c.to[2] - c.from[2]);
      const h = c.to[1] - c.from[1];
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.assets.toon.material(new THREE.MeshStandardMaterial({ color: c.colour })));
      cap.position.set((c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2, (c.from[2] + c.to[2]) / 2);
      cap.lookAt(cap.position.x + c.facing[0], cap.position.y + c.facing[1], cap.position.z + c.facing[2]);
      cap.name = c.name;
      cap.userData.see = { tag: SEE_NEVER } satisfies SeeSpec;
      this.scene.add(cap);
      statics.push(cap);
    }
    const echo = HORIZON.mountainEcho;
    if (town.landscape.includes(echo.asset)) {
      const o = await this.assets.instance(echo.asset);
      o.name = `${echo.asset}_echo`;
      o.userData.see = { tag: SEE_NEVER } satisfies SeeSpec;
      o.rotation.y = echo.rotYDeg * DEG;
      o.scale.setScalar(echo.scale);
      this.scene.add(o);
      statics.push(o);
    }
    await this.addCountryside(statics);
  }

  /**
   * The countryside (horizon.ts buildCountryside): the apron, the skirt and both mountain rings
   * recoloured by one radial ramp from the plateau's grass to the apron's far grass (vertex
   * colours), and hills_ring's mounds and willow clumps scattered over the plain. All of it in one
   * vertex-coloured toon material: one batch, never cut by the see-through.
   */
  private async addCountryside(statics: THREE.Object3D[]) {
    const town = this.layout.town!;
    const { scene } = this;
    scene.updateMatrixWorld(true);
    const meshes = (root: THREE.Object3D | undefined) => {
      const out: THREE.Mesh[] = [];
      root?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !m.userData.outline && !Array.isArray(m.material)) out.push(m);
      });
      return out;
    };
    const part = (m: THREE.Mesh): Part => ({ geometry: m.geometry, matrix: m.matrixWorld.clone(), colour: (m.material as THREE.MeshToonMaterial).color.clone(), material: (m.material as THREE.Material).name });
    const apron = meshes(scene.getObjectByName("ground_apron"));
    if (!apron.length) return;
    const echo = HORIZON.mountainEcho.asset;
    const mountains = [...meshes(scene.getObjectByName(echo)), ...meshes(scene.getObjectByName(`${echo}_echo`))];
    const tops = (this.L.asset("hills_ring").anchors?.hill_tops ?? []) as Vec3[];
    const treeName = HORIZON.countryside.trees.asset;
    // only an asset the town already loads (no extra download for the scatter)
    const treeRoot = this.L.assetNames().includes(treeName) ? await this.assets.template(treeName) : undefined;
    treeRoot?.updateMatrixWorld(true);
    const tree = meshes(treeRoot);
    const cs = buildCountryside({
      apron: apron.map(part),
      mountains: mountains.map(part),
      hillsRing: town.landscape.includes("hills_ring") ? meshes(scene.getObjectByName("hills_ring")).map(part) : [],
      hillTops: tops,
      tree: tree.map(part),
      views: flyoverViews(town.flyover, 16 / 9, 1, 24),
    });
    const vc = this.assets.toon.material(vertexColourSource(THREE.FrontSide));
    apron.forEach((m, i) => {
      m.geometry = cs.apron[i];
      m.material = vc;
    });
    mountains.forEach((m, i) => {
      m.geometry = cs.mountains[i];
      m.material = vc;
    });
    for (const [name, geometry] of [
      ["horizon_skirt", cs.skirt],
      ["countryside", cs.scatter],
    ] as const) {
      // a named root round the mesh: the mesh merges into the batch, the root stays (scene lookups by name)
      const root = new THREE.Group();
      root.name = name;
      root.userData.see = { tag: SEE_NEVER } satisfies SeeSpec;
      root.add(new THREE.Mesh(geometry, vc));
      scene.add(root);
      statics.push(root);
    }
    this.countryside = { hills: cs.hills.length, trees: cs.trees.length, near: `#${cs.palette.near.getHexString()}`, far: `#${cs.palette.far.getHexString()}` };
  }

  /** what addCountryside built (hills, trees, the ramp's colours as sRGB hex): for the tests */
  countryside?: { hills: number; trees: number; near: string; far: string };

  /**
   * The clouds (one merged object, five clusters at index.json's cloud_slots) moved to HORIZON's
   * slots, high and far off every camera's path, and unfogged like the sky dome.
   */
  private placeClouds(root: THREE.Object3D) {
    const slots = (this.L.asset("clouds").anchors?.cloud_slots ?? []) as Vec3[];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.outline) return;
      mesh.geometry = mesh.geometry.clone();
      if (slots.length) moveClouds(mesh.geometry, slots, HORIZON.clouds);
      const m = (mesh.material as THREE.MeshToonMaterial).clone();
      m.fog = false;
      mesh.material = m;
      if (LOOK.real) mesh.castShadow = mesh.receiveShadow = false;
    });
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
      if (LOOK.real) mesh.castShadow = mesh.receiveShadow = false;
      this.sky.push({ mat, base });
    });
    // The horizon band is the lighter, less saturated colour of the two.
    this.horizon = hazeColour(this.sky.map((x) => x.base));
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

  /**
   * Registers a figure that barks and gives it a tap target like a story NPC's: an invisible
   * cylinder riding on its root (walkers walk, pigeons scatter), smaller for a pet. Never drawn
   * (pickMaterial), so no draw call.
   */
  private addFigure(id: string, view: FigureView, small: boolean) {
    this.figures.set(id, view);
    const [r, h] = small ? [0.4, 0.8] : [0.55, 2.1];
    const proxy = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 8), pickMaterial);
    proxy.position.y = h / 2;
    proxy.userData.figure = id;
    view.actor.root.add(proxy);
    this.pickables.push(proxy);
  }

  /** What's under a screen point: an NPC, a figure that barks, a thing to use, else a spot on the ground (the town's: on its walking height). */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): PickHit | null {
    this.ray.setFromCamera(ndc, camera);
    const hit = this.ray.intersectObjects(this.pickables, false)[0];
    if (hit?.object.userData.npc) return { npc: hit.object.userData.npc as string };
    if (hit?.object.userData.figure) return { figure: hit.object.userData.figure as string };
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
   * barely-moved 2-colour lerp. Interiors use the full cycle with
   * their own sky palette; warm lamps take over toward evening.
   */
  setDaylight(f: number) {
    const k = Math.max(0, Math.min(1, f));
    lerpStops(DAY.sky, k, this.hemi.color);
    lerpStops(DAY.ground, k, this.hemi.groundColor);
    lerpStops(DAY.sun, k, this.sun.color);
    this.sun.intensity = lerpNums(DAY.sunIntensity, k);
    if (LOOK.real) this.sun.intensity *= REAL_SUN;
    // The sun swings low toward evening (grazing light, a longer-shadow feel) without moving its
    // azimuth, so the toon shading's light direction only dips, never spins. The town's sun
    // (town.json) sits at its own bearing and reaches its own elevation at midday.
    const town = this.layout.town;
    const angle = lerpNums(DAY.sunAngle, k) * (town ? town.sun.elevationDeg / MIDDAY_SUN : 1) * DEG;
    const horiz = Math.hypot(...this.sunHoriz);
    this.sun.position.set(this.sunHoriz[0], Math.tan(angle) * horiz, this.sunHoriz[1]);
    if (LOOK.real) this.sunDir.copy(this.sun.position).normalize();
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
    if (this.backdrop) {
      const evening = this.backdrop.update(k);
      this.hemi.color.set("#FFF1D8").lerp(new THREE.Color("#9AAFD0"), evening);
      this.hemi.groundColor.set("#98836A").lerp(new THREE.Color("#695575"), evening);
      this.sun.color.set("#FFE4B6").lerp(new THREE.Color("#FFB66C"), evening);
      this.sun.intensity = (2.1 - evening * 1.35) * (LOOK.real ? REAL_SUN : 1);
    }
    if (LOOK.real) this.writeLookSky(k);
  }

  /**
   * Per frame: NPCs face the player when within FACE_RANGE or in their scene (`sceneNpc`), else
   * turn back to their stand's facing; walkers pace, pigeons scatter; every character animates.
   */
  update(dt: number, player: THREE.Vector3, sceneNpc: string | null) {
    if (LOOK.real) this.followSun(player);
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
