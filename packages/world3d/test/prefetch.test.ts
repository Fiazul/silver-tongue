// The prefetcher (src/prefetch.ts, README "Prefetch"): which spaces it builds ahead and in what
// order, that it works only while the player is busy (paused, then resumed where it stopped), the
// cap on spaces built ahead (the least recently wanted dropped), a door rushing a build in flight,
// the `?prefetch=0` switch; and that a build on the gate (world.ts SceneSpace.create's `gate`) is the
// same space as one built at once, and that dropping it disposes its own GPU resources only.
// The slice's time budget with a fake clock is in perf.test.ts.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { frameSlack, PREFETCH_MAX, prefetchEnabled, PrefetchScheduler, rankCandidates, reachableFrom, TimeSlicer, type PrefetchHost } from "../src/prefetch";
import { AssetCache, drawCalls, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, readGlb } from "./helpers";

/** lets every pending promise continuation run */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** A host whose build of a space is `steps` steps of `stepMs` each on a fake clock. */
function fakeHost(opts: { steps?: number; stepMs?: number; fail?: string[] } = {}) {
  const clock = { t: 0 };
  const built = new Set<string>();
  const log: string[] = [];
  const progress = new Map<string, number>();
  let wanted: string[] = [];
  const host: PrefetchHost = {
    candidates: () => wanted,
    built: (s) => built.has(s),
    async build(space, gate) {
      log.push(`start ${space}`);
      for (let i = 0; i < (opts.steps ?? 10); i++) {
        clock.t += opts.stepMs ?? 1;
        progress.set(space, (progress.get(space) ?? 0) + 1);
        await gate.step();
      }
      if (opts.fail?.includes(space)) throw new Error(`${space}: failed`);
      built.add(space);
      log.push(`built ${space}`);
    },
    evict(space) {
      built.delete(space);
      log.push(`evict ${space}`);
    },
  };
  return { host, clock, built, log, progress, want: (w: string[]) => void (wanted = w) };
}

/** `n` frames: each a slice (the scheduler's frame()), then the slice's steps run */
async function frames(p: PrefetchScheduler, n: number, slack = true) {
  for (let i = 0; i < n; i++) {
    p.frame(slack);
    await flush();
  }
}

describe("which spaces, in what order", () => {
  it("rankCandidates: the guide's space first, then the reachable ones in their order; never the current one, each once", () => {
    expect(rankCandidates("street", "tea_house", ["noodle_shop", "tea_house", "shop"])).toEqual(["tea_house", "noodle_shop", "shop"]);
    expect(rankCandidates("street", null, ["noodle_shop", "shop"])).toEqual(["noodle_shop", "shop"]);
    expect(rankCandidates("street", "street", ["street", "shop"])).toEqual(["shop"]);
  });

  it("reachableFrom: the spaces the doors and ways out lead to, nearest first, each once, never here", () => {
    const spaceOf = (p: string) => ({ a_door: "a", a_back: "a", b_door: "b", market: "street" })[p] ?? "street";
    const triggers = [
      { place: "market", at: [0, 0, 0] }, // a zone of the street itself
      { place: "b_door", at: [10, 2, 0] },
      { place: "a_door", at: [30, 2, 0] },
      { place: "a_back", at: [5, 2, 0] }, // a's other door is the nearer one
    ];
    expect(reachableFrom(triggers, spaceOf, "street", 0, 0)).toEqual(["a", "b"]);
    expect(reachableFrom(triggers, spaceOf, "street", 28, 0)).toEqual(["a", "b"]);
    expect(reachableFrom(triggers, spaceOf, "street", 12, 0)).toEqual(["b", "a"]);
  });

  it("from the town's layout: every interior's door is reachable from the street, and the street from each interior", () => {
    const L = new LayoutIndex(LAYOUT, assetIndex!);
    const spaceOf = (p: string) => L.spaceOf(p);
    const fromStreet = reachableFrom(L.space(STREET).triggers, spaceOf, STREET, 0, 0);
    for (const id of L.spaceIds().filter((s) => s !== STREET && L.outerSpace(s) === STREET)) expect(fromStreet).toContain(id);
    for (const id of L.spaceIds().filter((s) => s !== STREET)) expect(reachableFrom(L.space(id).triggers, spaceOf, id, 0, 0)).toContain(L.outerSpace(id));
  });

  it("builds the wanted spaces one at a time, most wanted first, only the first PREFETCH_MAX", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a", "b", "c"]);
    p.setBusy(true);
    await frames(p, 20);
    expect(PREFETCH_MAX).toBe(2);
    expect(f.log).toEqual(["start a", "built a", "start b", "built b"]);
    expect([...p.prebuilt].sort()).toEqual(["a", "b"]);
    expect(p.prebuilt.at(-1)).toBe("a"); // the most wanted is the most recently used
    expect(p.state).toBe("idle");
    // one space at a time: b started only once a was built
    expect(f.log.indexOf("start b")).toBeGreaterThan(f.log.indexOf("built a"));
  });

  it("a space already built (entered, or built at a door) is skipped", async () => {
    const f = fakeHost();
    f.built.add("a");
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a", "b"]);
    p.setBusy(true);
    await frames(p, 20);
    expect(f.log).toEqual(["start b", "built b"]);
  });

  it("a build that fails isn't tried again by the prefetcher (the door builds it itself); the next wanted one goes on", async () => {
    const f = fakeHost({ fail: ["a"] });
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a", "b"]);
    p.setBusy(true);
    await frames(p, 30);
    expect(f.log).toEqual(["start a", "start b", "built b"]);
    expect(p.stats.failed).toEqual(["a"]);
  });
});

describe("only while the player is busy: paused, resumed where it stopped", () => {
  it("nothing starts while the player isn't busy, or the frame has no slack", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a"]);
    await frames(p, 10);
    expect(f.log).toEqual([]);
    p.setBusy(true);
    await frames(p, 10, false);
    expect(f.log).toEqual([]);
    expect(p.state).toBe("idle");
  });

  it("stops at its next step when the player stops being busy, and goes on from there (not over) when they are again", async () => {
    // 3 ms steps: one a slice (the second would pass 4 ms)
    const f = fakeHost({ steps: 10, stepMs: 3 });
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a"]);
    p.setBusy(true);
    await frames(p, 4);
    const at = f.progress.get("a")!;
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(10);
    expect(p.state).toBe("working");
    p.setBusy(false);
    expect(p.state).toBe("paused");
    await frames(p, 10);
    expect(f.progress.get("a")).toBe(at);
    p.setBusy(true);
    await frames(p, 20);
    expect(f.progress.get("a")).toBe(10); // resumed: 10 steps in all, the build not started over
    expect(f.log).toEqual(["start a", "built a"]);
  });

  it("a door rushes the build in flight: it finishes with no frames, and the space is the player's (not built ahead)", async () => {
    const f = fakeHost({ steps: 10, stepMs: 3 });
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a", "b"]);
    p.setBusy(true);
    await frames(p, 2);
    p.setBusy(false);
    p.entered("a");
    await flush(100);
    expect(f.built.has("a")).toBe(true);
    expect(p.prebuilt).toEqual([]);
    expect(p.state).toBe("idle");
  });

  it("entered: a space built ahead leaves the cap (the player's now, never evicted)", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    f.want(["a", "b"]);
    p.setBusy(true);
    await frames(p, 30);
    expect([...p.prebuilt].sort()).toEqual(["a", "b"]);
    p.entered("a");
    expect(p.prebuilt).toEqual(["b"]);
  });
});

describe("at most PREFETCH_MAX built ahead: the least recently wanted dropped", () => {
  it("a newly wanted space evicts the built-ahead one no longer wanted, never one still wanted", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    p.setBusy(true);
    f.want(["a", "b"]);
    await frames(p, 30);
    expect([...p.prebuilt].sort()).toEqual(["a", "b"]);
    f.want(["c", "b"]); // walked on: c's door is near, a's isn't wanted any more
    await frames(p, 30);
    expect(f.log.slice(4)).toEqual(["evict a", "start c", "built c"]);
    expect(p.prebuilt.sort()).toEqual(["b", "c"]);
    expect(f.built.has("a")).toBe(false);
  });

  it("least recently wanted: of two built ahead and not wanted now, the one wanted longer ago goes", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: true, now: () => f.clock.t });
    p.setBusy(true);
    f.want(["a", "b"]);
    await frames(p, 30);
    f.want(["b", "a"]); // both still wanted: b the most recent
    await frames(p, 2);
    f.want(["c", "a"]); // a wanted again (touched), b not: b goes
    await frames(p, 30);
    expect(f.log.filter((l) => l.startsWith("evict"))).toEqual(["evict b"]);
    expect(p.stats.evicted).toBe(1);
    f.want(["d", "e"]); // neither built-ahead one wanted: a (last wanted before c was built) goes first, then c
    await frames(p, 60);
    expect(f.log.filter((l) => l.startsWith("evict"))).toEqual(["evict b", "evict a", "evict c"]);
    expect([...p.prebuilt].sort()).toEqual(["d", "e"]);
  });
});

describe("?prefetch=0", () => {
  it("prefetchEnabled: on unless prefetch=0", () => {
    expect(prefetchEnabled("")).toBe(true);
    expect(prefetchEnabled("?look=full&prefetch=1")).toBe(true);
    expect(prefetchEnabled("?prefetch=0")).toBe(false);
    expect(prefetchEnabled("?look=lite&prefetch=0&perf=1")).toBe(false);
  });

  it("disabled: nothing is ever built, the state says off", async () => {
    const f = fakeHost();
    const p = new PrefetchScheduler(f.host, { enabled: false, now: () => f.clock.t });
    f.want(["a"]);
    p.setBusy(true);
    await frames(p, 20);
    expect(f.log).toEqual([]);
    expect(p.state).toBe("off");
  });
});

describe("frame slack", () => {
  it("a frame already late (over twice its budget) gets no slice; one on time does", () => {
    expect(frameSlack(16.7, 1000 / 60)).toBe(true);
    expect(frameSlack(30, 1000 / 60)).toBe(true);
    expect(frameSlack(40, 1000 / 60)).toBe(false);
    expect(frameSlack(40, 1000 / 30)).toBe(true);
  });
});

describe("a build on the gate (SceneSpace.create's gate)", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  it("is the same space as one built at once, and dropping it disposes only its own resources", async () => {
    const assets = new AssetCache(ASSETS, L, { read: readGlb });
    const plain = await SceneSpace.create(L, assets, "noodle_shop");
    // a gate driven slice by slice on a fake clock (every step 1 ms)
    const clock = { t: 0 };
    const gate = new TimeSlicer(() => clock.t);
    const gated = SceneSpace.create(L, assets, "noodle_shop", {
      gate: {
        step: () => {
          clock.t += 1;
          return gate.step();
        },
        wait: (p) => gate.wait(p),
      },
    });
    let done = false;
    void gated.then(() => (done = true));
    for (let i = 0; i < 5000 && !done; i++) {
      gate.beginSlice();
      await new Promise((r) => setTimeout(r, 0));
    }
    const g = await gated;
    expect(gate.steps).toBeGreaterThan(10);
    expect(g.batching).toEqual(plain.batching);
    expect(drawCalls(g.scene)).toBe(drawCalls(plain.scene));
    expect([...g.npcs.keys()].sort()).toEqual([...plain.npcs.keys()].sort());
    expect(g.blockers.length).toBe(plain.blockers.length);

    // dispose: its own geometry (the merged batches, the copies) goes, the templates' and the other space's stay
    const disposed = new Set<object>();
    const watch = (root: THREE.Object3D) =>
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.addEventListener("dispose", () => disposed.add(m.geometry));
        for (const mat of m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []) mat.addEventListener("dispose", () => disposed.add(mat));
      });
    const own = new Set<object>();
    g.scene.traverse((o) => (o as THREE.Mesh).geometry && own.add((o as THREE.Mesh).geometry));
    watch(g.scene);
    const keep = [plain.scene, ...assets.templateRoots()];
    const kept = new Set<object>();
    for (const r of keep)
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) kept.add(m.geometry);
        for (const mat of m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []) kept.add(mat);
      });
    g.dispose(keep);
    expect(disposed.size).toBeGreaterThan(0);
    for (const x of disposed) expect(kept.has(x)).toBe(false);
    for (const x of own) if (!kept.has(x)) expect(disposed.has(x)).toBe(true);
    expect(g.scene.children).toHaveLength(0);
    expect(plain.scene.children.length).toBeGreaterThan(0);
  });
});
