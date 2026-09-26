// 0.13's multi-language platform in the 3D front end: the course picked and loaded as the browser
// TUI does (courses.ts), a 0.12 save moving to the course's new id, readings as the TUI shows them,
// and tiles spaced in a spaced language.
import { describe, expect, it } from "vitest";
import { createCore, newGame, serialize, type CatalogEntry, type Course, type WordRecord } from "@silver-tongue/core";
import { loadWebSettings, SETTINGS_KEY, type KeyValue } from "@silver-tongue/tui-web/src/web-storage";
import { coursePath, pickCourse, type CourseChoice, type FetchJson } from "../src/courses";
import { createGame, lineReading, openSession } from "../src/game";
import { course, rightTiles } from "./helpers";

/** An in-memory localStorage (as tui-web's web-storage test). */
class FakeStorage implements KeyValue {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  keys() {
    return [...this.data.keys()];
  }
}

const entry: CatalogEntry = { id: course.id, language: course.language.code, setting: "china-city", learners: [course.learner], learnerNames: { [course.learner]: "English" } };

/** A server with these files; anything else is a 404. Records every path asked for. */
function server(files: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchJson: FetchJson = async <T>(path: string) => {
    asked.push(path);
    if (!(path in files)) throw new Error(`${path}: 404`);
    return structuredClone(files[path]) as T;
  };
  return { fetchJson, asked };
}

const noChoice = async (): Promise<number> => {
  throw new Error("asked to choose");
};

describe("picking the course", () => {
  it("the only course plays straight away in its default reading language, and is remembered", async () => {
    const kv = new FakeStorage();
    const { fetchJson, asked } = server({ "courses/index.json": [entry], [coursePath(entry, "en")]: course });
    const picked = await pickCourse({ fetchJson, kv, choose: noChoice });
    expect(picked.course.id).toBe(course.id);
    expect(asked).toEqual(["courses/index.json", `courses/${course.id}/en.json`]);
    expect(loadWebSettings(kv)).toEqual({ course: course.id, learner: course.learner });
  });

  it("several courses and none remembered: the player chooses, a failed load says so and the list stays", async () => {
    const kv = new FakeStorage();
    const other: CatalogEntry = { id: "xx-test", language: "xx", setting: "s", learners: ["en"], learnerNames: { en: "English" } };
    const { fetchJson } = server({ "courses/index.json": [entry, other], [coursePath(entry, "en")]: course });
    const shown: CourseChoice[] = [];
    const picks = [1, 0]; // xx-test (its file is missing), then the first course
    const picked = await pickCourse({
      fetchJson,
      kv,
      choose: async (c) => {
        shown.push(c);
        // nothing is remembered until a course is chosen and loaded
        expect(kv.getItem(SETTINGS_KEY)).toBeNull();
        return picks.shift()!;
      },
    });
    expect(shown).toHaveLength(2);
    expect(shown[0].labels).toHaveLength(2);
    expect(shown[0].labels[1]).toBe("xx"); // no language name for it: its code, as courseLabels
    expect(shown[0].error).toBeUndefined();
    expect(shown[1].error).toBeTruthy();
    expect(picked.entry).toBe(picked.catalog[0]);
    expect(loadWebSettings(kv)).toEqual({ course: course.id, learner: "en" });
  });

  it("a remembered course is played without asking, and a reading language it lacks falls back to its default", async () => {
    const kv = new FakeStorage();
    kv.setItem(SETTINGS_KEY, JSON.stringify({ course: course.id, learner: "fr" }));
    const other: CatalogEntry = { id: "xx-test", language: "xx", setting: "s", learners: ["en"], learnerNames: { en: "English" } };
    const { fetchJson } = server({ "courses/index.json": [other, entry], [coursePath(entry, "en")]: course });
    const picked = await pickCourse({ fetchJson, kv, choose: noChoice });
    expect(picked.entry.id).toBe(course.id);
    expect(picked.course.learner).toBe("en");
  });

  it("no catalog: pickCourse throws (the page says it could not load)", async () => {
    const { fetchJson } = server({});
    await expect(pickCourse({ fetchJson, kv: new FakeStorage(), choose: noChoice })).rejects.toThrow();
  });
});

describe("a 0.12 save", () => {
  it("made under the old course id loads, as the last game, from the same keys the browser TUI moves it to", async () => {
    expect(course.aliases).toContain("zh-china-en");
    const kv = new FakeStorage();
    const old = { ...newGame(course), course: "zh-china-en", player: "Sam", wallet: 123 };
    kv.setItem("silver-tongue:zh-china-en:session:s1", serialize(old));
    kv.setItem("silver-tongue:zh-china-en:meta", JSON.stringify({ last: "s1", played: { s1: 5 } }));
    const { fetchJson } = server({ "courses/index.json": [entry], [coursePath(entry, "en")]: course });
    const { course: loaded } = await pickCourse({ fetchJson, kv, choose: noChoice });
    expect(kv.keys().filter((k) => k.startsWith("silver-tongue:zh-china-en:"))).toEqual([]);
    let t = Date.UTC(2026, 8, 26, 12);
    const { game, opened } = openSession(loaded, kv, { now: () => (t += 1000) });
    expect(opened.id).toBe("s1");
    expect(opened.notice).toBeUndefined();
    expect(game.core.state.player).toBe("Sam");
    expect(game.core.state.wallet).toBe(123);
    // saved from now on under the new id
    game.talkTo("wang");
    expect(JSON.parse(kv.getItem(`silver-tongue:${course.id}:session:s1`)!).course).toBe(course.id);
  });
});

describe("readings", () => {
  const named = (c: Course) => {
    let t = 1_000_000;
    const now = () => (t += 1000);
    const core = createCore(c, { ...newGame(c), player: "Sam" }, { now, rng: () => 0.42 });
    return createGame({ course: c, core, now });
  };

  it("word help shows every reading; sentence help and the slowed line's ruby the last of each word", () => {
    const g0 = named(course);
    g0.talkTo("wang");
    const line = g0.model.bubble!.line;
    const word = line.tokens[0].word;
    const many: Course = { ...course, words: { ...course.words, [word]: { ...course.words[word], readings: ["first", "last"] } } };
    const g = named(many);
    g.talkTo("wang");
    expect(g.helpWord(word)?.reading).toBe("first last");
    expect(lineReading(many, line).split(" ")).toContain("last");
    expect(lineReading(many, line).split(" ")).not.toContain("first");
    expect(g.sentence(g.model.bubble!.line)?.reading).toBe(lineReading(many, g.model.bubble!.line));
    // a word with no readings shows none
    const none: Course = { ...course, words: { ...course.words, [word]: { ...course.words[word], readings: undefined } } };
    expect(named(none).helpWord(word)?.reading).toBeUndefined();
  });

  it("tiles are spaced in a spaced language, as core judges them", () => {
    const spaced: Course = { ...course, language: { ...course.language, spaced: true } };
    const T = 1_000_000;
    const lapsed: WordRecord = { right: 1, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T, lastSeen: T };
    const words = Object.fromEntries(Object.keys(spaced.words).map((w) => [w, { ...lapsed }]));
    let t = T;
    const now = () => (t += 1000);
    const core = createCore(spaced, { ...newGame(spaced), player: "Sam", words }, { now, rng: () => 0.42 });
    const game = createGame({ course: spaced, core, now });
    game.talkTo("wang");
    expect(game.model.reply?.mode).toBe("tiles");
    const r = game.model.reply as { tiles: string[] };
    const right = rightTiles(game);
    expect(right.length).toBeGreaterThan(1);
    // a wrong order: what the player placed, spaced
    const wrong = [...right].reverse();
    game.replyTiles(wrong);
    const said = game.model.feed.filter((f) => f.kind === "you").at(-1)!.text;
    expect(said).toContain(wrong.map((i) => r.tiles[i]).join(" "));
  });
});
