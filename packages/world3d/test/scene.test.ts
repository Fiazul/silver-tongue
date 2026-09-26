// Headless build of every scene space from the real GLBs (no WebGL: three builds scene graphs
// without a renderer): catches layout/anchor/asset mistakes that only show at runtime.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { LAYOUT, LayoutIndex } from "../src/layout";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex } from "./helpers";


describe.skipIf(!assetIndex)("scene spaces from the real GLBs", () => {
  it("builds the street and every interior; NPCs, walkers, pigeons and props are where the layout says", async () => {
    const L = new LayoutIndex(LAYOUT, assetIndex!);
    const assets = new AssetCache(ASSETS, L);
    // Read GLBs from disk instead of fetching them.
    const loader = (assets as unknown as { loader: { parseAsync(d: ArrayBuffer, p: string): Promise<unknown>; loadAsync(u: string): Promise<unknown> } }).loader;
    loader.loadAsync = (url: string) => {
      const buf = readFileSync(url);
      return loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
    };
    await assets.preload();
    const spaces = new Map<string, SceneSpace>();
    for (const id of L.spaceIds()) spaces.set(id, await SceneSpace.create(L, assets, id));
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
});
