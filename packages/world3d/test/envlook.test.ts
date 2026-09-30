// The real look's lawn and canopy constants (envlook.ts GRASS, GRASS_LOOK, CANOPY_CORE, grassDensityAt).
// The scene-level checks (no blades on the street or a footprint, a core in every tree) are in
// world.test.ts "real look environment"; the LOD bands and chunks in perf.test.ts "grass LOD".
import { describe, expect, it } from "vitest";
import { CANOPY_CORE, FIELD, GRASS, GRASS_LOOK, grassDensityAt, grassMacro, TUFT, tuftTextureData } from "../src/envlook";

describe("the lawn (envlook.ts GRASS, GRASS_LOOK)", () => {
  it("tuft cards: near 3 crossed quads, far 1 (turned to the camera), the tallest 0.16 m, at most 200 x 200 tufts a band", () => {
    expect(GRASS.near.size).toEqual([0.13, 0.16]);
    expect(GRASS.far.size).toEqual([0.26, 0.16]);
    expect([GRASS.near.quads, GRASS.far.quads]).toEqual([3, 1]);
    for (const b of [GRASS.near, GRASS.far]) {
      expect(b.n).toBeLessThanOrEqual(200);
      expect(b.size[1]).toBeLessThanOrEqual(0.16);
    }
    expect(GRASS_LOOK.lean).toBeLessThanOrEqual(0.2); // a few degrees
  });

  it("the colour: a deep green root (greener and darker than the lawn), a bright green-yellow tip, 80-90 % saturated on the town's lawn, never neon", () => {
    const lawn = [0.371, 0.552, 0.15]; // terrain_town grass_light (linear)
    const on = (m: number[]) => m.map((c, i) => c * lawn[i]);
    const sat = (c: number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const [root, mid, tip] = [on(GRASS_LOOK.root), on(GRASS_LOOK.mid), on(GRASS_LOOK.tip)];
    expect(sat(root)).toBeGreaterThan(sat(lawn)); // greener than the ground
    expect(lum(root)).toBeLessThan(lum(lawn)); // and darker
    expect(root[0] / root[1]).toBeLessThan(lawn[0] / lawn[1]);
    for (const c of [root, mid, tip]) {
      expect(sat(c)).toBeGreaterThanOrEqual(0.8);
      expect(Math.min(sat(c), GRASS_LOOK.maxSat)).toBeLessThanOrEqual(0.9);
      expect(c[1]).toBe(Math.max(...c)); // green, never yellow or blue
    }
    expect(tip[0] / tip[1]).toBeGreaterThan(root[0] / root[1]); // the tip toward yellow
    expect(lum(tip)).toBeGreaterThan(lum(root) * 1.4); // brighter than the root
    expect(lum(tip)).toBeLessThanOrEqual(lum(lawn) * 1.1); // no glow above the lawn
    expect(GRASS_LOOK.maxSat).toBeGreaterThanOrEqual(0.8);
    expect(GRASS_LOOK.maxSat).toBeLessThanOrEqual(0.9);
    expect(sat(tip)).toBeLessThanOrEqual(0.87); // the tip a notch calmer than the root and mid
    // the ground's lawn (round 4: raised from a light lift to the tufts' own green): the mid's hue
    // and brightness, its saturation lifted (up to 1.1x in linear: the ground's sky sheen greys it by
    // about a third on screen, so it lands at ~75-80 % of the tufts' there), so the tufts read as its
    // texture, not dots on beige
    const ground = mid.map((c) => Math.max(0, lum(mid) + (c - lum(mid)) * GRASS_LOOK.lawn.sat));
    expect(sat(ground) / sat(mid)).toBeGreaterThanOrEqual(0.7);
    expect(sat(ground) / sat(mid)).toBeLessThanOrEqual(1.1);
    expect(Math.abs(lum(ground) - lum(mid)) / lum(mid)).toBeLessThan(0.05);
    expect(ground[1]).toBe(Math.max(...ground));
    expect(GRASS_LOOK.clump.floor).toBeGreaterThan(0);
    expect(GRASS_LOOK.clump.floor).toBeLessThan(0.3);
  });

  it("the tuft texture: 256^2, two variants of 5-8 thin blades each, alpha-tested cover of a sliver of the card, tips thinning out", () => {
    const d = tuftTextureData().data as Uint8Array;
    const N = TUFT.n;
    expect(N).toBeLessThanOrEqual(512);
    expect(d.length).toBe(N * N * 4);
    for (const n of TUFT.blades) {
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(8);
    }
    const on = (x: number, y: number) => d[(y * N + x) * 4 + 3] >= TUFT.alphaTest * 255;
    let cover = 0;
    for (let q = 0; q < N * N; q++) if (d[q * 4 + 3] >= TUFT.alphaTest * 255) cover++;
    expect(cover / (N * N)).toBeGreaterThan(0.03);
    expect(cover / (N * N)).toBeLessThan(0.3); // thin blades, mostly air
    // each variant: at a third of the height, 4+ separate blades across it
    for (const v of [0, 1]) {
      let best = 0;
      for (let y = Math.floor(N * 0.25); y < N * 0.45; y++) {
        let runs = 0;
        for (let x = 0; x < N / 2; x++) if (on(v * (N / 2) + x, y) && (x === 0 || !on(v * (N / 2) + x - 1, y))) runs++;
        best = Math.max(best, runs);
      }
      expect(best, `variant ${v}`).toBeGreaterThanOrEqual(4);
    }
    // narrower toward the top: the covered texels in the top quarter well under the bottom quarter's
    const band = (y0: number, y1: number) => {
      let c = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < N; x++) if (on(x, y)) c++;
      return c;
    };
    expect(band(N * 0.75, N)).toBeLessThan(band(0, N * 0.25) * 0.3);
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
