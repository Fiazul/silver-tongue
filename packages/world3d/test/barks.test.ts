// Barks (src/barks.ts, barks/<language>.json): the picker (random, never the same line twice in a
// row, the fallback role), every figure in the merged town and every interior mapped to a role (no
// one falls back to passerby), every line glossed in every native language the chrome offers,
// its clip on disk, the role names in the chrome, and the game side: a bark shows its line, reading
// and meaning, says its clip on the bark player, closes on "…", and changes nothing in core.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { availableSceneIds, createCore, moneyBlocked, newGame } from "@silver-tongue/core";
import { describe, expect, it } from "vitest";
import { BARKS } from "../barks";
import { UI_LOCALES } from "../locale";
import { BARK_CLIP, BarkPicker, barkTokens, FALLBACK_ROLE, npcRole, spaceFigures, type BarkBook } from "../src/barks";
import { createGame } from "../src/game";
import { LAYOUT, LayoutIndex } from "../src/layout";
import { CHROME_KEYS } from "../src/strings";
import { ScatterMotion, WalkerMotion } from "../src/streetlife";
import { assetIndex, course, fakeAudio } from "./helpers";

const book: BarkBook = BARKS[course.language.code];
const L = new LayoutIndex(LAYOUT, assetIndex!);
const AUDIO = fileURLToPath(new URL("../barks/audio/", import.meta.url));

/** A seeded rng (mulberry32-ish LCG) for repeatable picks. */
const seeded = (seed = 7) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

describe("bark picker", () => {
  it("picks at random among a role's lines, never the same one twice in a row", () => {
    const p = new BarkPicker(book, seeded());
    for (const role of Object.keys(book.roles)) {
      const n = book.roles[role].lines.length;
      const seen = new Set<number>();
      let last = -1;
      for (let i = 0; i < 60; i++) {
        const { index, role: r } = p.pick(role);
        expect(r).toBe(role);
        if (n > 1) expect(index, `${role} repeated line ${index}`).not.toBe(last);
        seen.add(index);
        last = index;
      }
      expect(seen.size, `${role}: every line comes up`).toBe(n);
    }
  });

  it("even with an rng that always says the same thing", () => {
    const p = new BarkPicker(book, () => 0);
    const picks = Array.from({ length: 6 }, () => p.pick("egg_seller").index);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
  });

  it("a role the book lacks says the fallback's lines", () => {
    const p = new BarkPicker(book, seeded());
    const r = p.pick("no_such_role");
    expect(r.role).toBe(FALLBACK_ROLE);
    expect(book.roles[FALLBACK_ROLE].lines).toContain(r.line);
    expect(book.roles[FALLBACK_ROLE].lines.map((l) => l.text)).toEqual(expect.arrayContaining(["你好！", "不好意思，我有点忙。"]));
  });

  it("the egg seller has no eggs today", () => {
    expect(book.roles.egg_seller.lines[0]).toMatchObject({ text: "今天没有鸡蛋。", reading: "Jīntiān méiyǒu jīdàn.", gloss: { en: "No eggs today." } });
  });
});

describe("bark roles cover everyone", () => {
  const spaces = L.spaceIds();

  it("every figure in the town and every interior has a role of its own (none falls back)", () => {
    const all = spaces.flatMap((s) => spaceFigures(L, s, book).map((f) => ({ space: s, ...f })));
    const unmapped = all.filter((f) => !f.mapped).map((f) => `${f.space} ${f.id} ${f.asset}`);
    expect(unmapped).toEqual([]);
    // what is there today: 7 walkers, the cat, the dog, the egg seller, the boatman, 3 pigeons outdoors; a diner, a tea drinker, the neighbour's dog inside
    const street = spaceFigures(L, "street", book);
    expect(street.filter((f) => f.kind === "walker").map((f) => f.role)).toEqual(["stroller", "shopper", "worker", "kid", "granny", "tourist", "courier"]);
    expect(street.filter((f) => f.kind === "extra").map((f) => f.role)).toEqual(["cat", "dog", "egg_seller", "boatman"]);
    expect(street.filter((f) => f.kind === "scatter").map((f) => f.role)).toEqual(["pigeon", "pigeon", "pigeon"]);
    expect(spaceFigures(L, "noodle_shop", book).map((f) => f.role)).toEqual(["diner"]);
    expect(spaceFigures(L, "tea_house", book).map((f) => f.role)).toEqual(["tea_guest"]);
    expect(spaceFigures(L, "stairs", book).map((f) => f.role)).toEqual(["dog"]);
    // at least 14 distinct roles in the book besides the story NPCs'
    const figureRoles = Object.keys(book.roles).filter((r) => !course.world.npcs[r]);
    expect(figureRoles.length).toBeGreaterThanOrEqual(14);
  });

  it("the extras and scatterers are counted as world.ts builds them (dressing characters in order)", () => {
    for (const s of spaces) {
      const sp = L.space(s);
      const chars = sp.dressing.filter((d) => {
        const e = L.asset(d.asset);
        return e.set === "characters" && ["human", "recolour", "pet"].includes(e.kind ?? "");
      });
      const figs = spaceFigures(L, s, book);
      expect(figs.filter((f) => f.kind === "walker").length).toBe(sp.walkers.length);
      expect(figs.filter((f) => f.kind !== "walker").map((f) => f.home)).toEqual(chars.map((d) => d.pos));
    }
  });

  it("every story NPC has lines for when there's nothing to talk about", () => {
    for (const npc of Object.keys(course.world.npcs)) expect(npcRole(book, npc), npc).toEqual({ role: npc, mapped: true });
  });

  it("every figure role has a short name in the chrome (English; bn / zh in locale/)", () => {
    const roles = new Set(spaces.flatMap((s) => spaceFigures(L, s, book).map((f) => f.role)));
    roles.add(FALLBACK_ROLE);
    for (const r of roles) expect(CHROME_KEYS, r).toContain(`role-${r}`);
    for (const ui of ["bn", "zh"]) for (const r of roles) expect(UI_LOCALES[ui].game?.[`role-${r}`], `${ui} role-${r}`).toBeTruthy();
  });
});

describe("bark lines", () => {
  // Every UI language the chrome has, but the course's own: the natives a learner of it reads meanings in.
  const natives = Object.keys(UI_LOCALES).filter((l) => l !== book.language);

  it("1-3 lines per role, each with text, a reading and a meaning in every native language", () => {
    expect(natives).toEqual(expect.arrayContaining(["en", "bn"]));
    for (const [role, r] of Object.entries(book.roles)) {
      expect(r.lines.length, role).toBeGreaterThanOrEqual(1);
      expect(r.lines.length, role).toBeLessThanOrEqual(3);
      for (const l of r.lines) {
        expect(l.text.trim(), role).not.toBe("");
        expect(l.reading?.trim(), `${role}: ${l.text}`).toBeTruthy();
        for (const n of natives) expect(l.gloss[n]?.trim(), `${role}: ${l.text} (${n})`).toBeTruthy();
      }
    }
  });

  it("every clip named is on disk in both formats", () => {
    const clips = Object.values(book.roles).flatMap((r) => r.lines.flatMap((l) => (l.clip ? [l.clip] : [])));
    for (const c of clips) for (const ext of ["ogg", "m4a"]) expect(existsSync(`${AUDIO}${book.language}/${c}.${ext}`), `${c}.${ext}`).toBe(true);
  });

  it("the course's words in a bark are tokens, so they're tappable", () => {
    const text = book.roles.egg_seller.lines[0].text;
    const tokens = barkTokens(course, text);
    expect(tokens.length).toBeGreaterThan(0);
    for (const tk of tokens) expect(course.words[tk.word].w).toBe(text.slice(tk.start, tk.end));
    // non-overlapping, in order
    for (let i = 1; i < tokens.length; i++) expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].end);
  });
});

describe("a bark in the game", () => {
  function setup() {
    const core = createCore(course, newGame(course), { now: () => 1_000_000, rng: () => 0.42 });
    const audio = fakeAudio();
    const barkAudio = fakeAudio();
    const game = createGame({ course, core, now: () => 1_000_000, audio, barks: new BarkPicker(book, seeded()), barkAudio });
    game.setName("Mina");
    return { game, core, audio, barkAudio };
  }

  it("shows the line with its reading and meaning, says its clip on the bark player, and changes nothing in core", () => {
    const { game, core, barkAudio, audio } = setup();
    const before = JSON.stringify(core.state);
    const line = book.roles.egg_seller.lines[0];
    game.bark({ id: "bark:extra:2", name: game.s("role-egg_seller"), role: "egg_seller" }, line);
    const m = game.model;
    expect(m.bark).toEqual({ id: "bark:extra:2", role: "egg_seller" });
    expect(m.bubble).toMatchObject({ npc: "bark:extra:2", npcName: "Egg seller", kind: "bark", reading: "Jīntiān méiyǒu jīdàn." });
    expect(m.bubble!.line).toMatchObject({ text: "今天没有鸡蛋。", meaning: "No eggs today.", audio: [BARK_CLIP + line.clip] });
    expect(m.reply).toEqual({ mode: "continue", label: "…" });
    expect(barkAudio.plays).toEqual([[{ clips: [line.clip] }]]);
    expect(audio.plays).toEqual([]);
    // a word tapped in it: its gloss, said, not logged as help
    const w = m.bubble!.line.tokens[0].word;
    expect(game.helpWord(w)?.gloss).toBe(course.words[w].gloss);
    // the whole sentence: the bark's own reading
    expect(game.sentence(m.bubble!.line)).toMatchObject({ reading: "Jīntiān méiyǒu jīdàn.", gloss: "No eggs today." });
    game.reply(0); // the "…"
    expect(m.bark).toBeNull();
    expect(m.bubble).toBeNull();
    expect(m.reply).toBeNull();
    expect(JSON.stringify(core.state)).toBe(before);
  });

  it("the meaning follows the chrome's language (bn)", () => {
    const core = createCore(course, newGame(course), { now: () => 1_000_000, rng: () => 0.42 });
    const game = createGame({ course, core, now: () => 1_000_000, barks: new BarkPicker(book, seeded()), ui: "bn" });
    game.setName("Mina");
    game.bark({ id: "bark:extra:0", name: game.s("role-cat"), role: "cat" }, book.roles.cat.lines[0]);
    expect(game.model.bubble!.line.meaning).toBe(book.roles.cat.lines[0].gloss.bn);
    expect(game.model.bubble!.npcName).toBe(UI_LOCALES.bn.game!["role-cat"]);
  });

  it("a one-off hint goes into the feed with the first bark; sound off keeps it silent", () => {
    const { game, barkAudio } = setup();
    game.bark({ id: "bark:walker:3", name: "Kid", role: "kid" }, book.roles.kid.lines[0], game.s("bark-hint", { native: "English" }));
    expect(game.model.feed.at(-1)?.text).toBe("Everyone here will talk to you. The hint chip shows what they said in English.");
    game.endBark();
    game.setSound(false);
    game.bark({ id: "bark:walker:3", name: "Kid", role: "kid" }, book.roles.kid.lines[1]);
    expect(barkAudio.plays.length).toBe(1);
  });

  it("a story NPC with nothing to talk about says a line of their own instead", () => {
    const { game, core } = setup();
    // someone with no scene for a new game where they stand (and none waiting for money)
    const free = (n: string) => {
      const place = course.world.npcs[n].place;
      return !course.scenes.some((x) => x.npc === n && x.place === place && (availableSceneIds(course, core.state).includes(x.id) || moneyBlocked(x, core.state)));
    };
    const npc = Object.keys(course.world.npcs).find(free);
    expect(npc, "an NPC with nothing to say on day 1").toBeTruthy();
    game.enterPlace(course.world.npcs[npc!].place);
    expect(core.state.place).toBe(course.world.npcs[npc!].place);
    const log = core.state.log.length;
    game.talkTo(npc!);
    expect(game.model.bark).toEqual({ id: npc, role: npc });
    expect(game.model.bubble).toMatchObject({ npc, npcName: game.npcName(npc!), kind: "bark" });
    expect(book.roles[npc!].lines.map((l) => l.text)).toContain(game.model.bubble!.line.text);
    expect(core.state.log.length).toBe(log);
  });

  it("the Go to list, or anything sent to core, ends a bark", () => {
    const { game } = setup();
    game.bark({ id: "bark:walker:0", name: "Stroller", role: "stroller" }, book.roles.stroller.lines[0]);
    game.travel();
    expect(game.model.bark).toBeNull();
    expect(game.model.choices).not.toBeNull();
    game.closeChoices();
    game.bark({ id: "bark:walker:0", name: "Stroller", role: "stroller" }, book.roles.stroller.lines[1]);
    game.sleep(); // rejected (not at home) or not: the bark is gone either way
    expect(game.model.bark).toBeNull();
    expect(game.model.reply).toBeNull();
  });
});

describe("talked-to figures stop and face the player", () => {
  it("a walker holds, faces the player, then walks on along its path", () => {
    const w = new WalkerMotion([
      [0, 0],
      [10, 0],
    ]);
    w.update(1, 50, 50);
    const x = w.x;
    w.held = true;
    expect(w.update(1, x, 5)).toBe(0);
    expect(w.x).toBe(x);
    expect(w.waiting).toBe(true);
    expect(w.yaw).toBeCloseTo(0); // facing +z, toward the player
    w.held = false;
    expect(w.update(1, 50, 50)).toBeGreaterThan(0);
    expect(w.x).toBeGreaterThan(x);
  });

  it("a pigeon held doesn't scatter", () => {
    const s = new ScatterMotion([0, 0]);
    s.held = true;
    expect(s.update(0.5, 0.5, 0)).toBe(0);
    expect(s.away).toBe(0);
    expect(s.yaw).toBeCloseTo(Math.PI / 2);
  });
});
