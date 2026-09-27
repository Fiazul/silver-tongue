// The canal town as the outdoor space: src/town.json is the port of the vendored town.json,
// every walkable cell is some place and the right one, every place of the course is a zone, a
// door or travel-only, the walking heights (terrain, plaza, bridges, pier), water unwalkable,
// the oriented blockers.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gridClass, LAYOUT, LayoutIndex, STREET, type Vec2 } from "../src/layout";
import { blocked, PLAYER_RADIUS, step } from "../src/movement";
import { ASSETS, assetIndex, course } from "./helpers";
// @ts-expect-error plain JS script, no types
import { portTown, readTownSources, townJsonText } from "../scripts/port-town.mjs";

const town = LAYOUT.town;
const g = town.grid;
const hasSources = existsSync(`${ASSETS}/town_layout/town.json`);
const OUTDOORS = ["street", "market", "station_road"];
const TRAVEL_ONLY = ["hospital", "school", "warehouse"];

describe.skipIf(!hasSources)("src/town.json", () => {
  it("is the port of the vendored town (npm run port-town regenerates it)", () => {
    const { town: src, grid, index } = readTownSources(ASSETS);
    const fresh = townJsonText(portTown(src, grid, index));
    expect(fresh === readFileSync(new URL("../src/town.json", import.meta.url), "utf8"), "src/town.json is stale: run npm run port-town -w @silver-tongue/world3d").toBe(true);
    expect(town.buildings.length).toBe(src.placements.length);
    expect(town.blockers.length).toBe(src.walkable.blockers.length);
  });
});

describe.skipIf(!assetIndex)("the town as the outdoor space", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const free = (x: number, z: number) => !blocked(x, z, L.space(STREET).blockers, town.bounds, PLAYER_RADIUS, (a, b) => L.walkable(STREET, a, b));

  /** Every walkable cell the player can reach from the spawn (4-neighbour flood over walkable cell centres, decks included). */
  function reachableCells(): Vec2[] {
    const s = L.spawn(LAYOUT.defaultPlace).pos;
    const key = (i: number, j: number) => j * g.cols + i;
    const centre = (i: number, j: number): Vec2 => [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell];
    const start: [number, number] = [Math.floor((s[0] - g.x0) / g.cell), Math.floor((s[2] - g.z0) / g.cell)];
    const seen = new Set([key(...start)]);
    const queue = [start];
    const out: Vec2[] = [];
    // a deck cell counts when its centre is on the deck (the bridges' slot cells)
    const ok = (i: number, j: number) => {
      const [x, z] = centre(i, j);
      return L.walkable(STREET, x, z);
    };
    while (queue.length) {
      const [i, j] = queue.shift()!;
      out.push(centre(i, j));
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const [ni, nj] = [i + di, j + dj];
        if (ni < 0 || nj < 0 || ni >= g.cols || nj >= g.rows || seen.has(key(ni, nj)) || !ok(ni, nj)) continue;
        seen.add(key(ni, nj));
        queue.push([ni, nj]);
      }
    }
    return out;
  }

  it("the spawn is on the plaza, walkable and clear, at the plaza's top", () => {
    const s = L.spawn(LAYOUT.defaultPlace).pos;
    expect(gridClass(g, s[0], s[2])).toBe(3);
    expect(free(s[0], s[2])).toBe(true);
    expect(L.heightAt(STREET, s[0], s[2])).toBeCloseTo(town.plaza!.y, 6);
    expect(L.placeAt(STREET, s[0], s[2])).toBe("street");
  });

  it("every reachable walkable cell is some place, and the mapped one: plaza / spokes / tree / pier the street, the south bank the market, the east side and the gate Station Road", () => {
    const cells = reachableCells();
    expect(cells.length).toBeGreaterThan(5000); // the whole plateau, both banks, over both bridges
    const places = new Set(cells.map(([x, z]) => L.placeAt(STREET, x, z)));
    for (const p of places) expect([...OUTDOORS, "station", "noodle_shop", "room", "shop", "tea_house"], p).toContain(p);
    for (const p of OUTDOORS) expect(places.has(p), p).toBe(true);
    // both banks and both ends are reached: over the bridges, onto the pier
    const reached = (x: number, z: number) => cells.some(([cx, cz]) => Math.abs(cx - x) < 0.6 && Math.abs(cz - z) < 0.6);
    for (const [x, z] of [
      [-28.5, 18.5], // the stone bridge's crown
      [28.5, 18.5], // the wooden bridge
      [0.5, 26.5], // the south bank's pad
      [-38.5, 4.5], // out on the pier
      [0.5, 45.5], // through the town gate
    ])
      expect(reached(x, z), `${x},${z}`).toBe(true);
    const where: [string, number, number][] = [
      ["street", 0, 0], // plaza centre
      ["street", 0, -20], // spoke north
      ["street", 30, 0], // spoke east
      ["street", -30, 0], // spoke west
      ["street", -16.8, 11.5], // the great tree's altar
      ["street", -37, 3], // the pier
      ["street", -16, -19], // pad_nw (the tea house)
      ["market", 0, 13], // the promenade
      ["market", 13.5, 29], // the fruit stall
      ["market", -17, 30], // the noodle shop's front
      ["market", 0, 32], // loop_south
      ["market", -28, 18], // the stone bridge
      ["station_road", 14, -12.5], // pad_ne, in front of the corner shop and the rented room
      ["station_road", 19, 10.5], // pad_east, the pavilion's front
      ["station_road", 0, 40], // the town gate
    ];
    for (const [p, x, z] of where) expect(L.placeAt(STREET, x, z), `${x},${z}`).toBe(p);
  });

  it("every outdoor place of the course has a zone (the street: the default), every building place with a building here a door, the rest travel-only", () => {
    const places = LAYOUT.places;
    expect(L.space(STREET).defaultPlace).toBe("street");
    for (const p of ["market", "station_road"]) expect(places[p].zone, p).toBeDefined();
    const travel: string[] = [];
    for (const place of Object.keys(course.world.places)) {
      const p = places[place];
      if (place === "street" || p.zone) continue;
      if (p.travelOnly) {
        travel.push(place);
        expect(p.stay, place).toBeDefined();
        expect(p.door, place).toBeUndefined();
        continue;
      }
      // a door on one of the town's buildings (or, for the stairwell, in the room)
      expect(p.door, place).toBeDefined();
      expect(() => L.building(p.door!.building), place).not.toThrow();
      if ((p.space ?? STREET) === STREET) expect(town.buildings.some((b) => b.id === p.door!.building), place).toBe(true);
    }
    expect(travel.sort()).toEqual(TRAVEL_ONLY);
    // the station is the bus stop's stand: a door with no interior; the rooms open into their interiors
    expect(places.station.interior).toBeUndefined();
    expect(places.station.door?.building).toBe("bus_stop");
    for (const [p, b] of [
      ["noodle_shop", "noodle_shop"],
      ["room", "rented_room"],
      ["shop", "supermarket"],
      ["tea_house", "tea_house"],
    ])
      expect([places[p].door?.building, places[p].interior], p).toEqual([b, p]);
    // filler buildings are dressing: no place has one as its door
    for (const p of Object.values(places)) expect(p.door?.building ?? "").not.toMatch(/^filler_/);
  });

  it("walking heights: terrain (bilinear), the plaza's top, the bridges' decks, the pier's deck", () => {
    expect(L.heightAt(STREET, 0, 0)).toBeCloseTo(town.plaza!.y, 6);
    expect(L.heightAt(STREET, 0, 26)).toBeCloseTo(0, 6); // a pad
    expect(L.heightAt(STREET, -28, 18)).toBeCloseTo(1.6, 3); // the stone arch's crown
    expect(L.heightAt(STREET, 28, 18)).toBeCloseTo(0.12, 3); // the flat wooden bridge
    expect(L.heightAt(STREET, -38, 3.8)).toBeCloseTo(-0.232, 3); // the pier
    // the hills rise away from the plateau
    expect(L.heightAt(STREET, -60, -60)).toBeGreaterThan(1);
    // every outdoor NPC stands on the walking surface
    for (const n of L.space(STREET).npcs) {
      const p = L.npcStand(n).pos;
      expect(p[1], n).toBeCloseTo(L.heightAt(STREET, p[0], p[2]), 6);
    }
  });

  it("water is not walkable except on the decks; across each bridge and out along the pier is", () => {
    expect(L.walkable(STREET, 0, 18)).toBe(false); // the canal
    expect(L.walkable(STREET, -50, 10)).toBe(false); // the lake
    expect(L.walkable(STREET, -29.8, 18)).toBe(false); // the stone bridge's slot, off its deck
    expect(L.walkable(STREET, 200, 0)).toBe(false); // off the grid: the town's edge
    // walk straight across: from the promenade to the south bank over each bridge
    for (const x of [-28, 28]) {
      let [px, pz] = [x, 12.5];
      for (let i = 0; i < 400 && pz < 23.5; i++) [px, pz] = step(px, pz, 0, 1, 0.05, L.space(STREET).blockers, town.bounds, (a, b) => L.walkable(STREET, a, b));
      expect(pz, `bridge at x=${x}`).toBeGreaterThanOrEqual(23.5);
    }
    // straight into the canal from the promenade: stopped at the bank
    let [cx, cz] = [0, 13];
    for (let i = 0; i < 200; i++) [cx, cz] = step(cx, cz, 0, 1, 0.05, L.space(STREET).blockers, town.bounds, (a, b) => L.walkable(STREET, a, b));
    expect(cz).toBeLessThan(15.01);
    // out to the foreman on the pier
    const pier = town.decks.find((d) => d.kind === "pier")!;
    const [a, b] = pier.path;
    for (let t = 0; t <= 0.7; t += 0.05) expect(L.walkable(STREET, a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t), `pier ${t}`).toBe(true);
  });

  it("the blockers are the town's oriented rects: inside a turned one is blocked, inside its box but off the rect is not", () => {
    const well = town.blockers.find((b) => b.id === "stone_well:bbox")!;
    expect(well.rotY).not.toBe(0);
    const bl = L.space(STREET).blockers.find((b) => b.obb?.id === well.id)!;
    const only = [bl];
    const bounds = town.bounds;
    expect(blocked(well.centre[0], well.centre[1], only, bounds, 0)).toBe(true);
    // a corner of the box that the turned rect doesn't cover
    const corners: Vec2[] = [
      [bl.min[0] + 0.02, bl.min[1] + 0.02],
      [bl.max[0] - 0.02, bl.min[1] + 0.02],
      [bl.min[0] + 0.02, bl.max[1] - 0.02],
      [bl.max[0] - 0.02, bl.max[1] - 0.02],
    ];
    expect(corners.some(([x, z]) => !blocked(x, z, only, bounds, 0))).toBe(true);
    // every building of a place is blocked by its body, and its door stand is clear
    for (const id of ["noodle_shop", "rented_room", "supermarket", "tea_house", "bus_stop", "fruit_stall"]) {
      const body = town.blockers.find((b) => b.id === `${id}:body`)!;
      expect(body, id).toBeDefined();
      expect(free(body.centre[0], body.centre[1]), `${id} body`).toBe(false);
    }
  });
});
