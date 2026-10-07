import { fileURLToPath } from "node:url";
import { createCore, mulberry32, newGame, type GameState } from "@silver-tongue/core";
import { deskPapers, paperSyllables, readsSyllable, romanize } from "@silver-tongue/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCourse } from "../../../tools/src/build-course";
import { emptyOpeningChoices, openingInput, openingRound, openingEffects, openingProfile, parseOpeningChoices, prepareDoorCourse, type OpeningChoices, type OpeningOption } from "../src/door-choices";
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
const scenes = ["room-wake", "street-hello", "stall-lead", "street-introductions"];
const opening = scenes.slice(0, 3);
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
    expect(sites).toHaveLength(36);
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

  it("walks every permutation through door → Park → stall; each completes and shows text no other path shows", () => {
    const steps = opening.flatMap((scene) => course.scenes.find((s) => s.id === scene)!.exchanges.map((ex) => ({ scene, key: `${scene}:${ex.id}`, options: Object.keys(OPENING_CHOICES[`${scene}:${ex.id}`]) as OpeningOption[] })));
    const permutations = steps.reduce<OpeningOption[][]>((paths, step) => paths.flatMap((path) => step.options.map((option) => [...path, option])), [[]]);
    expect(permutations).toHaveLength(1944);
    const hello = steps.findIndex((step) => step.key === "street-hello:hello");
    const variants = permutations.flatMap((path) => path[hello] === "reply" ? [{ path, decode: false }, { path, decode: true }] : [{ path, decode: false }]);
    expect(variants).toHaveLength(2916);
    const signatures = new Set<string>();
    for (const { path, decode } of variants) {
      const { q } = start("room-wake");
      const downstream: string[] = [];
      let at = 0;
      for (const scene of opening) {
        if (scene !== "room-wake") {
          if (scene === "stall-lead" && decode) q.readPaper("stall-card");
          const destination = course.scenes.find((s) => s.id === scene)!.place;
          clock += 1000;
          let phase = q.view().phase;
          if (phase.kind !== "explore") throw new Error("Scene did not end");
          q.choose(phase.menu.findIndex((m) => m.kind === "go" && m.place === destination));
          clock += 1000;
          phase = q.view().phase;
          if (phase.kind !== "explore") throw new Error("Travel did not complete");
          q.choose(phase.menu.findIndex((m) => m.kind === "talk" && m.scene === scene));
          if (scene === "stall-lead") {
            const greeted = q.openingChoices()!.options["street-hello:hello"];
            const branch = greeted === "reply" ? (decode ? "card-read" : "card-unread") : "pointed";
            const arrival = q.t(`scene-stall-lead-${branch}`);
            expect(texts(q)).toContain(arrival);
            downstream.push(arrival);
          }
        }
        const sceneSteps = steps.filter((step) => step.scene === scene);
        for (const step of sceneSteps) {
          const option = path[at++];
          choose(q, option);
          const reaction = q.t(OPENING_CHOICES[step.key][option]!.reaction);
          expect(texts(q)).toContain(reaction);
          downstream.push(reaction);
        }
        expect(q.core.state.run).toBeNull();
        expect(q.core.state.scenesDone[scene]).toBe(1);
      }
      expect(Object.keys(q.openingChoices()!.options)).toHaveLength(8);
      signatures.add(downstream.join("\n"));
    }
    expect(signatures.size).toBe(variants.length);
  }, 120_000);
});

describe("a choice a later scene remembers", () => {
  it.each(["reply", "alt1", "silence"] as const)("who/%s: room-rent explains how the landlady has your name only if you never told her", (option) => {
    const store = memory();
    const { q } = start("room-wake", 0, true, store);
    for (const step of ["reply", "reply", option, "reply"] as const) choose(q, step);
    expect(q.core.state.run).toBeNull();
    // Skip the days between: every scene before room-rent done, home, a fresh day.
    const before = ["room-wake", "street-hello", "stall-lead", "street-introductions", "street-again", "street-what", "street-hungry", "shop-prices", "street-numbers", "shop-count", "stall-intro", "stall-shift", "stall-family"];
    const state: GameState = { ...structuredClone(q.core.state), place: "room", slot: 0, scenesDone: Object.fromEntries(before.map((id) => [id, 1])) };
    const later = createQuiet({ course, core: createCore(course, state, { now, rng: mulberry32(3) }), now, lab: true, openingChoice: store });
    clock += 1000;
    const phase = later.view().phase;
    if (phase.kind !== "explore") throw new Error(`Expected the room, got ${phase.kind}`);
    later.choose(phase.menu.findIndex((m) => m.kind === "talk" && m.scene === "room-rent"));
    const shown = texts(later);
    const named = later.t("door-room-wake-who-named-later");
    const greeting = shown.findIndex((text) => text.startsWith("Alex 씨"));
    expect(greeting).toBeGreaterThan(-1);
    if (option === "reply") expect(shown).not.toContain(named);
    else expect(shown.indexOf(named)).toBeGreaterThan(-1), expect(shown.indexOf(named)).toBeLessThan(greeting);
  });
});

describe("the old man's card", () => {
  it.each(["reply", "silence"] as const)("greeting %s survives reload and changes the stall welcome", (option) => {
    const { q, store } = start("street-hello");
    choose(q, option); choose(q, "reply");
    const reward = q.bookPapers().find((p) => p.id === "stall-card");
    expect(!!reward).toBe(option === "reply");
    if (option === "reply") {
      expect(reward?.lines[0].text).toBe("지우네");
      const syllables = paperSyllables(reward!);
      expect(syllables.map((s) => s.ch)).toEqual(["지", "우", "네"]);
      for (const syllable of syllables) expect(readsSyllable(romanize(syllable.ch), syllable.ch)).toBe(true);
      q.setDeskAt(reward!.id, syllables.length);
      q.readPaper(reward!.id);
      expect(store.load().cardRead).toBe(true);
    }
    const stall = start("stall-lead", 0, true, store).q;
    // start() resumes a run; start it through Quiet to exercise the visible arrival branch.
    const state = { ...stall.core.state, run: null, slot: 0 };
    const visit = createQuiet({ course, core: createCore(course, state, { now, rng: mulberry32(3) }), now, lab: true, openingChoice: store });
    expect(!!notebookDocuments(visit, clock).desk.find((p) => p.id === "stall-card")).toBe(option === "reply");
    expect(visit.placeLabel("stall")).toBe(option === "reply" ? visit.t("place-stall-known") : visit.t("place-stall"));
    clock += 1000;
    const menu = visit.view().phase;
    if (menu.kind !== "explore") throw new Error("No stall menu");
    visit.choose(menu.menu.findIndex((m) => m.kind === "talk" && m.scene === "stall-lead"));
    expect(texts(visit)).toContain(visit.t(`scene-stall-lead-${option === "reply" ? "card-read" : "pointed"}`));
  });
  it("keeps partial card decoding per game across reload instead of inheriting another game’s desk position", () => {
    const store = memory();
    store.save({ ...emptyOpeningChoices(), options: { "street-hello:hello": "reply" } });
    const { q } = start("stall-lead", 0, true, store);
    q.setDeskAt("stall-card", 1);
    const reload = createQuiet({ course, core: createCore(course, q.core.state, { now, rng: mulberry32(1) }), now, lab: true, openingChoice: store, papers: { load: () => ["stall-card"], save: () => {}, loadProgress: () => ({ at: { "stall-card": 3 }, met: [] }) } });
    expect(reload.deskAt("stall-card")).toBe(1);
    expect(reload.readPapers().has("stall-card")).toBe(false);
    expect(reload.openingChoices()?.cardRead).toBe(false);
    expect(start("stall-lead").q.bookPapers().some((p) => p.reward)).toBe(false);
  });
  it("plays content-declared clips for both the immediate reaction and the arrival without word lookup", () => {
    const changed = structuredClone(course);
    const profile = openingProfile(changed)!;
    const effect = profile.choices[profile.arrival.choice].reply!;
    effect.audio = ["declared-key-a", "declared-key-b"];
    profile.arrival.branches.reply!.audio = ["declared-arrival"];
    const { q: seed } = start("street-hello");
    const store = memory();
    const play = vi.fn();
    const audio = { available: true, play, stop: () => {} };
    const q = createQuiet({ course: changed, core: createCore(changed, seed.core.state, { now, rng: mulberry32(1) }), now, lab: true, audio, openingChoice: store });
    choose(q, "reply");
    expect(play.mock.calls.flatMap(([speeches]) => speeches).some((speech) => JSON.stringify(speech.clips) === JSON.stringify(effect.audio))).toBe(true);
    choose(q, "reply");
    const arrivalScene = changed.scenes.find((scene) => scene.id === profile.arrival.scene)!;
    const state = { ...q.core.state, run: null, slot: 0, place: arrivalScene.place, scenesDone: { ...q.core.state.scenesDone, ...Object.fromEntries((arrivalScene.after ?? []).map((id) => [id, 1])) } };
    const visit = createQuiet({ course: changed, core: createCore(changed, state, { now, rng: mulberry32(1) }), now, lab: true, audio, openingChoice: store });
    clock += 1000;
    const phase = visit.view().phase;
    if (phase.kind !== "explore") throw new Error("No arrival menu");
    visit.choose(phase.menu.findIndex((item) => item.kind === "talk" && item.scene === profile.arrival.scene));
    expect(play.mock.calls.flatMap(([speeches]) => speeches).some((speech) => JSON.stringify(speech.clips) === JSON.stringify(["declared-arrival"]))).toBe(true);
  });
  it("decoding at the stall has an immediate recognition payoff", () => {
    const store = memory();
    store.save({ options: { "street-hello:hello": "reply" }, cardAt: 0, cardRead: false });
    const { q } = start("stall-lead", 0, true, store);
    expect(q.deskAt("stall-card")).toBe(0);
    q.readPaper("stall-card");
    expect(texts(q)).toContain(q.t("scene-stall-lead-decoded"));
    expect(q.placeLabel("stall")).toBe(q.t("place-stall-known"));
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
    // Accepting a wrong reply in the lab keeps the NPC's authored answer: refusing the rent still gets "방세!" again.
    const rent = Object.values(course.scenes.find((s) => s.id === "room-wake")!.exchanges.find((e) => e.id === "rent")!.variants)[0];
    expect(rent.altOutcomes?.[0]?.reaction?.text).toBe("방세!");
  });
  it("never reads, clears, or writes opening choices on the non-lab page, and never earns a card", () => {
    const store = { load: vi.fn(() => ({ options: { "street-hello:hello": "reply" as const }, cardAt: 0, cardRead: true })), save: vi.fn() };
    const naming = createQuiet({ course: built, core: createCore(built, newGame(built), { now, rng: mulberry32(1) }), now, lab: false, openingChoice: store });
    naming.setName("Alex");
    const { q } = start("room-wake", 0, false, store);
    for (const text of ["아니요.", "몰라요.", "몰라요.", "네."]) {
      clock += 1000;
      const phase = q.view().phase;
      if (phase.kind !== "pick") throw new Error("Expected core pick");
      q.choose(phase.options.findIndex((o) => o.text === text));
    }
    expect(q.openingChoices()).toBeUndefined();
    expect(q.bookPapers().some((p) => p.reward)).toBe(false);
    expect(texts(q).some((t) => /stall card|지우네|지우 씨/.test(t))).toBe(false);
    const reload = createQuiet({ course: built, core: createCore(built, q.core.state, { now, rng: mulberry32(1) }), now, lab: false, openingChoice: store });
    expect(reload.openingChoices()).toBeUndefined();
    expect(reload.bookPapers().some((p) => p.reward)).toBe(false);
    const stallState = { ...q.core.state, run: null, slot: 0, place: "stall", scenesDone: { "room-wake": 1, "street-hello": 1 } };
    const visit = () => {
      const stall = createQuiet({ course: built, core: createCore(built, stallState, { now, rng: mulberry32(1) }), now, lab: false, openingChoice: store });
      const phase = stall.view().phase;
      if (phase.kind !== "explore") throw new Error("No non-lab stall menu");
      clock += 1000;
      stall.choose(phase.menu.findIndex((m) => m.kind === "talk" && m.scene === "stall-lead"));
      expect(texts(stall)).toContain(stall.t("scene-stall-lead-start"));
      expect(stall.bookPapers().some((paper) => paper.reward)).toBe(false);
      return texts(stall);
    };
    expect(visit()).toEqual(visit());
    expect(store.load).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
    // The reward never appears on the opening desk, on either page.
    expect(deskPapers(course).some((p) => p.reward)).toBe(false);
  });
  it("persists all decisions and decoded progress inside the experiment prefix, isolated by game", () => {
    const data = new Map<string, string>();
    const kv: KeyValue = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k), keys: () => [...data.keys()] };
    installPageStorage(labKeyValue(kv, DOOR_LAB_PREFIX));
    const choices: OpeningChoices = { options: Object.fromEntries(Object.keys(OPENING_CHOICES).map((key) => [key, "reply"])), cardAt: 0, cardRead: true };
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
    const ask = Object.values(tied.scenes.find((s) => s.id === "street-introductions")!.exchanges[1].variants)[0];
    ask.alts![0] = { ...ask.alts![0], text: ask.reply.text, tokens: structuredClone(ask.reply.tokens) };
    const { q } = start("street-introductions", 1);
    const state = structuredClone(q.core.state);
    state.player = "민준";
    state.run!.mode = "type";
    const game = createQuiet({ course: tied, core: createCore(tied, state, { now, rng: mulberry32(1) }), now, lab: true });
    game.sendText("저는 민준입니다.");
    expect(game.core.state.run?.exchange).toBe(1);
    expect(game.openingChoices()?.options["street-introductions:ask"]).toBeUndefined();
    const phase = game.view().phase;
    expect(phase).toMatchObject({ kind: "pick", options: expect.any(Array) });
    if (phase.kind !== "pick") throw new Error("No tied slips");
    expect(phase.options).toHaveLength(2);
    expect(texts(game)).toContain(game.t("quiet-scribe-choose"));
    clock += 1000;
    game.choose(1);
    expect(game.openingChoices()?.options["street-introductions:ask"]).toBe("alt1");
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
