// Music, ambience and effects (audio.ts), DOM-free: the pure choices the SoundMixer plays: the
// file format by canPlayType, the music bed for the phase / daylight / space, the ambient loops by
// distance to the real town's water, daylight and zone, the footstep surface from the real walk
// grid and decks, the stride clock, the event effects; the vendored manifest; the prefs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ambientFor,
  CROSSFADE_S,
  dbToGain,
  EVENING_AT,
  fileFor,
  footstep,
  musicFor,
  pickFormat,
  sfxForEvent,
  StrideClock,
  surfaceFor,
  waterDistance,
  WATER_RANGE_M,
  type SoundEntry,
} from "../src/audio";
import { deckAt, gridClass, LAYOUT } from "../src/layout";
import { DEFAULT_PREFS, loadPrefs, PREFS_KEY, savePrefs } from "../src/prefs";

const town = LAYOUT.town;
const MANIFEST = fileURLToPath(new URL("../assets/audio/manifest.json", import.meta.url));
const manifest: SoundEntry[] = JSON.parse(readFileSync(MANIFEST, "utf8"));

describe("format", () => {
  const plays = (...ok: string[]) => (m: string) => (ok.some((k) => m.includes(k)) ? "probably" : "");
  it("ogg where the browser plays Vorbis, else m4a (Safari), else nothing", () => {
    expect(pickFormat(plays("ogg", "mp4"))).toBe("ogg");
    expect(pickFormat(plays("mp4"))).toBe("m4a");
    expect(pickFormat(plays())).toBeNull();
    expect(pickFormat(undefined)).toBeNull();
  });
  it("an entry the build shipped in one format only falls back to it when the browser plays it", () => {
    const music: SoundEntry = { id: "town_day", kind: "music", file_ogg: "assets/audio/music/town_day.ogg", seconds: 66, loop: true };
    expect(fileFor(music, "ogg")).toBe(music.file_ogg);
    expect(fileFor(music, "m4a", plays("mp4"))).toBeNull();
    expect(fileFor(music, "m4a", plays("mp4", "ogg"))).toBe(music.file_ogg);
  });
});

describe("the music bus", () => {
  it("title → fly-over → the town by daylight; inside a building −6 dB", () => {
    expect(musicFor({ phase: "title", daylight: 0, interior: false })).toEqual({ track: "title_theme", gain: 1 });
    expect(musicFor({ phase: "cutscene", daylight: 0, interior: false }).track).toBe("cutscene_flyover");
    expect(musicFor({ phase: "game", daylight: 0, interior: false })).toEqual({ track: "town_day", gain: 1 });
    expect(musicFor({ phase: "game", daylight: EVENING_AT - 0.01, interior: false }).track).toBe("town_day");
    expect(musicFor({ phase: "game", daylight: EVENING_AT, interior: false }).track).toBe("town_evening");
    const inside = musicFor({ phase: "game", daylight: 0.25, interior: true });
    expect(inside.track).toBe("town_day");
    expect(20 * Math.log10(inside.gain)).toBeCloseTo(-6, 6);
    expect(dbToGain(0)).toBe(1);
    expect(CROSSFADE_S).toBe(1.5);
  });
});

describe("the ambient bus", () => {
  const water = waterDistance(town.grid);
  it("canal_water by distance to the real canal and lake: full at the water, silent from 25 m", () => {
    // on the stone bridge over the canal (x -28, z 18) and at the pier's end: water right there
    expect(water(-28, 18)).toBeLessThan(2);
    // the plaza's centre is well away from the canal (z 14.4-21.6) and the lake (west)
    const plaza = water(0, 0);
    expect(plaza).toBeGreaterThan(10);
    const near = ambientFor({ phase: "game", daylight: 0, interior: false, waterDistance: water(-28, 18) }).canal_water;
    const mid = ambientFor({ phase: "game", daylight: 0, interior: false, waterDistance: plaza }).canal_water;
    expect(near).toBeGreaterThan(0.9);
    expect(mid).toBeLessThan(near);
    expect(ambientFor({ phase: "game", daylight: 0, interior: false, waterDistance: WATER_RANGE_M }).canal_water).toBe(0);
    // the far north edge of the town: out of range
    expect(ambientFor({ phase: "game", daylight: 0, interior: false, waterDistance: water(40, -60) }).canal_water).toBe(0);
  });
  it("birds by day, crickets in the evening, the market murmur in the market; nothing indoors or on the title", () => {
    const day = ambientFor({ phase: "game", daylight: 0.2, interior: false, place: "street", waterDistance: 99 });
    expect(day.birds_day).toBeGreaterThan(0);
    expect(day.crickets_evening).toBe(0);
    expect(day.market_murmur).toBe(0);
    const eve = ambientFor({ phase: "game", daylight: 0.8, interior: false, place: "market", waterDistance: 99 });
    expect(eve.birds_day).toBe(0);
    expect(eve.crickets_evening).toBeGreaterThan(0);
    expect(eve.market_murmur).toBeGreaterThan(0);
    for (const s of [ambientFor({ phase: "game", daylight: 0.2, interior: true, place: "market", waterDistance: 0 }), ambientFor({ phase: "title", daylight: 0, interior: false, waterDistance: 0 })])
      expect(Object.values(s).every((v) => v === 0)).toBe(true);
  });
});

describe("footsteps", () => {
  const at = (x: number, z: number) => {
    const d = deckAt(town.decks, x, z);
    return surfaceFor({ gridClass: gridClass(town.grid, x, z), deck: d?.deck ?? null });
  };
  it("the surface from the walk grid class and the decks", () => {
    expect(surfaceFor({ gridClass: 1 })).toBe("grass");
    for (const c of [2, 3, 4]) expect(surfaceFor({ gridClass: c })).toBe("stone");
    expect(surfaceFor({ gridClass: 3, interior: true })).toBe("wood");
    // the real town: the plaza is stone, the stone arch bridge stone, the wooden bridge and the pier wood
    expect(gridClass(town.grid, 0, 0)).toBe(3);
    expect(at(0, 0)).toBe("stone");
    expect(at(-28, 18)).toBe("stone");
    expect(at(28, 18)).toBe("wood");
    const pier = town.decks.find((d) => d.kind === "pier")!;
    const mid = pier.path[Math.floor(pier.path.length / 2)];
    expect(at(mid[0], mid[2])).toBe("wood");
    // somewhere on the grass: some class-1 cell of the grid
    const j = town.grid.classes.findIndex((row) => row.includes("1"));
    const i = town.grid.classes[j].indexOf("1");
    expect(at(town.grid.x0 + i + 0.5, town.grid.z0 + j + 0.5)).toBe("grass");
  });
  it("one of four at random, ±10 % pitch", () => {
    const seen = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const r = (k * 0.618) % 1;
      const f = footstep("stone", () => r);
      seen.add(f.id);
      expect(f.rate).toBeGreaterThanOrEqual(0.9);
      expect(f.rate).toBeLessThanOrEqual(1.1);
    }
    expect([...seen].sort()).toEqual(["step_stone_1", "step_stone_2", "step_stone_3", "step_stone_4"]);
    expect(footstep("wood", () => 0.9999).id).toBe("step_wood_4");
  });
  it("two footfalls per stride of the walk clip, the first half a step in", () => {
    const c = new StrideClock(1.3);
    expect(c.advance(0.3)).toBe(0); // 0.325 + 0.3 < 0.65
    expect(c.advance(0.05)).toBe(1);
    let n = 0;
    for (let k = 0; k < 130; k++) n += c.advance(0.1); // 13 m more
    expect(n).toBe(20);
    c.reset();
    expect(c.advance(0.3)).toBe(0);
  });
});

describe("event effects", () => {
  it("a scene done, a mix-up, money in a shop or wages", () => {
    expect(sfxForEvent({ type: "sceneEnded" })).toBe("success_jingle");
    expect(sfxForEvent({ type: "actionPerformed", matched: false })).toBe("fail_soft");
    expect(sfxForEvent({ type: "actionPerformed", matched: true, tilesWrong: true })).toBe("fail_soft");
    expect(sfxForEvent({ type: "actionPerformed", matched: true })).toBeNull();
    expect(sfxForEvent({ type: "walletChanged", reason: "shopping" })).toBe("coin");
    expect(sfxForEvent({ type: "walletChanged", reason: "food" })).toBeNull();
    expect(sfxForEvent({ type: "lineSpoken" })).toBeNull();
  });
});

describe("the vendored sounds", () => {
  it("every id the game plays is in the manifest, with both files vendored", () => {
    const ids = new Set(manifest.map((e) => e.id));
    const used = [
      "title_theme", "cutscene_flyover", "town_day", "town_evening",
      "canal_water", "birds_day", "crickets_evening", "market_murmur",
      "ui_tap", "ui_confirm", "ui_back", "ui_page", "ui_reveal", "tile_place", "tile_undo", "bubble_open", "bubble_close",
      "coin", "success_jingle", "fail_soft", "door_open", "door_close", "notebook_open", "cutscene_skip", "bell_temple",
      ...["stone", "grass", "wood"].flatMap((s) => [1, 2, 3, 4].map((n) => `step_${s}_${n}`)),
    ];
    for (const id of used) expect(ids, id).toContain(id);
    for (const e of manifest)
      for (const f of [e.file_ogg, e.file_m4a]) expect(existsSync(fileURLToPath(new URL(`../${f}`, import.meta.url))), f).toBe(true);
    for (const id of ["town_day", "town_evening", "title_theme", "canal_water"]) expect(manifest.find((e) => e.id === id)!.loop, id).toBe(true);
  });
});

describe("prefs", () => {
  it("sound, music volume and the guide, apart from the shared settings key; junk and blocked storage: defaults", () => {
    const data = new Map<string, string>();
    const kv = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), keys: () => [...data.keys()] };
    expect(loadPrefs(kv)).toEqual(DEFAULT_PREFS);
    savePrefs(kv, { sound: false, music: 0.3, guideHidden: true });
    expect(loadPrefs(kv)).toEqual({ sound: false, music: 0.3, guideHidden: true });
    expect([...data.keys()]).toEqual([PREFS_KEY]);
    data.set(PREFS_KEY, '{"music": 7, "sound": "x"}');
    expect(loadPrefs(kv)).toEqual(DEFAULT_PREFS);
    const blocked = { ...kv, getItem: () => { throw new Error("no"); } };
    expect(loadPrefs(blocked)).toEqual(DEFAULT_PREFS);
  });
});
