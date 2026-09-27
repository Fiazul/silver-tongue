// Wayfinding (wayfind.ts): every objective kind resolved to a target in the space the player is in
// (the real course and layout, and a fixture layout for the space chain), the next steps and step
// n/N, A* on small grids, the screen-edge arrow's maths (a point behind the camera too), the
// "lost?" reminder's timing, the objective card's DOM, and the strings in all three languages.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { newGame, type Course, type GameState } from "@silver-tongue/core";
import { UI_LOCALES } from "../locale";
import { LAYOUT, LayoutIndex, STREET, type Interactable, type Trigger, type Vec3 } from "../src/layout";
import { objective, type Objective } from "../src/objective";
import { CHROME_KEYS } from "../src/strings";
import { HudView } from "../src/ui/hud";
import {
  buildPathGrid,
  daySteps,
  edgeArrow,
  findPath,
  LostTimer,
  nextSteps,
  projectDone,
  resolveTarget,
  type PathGrid,
  type WayLayout,
} from "../src/wayfind";
import { fakeDocument, fire, installFakeDom, type FakeElement } from "./fake-dom";
import { assetIndex, course, makeGame } from "./helpers";

const { game } = makeGame(newGame(course));
const { t, s } = game;
const named = (): GameState => ({ ...newGame(course), player: "Mina" });
const done = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, 1]));
const obj = (st: GameState, c: Course = course): Objective => objective(c, st, t, s, true);
/** the course with only these scenes (the rest of the rules as they are) */
const only = (...ids: string[]): Course => ({ ...course, scenes: course.scenes.filter((x) => ids.includes(x.id)) });

describe.skipIf(!assetIndex)("every objective kind → a target in the player's space (the real course and layout)", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const at = (st: GameState, space: string, c: Course = course) => {
    const o = obj(st, c);
    return { o, target: resolveTarget(L, o.goal, space, st.place) };
  };

  it("name: nothing (the name dialog is up)", () => {
    const { o, target } = at(newGame(course), STREET);
    expect(o.kind).toBe("name");
    expect(target).toBeNull();
  });

  it("story, here: the NPC (Wang at the start), walking to their talk stand", () => {
    const { o, target } = at(named(), STREET);
    expect(o).toMatchObject({ kind: "story", scene: "street-hello", goal: { kind: "npc", npc: "wang", place: "street" } });
    expect(target).toMatchObject({ kind: "npc", ref: "wang", final: true });
    expect(target!.walk).toEqual([L.talkStand("wang").pos[0], L.talkStand("wang").pos[2]]);
  });

  it("scene running: nothing (dialogue)", () => {
    const st: GameState = { ...named(), run: { scene: "street-hello", exchange: 0, combo: {}, mode: "pick", options: [], tiles: [], misses: 0, earned: 0, mixups: 0 } };
    const { o, target } = at(st, STREET);
    expect(o.kind).toBe("scene");
    expect(target).toBeNull();
  });

  it("story elsewhere: the door on the way from the street, the NPC once inside", () => {
    const st = { ...named(), scenesDone: done("street-hello", "street-hungry", "street-numbers", "room-hello", "warehouse-intro") };
    const { o, target } = at(st, STREET);
    expect(o.goal).toEqual({ kind: "npc", npc: "cook", place: "noodle_shop" });
    expect(target).toMatchObject({ kind: "door", ref: "noodle_shop", final: false });
    const inside = at({ ...st, place: "noodle_shop" }, "noodle_shop");
    expect(inside.target).toMatchObject({ kind: "npc", ref: "cook", final: true });
  });

  it("a travel-only place's NPC stands in the town: the NPC, not a door", () => {
    const st = { ...named(), scenesDone: done("street-hello", "street-hungry", "street-numbers", "room-hello", "noodle-intro") };
    const { o, target } = at(st, STREET);
    expect(o.goal).toEqual({ kind: "npc", npc: "foreman", place: "warehouse" });
    expect(L.travelOnly("warehouse")).toBe(true);
    expect(target).toMatchObject({ kind: "npc", ref: "foreman" });
  });

  it("go home (out of slots): the home door from the street, the way out from another interior", () => {
    const st = { ...named(), slot: course.world.slotsPerDay };
    expect(at(st, STREET)).toMatchObject({ o: { kind: "go-home", goal: { kind: "bed", place: "room" } }, target: { kind: "door", ref: "room", final: false } });
    expect(at({ ...st, place: "noodle_shop" }, "noodle_shop").target).toMatchObject({ kind: "exit", final: false });
  });

  it("sleep (out of slots, at home): the bed", () => {
    const st = { ...named(), slot: course.world.slotsPerDay, place: "room" };
    const { o, target } = at(st, "room");
    expect(o.kind).toBe("sleep");
    expect(target).toMatchObject({ kind: "bed", ref: "room", final: true });
  });

  it("rest (nothing left today): the bed at home, the door elsewhere", () => {
    const empty = only();
    expect(at(named(), STREET, empty)).toMatchObject({ o: { kind: "rest" }, target: { kind: "door", ref: "room" } });
    expect(at({ ...named(), place: "room" }, "room", empty).target).toMatchObject({ kind: "bed" });
  });

  it("deliver: the parcel's NPC (the doctor at the hospital spot, in the town)", () => {
    const st = { ...named(), errand: { to: "hospital" }, scenesDone: done("delivery-pickup") };
    const { o, target } = at(st, STREET, only("delivery-hospital"));
    expect(o).toMatchObject({ kind: "deliver", goal: { kind: "npc", npc: "doctor", place: "hospital" } });
    expect(target).toMatchObject({ kind: "npc", ref: "doctor" });
  });

  it("mentor: the mentor NPC", () => {
    const st = { ...named(), scenesDone: done("street-hello"), notes: { ready: ["n1"], read: [] } };
    const { o, target } = at(st, STREET, only("street-hello"));
    expect(o).toMatchObject({ kind: "mentor", goal: { kind: "npc", npc: "wang" } });
    expect(target).toMatchObject({ kind: "npc", ref: "wang" });
  });

  it("work (a paid shift) and practice: their NPC", () => {
    const shift = { ...named(), trust: { cook: 1 }, scenesDone: done("noodle-intro", "street-numbers") };
    expect(at(shift, STREET, only("noodle-shift"))).toMatchObject({ o: { kind: "work", goal: { npc: "cook" } }, target: { kind: "door", ref: "noodle_shop" } });
    const practice = { ...named(), scenesDone: done("street-hello") };
    expect(at(practice, STREET, only("street-practice"))).toMatchObject({ o: { kind: "practice" }, target: { kind: "npc", ref: "wang" } });
  });

  it("an inner room (the stairs, off the rented room): the room's door, then the stairs' door, then the neighbour", () => {
    const goal = { kind: "npc" as const, npc: "neighbour", place: "stairs" };
    expect(resolveTarget(L, goal, STREET, "street")).toMatchObject({ kind: "door", ref: "room" });
    expect(resolveTarget(L, goal, "room", "room")).toMatchObject({ kind: "door", ref: "stairs" });
    expect(resolveTarget(L, goal, "stairs", "stairs")).toMatchObject({ kind: "npc", ref: "neighbour" });
    // and back out: from the stairs to the street's noodle shop, the way out first
    expect(resolveTarget(L, { kind: "npc", npc: "cook", place: "noodle_shop" }, "stairs", "stairs")).toMatchObject({ kind: "exit" });
  });

  it("every NPC in the course resolves to something from every space (never lost)", () => {
    for (const npc of Object.keys(course.world.npcs))
      for (const space of L.spaceIds()) {
        const goal = { kind: "npc" as const, npc, place: course.world.npcs[npc].place };
        expect(resolveTarget(L, goal, space, L.defaultPlaceOf(space)), `${npc} from ${space}`).not.toBeNull();
      }
  });
});

describe("the resolver's space chain (fixture layout)", () => {
  const trig = (kind: Trigger["kind"], place: string, x: number): Trigger => ({ kind, place, box: { min: [x - 1, -1], max: [x + 1, 1] }, at: [x, 2.2, 0] });
  const spaces: Record<string, { triggers: Trigger[]; interactables: Interactable[] }> = {
    town: { triggers: [trig("door", "house", 10), trig("stay", "dock", 20), trig("zone", "park", 30)], interactables: [] },
    house: { triggers: [trig("exit", "street", 0), trig("door", "attic", 5)], interactables: [{ kind: "sleep", pos: [1, 0.5, 1], range: 1 }] },
    attic: { triggers: [trig("exit", "house", 0)], interactables: [] },
  };
  const placeSpace: Record<string, string> = { house: "house", attic: "attic" };
  const outer: Record<string, string | null> = { town: null, house: "town", attic: "house" };
  const L: WayLayout = {
    spaceOf: (p) => placeSpace[p] ?? "town",
    outerSpace: (s) => outer[s] ?? null,
    npcSpace: () => "attic",
    npcStand: () => ({ pos: [3, 0, 3] as Vec3 }),
    talkStand: () => ({ pos: [3, 0, 4] as Vec3 }),
    space: (id) => spaces[id],
    heightAt: () => 0,
  };

  it("doors down the chain, the way out up it, spots and zones in place, nothing once there", () => {
    const bed = (place: string) => ({ kind: "bed" as const, place });
    expect(resolveTarget(L, bed("attic"), "town", "street")).toMatchObject({ kind: "door", ref: "house", at: [10, 0, 0] });
    expect(resolveTarget(L, bed("attic"), "house", "house")).toMatchObject({ kind: "door", ref: "attic" });
    expect(resolveTarget(L, bed("dock"), "attic", "attic")).toMatchObject({ kind: "exit", ref: "house" });
    expect(resolveTarget(L, bed("dock"), "town", "street")).toMatchObject({ kind: "spot", ref: "dock", final: true });
    expect(resolveTarget(L, bed("park"), "town", "street")).toMatchObject({ kind: "spot", ref: "park" });
    expect(resolveTarget(L, bed("park"), "town", "park")).toBeNull();
    expect(resolveTarget(L, bed("house"), "house", "house")).toMatchObject({ kind: "bed", at: [1, 0, 1] });
    expect(resolveTarget(L, { kind: "npc", npc: "ghost", place: "attic" }, "attic", "attic")).toMatchObject({ kind: "npc", walk: [3, 4] });
    expect(resolveTarget(L, undefined, "town", "street")).toBeNull();
  });
});

describe("the sequence: the next steps and step n/N today", () => {
  it("a new game: Wang's scenes one after another, step 1 of slots + 1", () => {
    const st = named();
    const steps = nextSteps(course, st, t, s, true);
    expect(steps).toHaveLength(3);
    expect(steps.map((x) => x.scene)).toEqual(["street-hello", "street-hungry", "street-numbers"]);
    expect(daySteps(course, st)).toEqual({ n: 1, total: course.world.slotsPerDay + 1 });
  });

  it("the last slot: this scene, then the evening; nothing projected past sleep", () => {
    const st = { ...named(), slot: course.world.slotsPerDay - 1 };
    const steps = nextSteps(course, st, t, s, true);
    expect(steps.map((x) => x.kind)).toEqual(["story", "go-home"]);
    expect(daySteps(course, st).n).toBe(course.world.slotsPerDay);
    expect(daySteps(course, { ...st, slot: course.world.slotsPerDay }).n).toBe(course.world.slotsPerDay + 1);
  });

  it("before the name: the name, then the first scene; a running scene is the step its slot started", () => {
    expect(nextSteps(course, newGame(course), t, s, true).map((x) => x.kind).slice(0, 2)).toEqual(["name", "story"]);
    const run: GameState = { ...named(), slot: 1, run: { scene: "street-hello", exchange: 0, combo: {}, mode: "pick", options: [], tiles: [], misses: 0, earned: 0, mixups: 0 } };
    expect(daySteps(course, run).n).toBe(1);
    const after = projectDone(course, run, obj(run))!;
    expect(after).toMatchObject({ run: null, slot: 1, scenesDone: { "street-hello": 1 } });
  });

  it("projecting leaves the real state alone", () => {
    const st = named();
    const before = JSON.stringify(st);
    nextSteps(course, st, t, s, true);
    expect(JSON.stringify(st)).toBe(before);
  });
});

describe("A* on the walk grid", () => {
  /** rows of cost digits: 0 blocked, else the cost ("1" path, "3" grass), 1 m cells from (0, 0) */
  const grid = (rows: string[]): PathGrid => {
    const cost = new Float32Array(rows.length * rows[0].length);
    rows.forEach((r, j) => [...r].forEach((c, i) => (cost[j * r.length + i] = Number(c))));
    return { x0: 0, z0: 0, cell: 1, cols: rows[0].length, rows: rows.length, cost };
  };
  const len = (p: [number, number][]) => p.slice(1).reduce((d, q, k) => d + Math.hypot(q[0] - p[k][0], q[1] - p[k][1]), 0);

  it("finds a path, from the exact start to the exact goal", () => {
    const g = grid(["11111", "11111", "11111"]);
    const p = findPath(g, [0.5, 0.5], [4.5, 2.5])!;
    expect(p[0]).toEqual([0.5, 0.5]);
    expect(p.at(-1)).toEqual([4.5, 2.5]);
    expect(len(p)).toBeCloseTo(2 * Math.SQRT2 + 2, 5);
  });

  it("goes round a wall, never through it, and never cuts its corner", () => {
    const g = grid(["11111", "10001", "10101", "11101"]);
    const p = findPath(g, [2.5, 2.5], [4.5, 3.5])!;
    expect(p).not.toBeNull();
    // every step between open cells, and a diagonal only when both sides are open
    const cell = (q: [number, number]) => [Math.floor(q[0]), Math.floor(q[1])];
    const dense: [number, number][] = [];
    for (let k = 1; k < p.length; k++) {
      const n = Math.ceil(Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]) * 4);
      for (let u = 0; u <= n; u++) dense.push([p[k - 1][0] + ((p[k][0] - p[k - 1][0]) * u) / n, p[k - 1][1] + ((p[k][1] - p[k - 1][1]) * u) / n]);
    }
    for (const q of dense) {
      const [i, j] = cell(q);
      expect(g.cost[j * g.cols + i], `through (${i}, ${j})`).toBeGreaterThan(0);
    }
  });

  it("prefers the path over grass when the path costs less", () => {
    // straight across the grass (cost 3) is 4 m; round by the path (cost 1) is 8 m: cheaper
    const g = grid(["11111", "13331", "13331"]);
    const p = findPath(g, [0.5, 2.5], [4.5, 2.5])!;
    expect(Math.min(...p.map((q) => q[1]))).toBeLessThan(1);
  });

  it("no way through: null; a blocked goal snaps to the nearest open cell", () => {
    expect(findPath(grid(["11011", "11011", "11011"]), [0.5, 0.5], [4.5, 0.5])).toBeNull();
    const p = findPath(grid(["11110", "11110"]), [0.5, 0.5], [4.5, 0.5])!;
    expect(p.at(-1)).toEqual([3.5, 0.5]);
  });

  it("buildPathGrid: cost from the ground, zero where blocked", () => {
    const g = buildPathGrid({ min: [0, 0], max: [3, 2] }, 1, (x) => (x < 1 ? 0 : 2), (x, z) => x > 2 && z > 1);
    expect([...g.cost]).toEqual([0, 2, 2, 0, 2, 0]);
  });
});

describe("the screen-edge arrow", () => {
  const view = { w: 800, h: 600 };
  const cam = new THREE.PerspectiveCamera(30, view.w / view.h, 0.5, 2500);
  cam.position.set(0, 10, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const clipOf = (x: number, y: number, z: number) => {
    const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    return { x: v.x, y: v.y, w: v.w };
  };

  it("on screen: the point's pixel, no arrow", () => {
    const a = edgeArrow(clipOf(0, 0, 0), view, 40);
    expect(a.onScreen).toBe(true);
    expect(a.x).toBeCloseTo(400, 3);
    expect(a.y).toBeCloseTo(300, 3);
  });

  it("off to the right: on the right edge, pointing right", () => {
    const a = edgeArrow(clipOf(60, 0, 0), view, 40);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeCloseTo(760, 3);
    expect(Math.abs(a.angle)).toBeLessThan(0.3);
  });

  it("behind the camera and to the left: the left edge (not the mirrored right)", () => {
    const c = clipOf(-40, 0, 30);
    expect(c.w).toBeLessThan(0);
    const a = edgeArrow(c, view, 40);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeCloseTo(40, 3);
    expect(Math.abs(Math.abs(a.angle) - Math.PI)).toBeLessThan(0.6);
  });

  it("behind the camera, straight back: the bottom edge (towards the viewer), pointing down", () => {
    const c = clipOf(0, 0, 40);
    expect(c.w).toBeLessThan(0);
    const a = edgeArrow(c, view, 40);
    expect(a.y).toBeCloseTo(560, 3);
    expect(a.x).toBeCloseTo(400, 3);
    expect(a.angle).toBeCloseTo(Math.PI / 2, 3);
  });

  it("per-side insets (keeping out of the HUD): clamped inside them", () => {
    const a = edgeArrow(clipOf(0, 0, -400), view, { top: 120, right: 40, bottom: 40, left: 40 });
    expect(a.onScreen).toBe(false);
    expect(a.y).toBeCloseTo(120, 3);
  });
});

describe("never lost: the reminder", () => {
  it("after 20 s over 40 m away with nothing on, then at most once a minute; dialogue or coming close resets it", () => {
    const lost = new LostTimer();
    const run = (secs: number, dist: number | null, busy = false) => {
      let fired = 0;
      for (let k = 0; k < secs * 10; k++) if (lost.update(0.1, dist, busy)) fired++;
      return fired;
    };
    expect(run(19, 50)).toBe(0);
    expect(run(2, 50)).toBe(1);
    expect(run(30, 50)).toBe(0); // rate limit
    expect(run(31, 50)).toBe(1);
    expect(run(30, 10)).toBe(0); // close by
    expect(run(80, 50, true)).toBe(0); // in a scene
    expect(run(19, 50)).toBe(0); // the 20 s start again after a reset
    expect(run(2, 50)).toBe(1);
  });
});

describe("the objective card", () => {
  it("step n/N, the objective, the next step greyed, Take me there", () => {
    installFakeDom();
    let taken = 0;
    const hud = new HudView(s, t, () => {}, () => taken++);
    fakeDocument.body.append(hud.node as unknown as FakeElement);
    const o = obj(named());
    hud.render(game.model.hud, o, null, { step: { n: 2, total: 5 }, next: "Buy rice", take: true });
    const node = hud.node as unknown as FakeElement;
    expect(node.querySelector(".obj-step")!.textContent).toBe("Step 2/5");
    expect(node.querySelector(".obj-text")!.textContent).toContain(o.text);
    expect(node.querySelector(".obj-next")!.textContent).toBe("Next: Buy rice");
    fire(node.querySelector(".obj-go")!, "click");
    expect(taken).toBe(1);
    hud.render(game.model.hud, o, null, { step: { n: 2, total: 5 }, take: false });
    expect(node.querySelector(".obj-go")).toBeNull();
    expect(node.querySelector(".obj-next")).toBeNull();
  });
});

describe("wayfinding's strings", () => {
  it("bn and zh have every way- and path- key", () => {
    const keys = CHROME_KEYS.filter((k) => k.startsWith("way-") || k.startsWith("path-"));
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const lang of ["bn", "zh"]) for (const k of keys) expect(UI_LOCALES[lang].game, `${lang} ${k}`).toHaveProperty([k]);
  });
});

describe("draw calls", () => {
  it("the marker (arrow + ring, body + hull) and the path (every dot) add 3 draw calls in all", async () => {
    const { GuideMarker } = await import("../src/marker");
    const { PathTrail } = await import("../src/wayview");
    const { drawCalls } = await import("../src/world");
    const marker = new GuideMarker();
    const trail = new PathTrail();
    marker.update(0.016, new THREE.Vector3(1, 0, 1));
    trail.set([[0, 0], [30, 0], [30, 30]], () => 0);
    expect(trail.mesh.geometry.drawRange.count / 6).toBeGreaterThan(40);
    expect(drawCalls(marker.root) + drawCalls(trail.mesh)).toBe(3);
    trail.set(null, () => 0);
    marker.update(0.016, null);
    expect(drawCalls(marker.root) + drawCalls(trail.mesh)).toBe(0);
  });
});
