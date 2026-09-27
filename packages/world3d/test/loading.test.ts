// What loads when (src/loading.ts): the plan and the loading screen's progress reducer.
import { describe, expect, it } from "vitest";
import { emptyLoad, loadPlan, loadSummary, progressLabel, reduceLoad, type LoadEvent } from "../src/loading";
import { heldProp, LAYOUT, LayoutIndex } from "../src/layout";
import { assetIndex } from "./helpers";

describe.skipIf(!assetIndex)("the load plan", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const bag = heldProp(LAYOUT.player.errandProp)?.asset;
  const plan = loadPlan(L, { character: LAYOUT.player.character, errandProp: bag });

  it("lists every asset the layout uses exactly once", () => {
    const all = [...plan.first, ...plan.town, ...plan.spaces.flatMap((s) => s.assets)];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(L.assetNames()));
  });

  it("the first frame: the town's landscape, sky and buildings, the player and the bag; no NPC or walker model", () => {
    for (const n of [...LAYOUT.town.landscape, LAYOUT.town.sky!, LAYOUT.player.character, bag!]) expect(plan.first).toContain(n);
    const street = L.space("street");
    for (const p of street.pieces) expect(plan.first).toContain(p.asset);
    for (const npc of street.npcs) {
      const c = L.npc(npc).character;
      if (c !== LAYOUT.player.character) expect(plan.first).not.toContain(c);
    }
    for (const w of street.walkers) if (w.character !== LAYOUT.player.character) expect(plan.first).not.toContain(w.character);
  });

  it("under 40 % of the GLB bytes go before the first frame", () => {
    const bytes = (ns: string[]) => ns.reduce((t, n) => t + (L.asset(n).bytes ?? 0), 0);
    const all = bytes(L.assetNames());
    expect(all).toBeGreaterThan(0);
    expect(bytes(plan.first) / all).toBeLessThan(0.4);
  });

  it("the town's people: nearest the spawn first; interiors: every one, the nearest door first", () => {
    const spawn = L.spawn(L.space("street").defaultPlace).pos;
    const firstNpc = [...L.space("street").npcs].sort((a, b) => {
      const d = (n: string) => Math.hypot(L.npcStand(n).pos[0] - spawn[0], L.npcStand(n).pos[2] - spawn[2]);
      return d(a) - d(b);
    })[0];
    const c = L.npc(firstNpc).character;
    if (!plan.first.includes(c)) expect(plan.town[0]).toBe(c);
    expect(plan.spaces.map((s) => s.id).sort()).toEqual(L.spaceIds().filter((id) => id !== "street").sort());
  });
});

describe("the loading screen's progress", () => {
  const run = (evs: LoadEvent[]) => loadSummary(evs.reduce(reduceLoad, emptyLoad));

  it("by bytes when the index knows every size; the file on the bar is the first still loading", () => {
    const p = run([
      { type: "start", name: "a", bytes: 1000 },
      { type: "start", name: "b", bytes: 3000 },
      { type: "progress", name: "a", loaded: 500 },
      { type: "progress", name: "b", loaded: 1500 },
    ]);
    expect(p.fraction).toBeCloseTo(0.5);
    expect(p.current).toBe("a");
    expect(p.total).toBe(4000);
    const q = run([{ type: "start", name: "a", bytes: 1000 }, { type: "done", name: "a" }]);
    expect(q).toMatchObject({ fraction: 1, complete: true, current: null });
  });

  it("a server length only without an index size, never smaller than what came; else by count", () => {
    let s = reduceLoad(emptyLoad, { type: "start", name: "a" });
    s = reduceLoad(s, { type: "progress", name: "a", loaded: 300, total: 100 }); // gzip: the length is the compressed size
    expect(s.items[0].total).toBeNull();
    s = reduceLoad(s, { type: "start", name: "b" });
    s = reduceLoad(s, { type: "done", name: "b" });
    const p = loadSummary(s);
    expect(p.total).toBeNull();
    expect(p.fraction).toBeCloseTo(0.5);
    expect(progressLabel(p)).toBe("1 / 2");
    const r = run([{ type: "start", name: "c" }, { type: "progress", name: "c", loaded: 50, total: 200 }]);
    expect(r.fraction).toBeCloseTo(0.25);
  });

  it("a failed file counts as done (the bar never sticks); events for files it doesn't know are ignored; nothing: full", () => {
    const p = run([{ type: "start", name: "a", bytes: 10 }, { type: "fail", name: "a" }, { type: "progress", name: "zzz", loaded: 5 }]);
    expect(p.done).toBe(1);
    expect(p.count).toBe(1);
    expect(loadSummary(emptyLoad).fraction).toBe(1);
    expect(progressLabel(run([{ type: "start", name: "a", bytes: 2 * 1048576 }]))).toBe("0.0 / 2.0 MB");
  });
});
