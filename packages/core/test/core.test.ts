import { describe, expect, it } from "vitest";
import { comboKey } from "../src/combo";
import { describeRun, joinTiles, tilePieces } from "../src/dialogue";
import { createCore, LOG_LIMIT, newGame, type Core } from "../src/core";
import { recordRight } from "../src/learner";
import { mulberry32 } from "../src/rng";
import { addErrand, fixtureCourse, line, spacedCourse } from "../src/testing/fixture";
import { availableSceneIds, moneyBlocked, payFor, sceneCost } from "../src/life";
import type { GameEvent, WordRecord } from "../src/types";

const T0 = 1_000_000;
const course = fixtureCourse();

const setup = (seed = 1): Core => createCore(course, newGame(course), { now: () => T0, rng: mulberry32(seed) });
const types = (ev: GameEvent[]) => ev.map((e) => e.type);
const find = <K extends GameEvent["type"]>(ev: GameEvent[], type: K) =>
  ev.find((e) => e.type === type) as Extract<GameEvent, { type: K }>;

/** Index of the right option in the current pick. */
const rightChoice = (core: Core) => core.state.run!.options.indexOf(comboKey(core.state.run!.combo));
const answerRight = (core: Core) => core.send({ type: "reply", choice: rightChoice(core) });

function playIntro(core: Core) {
  core.send({ type: "goTo", place: "noodle_shop" });
  core.send({ type: "startScene", scene: "intro" });
  answerRight(core);
  return answerRight(core);
}

describe("core", () => {
  it("turns sound off and on, even mid-scene, without using a slot", () => {
    const core = setup();
    core.send({ type: "goTo", place: "noodle_shop" });
    core.send({ type: "startScene", scene: "intro" });
    const slot = core.state.slot;
    expect(core.send({ type: "setSound", on: false })).toEqual([{ type: "soundSet", on: false }]);
    expect(core.state.sound).toBe(false);
    expect(core.state.slot).toBe(slot);
    expect(core.state.run).not.toBeNull();
    core.send({ type: "setSound", on: true });
    expect(core.state.sound).toBe(true);
  });

  it("keeps the sound setting out of the play log, so older versions can still load the save", () => {
    const core = setup();
    core.send({ type: "goTo", place: "noodle_shop" });
    const log = core.state.log;
    core.send({ type: "setSound", on: false });
    expect(core.state.log).toEqual(log);
  });

  it("moves between linked places only", () => {
    const core = setup();
    expect(core.send({ type: "goTo", place: "nowhere" })).toEqual([{ type: "inputRejected", reason: "not-linked" }]);
    expect(core.send({ type: "goTo", place: "noodle_shop" })).toEqual([{ type: "placeEntered", place: "noodle_shop" }]);
    expect(core.state.place).toBe("noodle_shop");
  });

  it("a rejected input leaves the state untouched", () => {
    const core = setup();
    const before = core.state;
    core.send({ type: "startScene", scene: "intro" });
    expect(core.state).toBe(before);
  });

  it("plays the intro: line, options, next exchange, then trust and an unlock", () => {
    const core = setup();
    core.send({ type: "goTo", place: "noodle_shop" });
    const start = core.send({ type: "startScene", scene: "intro" });
    expect(types(start)).toEqual(["sceneStarted", "lineSpoken", "wordStateChanged", "wordStateChanged", "replyOptions"]);
    expect(find(start, "replyOptions")).toMatchObject({ mode: "pick" });
    expect(core.state.slot).toBe(1);

    const next = answerRight(core);
    expect(types(next)).toEqual(["actionPerformed", "lineSpoken", "wordStateChanged", "replyOptions"]);

    const end = answerRight(core);
    expect(types(end)).toEqual(["actionPerformed", "sceneEnded", "trustChanged", "unlocked"]);
    expect(find(end, "trustChanged")).toEqual({ type: "trustChanged", npc: "cook", trust: 2 });
    expect(find(end, "unlocked")).toEqual({ type: "unlocked", scene: "shift" });
    expect(core.state.run).toBeNull();
  });

  it("startScene's pick pins the first exchange's slot values; a slot or value it can't take is ignored", () => {
    for (const item of ["tea", "water"]) for (const count of ["three", "four"]) for (const seed of [1, 2, 3]) {
      const core = setup(seed);
      playIntro(core);
      const ev = core.send({ type: "startScene", scene: "shift", pick: { item, count } });
      expect(find(ev, "sceneStarted")).toEqual({ type: "sceneStarted", scene: "shift", npc: "cook" });
      expect(core.state.run!.combo).toEqual({ item, count });
      // the pinned combination plays as any other: its right reply is accepted
      expect(find(answerRight(core), "actionPerformed").matched).toBe(true);
    }
    // only item pinned: count is core's own choice
    const one = setup();
    playIntro(one);
    one.send({ type: "startScene", scene: "shift", pick: { item: "water" } });
    expect(one.state.run!.combo.item).toBe("water");
    expect(["three", "four"]).toContain(one.state.run!.combo.count);
    // a value the group lacks and a slot the exchange lacks: the same start as without a pick
    const plain = setup(7), odd = setup(7);
    playIntro(plain);
    playIntro(odd);
    const a = plain.send({ type: "startScene", scene: "shift" });
    const b = odd.send({ type: "startScene", scene: "shift", pick: { item: "apple", colour: "red" } });
    expect(b).toEqual(a);
    expect(odd.state.run).toEqual(plain.state.run);
  });

  it("a wrong reply costs money, triggers a reaction, and rephrases after two misses", () => {
    const core = setup();
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const right = rightChoice(core);
    const wrong = right === 0 ? 1 : 0;

    const miss1 = core.send({ type: "reply", choice: wrong });
    expect(find(miss1, "actionPerformed").matched).toBe(false);
    expect(find(miss1, "walletChanged")).toMatchObject({ delta: -2, reason: "mixup" });
    expect(find(miss1, "npcReacted")).toMatchObject({ npc: "cook", reaction: "wrong-generic" });
    expect(types(miss1)).not.toContain("lineRephrased");

    const miss2 = core.send({ type: "reply", choice: wrong });
    expect(find(miss2, "lineRephrased")).toMatchObject({ npc: "cook", slow: false });

    const ok = core.send({ type: "reply", choice: right });
    expect(find(ok, "sceneEnded")).toEqual({ type: "sceneEnded", scene: "shift", earned: 0 });
    expect(find(ok, "trustChanged")).toMatchObject({ trust: 3 });
    expect(core.state.wallet).toBe(20 - 4);
  });

  it("switches to tiles when the hinge words are known but typing is off", () => {
    const core = setup();
    playIntro(core);
    const words: Record<string, WordRecord> = {};
    for (const w of ["w_cha", "w_shui", "w_san", "w_si", "w_hao", "x_bei"]) {
      words[w] = recordRight(recordRight(recordRight(undefined, T0), T0), T0);
    }
    const tiles = createCore(course, { ...core.state, words }, { now: () => T0, rng: mulberry32(2) });
    const ev = tiles.send({ type: "startScene", scene: "shift" });
    expect(find(ev, "replyOptions").mode).toBe("tiles");

    const run = tiles.state.run!;
    const reply = course.scenes[1].exchanges[0].variants[comboKey(run.combo)].reply;
    const order = reply.tokens.map((t) => run.tiles.indexOf(reply.text.slice(t.start, t.end)));
    const done = tiles.send({ type: "replyTiles", tiles: order });
    expect(find(done, "actionPerformed").matched).toBe(true);

    const bad = createCore(course, { ...core.state, words }, { now: () => T0, rng: mulberry32(2) });
    bad.send({ type: "startScene", scene: "shift" });
    expect(find(bad.send({ type: "replyTiles", tiles: [0] }), "actionPerformed").matched).toBe(false);
  });

  it("only slots that change the action count as a mix-up", () => {
    const c = fixtureCourse();
    c.scenes[1].exchanges[0].expect = { action: "serve", item: "$item" };
    c.scenes[1].exchanges[0].hinges = ["$item"];
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const run = core.state.run!;
    const sameItem = run.options.findIndex((k) => k !== comboKey(run.combo) && k.endsWith(`item=${run.combo.item}`));
    expect(sameItem).toBeGreaterThanOrEqual(0);
    expect(find(core.send({ type: "reply", choice: sameItem }), "actionPerformed").matched).toBe(true);
  });

  it("rejects a resumed scene that no longer fits the course instead of throwing", () => {
    const core = setup();
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const stale = createCore(course, { ...core.state, run: { ...core.state.run!, exchange: 5 } }, { now: () => T0, rng: mulberry32(1) });
    expect(stale.send({ type: "reply", choice: 0 })).toEqual([{ type: "inputRejected", reason: "stale-run" }]);
  });

  it("describes the scene in progress for a front end resuming a save, without changing it", () => {
    const core = setup();
    expect(describeRun(course, core.state)).toEqual([]);
    core.send({ type: "goTo", place: "noodle_shop" });
    core.send({ type: "startScene", scene: "intro" });
    const next = answerRight(core);
    const before = core.state;
    expect(describeRun(course, core.state)).toEqual([
      { type: "sceneStarted", scene: "intro", npc: "cook" },
      find(next, "lineSpoken"),
      find(next, "replyOptions"),
    ]);
    expect(core.state).toBe(before);
  });

  it("a help lookup makes a word shaky", () => {
    const core = setup();
    playIntro(core);
    expect(core.send({ type: "helpWord", word: "w_ni" })).toEqual([
      { type: "wordStateChanged", word: "w_ni", from: "met", to: "shaky" },
    ]);
  });

  it("sleeps only at home when the course has one", () => {
    const c = fixtureCourse();
    c.world.home = "street";
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    core.send({ type: "goTo", place: "noodle_shop" });
    const before = core.state;
    expect(core.send({ type: "sleep" })).toEqual([{ type: "inputRejected", reason: "not-home" }]);
    expect(core.state).toBe(before);
    core.send({ type: "goTo", place: "street" });
    expect(types(core.send({ type: "sleep" }))).toContain("dayEnded");
    expect(core.state.day).toBe(2);
  });

  it("sleeps anywhere as a rough night before the home scene is done, then only at home", () => {
    const c = fixtureCourse();
    c.world.home = "street";
    c.world.homeScene = "intro";
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    core.send({ type: "goTo", place: "noodle_shop" });
    // Not home, and the home scene isn't done yet: sleep still works, and says it was rough.
    let events = core.send({ type: "sleep" });
    expect(find(events, "dayEnded")).toEqual({ type: "dayEnded", day: 1, rough: true });
    expect(core.state.day).toBe(2);
    // Finish the home scene: sleep is now home-only, same as a course without homeScene at all.
    playIntro(core);
    core.send({ type: "goTo", place: "noodle_shop" });
    expect(core.send({ type: "sleep" })).toEqual([{ type: "inputRejected", reason: "not-home" }]);
    core.send({ type: "goTo", place: "street" });
    events = core.send({ type: "sleep" });
    expect(find(events, "dayEnded")).toEqual({ type: "dayEnded", day: 2 });
  });

  it("without homeScene, sleep behaves exactly as before (no rough flag, ever)", () => {
    const c = fixtureCourse();
    c.world.home = "street";
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    const events = core.send({ type: "sleep" });
    expect(events.find((e) => e.type === "dayEnded")).toEqual({ type: "dayEnded", day: 1 });
  });

  it("keeps a running scene going after the course adds to its `after`", () => {
    const core = setup();
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const c = fixtureCourse();
    c.scenes[1].after = ["intro", "later"];
    const resumed = createCore(c, core.state, { now: () => T0, rng: mulberry32(1) });
    const choice = resumed.state.run!.options.indexOf(comboKey(resumed.state.run!.combo));
    expect(types(resumed.send({ type: "reply", choice }))).not.toContain("inputRejected");
  });

  it("uses day slots and refuses scenes when they run out", () => {
    const core = setup();
    playIntro(core);
    for (let i = 0; i < 3; i++) {
      core.send({ type: "startScene", scene: "shift" });
      answerRight(core);
    }
    expect(core.state.slot).toBe(4);
    expect(core.send({ type: "startScene", scene: "shift" })).toEqual([{ type: "inputRejected", reason: "no-slots" }]);
    expect(types(core.send({ type: "sleep" }))).toContain("dayEnded");
    expect(core.state.slot).toBe(0);
  });

  it("says what was asked alongside what the reply did", () => {
    const core = setup();
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const { combo, options } = core.state.run!;
    const expected = { action: "serve", item: combo.item, count: combo.count };
    const wrongKey = options.find((k) => k !== comboKey(combo))!;
    const miss = find(core.send({ type: "reply", choice: options.indexOf(wrongKey) }), "actionPerformed");
    expect(miss.expected).toEqual(expected);
    expect(miss.action).not.toEqual(expected);
    expect(find(answerRight(core), "actionPerformed")).toMatchObject({ matched: true, action: expected, expected });
  });

  it("remembers the line and place where each word was first heard, and never overwrites it", () => {
    const core = setup();
    playIntro(core);
    expect(core.state.words.w_ni.first).toEqual({ line: "你好！", place: "noodle_shop" });
    core.send({ type: "startScene", scene: "shift" });
    expect(core.state.words.w_ni.first).toEqual({ line: "你好！", place: "noodle_shop" });
    const bei = core.state.words.x_bei.first!;
    expect(bei.line).toMatch(/杯/);
  });

  it("logs accepted inputs for play-tests, not rejected ones, keeping the last 500", () => {
    const core = setup();
    core.send({ type: "goTo", place: "nowhere" });
    core.send({ type: "goTo", place: "noodle_shop" });
    expect(core.state.log).toEqual([{ t: T0, day: 1, slot: 0, input: { type: "goTo", place: "noodle_shop" } }]);
    for (let i = 0; i < 600; i++) core.send({ type: "helpWord", word: "w_ni" });
    expect(core.state.log).toHaveLength(LOG_LIMIT);
    expect(core.state.log.at(-1)!.input).toEqual({ type: "helpWord", word: "w_ni" });
  });

  it("keeps picking for a word got wrong but never right: tiles are for words once known", () => {
    const core = setup();
    playIntro(core);
    const wrongOnly = { right: 0, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T0, lastSeen: T0 };
    const words = Object.fromEntries(["w_cha", "w_shui", "w_san", "w_si", "w_hao", "x_bei"].map((w) => [w, { ...wrongOnly }]));
    const pick = createCore(course, { ...core.state, words }, { now: () => T0, rng: mulberry32(2) });
    expect(find(pick.send({ type: "startScene", scene: "shift" }), "replyOptions").mode).toBe("pick");
    const lapsed = Object.fromEntries(Object.keys(words).map((w) => [w, { ...wrongOnly, right: 1 }]));
    const tiles = createCore(course, { ...core.state, words: lapsed }, { now: () => T0, rng: mulberry32(2) });
    expect(find(tiles.send({ type: "startScene", scene: "shift" }), "replyOptions").mode).toBe("tiles");
  });

  it("falls back to picking after two wrong tile answers", () => {
    const core = setup();
    playIntro(core);
    const lapsed = { right: 1, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T0, lastSeen: T0 };
    const words = Object.fromEntries(["w_cha", "w_shui", "w_san", "w_si", "w_hao", "x_bei"].map((w) => [w, { ...lapsed }]));
    const tiles = createCore(course, { ...core.state, words }, { now: () => T0, rng: mulberry32(2) });
    tiles.send({ type: "startScene", scene: "shift" });
    expect(find(tiles.send({ type: "replyTiles", tiles: [0] }), "replyOptions").mode).toBe("tiles");
    const second = tiles.send({ type: "replyTiles", tiles: [0] });
    expect(find(second, "replyOptions").mode).toBe("pick");
    expect(tiles.state.run!.mode).toBe("pick");
    expect(tiles.state.run!.options).toContain(comboKey(tiles.state.run!.combo));
    expect(find(answerRight(tiles), "actionPerformed").matched).toBe(true);
  });

  it("offers written wrong replies for an exchange without slots, and picking one is a mix-up", () => {
    const core = setup();
    core.send({ type: "goTo", place: "noodle_shop" });
    const start = core.send({ type: "startScene", scene: "intro" });
    const opts = find(start, "replyOptions");
    expect(opts.mode === "pick" && opts.options.map((o) => o.text).sort()).toEqual(["你好！", "好你！", "好！"].sort());
    const run = core.state.run!;
    const alt = run.options.findIndex((k) => k.startsWith("alt:"));
    const miss = core.send({ type: "reply", choice: alt });
    expect(find(miss, "actionPerformed")).toMatchObject({ matched: false, action: { action: "other" }, expected: { action: "greet" } });
    expect(find(miss, "npcReacted")).toBeTruthy();
    expect(find(answerRight(core), "actionPerformed").matched).toBe(true);
  });

  it("counts the words of a right reply as answered right, and remembers the reply they were first said in", () => {
    const c = fixtureCourse();
    c.scenes[0].exchanges[0].variants[""].reply = line(["不", "w_bu"], ["是", "w_shi"], ["。", null]);
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    core.send({ type: "goTo", place: "noodle_shop" });
    core.send({ type: "startScene", scene: "intro" });
    answerRight(core);
    expect(core.state.words.w_bu).toMatchObject({ right: 1, first: { line: "不是。", place: "noodle_shop" } });
  });

  it("chooses the reply mode by the weakest of the hinge and reply words", () => {
    const core = setup();
    const lapsed = { right: 1, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T0, lastSeen: T0 };
    const words = { w_ni: { ...lapsed }, w_hao: { ...lapsed } };
    const tiles = createCore(course, { ...core.state, place: "noodle_shop", words }, { now: () => T0, rng: mulberry32(2) });
    expect(find(tiles.send({ type: "startScene", scene: "intro" }), "replyOptions").mode).toBe("tiles");
    expect([...tiles.state.run!.tiles].sort()).toEqual(["你", "好"].sort()); // the wrong replies add no new words here
  });

  it("a mix-up weakens the right reply's words that the chosen reply lacked", () => {
    const c = fixtureCourse();
    c.scenes[0].exchanges[0].variants[""].alts = [line(["好", "w_hao"], ["！", null])];
    const core = createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
    core.send({ type: "goTo", place: "noodle_shop" });
    core.send({ type: "startScene", scene: "intro" });
    const alt = core.state.run!.options.indexOf("alt:0");
    core.send({ type: "reply", choice: alt });
    expect(core.state.words.w_ni).toMatchObject({ wrong: 1, lapsed: true }); // 你 was missing from 好！
    expect(core.state.words.w_hao.wrong).toBe(0); // 好 was in both
  });

  it("resumes a saved pick that includes written wrong replies", () => {
    const core = setup();
    core.send({ type: "goTo", place: "noodle_shop" });
    const start = core.send({ type: "startScene", scene: "intro" });
    expect(describeRun(course, core.state)).toContainEqual(find(start, "replyOptions"));
  });
});


describe("errands", () => {
  const c = addErrand(fixtureCourse());
  const start = () => createCore(c, newGame(c), { now: () => T0, rng: mulberry32(1) });
  /** Answers the current exchange right, in pick or tiles mode. */
  const answer = (core: Core) => {
    const run = core.state.run!;
    if (run.mode === "pick") return core.send({ type: "reply", choice: run.options.indexOf(comboKey(run.combo)) });
    const ex = c.scenes.find((s) => s.id === run.scene)!.exchanges[run.exchange];
    const used = new Set<number>();
    const tiles = tilePieces(ex.variants[comboKey(run.combo)].reply).map((p) => {
      const i = run.tiles.findIndex((t, j) => t === p && !used.has(j));
      used.add(i);
      return i;
    });
    return core.send({ type: "replyTiles", tiles });
  };
  const play = (core: Core, scene: string) => {
    const ev = [...core.send({ type: "startScene", scene })];
    while (core.state.run) ev.push(...answer(core));
    return ev;
  };
  const pickedUp = () => {
    const core = start();
    core.send({ type: "goTo", place: "noodle_shop" });
    play(core, "intro");
    const ev = play(core, "pickup");
    return { core, ev };
  };
  const walkToSchool = (core: Core) => {
    core.send({ type: "goTo", place: "street" });
    core.send({ type: "goTo", place: "school" });
  };

  it("a pickup starts an errand to the place its slot named, with no unlock line for the drop-off", () => {
    const { core, ev } = pickedUp();
    expect(core.state.errand).toEqual({ to: "school" });
    expect(find(ev, "errandStarted")).toEqual({ type: "errandStarted", to: "school" });
    expect(ev.filter((e) => e.type === "unlocked")).toEqual([]);
  });

  it("a wrong reply at pickup still sends the parcel where she said", () => {
    const core = start();
    core.send({ type: "goTo", place: "noodle_shop" });
    play(core, "intro");
    core.send({ type: "startScene", scene: "pickup" });
    const wrong = core.state.run!.options.findIndex((k) => k !== comboKey(core.state.run!.combo));
    expect(types(core.send({ type: "reply", choice: wrong }))).toContain("npcReacted");
    while (core.state.run) answer(core);
    expect(core.state.errand).toEqual({ to: "school" });
  });

  it("carries one parcel at a time", () => {
    const { core } = pickedUp();
    expect(availableSceneIds(c, core.state)).not.toContain("pickup");
    expect(core.send({ type: "startScene", scene: "pickup" })).toEqual([{ type: "inputRejected", reason: "locked" }]);
  });

  it("offers the drop-off only while a parcel is for its place", () => {
    const empty = start();
    empty.send({ type: "goTo", place: "noodle_shop" });
    play(empty, "intro");
    expect(availableSceneIds(c, empty.state)).not.toContain("drop");
    const { core } = pickedUp();
    expect(availableSceneIds(c, core.state)).toContain("drop");
  });

  it("delivering pays, ends the errand, and opens the pickup again", () => {
    const { core } = pickedUp();
    walkToSchool(core);
    const wallet = core.state.wallet;
    const ev = play(core, "drop");
    expect(find(ev, "errandEnded")).toEqual({ type: "errandEnded", to: "school" });
    expect(core.state.errand).toBeUndefined();
    expect(core.state.wallet).toBeGreaterThan(wallet);
    expect(availableSceneIds(c, core.state)).toContain("pickup");
    expect(availableSceneIds(c, core.state)).not.toContain("drop");
  });

  it("announces the pickup once, not again after every delivery", () => {
    const { core } = pickedUp();
    walkToSchool(core);
    expect(play(core, "drop").filter((e) => e.type === "unlocked")).toEqual([]);
  });

  it("keeps the parcel overnight", () => {
    const { core } = pickedUp();
    core.send({ type: "sleep" });
    expect(core.state.day).toBe(2);
    expect(core.state.errand).toEqual({ to: "school" });
    walkToSchool(core);
    expect(types(core.send({ type: "startScene", scene: "drop" }))).toContain("sceneStarted");
  });

  it("with no slots left, the drop-off waits until the next day", () => {
    const { core } = pickedUp();
    walkToSchool(core);
    const tired = createCore(c, { ...core.state, slot: c.world.slotsPerDay }, { now: () => T0, rng: mulberry32(1) });
    expect(tired.send({ type: "startScene", scene: "drop" })).toEqual([{ type: "inputRejected", reason: "no-slots" }]);
    tired.send({ type: "goTo", place: "street" });
    tired.send({ type: "sleep" });
    tired.send({ type: "goTo", place: "school" });
    expect(types(tired.send({ type: "startScene", scene: "drop" }))).toContain("sceneStarted");
  });
});

describe("prices", () => {
  /** The fixture with the intro's greeting costing 3. */
  const priced = () => {
    const c = fixtureCourse();
    c.scenes[0].exchanges[0].variants[""].cost = 3;
    return c;
  };
  const at = (c: ReturnType<typeof fixtureCourse>, patch: Partial<ReturnType<typeof newGame>> = {}) =>
    createCore(c, { ...newGame(c), place: "noodle_shop", ...patch }, { now: () => T0, rng: mulberry32(1) });

  it("a right reply pays the price, as shopping", () => {
    const core = at(priced());
    core.send({ type: "startScene", scene: "intro" });
    const ev = core.send({ type: "reply", choice: core.state.run!.options.indexOf(comboKey(core.state.run!.combo)) });
    expect(find(ev, "walletChanged")).toEqual({ type: "walletChanged", wallet: 17, delta: -3, reason: "shopping" });
  });

  it("a wrong reply buys nothing", () => {
    const core = at(priced());
    core.send({ type: "startScene", scene: "intro" });
    const wrong = core.state.run!.options.findIndex((k) => k !== comboKey(core.state.run!.combo));
    const ev = core.send({ type: "reply", choice: wrong });
    expect(ev.filter((e) => e.type === "walletChanged" && e.reason === "shopping")).toEqual([]);
    expect(core.state.wallet).toBe(20);
  });

  it("sums a scene's highest price per exchange", () => {
    const c = priced();
    const menu = c.scenes[0].exchanges[1];
    menu.variants[comboKey({ item: "tea" })].cost = 2;
    menu.variants[comboKey({ item: "water" })].cost = 4;
    expect(sceneCost(c.scenes[0])).toBe(7);
    expect(sceneCost(c.scenes[1])).toBe(0);
  });

  it("isn't offered when the wallet can't cover the most it could cost", () => {
    const c = priced();
    expect(availableSceneIds(c, { ...newGame(c), wallet: 2 })).not.toContain("intro");
    expect(availableSceneIds(c, { ...newGame(c), wallet: 3 })).toContain("intro");
    expect(at(c, { wallet: 2 }).send({ type: "startScene", scene: "intro" })).toEqual([{ type: "inputRejected", reason: "locked" }]);
  });

  it("a repeatable scene played before is not announced again when it reopens", () => {
    const c = fixtureCourse();
    // The shift costs more than the wallet holds; a paid odd job makes it affordable again.
    for (const v of Object.values(c.scenes[1].exchanges[0].variants)) v.cost = 21;
    c.scenes.push({ ...structuredClone(c.scenes[0]), id: "odd", repeatable: true, exchanges: [{ ...structuredClone(c.scenes[0].exchanges[0]), pay: 5 }] });
    const core = at(c, { scenesDone: { intro: 1, shift: 1 }, trust: { cook: 2 }, wallet: 20 });
    expect(availableSceneIds(c, core.state)).not.toContain("shift");
    core.send({ type: "startScene", scene: "odd" });
    const ev: GameEvent[] = [];
    while (core.state.run) ev.push(...core.send({ type: "reply", choice: core.state.run.options.indexOf(comboKey(core.state.run.combo)) }));
    expect(availableSceneIds(c, core.state)).toContain("shift");
    expect(ev.filter((e) => e.type === "unlocked")).toEqual([]);
  });

  it("says when money is the only thing keeping a scene closed", () => {
    const c = priced();
    expect(moneyBlocked(c.scenes[0], { ...newGame(c), wallet: 2 })).toBe(true);
    expect(moneyBlocked(c.scenes[0], { ...newGame(c), wallet: 3 })).toBe(false);
    // the shift is closed by trust, not money
    expect(moneyBlocked(c.scenes[1], { ...newGame(c), wallet: 0 })).toBe(false);
  });

  it("announces a priced scene never played once it becomes affordable", () => {
    const c = fixtureCourse();
    for (const v of Object.values(c.scenes[1].exchanges[0].variants)) v.cost = 21;
    c.scenes.push({ ...structuredClone(c.scenes[0]), id: "odd", repeatable: true, exchanges: [{ ...structuredClone(c.scenes[0].exchanges[0]), pay: 5 }] });
    const core = at(c, { scenesDone: { intro: 1 }, trust: { cook: 2 }, wallet: 20 });
    core.send({ type: "startScene", scene: "odd" });
    const ev: GameEvent[] = [];
    while (core.state.run) ev.push(...core.send({ type: "reply", choice: core.state.run.options.indexOf(comboKey(core.state.run.combo)) }));
    expect(ev).toContainEqual({ type: "unlocked", scene: "shift" });
  });
});

describe("pay depends on misses", () => {
  it("full with no misses, half (rounded down) after one, nothing after two", () => {
    expect(payFor(3, 0)).toBe(3);
    expect(payFor(3, 1)).toBe(1);
    expect(payFor(4, 1)).toBe(2);
    expect(payFor(3, 2)).toBe(0);
    expect(payFor(3, 5)).toBe(0);
    expect(payFor(0, 0)).toBe(0);
  });

  it("pay after one miss is halved, and the mixup cost still stands", () => {
    const core = setup();
    playIntro(core);
    core.send({ type: "startScene", scene: "shift" });
    const right = rightChoice(core);
    core.send({ type: "reply", choice: right === 0 ? 1 : 0 });
    const ok = core.send({ type: "reply", choice: right });
    expect(find(ok, "sceneEnded")).toEqual({ type: "sceneEnded", scene: "shift", earned: 1 });
    expect(core.state.wallet).toBe(20 - 2 + 1);
  });

  it("misses count per exchange: the next exchange pays in full", () => {
    const c = fixtureCourse();
    c.scenes[1].exchanges.push({ ...structuredClone(c.scenes[1].exchanges[0]), id: "order2" });
    const core = createCore(c, { ...newGame(c), place: "noodle_shop", scenesDone: { intro: 1 }, trust: { cook: 2 } }, { now: () => T0, rng: mulberry32(1) });
    core.send({ type: "startScene", scene: "shift" });
    const pick = () => core.state.run!.options.indexOf(comboKey(core.state.run!.combo));
    core.send({ type: "reply", choice: pick() === 0 ? 1 : 0 });
    core.send({ type: "reply", choice: pick() });
    const ev = core.send({ type: "reply", choice: pick() });
    expect(find(ev, "sceneEnded")).toEqual({ type: "sceneEnded", scene: "shift", earned: 1 + 3 });
  });
});

describe("spaced languages", () => {
  it("joins tiles with a space only when the language is spaced", () => {
    expect(joinTiles(fixtureCourse(), ["a", "b"])).toBe("ab");
    expect(joinTiles(spacedCourse(), ["a", "b"])).toBe("a b");
  });

  it("accepts the right tiles in a spaced language", () => {
    const course = spacedCourse();
    const state = newGame(course);
    const known = { right: 3, wrong: 0, streak: 3, helps: 0, lapsed: false, firstSeen: 0, lastSeen: 0 };
    for (const id of Object.keys(course.words)) state.words[id] = { ...known };
    state.place = "noodle_shop";
    const core = createCore(course, state, { now: () => 0, rng: mulberry32(1) });
    core.send({ type: "startScene", scene: "intro" });
    const run = core.state.run!;
    expect(run.mode).toBe("tiles");
    const reply = course.scenes[0].exchanges[0].variants[""].reply;
    expect(reply.text).toBe("mi bon!");
    const used = new Set<number>();
    const order = tilePieces(reply).map((p) => {
      const i = run.tiles.findIndex((x, j) => x === p && !used.has(j));
      used.add(i);
      return i;
    });
    const ev = core.send({ type: "replyTiles", tiles: order });
    expect(ev.find((e) => e.type === "actionPerformed")).toMatchObject({ tilesWrong: false });
  });
});
