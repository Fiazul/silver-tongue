// The spatial layout the 3D world owns (core's world graph has no coordinates), plus the pure
// maths on it: anchor -> world transforms, scene spaces (the town outdoors and each interior),
// trigger zones, walking height and walkable ground, blockers, place routing.
// Two files make it: src/layout.json (the player, the interiors, the NPCs' characters) and
// src/town.json (the canal town, ported by scripts/port-town.mjs); `mergeLayout` joins them.
// No three.js here, so game logic and tests can use it without WebGL.
import type { World } from "@silver-tongue/core";
import layoutJson from "./layout.json";
import townJson from "./town.json";
import { PLAYER_RADIUS } from "./movement";

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** An asset instance: glTF axes, rotY/tiltX in degrees, uniform `scale` (default 1). */
export interface Placement {
  asset: string;
  pos: Vec3;
  rotY: number;
  tiltX?: number;
  scale?: number;
  /** street life: "scatter" moves away from the player (pigeons) */
  behaviour?: "scatter";
}
export interface BuildingPlacement extends Placement {
  id: string;
}
export interface Box2 {
  min: Vec2;
  max: Vec2;
}
/** A rect turned by rotY about +y (the town's blockers): centre x/z, half sizes along its own x / z. */
export interface OrientedRect {
  id?: string;
  centre: Vec2;
  half: Vec2;
  rotY: number;
}
/** What stops walking: an x/z box, or an oriented rect inside its box (`obb`). */
export interface Blocker extends Box2 {
  obb?: OrientedRect;
}
/** A fixed point with a facing (x/z or x/y/z). */
export interface FixedStand {
  pos: Vec3;
  facing: Vec2 | Vec3;
}
/** Where the player appears in a place: a fixed point, a building's stand anchor, or its interior's entry. */
export type Spawn = FixedStand | { building: string; anchor: string } | { interior: string };
/** A street door into a place's interior: a trigger box `depth` metres out from the door anchor along its facing. */
export interface DoorSpec {
  building: string;
  anchor: string;
  width: number;
  depth: Vec2;
  /** metres across, to the right as you face the door from outside (keeps a door box clear of furniture or an NPC beside it) */
  shift?: number;
}
export interface PlaceLayout {
  buildings: string[];
  /** the scene space its zone / door is in (default: the street); `interior` is the space it opens into */
  space?: string;
  /** walking into this box (x/z, in `space`) means being at the place; a space's default place has none */
  zone?: Box2;
  /** more boxes of the same zone (a place wrapped round another place's door); they may overlap each other */
  zones?: Box2[];
  spawn: Spawn;
  /** the place has a scene space of its own (key of `interiors`: a room, or an outdoor side street) */
  interior?: string;
  /** the door (in `space`) that leads into it; a place without `interior` is simply there (the town's bus stop stand) */
  door?: DoorSpec;
  /**
   * No building of its own (the town has no warehouse, school or hospital): reached from the Go to
   * list only, which puts the player at `spawn`; `stay` is the spot (x/z box) that keeps them at the
   * place while they stay in it. Walking into it goes nowhere.
   */
  travelOnly?: boolean;
  stay?: Box2;
}
/** A held prop: a characters/ prop (origin at its grip). `carry: true` (boxes, bags) plays the carry pose. */
export type HeldPropSpec = string | { asset: string; carry?: boolean };
export interface NpcLayout {
  character: string;
  /** the scene space the NPC stands in; defaults to the space of `building` */
  space?: string;
  /** the building / interior piece whose anchors `stand` and `playerStand` name */
  building?: string;
  /** stand anchor on `building` the NPC stands on, or a fixed stand */
  stand: string | FixedStand;
  /** stand anchor (or fixed stand) where the player stands to talk */
  playerStand: string | FixedStand;
  heldProp?: HeldPropSpec;
}
export interface GroundBox {
  name: string;
  colour: string;
  min: Vec3;
  max: Vec3;
}
export interface InteractableSpec {
  kind: "sleep" | "notebook";
  /** a piece (and optionally one of its anchors), or a fixed point */
  at: { building: string; anchor?: string } | { pos: Vec3 };
  range?: number;
}
/**
 * A scene space other than Main Street, entered through its place's door: a room (shell or size +
 * ground boxes), or with `outdoor: true` a side street (sky, fog, the full day's light) with street
 * buildings and tiles. Its own places' zones and doors (`places.<p>.space`) go in it like Main
 * Street's; the way out (the open front edge, or `exitBox`) leads back to the space its door is in.
 */
export interface InteriorLayout {
  /** the core place this space shows (its default place) */
  place: string;
  /** a side street, not a room */
  outdoor?: boolean;
  /** an interiors/ shell (open front at z=0, room toward -z); its furniture_slots are placed as pieces */
  shell?: { id: string; asset: string };
  /** width, depth (m) when there is no shell */
  size?: Vec2;
  floorY?: number;
  bounds?: Box2;
  /** where the player comes in: a shell stand anchor or a fixed stand, then `inset` m along its facing, `shift` m across */
  entry: ({ anchor: string } | FixedStand) & { inset: number; shift?: number };
  /** depth (m) of the exit trigger along the open front edge */
  exitDepth?: number;
  /** the way out, when it isn't the open front edge (a side street's end) */
  exitBox?: Box2;
  /** furniture and props: block by their index size */
  pieces: BuildingPlacement[];
  /** street buildings: block by their footprint, as on Main Street */
  buildings?: BuildingPlacement[];
  tiles?: Placement[];
  walkers?: WalkerLayout[];
  /** walking heights (kerbs); default the flat floor */
  surfaces?: Surfaces;
  ground: GroundBox[];
  dressing: Placement[];
  interactables: InteractableSpec[];
  camera?: { distance?: number };
  background?: string;
}
export interface WalkerLayout {
  character: string;
  /** x/z waypoints, walked there and back */
  path: Vec2[];
  speed?: number;
  heldProp?: HeldPropSpec;
}
export interface Surfaces {
  default: number;
  bands: { zMin: number; zMax: number; y: number }[];
}
/** The town's walk grid: `classes[j][i]` for the cell [x0+i*cell, +cell] x [z0+j*cell, +cell] (1-5 walkable), heights (cm) at the cell corners, row-major (rows+1) x (cols+1). */
export interface WalkGrid {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  classes: string[];
  heights: number[];
}
/** A bridge or pier deck: walkable within `width` of its walk path, at the path's height. */
export interface Deck {
  id: string;
  kind: "bridge" | "pier";
  width: number;
  path: Vec3[];
}
/** One key of the fly-over: cubic Hermite on pos and lookAt with the stored tangents (m/s), fov linear. */
export interface CameraKey {
  t: number;
  pos: Vec3;
  lookAt: Vec3;
  fovDeg: number;
  posTangent: Vec3;
  lookTangent: Vec3;
}
export interface CameraPath {
  duration: number;
  /** the game camera the last key lands on (camera.ts CAMERA at the spawn) */
  endPose: { elevationDeg: number; azimuthDeg: number; distance: number; aimHeight: number; fovDeg: number };
  keys: CameraKey[];
}
/** src/town.json: the outdoors, ported from the make-it-in-china canal town. */
export interface TownLayout {
  bounds: Box2;
  /** world GLBs loaded at the origin (terrain, water, banks, hills, mountains, clouds) */
  landscape: string[];
  /** the sky dome (drawn unlit, behind everything) */
  sky?: string;
  buildings: BuildingPlacement[];
  blockers: OrientedRect[];
  grid: WalkGrid;
  decks: Deck[];
  /** the round plaza: its top sits `y` above the terrain inside `radius` */
  plaza?: { centre: Vec2; radius: number; y: number };
  /** compass bearing from north (-z) toward east (+x), and height above the horizon */
  sun: { azimuthDeg: number; elevationDeg: number };
  fog: { near: number; far: number };
  camera: CameraPath;
  places: Record<string, Partial<PlaceLayout>>;
  npcs: Record<string, Partial<NpcLayout>>;
  walkers: WalkerLayout[];
  dressing: Placement[];
}
/** src/layout.json: the player, the interiors, the NPCs' characters (and the interior NPCs' stands). */
export interface LayoutFile {
  defaultPlace: string;
  /** the player's character, and what they carry while an errand is on (a parcel: `{asset, carry: true}`) */
  player: { character: string; errandProp?: HeldPropSpec };
  places: Record<string, Partial<PlaceLayout>>;
  npcs: Record<string, Partial<NpcLayout>>;
  interiors: Record<string, InteriorLayout>;
}
/** The whole layout: layout.json and town.json merged (a place's / NPC's fields come from both). */
export interface Layout {
  defaultPlace: string;
  player: LayoutFile["player"];
  places: Record<string, PlaceLayout>;
  npcs: Record<string, NpcLayout>;
  interiors: Record<string, InteriorLayout>;
  town: TownLayout;
}

/** Joins layout.json and town.json: every place and NPC gets the fields of both files (town.json's win). */
export function mergeLayout(file: LayoutFile, town: TownLayout): Layout {
  const join = <T>(a: Record<string, Partial<T>>, b: Record<string, Partial<T>>) =>
    Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, { ...a[k], ...b[k] } as T]));
  return {
    defaultPlace: file.defaultPlace,
    player: file.player,
    places: join<PlaceLayout>(file.places, town.places),
    npcs: join<NpcLayout>(file.npcs, town.npcs),
    interiors: file.interiors,
    town,
  };
}

export const LAYOUT = mergeLayout(layoutJson as unknown as LayoutFile, townJson as unknown as TownLayout);
/** The outdoor space (the town); its default place is `defaultPlace`. */
export const STREET = "street";

/** index.json entry, the parts the world uses. */
export interface AssetEntry {
  name: string;
  set: string;
  path: string;
  size_m: Vec3;
  origin: string;
  /** human, recolour, pet, prop (characters set) */
  kind?: string;
  anchors?: Record<string, unknown>;
  /** rigged characters: metres covered by one loop of the walk clip */
  rig?: { stride_m?: number };
  wall_piece?: boolean;
}
export interface AssetIndex {
  assets: AssetEntry[];
}

export interface Stand {
  pos: Vec3;
  facing: Vec3;
}

/** How a placed piece blocks walking: street buildings by their footprint (world.ts, from the mesh), interior furniture by its size. */
export type BlockMode = "footprint" | "size" | "none";
export interface SpacePiece extends BuildingPlacement {
  block: BlockMode;
}

/**
 * A trigger box: a place's zone, a door (into another space, or a spot like the bus stop's stand),
 * a space's way out, or a travel-only place's `stay` spot (never entered by walking; it only
 * holds the place while the player stays in it). Doors and exits win over the zone round them.
 */
export interface Trigger {
  kind: "zone" | "door" | "exit" | "stay";
  /** the place walking in means going to */
  place: string;
  box: Box2;
  /** where its prompt floats (world, this space) */
  at: Vec3;
}

export interface Interactable {
  kind: InteractableSpec["kind"];
  pos: Vec3;
  range: number;
}

/** The town's outdoor look: landscape GLBs at the origin, the sky dome, the sun, the fog. */
export interface TownLook {
  landscape: string[];
  sky?: string;
  sun: TownLayout["sun"];
  fog: TownLayout["fog"];
}

/** One scene space, normalised: the town and every interior go through this shape. */
export interface SpaceLayout {
  id: string;
  /** the place you are at anywhere in the space outside its triggers */
  defaultPlace: string;
  bounds: Box2;
  surfaces: Surfaces;
  /** blockers of their own (the town's oriented rects), on top of what the pieces block */
  blockers: Blocker[];
  /** outdoors in the town */
  town?: TownLook;
  pieces: SpacePiece[];
  tiles: Placement[];
  ground: GroundBox[];
  dressing: Placement[];
  walkers: WalkerLayout[];
  triggers: Trigger[];
  interactables: Interactable[];
  npcs: string[];
  camera: { distance?: number };
  background?: string;
  interior: boolean;
}

const DEG = Math.PI / 180;
const WALL = 0.15; // shell wall thickness allowance (m) for default interior bounds

/** A point in an asset's frame -> world, for an instance at `p` (rotY about +Y, glTF convention; scaled by `scale`). */
export function anchorToWorld(p: Pick<Placement, "pos" | "rotY" | "scale">, local: Vec3): Vec3 {
  const a = p.rotY * DEG;
  const k = p.scale ?? 1;
  const c = Math.cos(a) * k;
  const s = Math.sin(a) * k;
  // Rotation about +Y: x' = x cos + z sin, z' = -x sin + z cos.
  return [p.pos[0] + local[0] * c + local[2] * s, p.pos[1] + local[1] * k, p.pos[2] - local[0] * s + local[2] * c];
}

/** A direction in an asset's frame -> world (rotation only). */
export function dirToWorld(p: Pick<Placement, "rotY">, local: Vec3): Vec3 {
  return anchorToWorld({ pos: [0, 0, 0], rotY: p.rotY }, local);
}

/** An oriented rect's x/z box, with the rect kept for the exact test (movement.ts). */
export function orientedBlocker(r: OrientedRect): Blocker {
  const a = r.rotY * DEG;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const hx = r.half[0] * c + r.half[1] * s;
  const hz = r.half[0] * s + r.half[1] * c;
  return { min: [r.centre[0] - hx, r.centre[1] - hz], max: [r.centre[0] + hx, r.centre[1] + hz], obb: r };
}

/** The walk grid's height at (x, z): bilinear between the corner heights, clamped to the grid. */
export function gridHeight(g: WalkGrid, x: number, z: number): number {
  const fi = Math.max(0, Math.min(g.cols, (x - g.x0) / g.cell));
  const fj = Math.max(0, Math.min(g.rows, (z - g.z0) / g.cell));
  const i = Math.min(g.cols - 1, Math.floor(fi));
  const j = Math.min(g.rows - 1, Math.floor(fj));
  const u = fi - i;
  const v = fj - j;
  const w = g.cols + 1;
  const h = (ii: number, jj: number) => g.heights[jj * w + ii] / 100;
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

/** The walk grid's class at (x, z): 0 off the grid (the town's edge is the grid's). */
export function gridClass(g: WalkGrid, x: number, z: number): number {
  const i = Math.floor((x - g.x0) / g.cell);
  const j = Math.floor((z - g.z0) / g.cell);
  if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return 0;
  return g.classes[j].charCodeAt(i) - 48;
}

/** Where (x, z) is on a deck: its walk path's height there and how far off the path it is, or null off every deck. */
export function deckAt(decks: Deck[], x: number, z: number): { y: number; lateral: number; deck: Deck } | null {
  let best: { y: number; lateral: number; deck: Deck } | null = null;
  for (const deck of decks)
    for (let k = 0; k + 1 < deck.path.length; k++) {
      const a = deck.path[k];
      const b = deck.path[k + 1];
      const ex = b[0] - a[0];
      const ez = b[2] - a[2];
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      const t = ((x - a[0]) * ex + (z - a[2]) * ez) / len2;
      if (t < 0 || t > 1) continue;
      const lateral = Math.abs((x - a[0]) * ez - (z - a[2]) * ex) / Math.sqrt(len2);
      if (lateral > deck.width / 2) continue;
      if (!best || lateral < best.lateral) best = { y: a[1] + (b[1] - a[1]) * t, lateral, deck };
    }
  return best;
}

/** Y rotation (radians) that turns an asset (front = +z) to look along `dir` in x/z. */
export function yawFor(dir: Vec2 | Vec3): number {
  const x = dir[0];
  const z = dir.length === 3 ? dir[2] : dir[1];
  return Math.atan2(x, z);
}

const vec3 = (f: readonly number[]): Vec3 => (f.length === 2 ? [f[0], 0, f[1]] : [f[0], f[1], f[2]]);

/** The one held-prop reading: carry pose only for props flagged `carry: true` (boxes, bags); hand props keep idle/talk. */
export function heldProp(spec: HeldPropSpec | undefined): { asset: string; carry: boolean } | undefined {
  if (!spec) return undefined;
  return typeof spec === "string" ? { asset: spec, carry: false } : { asset: spec.asset, carry: spec.carry === true };
}

export const inBox = (b: Box2, x: number, z: number, margin = 0) =>
  x >= b.min[0] + margin && x <= b.max[0] - margin && z >= b.min[1] + margin && z <= b.max[1] - margin;

export const boxesOverlap = (a: Box2, b: Box2) => a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1];

/** Axis-aligned x/z box around points. */
function aabb(points: Vec3[]): Box2 {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[2]);
  return { min: [Math.min(...xs), Math.min(...zs)], max: [Math.max(...xs), Math.max(...zs)] };
}

/** A box `depth` along `facing` from `pos`, `width` across it. */
function boxAlong(pos: Vec3, facing: Vec3, width: number, depth: Vec2): Box2 {
  const len = Math.hypot(facing[0], facing[2]) || 1;
  const f = [facing[0] / len, facing[2] / len];
  const side = [f[1], -f[0]];
  const pts: Vec3[] = [];
  for (const d of depth) for (const w of [-width / 2, width / 2]) pts.push([pos[0] + f[0] * d + side[0] * w, 0, pos[2] + f[1] * d + side[1] * w]);
  return aabb(pts);
}

export class LayoutIndex {
  private assets = new Map<string, AssetEntry>();
  private buildings = new Map<string, SpacePiece>();
  private pieceSpace = new Map<string, string>();
  private spaceCache = new Map<string, SpaceLayout>();

  constructor(
    readonly layout: Layout,
    index: AssetIndex,
  ) {
    for (const a of index.assets) this.assets.set(a.name, a);
    // The town's placements block nothing themselves: its blockers are listed (oriented rects).
    for (const b of layout.town.buildings) this.addPiece(STREET, { ...b, block: "none" });
    for (const [id, interior] of Object.entries(layout.interiors ?? {})) for (const p of this.interiorPieces(interior)) this.addPiece(id, p);
  }

  private addPiece(space: string, p: SpacePiece) {
    if (this.buildings.has(p.id)) throw new Error(`layout has two pieces with id "${p.id}"`);
    this.buildings.set(p.id, p);
    this.pieceSpace.set(p.id, space);
  }

  /** A space's pieces: its shell, the shell's furniture slots (ids `<shell id>:<asset>[:n]`), its own pieces, then its street buildings. */
  private interiorPieces(i: InteriorLayout): SpacePiece[] {
    const out: SpacePiece[] = [];
    if (i.shell) {
      out.push({ id: i.shell.id, asset: i.shell.asset, pos: [0, 0, 0], rotY: 0, block: "none" });
      const slots = (this.asset(i.shell.asset).anchors?.furniture_slots ?? []) as { asset: string; pos: Vec3; rot_y_deg?: number }[];
      const seen = new Map<string, number>();
      for (const s of slots) {
        const n = (seen.get(s.asset) ?? 0) + 1;
        seen.set(s.asset, n);
        out.push({ id: `${i.shell.id}:${s.asset}${n > 1 ? `:${n}` : ""}`, asset: s.asset, pos: s.pos, rotY: s.rot_y_deg ?? 0, block: "size" });
      }
    }
    for (const p of i.pieces) out.push({ ...p, block: "size" });
    for (const b of i.buildings ?? []) out.push({ ...b, block: "footprint" });
    return out;
  }

  asset(name: string): AssetEntry {
    const a = this.assets.get(name);
    if (!a) throw new Error(`asset "${name}" is not in index.json`);
    return a;
  }

  building(id: string): SpacePiece {
    const b = this.buildings.get(id);
    if (!b) throw new Error(`layout has no building "${id}"`);
    return b;
  }

  /** Every scene space: the town, then each interior. */
  spaceIds(): string[] {
    return [STREET, ...Object.keys(this.layout.interiors ?? {})];
  }

  /** The space that shows `place`: its own space, else the space its zone is in (the street by default). */
  spaceOf(place: string): string {
    const p = this.layout.places[place];
    return p?.interior ?? p?.space ?? STREET;
  }

  /** The space a space's door is in: where its way out leads (null for the street). */
  outerSpace(space: string): string | null {
    if (space === STREET) return null;
    return this.layout.places[this.interior(space).place]?.space ?? STREET;
  }

  /** The place you are at in a space outside its triggers. */
  defaultPlaceOf(space: string): string {
    return space === STREET ? this.layout.defaultPlace : this.interior(space).place;
  }

  /** The one anchor lookup: a named anchor of a placed building / piece, in its space's coordinates. */
  stand(buildingId: string, anchor: string): Stand {
    const b = this.building(buildingId);
    const raw = this.asset(b.asset).anchors?.[anchor] as { pos?: Vec3; facing?: number[] } | undefined;
    if (!raw?.pos || !raw.facing) throw new Error(`${b.asset} has no stand anchor "${anchor}"`);
    return { pos: anchorToWorld(b, raw.pos), facing: dirToWorld(b, vec3(raw.facing)) };
  }

  point(buildingId: string, anchor: string): Vec3 {
    const b = this.building(buildingId);
    const raw = this.asset(b.asset).anchors?.[anchor] as Vec3 | { pos: Vec3 } | undefined;
    if (Array.isArray(raw)) return anchorToWorld(b, raw);
    if (raw && Array.isArray(raw.pos)) return anchorToWorld(b, raw.pos);
    throw new Error(`${b.asset} has no point anchor "${anchor}"`);
  }

  private resolveStand(npc: string, spec: string | FixedStand): Stand {
    const n = this.npc(npc);
    let s: Stand;
    if (typeof spec !== "string") s = { pos: spec.pos, facing: vec3(spec.facing) };
    else if (!n.building) throw new Error(`npc stand "${spec}" needs a building`);
    else s = this.stand(n.building, spec);
    return this.onGround(this.npcSpace(npc), s);
  }

  /** In the town a stand is on the walking surface (terrain, plaza, deck); interiors keep the floor height they give. */
  private onGround(space: string, s: Stand): Stand {
    if (space !== STREET) return s;
    return { pos: [s.pos[0], this.heightAt(space, s.pos[0], s.pos[2]), s.pos[2]], facing: s.facing };
  }

  npcStand(npc: string): Stand {
    return this.resolveStand(npc, this.npc(npc).stand);
  }

  /** Where the player stands to talk to `npc`, facing them. */
  talkStand(npc: string): Stand {
    return this.resolveStand(npc, this.npc(npc).playerStand);
  }

  npc(npc: string): NpcLayout {
    const n = this.layout.npcs[npc];
    if (!n) throw new Error(`layout has no npc "${npc}"`);
    return n;
  }

  /** The space an NPC stands in. */
  npcSpace(npc: string): string {
    const n = this.npc(npc);
    return n.space ?? (n.building ? this.pieceSpace.get(n.building) ?? STREET : STREET);
  }

  /** Where the player comes into an interior (its entry anchor moved `inset` inwards, `shift` across). */
  entrySpawn(interiorId: string): Stand {
    const i = this.interior(interiorId);
    const e = i.entry;
    const base: Stand = "anchor" in e ? this.stand(i.shell!.id, e.anchor) : { pos: e.pos, facing: vec3(e.facing) };
    const len = Math.hypot(base.facing[0], base.facing[2]) || 1;
    const f = [base.facing[0] / len, base.facing[2] / len];
    const shift = e.shift ?? 0;
    return {
      // shift: to the right of the facing (facing -z into a shell: +x, the open side)
      pos: [base.pos[0] + f[0] * e.inset - f[1] * shift, base.pos[1], base.pos[2] + f[1] * e.inset + f[0] * shift],
      facing: base.facing,
    };
  }

  /** Where the player comes out of a space into the space its door is in: past the door trigger, facing away from the door. */
  exitSpawn(interiorId: string): Stand {
    const place = this.interior(interiorId).place;
    const outer = this.outerSpace(interiorId)!;
    const door = this.layout.places[place]?.door;
    if (!door) return this.spawnIn(outer, this.defaultPlaceOf(outer));
    const d = this.doorStand(door);
    const out = door.depth[1] + 0.6;
    const x = d.pos[0] + d.facing[0] * out;
    const z = d.pos[2] + d.facing[2] * out;
    return { pos: [x, this.heightAt(outer, x, z), z], facing: d.facing };
  }

  interior(id: string): InteriorLayout {
    const i = this.layout.interiors?.[id];
    if (!i) throw new Error(`layout has no interior "${id}"`);
    return i;
  }

  /** The place's spawn, in the place's space. */
  spawn(place: string): Stand {
    return this.spawnIn(this.spaceOf(place), place);
  }

  private spawnIn(space: string, place: string): Stand {
    const s = (this.layout.places[place] ?? this.layout.places[this.layout.defaultPlace]).spawn;
    if ("interior" in s) return this.entrySpawn(s.interior);
    if ("building" in s) return this.onGround(space, this.stand(s.building, s.anchor));
    return this.onGround(space, { pos: s.pos, facing: vec3(s.facing) });
  }

  /** A place with no building here (the Go to list only; `PlaceLayout.travelOnly`). */
  travelOnly(place: string): boolean {
    return !!this.layout.places[place]?.travelOnly;
  }

  /**
   * Where the player appears after core moved them to `place` while they were in space `from`:
   * out of the door of the space just left, when that door is in this space and opens onto this
   * place; else the place's spawn (a space of its own: its entry).
   */
  arrival(place: string, from: string): { space: string; stand: Stand } {
    const space = this.spaceOf(place);
    if (from !== space && this.layout.interiors?.[from] && this.outerSpace(from) === space) {
      const out = this.exitSpawn(from);
      if (this.placeAt(space, out.pos[0], out.pos[2]) === place) return { space, stand: out };
    }
    return { space, stand: this.spawnIn(space, place) };
  }

  /** The normalised scene space. */
  space(id: string): SpaceLayout {
    let s = this.spaceCache.get(id);
    if (!s) {
      s = id === STREET ? this.streetSpace() : this.interiorSpace(id);
      this.spaceCache.set(id, s);
    }
    return s;
  }

  private npcsIn(space: string): string[] {
    return Object.keys(this.layout.npcs).filter((n) => this.npcSpace(n) === space);
  }

  /** A door's anchor stand, moved `shift` across (to the right as you face it from outside). */
  private doorStand(door: DoorSpec): Stand {
    const d = this.stand(door.building, door.anchor);
    const k = door.shift ?? 0;
    const len = Math.hypot(d.facing[0], d.facing[2]) || 1;
    return { pos: [d.pos[0] + (d.facing[2] / len) * k, d.pos[1], d.pos[2] - (d.facing[0] / len) * k], facing: d.facing };
  }

  /** The zones, doors and stay spots of the places in `space` (`places.<p>.space`, the town by default). */
  private placeTriggers(space: string): Trigger[] {
    const triggers: Trigger[] = [];
    for (const [place, p] of Object.entries(this.layout.places)) {
      if ((p.space ?? STREET) !== space) continue;
      for (const box of [...(p.zone ? [p.zone] : []), ...(p.zones ?? [])]) {
        const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
        triggers.push({ kind: "zone", place, box, at: [c[0], 2.2, c[1]] });
      }
      if (p.stay) {
        const c = [(p.stay.min[0] + p.stay.max[0]) / 2, (p.stay.min[1] + p.stay.max[1]) / 2];
        triggers.push({ kind: "stay", place, box: p.stay, at: [c[0], 2.2, c[1]] });
      }
      if (p.door) {
        const d = this.doorStand(p.door);
        const f = p.door.depth[0];
        triggers.push({
          kind: "door",
          place,
          box: boxAlong(d.pos, d.facing, p.door.width, p.door.depth),
          at: [d.pos[0] + d.facing[0] * f, d.pos[1] + 2.2, d.pos[2] + d.facing[2] * f],
        });
      }
    }
    return triggers;
  }

  /** The town: its placements, blockers, landscape, sky, sun and fog; walking on its grid and decks (heightAt, walkable). */
  private streetSpace(): SpaceLayout {
    const l = this.layout;
    const t = l.town;
    return {
      id: STREET,
      defaultPlace: l.defaultPlace,
      bounds: t.bounds,
      surfaces: this.surfacesOf(STREET),
      blockers: t.blockers.map(orientedBlocker),
      town: { landscape: t.landscape, sky: t.sky, sun: t.sun, fog: t.fog },
      pieces: t.buildings.map((b) => this.building(b.id)),
      tiles: [],
      ground: [],
      dressing: t.dressing,
      walkers: t.walkers,
      triggers: this.placeTriggers(STREET),
      interactables: [],
      npcs: this.npcsIn(STREET),
      camera: {},
      interior: false,
    };
  }

  /** A space's walking heights: a side street's own, else its flat floor (the town walks on its grid instead, heightAt). */
  private surfacesOf(space: string): Surfaces {
    if (space === STREET) return { default: 0, bands: [] };
    const i = this.interior(space);
    if (i.surfaces) return i.surfaces;
    return { default: i.floorY ?? (i.shell ? ((this.asset(i.shell.asset).anchors?.floor_top_z as number | undefined) ?? 0.06) : 0.06), bands: [] };
  }

  private interiorSpace(id: string): SpaceLayout {
    const i = this.interior(id);
    const surfaces = this.surfacesOf(id);
    const floorY = surfaces.default;
    const [W, D] = i.size ?? (i.shell ? [this.asset(i.shell.asset).size_m[0], this.asset(i.shell.asset).size_m[2]] : [6, 5]);
    const bounds = i.bounds ?? { min: [-W / 2 + WALL, -D + WALL], max: [W / 2 - WALL, 0.35] };
    // The way out (the whole open front edge, or its exit box) leads to the place outside this space's door.
    const outer = this.outerSpace(id)!;
    const outside = this.exitSpawn(id);
    const exitPlace = this.placeAt(outer, outside.pos[0], outside.pos[2]);
    const depth = i.exitDepth ?? 0.9;
    const box: Box2 = i.exitBox ?? { min: [bounds.min[0], bounds.max[1] - depth], max: [bounds.max[0], bounds.max[1]] };
    const exit: Trigger = {
      kind: "exit",
      place: exitPlace,
      box,
      at: i.exitBox
        ? [(box.min[0] + box.max[0]) / 2, floorY + 1.4, (box.min[1] + box.max[1]) / 2]
        : [this.entrySpawn(id).pos[0], floorY + 1.4, bounds.max[1] - depth / 2],
    };
    const pieces = [...this.buildings.values()].filter((p) => this.pieceSpace.get(p.id) === id);
    return {
      id,
      defaultPlace: i.place,
      bounds,
      surfaces,
      blockers: [],
      pieces,
      tiles: i.tiles ?? [],
      ground: i.ground,
      dressing: i.dressing,
      walkers: i.walkers ?? [],
      triggers: [exit, ...this.placeTriggers(id)],
      interactables: i.interactables.map((x) => ({
        kind: x.kind,
        range: x.range ?? 1.5,
        pos: "pos" in x.at ? x.at.pos : x.at.anchor ? this.point(x.at.building, x.at.anchor) : this.building(x.at.building).pos,
      })),
      npcs: this.npcsIn(id),
      camera: i.camera ?? {},
      background: i.background,
      interior: !i.outdoor,
    };
  }

  /**
   * The trigger holding (x, z) in a space, or null: a door or way out first, else a zone (a door
   * sits inside the zone round it); travel-only stay spots never count. `margin` > 0 asks for
   * "well inside" (the box shrunk by it), < 0 for "anywhere near" (grown): ZoneTracker uses both
   * for hysteresis.
   */
  triggerAt(space: string, x: number, z: number, margin = 0): Trigger | null {
    const ts = this.space(space).triggers;
    for (const t of ts) if ((t.kind === "door" || t.kind === "exit") && inBox(t.box, x, z, margin)) return t;
    for (const t of ts) if (t.kind === "zone" && inBox(t.box, x, z, margin)) return t;
    return null;
  }

  /** The place at (x, z) in a space: its trigger's place, else the space's default place. */
  placeAt(space: string, x: number, z: number): string {
    return this.triggerAt(space, x, z)?.place ?? this.space(space).defaultPlace;
  }

  /**
   * Whether standing at (x, z) is being at `place` (within `margin` of one of its triggers, its
   * stay spot included; for the default place, not well inside any other trigger). Where core put
   * the player at a place the player isn't standing at (the Go to list), SpaceNav moves them.
   */
  holds(space: string, place: string, x: number, z: number, margin = 0): boolean {
    const own = this.space(space).triggers.filter((t) => t.place === place);
    if (own.some((t) => inBox(t.box, x, z, -margin))) return true;
    return place === this.space(space).defaultPlace && !this.triggerAt(space, x, z, margin);
  }

  /** Walking surface height at (x, z): in the town the deck, else the plaza's top, else the terrain grid (bilinear); indoors the floor. */
  heightAt(space: string, x: number, z: number): number {
    if (space === STREET) {
      const t = this.layout.town;
      const deck = deckAt(t.decks, x, z);
      if (deck) return deck.y;
      const h = gridHeight(t.grid, x, z);
      const p = t.plaza;
      return p && Math.hypot(x - p.centre[0], z - p.centre[1]) <= p.radius ? Math.max(h, p.y) : h;
    }
    const surfaces = this.surfacesOf(space);
    const band = surfaces.bands.find((b) => z > b.zMin && z < b.zMax);
    return band ? band.y : surfaces.default;
  }

  /**
   * Whether the player can stand at (x, z) (movement.ts, on top of bounds and blockers). In the
   * town: a deck (bridge, pier) within its width less the player's radius, else a grid cell of
   * class 1-4 (ground, path, plaza, pad; the bridge slots, 5, only on a deck; water and slopes, 0,
   * never). Interiors: everywhere inside the bounds.
   */
  walkable(space: string, x: number, z: number): boolean {
    if (space !== STREET) return true;
    const t = this.layout.town;
    const deck = deckAt(t.decks, x, z);
    if (deck && deck.lateral <= deck.deck.width / 2 - PLAYER_RADIUS) return true;
    const c = gridClass(t.grid, x, z);
    return c >= 1 && c <= 4;
  }

  /**
   * The blocker of a piece placed with block "size": its index size (feet origin: base centred in
   * x/z), turned by rotY. Wall pieces, low things (mats, pallets, under 0.3 m) and small things
   * (stools, under 0.4 m across) don't block.
   */
  sizeBlocker(p: Placement): Box2 | null {
    const a = this.asset(p.asset);
    const [sx, sy, sz] = a.size_m;
    if (a.wall_piece || a.origin !== "feet" || sy < 0.3 || Math.min(sx, sz) < 0.4) return null;
    const corners: Vec3[] = [
      [-sx / 2, 0, -sz / 2],
      [sx / 2, 0, -sz / 2],
      [-sx / 2, 0, sz / 2],
      [sx / 2, 0, sz / 2],
    ].map((c) => anchorToWorld(p, c as Vec3));
    return aabb(corners);
  }

  /** Every asset name the layout instantiates (the build copies only these GLBs; build.mjs scans the same way). */
  assetNames(): string[] {
    return usedAssets(this.layout, (name) => this.assets.get(name));
  }
}

/**
 * The asset names a layout uses: every `asset` / `character` / `heldProp` / `sky` value and
 * `landscape` list anywhere in it, plus the furniture of every shell. scripts/used-assets.mjs (the
 * build and the asset sync) has the same scan in plain JS.
 */
export function usedAssets(layout: unknown, entry: (name: string) => { anchors?: Record<string, unknown> } | undefined): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "asset" || k === "character" || k === "heldProp" || k === "sky") && typeof x === "string") out.add(x);
      else if (k === "landscape" && Array.isArray(x)) x.forEach((n) => typeof n === "string" && out.add(n));
      else walk(x);
    }
  };
  walk(layout);
  for (const name of [...out]) {
    const slots = entry(name)?.anchors?.furniture_slots as { asset: string }[] | undefined;
    for (const s of slots ?? []) out.add(s.asset);
  }
  return [...out];
}

/**
 * The places to pass through to get from `from` to `to` in the world graph (excluding `from`).
 * The street's zones don't mirror the graph's links (the room is off Market Street), so walking
 * straight into a zone sends one goTo per hop. Empty when already there or unreachable.
 */
export function route(world: Pick<World, "places">, from: string, to: string): string[] {
  if (from === to) return [];
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of world.places[cur]?.links ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let p = cur; p !== from; p = prev.get(p)!) path.unshift(p);
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}
