// The spatial layout the 3D world owns (core's world graph has no coordinates), plus the pure
// maths on it: anchor -> world transforms, scene spaces (the street and each interior), trigger
// zones, walking height, blockers of interior furniture, place routing.
// No three.js here, so game logic and tests can use it without WebGL.
import type { World } from "@silver-tongue/core";
import layoutJson from "./layout.json";

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** An asset instance: glTF axes, rotY/tiltX in degrees. */
export interface Placement {
  asset: string;
  pos: Vec3;
  rotY: number;
  tiltX?: number;
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
  /** the door (in `space`) that leads into it */
  door?: DoorSpec;
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
export interface Layout {
  defaultPlace: string;
  bounds: Box2;
  surfaces: Surfaces;
  /** the player's character, and what they carry while an errand is on (a parcel: `{asset, carry: true}`) */
  player: { character: string; errandProp?: HeldPropSpec };
  places: Record<string, PlaceLayout>;
  npcs: Record<string, NpcLayout>;
  buildings: BuildingPlacement[];
  tiles: Placement[];
  ground: GroundBox[];
  dressing: Placement[];
  interiors: Record<string, InteriorLayout>;
  walkers: WalkerLayout[];
}

export const LAYOUT = layoutJson as unknown as Layout;
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

/** A trigger box: a place's zone, a door into another space, or a space's way out. */
export interface Trigger {
  kind: "zone" | "door" | "exit";
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

/** One scene space, normalised: the street and every interior go through this shape. */
export interface SpaceLayout {
  id: string;
  /** the place you are at anywhere in the space outside its triggers */
  defaultPlace: string;
  bounds: Box2;
  surfaces: Surfaces;
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

/** A point in an asset's frame -> world, for an instance at `p` (rotY about +Y, glTF convention). */
export function anchorToWorld(p: Pick<Placement, "pos" | "rotY">, local: Vec3): Vec3 {
  const a = p.rotY * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Rotation about +Y: x' = x cos + z sin, z' = -x sin + z cos.
  return [p.pos[0] + local[0] * c + local[2] * s, p.pos[1] + local[1], p.pos[2] - local[0] * s + local[2] * c];
}

/** A direction in an asset's frame -> world (rotation only). */
export function dirToWorld(p: Pick<Placement, "rotY">, local: Vec3): Vec3 {
  return anchorToWorld({ pos: [0, 0, 0], rotY: p.rotY }, local);
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
    for (const b of layout.buildings) this.addPiece(STREET, { ...b, block: "footprint" });
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

  /** Every scene space: the street, then each interior. */
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

  private resolveStand(n: NpcLayout, spec: string | FixedStand): Stand {
    if (typeof spec !== "string") return { pos: spec.pos, facing: vec3(spec.facing) };
    if (!n.building) throw new Error(`npc stand "${spec}" needs a building`);
    return this.stand(n.building, spec);
  }

  npcStand(npc: string): Stand {
    const n = this.npc(npc);
    return this.resolveStand(n, n.stand);
  }

  /** Where the player stands to talk to `npc`, facing them. */
  talkStand(npc: string): Stand {
    const n = this.npc(npc);
    return this.resolveStand(n, n.playerStand);
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

  private spawnIn(_space: string, place: string): Stand {
    const s = (this.layout.places[place] ?? this.layout.places[this.layout.defaultPlace]).spawn;
    if ("interior" in s) return this.entrySpawn(s.interior);
    if ("building" in s) return this.stand(s.building, s.anchor);
    return { pos: s.pos, facing: vec3(s.facing) };
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

  /** The zones and doors of the places in `space` (`places.<p>.space`, the street by default). */
  private placeTriggers(space: string): Trigger[] {
    const triggers: Trigger[] = [];
    for (const [place, p] of Object.entries(this.layout.places)) {
      if ((p.space ?? STREET) !== space) continue;
      for (const box of [...(p.zone ? [p.zone] : []), ...(p.zones ?? [])]) {
        const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
        triggers.push({ kind: "zone", place, box, at: [c[0], 2.2, c[1]] });
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

  private streetSpace(): SpaceLayout {
    const l = this.layout;
    const triggers = this.placeTriggers(STREET);
    return {
      id: STREET,
      defaultPlace: l.defaultPlace,
      bounds: l.bounds,
      surfaces: l.surfaces,
      pieces: l.buildings.map((b) => this.building(b.id)),
      tiles: l.tiles,
      ground: l.ground,
      dressing: l.dressing,
      walkers: l.walkers ?? [],
      triggers,
      interactables: [],
      npcs: this.npcsIn(STREET),
      camera: {},
      interior: false,
    };
  }

  /** A space's walking heights: Main Street's kerbs, a side street's own, else its flat floor. */
  private surfacesOf(space: string): Surfaces {
    if (space === STREET) return this.layout.surfaces;
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
   * The trigger holding (x, z) in a space, or null. `margin` > 0 asks for "well inside" (the box
   * shrunk by it), < 0 for "anywhere near" (grown): ZoneTracker uses both for hysteresis.
   */
  triggerAt(space: string, x: number, z: number, margin = 0): Trigger | null {
    for (const t of this.space(space).triggers) if (inBox(t.box, x, z, margin)) return t;
    return null;
  }

  /** The place at (x, z) in a space: its trigger's place, else the space's default place. */
  placeAt(space: string, x: number, z: number): string {
    return this.triggerAt(space, x, z)?.place ?? this.space(space).defaultPlace;
  }

  /** Walking surface height at (x, z). */
  heightAt(space: string, _x: number, z: number): number {
    const surfaces = this.surfacesOf(space);
    const band = surfaces.bands.find((b) => z > b.zMin && z < b.zMax);
    return band ? band.y : surfaces.default;
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
 * The asset names a layout uses: every `asset` / `character` / `heldProp` value anywhere in it,
 * plus the furniture of every shell. build.mjs has the same scan in plain JS.
 */
export function usedAssets(layout: unknown, entry: (name: string) => { anchors?: Record<string, unknown> } | undefined): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "asset" || k === "character" || k === "heldProp") && typeof x === "string") out.add(x);
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
