// What loads when (pure): the first frame waits only for what the town's first views show; the
// rest streams in behind it. And the loading screen's numbers: a reducer over the loader's
// per-file progress (bytes where the index knows the file's size or the server sends a length,
// else a count).
//
//   first   the town's ground and everything on it that never moves (landscape, sky, tiles,
//           buildings, props, static dressing) plus the player and the parcel they may carry:
//           the fly-over's first key and the spawn see all of it, and nothing can be played without it
//   town    the town's people (NPCs nearest the spawn first), walkers and pets with what they
//           hold: after the first frame, never blocking input; each appears as it lands
//   spaces  every interior, nearest door first: prefetched once the town is up and idle; a door
//           whose room hasn't landed yet waits behind the loading screen (shown after 300 ms)
//
// Audio never waits here: the mixer fetches nothing before the first gesture (audio.ts), and the
// word clips are fetched as they are said.
import { heldProp, type LayoutIndex, type SpaceLayout, type Vec3 } from "./layout";

export interface LoadPlan {
  first: string[];
  town: string[];
  spaces: { id: string; assets: string[] }[];
}

/** character kinds that animate (world.ts: an actor, never batched) */
export const CHARACTER_KINDS = new Set(["human", "recolour", "pet"]);

/** A space's assets split into what never moves (batched, needed for its first frame) and its characters with their props. */
export function spaceAssets(L: LayoutIndex, s: SpaceLayout): { statics: string[]; characters: string[] } {
  const statics = new Set<string>();
  const characters = new Set<string>();
  for (const n of s.town?.landscape ?? []) statics.add(n);
  if (s.town?.sky) statics.add(s.town.sky);
  for (const t of s.tiles) statics.add(t.asset);
  for (const p of s.pieces) statics.add(p.asset);
  const pets: string[] = [];
  for (const d of s.dressing) {
    const e = L.asset(d.asset);
    if (e.set === "characters" && CHARACTER_KINDS.has(e.kind ?? "")) pets.push(d.asset);
    else statics.add(d.asset);
  }
  const people: { character: string; prop?: string; at: Vec3 | null }[] = [];
  for (const npc of s.npcs) {
    const n = L.npc(npc);
    people.push({ character: n.character, prop: heldProp(n.heldProp)?.asset, at: L.npcStand(npc).pos });
  }
  for (const w of s.walkers) people.push({ character: w.character, prop: heldProp(w.heldProp)?.asset, at: [w.path[0][0], 0, w.path[0][1]] });
  // the people nearest the space's spawn first: they are the ones the first views show
  const spawn = s.town ? L.spawn(s.defaultPlace).pos : null;
  const d = (p: Vec3 | null) => (spawn && p ? Math.hypot(p[0] - spawn[0], p[2] - spawn[2]) : 0);
  people.sort((a, b) => d(a.at) - d(b.at));
  for (const p of people) {
    characters.add(p.character);
    if (p.prop) characters.add(p.prop);
  }
  for (const n of pets) characters.add(n); // pets and pigeons after the people
  for (const n of characters) statics.delete(n);
  return { statics: [...statics], characters: [...characters].filter((n) => !statics.has(n)) };
}

/**
 * The load order for the page: `start` is the space the player starts in (the town, or a saved
 * game's interior: then that room joins `first`). Every asset the layout uses is in exactly one list.
 */
export function loadPlan(L: LayoutIndex, player: { character: string; errandProp?: string }, start = "street"): LoadPlan {
  const town = L.space("street");
  const t = spaceAssets(L, town);
  const first = new Set<string>([...t.statics, player.character, ...(player.errandProp ? [player.errandProp] : [])]);
  const later = new Set<string>(t.characters);
  // interiors: nearest door (from the spawn) first
  const spawn = L.spawn(town.defaultPlace).pos;
  const doorOf = (id: string) => {
    const door = town.triggers.find((tr) => tr.kind === "door" && L.space(id).defaultPlace === tr.place);
    return door ? Math.hypot(door.at[0] - spawn[0], door.at[2] - spawn[2]) : Infinity;
  };
  const ids = L.spaceIds().filter((id) => id !== "street");
  ids.sort((a, b) => (a === start ? -1 : b === start ? 1 : doorOf(a) - doorOf(b)));
  const spaces: LoadPlan["spaces"] = [];
  for (const id of ids) {
    const a = spaceAssets(L, L.space(id));
    const all = [...a.statics, ...a.characters];
    if (id === start) all.forEach((n) => first.add(n));
    spaces.push({ id, assets: all.filter((n) => !first.has(n)) });
  }
  for (const n of first) later.delete(n);
  // an asset shared by several interiors belongs to the first that needs it
  const seen = new Set<string>([...first, ...later]);
  for (const s of spaces) {
    s.assets = s.assets.filter((n) => !seen.has(n));
    s.assets.forEach((n) => seen.add(n));
  }
  return { first: [...first], town: [...later], spaces };
}

// ---------------------------------------------------------------------------------------------
// Loading progress
// ---------------------------------------------------------------------------------------------

export interface LoadItem {
  name: string;
  /** bytes the file has (index.json `bytes`, or the response's length), null when neither says */
  total: number | null;
  loaded: number;
  done: boolean;
  failed?: boolean;
}

export interface LoadState {
  items: LoadItem[];
}

export type LoadEvent =
  | { type: "start"; name: string; bytes?: number }
  | { type: "progress"; name: string; loaded: number; total?: number }
  | { type: "done"; name: string }
  | { type: "fail"; name: string }
  | { type: "reset" };

export const emptyLoad: LoadState = { items: [] };

/** One loader event onto the state (a new state; the old one untouched). */
export function reduceLoad(s: LoadState, e: LoadEvent): LoadState {
  if (e.type === "reset") return emptyLoad;
  const i = s.items.findIndex((x) => x.name === e.name);
  if (e.type === "start") {
    if (i >= 0) return s;
    return { items: [...s.items, { name: e.name, total: e.bytes && e.bytes > 0 ? e.bytes : null, loaded: 0, done: false }] };
  }
  if (i < 0) return s;
  const it = { ...s.items[i] };
  if (e.type === "progress") {
    // the index's size wins; a server length only when the index has none (and it's no smaller than what came)
    if (it.total === null && e.total && e.total >= e.loaded) it.total = e.total;
    it.loaded = it.total !== null ? Math.min(e.loaded, it.total) : e.loaded;
  } else if (e.type === "done") {
    it.done = true;
    if (it.total !== null) it.loaded = it.total;
  } else {
    it.done = true;
    it.failed = true;
  }
  const items = s.items.slice();
  items[i] = it;
  return { items };
}

export interface LoadSummary {
  count: number;
  done: number;
  /** 0..1: by bytes when every file's size is known, else by count (partly loaded files counting their share where known) */
  fraction: number;
  /** bytes loaded / expected (expected null when some size is unknown) */
  loaded: number;
  total: number | null;
  /** the file the bar is on now: the first still loading */
  current: string | null;
  complete: boolean;
}

export function loadSummary(s: LoadState): LoadSummary {
  const count = s.items.length;
  const done = s.items.filter((x) => x.done).length;
  const loaded = s.items.reduce((n, x) => n + x.loaded, 0);
  const known = s.items.every((x) => x.total !== null);
  const total = known ? s.items.reduce((n, x) => n + (x.total ?? 0), 0) : null;
  let fraction: number;
  if (!count) fraction = 1;
  else if (total) fraction = loaded / total;
  else fraction = s.items.reduce((n, x) => n + (x.done ? 1 : x.total ? x.loaded / x.total : 0), 0) / count;
  return { count, done, fraction: Math.max(0, Math.min(1, fraction)), loaded, total, current: s.items.find((x) => !x.done)?.name ?? null, complete: done === count };
}

/** "3.1 / 7.8 MB", or "12 / 40 files" when the sizes aren't all known. */
export function progressLabel(p: LoadSummary): string {
  const mb = (n: number) => (n / 1048576).toFixed(1);
  return p.total ? `${mb(p.loaded)} / ${mb(p.total)} MB` : `${p.done} / ${p.count}`;
}
