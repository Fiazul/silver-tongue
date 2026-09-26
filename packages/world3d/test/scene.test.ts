// Headless build of every scene space from the real GLBs (no WebGL: three builds scene graphs
// without a renderer): catches layout/anchor/asset mistakes that only show at runtime.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { newGame } from "@silver-tongue/core";
import { PlayerCarry } from "../src/carry";
import { LAYOUT, LayoutIndex, type Box2 } from "../src/layout";
import { blocked } from "../src/movement";
import { ZONE_MARGIN } from "../src/spaces";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, course, makeGame } from "./helpers";

/** Every space built from the real GLBs, read from disk instead of fetched (once for the file). */
let built: Promise<{ L: LayoutIndex; assets: AssetCache; spaces: Map<string, SceneSpace> }> | undefined;
function buildAll() {
  built ??= (async () => {
    const L = new LayoutIndex(LAYOUT, assetIndex!);
    const assets = new AssetCache(ASSETS, L);
    const loader = (assets as unknown as { loader: { parseAsync(d: ArrayBuffer, p: string): Promise<unknown>; loadAsync(u: string): Promise<unknown> } }).loader;
    loader.loadAsync = (url: string) => {
      const buf = readFileSync(url);
      return loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
    };
    await assets.preload();
    const spaces = new Map<string, SceneSpace>();
    for (const id of L.spaceIds()) spaces.set(id, await SceneSpace.create(L, assets, id));
    return { L, assets, spaces };
  })();
  return built;
}

describe.skipIf(!assetIndex)("scene spaces from the real GLBs", () => {
  it("builds the street and every interior; NPCs, walkers, pigeons and props are where the layout says", async () => {
    const { spaces } = await buildAll();
    const street = spaces.get("street")!;
    // static batching: the street's ~770 draw calls cut to under 250, characters left out of it
    for (const [id, sp] of spaces) console.log(`draw calls ${id}: ${sp.batching.before} -> ${sp.batching.after} (${sp.batching.merged} meshes merged)`);
    expect(street.batching.before).toBeGreaterThan(500);
    expect(street.batching.after).toBeLessThan(250);
    for (const sp of spaces.values()) {
      expect(sp.batching.after).toBeLessThanOrEqual(sp.batching.before);
      for (const v of sp.npcs.values()) expect(v.actor.root.parent, v.npc).toBe(sp.scene);
      for (const w of sp.walkers) expect(w.actor.root.parent).toBe(sp.scene);
    }
    expect(street.walkers.length).toBeGreaterThanOrEqual(4);
    expect(street.scatterers.length).toBe(3);
    expect([...spaces.get("noodle_shop")!.npcs.keys()]).toEqual(["cook"]);
    expect([...spaces.get("room")!.npcs.keys()]).toEqual(["landlord"]);
    expect([...spaces.get("warehouse")!.npcs.keys()]).toEqual(["foreman"]);
    expect([...street.npcs.keys()].sort()).toEqual(["dispatcher", "wang"]);
    expect([...spaces.get("station_road")!.npcs.keys()].sort()).toEqual(["classmate", "doctor", "driver", "teacher", "traveller"]);
    expect([...spaces.get("tea_house")!.npcs.keys()]).toEqual(["teaboss"]);
    expect([...spaces.get("shop")!.npcs.keys()]).toEqual(["shopkeeper"]);
    expect([...spaces.get("stairs")!.npcs.keys()]).toEqual(["neighbour"]);
    // Station Road is a street (sky and fog, the full day's light), the rest are rooms
    expect(spaces.get("station_road")!.layout.interior).toBe(false);
    expect(spaces.get("station_road")!.scene.fog).toBeTruthy();
    expect(spaces.get("station_road")!.walkers.length).toBeGreaterThanOrEqual(1);
    expect(spaces.get("shop")!.scene.getObjectByName("shop_counter")).toBeDefined();
    expect(spaces.get("tea_house")!.scene.getObjectByName("tea_interior:table_round")).toBeDefined();
    // hand props: no carry pose; Wang holds the fan on the grip bone
    for (const s of spaces.values())
      for (const v of s.npcs.values()) {
        expect(v.actor.carrying, v.npc).toBe(false);
        v.actor.update(1 / 60, 0);
        expect(v.actor.state, v.npc).toBe("idle");
      }
    const fan = street.npcs.get("wang")!.actor.bone("RightHandGrip")!.children;
    expect(fan.length).toBe(1);
    // frames run: walkers walk, pigeons scatter from a player next to them, a shrug plays
    const pigeon = street.scatterers[0];
    const player = new THREE.Vector3(pigeon.motion.x + 0.5, 0.18, pigeon.motion.z);
    street.shrug("wang");
    street.update(1 / 60, player, null);
    expect(street.npcs.get("wang")!.actor.shrugging).toBe(true);
    expect(street.npcs.get("wang")!.actor.state).toBe("talk"); // no shrug clip: talk + head shake
    for (let i = 0; i < 90; i++) street.update(1 / 60, player, null);
    expect(pigeon.motion.away).toBeGreaterThan(0.5);
    expect(street.walkers.some((w) => w.actor.state === "walk")).toBe(true);
    expect(street.npcs.get("wang")!.actor.shrugging).toBe(false);
    street.setDaylight(1);
    // interiors: shell furniture placed, no hideable wall drawn, blockers from furniture
    const room = spaces.get("room")!;
    expect(room.scene.getObjectByName("room_interior:bed_single")).toBeDefined();
    expect(room.scene.getObjectByName("room_shell_wall_x")).toBeUndefined();
    expect(room.blockers.length).toBeGreaterThan(3);
    expect(spaces.get("noodle_shop")!.scene.getObjectByName("noodle_counter")).toBeDefined();
    // picking the bed's tap box from above
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const bed = room.layout.interactables.find((x) => x.kind === "sleep")!;
    cam.position.set(bed.pos[0], 10, bed.pos[2]);
    cam.lookAt(bed.pos[0], 0, bed.pos[2]);
    cam.updateMatrixWorld();
    room.scene.updateMatrixWorld(); // the renderer does this each frame
    expect(room.pick(new THREE.Vector2(0, 0), cam)).toEqual({ target: "sleep:0" });
  }, 30_000);

  it("with the real blockers (street buildings by their footprint): every talk stand, entry and exit spawn, and a spot deep in every trigger is walkable", async () => {
    const { L, spaces } = await buildAll();
    for (const [id, sp] of spaces) {
      const free = (x: number, z: number) => !blocked(x, z, sp.blockers, sp.layout.bounds);
      for (const n of sp.layout.npcs) {
        const p = L.talkStand(n).pos;
        expect(free(p[0], p[2]), `${id}: ${n}'s talk stand`).toBe(true);
      }
      if (sp.layout.interior || id !== "street") {
        const e = L.entrySpawn(id).pos;
        expect(free(e[0], e[2]), `${id}: entry`).toBe(true);
        const outer = spaces.get(L.outerSpace(id)!)!;
        const o = L.exitSpawn(id).pos;
        expect(!blocked(o[0], o[2], outer.blockers, outer.layout.bounds), `${id}: exit spawn in ${outer.id}`).toBe(true);
      }
      for (const place of Object.keys(course.world.places))
        if (L.spaceOf(place) === id && !LAYOUT.places[place]?.interior) {
          const p = L.spawn(place).pos;
          expect(free(p[0], p[2]), `${id}: ${place} spawn`).toBe(true);
        }
      // the zone tracker fires only 0.25 m inside a trigger: there must be a free spot that deep
      for (const t of sp.layout.triggers) {
        const deep: Box2 = { min: [t.box.min[0] + ZONE_MARGIN, t.box.min[1] + ZONE_MARGIN], max: [t.box.max[0] - ZONE_MARGIN, t.box.max[1] - ZONE_MARGIN] };
        let reach = false;
        for (let x = deep.min[0]; x <= deep.max[0] + 1e-9 && !reach; x += 0.05) for (let z = deep.min[1]; z <= deep.max[1] + 1e-9 && !reach; z += 0.05) reach = free(x, z);
        expect(reach, `${id}: ${t.kind} ${t.place} is walled off`).toBe(true);
      }
    }
  }, 30_000);

  it("the player carries the parcel while an errand is on (carry clips), puts it down after, and a restored save has it in hand", async () => {
    const { assets } = await buildAll();
    const spec = LAYOUT.player.errandProp!;
    expect(spec).toEqual({ asset: "delivery_bag", carry: true });
    const actor = await assets.actor(LAYOUT.player.character);
    const carry = new PlayerCarry(actor, await assets.instance("delivery_bag"), spec);
    carry.sync(null);
    expect(carry.holding).toBe(false);
    // a save made mid-errand: the model has it, so the first sync puts the bag in hand
    const { game } = makeGame({ ...newGame(course), player: "Sam", place: "market", errand: { to: "school" } });
    expect(game.model.hud.errand).toEqual({ to: "school", placeName: game.t("place-school") });
    carry.sync(game.model.hud.errand);
    expect(carry.holding).toBe(true);
    expect(actor.carrying).toBe(true);
    expect(actor.bone("RightHandGrip")!.children).toContain(actor.held);
    actor.update(1 / 60, 0);
    expect(actor.state).toBe("carry_idle");
    for (let i = 0; i < 10; i++) actor.update(1 / 60, 1.4);
    expect(actor.state).toBe("carry_walk");
    carry.sync(game.model.hud.errand); // idempotent
    expect(actor.bone("RightHandGrip")!.children.length).toBe(1);
    // delivered: put down, back to the plain clips
    carry.sync(null);
    expect(carry.holding).toBe(false);
    expect(actor.carrying).toBe(false);
    expect(actor.bone("RightHandGrip")!.children.length).toBe(0);
    for (let i = 0; i < 10; i++) actor.update(1 / 60, 0);
    expect(actor.state).toBe("idle");
  }, 30_000);
});
