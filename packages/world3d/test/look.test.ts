// Graphics tiers (look.ts): the resolution order (URL > saved choice > device default), the auto
// default per device signal, each tier's layers, the safety valve's rules, the saved choice in
// prefs.ts, and the loading bar's work item (the environment build).
import { describe, expect, it } from "vitest";
import { autoTier, ENV_LAYERS, LITE_GRASS, LITE_LAYERS, LookValve, lookFor, resolveLook, tierLayers, TIERS, type DeviceSignals } from "../src/look";
import { emptyLoad, loadSummary, reduceLoad, WORK_SHARE } from "../src/loading";
import { DEFAULT_PREFS, GRAPHICS_TIERS, loadPrefs, PREFS_KEY, savePrefs } from "../src/prefs";

const DESKTOP: DeviceSignals = { coarse: false, deviceMemory: 8, cores: 8 };
const PHONE: DeviceSignals = { coarse: true, deviceMemory: 4, cores: 8 };

describe("graphics tier resolution", () => {
  it("the URL wins over the saved choice, the saved choice over the device", () => {
    expect(resolveLook("?look=classic", "full", DESKTOP)).toMatchObject({ tier: "classic", source: "url", real: false });
    expect(resolveLook("?look=real", "classic", PHONE)).toMatchObject({ tier: "full", source: "url", real: true });
    expect(resolveLook("?look=lite", "full", DESKTOP)).toMatchObject({ tier: "lite", source: "url" });
    expect(resolveLook("?look=full", "lite", PHONE)).toMatchObject({ tier: "full", source: "url" });
    expect(resolveLook("?look=toon", undefined, DESKTOP)).toMatchObject({ tier: "classic", source: "url" });
    expect(resolveLook("", "classic", DESKTOP)).toMatchObject({ tier: "classic", source: "pref", real: false });
    expect(resolveLook("", "full", PHONE)).toMatchObject({ tier: "full", source: "pref" });
    expect(resolveLook("", undefined, DESKTOP)).toMatchObject({ tier: "full", source: "auto" });
    expect(resolveLook("", undefined, PHONE)).toMatchObject({ tier: "lite", source: "auto", reason: "auto: coarse pointer" });
    // an unknown ?look= is no override
    expect(resolveLook("?look=ultra", "lite", DESKTOP)).toMatchObject({ tier: "lite", source: "pref" });
  });

  it("?env= picks the layers (alone: the real look with just those; empty: none), &ramp=1 keeps the toon materials", () => {
    expect(resolveLook("?look=real&env=grass,sky", undefined, PHONE).env).toEqual(["grass", "sky"]);
    expect(resolveLook("?look=real&env=", "classic", DESKTOP)).toMatchObject({ tier: "full", real: true, env: [] });
    expect(resolveLook("?env=bloom", "classic", DESKTOP)).toMatchObject({ tier: "full", source: "url", env: ["bloom"] });
    expect(resolveLook("?look=real&ramp=1", undefined, DESKTOP).ramp).toBe(true);
    expect(resolveLook("?look=classic&ramp=1&env=grass", undefined, DESKTOP)).toMatchObject({ ramp: false, env: [] });
  });

  it("auto: lite on a coarse pointer, <= 4 GB or <= 4 cores; full otherwise (a missing signal doesn't count)", () => {
    expect(autoTier({ coarse: true, deviceMemory: 8, cores: 16 }).tier).toBe("lite");
    expect(autoTier({ coarse: false, deviceMemory: 4, cores: 16 })).toEqual({ tier: "lite", reason: "auto: deviceMemory 4" });
    expect(autoTier({ coarse: false, deviceMemory: 2 }).tier).toBe("lite");
    expect(autoTier({ coarse: false, deviceMemory: 8, cores: 4 })).toEqual({ tier: "lite", reason: "auto: 4 cores" });
    expect(autoTier({ coarse: false, deviceMemory: 8, cores: 6 }).tier).toBe("full");
    expect(autoTier({ coarse: false, deviceMemory: 8, cores: 5 }).tier).toBe("full");
    expect(autoTier({ coarse: false }).tier).toBe("full"); // Safari / Firefox: no deviceMemory
  });

  it("the layer sets: full every layer, lite ground / grass at half / sky / grade, classic none", () => {
    expect(tierLayers("full")).toEqual({ env: [...ENV_LAYERS], grassDensity: 1 });
    expect(tierLayers("lite")).toEqual({ env: ["ground", "grass", "sky", "grade"], grassDensity: 0.5 });
    expect(LITE_LAYERS).not.toContain("bloom");
    expect(LITE_LAYERS).not.toContain("leaves");
    expect(LITE_LAYERS).not.toContain("particles");
    expect(LITE_GRASS).toBe(0.5);
    expect(tierLayers("classic").env).toEqual([]);
    expect(lookFor("lite", "auto", "")).toMatchObject({ real: true, env: LITE_LAYERS, grassDensity: 0.5 });
    expect(lookFor("classic", "auto", "")).toMatchObject({ real: false, ramp: false, env: [] });
  });
});

describe("the safety valve", () => {
  const run = (v: LookValve, ms: number, seconds = 3.2) => {
    let drops = 0;
    for (let t = 0; t < seconds * 1000; t += ms) if (v.frame(ms)) drops++;
    return drops;
  };

  it("full by the device's default: a slow first 3 s (mean over 33 ms) drops once; a fast one never", () => {
    const slow = new LookValve({ tier: "full", source: "auto" });
    expect(slow.state).toBe("watching");
    expect(run(slow, 40, 10)).toBe(1);
    expect(slow.state).toBe("dropped");
    expect(slow.meanMs).toBe(40);
    expect(slow.frame(100)).toBe(false); // once
    const fast = new LookValve({ tier: "full", source: "auto" });
    expect(run(fast, 17, 10)).toBe(0);
    expect(fast.state).toBe("idle");
    expect(fast.frame(200)).toBe(false); // the window has passed: slow later never counts
    const edge = new LookValve({ tier: "full", source: "auto" });
    expect(run(edge, 33)).toBe(0); // "above 33 ms"
  });

  it("a stall counts as 250 ms at most (a hidden tab, a GC); nothing before the window closes", () => {
    const v = new LookValve({ tier: "full", source: "auto" });
    expect(v.frame(5000)).toBe(false);
    expect(v.state).toBe("watching");
    expect(run(v, 16, 2.9)).toBe(0);
    expect(v.state).toBe("idle"); // 250 + ~2.9 s of 16 ms: mean under 33
  });

  it("never fights a choice: a URL, a saved tier, or a pick in Settings; never below lite", () => {
    for (const look of [{ tier: "full", source: "url" }, { tier: "full", source: "pref" }, { tier: "lite", source: "auto" }, { tier: "classic", source: "auto" }] as const) {
      const v = new LookValve(look);
      expect(v.state, JSON.stringify(look)).toBe("idle");
      expect(run(v, 80, 10)).toBe(0);
    }
    const v = new LookValve({ tier: "full", source: "auto" });
    run(v, 80, 1);
    v.manual(); // Settings → Graphics mid-window
    expect(run(v, 80, 10)).toBe(0);
    expect(v.state).toBe("idle");
  });
});

describe("the saved choice (prefs.ts graphics)", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), keys: () => [...m.keys()] };
  };

  it("absent by default; a tier round-trips; anything else is dropped; the two tier lists agree", () => {
    expect(GRAPHICS_TIERS).toEqual(TIERS);
    const kv = store();
    expect(loadPrefs(kv).graphics).toBeUndefined();
    expect("graphics" in DEFAULT_PREFS).toBe(false);
    for (const t of TIERS) {
      savePrefs(kv, { ...loadPrefs(kv), graphics: t });
      expect(loadPrefs(kv).graphics).toBe(t);
      // look.ts reads the same key itself, before main.ts loads the prefs
      expect(JSON.parse(kv.getItem(PREFS_KEY)!).graphics).toBe(t);
    }
    kv.setItem(PREFS_KEY, JSON.stringify({ graphics: "ultra" }));
    expect(loadPrefs(kv).graphics).toBeUndefined();
  });
});

describe("the loading bar's work item (the environment build)", () => {
  it("holds the bar short of full until done, takes WORK_SHARE of it, and never shows in the bytes", () => {
    let s = reduceLoad(emptyLoad, { type: "start", name: "a.glb", bytes: 1000 });
    s = reduceLoad(s, { type: "done", name: "a.glb" });
    expect(loadSummary(s)).toMatchObject({ fraction: 1, complete: true });
    s = reduceLoad(s, { type: "start", name: "environment", work: true });
    let p = loadSummary(s);
    expect(p.fraction).toBeCloseTo(1 - WORK_SHARE);
    expect(p).toMatchObject({ loaded: 1000, total: 1000, current: "environment", complete: false, count: 2, done: 1 });
    s = reduceLoad(s, { type: "done", name: "environment" });
    p = loadSummary(s);
    expect(p).toMatchObject({ fraction: 1, complete: true, total: 1000 });
    // a failed build counts as done (the bar never sticks), and starts from 0 again on a retry
    s = reduceLoad(reduceLoad(emptyLoad, { type: "start", name: "environment", work: true }), { type: "fail", name: "environment" });
    expect(loadSummary(s)).toMatchObject({ fraction: 1, complete: true });
    s = reduceLoad(s, { type: "start", name: "environment", work: true });
    expect(s.items[0]).toMatchObject({ done: false, work: true });
  });
});
