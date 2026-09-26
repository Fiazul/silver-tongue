// Smoke test of the 3D front end's game logic against the real course, with no DOM and no WebGL:
// the UI model is what the overlay would render.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { comboKey, newGame, type Course, type GameEvent } from "@silver-tongue/core";
import { buildCourse } from "../../../tools/src/build-course";
import { createGame, openSession, type UiModel } from "../src/game";
import { boxesOverlap, heldProp, LAYOUT, LayoutIndex, route, STREET, type AssetIndex, type Box2 } from "../src/layout";
import { blocked } from "../src/movement";
import { ZONE_MARGIN } from "../src/spaces";
import { createCore } from "@silver-tongue/core";
import { readFileSync, existsSync } from "node:fs";
import { ASSETS, fakeAudio } from "./helpers";

const CONTENT = fileURLToPath(new URL("../../../content", import.meta.url));
const { course: built, errors } = buildCourse(CONTENT, "zh-china-en");
const course = built as Course;

/** A fake UI adapter: records every model it is handed and every event the dispatcher passes on. */
function fakeUi() {
  const models: UiModel[] = [];
  const events: GameEvent[] = [];
  return {
    models,
    events,
    onChange: (m: UiModel) => models.push(structuredClone(m)),
    onEvent: (e: GameEvent) => events.push(e),
  };
}

/** The pick-mode option index core expects: the option whose key is the run's combo. */
function rightOption(game: ReturnType<typeof createGame>): number {
  const run = game.core.state.run!;
  expect(run.mode).toBe("pick");
  return run.options.indexOf(comboKey(run.combo));
}

function playScene(game: ReturnType<typeof createGame>) {
  for (let guard = 0; game.core.state.run && guard < 20; guard++) {
    expect(game.model.reply?.mode).toBe("pick");
    game.reply(rightOption(game));
  }
  expect(game.core.state.run).toBeNull();
}

describe("world3d game (real course)", () => {
  it("builds the course", () => expect(errors).toEqual([]));

  it("newGame -> goTo noodle_shop -> first available scene (+ the one it unlocks) -> right picks: wages and sceneEnded reach the UI model", () => {
    let t = 1_000_000;
    const now = () => (t += 1000);
    // The noodle shop's first scene needs Old Wang's two street scenes and a name: give the fresh game those.
    const state = { ...newGame(course), player: "Sam", scenesDone: { "street-hello": 1, "street-hungry": 1, "street-numbers": 1 } };
    const ui = fakeUi();
    const saves: unknown[] = [];
    const core = createCore(course, state, { now, rng: () => 0.42 });
    const audio = fakeAudio();
    const game = createGame({ course, core, now, save: (s) => (saves.push(s), true), onChange: ui.onChange, onEvent: ui.onEvent, audio });
    expect(game.model.mode).toBe("explore");

    game.enterPlace("noodle_shop");
    expect(core.state.place).toBe("noodle_shop");
    expect(game.model.hud.place).toBe("noodle_shop");

    const wallet0 = game.model.hud.wallet;
    game.talkTo("cook");
    expect(game.model.mode).toBe("scene");
    expect(game.model.scene).toEqual({ id: "noodle-intro", npc: "cook" });
    expect(game.model.bubble?.npc).toBe("cook");
    expect(game.model.bubble?.line.tokens.length).toBeGreaterThan(0);
    const opts = game.model.reply;
    expect(opts?.mode).toBe("pick");
    if (opts?.mode === "pick") expect(opts.options.length).toBeGreaterThanOrEqual(2);

    playScene(game);
    // noodle-intro pays nothing (all its exchanges have pay 0) but earns the cook's trust, which
    // unlocks the paid noodle-shift: the next talk to the cook starts that.
    expect(ui.events.some((e) => e.type === "sceneEnded" && e.scene === "noodle-intro")).toBe(true);
    expect(ui.events.some((e) => e.type === "trustChanged" && e.npc === "cook")).toBe(true);
    game.talkTo("cook");
    expect(game.model.scene).toEqual({ id: "noodle-shift", npc: "cook" });
    playScene(game);

    const types = ui.events.map((e) => e.type);
    expect(types).toContain("sceneStarted");
    expect(types).toContain("lineSpoken");
    expect(types).toContain("replyOptions");
    expect(types).toContain("actionPerformed");
    expect(types).toContain("sceneEnded");
    expect(types).toContain("walletChanged");
    const wages = ui.events.find((e) => e.type === "walletChanged");
    expect(wages).toMatchObject({ reason: "wages" });
    // ...and into the model the UI renders
    const last = ui.models.at(-1)!;
    expect(last.mode).toBe("explore");
    expect(last.scene).toBeNull();
    expect(last.hud.wallet).toBeGreaterThan(wallet0);
    expect(last.hud.slotsLeft).toBe(course.world.slotsPerDay - 2);
    expect(last.feed.some((f) => f.kind === "sceneEnded")).toBe(true);
    expect(last.feed.some((f) => f.kind === "walletChanged" && f.tone === "good")).toBe(true);
    expect(last.events.some((e) => e.type === "sceneEnded")).toBe(true);
    expect(saves.length).toBeGreaterThan(0);
    // Every line was said (the scenes' lines and replies reached the audio out)...
    expect(audio.plays.length).toBeGreaterThan(4);
    expect(last.hud.sound).toBe("on");
    // ...and the sound toggle: soundSet flips the HUD chip in the model the UI renders, and is saved.
    game.setSound(false);
    expect(ui.events.at(-1)).toEqual({ type: "soundSet", on: false });
    expect(ui.models.at(-1)!.hud.sound).toBe("off");
    expect((saves.at(-1) as { sound?: boolean }).sound).toBe(false);
    game.setSound(true);
    expect(ui.events.at(-1)).toEqual({ type: "soundSet", on: true });
    expect(ui.models.at(-1)!.hud.sound).toBe("on");
  });

  it("a fresh game asks for a name, then Old Wang's first scene plays on the street", () => {
    let t = 5_000_000;
    const now = () => (t += 1000);
    const core = createCore(course, newGame(course), { now, rng: () => 0.3 });
    const game = createGame({ course, core, now });
    expect(game.model.mode).toBe(course.needsName ? "name" : "explore");
    game.talkTo("wang"); // ignored while naming
    expect(core.state.run).toBeNull();
    expect(game.setName("Sam")).toBe(true);
    expect(game.model.mode).toBe("explore");
    game.talkTo("wang");
    expect(game.model.scene?.npc).toBe("wang");
    // word help is logged in core, as in the TUI
    const word = game.model.bubble!.line.tokens[0].word;
    const gloss = game.helpWord(word);
    expect(gloss?.gloss).toBeTruthy();
    expect(core.state.words[word].helps).toBe(1);
    playScene(game);
    expect(core.state.scenesDone["street-hello"]).toBe(1);
  });

  it("rejections become toasts; walking into a zone routes through the graph", () => {
    let t = 9_000_000;
    const now = () => (t += 1000);
    const core = createCore(course, { ...newGame(course), player: "Sam" }, { now, rng: () => 0.5 });
    const game = createGame({ course, core, now });
    game.talkTo("cook"); // not here
    expect(game.model.feed.at(-1)).toMatchObject({ kind: "inputRejected", tone: "bad" });
    game.sleep(); // not home
    expect(game.model.feed.at(-1)?.text).toBe(game.t("reject-not-home"));
    expect(route(course.world, "street", "room")).toEqual(["market", "room"]);
    game.enterPlace("room"); // street -> market -> room
    expect(core.state.place).toBe("room");
    expect(game.model.canSleep).toBe(true);
    expect(game.model.feed.filter((f) => f.kind === "placeEntered").at(-1)?.text).toBe(game.t("place-room"));
  });

  it("tiles mode shows the tiles; the dispatcher takes every other event", () => {
    const now = () => 1;
    const core = createCore(course, { ...newGame(course), player: "Sam" }, { now, rng: () => 0.5 });
    const game = createGame({ course, core, now });
    game.dispatch([{ type: "replyOptions", mode: "tiles", tiles: ["你", "好"] }]);
    expect(game.model.reply).toEqual({ mode: "tiles", tiles: ["你", "好"] });
    const line = { text: "你好", tokens: [] };
    game.dispatch([
      { type: "lineRephrased", npc: "wang", line, slow: true },
      { type: "npcReacted", npc: "wang", reaction: "wrong-generic", line },
      { type: "unlocked", scene: "street-hungry" },
      { type: "rankChanged", rank: 1 },
      { type: "dayEnded", day: 1 },
      { type: "noteReady", note: "x" },
      { type: "mentorVisited", npc: "wang", notes: [] },
      { type: "wordStateChanged", word: "w0001", from: "unseen", to: "met" },
    ]);
    expect(game.model.bubble?.kind).toBe("reaction");
    expect(game.model.dayChanges).toBe(1);
    expect(game.model.feed.map((f) => f.kind)).toEqual(expect.arrayContaining(["unlocked", "rankChanged", "dayEnded", "noteReady", "mentorVisited"]));
  });

  it("a shop you can't afford says what it needs (the TUI menu's line); a save with a parcel resumes with it on the HUD and the objective", () => {
    const now = () => 1_000;
    const broke = createCore(course, { ...newGame(course), player: "Sam", place: "shop", wallet: 1, scenesDone: { "shop-intro": 1 }, trust: { shopkeeper: 1 } }, { now, rng: () => 0.5 });
    const g = createGame({ course, core: broke, now });
    g.talkTo("shopkeeper");
    expect(broke.state.run).toBeNull();
    const need = g.t("menu-needs-money", { npc: g.npcName("shopkeeper"), scene: g.t("scene-shop-buy"), currency: course.world.currency, cost: 5 });
    expect(g.model.feed.at(-1)).toMatchObject({ text: need, tone: "info" });

    const core = createCore(course, { ...newGame(course), player: "Sam", place: "market", errand: { to: "hospital" }, scenesDone: { "delivery-intro": 1, "delivery-pickup": 1 } }, { now, rng: () => 0.5 });
    const game = createGame({ course, core, now });
    expect(game.model.hud.errand).toEqual({ to: "hospital", placeName: game.t("place-hospital") });
    expect(game.model.objective).toMatchObject({ text: game.s("obj-deliver", { place: game.t("place-hospital"), npc: game.npcName("doctor") }), scene: "delivery-hospital" });
    // no second parcel while one is carried
    game.talkTo("dispatcher");
    expect(core.state.run).toBeNull();
  });

  it("saves under the TUI's localStorage keys", () => {
    const store = new Map<string, string>();
    const kv = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      keys: () => [...store.keys()],
    };
    let t = Date.UTC(2026, 8, 26, 12);
    const { game, opened } = openSession(course, kv, { now: () => (t += 1000) });
    game.setName("Sam");
    expect(store.get(`silver-tongue:${course.id}:session:${opened.id}`)).toContain('"player":"Sam"');
    expect(JSON.parse(store.get(`silver-tongue:${course.id}:meta`)!).last).toBe(opened.id);
  });
});

describe("layout", () => {
  const indexPath = `${ASSETS}/index.json`;
  const index: AssetIndex | undefined = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;

  it("covers every place and NPC in the course's world", () => {
    for (const p of Object.keys(course.world.places)) expect(LAYOUT.places[p], p).toBeDefined();
    for (const n of Object.keys(course.world.npcs)) expect(LAYOUT.npcs[n], n).toBeDefined();
  });

  it.skipIf(!index)("every asset is in index.json; every NPC stands in the space of its place and talks from inside that place", () => {
    const L = new LayoutIndex(LAYOUT, index!);
    for (const a of L.assetNames()) expect(() => L.asset(a), a).not.toThrow();
    for (const [npc, { place }] of Object.entries(course.world.npcs)) {
      const space = L.spaceOf(place);
      expect(L.npcSpace(npc), npc).toBe(space);
      const talk = L.talkStand(npc);
      expect(L.placeAt(space, talk.pos[0], talk.pos[2]), npc).toBe(place);
      expect(L.placeAt(space, L.spawn(place).pos[0], L.spawn(place).pos[2]), place).toBe(place);
    }
    // the cook stands behind the noodle counter inside the shop, the counter from props/
    const cook = L.npcStand("cook").pos;
    expect(cook.map((v) => Math.round(v * 1000) / 1000)).toEqual([-0.5, 0.06, -4.3]);
    expect(L.space("noodle_shop").pieces.map((p) => p.asset)).toEqual(expect.arrayContaining(["noodle_shop_shell", "counter_noodle", "table_square"]));
  });

  it.skipIf(!index)("every place in the course's world has a space, and its spawn is at that place, clear of every other place's trigger", () => {
    const L = new LayoutIndex(LAYOUT, index!);
    for (const place of Object.keys(course.world.places)) {
      const space = L.spaceOf(place);
      expect(L.spaceIds(), place).toContain(space);
      const sp = L.spawn(place).pos;
      expect(L.placeAt(space, sp[0], sp[2]), `${place} spawn`).toBe(place);
      // nowhere near a trigger that would send the player on the moment they land (grown by the margin)
      for (const t of L.space(space).triggers) {
        const near = t.box.min[0] - ZONE_MARGIN <= sp[0] && sp[0] <= t.box.max[0] + ZONE_MARGIN && t.box.min[1] - ZONE_MARGIN <= sp[2] && sp[2] <= t.box.max[1] + ZONE_MARGIN;
        if (near) expect(t.place, `${place} spawn near ${t.kind} ${t.place}`).toBe(place);
      }
    }
    // every space is reachable from the street through doors / zones (and back out)
    const seen = new Set([STREET]);
    const queue = [STREET];
    while (queue.length) for (const t of L.space(queue.shift()!).triggers) {
      const next = L.spaceOf(t.place);
      if (!seen.has(next)) (seen.add(next), queue.push(next));
    }
    expect([...seen].sort()).toEqual([...L.spaceIds()].sort());
  });

  it.skipIf(!index)("trigger zones of different places never overlap, in any space", () => {
    const L = new LayoutIndex(LAYOUT, index!);
    for (const id of L.spaceIds()) {
      const ts = L.space(id).triggers;
      for (let i = 0; i < ts.length; i++)
        for (let j = i + 1; j < ts.length; j++) {
          // one place's zone may be several boxes (wrapped round another place's door); they may touch
          if (ts[i].place === ts[j].place) continue;
          // grown by the hysteresis margin too: two zones must not be within reach of one step
          const grow = (b: Box2): Box2 => ({ min: [b.min[0] - ZONE_MARGIN, b.min[1] - ZONE_MARGIN], max: [b.max[0] + ZONE_MARGIN, b.max[1] + ZONE_MARGIN] });
          expect(boxesOverlap(grow(ts[i].box), grow(ts[j].box)), `${id}: ${ts[i].place} / ${ts[j].place}`).toBe(false);
        }
    }
  });

  it.skipIf(!index)("every interior: entry spawn clear of its triggers and its furniture, each trigger reachable deep inside; the exit spawn clear of every door outside", () => {
    const L = new LayoutIndex(LAYOUT, index!);
    for (const [id, interior] of Object.entries(LAYOUT.interiors)) {
      const sp = L.space(id);
      const entry = L.entrySpawn(id).pos;
      expect(L.triggerAt(id, entry[0], entry[2], -ZONE_MARGIN), `${id} entry in a trigger`).toBeNull();
      const blockers = sp.pieces.flatMap((p) => (p.block === "size" ? [L.sizeBlocker(p)] : [])).filter((b): b is Box2 => !!b);
      const npcBoxes = sp.npcs.map((n) => {
        const p = L.npcStand(n).pos;
        return { min: [p[0] - 0.25, p[2] - 0.25], max: [p[0] + 0.25, p[2] + 0.25] } as Box2;
      });
      const free = (x: number, z: number) => !blocked(x, z, [...blockers, ...npcBoxes], sp.bounds);
      expect(free(entry[0], entry[2]), `${id} entry blocked at ${entry} by ${JSON.stringify([...blockers, ...npcBoxes].filter((b) => blocked(entry[0], entry[2], [b], sp.bounds)))}`).toBe(true);
      for (const n of sp.npcs) expect(free(L.talkStand(n).pos[0], L.talkStand(n).pos[2]), `${n} talk stand blocked`).toBe(true);
      // a door or zone inside a room (the stairwell door) has a free spot deep enough in it to fire (ZoneTracker)
      for (const t of sp.triggers) {
        let reach = false;
        for (let x = t.box.min[0] + ZONE_MARGIN; x <= t.box.max[0] - ZONE_MARGIN + 1e-9 && !reach; x += 0.05)
          for (let z = t.box.min[1] + ZONE_MARGIN; z <= t.box.max[1] - ZONE_MARGIN + 1e-9 && !reach; z += 0.05) reach = free(x, z);
        expect(reach, `${id} ${t.kind} ${t.place} can't be reached deep inside`).toBe(true);
      }
      // things to use are within reach of some free spot
      for (const x of sp.interactables) {
        let reach = false;
        for (let dx = -x.range; dx <= x.range && !reach; dx += 0.1)
          for (let dz = -x.range; dz <= x.range && !reach; dz += 0.1)
            reach = Math.hypot(dx, dz) <= x.range && free(x.pos[0] + dx, x.pos[2] + dz);
        expect(reach, `${id} ${x.kind} out of reach`).toBe(true);
      }
      const out = L.exitSpawn(id).pos;
      const outer = L.outerSpace(id)!;
      expect(L.triggerAt(outer, out[0], out[2], -ZONE_MARGIN)?.kind, `${id} exit spawn in a trigger`).not.toBe("door");
      expect(L.triggerAt(outer, out[0], out[2], -ZONE_MARGIN)?.kind, `${id} exit spawn in a trigger`).not.toBe("exit");
      expect(sp.triggers.find((t) => t.kind === "exit")?.place).toBe(L.placeAt(outer, out[0], out[2]));
      // the way out leads to a place core can reach from here (hop by hop: the room's door opens onto Main Street, off Market Street)
      expect(route(course.world, interior.place, L.placeAt(outer, out[0], out[2])).length, `${id} exits to ${L.placeAt(outer, out[0], out[2])}`).toBeGreaterThan(0);
      expect(interior.place in course.world.places).toBe(true);
    }
  });

  it.skipIf(!index)("held props: only carry-flagged ones play the carry pose (Wang holds the fan and stands normally)", () => {
    expect(heldProp(LAYOUT.npcs.wang.heldProp)).toEqual({ asset: "folding_fan", carry: false });
    for (const n of Object.values(LAYOUT.npcs)) {
      const p = heldProp(n.heldProp);
      if (p && ["folding_fan", "ladle", "key_ring", "clipboard"].includes(p.asset)) expect(p.carry, p.asset).toBe(false);
    }
    expect(heldProp({ asset: "box_small", carry: true })).toEqual({ asset: "box_small", carry: true });
  });
});
