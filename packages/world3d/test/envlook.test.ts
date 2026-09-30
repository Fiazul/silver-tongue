// The real look's lawn and canopy constants (envlook.ts GRASS, GRASS_LOOK, CANOPY_CORE, grassDensityAt).
// The scene-level checks (no blades on the street or a footprint, a core in every tree) are in
// world.test.ts "real look environment"; the LOD bands and chunks in perf.test.ts "grass LOD".
import { describe, expect, it } from "vitest";
import { CANOPY_CORE, FIELD, GRASS, GRASS_LOOK, grassDensityAt, grassMacro } from "../src/envlook";

describe("the lawn (envlook.ts GRASS, GRASS_LOOK)", () => {
  it("short blades: near 0.14 m, far 0.17 m tall at the size's top (half the first pass's), at most 200 x 200 blades a band", () => {
    expect(GRASS.near.size).toEqual([0.06, 0.14]);
    expect(GRASS.far.size).toEqual([0.11, 0.17]);
    for (const b of [GRASS.near, GRASS.far]) expect(b.n).toBeLessThanOrEqual(200);
  });

  it("a dark root and a yellow-green tip (more red, less blue than the lawn's green); thin patches keep a floor of their blades", () => {
    for (const c of GRASS_LOOK.root) expect(c).toBeLessThan(0.5);
    const [r, g, b] = GRASS_LOOK.tip;
    expect(r).toBeGreaterThan(g);
    expect(b).toBeLessThan(1);
    expect(GRASS_LOOK.clump.floor).toBeGreaterThan(0);
    expect(GRASS_LOOK.clump.floor).toBeLessThan(0.3);
  });

  it("grassDensityAt: 0 off the lawn's mask; on a full lawn, dense clumps, thin patches and some bare ground", () => {
    const n = FIELD.n;
    const none = { grass: new Uint8Array(n * n) };
    const all = { grass: new Uint8Array(n * n).fill(1) };
    const macro = grassMacro();
    const ds: number[] = [];
    for (let z = -60; z < 60; z += 0.7)
      for (let x = -60; x < 60; x += 0.7) {
        expect(grassDensityAt(none, macro, x, z)).toBe(0);
        ds.push(grassDensityAt(all, macro, x, z));
      }
    expect(grassDensityAt(all, macro, 80, 0)).toBe(0); // outside the field
    const share = (f: (d: number) => boolean) => ds.filter(f).length / ds.length;
    expect(share((d) => d > 0.9)).toBeGreaterThan(0.2);
    expect(share((d) => d < 0.3)).toBeGreaterThan(0.1);
    expect(share((d) => d === 0)).toBeGreaterThan(0.005);
    expect(share((d) => d === 0)).toBeLessThan(0.15);
    for (const d of ds) expect(d).toBeLessThanOrEqual(1);
  });
});

describe("the canopy core (envlook.ts CANOPY_CORE)", () => {
  it("inside the crown (under 1 of its half-size each way), darker than it, low-poly (detail <= 1: at most 80 triangles a tree)", () => {
    for (const r of CANOPY_CORE.radius) {
      expect(r).toBeGreaterThan(0.5);
      expect(r).toBeLessThan(1);
    }
    expect(CANOPY_CORE.shade).toBeLessThan(1);
    expect(CANOPY_CORE.detail).toBeLessThanOrEqual(1);
  });
});
