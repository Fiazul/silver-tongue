// The performance pass (README "Performance"): each tier's render budget and its URL overrides,
// the render scale's resolution (lite's pixels against full's), dynamic resolution's hysteresis,
// frame pacing and dt at 60 and 30, the shadow map's redraw triggers, the grass LOD bands and their
// chunk culling, the long-frame causes the ?perf=1 probe gives, and that no synchronous GPU
// read-back is left in the frame loop's code; the prefetcher's time slices (prefetch.ts TimeSlicer)
// keep their main-thread work per frame within PREFETCH_SLICE_MS, on a fake clock.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GRASS, grassBands, grassChunkVisible, LITE_FAR_FADE, wrapIntervals } from "../src/envlook";
import { BUDGETS, budgetFor, DynamicScale, FramePacer, lookFor, renderPixelRatio, resolveLook, SHADOW_CELL } from "../src/look";
import { ShadowScheduler } from "../src/shadows";
import { longFrameCause } from "../src/perf";
import { PREFETCH_SLICE_MS, TimeSlicer } from "../src/prefetch";
import { loadPrefs, PREFS_KEY, savePrefs } from "../src/prefs";

describe("render budget and render scale", () => {
  it("full: DPR cap 2, scale 1, half-res AO, FXAA, 2048 shadow; lite: DPR cap 1.5 x 0.75, dynamic, no AO, 1024 shadow; both 60 fps", () => {
    expect(budgetFor("full")).toMatchObject({ dprCap: 2, renderScale: 1, dynamic: false, ao: "half", msaa: 0, fxaa: true, shadowSize: 2048, shadowEvery: 2, fps: 60 });
    expect(budgetFor("lite")).toMatchObject({ dprCap: 1.5, renderScale: 0.75, dynamic: true, ao: "off", shadowSize: 1024, shadowEvery: 3, fps: 60 });
    expect(lookFor("lite", "auto", "").budget).toEqual(BUDGETS.lite);
    expect(resolveLook("?look=full", undefined, { coarse: false }).budget).toEqual(BUDGETS.full);
  });

  it("the URL overrides each knob (scale fixes the scale: no dynamic), junk is ignored; the saved frame rate applies, the URL's wins", () => {
    expect(budgetFor("lite", "?scale=0.5")).toMatchObject({ renderScale: 0.5, dynamic: false, minScale: 0.5 });
    expect(budgetFor("full", "?ao=off&msaa=4&fxaa=0&shadow=1024&shadowEvery=1&dpr=1&dynres=1")).toMatchObject({ ao: "off", msaa: 4, fxaa: false, shadowSize: 1024, shadowEvery: 1, dprCap: 1, dynamic: true });
    expect(budgetFor("full", "?scale=9&ao=ultra&msaa=-1&fps=abc")).toEqual(BUDGETS.full);
    expect(budgetFor("full", "?fps=0").fps).toBe(0);
    expect(budgetFor("full", "?fps=5").fps).toBe(10);
    expect(budgetFor("lite", "", 30).fps).toBe(30);
    expect(budgetFor("lite", "", 45).fps).toBe(60); // not a Settings choice
    expect(budgetFor("lite", "?fps=60", 30).fps).toBe(60);
    expect(resolveLook("", "lite", { coarse: true }, 30).budget.fps).toBe(30);
  });

  it("renderPixelRatio: lite on a 1080x2400 DPR 2.6 phone draws under half the pixels full draws at 1920x1080 DPR 1", () => {
    const full = renderPixelRatio(BUDGETS.full, 1, BUDGETS.full.renderScale);
    expect(full).toBe(1);
    const lite = renderPixelRatio(BUDGETS.lite, 2.6, BUDGETS.lite.renderScale);
    expect(lite).toBeCloseTo(1.125);
    const css = { w: 1080 / 2.6, h: 2400 / 2.6 };
    const litePx = Math.floor(css.w * lite) * Math.floor(css.h * lite);
    expect(litePx / (1920 * 1080)).toBeLessThanOrEqual(0.5);
    expect(litePx / (1080 * 2400)).toBeLessThan(0.2);
    // full on the same phone: capped at DPR 2
    expect(renderPixelRatio(BUDGETS.full, 2.6, 1)).toBe(2);
    // no DPR reported: 1
    expect(renderPixelRatio(BUDGETS.lite, 0, 0.75)).toBeCloseTo(0.75);
  });
});

describe("dynamic resolution (DynamicScale)", () => {
  const windowOf = (d: DynamicScale, ms: number) => {
    let changed = false;
    for (let i = 0; i < d.window; i++) changed = d.frame(ms) || changed;
    return changed;
  };

  it("p95 over 20 ms (at 60) for two windows: 10 % less; under 12 ms for three: 10 % more; never past its bounds", () => {
    const d = new DynamicScale(0.75, 0.5, 1000 / 60, 60, 0);
    expect(d.high).toBeCloseTo(20);
    expect(d.low).toBeCloseTo(12);
    expect(windowOf(d, 25)).toBe(false); // one hot window is not enough
    expect(windowOf(d, 25)).toBe(true);
    expect(d.scale).toBeCloseTo(0.675);
    for (let i = 0; i < 20; i++) windowOf(d, 40);
    expect(d.scale).toBe(0.5);
    expect(windowOf(d, 8)).toBe(false);
    expect(windowOf(d, 8)).toBe(false);
    expect(windowOf(d, 8)).toBe(true); // three calm windows
    expect(d.scale).toBeCloseTo(0.556, 3);
    for (let i = 0; i < 40; i++) windowOf(d, 8);
    expect(d.scale).toBe(0.75);
  });

  it("hysteresis: between the thresholds nothing moves; a window in between resets the count; after a change the cooldown windows are ignored", () => {
    const d = new DynamicScale(1, 0.5, 1000 / 60, 60, 2);
    for (let i = 0; i < 10; i++) expect(windowOf(d, 15)).toBe(false);
    windowOf(d, 25);
    windowOf(d, 15); // reset
    expect(windowOf(d, 25)).toBe(false);
    expect(windowOf(d, 25)).toBe(true);
    expect(windowOf(d, 40)).toBe(false); // cooldown
    expect(windowOf(d, 40)).toBe(false); // cooldown
    expect(windowOf(d, 40)).toBe(false); // hot 1
    expect(windowOf(d, 40)).toBe(true);
    expect(d.changes).toBe(2);
    // the p95 judges: a few slow frames in a fast window don't count
    const e = new DynamicScale(1, 0.5, 1000 / 60, 60, 0);
    for (let w = 0; w < 4; w++) for (let i = 0; i < 60; i++) e.frame(i < 2 ? 80 : 10);
    expect(e.scale).toBe(1);
    // at 30 fps pacing: the budget doubles
    const f = new DynamicScale(1, 0.5, 1000 / 30, 60, 0);
    windowOf(f, 30);
    windowOf(f, 30);
    expect(f.scale).toBe(1);
  });
});

describe("frame pacing (FramePacer) and dt", () => {
  /** a display at `hz` for `seconds`: the callbacks that draw and the dt each drawn frame gets (as main.ts: clock at each drawn frame, capped at 0.05) */
  const run = (hz: number, fps: number, seconds = 10, jitter = 0) => {
    const p = new FramePacer(fps);
    let last: number | null = null;
    const dts: number[] = [];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < hz * seconds; i++) {
      const now = (i * 1000) / hz + rnd() * jitter;
      if (!p.tick(now)) continue;
      if (last !== null) dts.push(Math.min(0.05, (now - last) / 1000));
      last = now;
    }
    return { drawn: dts.length + 1, dts, gameTime: dts.reduce((a, b) => a + b, 0) };
  };

  it("60 Hz display: 60 draws every callback; 30 every other one, dt 1/30, the game at the same speed", () => {
    const a = run(60, 60);
    expect(a.drawn).toBe(600);
    const b = run(60, 30);
    expect(b.drawn).toBe(300); // half the frames: half the GPU work
    for (const dt of b.dts) expect(dt).toBeCloseTo(1 / 30, 5);
    expect(b.gameTime).toBeCloseTo(a.gameTime, 1); // dt-correct: the same game time either way
  });

  it("a 144 Hz or 120 Hz display is capped at 60; jitter never lets it drift above; 0 is uncapped", () => {
    for (const hz of [120, 144]) {
      const r = run(hz, 60, 10, 1.5);
      expect(r.drawn).toBeLessThanOrEqual(605);
      expect(r.drawn).toBeGreaterThanOrEqual(hz === 120 ? 590 : 470);
      expect(r.gameTime).toBeCloseTo(10, 0);
    }
    expect(run(144, 0).drawn).toBe(1440);
    const j = run(60, 30, 10, 2);
    expect(j.drawn).toBeGreaterThanOrEqual(295);
    expect(j.drawn).toBeLessThanOrEqual(305);
  });

  it("a slot missed by more than a frame is dropped, never caught up in a burst", () => {
    const p = new FramePacer(60);
    expect(p.tick(0)).toBe(true);
    expect(p.tick(200)).toBe(true); // a 200 ms stall
    expect(p.tick(205)).toBe(false); // no catch-up
    expect(p.tick(216.7)).toBe(true);
  });
});

describe("the shadow map's redraws (ShadowScheduler)", () => {
  it("static layer: the sun, the box or the static set changing, else never; casters: with it, every frame one moves, else every `every` frames animating", () => {
    const s = new ShadowScheduler(2);
    const due = (sun: number, box: string, moving = false, animated = true, statics = "9") => s.due(sun, box, statics, moving, animated);
    expect(due(1, "0,0,0")).toEqual({ statics: true, casters: true }); // first frame
    expect(due(1, "0,0,0")).toEqual({ statics: false, casters: false });
    expect(due(1, "0,0,0")).toEqual({ statics: false, casters: true }); // 2 frames on: the idle animation
    expect(due(1, "0,0,0", true)).toEqual({ statics: false, casters: true }); // a caster moved: every frame
    expect(due(1, "0,0,0", true)).toEqual({ statics: false, casters: true });
    expect(due(1, "93,0,0", true)).toEqual({ statics: true, casters: true }); // the box stepped a cell
    expect(due(2, "93,0,0")).toEqual({ statics: true, casters: true }); // the sun moved (setDaylight)
    expect(due(2, "93,0,0", false, true, "10")).toEqual({ statics: true, casters: true }); // a static root landed
    for (let i = 0; i < 100; i++) expect(due(2, "93,0,0", false, false, "10")).toEqual({ statics: false, casters: false }); // a still scene keeps its map
    expect(due(2, "93,0,0", false, true, "10").casters).toBe(true);
    expect(s.updates).toBe(4);
    expect(s.casterUpdates).toBe(8);
    expect(s.frames).toBe(109);
    // lite: every third frame while the casters only animate in place, every frame while one walks
    const l = new ShadowScheduler(3);
    expect(Array.from({ length: 12 }, () => l.due(0, "k", "1", false, true).casters).filter(Boolean).length).toBe(4);
    expect(Array.from({ length: 12 }, () => l.due(0, "k", "1", true, true).casters).every(Boolean)).toBe(true);
    expect(SHADOW_CELL).toBeGreaterThan(0);
  });
});

describe("grass LOD", () => {
  it("the bands: dense near to 12.5 m, sparse far to 30 m (none beyond); lite's far band unshadowed", () => {
    const full = grassBands(false);
    expect(full.map((b) => [b.key, b.fade[1], b.shadow])).toEqual([["near", 12.5, true], ["far", 30, true]]);
    expect(full[0].n ** 2 / full[0].tile ** 2).toBeGreaterThan(8 * (full[1].n ** 2 / full[1].tile ** 2) * 0.9); // near ~8x as dense
    const lite = grassBands(true);
    expect(lite[1].fade).toEqual(LITE_FAR_FADE);
    expect(lite[1].shadow).toBe(false);
    expect(lite[1].fade[1]).toBeLessThanOrEqual(full[1].fade[1]);
    for (const b of full) expect(b.tile / 2).toBeGreaterThanOrEqual(b.fade[1]); // the tile covers its fade radius
    expect(GRASS.near.chunks ** 2 + GRASS.far.chunks ** 2).toBeLessThanOrEqual(64); // a bounded number of meshes
  });

  it("wrapIntervals: a chunk lands where the tile wraps it round the player: one interval, or two when the wrap cuts it", () => {
    expect(wrapIntervals(0, 6.5, 13, 26)).toEqual([[0, 6.5]]);
    expect(wrapIntervals(0, 6.5, 0, 26)).toEqual([[0, 6.5]]);
    expect(wrapIntervals(0, 6.5, 40, 26)).toEqual([[27, 32.5], [52, 53]]); // the window [27, 53) takes a sliver of the next copy too
    // the wrap line (c - T/2 = 3) cuts [0, 6.5): [3, 6.5) stays, [0, 3) moves a tile on
    expect(wrapIntervals(0, 6.5, 16, 26)).toEqual([[3, 6.5], [26, 29]]);
    // every blade position lands exactly once inside the window
    for (const c of [-50, -3.3, 0, 7.7, 100]) {
      let total = 0;
      for (let k = 0; k < 4; k++) for (const [a, b] of wrapIntervals(k * 6.5, (k + 1) * 6.5, c, 26)) {
        expect(a).toBeGreaterThanOrEqual(c - 13 - 1e-9);
        expect(b).toBeLessThanOrEqual(c + 13 + 1e-9);
        total += b - a;
      }
      expect(total).toBeCloseTo(26, 9);
    }
  });

  it("grassChunkVisible: behind the camera or past the band's reach, not drawn; in view and in reach, drawn", () => {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
    cam.position.set(0, 10, 12);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const centre = { x: 0, y: 0 };
    const tile = 26;
    const at = (x: number, z: number) => ({ x0: x, x1: x + 6.5, z0: z, z1: z + 6.5 });
    // the chunk under the player: drawn
    expect(grassChunkVisible(frustum, centre, at(0, 0), tile, 12.5, 0, 1)).toBe(true);
    // behind the camera (z > 12): not drawn; without a frustum it would be
    expect(grassChunkVisible(frustum, { x: 0, y: 25 }, at(19.5, 19.5), 72, 60, 0, 1)).toBe(false);
    expect(grassChunkVisible(null, { x: 0, y: 25 }, at(19.5, 19.5), 72, 60, 0, 1)).toBe(true);
    const behind = { x: 0, y: 0 };
    const far = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
    far.position.set(0, 2, -10);
    far.lookAt(0, 0, -30);
    far.updateMatrixWorld();
    const f2 = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(far.projectionMatrix, far.matrixWorldInverse));
    expect(grassChunkVisible(f2, behind, { x0: -3, x1: 3, z0: 2, z1: 8 }, 26, 12.5, 0, 1)).toBe(false);
    expect(grassChunkVisible(null, behind, { x0: -3, x1: 3, z0: 2, z1: 8 }, 26, 12.5, 0, 1)).toBe(true);
    // out of reach: a chunk whose nearest point is 13 m off, reach 12.5
    expect(grassChunkVisible(null, { x: 0, y: 0 }, { x0: 13, x1: 19, z0: -3, z1: 3 }, 72, 12.5, 0, 1)).toBe(false);
    expect(grassChunkVisible(null, { x: 0, y: 0 }, { x0: 12, x1: 19, z0: -3, z1: 3 }, 72, 12.5, 0, 1)).toBe(true);
  });
});

describe("the ?perf=1 probe's long-frame causes", () => {
  it("a sync read, a compile, the env build first; then the CPU's biggest section, the GPU, an asset, or outside the frame", () => {
    const f = { interval: 400, cpu: 10, cpuPass: { colour: 6, frame: 2 }, gpuTotal: 12, flags: [] as string[] };
    expect(longFrameCause({ ...f, flags: ["syncRead", "compile"] })).toBe("sync read-back");
    expect(longFrameCause({ ...f, flags: ["compile"] })).toBe("shader compile");
    expect(longFrameCause({ ...f, flags: ["upload"] })).toBe("texture / buffer upload");
    expect(longFrameCause({ ...f, cpu: 390, cpuPass: { colour: 380, frame: 2 } })).toBe("cpu: colour");
    expect(longFrameCause({ ...f, gpuTotal: 300 })).toBe("gpu");
    expect(longFrameCause({ ...f, flags: ["asset"] })).toBe("asset landed (upload / GC)");
    expect(longFrameCause(f)).toBe("outside the frame (GC, compositor, the tab)");
  });
});

describe("the saved frame rate (prefs.ts fps)", () => {
  it("absent by default; 30 and 60 round-trip; anything else is dropped", () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), keys: () => [...m.keys()] };
    expect(loadPrefs(kv).fps).toBeUndefined();
    savePrefs(kv, { ...loadPrefs(kv), fps: 30 });
    expect(loadPrefs(kv).fps).toBe(30);
    expect(JSON.parse(kv.getItem(PREFS_KEY)!).fps).toBe(30); // look.ts reads it itself
    kv.setItem(PREFS_KEY, JSON.stringify({ fps: 45 }));
    expect(loadPrefs(kv).fps).toBeUndefined();
  });
});

describe("no synchronous GPU read-back in the frame loop", () => {
  const src = join(__dirname, "..", "src");
  const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const read = (f: string) => readFileSync(join(src, f), "utf8");

  it("readRenderTargetPixels is only named by the ?perf=1 probe (which wraps it to flag any caller); gl.readPixels only into a pixel-pack buffer", () => {
    const named = files.filter((f) => /readRenderTargetPixels|readRenderTargetPixelsAsync/.test(read(f)));
    expect(named).toEqual(["perf.ts"]);
    const readers = files.filter((f) => /\.readPixels\(/.test(read(f)));
    expect(readers).toEqual(["seethrough.ts"]);
    const s = read("seethrough.ts");
    // the one readPixels writes into the bound PIXEL_PACK_BUFFER (offset 0), fenced
    expect(s).toMatch(/gl\.bindBuffer\(gl\.PIXEL_PACK_BUFFER, buffer\);[\s\S]{0,200}gl\.readPixels\([^)]*, 0\);\s*fence = gl\.fenceSync/);
    // getBufferSubData only after the fence reports signalled (the zero-timeout poll)
    const poll = s.slice(s.indexOf("private pollSlot"), s.indexOf("counts(slot: number)"));
    expect(poll.indexOf("clientWaitSync(read.fence, 0, 0)")).toBeGreaterThan(0);
    expect(poll.indexOf("getBufferSubData")).toBeGreaterThan(poll.indexOf("TIMEOUT_EXPIRED"));
    // nothing blocks on the GPU: no finish(), no waiting clientWaitSync
    for (const f of files) {
      expect(read(f), f).not.toMatch(/\bgl\.finish\(|renderer\.getContext\(\)\.finish\(/);
      expect(read(f), f).not.toMatch(/clientWaitSync\([^)]*,\s*[1-9]/);
    }
  });
});

describe("the prefetcher's time slices (prefetch.ts TimeSlicer, fake clock)", () => {
  /**
   * A job of `steps` synchronous steps (each `ms(i)` on the clock) on a slicer, run one slice per
   * "frame" (beginSlice, then every continuation runs); the work of each slice, in ms.
   */
  async function slices(ms: (i: number) => number, steps: number, budget = PREFETCH_SLICE_MS) {
    const clock = { t: 0 };
    const s = new TimeSlicer(() => clock.t, budget);
    let done = 0;
    void (async () => {
      await s.step();
      for (let i = 0; i < steps; i++) {
        clock.t += ms(i);
        done++;
        await s.step();
      }
    })();
    const work: number[] = [];
    for (let f = 0; f < 10 * steps && done < steps; f++) {
      const before = s.spent;
      s.beginSlice();
      for (let k = 0; k < 50; k++) await Promise.resolve();
      clock.t += 16; // the rest of the frame: not the prefetcher's
      work.push(s.spent - before);
    }
    return { work: work.filter((w) => w > 0), done, slicer: s };
  }

  it(`steps of 0.3-2 ms: every slice's work stays within ${PREFETCH_SLICE_MS} ms, and the job finishes`, async () => {
    for (const stepMs of [0.3, 1, 1.5, 2]) {
      const r = await slices(() => stepMs, 60);
      expect(r.done, `${stepMs} ms`).toBe(60);
      for (const w of r.work) expect(w, `${stepMs} ms steps`).toBeLessThanOrEqual(PREFETCH_SLICE_MS + 1e-9);
      // and it uses the slice: more than one step a slice when they fit
      if (stepMs <= 1) expect(Math.max(...r.work), `${stepMs} ms`).toBeGreaterThanOrEqual(PREFETCH_SLICE_MS - stepMs - 1e-9);
    }
  });

  it("uneven steps (a 3 ms one among 0.5 ms ones): a slice of short steps stays within the slice; one with a long step overruns by that step at most", async () => {
    const clock = { t: 0 };
    const s = new TimeSlicer(() => clock.t);
    const long = (i: number) => i % 7 === 3;
    let frame = 0;
    const ran: { frame: number; ms: number }[] = [];
    let done = 0;
    void (async () => {
      await s.step();
      for (let i = 0; i < 70; i++) {
        const ms = long(i) ? 3 : 0.5;
        clock.t += ms;
        ran.push({ frame, ms });
        done++;
        await s.step();
      }
    })();
    for (; frame < 400 && done < 70; frame++) {
      s.beginSlice();
      for (let k = 0; k < 50; k++) await Promise.resolve();
      clock.t += 16;
    }
    expect(done).toBe(70);
    const byFrame = new Map<number, number[]>();
    for (const r of ran) byFrame.set(r.frame, [...(byFrame.get(r.frame) ?? []), r.ms]);
    for (const [, steps] of byFrame) {
      const work = steps.reduce((a, b) => a + b, 0);
      if (steps.every((x) => x < 3)) expect(work).toBeLessThanOrEqual(PREFETCH_SLICE_MS);
      else expect(work).toBeLessThanOrEqual(PREFETCH_SLICE_MS + 3);
    }
  });

  it("a step alone over the slice (one driver compile) still runs, one a slice: the job makes progress", async () => {
    const r = await slices(() => 10, 5);
    expect(r.done).toBe(5);
    expect(r.work).toEqual([10, 10, 10, 10, 10]);
    expect(r.slicer.maxStep).toBe(10);
  });

  it("an async wait is off the budget: a 100 ms fetch between steps isn't counted as work", async () => {
    const clock = { t: 0 };
    const s = new TimeSlicer(() => clock.t);
    let resolveFetch!: () => void;
    const fetched = new Promise<void>((r) => (resolveFetch = r));
    let finished = false;
    void (async () => {
      await s.step();
      clock.t += 1;
      await s.wait(fetched);
      clock.t += 1;
      await s.step();
      finished = true;
    })();
    s.beginSlice();
    for (let k = 0; k < 20; k++) await Promise.resolve();
    clock.t += 100; // the fetch
    resolveFetch();
    for (let k = 0; k < 20; k++) await Promise.resolve();
    s.beginSlice();
    for (let k = 0; k < 20; k++) await Promise.resolve();
    expect(finished).toBe(true);
    expect(s.spent).toBe(2);
  });
});
