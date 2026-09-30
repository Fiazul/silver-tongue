// The shop (layout.json interiors.shop): a believable room (fixtures against walls or in aisles,
// nothing overlapping, floating or outside the walls, 1.2 m aisles), the products on its shelves
// (goods: each one's hotspot → the core input its seller's counter sends), the item in hand, and
// the objective served by the hotspot route.
import { describe, expect, it } from "vitest";
import { newGame, type GameState, type Input } from "@silver-tongue/core";
import { guideFinished } from "../src/guide";
import { LAYOUT, LayoutIndex, boxesOverlap, expandGrid, type Box2, type Placement } from "../src/layout";
import { blocked, PLAYER_RADIUS, step } from "../src/movement";
import { GOODS_RANGE, nearestPrompt, promptTargets } from "../src/spaces";
import { aisleRoute, handProp, ShopHand } from "../src/shop";
import { buildPathGrid, findPath } from "../src/wayfind";
import { AssetCache } from "../src/world";
import { ASSETS, assetIndex, course, makeGame, playScene, readGlb } from "./helpers";

const L = assetIndex ? new LayoutIndex(LAYOUT, assetIndex) : undefined;
const ID = "shop";
const NPC = "shopkeeper";
const EPS = 0.011;

/** Every blocker the built shop has: pieces by their index size, the layout's own boxes, a box per NPC (world.ts). */
function shopBlockers(L: LayoutIndex): { what: string; box: Box2 }[] {
  const sp = L.space(ID);
  return [
    ...sp.pieces.flatMap((p) => (p.block === "size" && L.sizeBlocker(p) ? [{ what: p.id, box: L.sizeBlocker(p)! }] : [])),
    ...sp.blockers.map((box, i) => ({ what: `blocker ${i}`, box })),
    ...sp.npcs.map((n) => {
      const p = L.npcStand(n).pos;
      return { what: n, box: { min: [p[0] - 0.25, p[2] - 0.25], max: [p[0] + 0.25, p[2] + 0.25] } as Box2 };
    }),
  ];
}

/** A placement's x/z footprint from its index size (turned by rotY), and its base / top heights. */
function footprint(L: LayoutIndex, p: Placement) {
  const a = L.asset(p.asset);
  const [sx, sy, sz] = a.size_m;
  const rad = (p.rotY * Math.PI) / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const hx = (sx * c + sz * s) / 2, hz = (sx * s + sz * c) / 2;
  // grip-origin props (the scanner) hang below their origin: their base is the mesh's lowest point
  const base = a.origin === "grip" ? p.pos[1] - 0.066 : p.pos[1];
  return { box: { min: [p.pos[0] - hx, p.pos[2] - hz], max: [p.pos[0] + hx, p.pos[2] + hz] } as Box2, base, top: base + sy, wall: !!a.wall_piece };
}

const inside = (b: Box2, room: Box2) =>
  b.min[0] >= room.min[0] - EPS && b.max[0] <= room.max[0] + EPS && b.min[1] >= room.min[1] - EPS && b.max[1] <= room.max[1] + EPS;
const shrink = (b: Box2, k: number): Box2 => ({ min: [b.min[0] + k, b.min[1] + k], max: [b.max[0] - k, b.max[1] - k] });

/** States of the shop: nothing unlocked yet, the first chat open, buying open (and money), buying open without money. */
const named = (): GameState => ({ ...newGame(course), player: "Sam", place: "shop" });
const states = {
  fresh: () => named(),
  intro: (): GameState => ({ ...named(), scenesDone: { "noodle-kitchen": 1, "room-rent": 1 } }),
  buy: (): GameState => ({ ...named(), wallet: 30, scenesDone: { "noodle-kitchen": 1, "room-rent": 1, "shop-intro": 1 }, trust: { shopkeeper: 1 } }),
  broke: (): GameState => ({ ...named(), wallet: 1, scenesDone: { "noodle-kitchen": 1, "room-rent": 1, "shop-intro": 1 }, trust: { shopkeeper: 1 } }),
};

describe.skipIf(!L)("the shop's layout", () => {
  const sp = L!.space(ID);
  const room = sp.view!.bounds;

  it("is a bigger room than the old 6 x 5 m box (6.4 x 5.4 m, 2.9 m high), its walls and floor on its size", () => {
    expect(room).toEqual({ min: [-3.2, -5.4], max: [3.2, 0] });
    const g = (n: string) => sp.ground.find((x) => x.name === n)!;
    expect(g("shop_floor").min.slice(0, 1).concat(g("shop_floor").max[0])).toEqual([-3.2, 3.2]);
    expect(g("shop_back").max[2]).toBe(-5.4);
    expect(g("shop_left").max[0]).toBe(-3.2);
    expect(sp.view!.ceiling).toBe(2.9);
  });

  it("fixtures: no two blockers overlap, every one inside the walls; the counter, fridge, gondolas, wall shelves, stand and tables are all there", () => {
    const all = shopBlockers(L!);
    for (const a of all) expect(inside(a.box, room), `${a.what} outside the walls`).toBe(true);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(boxesOverlap(all[i].box, all[j].box), `${all[i].what} overlaps ${all[j].what}`).toBe(false);
    const ids = sp.pieces.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith("shop_wall_shelf_"))).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("shop_gondola_a_"))).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("shop_gondola_b_"))).toHaveLength(2); // one unit: the till keeps clear of its aisle
    expect(ids).toEqual(expect.arrayContaining(["shop_table_cups", "shop_table_books", "shop_freezer"]));
    const names = sp.ground.map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(["shop_counter", "shop_counter_top", "shop_fridge_body", "shop_stand", "shop_baskets"]));
    // no noodle counter or bowls (the noodle shop's); the scanner and a bag on the checkout counter
    const assets = [...sp.pieces, ...sp.dressing].map((p) => p.asset);
    for (const a of ["counter_noodle", "bowl_noodles", "bowl_soup"]) expect(assets).not.toContain(a);
    const top = sp.ground.find((g) => g.name === "shop_counter_top")!;
    for (const a of ["barcode_scanner", "takeaway_bag"]) {
      const d = sp.dressing.find((x) => x.asset === a)!;
      expect(inside(shrink({ min: [d.pos[0], d.pos[2]], max: [d.pos[0], d.pos[2]] }, 0), { min: [top.min[0], top.min[2]], max: [top.max[0], top.max[2]] }), a).toBe(true);
    }
    // the clerk stands behind the counter, the player talks from its front
    const counter = sp.ground.find((g) => g.name === "shop_counter")!;
    expect(L!.npcStand(NPC).pos[0]).toBeGreaterThan(counter.max[0]);
    expect(L!.talkStand(NPC).pos[0]).toBeLessThan(counter.min[0]);
    expect(L!.npcStand(NPC).pos[2]).toBeGreaterThan(counter.min[2]);
    expect(L!.npcStand(NPC).pos[2]).toBeLessThan(counter.max[2]);
  });

  it("nothing floats: every dressing stands on the floor, a fixture's top, a shelf or another prop; wall pieces hang on a wall; boxes stay under the ceiling", () => {
    const floor = sp.surfaces.default;
    const tops: { box: Box2; y: number }[] = [
      ...sp.ground.map((g) => ({ box: { min: [g.min[0], g.min[2]], max: [g.max[0], g.max[2]] } as Box2, y: g.max[1] })),
      ...sp.pieces.map((p) => ({ box: footprint(L!, p).box, y: footprint(L!, p).top })),
      ...sp.dressing.map((d) => ({ box: footprint(L!, d).box, y: footprint(L!, d).top })),
    ];
    for (const d of sp.dressing) {
      const f = footprint(L!, d);
      const at = (b: Box2) => d.pos[0] >= b.min[0] - EPS && d.pos[0] <= b.max[0] + EPS && d.pos[2] >= b.min[1] - EPS && d.pos[2] <= b.max[1] + EPS;
      if (f.wall) {
        const onWall = Math.abs(f.box.min[1] - room.min[1]) < 0.02 || Math.abs(f.box.min[0] - room.min[0]) < 0.02 || Math.abs(f.box.max[0] - room.max[0]) < 0.02;
        expect(onWall, `${d.asset} at ${d.pos} is off the walls`).toBe(true);
        expect(inside(f.box, room), `${d.asset} at ${d.pos}`).toBe(true);
        continue;
      }
      const onSomething = Math.abs(f.base - floor) < 0.005 || tops.some((t) => Math.abs(t.y - f.base) < 0.005 && at(t.box));
      expect(onSomething, `${d.asset} at ${d.pos} floats`).toBe(true);
      expect(inside(f.box, room), `${d.asset} at ${d.pos} outside the walls`).toBe(true);
    }
    for (const g of sp.ground) expect(g.max[1], g.name).toBeLessThanOrEqual(sp.view!.ceiling + 1e-9);
  });

  it("props of one layer don't overlap (crates on the stand, cups on their table, bottles in the fridge)", () => {
    const items = sp.dressing.filter((d) => !L!.asset(d.asset).wall_piece).map((d) => ({ d, f: footprint(L!, d) }));
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (Math.abs(a.f.base - b.f.base) > 0.005) continue;
        // index sizes are a hair over the meshes: shrink 3 mm
        expect(boxesOverlap(shrink(a.f.box, 0.003), shrink(b.f.box, 0.003)), `${a.d.asset} ${a.d.pos} / ${b.d.asset} ${b.d.pos}`).toBe(false);
      }
  });

  it("the grid dressing expands into its copies", () => {
    const bottles = sp.dressing.filter((d) => d.asset === "bottle_water");
    expect(bottles.length).toBe(4 * 2 * 9);
    expect(sp.dressing.every((d) => !d.grid)).toBe(true);
    expect(expandGrid({ asset: "x", pos: [0, 0, 0], rotY: 0, grid: { count: [2, 1, 3], step: [1, 0, 2] } }).map((p) => p.pos)).toEqual([
      [0, 0, 0], [0, 0, 2], [0, 0, 4], [1, 0, 0], [1, 0, 2], [1, 0, 4],
    ]);
  });

  it("aisles are at least 1.2 m: a 1.2 m wide body gets from the door to every product and to the counter", () => {
    const blockers = shopBlockers(L!).map((b) => b.box);
    const entry = L!.entrySpawn(ID).pos;
    // a disc of 0.6 m radius (Euclidean: an aisle's width is the gap between fixtures, corners too)
    const gap = (b: Box2, x: number, z: number) => Math.hypot(Math.max(b.min[0] - x, 0, x - b.max[0]), Math.max(b.min[1] - z, 0, z - b.max[1]));
    const room = sp.view!.bounds;
    const tooNear = (x: number, z: number) =>
      x < room.min[0] + 0.6 || x > room.max[0] - 0.6 || z < room.min[1] + 0.6 || z > sp.bounds.max[1] || blockers.some((b) => gap(b, x, z) < 0.6);
    const grid = buildPathGrid(sp.bounds, 0.05, () => 1, tooNear);
    const goals = [...sp.goods.map((g) => ({ what: g.id, p: g.stand.pos })), { what: "counter", p: L!.talkStand(NPC).pos }];
    for (const g of goals) {
      // the open cell (a 1.2 m body's centre fits) nearest the stand: close enough to take / talk from
      let best: [number, number] | null = null;
      for (let j = 0; j < grid.rows; j++)
        for (let i = 0; i < grid.cols; i++) {
          if (!grid.cost[j * grid.cols + i]) continue;
          const c: [number, number] = [grid.x0 + (i + 0.5) * grid.cell, grid.z0 + (j + 0.5) * grid.cell];
          if (!best || Math.hypot(c[0] - g.p[0], c[1] - g.p[2]) < Math.hypot(best[0] - g.p[0], best[1] - g.p[2])) best = c;
        }
      expect(Math.hypot(best![0] - g.p[0], best![1] - g.p[2]), g.what).toBeLessThan(Math.min(GOODS_RANGE, 0.45));
      // from the door (a 1.2 m body centred within 0.35 m of the entry spot: it stands in the open front)
      expect(findPath(grid, [entry[0], entry[2]], best!, 0.35), `no 1.2 m way to ${g.what}`).not.toBeNull();
    }
  });

  it("the player walks from the door to every product, and from every product to the counter, along the route main.ts gives them", () => {
    const blockers = shopBlockers(L!).map((b) => b.box);
    const entry = L!.entrySpawn(ID).pos;
    const counter = L!.talkStand(NPC).pos;
    const walk = (from: number[], to: number[], what: string) => {
      const route = aisleRoute(sp.bounds, blockers, [from[0], from[2]], [to[0], to[2]]);
      expect(route, what).not.toBeNull();
      let [x, z] = [from[0], from[2]];
      for (const [tx, tz] of route!)
        for (let k = 0; k < 2000 && Math.hypot(tx - x, tz - z) > 0.05; k++) {
          const d = Math.hypot(tx - x, tz - z);
          [x, z] = step(x, z, (tx - x) / d, (tz - z) / d, Math.min(d, 3.2 / 60), blockers, sp.bounds);
        }
      expect(Math.hypot(to[0] - x, to[2] - z), `${what}: stuck at ${x.toFixed(2)},${z.toFixed(2)}`).toBeLessThan(0.06);
    };
    for (const g of sp.goods) {
      expect(blocked(g.stand.pos[0], g.stand.pos[2], blockers, sp.bounds, PLAYER_RADIUS), `${g.id} stand blocked`).toBe(false);
      walk(entry, g.stand.pos, `door → ${g.id}`);
      walk(g.stand.pos, counter, `${g.id} → counter`);
    }
  });

  it("each product's prompt: in range at its stand (the nearest one there), out of range at the counter, which talks", () => {
    const targets = promptTargets(L!, ID, false);
    for (const g of sp.goods) {
      const here = nearestPrompt(L!, ID, targets, g.stand.pos[0], g.stand.pos[2]);
      expect(here?.id, g.id).toBe(`goods:${g.id}`);
      expect(here?.range).toBe(GOODS_RANGE);
      // the product is where the stand faces, within reach
      const f = g.stand.facing, v = [g.at[0] - g.stand.pos[0], g.at[2] - g.stand.pos[2]];
      expect(f[0] * v[0] + f[2] * v[1], g.id).toBeGreaterThan(0.3);
      expect(Math.hypot(v[0], v[1]), g.id).toBeLessThan(1.1);
    }
    const c = L!.talkStand(NPC).pos;
    expect(nearestPrompt(L!, ID, targets, c[0], c[2])?.id).toBe(`talk:${NPC}`);
  });
});

describe("shop goods → core inputs", () => {
  const goods = LAYOUT.interiors.shop.goods!;
  const word = (concept: string) => course.concepts[concept][0];
  const sold = new Set(course.groups.goods);

  it("covers the items the shop's scenes sell and the drinks and vegetables it stocks, each a concept of the course", () => {
    expect(goods.map((g) => g.concept).sort()).toEqual(["apple", "book", "cup", "tea", "vegetables", "water"]);
    for (const g of goods) {
      expect(word(g.concept), g.concept).toBeDefined();
      expect(g.npc).toBe(NPC);
    }
    for (const item of sold) expect(goods.some((g) => g.concept === item), item).toBe(true);
  });

  it("buying open: the goods shop-buy sells start it with the item picked, the rest are their word; the counter sends the same", () => {
    for (const g of goods) {
      const { game, core } = makeGame(states.buy());
      const plan = game.shopItem(NPC, g.concept);
      expect(plan.word).toBe(word(g.concept));
      if (sold.has(g.concept)) {
        const input: Input = { type: "startScene", scene: "shop-buy", pick: { item: g.concept } };
        expect(plan).toEqual({ kind: "buy", word: word(g.concept), input });
        // at the counter, the item in hand: talkTo sends exactly that, and the clerk asks about it
        game.talkTo(NPC, g.concept);
        expect(core.sent.at(-1)).toEqual(input);
        expect(core.state.run?.combo.item).toBe(g.concept);
        const cost = game.model.reply!.cost!;
        const wallet = core.state.wallet;
        playScene(game);
        expect(core.state.wallet).toBe(wallet - cost);
      } else {
        expect(plan).toEqual({ kind: "look", word: word(g.concept) });
        // talking with it in hand is the plain talk (core chooses the item), as without it
        game.talkTo(NPC, g.concept);
        expect(core.sent.at(-1)).toEqual({ type: "startScene", scene: "shop-buy" });
      }
    }
  });

  it("the first chat open: every product takes you to it (no item picked: the scene has no slot)", () => {
    for (const g of goods) {
      const { game, core } = makeGame(states.intro());
      expect(game.shopItem(NPC, g.concept)).toEqual({ kind: "ask", word: word(g.concept) });
      game.talkTo(NPC, g.concept);
      expect(core.sent.at(-1)).toEqual({ type: "startScene", scene: "shop-intro" });
    }
  });

  it("nothing open (a fresh game) or no money: the word only, and why (the TUI menu's needs-money line); no input sent", () => {
    for (const g of goods) {
      const fresh = makeGame(states.fresh());
      expect(fresh.game.shopItem(NPC, g.concept)).toEqual({ kind: "look", word: word(g.concept) });
      expect(fresh.core.sent).toEqual([]);
      const broke = makeGame(states.broke());
      const need = broke.game.t("menu-needs-money", { npc: broke.game.npcName(NPC), scene: broke.game.t("scene-shop-buy"), currency: course.world.currency, cost: 5 });
      expect(broke.game.shopItem(NPC, g.concept)).toEqual({ kind: "look", word: word(g.concept), note: need });
      expect(broke.core.sent).toEqual([]);
    }
  });

  it("in a scene, or elsewhere: nothing to buy", () => {
    const { game } = makeGame(states.buy());
    game.talkTo(NPC);
    expect(game.core.state.run).not.toBeNull();
    expect(game.shopItem(NPC, "apple").kind).toBe("look");
    const away = makeGame({ ...states.buy(), place: "market" });
    expect(away.game.shopItem(NPC, "apple").kind).toBe("look");
  });
});

describe("the guide and the objective through the hotspot route", () => {
  it("whenever a shop scene can start, the first-steps guide is over (it never names the shop); the objective's shop scene is done by taking an item to the counter", () => {
    for (const st of [states.intro(), states.buy()]) expect(guideFinished(course, st)).toBe(true);
    const { game, core } = makeGame({ ...states.intro(), place: "shop" });
    expect(game.model.objective.scene).toBe("shop-intro");
    const plan = game.shopItem(NPC, "apple");
    expect(plan.kind).toBe("ask");
    game.talkTo(NPC, "apple"); // what main.ts does on arrival at the counter
    playScene(game);
    expect(core.state.scenesDone["shop-intro"]).toBe(1);
    expect(game.model.objective.scene).not.toBe("shop-intro");
    // and the next visit sells the apple itself
    expect(game.shopItem(NPC, "apple").kind).toBe(core.state.wallet >= 5 ? "buy" : "look");
  });
});

describe.skipIf(!L)("the item in hand", () => {
  it("goes on the player's right grip, one at a time; put back, it leaves the hand; a hand holding a parcel takes nothing", async () => {
    const assets = new AssetCache(ASSETS, L!, { read: readGlb });
    const actor = await assets.actor(LAYOUT.player.character);
    const hand = new ShopHand(actor, (h) => handProp(L!, assets, h));
    const grip = actor.bone("RightHandGrip")!;
    const spots = L!.space(ID).goods;
    for (const spot of spots) {
      expect(await hand.take(spot), spot.id).toBe(true);
      expect(hand.spot?.id).toBe(spot.id);
      expect(hand.inHand).toBe(true);
      expect(grip.children).toContain(actor.held);
      expect(grip.children.length).toBe(1); // the one before went back
      // held by its middle: the item's centre sits on the grip
      expect(actor.held!.name).toBe("shop_item");
      expect(actor.carrying).toBe(false);
    }
    hand.putBack();
    expect(hand.spot).toBeNull();
    expect(grip.children.length).toBe(0);
    expect(actor.held).toBeNull();
    // taken and put back before the prop landed: nothing ends up in the hand
    const late = hand.take(spots[0]);
    hand.putBack();
    expect(await late).toBe(false);
    expect(grip.children.length).toBe(0);
    // a parcel in hand: the item is still the one being bought, but nothing goes on the grip
    const bag = await assets.instance("delivery_bag");
    actor.hold(bag, { carry: true });
    expect(await hand.take(spots[0])).toBe(false);
    expect(hand.spot?.id).toBe(spots[0].id);
    expect(actor.held).toBe(bag);
    hand.putBack();
    expect(actor.held).toBe(bag);
  }, 30_000);
});
