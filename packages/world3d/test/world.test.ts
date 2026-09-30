// The walking side of the game, DOM-free: trigger zones (the thrash fix), town <-> interior
// transitions, the Go to list across the town (zones, travel-only spots), the objective line
// across a played day, prompts, street life motion, 3D wording, daylight.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newGame, type GameEvent } from "@silver-tongue/core";
import { makeText } from "@silver-tongue/tui";
import { createGame } from "../src/game";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { daysToRent } from "../src/objective";
import { nearestPrompt, promptTargets, SpaceNav, ZONE_COOLDOWN, ZONE_MARGIN } from "../src/spaces";
import { KEY_HINT, TUI_ONLY, display } from "../src/strings";
import { ScatterMotion, WalkerMotion, WAIT_RANGE } from "../src/streetlife";
import { placeBubble, screenLayout } from "../src/ui/viewport";
import { AssetCache, drawCalls, mergeStatic, SceneSpace } from "../src/world";
import { CameraRig } from "../src/camera";
import { LOOK, lookFor, resolveLook } from "../src/look";
import { ASYNC_RETRY_MS, FENCE_TIMEOUT_MS, MAX_SAMPLE_AGE_MS, SEE_SILHOUETTE_CODE, fadeTexture, idHistogram, isSeeThrough, SEE_ATTR, SEE_ID0, SEE_NEVER, SEE_THROUGH, seeThroughCompile, SeeThroughControl, SeeThroughDetector, seeUniforms, silhouetteProjection, type Occluder, type SeeSample } from "../src/seethrough";
import { ASSETS, assetIndex, readGlb, countingCore, course, makeGame, playScene, rightOption, rightTiles } from "./helpers";
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

  it("name -> meet Wang (3 scenes) -> noodle intro -> sleep rough (day card) -> day 2 the landlord's key -> shift", () => {
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
    // No home yet (world.homeScene, the landlord's key, not done): the night is spent right here.
    expect(core.state.scenesDone[course.world.homeScene!]).toBeUndefined();
    expect(obj()).toBe(s("obj-sleep-rough"));
    expect(game.model.canSleep).toBe(true);
    const wallet = core.state.wallet;
    game.sleep();
    expect(game.model.dayChanges).toBe(1);
    expect(game.model.feed.map((f) => f.text)).toContain(t("day-ended-rough", { day: 1 }));
    expect(game.model.dayCard).toMatchObject({ day: 1, food: course.world.foodPerDay, rent: 0, rentLate: false, wallet: wallet - course.world.foodPerDay });
    expect(game.model.dayCard!.change).toBe(core.state.wallet - 20);
    expect(game.model.walletFx.at(-1)?.delta).toBe(-course.world.foodPerDay);
    expect(game.model.hud.day).toBe(2);
    // day 2: the landlord hands over the key at the room
    expect(obj()).toBe(s("obj-go", { place: t("place-room"), npc: game.npcName("landlord"), task: task("room-hello") }));
    walkTo("room");
    expect(obj()).toBe(s("obj-talk", { task: task("room-hello"), npc: game.npcName("landlord") }));
    play("landlord");
    // a home now: out of slots means going back to the room's bed
    expect(game.model.canSleep).toBe(true);
    walkTo("noodle_shop");
    expect(game.model.canSleep).toBe(false);
    expect(obj()).toBe(s("obj-go", { place: t("place-warehouse"), npc: game.npcName("foreman"), task: task("warehouse-intro") }));
    // a paid shift at the noodle shop instead
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

  it("a mix-up's hint names who asked (0.14 asked-* take { $npc }); no unfilled variable", () => {
    expect([...course.learnerFtl.matchAll(/^asked-[\w-]+ = .*\{ \$npc \}/gm)].length).toBeGreaterThan(0);
    // Old Wang's first exchange, its asked-* line rewritten to take the NPC as the 0.14 ones do.
    const id = `asked-${course.scenes.find((x) => x.id === "street-hello")!.exchanges[0].expect.action}`;
    expect(course.learnerFtl).toMatch(new RegExp(`^${id} =`, "m"));
    const withNpc = { ...course, learnerFtl: course.learnerFtl.replace(new RegExp(`^${id} = .*$`, "m"), `${id} = { $npc } was asking.`) };
    let t = 1_000_000;
    const now = () => (t += 1000);
    const core = createCore(withNpc, named(), { now, rng: () => 0.42 });
    const game = createGame({ course: withNpc, core, now });
    game.talkTo("wang");
    const n = game.model.feed.length;
    game.reply(rightOption(game) === 0 ? 1 : 0);
    const bad = game.model.feed.slice(n).filter((f) => f.kind === "actionPerformed" && f.tone === "bad").map((f) => f.text);
    expect(bad).toEqual([`${game.npcName("wang")} was asking.`]);
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
  const assets = new AssetCache(ASSETS, L, { read: readGlb });
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
    // cheap: no shadow maps in the classic (toon) tier. This street was built at classic (look.ts:
    // no page, or `?look=classic`, or the saved Classic: the same LookState). Nothing in it casts or
    // receives, the sun included; the real look (the full / lite tiers) turns them on only behind
    // LOOK.real: in world.ts every shadow flag outside setupRealLook (itself called only under
    // LOOK.real) sits on a LOOK.real-gated line, and the renderer's shadow map lives in reallook.ts.
    expect(LOOK.tier).toBe("classic");
    for (const classic of [LOOK, resolveLook("?look=classic", "full", { coarse: false }), resolveLook("", "classic", { coarse: false }), lookFor("classic", "pref", "")]) {
      expect(classic.tier).toBe("classic");
      expect(classic.real).toBe(false);
      expect(classic.ramp).toBe(false);
      expect(classic.env).toEqual([]);
    }
    expect(sun.castShadow).toBe(false);
    let flagged = 0;
    street.scene.traverse((o) => void ((o.castShadow || o.receiveShadow) && flagged++));
    expect(flagged).toBe(0);
    const worldSrc = readFileSync(new URL("../src/world.ts", import.meta.url), "utf8");
    expect(worldSrc).not.toMatch(/shadowMap/);
    const setup = worldSrc.indexOf("private setupRealLook()");
    expect(setup).toBeGreaterThan(0);
    expect(worldSrc.match(/this\.setupRealLook\(\)/g)?.length).toBe(1);
    expect(worldSrc).toMatch(/if \(LOOK\.real\) this\.setupRealLook\(\);/);
    const setupEnd = worldSrc.indexOf("\n  }\n", setup);
    const outside = worldSrc.slice(0, setup) + worldSrc.slice(setupEnd);
    const shadowLines = outside.split("\n").filter((l) => /(castShadow|receiveShadow)\s*=/.test(l));
    expect(shadowLines.length).toBeGreaterThan(0);
    for (const l of shadowLines) expect(l, l.trim()).toMatch(/if \(LOOK\.real\)/);
    // The environment layers (envlook.ts: the tier's, or `?env=...`) are reachable only under
    // LOOK.real: LOOK.env is empty at classic; envlook.ts is imported by reallook.ts alone (itself
    // loaded, made and prepared only behind LOOK.real); every layer is built behind its own
    // `want.has(...)` (the town's also behind `town`), bloom / grade passes only when on; the space
    // data they read (lookGround) is written in setupRealLook only; neither chunk value-imports a
    // main-bundle module (it would split it off).
    expect(street.scene.userData.lookGround).toBeUndefined();
    expect(street.scene.getObjectByName("env_sky") ?? street.scene.getObjectByName("env_grass_near") ?? street.scene.getObjectByName("env_leaves")).toBeUndefined();
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const importers = ["main.ts", "world.ts", "game.ts", "camera.ts", "seethrough.ts", "look.ts", "layout.ts", "reallook.ts"].filter((f) => /from "\.\/envlook"/.test(src(f)));
    expect(importers).toEqual(["reallook.ts"]);
    expect(mainSrc).toMatch(/const real = LOOK\.real \? \(madeReal \?\?= \(await import\("\.\/reallook"\)\)\.createRealLook\(/);
    expect(mainSrc.match(/import\("\.\/reallook"\)\)\.createRealLook/g)?.length).toBe(1);
    expect(mainSrc).toMatch(/if \(real\) await prepareLook\(real,/);
    expect(mainSrc.match(/prepareLook\(/g)?.length).toBe(1); // that one call, behind `real`
    expect(mainSrc).not.toMatch(/from "\.\/reallook"/);
    const envSrc = src("envlook.ts");
    const realSrc = src("reallook.ts");
    // the chunk's own modules only: envlook.ts, envcache.ts (the env build's IndexedDB cache), neither imported by the main bundle
    for (const s of [envSrc, realSrc]) for (const m of s.matchAll(/^import (?!type )[^;]*from "(\.[^"]+)"/gm)) expect(["./envlook", "./envcache"], m[0]).toContain(m[1]);
    expect(["main.ts", "world.ts", "game.ts", "camera.ts", "seethrough.ts", "look.ts", "layout.ts"].filter((f) => /from "\.\/envcache"/.test(src(f)))).toEqual([]);
    for (const layer of ["ground", "grass", "leaves", "sky", "particles"]) expect(envSrc, layer).toMatch(new RegExp(`if \\(town && want\\.has\\("${layer}"\\)\\)`));
    for (const layer of ["bloom", "grade"]) {
      expect(envSrc, layer).toMatch(new RegExp(`if \\(want\\.has\\("${layer}"\\)\\)`));
      expect(realSrc, layer).toMatch(new RegExp(`= layers\\.has\\("${layer}"\\) \\? (new |\\{)`));
      expect(realSrc.match(new RegExp(`layers\\.has\\("${layer}"\\)`, "g"))?.length, layer).toBe(1);
    }
    expect(realSrc).toMatch(/if \(!layers\.size \|\| !scene\.userData\.lookSky\) return undefined;/);
    expect(worldSrc.match(/userData\.lookGround/g)?.length).toBe(1);
    expect(worldSrc.indexOf("userData.lookGround")).toBeGreaterThan(setup);
    expect(worldSrc.indexOf("userData.lookGround")).toBeLessThan(setupEnd);
  });

  it.skipIf(!assetIndex)("real look environment (envlook.ts): the town's layers build on the real street; grass only on the lawn, never on the path or a footprint; leaves fade with their tree; lite (from the start, or the valve's live drop) keeps ground, grass at half, sky, grade", async () => {
    vi.resetModules();
    vi.doMock("../src/look", async (orig) => ({ ...(await orig<typeof import("../src/look")>()), LOOK: { ...lookFor("full", "url", "test"), env: [] } }));
    try {
      const world = await import("../src/world");
      const layout = await import("../src/layout");
      const see = await import("../src/seethrough");
      const env = await import("../src/envlook");
      const look = await import("../src/look");
      const L2 = new layout.LayoutIndex(layout.LAYOUT, assetIndex!);
      const assets = new world.AssetCache(ASSETS, L2, { read: readGlb });
      await assets.preload();
      const space = await world.SceneSpace.create(L2, assets, STREET);
      const scene = space.scene;
      const ground = scene.userData.lookGround;
      expect(ground.town).toBe(true);
      // the field: the player's spot on Market Street is path, the noodle shop's floor is no lawn, the lawn west of the great tree is
      const field = env.buildField(scene, ground);
      const at = (x: number, z: number) => field.grass[Math.floor((z - env.FIELD.min) / (env.FIELD.size / env.FIELD.n)) * env.FIELD.n + Math.floor((x - env.FIELD.min) / (env.FIELD.size / env.FIELD.n))];
      expect(at(-15.5, 31.5)).toBe(0);
      expect(at(-17, 27)).toBe(0);
      expect(at(-24, 5)).toBe(1);
      expect(at(-17.2, 6.3)).toBe(0); // the trunk
      const aoHidden: THREE.Material[] = [];
      const material = (re: RegExp) => {
        let found: THREE.MeshStandardMaterial | undefined;
        scene.traverse((o) => void (!found && (o as THREE.Mesh).isMesh && re.test(((o as THREE.Mesh).material as THREE.Material).name) && (found = (o as THREE.Mesh).material as THREE.MeshStandardMaterial)));
        return found!;
      };
      const crown = material(/^(canopy_green|leaf_green|leaf_dark|leaf_pale|town_willow)$/);
      const crownColour = crown.color.clone();
      const lantern = material(/^(lantern_red|lantern_PBR|glass)$/);
      const e = env.buildEnv(scene, new Set(["ground", "grass", "leaves", "sky", "bloom", "grade", "particles"]), { seeThrough: see.patchSeeThrough, seeAttr: see.SEE_ATTR, aoHidden });
      expect([...e.layers].sort()).toEqual(["bloom", "grade", "grass", "ground", "leaves", "particles", "sky"]);
      for (const n of ["env_grass_near", "env_grass_far", "env_leaves", "env_sky", "env_dust", "env_steam", "env_falling_leaves"]) expect(scene.getObjectByName(n), n).toBeTruthy();
      expect(scene.getObjectByName(ground.sky)!.visible).toBe(false);
      // the leaf cards carry their crown's fade id (the great tree's is an occluder id)
      const leaves = scene.getObjectByName("env_leaves") as THREE.InstancedMesh;
      const ids = new Set(Array.from((leaves.geometry.getAttribute("aSeeId") as THREE.BufferAttribute).array));
      const tree = space.occluders.find((o) => o.asset === "great_tree")!;
      expect(ids.has(tree.id + see.SEE_ID0)).toBe(true);
      expect(leaves.count).toBeGreaterThan(1000);
      expect(aoHidden.length).toBeGreaterThanOrEqual(5); // grass x2, leaves, sky, particles: never in the AO pass
      e.update(new THREE.PerspectiveCamera(), new THREE.Vector3(-15.5, 0, 31.5), 1);
      expect(e.evening).toBe(0);
      space.setDaylight(1);
      e.update(new THREE.PerspectiveCamera(), new THREE.Vector3(-15.5, 0, 31.5), 2);
      expect(e.evening).toBe(1);
      expect(lantern.emissiveIntensity).toBeGreaterThan(1); // the evening glow (bloom's emissives)
      // the safety valve's full -> lite (look.ts LITE_LAYERS, LITE_GRASS), live: nothing built, the rest hidden or thinned
      // the grass in chunks (envlook.ts GRASS: LOD bands, each tile cut into chunks, culled per frame)
      const chunks = (sc: THREE.Scene, name: string) => sc.children.filter((o) => o.name === name) as THREE.Mesh<THREE.InstancedBufferGeometry>[];
      const blades = (sc: THREE.Scene, name: string) => chunks(sc, name).reduce((n, m) => n + m.geometry.instanceCount, 0);
      expect(chunks(scene, "env_grass_near")).toHaveLength(env.GRASS.near.chunks ** 2);
      expect(blades(scene, "env_grass_near")).toBe(200 * 200);
      e.restrict(new Set(look.LITE_LAYERS), look.LITE_GRASS);
      expect([...e.layers].sort()).toEqual(["grade", "grass", "ground", "sky"]);
      expect(Math.abs(blades(scene, "env_grass_near") - 200 * 200 * look.LITE_GRASS)).toBeLessThanOrEqual(env.GRASS.near.chunks ** 2); // each chunk rounds its half
      // a camera over the lawn west of the great tree, looking down on it: the chunks round the player drawn, the ones behind it not
      const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
      cam.position.set(-25.6, 12, 17);
      cam.lookAt(-25.6, 0, 5.2);
      cam.updateMatrixWorld();
      e.update(cam, new THREE.Vector3(-25.6, 0, 5.2), 2.5);
      expect(chunks(scene, "env_grass_near").some((m) => m.visible)).toBe(true);
      const drawn = chunks(scene, "env_grass_far").filter((m) => m.visible).length;
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThan(env.GRASS.far.chunks ** 2 / 2); // behind the camera or past 30 m: not drawn
      for (const n of ["env_leaves", "env_dust", "env_steam", "env_falling_leaves"]) expect(scene.getObjectByName(n)!.visible, n).toBe(false);
      expect(scene.getObjectByName("env_sky")!.visible).toBe(true);
      for (const k of ["r", "g", "b"] as const) expect(crown.color[k]).toBeCloseTo(crownColour[k], 6); // the crown's own colour back
      expect(lantern.emissiveIntensity).toBe(1);
      e.update(new THREE.PerspectiveCamera(), new THREE.Vector3(-15.5, 0, 31.5), 3);
      expect(lantern.emissiveIntensity).toBe(1); // and it stays off
      // lite from the start: its four layers, half the blades, no leaf cards or particles
      const liteSpace = await world.SceneSpace.create(L2, assets, STREET);
      const lite = env.buildEnv(liteSpace.scene, new Set(look.LITE_LAYERS), { seeThrough: see.patchSeeThrough, seeAttr: see.SEE_ATTR, aoHidden: [], grassDensity: look.LITE_GRASS });
      expect([...lite.layers].sort()).toEqual(["grade", "grass", "ground", "sky"]);
      expect(Math.abs(blades(liteSpace.scene, "env_grass_far") - 200 * 200 * look.LITE_GRASS)).toBeLessThanOrEqual(env.GRASS.far.chunks ** 2);
      for (const n of ["env_leaves", "env_dust", "env_steam", "env_falling_leaves"]) expect(liteSpace.scene.getObjectByName(n), n).toBeUndefined();
      // on an interior: no town layers, the renderer's still on
      const room = await world.SceneSpace.create(L2, assets, "room");
      const r = env.buildEnv(room.scene, new Set(["ground", "grass", "leaves", "sky", "bloom", "grade", "particles"]), { seeThrough: see.patchSeeThrough, seeAttr: see.SEE_ATTR, aoHidden: [] });
      expect([...r.layers].sort()).toEqual(["bloom", "grade"]);
    } finally {
      vi.doUnmock("../src/look");
      vi.resetModules();
    }
  }, 20000); // three env builds on the real town (full, lite, a room): ~3 s alone, more under the parallel suite

  it("an interior follows daylight with a blue evening exterior and warm interior light", async () => {
    const room = await buildSpace(L, "room");
    const { hemi, sun } = peekLights(room);
    room.setDaylight(1 / 3);
    const midday = (room.scene.background as THREE.Color).clone();
    const noonIntensity = sun.intensity;
    room.setDaylight(1);
    const evening = room.scene.background as THREE.Color;
    expect(evening.equals(midday)).toBe(false);
    expect(evening.b).toBeGreaterThan(evening.r);
    expect(sun.color.r).toBeGreaterThan(sun.color.b);
    expect(sun.intensity).toBeLessThan(noonIntensity);
    expect(hemi.color.b).toBeGreaterThan(hemi.color.r);
    expect((room.scene.fog as THREE.Fog).color.equals(evening)).toBe(true);
  });
});

describe("see-through: whatever blocks a focus fades as a whole object", () => {
  // The rig as main.ts has it: a landscape viewport, snapped onto the player at the plaza.
  const rig = () => {
    const r = new CameraRig({} as HTMLElement);
    r.resize(1280, 720);
    return r;
  };
  const feet = new THREE.Vector3(-15, 0, 8); // under the great tree
  const occluder = (asset: string, id = 0): Occluder => ({ id, asset });

  // One focus's pass result: covered pixels per id, the silhouette their sum unless given.
  const hits = (covered: [number, number][], silhouette = covered.reduce((a, [, n]) => a + n, 0)): SeeSample => ({ silhouette, covered: new Map(covered) });

  it("counts rendered root ids and ignores untouched pixels", () => {
    expect(idHistogram(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 255, 1, 0, 0, 255, 2, 1, 0, 255]))).toEqual({ silhouette: 3, covered: new Map([[0, 2], [257, 1]]) });
  });

  it("the histogram carries the silhouette: the proxy's reserved code counts as silhouette, never as an id", () => {
    const lo = SEE_SILHOUETTE_CODE & 255;
    const hi = SEE_SILHOUETTE_CODE >> 8;
    const px = new Uint8Array([lo, hi, 0, 255, lo, hi, 0, 255, lo, hi, 0, 255, 8, 0, 0, 255, 0, 0, 0, 0]);
    const h = idHistogram(px);
    expect(h.silhouette).toBe(4); // 3 uncovered + 1 covered by id 7
    expect(h.covered).toEqual(new Map([[7, 1]]));
    expect(h.covered.has(SEE_SILHOUETTE_CODE - 1)).toBe(false);
    expect(SEE_SILHOUETTE_CODE - 1).toBeGreaterThan(SEE_THROUGH.maxOccluders); // no id can collide
  });

  it("fades at 40 % of the silhouette, releases below 30 % (hysteresis), with a 6-pixel floor", () => {
    const roof = occluder("roof", 7);
    const see = new SeeThroughControl();
    const f = [feet];
    const run = (covered: number, silhouette: number, seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) see.update(1 / 60, f, [roof], [hits([[7, covered]], silhouette)]); };
    run(39, 100, 2);
    expect(see.vis[7]).toBe(1); // below 40 %: never fades
    run(40, 100, 2);
    expect(see.vis[7]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
    expect(see.status([roof]).faded).toEqual([{ id: 7, asset: "roof", vis: SEE_THROUGH.fadeTo, coverage: 0.4 }]);
    run(31, 100, 3); // hovering between the two thresholds: stays faded, no flicker
    expect(see.vis[7]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
    run(29, 100, 3); // below 30 %: let go
    expect(see.vis[7]).toBe(1);
    run(35, 100, 2); // clear again: 35 % is not enough to fade anew
    expect(see.vis[7]).toBe(1);
    see.reset();
    run(5, 10, 2); // 50 % of a tiny silhouette, but under the 6-pixel floor
    expect(see.vis[7]).toBe(1);
    run(6, 10, 2);
    expect(see.vis[7]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
  });

  it("a thin post covering 10 % never fades; a roof covering 60 % does (histogram to fade)", () => {
    const post = occluder("lamp_post", 3);
    const roof = occluder("roof", 9);
    const lo = SEE_SILHOUETTE_CODE & 255;
    const hi = SEE_SILHOUETTE_CODE >> 8;
    const px = new Uint8Array(100 * 4);
    for (let i = 0; i < 100; i++) px.set(i < 10 ? [4, 0, 0, 255] : i < 70 ? [10, 0, 0, 255] : [lo, hi, 0, 255], i * 4); // post 10, roof 60, bare 30
    const pass = idHistogram(px);
    expect(pass.silhouette).toBe(100);
    const see = new SeeThroughControl();
    for (let i = 0; i < 180; i++) see.update(1 / 60, [feet], [post, roof], [pass]);
    expect(see.vis[3]).toBe(1);
    expect(see.vis[9]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
    expect(see.status([post, roof]).faded).toEqual([{ id: 9, asset: "roof", vis: SEE_THROUGH.fadeTo, coverage: 0.6 }]);
  });

  it("two focuses: each is judged against its own silhouette, the larger fraction wins", () => {
    const wall = occluder("wall", 4);
    const see = new SeeThroughControl();
    // 30 px: 30 % of the player's 100 px silhouette, 60 % of the NPC's 50 px one
    for (let i = 0; i < 180; i++) see.update(1 / 60, [feet, feet], [wall], [hits([[4, 30]], 100), hits([[4, 30]], 50)]);
    expect(see.vis[4]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
    expect(see.status([wall]).faded[0].coverage).toBe(0.6);
  });

  it("requires six pixels, ignores canopy position, expires every hit after 0.35 s, and honors off and fly-over", () => {
    const tree = occluder("great_tree", 0);
    const roof = occluder("roof", 7);
    const see = new SeeThroughControl();
    const outside = new THREE.Vector3(3, 0, 3);
    const underCanopy = new THREE.Vector3(0, 0, 0);
    see.update(0, [underCanopy], [tree, roof]);
    expect(see.vis[0]).toBe(1);
    see.update(0, [outside], [tree, roof], [hits([[7, 5]])]); // 100 %, but under the floor
    expect(see.vis[7]).toBe(1);
    see.update(0, [outside], [tree, roof], [hits([[0, 6], [7, 6]])]); // 50 % each
    expect(see.vis[0]).toBeCloseTo(SEE_THROUGH.fadeTo);
    expect(see.vis[7]).toBeCloseTo(SEE_THROUGH.fadeTo);
    see.update(0.2, [underCanopy], [tree, roof]);
    expect(see.vis[0]).toBeCloseTo(SEE_THROUGH.fadeTo);
    expect(see.vis[7]).toBeCloseTo(SEE_THROUGH.fadeTo);
    see.update(0.2, [underCanopy], [tree, roof]);
    expect(see.vis[0]).toBeGreaterThan(SEE_THROUGH.fadeTo);
    expect(see.vis[7]).toBeGreaterThan(SEE_THROUGH.fadeTo);
    see.update(10, [underCanopy], [tree, roof], [], false);
    expect(see.vis[0]).toBe(1);
    see.on = false;
    see.update(10, [outside], [tree, roof], [hits([[7, 100]])]);
    expect(see.vis[7]).toBe(1);
  });

  it("sets up one scissored ID render and async pixel read for a focus; never a sync read", () => {
    const calls: string[] = [];
    const g = fakeGl2();
    const viewport = new THREE.Vector4(10, 20, 1280, 720);
    const scissor = new THREE.Vector4(30, 40, 600, 400);
    let scissorTest = true;
    let target: THREE.WebGLRenderTarget | null = null;
    let clearColor = new THREE.Color(0xffffff);
    let clearAlpha = 1;
    let throwRead = false;
    const renderer = {
      autoClear: true,
      getContext: () => g.gl,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720),
      getRenderTarget: () => target,
      getViewport: (v: THREE.Vector4) => v.copy(viewport),
      getScissor: (v: THREE.Vector4) => v.copy(scissor),
      getScissorTest: () => scissorTest,
      getClearColor: (v: THREE.Color) => v.copy(clearColor),
      getClearAlpha: () => clearAlpha,
      setClearColor: (c: THREE.Color | number, a: number) => { clearColor = new THREE.Color(c); clearAlpha = a; },
      setRenderTarget: (rt: THREE.WebGLRenderTarget | null) => {
        calls.push(rt ? "target:offscreen" : "target:default");
        target = rt;
        if (rt) { viewport.copy(rt.viewport); scissor.copy(rt.scissor); }
      },
      setViewport: (x: number | THREE.Vector4, y?: number, w?: number, h?: number) => { if (x instanceof THREE.Vector4) viewport.copy(x); else viewport.set(x, y!, w!, h!); },
      setScissor: (x: number | THREE.Vector4, y?: number, w?: number, h?: number) => { if (x instanceof THREE.Vector4) scissor.copy(x); else scissor.set(x, y!, w!, h!); },
      setScissorTest: (value: boolean) => { scissorTest = value; },
      clear: () => calls.push("clear"),
      render: (scene: THREE.Scene) => {
        calls.push("render");
        if (throwRead) throw new Error("read failed");
        expect(scene.children).toHaveLength(2);
        const proxy = scene.children[0] as THREE.Mesh;
        const idMesh = scene.children[1] as THREE.Mesh;
        expect((proxy.material as THREE.Material).colorWrite).toBe(true); // writes the silhouette code
        expect((proxy.material as THREE.ShaderMaterial).fragmentShader).toContain("vec4(1.0, 1.0, 0.0, 1.0)");
        expect((idMesh.material as THREE.ShaderMaterial).stencilFunc).toBe(THREE.EqualStencilFunc);
        expect(idMesh.geometry).toBe(geo);
      },
      readRenderTargetPixels: () => calls.push("syncRead"),
    } as unknown as THREE.WebGLRenderer;
    const geo = new THREE.BoxGeometry();
    geo.setAttribute(SEE_ATTR, new THREE.Float32BufferAttribute(new Array(geo.getAttribute("position").count).fill(SEE_ID0), 1));
    const source = new THREE.Scene();
    source.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    const detector = new SeeThroughDetector(renderer);
    const see = new SeeThroughControl();
    const r = rig();
    r.snap(new THREE.Vector3());
    const beforeViewport = viewport.clone();
    const beforeScissor = scissor.clone();
    const update = () => see.update(1 / 60, [new THREE.Vector3()], [{ id: 0, asset: "box" }], [detector.sample(source, r.camera, new THREE.Vector3())]);
    update();
    expect(g.calls).toContain(`readPixels:${SEE_THROUGH.sampleSize}x${SEE_THROUGH.sampleSize}@0`);
    g.signal(g.gl.CONDITION_SATISFIED);
    detector.poll();
    expect(target).toBeNull();
    expect(viewport).toEqual(beforeViewport);
    expect(scissor).toEqual(beforeScissor);
    expect(scissorTest).toBe(true);
    expect(clearColor).toEqual(new THREE.Color(0xffffff));
    expect(clearAlpha).toBe(1);
    expect(renderer.autoClear).toBe(true);
    const renders = calls.filter((c) => c === "render").length;
    update(); // nothing moved: the pass is skipped and the last decision reused
    expect(calls.filter((c) => c === "render").length).toBe(renders);
    throwRead = true;
    const oldTarget = new THREE.WebGLRenderTarget(64, 64);
    target = oldTarget;
    detector.invalidate(); // a teleport or space change forces a fresh pass
    expect(update).toThrow("read failed");
    expect(target).toBe(oldTarget);
    expect(viewport).toEqual(beforeViewport);
    expect(scissor).toEqual(beforeScissor);
    expect(scissorTest).toBe(true);
    expect(clearColor).toEqual(new THREE.Color(0xffffff));
    expect(clearAlpha).toBe(1);
    expect(renderer.autoClear).toBe(true);
    expect(calls.at(-2)).toBe("target:default");
    expect(calls.at(-1)).toBe("target:offscreen");
    expect(calls).not.toContain("syncRead");
    expect(silhouetteProjection(r.camera, new THREE.Vector3(), 1280, 720).elements.every(Number.isFinite)).toBe(true);
  });

  // A minimal renderer (and optionally a WebGL2 context) for the detector's pass.
  const stubRenderer = (gl?: object) => {
    const calls: string[] = [];
    const renderer = {
      autoClear: true,
      getContext: () => gl,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720),
      getRenderTarget: () => null,
      getViewport: (v: THREE.Vector4) => v,
      getScissor: (v: THREE.Vector4) => v,
      getScissorTest: () => false,
      getClearColor: (v: THREE.Color) => v,
      getClearAlpha: () => 1,
      setClearColor: () => {},
      setRenderTarget: () => {},
      setViewport: () => {},
      setScissor: () => {},
      setScissorTest: () => {},
      clear: () => {},
      render: () => calls.push("render"),
      readRenderTargetPixels: (_t: unknown, _x: number, _y: number, _w: number, _h: number, px: Uint8Array) => { calls.push("syncRead"); px.set([3, 0, 0, 255, 3, 0, 0, 255, 3, 0, 0, 255, 3, 0, 0, 255, 3, 0, 0, 255, 3, 0, 0, 255]); },
    } as unknown as THREE.WebGLRenderer;
    const geo = new THREE.BoxGeometry();
    geo.setAttribute(SEE_ATTR, new THREE.Float32BufferAttribute(new Array(geo.getAttribute("position").count).fill(SEE_ID0), 1));
    const source = new THREE.Scene();
    source.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    const r = rig();
    r.snap(new THREE.Vector3());
    return { calls, renderer, source, camera: r.camera };
  };
  const fakeGl2 = () => {
    const calls: string[] = [];
    let state = 0x911b; // TIMEOUT_EXPIRED
    let bound: object | null = null;
    const gl = {
      PIXEL_PACK_BUFFER: 0x88eb, PIXEL_PACK_BUFFER_BINDING: 0x88ed, STREAM_READ: 0x88e1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
      SYNC_GPU_COMMANDS_COMPLETE: 0x9117, TIMEOUT_EXPIRED: 0x911b, CONDITION_SATISFIED: 0x911c, ALREADY_SIGNALED: 0x911a, WAIT_FAILED: 0x911d,
      createBuffer: () => { calls.push("createBuffer"); return {}; },
      deleteBuffer: () => calls.push("deleteBuffer"),
      bindBuffer: (_t: number, b: object | null) => { bound = b; },
      getParameter: () => bound,
      bufferData: (_t: number, size: number) => calls.push(`bufferData:${size}`),
      readPixels: (_x: number, _y: number, w: number, h: number, _f: number, _t: number, offset: unknown) => calls.push(`readPixels:${w}x${h}@${offset}`),
      fenceSync: () => { calls.push("fenceSync"); return {}; },
      flush: () => calls.push("flush"),
      clientWaitSync: (_s: object, _f: number, timeout: number) => { calls.push(`clientWaitSync:${timeout}`); return state; },
      getBufferSubData: (_t: number, _o: number, px: Uint8Array) => { calls.push("getBufferSubData"); px.set([6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255]); },
      deleteSync: () => calls.push("deleteSync"),
    };
    return { gl, calls, signal: (s: number) => { state = s; }, bound: () => bound };
  };

  // performance.now() under test control: fence timeouts and the sample age are wall-clock.
  const clocks: (() => void)[] = [];
  afterEach(() => { while (clocks.length) clocks.pop()!(); });
  const fakeClock = () => {
    let now = 1000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
    clocks.push(() => spy.mockRestore());
    return { advance: (ms: number) => { now += ms; }, restore: () => spy.mockRestore() };
  };

  it("WebGL2: reads the ID pass through a pixel-pack buffer and fence, polled without waiting", () => {
    const clock = fakeClock();
    try {
    const g = fakeGl2();
    const { calls, renderer, source, camera } = stubRenderer(g.gl);
    const detector = new SeeThroughDetector(renderer);
    const focus = new THREE.Vector3();
    const n = SEE_THROUGH.sampleSize;
    expect(detector.sample(source, camera, focus).silhouette).toBe(0); // queued, nothing known yet
    expect(calls).toEqual(["render"]); // no sync readback
    expect(g.calls).toEqual(["createBuffer", `bufferData:${n * n * 4}`, `readPixels:${n}x${n}@0`, "fenceSync", "flush"]);
    expect(g.bound()).toBeNull(); // pack binding restored
    g.calls.length = 0;
    detector.poll(); // GPU not done: no read, still pending
    expect(g.calls).toEqual(["clientWaitSync:0"]);
    detector.sample(source, camera, focus.clone().setX(1)); // a pending read blocks a second pass
    expect(calls).toEqual(["render"]);
    g.signal(g.gl.CONDITION_SATISFIED);
    g.calls.length = 0;
    detector.poll();
    expect(g.calls).toEqual(["clientWaitSync:0", "getBufferSubData", "deleteSync", "deleteBuffer"]);
    expect(detector.counts(0)).toEqual({ silhouette: 6, covered: new Map([[5, 6]]) });
    expect(detector.lastReadMs).toBeGreaterThanOrEqual(0);
    // unmoved: skipped, last decision reused
    expect(detector.sample(source, camera, focus).covered).toEqual(new Map([[5, 6]]));
    expect(calls).toEqual(["render"]);
    // an in-flight read from before a teleport is dropped, never applied
    detector.sample(source, camera, focus.clone().setX(2));
    expect(calls).toEqual(["render", "render"]);
    g.calls.length = 0;
    detector.invalidate();
    expect(g.calls).toEqual(["deleteSync", "deleteBuffer"]);
    expect(detector.counts(0).silhouette).toBe(0);
    detector.poll();
    expect(g.calls).not.toContain("getBufferSubData");
    // a failed wait rests the pass for ASYNC_RETRY_MS (no pass, never a sync read), then it reads async again
    detector.sample(source, camera, focus.clone().setX(3));
    g.signal(g.gl.WAIT_FAILED);
    const log = quietWarn();
    detector.poll();
    log.restore();
    const n0 = calls.length;
    detector.sample(source, camera, focus.clone().setX(4));
    expect(calls).toHaveLength(n0); // resting: no pass
    expect(detector.debug()[0]).toMatchObject({ asyncPaused: true, pending: false });
    expect(detector.current(0)).toBeNull(); // moved: no evidence
    clock.advance(ASYNC_RETRY_MS);
    g.signal(g.gl.CONDITION_SATISFIED);
    detector.sample(source, camera, focus.clone().setX(4));
    expect(calls.at(-1)).toBe("render");
    detector.poll();
    expect(detector.counts(0).covered).toEqual(new Map([[5, 6]]));
    expect(calls).not.toContain("syncRead");
    } finally {
      clock.restore();
    }
  });

  // A frame as main.ts runs it: poll, sample, fade from the counts the detector vouches for.
  const hitPixels = (px: Uint8Array) => px.set([6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255, 6, 0, 0, 255]); // id 5, 6 px
  const asyncRig = () => {
    const clock = fakeClock();
    const g = fakeGl2();
    const stub = stubRenderer(g.gl);
    const detector = new SeeThroughDetector(stub.renderer);
    const see = new SeeThroughControl();
    see.reset();
    let hit = true;
    g.gl.getBufferSubData = (_t: number, _o: number, px: Uint8Array) => { g.calls.push("getBufferSubData"); if (hit) hitPixels(px); };
    const occluders = [{ id: 5, asset: "great_tree" }];
    const frame = (focus: THREE.Vector3, dt = 1 / 60) => {
      clock.advance(dt * 1000);
      detector.poll();
      detector.sample(stub.source, stub.camera, focus);
      see.update(dt, [focus], occluders, [detector.current(0)]);
    };
    const vis = () => see.vis[5];
    const renders = () => stub.calls.filter((c) => c === "render").length;
    return { g, ...stub, clock, detector, see, frame, vis, renders, setHit: (h: boolean) => { hit = h; } };
  };
  const quietWarn = () => {
    const warn = console.warn;
    const logged: unknown[][] = [];
    console.warn = (...a: unknown[]) => { logged.push(a); };
    return { logged, restore: () => { console.warn = warn; } };
  };

  it("WebGL2: a fence that never signals is dropped after FENCE_TIMEOUT_MS of wall clock however few polls ran, the pass resumes and the fade clears", () => {
    const t = asyncRig();
    const log = quietWarn();
    try {
      const focus = new THREE.Vector3();
      t.g.signal(t.g.gl.ALREADY_SIGNALED);
      for (let i = 0; i < 150; i++) t.frame(focus); // under the tree: fresh hits, then unmoved
      expect(t.vis()).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
      // walk off; the GPU never reports the next fence
      t.g.signal(t.g.gl.TIMEOUT_EXPIRED);
      const away = focus.clone().setX(0.5);
      t.frame(away);
      expect(t.detector.debug()[0]).toMatchObject({ slot: 0, pending: true, timeouts: 0, asyncPaused: false });
      const before = t.renders();
      t.clock.advance(FENCE_TIMEOUT_MS - 1);
      t.detector.poll(); // one poll, just inside the budget
      expect(t.detector.debug()[0].pending).toBe(true);
      expect(t.renders()).toBe(before); // blocked while in flight
      t.clock.advance(1);
      t.g.calls.length = 0;
      t.detector.poll(); // the second poll, FENCE_TIMEOUT_MS after the queue: dropped
      expect(t.g.calls).toEqual(["clientWaitSync:0", "deleteSync", "deleteBuffer"]);
      expect(t.detector.debug()[0]).toMatchObject({ pending: false, timeouts: 1, asyncPaused: false });
      expect(log.logged).toHaveLength(1);
      // the next pass runs although the focus has not moved since the dropped one was queued
      t.detector.sample(t.source, t.camera, away);
      expect(t.renders()).toBe(before + 1);
      t.setHit(false);
      t.g.signal(t.g.gl.CONDITION_SATISFIED);
      for (let i = 0; i < 180; i++) t.frame(away);
      expect(t.detector.counts(0).covered.size).toBe(0);
      expect(t.vis()).toBe(1);
      expect(t.see.status([{ id: 5, asset: "great_tree" }]).faded).toEqual([]);
      expect(t.detector.debug()[0].lastSampleAgeMs).toBeGreaterThanOrEqual(0);
    } finally {
      log.restore();
    }
  });

  it("WebGL2: a read still in flight is waited for however old the decision gets: never abandoned for a sync read", () => {
    const t = asyncRig();
    const log = quietWarn();
    const focus = new THREE.Vector3();
    t.g.signal(t.g.gl.ALREADY_SIGNALED);
    t.frame(focus);
    t.frame(focus); // a result for this pose
    t.g.signal(t.g.gl.TIMEOUT_EXPIRED);
    t.detector.sample(t.source, t.camera, focus.setX(1)); // moved: queued, the decision ages from here
    t.clock.advance(FENCE_TIMEOUT_MS + 10);
    t.detector.poll(); // timed out
    t.clock.advance(10);
    t.detector.sample(t.source, t.camera, focus); // re-queued
    expect(t.detector.debug()[0]).toMatchObject({ pending: true, timeouts: 1 });
    t.clock.advance(MAX_SAMPLE_AGE_MS); // the decision is old; the read is still inside its fence budget
    const renders = t.renders();
    t.g.calls.length = 0;
    log.restore();
    t.detector.sample(t.source, t.camera, focus);
    expect(t.g.calls).toEqual(["clientWaitSync:0"]); // polled, still waiting
    expect(t.renders()).toBe(renders); // no second pass
    expect(t.calls).not.toContain("syncRead");
    expect(t.detector.debug()[0]).toMatchObject({ pending: true, timeouts: 1 });
    expect(t.detector.current(0)).toBeNull(); // no evidence while it waits
    t.g.signal(t.g.gl.CONDITION_SATISFIED);
    t.detector.poll();
    expect(t.detector.current(0)?.covered).toEqual(new Map([[5, 6]]));
  });

  it("WebGL2: walking with fences that never signal, no sync read ever runs, the pass rests after three timeouts and the tree still clears", () => {
    const t = asyncRig();
    const log = quietWarn();
    try {
      const focus = new THREE.Vector3();
      t.g.signal(t.g.gl.ALREADY_SIGNALED);
      for (let i = 0; i < 150; i++) t.frame(focus);
      expect(t.vis()).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
      // stuck: every fence stays unsignalled while the player walks out from under the tree
      t.g.signal(t.g.gl.TIMEOUT_EXPIRED);
      let x = 0;
      let paused = -1;
      for (let i = 0; i < 5 * 60; i++) {
        t.frame(new THREE.Vector3((x += 0.05), 0, 0));
        const d = t.detector.debug()[0];
        if (paused < 0 && d.asyncPaused) paused = i;
      }
      // no evidence: the hold runs out and the tree eases back
      expect(t.vis()).toBe(1);
      expect(t.calls).not.toContain("syncRead");
      // three timeouts in a row rest the pass (ASYNC_RETRY_MS), then it tries again
      expect(paused).toBeGreaterThan(0);
      expect(paused).toBeLessThanOrEqual(Math.ceil((3 * FENCE_TIMEOUT_MS) / (1000 / 60)) + 3);
      expect(t.detector.debug()[0].skipped.unavailable).toBeGreaterThan(0);
      expect(log.logged).toHaveLength(2); // the first timeout, then the rest
    } finally {
      log.restore();
    }
  });

  it("WebGL2: unmoved, the last counts keep a fade (the object still covers); moving on, a fresh miss clears it within the hold", () => {
    const t = asyncRig();
    const focus = new THREE.Vector3();
    t.g.signal(t.g.gl.ALREADY_SIGNALED);
    for (let i = 0; i < 30; i++) t.frame(focus);
    const renders = t.renders();
    for (let i = 0; i < 180; i++) t.frame(focus); // 3 s standing still: no pass, fade kept
    expect(t.renders()).toBe(renders);
    expect(t.vis()).toBeCloseTo(SEE_THROUGH.fadeTo, 3);
    // a fresh pass that arrives in the same frame as the next one is queued still counts once
    t.setHit(true);
    t.frame(focus.clone().setX(0.1)); // queued
    t.frame(focus.clone().setX(0.2)); // polled (hit) and the next queued in the same frame
    expect(t.vis()).toBeCloseTo(SEE_THROUGH.fadeTo, 3);
    // moving on with fresh misses: the hold runs out, the tree eases back
    t.setHit(false);
    const away = focus.clone().setX(1);
    for (let i = 0; i < Math.ceil(SEE_THROUGH.holdSeconds * 60) + 4; i++) t.frame(away.setX(away.x + 0.05));
    const easing = t.vis();
    expect(easing).toBeGreaterThan(SEE_THROUGH.fadeTo);
    t.frame(away.setX(away.x + 0.05));
    expect(t.vis()).toBeGreaterThan(easing);
  });

  // main.ts's frame, as the browser runs it: poll at the top, the rig following the player, a jump
  // over 2 m (or a teleport) resetting, sample() every other frame (skip() on the others), and
  // fences that signal on a later animation frame than the one that queued them (Chrome only
  // updates a sync's status once the page yields).
  it("WebGL2, the main.ts frame: after a teleport, 5 s of walking gets a fresh sample at least every MAX_SAMPLE_AGE_MS and the fade clears", () => {
    const clock = fakeClock();
    const g = fakeGl2();
    let frameNo = 0;
    const fences = new Map<object, number>();
    g.gl.fenceSync = () => { const f = {}; fences.set(f, frameNo); return f; };
    g.gl.clientWaitSync = (f: object) => (frameNo > fences.get(f)! ? g.gl.CONDITION_SATISFIED : g.gl.TIMEOUT_EXPIRED);
    const tree = new THREE.Vector3(-17.2, 0, 6.3);
    let covered = true;
    // six silhouette pixels: all under the tree (id 5), or none covered
    g.gl.getBufferSubData = (_t: number, _o: number, px: Uint8Array) => { px.fill(0); for (let i = 0; i < 6; i++) px.set(covered ? [6, 0, 0, 255] : [255, 255, 0, 255], i * 4); };
    const stub = stubRenderer(g.gl);
    const r = rig();
    const detector = new SeeThroughDetector(stub.renderer);
    const see = new SeeThroughControl();
    see.reset();
    const occluders = [{ id: 5, asset: "great_tree" }];
    const player = new THREE.Vector3(0, 0, 0);
    r.snap(player);
    const last = player.clone();
    let seeFrame = 0;
    const fps = 59;
    const frame = (vx: number, vz: number) => {
      clock.advance(1000 / fps);
      frameNo++;
      detector.poll();
      player.x += vx / fps;
      player.z += vz / fps;
      covered = player.distanceTo(tree) < 6;
      r.update(1 / fps, player, false);
      if (last.distanceToSquared(player) > 4) {
        see.reset();
        detector.invalidate();
        seeFrame = 0;
      }
      last.copy(player);
      if (seeFrame++ % 2 === 0) detector.sample(stub.source, r.camera, player, 0);
      else detector.skip(0);
      see.update(1 / fps, [player], occluders, [detector.current(0)]);
    };
    try {
      for (let i = 0; i < 60; i++) frame(0, 0);
      // world3d.teleport(-20, 3): player.place, see.reset, detector.invalidate, between two frames
      player.set(-20, 0, 3);
      see.reset();
      detector.invalidate();
      for (let i = 0; i < 3 * fps; i++) frame(0, 0); // stand while the rig glides over and settles
      expect(see.status(occluders).faded).toEqual([{ id: 5, asset: "great_tree", vis: SEE_THROUGH.fadeTo, coverage: 1 }]);
      const standing = detector.debug()[0];
      expect(standing.silhouettePixels).toBe(6);
      expect(standing.skipped.unmoved).toBeGreaterThan(0); // settled: passes skipped, the age just grows
      // walk (W: away from the camera, 3.2 m/s) for 5 s
      const az = (36 * Math.PI) / 180;
      const before = { ...standing, skipped: { ...standing.skipped } };
      let worst = 0;
      let clearedAt = -1;
      for (let i = 0; i < 5 * fps; i++) {
        frame(-Math.sin(az) * 3.2, -Math.cos(az) * 3.2);
        const d = detector.debug()[0];
        if (i >= 2) worst = Math.max(worst, d.lastSampleAgeMs ?? Infinity); // the first pass lands a frame after it is queued
        if (clearedAt < 0 && see.vis[5] === 1) clearedAt = i;
      }
      expect(worst).toBeLessThanOrEqual(MAX_SAMPLE_AGE_MS);
      expect(clearedAt).toBeGreaterThan(0);
      expect(see.status(occluders).faded).toEqual([]);
      const walked = detector.debug()[0];
      expect(walked).toMatchObject({ timeouts: 0, asyncPaused: false, silhouettePixels: 6 });
      expect(stub.calls).not.toContain("syncRead");
      expect(walked.skipped.unmoved).toBe(before.skipped.unmoved); // moving: never skipped as unmoved
      expect(walked.skipped.pending).toBe(before.skipped.pending);
      // every call either rendered a pass or was an off-cadence frame, half and half
      const cadence = walked.skipped.cadence - before.skipped.cadence;
      const passes = walked.passes - before.passes;
      expect(cadence + passes).toBe(5 * fps);
      expect(Math.abs(cadence - passes)).toBeLessThanOrEqual(1);
      expect(detector.counts(0).covered.size).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it("WebGL2: a throwing readPixels, a throwing poll and a generation mismatch all leave nothing pending", () => {
    const t = asyncRig();
    const log = quietWarn();
    try {
      const focus = new THREE.Vector3();
      const readPixels = t.g.gl.readPixels;
      t.g.gl.readPixels = () => { throw new Error("pack failed"); };
      t.g.calls.length = 0;
      t.detector.sample(t.source, t.camera, focus); // not queued: nothing pending, no sync read; the next sample re-runs it
      expect(t.detector.debug()[0].pending).toBe(false);
      expect(t.calls.at(-1)).toBe("render");
      expect(t.calls).not.toContain("syncRead");
      expect(t.g.calls).toEqual(["createBuffer", `bufferData:${SEE_THROUGH.sampleSize ** 2 * 4}`, "deleteBuffer"]);
      t.g.gl.readPixels = readPixels;
      // a poll that throws while reading back drops the read
      t.detector.sample(t.source, t.camera, focus.clone().setX(1));
      expect(t.detector.debug()[0].pending).toBe(true);
      const read = t.g.gl.getBufferSubData;
      t.g.gl.getBufferSubData = () => { throw new Error("lost"); };
      t.g.signal(t.g.gl.CONDITION_SATISFIED);
      t.g.calls.length = 0;
      t.detector.poll();
      expect(t.detector.debug()[0].pending).toBe(false);
      expect(t.g.calls).toEqual(["clientWaitSync:0", "deleteSync", "deleteBuffer"]);
      t.g.gl.getBufferSubData = read;
      // a result from an older generation is dropped and the pass re-runs even unmoved
      t.detector.sample(t.source, t.camera, focus.clone().setX(1));
      expect(t.detector.debug()[0].pending).toBe(true);
      (t.detector as unknown as { generation: number }).generation++;
      t.g.calls.length = 0;
      t.detector.poll();
      expect(t.g.calls).not.toContain("getBufferSubData");
      expect(t.detector.debug()[0].pending).toBe(false);
      const renders = t.renders();
      t.detector.sample(t.source, t.camera, focus.clone().setX(1));
      expect(t.renders()).toBe(renders + 1);
    } finally {
      log.restore();
    }
  });

  it("no fences (a WebGL1-like context): no pass and no sync read, ever; nothing to fade by", () => {
    const { calls, renderer, source, camera } = stubRenderer({}); // a context without fenceSync
    const detector = new SeeThroughDetector(renderer);
    const focus = new THREE.Vector3();
    expect(detector.sample(source, camera, focus)).toEqual({ silhouette: 0, covered: new Map() });
    detector.sample(source, camera, focus.clone().setZ(0.5)); // focus moved
    camera.position.x += 0.5; // camera moved
    camera.updateMatrixWorld();
    detector.sample(source, camera, focus.clone().setZ(0.5));
    expect(calls).toEqual([]);
    expect(detector.debug()[0]).toMatchObject({ asyncPaused: true, passes: 0, skipped: { unavailable: 3 } });
    expect(detector.current(0)).toBeNull();
    detector.invalidateSlot(0); // the focus left (scene ended): its counts go
    expect(detector.counts(0).silhouette).toBe(0);
  });

  it("the silhouette is the only trigger: a canopy with no pixels never fades, and every id clears after the hold", () => {
    const ids = [0, 1, 7, 300, SEE_THROUGH.maxOccluders - 1];
    const roots = ids.map((id) => occluder(id === 0 ? "great_tree" : "roof", id));
    const see = new SeeThroughControl();
    const under = new THREE.Vector3(-15, 0, 8); // under the great tree's canopy
    for (let i = 0; i < 60; i++) see.update(1 / 60, [under], roots);
    expect(ids.map((id) => see.vis[id])).toEqual(ids.map(() => 1));
    const all = ids.map((id) => hits([[id, 20]], 40)); // one focus per id, each half covered
    for (let i = 0; i < 180; i++) see.update(1 / 60, [under], roots, all);
    for (const id of ids) expect(see.vis[id]).toBeCloseTo(SEE_THROUGH.fadeTo, 2);
    for (let t = 0; t < SEE_THROUGH.holdSeconds - 0.05; t += 1 / 60) see.update(1 / 60, [under], roots);
    for (const id of ids) expect(see.vis[id]).toBeCloseTo(SEE_THROUGH.fadeTo, 2); // still held
    for (let i = 0; i < 180; i++) see.update(1 / 60, [under], roots);
    expect(ids.map((id) => see.vis[id])).toEqual(ids.map(() => 1));
    expect(see.status(roots).faded).toEqual([]);
    // a teleport or space change drops every fade and hold at once
    see.update(0, [under], roots, all);
    see.reset();
    see.update(0, [under], roots);
    expect(ids.map((id) => see.vis[id])).toEqual(ids.map(() => 1));
  });

  it("eases an occluding root down to fadeTo and back up; off and fly-over restore opaque", () => {
    const r = rig();
    r.snap(feet);
    const tree = occluder("great_tree", 0);
    const see = new SeeThroughControl();
    see.update(1 / 60, [feet], [tree], [hits([[0, 6]])]);
    expect(see.vis[0]).toBeLessThan(1);
    expect(see.vis[0]).toBeGreaterThan(SEE_THROUGH.fadeTo);
    for (let i = 0; i < 120; i++) see.update(1 / 60, [feet], [tree], [hits([[0, 6]])]);
    expect(see.vis[0]).toBeCloseTo(SEE_THROUGH.fadeTo);
    expect(see.status([tree]).faded).toEqual([{ id: 0, asset: "great_tree", vis: SEE_THROUGH.fadeTo, coverage: 1 }]);
    see.on = false;
    see.update(10, [feet], [tree]);
    expect(see.vis[0]).toBe(1);
    see.on = true;
    see.update(10, [feet], [tree], [], false);
    expect(see.vis[0]).toBe(1);
  });

  it("uploads eased visibility through the shared float DataTexture", () => {
    const r = rig();
    r.snap(feet);
    const roof = occluder("roof", 7);
    const see = new SeeThroughControl();
    const before = fadeTexture.version;
    see.update(0, [feet], [roof], [hits([[7, 6]])]);
    expect(fadeTexture.image.width).toBe(SEE_THROUGH.maxOccluders);
    expect(fadeTexture.image.data![7]).toBeCloseTo(SEE_THROUGH.fadeTo);
    expect(fadeTexture.version).toBeGreaterThan(before);
    expect(seeUniforms.stFade.value).toBe(fadeTexture);
  });

  it("the shader patch lands in three's toon shader (its anchors exist) and shares the one set of uniforms", () => {
    const toon = THREE.ShaderLib.toon;
    const shader = { vertexShader: toon.vertexShader, fragmentShader: toon.fragmentShader, uniforms: THREE.UniformsUtils.clone(toon.uniforms) };
    seeThroughCompile(shader);
    expect(shader.vertexShader).toContain(`attribute float ${SEE_ATTR};`);
    expect(shader.vertexShader.indexOf(`vStId = ${SEE_ATTR};`)).toBeGreaterThan(shader.vertexShader.indexOf("#include <project_vertex>"));
    expect(shader.fragmentShader).toContain("texture2D(stFade");
    expect(shader.fragmentShader.indexOf("stSeeThrough();")).toBeGreaterThan(shader.fragmentShader.indexOf("#include <clipping_planes_fragment>"));
    expect(shader.fragmentShader).toContain("discard"); // a cutout: no blending, depth still written
    for (const k of Object.keys(seeUniforms)) expect(shader.uniforms[k]).toBe(seeUniforms[k as keyof typeof seeUniforms]);
  });

  it("mergeStatic bakes each root id per vertex; canopy parts carry it while the trunk stays never-faded", () => {
    const mat = new THREE.MeshToonMaterial({ name: "leaf_green" });
    const bark = new THREE.MeshToonMaterial({ name: "town_bark" });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const root = (name: string, see: object, asset?: string, meshes: THREE.Mesh[] = [new THREE.Mesh(box, mat)]) => {
      const o = new THREE.Group();
      o.name = name;
      o.add(...meshes);
      o.userData.see = see;
      if (asset) o.userData.seeAsset = asset;
      return o;
    };
    const scene = new THREE.Scene();
    const lone = new THREE.Mesh(box, bark);
    const roots = [root("ground", { tag: SEE_NEVER }), root("prop", { tag: SEE_ID0 }), root("willow", { tag: SEE_ID0 + 3, baseY: 0 }, "willow", [new THREE.Mesh(box, mat), lone])];
    scene.add(...roots);
    const calls = drawCalls(scene);
    mergeStatic(scene, roots);
    expect(drawCalls(scene)).toBe(calls - 2); // three leaf meshes -> one batch, the bark alone
    const batch = scene.children.find((c) => c.name === "batch:leaf_green") as THREE.Mesh;
    const tags = [...(batch.geometry.getAttribute(SEE_ATTR).array as Float32Array)];
    const n = box.getAttribute("position").count;
    expect(tags).toEqual([...Array(n).fill(SEE_NEVER), ...Array(n).fill(SEE_ID0), ...Array(n).fill(SEE_ID0 + 3)]);
    expect(lone.geometry).not.toBe(box); // the template's geometry untouched
    expect(box.hasAttribute(SEE_ATTR)).toBe(false);
    expect([...(lone.geometry.getAttribute(SEE_ATTR).array as Float32Array)].every((v) => v === SEE_NEVER)).toBe(true);
  });

  it.skipIf(!assetIndex)("the real town: every static root has an id, spawn fades the great tree but not ground, and batching is unchanged", async () => {
    const L = new LayoutIndex(LAYOUT, assetIndex!);
    const assets = new AssetCache(ASSETS, L, { read: readGlb });
    const street = await SceneSpace.create(L, assets, STREET);
    const tea = await SceneSpace.create(L, assets, "tea_house");
    const noodle = await SceneSpace.create(L, assets, "noodle_shop");
    const room = await SceneSpace.create(L, assets, "room");
    expect(street.occluders.length).toBeGreaterThan(100);
    expect(street.occluders.length).toBeLessThanOrEqual(SEE_THROUGH.maxOccluders);
    expect(new Set(street.occluders.map((c) => c.id)).size).toBe(street.occluders.length);
    const great = street.occluders.find((c) => c.asset === "great_tree")!;
    // every root id is in the batches; the great tree's high branches carry it and its trunk does not
    const count = new Map<number, number>();
    const barkTags: number[] = [];
    street.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      const a = m.isMesh ? (m.geometry.getAttribute(SEE_ATTR) as THREE.BufferAttribute | undefined) : undefined;
      if (!a) return;
      for (const v of a.array as Float32Array) count.set(v, (count.get(v) ?? 0) + 1);
      if (m.name === "batch:town_bark") barkTags.push(...(a.array as Float32Array));
    });
    for (const c of street.occluders) expect(count.get(SEE_ID0 + c.id), c.asset).toBeGreaterThan(0);
    expect(barkTags.filter((v) => v === SEE_ID0 + great.id).length).toBeGreaterThan(0);
    expect(barkTags.filter((v) => v === SEE_NEVER).length).toBeGreaterThan(0);
    expect(count.get(SEE_NEVER)).toBeGreaterThan(0);
    // landscape, plaza and far edge stay never-faded; each building/prop root has its own id
    const tagOf = (name: string) => (street.scene.getObjectByName(name)!.userData.see as { tag: number }).tag;
    for (const g of ["terrain_town", "lake", "canal_water", "canal_banks", "plaza_round", "horizon_skirt", "ground_apron", "hills_ring", "mountains_far", "mountains_far_echo", "countryside"]) expect(tagOf(g), g).toBe(SEE_NEVER);
    // the countryside (horizon.ts): the apron, the skirt, both mountain rings, the hills and trees in one vertex-coloured batch, never cut
    const vc = street.scene.children.filter((c) => c.name === "batch:vertex_colours") as THREE.Mesh[];
    expect(vc.length).toBe(1);
    expect(new Set(vc[0].geometry.getAttribute(SEE_ATTR).array as Float32Array)).toEqual(new Set([SEE_NEVER]));
    expect(street.countryside).toMatchObject({ near: "#78a152", far: "#93af86" });
    expect(street.countryside!.hills).toBeGreaterThanOrEqual(24);
    for (const h of ["tea_house", "pavilion", "street_lamp", "bridge_stone_arch", "noodle_shop", "willow"]) expect(tagOf(h), h).toBeGreaterThanOrEqual(SEE_ID0);
    const r = rig();
    const spawn = new THREE.Vector3(...L.spawn(LAYOUT.defaultPlace).pos);
    r.snap(spawn);
    const see = new SeeThroughControl();
    for (let i = 0; i < 120; i++) see.update(1 / 60, [spawn], street.occluders, [hits([[great.id, 6]])]);
    expect(see.vis[great.id]).toBeCloseTo(SEE_THROUGH.fadeTo);
    expect(tagOf("plaza_round")).toBe(SEE_NEVER);
    // every static mesh drawn with a patched material carries the tag; what isn't patched
    const actorRoots = new Set<THREE.Object3D>([...street.npcs.values()].map((v) => v.actor.root).concat(street.walkers.map((w) => w.actor.root), street.extras.map((a) => a.root), street.scatterers.map((s) => s.actor.root)));
    const inActor = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (actorRoots.has(p)) return true;
      return false;
    };
    for (const sp of [street, tea])
      sp.scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material) || !m.material.visible) return;
        if (inActor(m)) {
          // characters and their hulls never; what they hold may be (it has no tag: read as never)
          if ((m as THREE.SkinnedMesh).isSkinnedMesh) expect(isSeeThrough(m.material), m.name).toBe(false);
          return;
        }
        if (isSeeThrough(m.material)) expect(m.geometry.hasAttribute(SEE_ATTR), m.name).toBe(true);
      });
    const skinnedMats = [...street.npcs.values()].flatMap((v) => {
      const out: THREE.Material[] = [];
      v.actor.root.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && out.push((o as THREE.Mesh).material as THREE.Material));
      return out;
    });
    expect(skinnedMats.length).toBeGreaterThan(8); // bodies and hulls
    expect(skinnedMats.every((m) => !isSeeThrough(m))).toBe(true);
    const sky = street.scene.getObjectByName("sky_dome")!;
    sky.traverse((o) => (o as THREE.Mesh).isMesh && expect(isSeeThrough((o as THREE.Mesh).material as THREE.Material)).toBe(false));
    street.scene.getObjectByName("clouds")!.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.outline && expect(isSeeThrough((o as THREE.Mesh).material as THREE.Material)).toBe(false));
    const { GuideMarker } = await import("../src/marker");
    const { PathTrail } = await import("../src/wayview");
    for (const r of [new GuideMarker().root, new PathTrail().mesh]) r.traverse((o) => (o as THREE.Mesh).isMesh && expect(isSeeThrough((o as THREE.Mesh).material as THREE.Material)).toBe(false));
    // the static world's hull cut with it (a batch of hulls: the shared outline material, patched)
    const hullBatch = street.scene.children.find((c) => c.userData.outline && (c as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(isSeeThrough(hullBatch.material as THREE.Material)).toBe(true);
    expect((hullBatch.material as THREE.ShaderMaterial).fragmentShader).toContain("stSeeThrough();");
    // draw calls: no more than before the see-through (0.13 at 17485a1: street 123, tea house 19; the countryside: 119)
    console.log(`see-through draw calls: street ${street.batching.before} -> ${street.batching.after}, tea_house ${tea.batching.before} -> ${tea.batching.after}`);
    expect(street.batching.after).toBeLessThanOrEqual(123);
    // Preserve the room batching guard separately from what the interior view adds on purpose: its
    // backdrop, its six enclosure planes and the shell's front-side twins (interior-enclosure.ts
    // interiorFaces: single-sided, so they cannot share a batch with double-sided furniture).
    const shell = tea.scene.getObjectByName("tea_house_shell")!;
    expect(drawCalls(shell)).toBeLessThanOrEqual(10);
    expect(tea.batching.after - drawCalls(tea.scene.getObjectByName("interior_backdrop")!) - drawCalls(tea.scene.getObjectByName("interior_enclosure")!) - drawCalls(shell)).toBeLessThanOrEqual(19);
  }, 60_000);
});
