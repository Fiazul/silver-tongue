import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  availableSceneIds,
  comboKey,
  createCore,
  mulberry32,
  newGame,
  personalize,
  sceneCost,
  tilePieces,
  type Course,
  type GameState,
  type Input,
} from "@silver-tongue/core";
import { anchorRow, extra, makeText, npcLabel, placeMenu, primaryItem } from "@silver-tongue/view";
import { stepToward } from "../src/bots";
import { buildCourse } from "../src/build-course";

const CONTENT = fileURLToPath(new URL("../../content", import.meta.url));

/** ko-seoul stage 1: each scene answers a need the one before it raised (spec section 11). */
const CHAIN = [
  "room-wake",
  "room-minjun",
  "street-introductions",
  "street-again",
  "street-what",
  "street-hungry",
  "shop-prices",
  "street-numbers",
  "shop-count",
  "stall-intro",
  "stall-shift",
  "stall-family",
  "room-rent",
];

/** Stage 2's scenes: the letter opens them once stage 1 is done. */
const STAGE2 = ["room-letter", "campus-labmate", "copy-intro", "copy-shift", "room-creditor"];

/** The right reply in whatever mode the core asks for. */
function rightReply(course: Course, state: GameState): Input {
  const run = state.run!;
  const v = course.scenes.find((s) => s.id === run.scene)!.exchanges[run.exchange].variants[comboKey(run.combo)];
  if (run.mode === "pick") return { type: "reply", choice: run.options.indexOf(comboKey(run.combo)) };
  if (run.mode === "type") return { type: "replyText", text: personalize(v.reply, state.player ?? "?").text };
  const used = new Set<number>();
  const tiles = tilePieces(v.reply).map((p) => {
    const i = run.tiles.findIndex((t, j) => t === p && !used.has(j));
    used.add(i);
    return i;
  });
  return { type: "replyTiles", tiles };
}

/** Plays from a new game: the chain in order, then one visit to the shop. `idleNights` sleeps that many nights after waking first. */
function playChain(c: Course, idleNights: number) {
  let clock = 0;
  const core = createCore(c, newGame(c), { now: () => clock, rng: mulberry32(1) });
  const wallet: number[] = [];
  const send = (input: Input) => {
    clock += 3_600_000;
    const ev = core.send(input);
    expect(ev.filter((e) => e.type === "inputRejected"), JSON.stringify(input)).toEqual([]);
    for (const e of ev) if (e.type === "walletChanged") wallet.push(e.wallet);
  };
  const walkTo = (place: string) => {
    while (core.state.place !== place) {
      const step = stepToward(c, core.state.place, new Set([place]), core.state);
      expect(step, `a way to ${place}`).toBeDefined();
      send({ type: "goTo", place: step! });
    }
  };
  const sleep = () => {
    walkTo(c.world.home!);
    send({ type: "sleep" });
  };
  const play = (id: string) => {
    if (core.state.slot >= c.world.slotsPerDay) sleep();
    walkTo(c.scenes.find((s) => s.id === id)!.place);
    send({ type: "startScene", scene: id });
    for (let n = 0; core.state.run && n < 50; n++) send(rightReply(c, core.state));
    expect(core.state.run ?? null, id).toBeNull();
    expect(core.state.scenesDone[id], id).toBe(1);
  };
  const openOneOffs = () => availableSceneIds(c, core.state).filter((id) => !c.scenes.find((s) => s.id === id)!.repeatable);
  if (c.needsName) send({ type: "setName", name: "Sam" });

  for (const [i, id] of CHAIN.entries()) {
    // The story offers exactly this scene next (a job, once found, stays open beside it).
    if (!c.scenes.find((s) => s.id === id)!.repeatable) expect(openOneOffs(), `before ${id}`).toEqual([id]);
    else expect(availableSceneIds(c, core.state), `before ${id}`).toContain(id);
    play(id);
    if (i === 0) for (let n = 0; n < idleNights; n++) sleep();
  }
  expect(openOneOffs()).toEqual(["room-letter"]);
  // Shopping opens with the clerk's apology, and the wages pay for it.
  expect(availableSceneIds(c, core.state)).toContain("shop-buy");
  play("shop-buy");
  return { state: core.state, wallet };
}

/**
 * Plays from a new game pressing only the one bright control (primaryItem) between scenes, with
 * unavailable items left out as the quiet page leaves them out. Returns the scenes in the order played.
 */
function followBright(c: Course) {
  let clock = 0;
  const core = createCore(c, newGame(c), { now: () => clock, rng: mulberry32(1) });
  const t = makeText(c.learnerFtl, c.learner);
  const send = (input: Input) => {
    clock += 3_600_000;
    const ev = core.send(input);
    expect(ev.filter((e) => e.type === "inputRejected"), JSON.stringify(input)).toEqual([]);
    return ev;
  };
  if (c.needsName) send({ type: "setName", name: "Sam" });
  const played: string[] = [];
  const rentShown: boolean[] = [];
  for (let n = 0; n < 200 && !core.state.scenesDone["room-rent"]; n++) {
    const menu = placeMenu(c, core.state, t).filter((m) => !("disabled" in m && m.disabled));
    const i = primaryItem(c, core.state, menu) ?? (menu.length === 1 ? 0 : undefined);
    expect(i, `a bright control at ${core.state.place}, day ${core.state.day}`).toBeDefined();
    const item = menu[i!];
    send(item.input);
    if (item.kind !== "talk") continue;
    played.push(item.scene);
    rentShown.push(!!anchorRow(c, core.state, t).rent);
    for (let k = 0; core.state.run && k < 50; k++) send(rightReply(c, core.state));
  }
  return { played, rentShown, state: core.state, t };
}

describe("ko-seoul's stage-1 chain", () => {
  const { course, errors } = buildCourse(CONTENT, "ko-seoul");

  it("builds with the chain plus the shop, one-off except the jobs", () => {
    expect(errors).toEqual([]);
    expect(course!.scenes.map((s) => s.id).sort()).toEqual([...CHAIN, "shop-buy", ...STAGE2].sort());
    expect(course!.scenes.filter((s) => s.repeatable).map((s) => s.id).sort()).toEqual(["copy-shift", "shop-buy", "stall-shift"]);
  });

  it("teaches the farewell at the door: the landlady leaves, the player stays", () => {
    const scene = course!.scenes.find((s) => s.id === "room-wake")!;
    const v = Object.values(scene.exchanges.find((e) => e.id === "bye")!.variants)[0];
    expect(v.npc.text).toBe("안녕히 계세요.");
    expect(v.reply.text).toBe("안녕히 가세요.");
    expect(v.reply.intent).toBe("Say goodbye as she leaves");
    expect(v.alts?.map((l) => l.text)).toEqual(["네."]);
  });

  it("keeps the fast-question narration to observable speed and gestures", () => {
    const t = makeText(course!.learnerFtl, course!.learner);
    for (const id of ["scene-street-again-start", "scene-street-introductions-end"]) expect(t(id)).not.toMatch(/where.*going/i);
    expect(t("scene-street-again-start")).toMatch(/quick|fast/i);
    // A night can fall between the two (four scenes a day, and the mentor takes one), so the question is set up where it is asked.
    expect(t("scene-street-introductions-end")).not.toMatch(/quick|fast|asks/i);
  });

  it("Min-jun comes home right after the door; his replies use only words heard first; the stall opens once Park points at it", () => {
    const s = course!.scenes.find((s) => s.id === "room-minjun")!;
    expect(s.after).toEqual(["room-wake"]);
    expect(course!.scenes.find((x) => x.id === "street-introductions")!.after).toEqual(["room-minjun"]);
    expect(course!.world.places.stall.after).toEqual(["street-hungry"]);
    const heard = new Set(course!.scenes.filter((x) => x.id === "room-wake").flatMap((x) => x.exchanges.flatMap((ex) => Object.values(ex.variants).flatMap((v) => [v.npc, v.reply].flatMap((l) => l.tokens.map((t) => t.word))))));
    for (const v of s.exchanges.flatMap((ex) => Object.values(ex.variants))) {
      for (const tk of v.npc.tokens) heard.add(tk.word);
      for (const l of v.alts ?? []) for (const tk of l.tokens) expect(heard.has(tk.word), l.text).toBe(true);
      for (const tk of v.reply.tokens) heard.add(tk.word);
    }
  });

  it("keeps the door to the script's three exchanges and at most nine new lexical items", () => {
    const door = course!.scenes.find((s) => s.id === "room-wake")!;
    expect(door.exchanges.map((e) => e.id)).toEqual(["call", "message", "bye"]);
    const words = new Set(door.exchanges.flatMap((ex) => Object.values(ex.variants).flatMap((v) => [v.npc, v.reply, ...(v.alts ?? [])].flatMap((l) => l.tokens.map((t) => t.word)))));
    const nonNames = [...words].filter((id) => course!.words[id].w !== "민준");
    expect(nonNames.length).toBeLessThanOrEqual(9);
  });

  it("a new player plays it in order: each scene opens only after the one before, never blocked", () => {
    const { state, wallet } = playChain(course!, 0);
    expect(Math.min(...wallet)).toBeGreaterThan(0);
    expect(state.day).toBeLessThanOrEqual(5);
  });

  it("no story scene before the first job costs money, so a player who spent every won is never stuck", () => {
    for (const id of CHAIN.slice(0, CHAIN.indexOf("stall-shift"))) expect(sceneCost(course!.scenes.find((s) => s.id === id)!), id).toBe(0);
    const { wallet } = playChain(course!, 6);
    expect(wallet).toContain(0);
  });

  it("the one bright control between scenes always leads to the next scene of the chain", () => {
    const { played } = followBright(course!);
    expect(played).toEqual(CHAIN);
  });

  it("rent stays off the top bar until the landlady brings it up; names wait for introductions", () => {
    const { played, rentShown, state, t } = followBright(course!);
    expect(extra(course!).scenes.filter((s) => s.rent).map((s) => s.id)).toEqual(["room-rent"]);
    expect(rentShown.slice(0, played.indexOf("room-rent") + 1).some(Boolean)).toBe(false);
    // Short of rent and two days from it, but nobody has mentioned rent: nothing on the bar.
    const short = { ...state, day: 6, wallet: 0, scenesDone: { ...state.scenesDone, "room-rent": 0 } };
    expect(anchorRow(course!, short, t).rent).toBeUndefined();
    expect(anchorRow(course!, { ...short, scenesDone: state.scenesDone }, t).rent).toBeDefined();
    expect(npcLabel(course!, state, t, "oldman")).toBe("Grandpa Park");
    const fresh = newGame(course!);
    expect(npcLabel(course!, { ...fresh, scenesDone: { "room-wake": 1, "room-minjun": 1 } }, t, "oldman")).toBe("The old man");
    expect(npcLabel(course!, { ...fresh, scenesDone: { "room-wake": 1, "room-minjun": 1 } }, t, "jiwoo")).toBe(t("npc-jiwoo-unmet"));
    expect(npcLabel(course!, { ...fresh, scenesDone: { "room-wake": 1 } }, t, "minjun")).toBe("A young man");
    expect(npcLabel(course!, { ...fresh, scenesDone: { "room-wake": 1, "room-minjun": 1 } }, t, "minjun")).toBe("Min-jun");
    expect(npcLabel(course!, fresh, t, "oldman")).toBe("The old man");
    expect(npcLabel(course!, fresh, t, "landlady")).toBe("The landlady");
  });

  it("wrong replies differ from this exchange's reply; accepted story choices advance", () => {
    // Repetition requests look like valid progress during a miss. Other exchanges may legitimately
    // want the same word; only this exchange determines whether it is an accepted story choice.
    const repeatRequests = ["네?", "다시 말해 주세요.", "천천히 말해 주세요."];
    for (const s of course!.scenes) {
      const variants = s.exchanges.flatMap((ex) => Object.values(ex.variants));
      for (const ex of s.exchanges)
        for (const v of Object.values(ex.variants))
          for (const [i, alt] of (v.alts ?? []).entries()) {
            if (v.altOutcomes?.[i + 1]?.accept) continue;
            // Reusing a valid word can be an invalid response to a different question.
            expect(alt.text, `${s.id}/${ex.id}`).not.toBe(v.reply.text);
            expect(repeatRequests, `${s.id}/${ex.id}`).not.toContain(alt.text);
            expect(alt.meaning && alt.intent, `${s.id}/${ex.id}: ${alt.text}`).toBeTruthy();
          }
      for (const v of variants) expect(v.reply.meaning && v.reply.intent, `${s.id}: ${v.reply.text}`).toBeTruthy();
      // A right reply moves the line on, so the player can tell it from a miss.
      const single = s.exchanges.filter((ex) => Object.keys(ex.variants).length === 1).map((ex) => Object.values(ex.variants)[0].npc.text);
      for (let i = 1; i < single.length; i++) expect(single[i], `${s.id}: line ${i}`).not.toBe(single[i - 1]);
    }
  });

  it("keeps the pinned clue lines word for word", () => {
    const pinned = extra(course!).scenes.flatMap((s) => s.exchanges.filter((ex) => ex.pin).map((ex) => `${s.id}: ${Object.values(ex.variants)[0].npc.text}`));
    expect(pinned.sort()).toEqual([
      "campus-labmate: 민준 씨가 책을 가져갔어요.",
      "campus-labmate: 민준 씨는 삼월부터 안 왔어요.",
      "room-creditor: 다음 주에 또 올게요.",
      "room-rent: 민준 씨는 삼월까지 냈어요.",
      "stall-family: 동생이에요. 지금 없어요.",
    ]);
  });
});
