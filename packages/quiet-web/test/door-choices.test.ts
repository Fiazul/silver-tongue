import { fileURLToPath } from "node:url";
import { createCore, mulberry32, newGame, type GameState } from "@silver-tongue/core";
import { deskPapers, paperSyllables, readsSyllable, romanize } from "@silver-tongue/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCourse } from "../../../tools/src/build-course";
import { cardLabel, emptyOpeningChoices, openingInput, openingRound, openingEffects, openingProfile, parseOpeningChoices, prepareDoorCourse, type OpeningChoices, type OpeningOption } from "../src/door-choices";
import { stageDirections, stageView } from "../src/stage";
import { createQuiet, type Quiet } from "../src/quiet";
import { notebookDocuments } from "../src/notebook";
import { openingStore } from "../src/scribe";
import { DOOR_LAB_PREFIX, installPageStorage } from "../src/storage";
import { labKeyValue, type KeyValue } from "@silver-tongue/web-common";

const checked = buildCourse(fileURLToPath(new URL("../../../content", import.meta.url)), "ko-seoul");
const built = checked.course!;
const course = prepareDoorCourse(built, true);
const OPENING_CHOICES = openingEffects(course);
const scenes = ["room-wake", "room-minjun", "street-introductions"];
let clock = 0;
const now = () => clock;
function memory() {
  let record = emptyOpeningChoices();
  return { load: () => structuredClone(record), save: (v: OpeningChoices) => { record = structuredClone(v); } };
}
function start(scene: string, exchange = 0, lab = true, store = memory()) {
  const c = lab ? course : built;
  const state: GameState = { ...newGame(c), player: "Alex", place: c.scenes.find((s) => s.id === scene)!.place, scenesDone: Object.fromEntries(scenes.slice(0, scenes.indexOf(scene)).map((id) => [id, 1])) };
  const core = createCore(c, state, { now, rng: mulberry32(1) });
  core.send({ type: "startScene", scene });
  for (let i = 0; i < exchange; i++) core.send(openingInput(c, core.state, "reply"));
  const q = createQuiet({ course: c, core, now, lab, openingChoice: store });
  return { q, store };
}
function texts(q: Quiet): string[] { return q.view().backlog.flatMap((b) => b.text ? [b.text] : b.line ? [b.line.text] : []); }
function choose(q: Quiet, option: OpeningOption) {
  clock += 1000;
  const phase = q.view().phase;
  if (phase.kind !== "pick") throw new Error(`Expected lab slips, got ${phase.kind}`);
  q.choose(option === "silence" ? phase.options.length : option === "reply" ? 0 : Number(option.slice(3)));
}
function complete(q: Quiet) { while (q.core.state.run) choose(q, "reply"); }

describe("every opening action has an effect", () => {
  const sites = course.scenes.filter((s) => scenes.includes(s.id)).flatMap((s) => s.exchanges.flatMap((ex, index) => {
    const v = Object.values(ex.variants)[0];
    return ["reply", ...(v.alts ?? []).map((_, i) => `alt${i + 1}`), "silence"].map((option) => ({ scene: s.id, index, key: `${s.id}:${ex.id}`, option: option as OpeningOption }));
  }));
  it("keeps every content/word-chain and audio checker green", () => {
    expect(checked.errors).toEqual([]);
  });
  it("enumerates the complete map with no stale exchanges or unhandled options", () => {
    expect(sites).toHaveLength(38);
    expect(sites.map((s) => `${s.key}/${s.option}`).sort()).toEqual(Object.entries(OPENING_CHOICES).flatMap(([key, opts]) => Object.keys(opts).map((opt) => `${key}/${opt}`)).sort());
    for (const [key, opts] of Object.entries(OPENING_CHOICES)) {
      expect(new Set(Object.values(opts).map((e) => e!.reaction)).size, key).toBe(Object.keys(opts).length);
    }
  });
  it.each(sites)("$key/$option reacts, advances, persists, and any later line shows", ({ scene, index, key, option }) => {
    const { q, store } = start(scene, index);
    const effect = OPENING_CHOICES[key][option]!;
    expect(q.t.has(effect.reaction)).toBe(true);
    if (effect.consequence) expect(q.t.has(effect.consequence)).toBe(true);
    choose(q, option);
    expect(texts(q)).toContain(q.t(effect.reaction));
    const stage = stageView(q.view().backlog, q.view().stageFrom);
    const displayed = [...stage.history.map((row) => row.beat), ...stage.direction, ...stage.exchanges.flatMap(stageDirections)];
    expect(displayed.some((beat) => beat.text === q.t(effect.reaction))).toBe(true);
    expect(q.core.state.run?.exchange ?? Infinity).toBeGreaterThan(index);
    expect(store.load().options[key]).toBe(option);
    // Resume the actual core state and durable choice before testing the later callback.
    const reloaded = createQuiet({ course, core: createCore(course, q.core.state, { now, rng: mulberry32(2) }), now, lab: true, openingChoice: store });
    expect(reloaded.openingChoices()?.options[key]).toBe(option);
    // A final choice has already ended the scene; otherwise the callback is emitted after reload.
    complete(reloaded);
    const visible = [...texts(q), ...texts(reloaded)];
    // A consequence belongs to a later scene: never said in the scene of the choice.
    if (effect.consequence) expect(visible).not.toContain(q.t(effect.consequence));
    expect(q.core.state.scenesDone[scene] || reloaded.core.state.scenesDone[scene]).toBe(1);
  });

  it("walks 400 sampled paths through door → Min-jun → Park; each completes and shows text no other path shows", () => {
    const steps = scenes.flatMap((scene) => course.scenes.find((s) => s.id === scene)!.exchanges.map((ex) => ({ scene, key: `${scene}:${ex.id}`, options: Object.keys(OPENING_CHOICES[`${scene}:${ex.id}`]) as OpeningOption[] })));
    expect(steps.reduce((n, step) => n * step.options.length, 1)).toBe(2 * 3 ** 12);
    const rng = mulberry32(7);
    // Every option of every line is on at least one path; the rest are drawn at random.
    const paths = steps.flatMap((step, i) => step.options.map((option) => steps.map((s, j) => (j === i ? option : s.options[Math.floor(rng() * s.options.length)]))));
    while (paths.length < 400) paths.push(steps.map((s) => s.options[Math.floor(rng() * s.options.length)]));
    const signatures = new Map<string, string>();
    for (const path of paths) {
      const { q } = start("room-wake");
      const downstream: string[] = [];
      let at = 0;
      for (const scene of scenes) {
        if (scene !== "room-wake") {
          const destination = course.scenes.find((s) => s.id === scene)!.place;
          clock += 1000;
          let phase = q.view().phase;
          if (phase.kind !== "explore") throw new Error("Scene did not end");
          const go = phase.menu.findIndex((m) => m.kind === "go" && m.place === destination);
          if (go >= 0) {
            q.choose(go);
            clock += 1000;
            phase = q.view().phase;
            if (phase.kind !== "explore") throw new Error("Travel did not complete");
          }
          q.choose(phase.menu.findIndex((m) => m.kind === "talk" && m.scene === scene));
        }
        for (const step of steps.filter((step) => step.scene === scene)) {
          const option = path[at++];
          choose(q, option);
          const reaction = q.t(OPENING_CHOICES[step.key][option]!.reaction);
          expect(texts(q)).toContain(reaction);
          downstream.push(reaction);
        }
        expect(q.core.state.run).toBeNull();
        expect(q.core.state.scenesDone[scene]).toBe(1);
      }
      expect(Object.keys(q.openingChoices()!.options)).toHaveLength(steps.length);
      signatures.set(path.join(","), downstream.join("\n"));
    }
    expect(new Set(signatures.values()).size).toBe(signatures.size);
  }, 120_000);
});

describe("a choice a later scene remembers", () => {
  it.each(["reply", "alt1", "silence"] as const)("Min-jun's who/%s: room-rent says how the landlady has your name", (option) => {
    const store = memory();
    const { q } = start("room-minjun", 0, true, store);
    choose(q, option);
    complete(q);
    expect(q.core.state.run).toBeNull();
    // Skip the days between: every scene before room-rent done, home, a fresh day.
    const before = ["room-wake", "room-minjun", "street-introductions", "street-again", "street-what", "street-hungry", "shop-prices", "street-numbers", "shop-count", "stall-intro", "stall-shift", "stall-family"];
    const state: GameState = { ...structuredClone(q.core.state), place: "room", slot: 0, scenesDone: Object.fromEntries(before.map((id) => [id, 1])) };
    const later = createQuiet({ course, core: createCore(course, state, { now, rng: mulberry32(3) }), now, lab: true, openingChoice: store });
    clock += 1000;
    const phase = later.view().phase;
    if (phase.kind !== "explore") throw new Error(`Expected the room, got ${phase.kind}`);
    later.choose(phase.menu.findIndex((m) => m.kind === "talk" && m.scene === "room-rent"));
    const shown = texts(later);
    const line = later.t(option === "reply" ? "door-room-minjun-who-named-later" : "door-room-minjun-who-unnamed-later");
    const other = later.t(option === "reply" ? "door-room-minjun-who-unnamed-later" : "door-room-minjun-who-named-later");
    const greeting = shown.findIndex((text) => text.startsWith("Alex 씨"));
    expect(greeting).toBeGreaterThan(-1);
    expect(shown.indexOf(line)).toBeGreaterThan(-1);
    expect(shown.indexOf(line)).toBeLessThan(greeting);
    expect(shown).not.toContain(other);
  });
});

describe("the landlady's words", () => {
  it.each(["reply", "alt1", "silence"] as const)("why/%s: understood only by saying them to Min-jun, and kept across reload", (option) => {
    const store = memory();
    const { q } = start("room-minjun", 3, true, store);
    expect(q.t(cardLabel(course, q.openingChoices(), "message")!)).toBe(q.t("card-message"));
    choose(q, option);
    const reloaded = createQuiet({ course, core: createCore(course, q.core.state, { now, rng: mulberry32(2) }), now, lab: true, openingChoice: store });
    const label = q.t(cardLabel(course, reloaded.openingChoices(), "message")!);
    expect(label).toBe(q.t(option === "reply" ? "card-message-learned" : "card-message"));
    expect(label.includes("Pay the rent")).toBe(option === "reply");
  });
  it("is never the right card for its own line: you remember it, you don't work it out from it", () => {
    for (const d of Object.values(openingProfile(course)!.deduce!)) expect(d.right).not.toBe("message");
  });
  it("plays content-declared clips for a reaction without word lookup", () => {
    const changed = structuredClone(course);
    const effect = openingProfile(changed)!.choices["room-minjun:why"].reply!;
    effect.audio = ["declared-key-a", "declared-key-b"];
    const { q: seed } = start("room-minjun", 3);
    const play = vi.fn();
    const audio = { available: true, play, stop: () => {} };
    const q = createQuiet({ course: changed, core: createCore(changed, seed.core.state, { now, rng: mulberry32(1) }), now, lab: true, audio, openingChoice: memory() });
    choose(q, "reply");
    expect(play.mock.calls.flatMap(([speeches]) => speeches).some((speech) => JSON.stringify(speech.clips) === JSON.stringify(effect.audio))).toBe(true);
  });
});

describe("the desk at a glance", () => {
  it("each paper is seen in full with nothing typed; the knock comes and the door opens on the landlady", () => {
    const fresh = createQuiet({ course, core: createCore(course, newGame(course), { now, rng: mulberry32(1) }), now, lab: true, openingChoice: memory() });
    fresh.setName("Alex");
    for (const p of deskPapers(course).filter((p) => p.required?.length !== 0)) {
      fresh.glancePaper(p.id);
      expect(fresh.readPapers().has(p.id), p.id).toBe(true);
      expect(fresh.deskAt(p.id), p.id).toBe(paperSyllables(p).length);
    }
    fresh.leaveDesk();
    expect(fresh.core.state.run?.scene).toBe("room-wake");
    // Words seen on the desk are the ones the door's clues name.
    expect(fresh.t(cardLabel(course, fresh.openingChoices(), "id")!)).toContain("김민준");
    expect(fresh.t(cardLabel(course, fresh.openingChoices(), "bill")!)).toContain("방세");
  });
});

describe("experiment boundary and durable choice format", () => {
  afterEach(() => installPageStorage(undefined as never));
  it("uses native accepted alts only in a lab course without mutating the main course", () => {
    expect(prepareDoorCourse(built, false)).toBe(built);
    for (const scene of course.scenes.filter((s) => scenes.includes(s.id))) for (const ex of scene.exchanges) for (const v of Object.values(ex.variants)) {
      for (const [i] of (v.alts ?? []).entries()) expect(v.altOutcomes?.[i].accept).toBe(true);
    }
    expect(built.scenes.find((s) => s.id === "room-wake")!.exchanges[0].variants[""].altOutcomes?.[0]?.accept).not.toBe(true);
    // Accepting a wrong reply in the lab keeps the NPC's authored answer: refusing her message gets it said again.
    const message = Object.values(course.scenes.find((s) => s.id === "room-wake")!.exchanges.find((e) => e.id === "message")!.variants)[0];
    expect(message.altOutcomes?.[0]?.reaction?.text).toBe("방세 내세요!");
  });
  it("never reads, clears, or writes opening choices on the non-lab page, and never earns a card", () => {
    const store = { load: vi.fn(() => ({ options: { "room-minjun:why": "reply" as const }, cardAt: 0, cardRead: true })), save: vi.fn() };
    const naming = createQuiet({ course: built, core: createCore(built, newGame(built), { now, rng: mulberry32(1) }), now, lab: false, openingChoice: store });
    naming.setName("Alex");
    const { q } = start("room-wake", 0, false, store);
    for (const text of ["아니요.", "네.", "안녕히 가세요."]) {
      clock += 1000;
      const phase = q.view().phase;
      if (phase.kind !== "pick") throw new Error("Expected core pick");
      q.choose(phase.options.findIndex((o) => o.text === text));
    }
    expect(q.openingChoices()).toBeUndefined();
    expect(q.bookPapers().some((p) => p.reward)).toBe(false);
    expect(texts(q).some((t) => t === q.t("door-room-wake-call-reply-reaction"))).toBe(false);
    const reload = createQuiet({ course: built, core: createCore(built, q.core.state, { now, rng: mulberry32(1) }), now, lab: false, openingChoice: store });
    expect(reload.openingChoices()).toBeUndefined();
    expect(reload.bookPapers().some((p) => p.reward)).toBe(false);
    expect(store.load).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
    // The reward never appears on the opening desk, on either page.
    expect(deskPapers(course).some((p) => p.reward)).toBe(false);
  });
  it("persists all decisions and decoded progress inside the experiment prefix, isolated by game", () => {
    const data = new Map<string, string>();
    const kv: KeyValue = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k), keys: () => [...data.keys()] };
    installPageStorage(labKeyValue(kv, DOOR_LAB_PREFIX));
    const choices: OpeningChoices = { options: Object.fromEntries(Object.keys(OPENING_CHOICES).map((key) => [key, "reply"])), cardAt: 0, cardRead: false };
    openingStore(course, "one").save(choices);
    expect(openingStore(course, "one").load()).toEqual(choices);
    expect(openingStore(course, "two").load()).toEqual(emptyOpeningChoices());
    expect([...data.keys()].every((k) => k.startsWith(DOOR_LAB_PREFIX))).toBe(true);
    expect(parseOpeningChoices(true, course)).toEqual(emptyOpeningChoices());
    expect(parseOpeningChoices({ options: { "removed:exchange": "reply", "room-wake:call": "alt99" }, cardAt: 0, cardRead: true }, course)).toEqual(emptyOpeningChoices());
  });
  it("an exact Korean replyText in a saved type run records the selected slip rather than silence", () => {
    const { q } = start("street-introductions", 2);
    const state = structuredClone(q.core.state);
    state.run!.mode = "type";
    const game = createQuiet({ course, core: createCore(course, state, { now, rng: mulberry32(1) }), now, lab: true });
    game.sendText("아니요.");
    expect(game.openingChoices()?.options["street-introductions:sit"]).toBe("alt1");
    expect(game.core.state.run?.exchange).toBe(3);
  });
  it("keeps equally matching typed slips tied until explicitly chosen", () => {
    // Content has no tie today, so make one: the wrong reply duplicates the right one.
    const tied = structuredClone(course);
    const friend = Object.values(tied.scenes.find((s) => s.id === "street-introductions")!.exchanges[1].variants)[0];
    friend.alts![0] = { ...friend.alts![0], text: friend.reply.text, tokens: structuredClone(friend.reply.tokens) };
    const { q } = start("street-introductions", 1);
    const state = structuredClone(q.core.state);
    state.run!.mode = "type";
    const game = createQuiet({ course: tied, core: createCore(tied, state, { now, rng: mulberry32(1) }), now, lab: true });
    game.sendText("네, 친구예요.");
    expect(game.core.state.run?.exchange).toBe(1);
    expect(game.openingChoices()?.options["street-introductions:friend"]).toBeUndefined();
    const phase = game.view().phase;
    expect(phase).toMatchObject({ kind: "pick", options: expect.any(Array) });
    if (phase.kind !== "pick") throw new Error("No tied slips");
    expect(phase.options).toHaveLength(2);
    expect(texts(game)).toContain(game.t("quiet-scribe-choose"));
    clock += 1000;
    game.choose(1);
    expect(game.openingChoices()?.options["street-introductions:friend"]).toBe("alt1");
    expect(game.core.state.run?.exchange).toBe(2);
  });
  it.each(["pick", "tiles", "type"] as const)("silence and every slip advance when core mode is %s", (mode) => {
    for (const option of ["reply", "alt1", "silence"] as const) {
      const { q } = start("street-introductions");
      const run = q.core.state.run!;
      const v = openingRound(course, q.core.state)!.variant;
      // Supply a valid saved run for each core exercise mode.
      const state = structuredClone(q.core.state);
      state.run!.mode = mode;
      state.run!.tiles = v.reply.tokens.map((t) => v.reply.text.slice(t.start, t.end));
      const game = createQuiet({ course, core: createCore(course, state, { now, rng: mulberry32(1) }), now, lab: true });
      choose(game, option);
      expect(game.core.state.run?.exchange).toBe(run.exchange + 1);
      expect(game.openingChoices()?.options["street-introductions:park"]).toBe(option);
    }
  });
});
