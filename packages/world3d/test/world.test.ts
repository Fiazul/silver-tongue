// The walking side of the game, DOM-free: trigger zones (the thrash fix), town <-> interior
// transitions, the Go to list across the town (zones, travel-only spots), the objective line
// across a played day, prompts, street life motion, 3D wording, daylight.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { newGame, type GameEvent } from "@silver-tongue/core";
import { makeText } from "@silver-tongue/tui";
import { createGame } from "../src/game";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { daysToRent } from "../src/objective";
import { nearestPrompt, promptTargets, SpaceNav, ZONE_COOLDOWN, ZONE_MARGIN } from "../src/spaces";
import { KEY_HINT, TUI_ONLY, display } from "../src/strings";
import { ScatterMotion, WalkerMotion, WAIT_RANGE } from "../src/streetlife";
import { placeBubble, screenLayout } from "../src/ui/viewport";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, countingCore, course, makeGame, playScene, rightOption, rightTiles } from "./helpers";
import { createCore } from "@silver-tongue/core";

const named = () => ({ ...newGame(course), player: "Sam" });
const goTos = (sent: { type: string }[]) => sent.filter((i) => i.type === "goTo").length;
const centre = (b: { min: number[]; max: number[] }): [number, number] => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];

describe.skipIf(!assetIndex)("place triggers (the goTo thrash)", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const market = LAYOUT.places.market.zone!;

  it("a position oscillating across a zone boundary 100 times sends at most 2 goTo", () => {
    const { game, core } = makeGame(named());
    const nav = new SpaceNav(L, "street");
    const z = (market.min[1] + market.max[1]) / 2;
    const edge = market.min[0];
    const walk = (x: number) => {
      const go = nav.step(1 / 60, x, z);
      if (go) game.enterPlace(go);
    };
    walk(edge + 1); // well inside the market: one goTo
    for (let i = 0; i < 100; i++) walk(edge + (i % 2 ? 0.12 : -0.12)); // jitter on the boundary, both sides
    expect(goTos(core.sent)).toBeLessThanOrEqual(2);
    expect(core.state.place).toBe("market");
  });

  it("big swings every frame are rate-limited by the cooldown and end where the player is", () => {
    const { game, core } = makeGame(named());
    const nav = new SpaceNav(L, "street");
    const z = (market.min[1] + market.max[1]) / 2;
    const dt = 1 / 60;
    let x = 0;
    for (let i = 0; i < 100; i++) {
      x = market.min[0] + (i % 2 ? 1 : -1);
      const go = nav.step(dt, x, z);
      if (go) game.enterPlace(go);
    }
    expect(goTos(core.sent)).toBeLessThanOrEqual(Math.ceil((100 * dt) / ZONE_COOLDOWN) + 1);
    for (let i = 0; i < 60; i++) {
      const go = nav.step(dt, market.min[0] + 1, z); // settle inside
      if (go) game.enterPlace(go);
    }
    expect(core.state.place).toBe("market");
  });

  it("enterPlace is idempotent and not re-entrant (a change handler calling it back is dropped)", () => {
    let t = 1;
    const now = () => (t += 1000);
    const core = countingCore(createCore(course, named(), { now, rng: () => 0.5 }));
    let flips = 0;
    let game: ReturnType<typeof createGame> | undefined = undefined;
    game = createGame({
      course,
      core,
      now,
      // A handler that bounces the player straight back: without the guard, an endless goTo loop.
      onChange: () => {
        flips++;
        game?.enterPlace(core.state.place === "market" ? "street" : "market");
      },
    });
    const before = goTos(core.sent);
    game!.enterPlace("room"); // street -> market -> room
    expect(goTos(core.sent) - before).toBeLessThanOrEqual(3);
    expect(flips).toBeLessThan(10);
    game!.enterPlace(core.state.place); // already there: nothing
    expect(goTos(core.sent) - before).toBeLessThanOrEqual(3);
  });

  it("zones, doors and exits sit exactly as the margins need: well inside each trigger is reachable", () => {
    for (const id of L.spaceIds())
      for (const t of L.space(id).triggers) {
        const [cx, cz] = centre(t.box);
        // a travel-only spot is never walked into: it only holds its place
        if (t.kind === "stay") expect(L.holds(id, t.place, cx, cz, ZONE_MARGIN), `${id} stay ${t.place}`).toBe(true);
        else expect(L.triggerAt(id, cx, cz, ZONE_MARGIN)?.place, `${id} ${t.kind} ${t.place}`).toBe(t.place);
      }
  });

  it("a door inside a zone wins, and its margin band holds (no flip between the door and the zone round it)", () => {
    const { game, core } = makeGame({ ...named(), place: "market" });
    const nav = new SpaceNav(L, "market");
    const door = L.space(STREET).triggers.find((t) => t.kind === "door" && t.place === "noodle_shop")!;
    expect(L.placeAt(STREET, door.box.max[0] + 1, door.box.max[1] + 1)).toBe("market"); // the zone round it
    const [cx] = centre(door.box);
    const z = door.box.max[1];
    // jitter across the door's outer edge: never deep inside, so never in
    for (let i = 0; i < 100; i++) {
      const go = nav.step(1 / 60, cx, z + (i % 2 ? 0.12 : -0.12));
      if (go) game.enterPlace(go);
    }
    expect(goTos(core.sent)).toBe(0);
    expect(core.state.place).toBe("market");
  });

  it("a travel-only spot holds its place only while it is the place: walking onto it goes nowhere, walking off it goes back", () => {
    const pier = LAYOUT.places.warehouse.stay!;
    const [px, pz] = centre(pier);
    // walking onto the pier from the street: still the street
    const { game, core } = makeGame(named());
    const nav = new SpaceNav(L, "street");
    for (let i = 0; i < 60; i++) {
      const go = nav.step(1 / 60, px, pz);
      if (go) game.enterPlace(go);
    }
    expect(core.state.place).toBe("street");
    expect(goTos(core.sent)).toBe(0);
    // the Go to list: at the warehouse, on the pier; stepping about on it holds, walking off it is the street again
    game.travel();
    game.choose(game.model.choices!.items.findIndex((c) => c.input?.type === "goTo" && c.input.place === "warehouse"));
    expect(core.state.place).toBe("warehouse");
    const a = nav.sync("warehouse", { x: 0, z: 0 });
    expect(a).toMatchObject({ from: STREET, space: STREET, stand: L.spawn("warehouse") });
    const talk = L.talkStand("foreman").pos;
    expect(inBoxXZ(pier, talk[0], talk[2])).toBe(true);
    for (let i = 0; i < 60; i++) expect(nav.step(1 / 60, talk[0] + (i % 2 ? 0.2 : -0.2), talk[2])).toBeNull();
    let go: string | null = null;
    for (let i = 0; i < 60 && !go; i++) go = nav.step(1 / 60, -30, 0); // back on the west spoke
    expect(go).toBe("street");
  });
});

describe.skipIf(!assetIndex)("interiors: enter and leave", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);

  for (const [id, interior] of Object.entries(LAYOUT.interiors)) {
    it(`${id}: door outside -> fade -> inside at the entry -> way out -> outside, clear of the door`, () => {
      // Start in the space its door is in (Main Street; Station Road for the tea house; the room for the stairwell).
      const outer = L.outerSpace(id)!;
      const outside = L.defaultPlaceOf(outer);
      const { game, core } = makeGame({ ...named(), place: outside });
      const nav = new SpaceNav(L, outside);
      expect(nav.space).toBe(outer);
      const door = L.space(outer).triggers.find((t) => t.kind === "door" && t.place === interior.place)!;
      expect(door, `${id} has a door in ${outer}`).toBeDefined();
      const walk = (x: number, z: number, frames = 40) => {
        for (let i = 0; i < frames; i++) {
          const go = nav.step(1 / 60, x, z);
          if (go) game.enterPlace(go);
          const a = nav.sync(core.state.place);
          if (a) return a;
        }
        return null;
      };
      const into = walk(...centre(door.box));
      expect(core.state.place).toBe(interior.place);
      expect(into).toMatchObject({ from: outer, space: id });
      expect(into!.stand).toEqual(L.entrySpawn(id));
      expect(nav.space).toBe(id);
      // standing at the entry doesn't bounce the player straight out
      expect(walk(into!.stand.pos[0], into!.stand.pos[2], 90)).toBeNull();
      expect(core.state.place).toBe(interior.place);
      const exit = L.space(id).triggers.find((t) => t.kind === "exit")!;
      const out = walk(...centre(exit.box));
      expect(out).toMatchObject({ from: id, space: outer });
      expect(out!.stand).toEqual(L.exitSpawn(id));
      expect(core.state.place).toBe(exit.place);
      // out on the street past the door: no re-entry
      const sent = goTos(core.sent);
      expect(walk(out!.stand.pos[0], out!.stand.pos[2], 90)).toBeNull();
      expect(goTos(core.sent)).toBe(sent);
    });
  }

  it("a save made inside resumes inside (jump), and travel from the list lands in the right space, at the place", () => {
    const nav = new SpaceNav(L, "room");
    expect(nav.space).toBe("room");
    expect(nav.jump("room").stand).toEqual(L.entrySpawn("room"));
    const { game, core } = makeGame({ ...named(), place: "room" });
    const go = (place: string) => {
      game.travel();
      const i = game.model.choices!.items.findIndex((c) => c.input?.type === "goTo" && c.input.place === place);
      expect(i, place).toBeGreaterThanOrEqual(0);
      game.choose(i);
      expect(core.state.place).toBe(place);
    };
    // out of the room to a travel-only place: the town, on its spot
    go("warehouse");
    const e = L.entrySpawn("room").pos;
    expect(nav.sync("warehouse", { x: e[0], z: e[2] })).toMatchObject({ from: "room", space: STREET, stand: L.spawn("warehouse") });
    expect(nav.sync("warehouse", { x: L.spawn("warehouse").pos[0], z: L.spawn("warehouse").pos[2] })).toBeNull();
    expect(nav.exitPlace()).toBeNull();
    // across the town: a zone the player isn't standing in moves them to its spawn; one they stand in doesn't
    const at = L.spawn("warehouse").pos;
    go("market");
    const a = nav.sync("market", { x: at[0], z: at[2] });
    expect(a).toMatchObject({ from: STREET, space: STREET, stand: L.spawn("market") });
    const m = L.spawn("market").pos;
    expect(L.placeAt(STREET, m[0], m[2])).toBe("market");
    go("station");
    expect(nav.sync("station", { x: L.spawn("station").pos[0], z: L.spawn("station").pos[2] })).toBeNull();
  });

  it("prompts: talk near an NPC, enter at a door, sleep at the bed only where core allows it, the desk notebook", () => {
    const street = promptTargets(L, STREET, false);
    const wang = L.talkStand("wang").pos;
    expect(nearestPrompt(L, STREET, street, wang[0], wang[2])?.id).toBe("talk:wang");
    const door = L.space(STREET).triggers.find((t) => t.kind === "door" && t.place === "noodle_shop")!;
    const [dx, dz] = centre(door.box);
    expect(nearestPrompt(L, STREET, street, dx, door.box.max[1] + 0.5)?.id).toBe("enter:noodle_shop");
    expect(dz).toBeLessThan(door.box.max[1]);
    const bed = L.space("room").interactables.find((x) => x.kind === "sleep")!;
    expect(promptTargets(L, "room", false).some((t) => t.kind === "sleep")).toBe(false);
    const room = promptTargets(L, "room", true);
    expect(room.map((t) => t.kind)).toEqual(expect.arrayContaining(["talk", "exit", "sleep", "notebook"]));
    expect(nearestPrompt(L, "room", room, bed.pos[0] + 0.6, bed.pos[2])?.kind).toBe("sleep");
  });
});

const inBoxXZ = (b: { min: number[]; max: number[] }, x: number, z: number) => x >= b.min[0] && x <= b.max[0] && z >= b.min[1] && z <= b.max[1];

/**
 * Walks to `place` the way a player would: through the triggers of each space in turn (a door, a
 * zone, a way out), standing well inside each one until the zone tracker fires. Spaces are found
 * by a search over the triggers (which space each one's place is shown in), so it crosses the
 * town, the rooms and the stairwell alike. A travel-only place (no building in the town) is taken
 * from the Go to list, as a player would.
 */
function walker(L: LayoutIndex, game: ReturnType<typeof createGame>, nav: SpaceNav) {
  const core = game.core;
  /** the first trigger on the way from space `from` to space `to` */
  const firstStep = (from: string, to: string) => {
    const prev = new Map<string, { space: string; trigger: ReturnType<LayoutIndex["space"]>["triggers"][number] } | null>([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const trigger of L.space(cur).triggers) {
        const next = L.spaceOf(trigger.place);
        if (prev.has(next)) continue;
        prev.set(next, { space: cur, trigger });
        if (next === to) {
          let step = prev.get(next)!;
          while (step.space !== from) step = prev.get(step.space)!;
          return step.trigger;
        }
        queue.push(next);
      }
    }
    throw new Error(`no way from ${from} to ${to}`);
  };
  const stand = (x: number, z: number) => {
    for (let i = 0; i < 40; i++) {
      const go = nav.step(1 / 60, x, z);
      if (go) game.enterPlace(go);
      nav.sync(core.state.place);
    }
  };
  return (place: string) => {
    if (L.travelOnly(place) && core.state.place !== place) {
      game.travel();
      game.choose(game.model.choices!.items.findIndex((c) => c.input?.type === "goTo" && c.input.place === place));
      const a = nav.sync(core.state.place);
      const s = a?.stand.pos ?? L.spawn(place).pos;
      stand(s[0], s[2]); // on its spot: it holds
    }
    for (let hop = 0; hop < 8 && core.state.place !== place; hop++) {
      const target = L.spaceOf(place);
      if (nav.space === target) {
        const trig = L.space(nav.space).triggers.find((x) => x.place === place && x.kind !== "exit");
        // a space's default place has no trigger: step off every trigger, onto its spawn
        const at = trig ? centre(trig.box) : ([L.spawn(place).pos[0], L.spawn(place).pos[2]] as [number, number]);
        stand(...at);
      } else stand(...centre(firstStep(nav.space, target).box));
    }
    expect(core.state.place).toBe(place);
    expect(nav.space).toBe(L.spaceOf(place));
  };
}

describe.skipIf(!assetIndex)("a day played through: the objective line at every step", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);

  it("name -> meet Wang (3 scenes) -> noodle intro -> home -> sleep (day card) -> day 2 shift", () => {
    const { game, core } = makeGame(newGame(course), 50_000_000);
    const { s, t } = game;
    const obj = () => game.model.objective.text;
    const events: GameEvent[] = [];
    const nav = new SpaceNav(L, core.state.place);
    const task = (id: string) => t(`scene-${id}`);
    const rent = { currency: course.world.currency, rent: course.world.rentPerWeek };
    const walkTo = walker(L, game, nav);
    const play = (npc: string) => {
      const n = game.model.events.length;
      const want = game.model.objective.scene;
      game.talkTo(npc);
      // Several things to talk about: the list; pick the one the objective points at.
      if (game.model.choices) game.choose(game.model.choices.items.findIndex((c) => c.input?.type === "startScene" && c.input.scene === want));
      expect(obj()).toBe(s("obj-in-scene", { npc: game.npcName(npc) }));
      playScene(game);
      events.push(...game.model.events.slice(n));
    };

    expect(obj()).toBe(s("obj-name"));
    expect(game.model.objective.sub).toBe(s("obj-rent-due", { ...rent, n: daysToRent(1) }));
    game.setName("Sam");
    expect(obj()).toBe(s("obj-talk", { task: task("street-hello"), npc: "Old Wang" }));
    play("wang");
    expect(obj()).toBe(s("obj-talk", { task: task("street-hungry"), npc: "Old Wang" }));
    play("wang");
    expect(obj()).toBe(s("obj-talk", { task: task("street-numbers"), npc: "Old Wang" }));
    play("wang");
    expect(obj()).toBe(s("obj-go", { place: t("place-noodle_shop"), npc: game.npcName("cook"), task: task("noodle-intro") }));
    walkTo("noodle_shop");
    expect(nav.space).toBe("noodle_shop");
    expect(obj()).toBe(s("obj-talk", { task: task("noodle-intro"), npc: game.npcName("cook") }));
    play("cook");
    expect(game.model.hud.slotsLeft).toBe(0);
    expect(obj()).toBe(s("obj-go-home", { place: t("place-room") }));
    walkTo("room");
    expect(nav.space).toBe("room");
    expect(obj()).toBe(s("obj-sleep-here"));
    expect(game.model.canSleep).toBe(true);
    const wallet = core.state.wallet;
    game.sleep();
    expect(game.model.dayChanges).toBe(1);
    expect(game.model.dayCard).toMatchObject({ day: 1, food: course.world.foodPerDay, rent: 0, rentLate: false, wallet: wallet - course.world.foodPerDay });
    expect(game.model.dayCard!.change).toBe(core.state.wallet - 20);
    expect(game.model.walletFx.at(-1)?.delta).toBe(-course.world.foodPerDay);
    expect(game.model.hud.day).toBe(2);
    // day 2: the landlord is right here
    expect(obj()).toBe(s("obj-talk", { task: task("room-hello"), npc: game.npcName("landlord") }));
    play("landlord");
    expect(obj()).toBe(s("obj-go", { place: t("place-warehouse"), npc: game.npcName("foreman"), task: task("warehouse-intro") }));
    // a paid shift at the noodle shop instead
    walkTo("noodle_shop");
    const before = core.state.wallet;
    play("cook");
    expect(events.some((e) => e.type === "walletChanged" && e.reason === "wages")).toBe(true);
    expect(core.state.wallet).toBeGreaterThan(before);
    expect(game.model.walletFx.at(-1)!.delta).toBeGreaterThan(0);
    expect(core.state.scenesDone["noodle-shift"]).toBe(1);
  });

  it("an errand end to end (pick up from Miss Gao, carry it to the drop-off, hand it over) and a shop purchase", () => {
    // Miss Gao has told you about deliveries, and the shopkeeper knows you: the paid parts are open.
    const { game, core } = makeGame(
      { ...named(), wallet: 30, scenesDone: { "delivery-intro": 1, "shop-intro": 1 }, trust: { dispatcher: 1, shopkeeper: 1 } },
      70_000_000,
    );
    const { s, t } = game;
    const obj = () => game.model.objective.text;
    const nav = new SpaceNav(L, core.state.place);
    const walkTo = walker(L, game, nav);
    const play = (npc: string) => {
      const want = game.model.objective.scene;
      game.talkTo(npc);
      if (game.model.choices) game.choose(game.model.choices.items.findIndex((c) => c.input?.type === "startScene" && c.input.scene === want));
      playScene(game);
    };

    // the pickup: Miss Gao's fruit stall on the south bank
    walkTo("market");
    expect(nav.space).toBe(STREET);
    expect(game.model.hud.errand).toBeNull();
    const n = game.model.events.length;
    game.talkTo("dispatcher");
    expect(core.state.run?.scene).toBe("delivery-pickup");
    playScene(game);
    const started = game.model.events.slice(n).find((e) => e.type === "errandStarted");
    expect(started).toBeDefined();
    const to = core.state.errand!.to;
    expect(started).toEqual({ type: "errandStarted", to });
    expect(course.world.places[to]).toBeDefined();
    expect(game.model.feed.map((f) => f.text)).toContain(t("errand-started"));
    // the HUD chip and the objective say where it goes
    expect(game.model.hud.errand).toEqual({ to, placeName: t(`place-${to}`) });
    const drop = course.scenes.find((x) => x.endsErrand && x.place === to)!;
    expect(obj()).toBe(s("obj-deliver", { place: t(`place-${to}`), npc: game.npcName(drop.npc) }));
    expect(game.model.objective.scene).toBe(drop.id);

    // to the drop-off: the bus stop, or the Go to list for the school / hospital by the pavilion
    walkTo(to);
    expect(nav.space).toBe(STREET);
    expect(obj()).toBe(s("obj-deliver-here", { npc: game.npcName(drop.npc) }));
    const m = game.model.events.length;
    const wallet = core.state.wallet;
    play(drop.npc);
    const after = game.model.events.slice(m);
    expect(after).toContainEqual({ type: "errandEnded", to });
    expect(core.state.errand).toBeUndefined();
    expect(game.model.hud.errand).toBeNull();
    expect(game.model.feed.map((f) => f.text)).toContain(t("errand-ended"));
    // the wage floats, marked as a delivery
    const wage = game.model.walletFx.find((fx) => fx.reason === "wages" && fx.label === s("fx-delivery"));
    expect(wage?.delta).toBeGreaterThan(0);
    expect(core.state.wallet).toBe(wallet + wage!.delta);

    // across the town and into the corner shop: a purchase
    walkTo("shop");
    expect(nav.space).toBe("shop");
    game.talkTo("shopkeeper");
    expect(core.state.run?.scene).toBe("shop-buy");
    const cost = game.model.reply!.cost!;
    expect(cost).toBeGreaterThanOrEqual(3); // the price slot, 3-5
    expect(cost).toBeLessThanOrEqual(5);
    const before = core.state.wallet;
    playScene(game);
    expect(core.state.wallet).toBe(before - cost);
    const spent = game.model.walletFx.find((fx) => fx.reason === "shopping");
    expect(spent).toMatchObject({ delta: -cost, label: t("reason-shopping") });
    // and out again: the shop's open front leads back into the town
    walkTo("market");
    expect(nav.space).toBe(STREET);
  });
});

describe("street life motion", () => {
  it("walkers pace their path there and back and wait while the player is in the way", () => {
    const w = new WalkerMotion([
      [0, 0],
      [4, 0],
    ], 1);
    for (let i = 0; i < 60; i++) w.update(1 / 60, 50, 50);
    expect(w.x).toBeCloseTo(1, 1);
    expect(w.update(1 / 60, w.x + WAIT_RANGE - 0.3, 0)).toBe(0); // player ahead: stop and wait
    expect(w.waiting).toBe(true);
    expect(w.update(1 / 60, w.x - 1, 0)).toBeGreaterThan(0); // player behind: carry on
    for (let i = 0; i < 400; i++) w.update(1 / 60, 50, 50);
    expect(w.x).toBeLessThan(4); // turned round at the end
  });

  it("pigeons scatter within 2 m of the player and drift home once they're gone", () => {
    const p = new ScatterMotion([0, 0]);
    for (let i = 0; i < 30; i++) p.update(1 / 60, 1, 0);
    expect(p.away).toBeGreaterThan(0.5);
    expect(p.x).toBeLessThan(0); // away from the player
    for (let i = 0; i < 60 * 20; i++) p.update(1 / 60, 30, 30);
    expect(p.away).toBeLessThan(0.1);
  });
});

describe("3D wording", () => {
  it("no text the 3D world shows carries a TUI key hint ([w], [s], [enter], number keys)", () => {
    const t = display(makeText(course.learnerFtl, course.learner));
    const ids = [...course.learnerFtl.matchAll(/^([a-z][\w-]*)\s*=/gm)].map((m) => m[1]);
    const shown = ids.filter((id) => !id.startsWith("keys-") && !TUI_ONLY.has(id));
    expect(shown.length).toBeGreaterThan(50);
    for (const id of shown) expect(t(id), id).not.toMatch(KEY_HINT);
    // the intro narration names the taps instead
    expect(t("scene-street-hello-start")).toMatch(/Tap a word/);
  });

  it("the narration override reaches the feed when Old Wang's first scene starts", () => {
    const { game } = makeGame(named());
    game.talkTo("wang");
    const story = game.model.feed.filter((f) => f.kind === "sceneStarted").map((f) => f.text);
    expect(story.join(" ")).toMatch(/Tap a word/);
    expect(story.join(" ")).not.toMatch(KEY_HINT);
  });
});

/** Same technique as scene.test.ts: real GLBs, read from disk instead of fetched (no network / DOM). */
async function buildSpace(L: LayoutIndex, id: string): Promise<SceneSpace> {
  const assets = new AssetCache(ASSETS, L);
  const loader = (assets as unknown as { loader: { parseAsync(d: ArrayBuffer, p: string): Promise<unknown>; loadAsync(u: string): Promise<unknown> } }).loader;
  loader.loadAsync = (url: string) => {
    const buf = readFileSync(url);
    return loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
  };
  await assets.preload();
  return SceneSpace.create(L, assets, id);
}

describe.skipIf(!assetIndex)("bug 1 category: a scene started through the topic picker never crashes bubble positioning", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);

  /** Mirrors main.ts's per-frame bubble block after the fix: a missing NPC lookup pins top-centre
   * through placeBubble instead of throwing or freezing wherever the bubble last was. */
  function positionBubble(space: SceneSpace, npc: string | null, camera: THREE.Camera, area = screenLayout(1024, 768).bubble, size = { w: 200, h: 90 }) {
    if (!npc) return null;
    const head = new THREE.Vector3();
    const found = !!space.head(npc, head);
    let x = 0,
      y = 0,
      visible = false;
    if (found) {
      head.y += 0.25;
      const v = head.clone().project(camera);
      x = ((v.x + 1) / 2) * 1024;
      y = ((1 - v.y) / 2) * 768;
      visible = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    }
    return placeBubble(x, y, visible, size.w, size.h, area);
  }

  it("talking to Old Wang a second time (2+ topics: the picker, not the single-item intro) runs bubble positioning every frame, both reply modes, without throwing", async () => {
    const street = await buildSpace(L, "street");
    const { game } = makeGame(named());
    // Intro: a single item, auto-starts (no model.choices) - the path that never crashed.
    expect(game.model.choices).toBeNull();
    game.talkTo("wang");
    expect(game.model.scene?.id).toBe("street-hello");
    playScene(game);

    // Now several things to talk about: the topic picker. Pick the non-primary, repeatable one
    // ("street-practice"), reached only through the picker - never through the single-item intro.
    game.talkTo("wang");
    expect(game.model.choices).not.toBeNull();
    expect(game.model.choices!.items.length).toBeGreaterThan(1);
    const pick = game.model.choices!.items.findIndex((c) => c.input?.type === "startScene" && c.input.scene === "street-practice");
    expect(pick).toBeGreaterThanOrEqual(0);
    game.choose(pick);
    expect(game.model.scene?.id).toBe("street-practice");
    expect(game.model.bubble?.npc).toBe("wang");

    const camera = new THREE.PerspectiveCamera(30, 1024 / 768, 0.1, 200);
    const w = L.npcStand("wang").pos;
    let sawOnScreen = false;
    let frames = 0;
    // A camera swinging round wang's head (headVisible flips both ways) for several simulated
    // frames per exchange, driving both "pick" and "tiles" reply modes through to the scene's end -
    // the crash fired every animation frame for the whole time a picker-started scene was on screen.
    for (let guard = 0; game.core.state.run && guard < 20; guard++) {
      for (let f = 0; f < 12; f++, frames++) {
        const angle = frames * 0.4;
        camera.position.set(w[0] + Math.sin(angle) * 6, w[1] + 3 + Math.cos(angle * 0.7), w[2] + Math.cos(angle) * 6);
        camera.lookAt(w[0], w[1] + 1.7, w[2]);
        camera.updateMatrixWorld();
        const npc = game.model.bubble?.npc ?? null;
        expect(npc).toBe("wang");
        expect(() => positionBubble(street, npc, camera)).not.toThrow();
        const p = positionBubble(street, npc, camera)!;
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        if (!p.pinned) sawOnScreen = true;
      }
      const mode = game.model.reply?.mode;
      if (mode === "tiles") game.replyTiles(rightTiles(game));
      else {
        expect(mode).toBe("pick");
        game.reply(rightOption(game));
      }
    }
    expect(game.core.state.run).toBeNull(); // the scene finished
    expect(frames).toBeGreaterThan(0);
    expect(sawOnScreen).toBe(true); // the camera did face wang at least once: a real, not degenerate, run

    // The category this bug represents: the NPC actor lookup can come back undefined (a scene's
    // npc not in *this* SceneSpace - a different room, or mid space-swap, or after world3d.teleport()
    // without a zone sync). placeBubble must still just pin, never throw.
    expect(street.head("nobody-here", new THREE.Vector3())).toBeUndefined();
    expect(() => positionBubble(street, "nobody-here", camera)).not.toThrow();
    expect(positionBubble(street, "nobody-here", camera)!.pinned).toBe(true);
  });
});

type LightPeek = { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight };
const peekLights = (s: SceneSpace) => s as unknown as LightPeek;

describe.skipIf(!assetIndex)("bug 2: daylight is clearly perceptible at each quarter, not a barely-moved 2-stop lerp", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const quarters = [0, 0.25, 0.5, 0.75, 1];

  it("street: sky, ground, sun colour, sun intensity, background and fog are all pairwise distinct across the 5 quarter points", async () => {
    const street = await buildSpace(L, "street");
    const { hemi, sun } = peekLights(street);
    const snap = () => ({
      sky: hemi.color.getHexString(),
      ground: hemi.groundColor.getHexString(),
      sun: sun.color.getHexString(),
      intensity: sun.intensity,
      sunY: sun.position.y,
      background: (street.scene.background as THREE.Color).getHexString(),
      fog: street.scene.fog instanceof THREE.Fog ? street.scene.fog.color.getHexString() : null,
    });
    const snaps = quarters.map((t) => {
      street.setDaylight(t);
      return snap();
    });
    for (const key of ["sky", "ground", "sun", "background", "fog"] as const) {
      const values = snaps.map((s) => s[key]);
      expect(new Set(values).size, key).toBe(values.length); // every quarter reads differently
    }
    const intensities = snaps.map((s) => s.intensity);
    expect(new Set(intensities).size).toBe(intensities.length);
    expect(intensities.at(-1)).toBeLessThan(intensities[0]); // evening dimmer than morning
    // the sun swings low toward evening (a longer-shadow feel) after peaking near midday
    const sunYs = snaps.map((s) => s.sunY);
    expect(sunYs.at(-1)).toBe(Math.min(...sunYs));
    expect(sunYs.at(-1)).toBeLessThan(sunYs[0]);
    expect(Math.max(...sunYs)).toBeGreaterThan(sunYs[0]); // brighter/higher than morning somewhere near midday
    // world3d.setDaylight(t) (main.ts) is wired straight to this same method, for the browser worker.
    const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(mainSrc).toMatch(/setDaylight:\s*\(t: number\) => space\.setDaylight\(t\)/);
    // cheap: no shadow maps anywhere in the 3D world module.
    const worldSrc = readFileSync(new URL("../src/world.ts", import.meta.url), "utf8");
    expect(worldSrc).not.toMatch(/castShadow\s*=\s*true/);
    expect(worldSrc).not.toMatch(/shadowMap/);
  });

  it("an interior shifts less than the street, and keeps its own wall colour (background/fog untouched)", async () => {
    const room = await buildSpace(L, "room");
    const before = (room.scene.background as THREE.Color).clone();
    const { hemi } = peekLights(room);
    room.setDaylight(0);
    const skyAtMorning = hemi.color.clone();
    room.setDaylight(1);
    const skyAtEvening = hemi.color.clone();
    const roomDelta = skyAtMorning.r - skyAtEvening.r + (skyAtMorning.g - skyAtEvening.g) + (skyAtMorning.b - skyAtEvening.b);

    const street = await buildSpace(L, "street");
    const { hemi: streetHemi } = peekLights(street);
    street.setDaylight(0);
    const streetMorning = streetHemi.color.clone();
    street.setDaylight(1);
    const streetEvening = streetHemi.color.clone();
    const streetDelta = streetMorning.r - streetEvening.r + (streetMorning.g - streetEvening.g) + (streetMorning.b - streetEvening.b);

    expect(Math.abs(roomDelta)).toBeLessThan(Math.abs(streetDelta)); // interiors shift less (0.45x)
    expect((room.scene.background as THREE.Color).equals(before)).toBe(true); // an interior's wall colour never tints
    expect(room.scene.fog).toBeNull(); // no depth fog indoors
  });
});
