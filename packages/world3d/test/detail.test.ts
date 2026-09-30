// Tiling detail maps on the textured assets (src/detail.ts, README "Real look" "Detail maps") and the
// evening lantern glow (envlook.ts emissives): the family table covers every textured material the
// vendored GLBs carry, the generated textures are the right size, tile seamlessly and stay grey
// around 1, the patch is real-look only (Classic and the ramp never), and lantern_red glows with its
// map on the lantern alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS script, no types
import { parseGlb } from "../scripts/glb.mjs";
import { ALBEDO_LO, ALBEDO_SPAN, DETAIL_FADE, DETAIL_KEY, DETAIL_KINDS, DETAIL_N, DETAIL_TILE_M, detailFor, detailShader, detailTexture, detailTextureData, FAMILY_DETAIL, familyOf, NAME_FAMILY } from "../src/detail";
import { emissives, LANTERN_GLOW } from "../src/envlook";
import { LayoutIndex, LAYOUT } from "../src/layout";
import { AssetCache } from "../src/world";
import { ASSETS, assetIndex } from "./helpers";

/** every textured material (a base colour texture) in the vendored GLBs, with its asset and set */
function texturedMaterials(): { name: string; asset: string; set: string }[] {
  const out: { name: string; asset: string; set: string }[] = [];
  for (const a of assetIndex?.assets ?? []) {
    if (!(a as { texture?: unknown }).texture) continue;
    const { json } = parseGlb(readFileSync(join(ASSETS, a.path)));
    for (const m of (json.materials ?? []) as { name: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[])
      if (m.pbrMetallicRoughness?.baseColorTexture) out.push({ name: m.name, asset: a.name, set: a.set });
  }
  return out;
}

describe("detail family table", () => {
  it.skipIf(!assetIndex)("every textured material in the vendored GLBs maps to a known family (none falls to the default); brick / plaster / wood / metal get their own texture", () => {
    const mats = texturedMaterials();
    expect(mats.length).toBeGreaterThan(100);
    const defaults = mats.filter((m) => familyOf(m.name, m.set, m.asset) === null).map((m) => `${m.asset}:${m.name}`);
    expect(defaults, "names the table doesn't know").toEqual([]);
    for (const m of mats) {
      const f = familyOf(m.name, m.set, m.asset)!;
      expect(f === "flat" || f in FAMILY_DETAIL, `${m.asset}:${m.name} -> ${f}`).toBe(true);
    }
    const kind = (name: string, set = "buildings", asset = "noodle_shop") => detailFor(name, set, asset)?.kind ?? null;
    expect(kind("brick")).toBe("brick");
    expect(kind("plaster")).toBe("plaster");
    expect(kind("concrete")).toBe("plaster");
    expect(kind("wood")).toBe("wood");
    expect(kind("wood_dark")).toBe("wood");
    expect(kind("metal")).toBe("metal");
    expect(kind("bld_iron")).toBe("metal");
    expect(kind("land_bank_wet", "landscape", "canal_banks")).toBe("stone");
    // the library's set / asset overrides: a props / interiors "brick" is a teapot or a pot (ceramic: none)
    expect(kind("brick", "props", "plant_bamboo_pot")).toBeNull();
    expect(kind("brick", "interiors", "tea_set_tray")).toBeNull();
    expect(detailFor("red", "props", "stool_plastic")!.family).toBe("plastic");
    // every family the name table uses has a detail entry
    for (const f of new Set(Object.values(NAME_FAMILY))) expect(FAMILY_DETAIL, f).toHaveProperty(f);
  });

  it("game-owned flat names get nothing; an unknown name gets plaster grain, low", () => {
    for (const n of ["grass_light", "land_path", "land_plaza", "water_deep", "canopy_green", "glass", "pi_glass", "sky_blue", "mtn_haze"]) expect(detailFor(n), n).toBeNull();
    const d = detailFor("something_new")!;
    expect(d).toMatchObject({ kind: "plaster", family: "default" });
    expect(d.albedo).toBeLessThanOrEqual(0.35);
    expect(d.normal).toBeLessThanOrEqual(0.35);
    expect(detailFor("pi_ceramic")).toBeNull();
    expect(detailFor("broth")).toBeNull();
  });
});

describe("detail textures", () => {
  const cache = new Map<string, Uint8Array>();
  const data = (k: (typeof DETAIL_KINDS)[number]) => cache.get(k) ?? (cache.set(k, detailTextureData(k)), cache.get(k)!);

  it("each is DETAIL_N² RGBA, deterministic, albedo mean 1 and the bulk within +-15 %, normals centred", () => {
    expect(DETAIL_N).toBeLessThanOrEqual(256);
    for (const k of DETAIL_KINDS) {
      const a = data(k);
      expect(a.length, k).toBe(DETAIL_N * DETAIL_N * 4);
      if (k === "brick") expect(detailTextureData(k)).toEqual(a);
      const mult: number[] = [];
      let gx = 0;
      let gy = 0;
      for (let i = 0; i < a.length; i += 4) {
        mult.push(ALBEDO_LO + (ALBEDO_SPAN * a[i]) / 255);
        gx += a[i + 1];
        gy += a[i + 2];
      }
      const mean = mult.reduce((s, x) => s + x, 0) / mult.length;
      expect(mean, k).toBeCloseTo(1, 2);
      mult.sort((x, y) => x - y);
      expect(mult[Math.floor(mult.length * 0.05)], `${k} p5`).toBeGreaterThan(0.85);
      expect(mult[Math.floor(mult.length * 0.95)], `${k} p95`).toBeLessThan(1.15);
      expect(gx / mult.length, k).toBeCloseTo(127.5, -1);
      expect(gy / mult.length, k).toBeCloseTo(127.5, -1);
      expect(DETAIL_TILE_M[k]).toBeGreaterThanOrEqual(0.5);
      expect(DETAIL_TILE_M[k]).toBeLessThanOrEqual(2.5);
    }
  }, 60_000);

  it("each tiles: the step across the wrap (last column -> first, last row -> first) is no bigger than the worst step between neighbouring columns / rows inside", () => {
    const N = DETAIL_N;
    for (const k of DETAIL_KINDS) {
      const a = data(k);
      for (let ch = 0; ch < 3; ch++) {
        const px = (x: number, y: number) => a[(y * N + x) * 4 + ch];
        const colStep = (x0: number, x1: number) => {
          let s = 0;
          for (let y = 0; y < N; y++) s += Math.abs(px(x1, y) - px(x0, y));
          return s / N;
        };
        const rowStep = (y0: number, y1: number) => {
          let s = 0;
          for (let x = 0; x < N; x++) s += Math.abs(px(x, y1) - px(x, y0));
          return s / N;
        };
        let worstX = 0;
        let worstY = 0;
        for (let i = 0; i < N - 1; i++) {
          worstX = Math.max(worstX, colStep(i, i + 1));
          worstY = Math.max(worstY, rowStep(i, i + 1));
        }
        expect(colStep(N - 1, 0), `${k} ch${ch} u seam`).toBeLessThanOrEqual(worstX * 1.05 + 0.5);
        expect(rowStep(N - 1, 0), `${k} ch${ch} v seam`).toBeLessThanOrEqual(worstY * 1.05 + 0.5);
      }
    }
  }, 60_000);

  it("the texture: repeat, mipmapped, anisotropic, linear data, shared", () => {
    const t = detailTexture("brick");
    expect(t.image.width).toBe(DETAIL_N);
    expect([t.wrapS, t.wrapT]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping]);
    expect(t.generateMipmaps).toBe(true);
    expect(t.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(t.anisotropy).toBeGreaterThan(1);
    expect(t.colorSpace).toBe(THREE.NoColorSpace);
    expect(detailTexture("brick")).toBe(t);
  });

  it("the shader patch is fragment-only: the standard shader's anchors, triplanar textureGrad reads, the distance fade", () => {
    const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
    const vert = s.vertexShader;
    detailShader(s, detailFor("brick")!);
    expect(s.vertexShader).toBe(vert);
    expect(s.fragmentShader.match(/textureGrad\(dtMap/g)?.length).toBe(3);
    expect(s.fragmentShader).toContain("diffuseColor.rgb *= dtMul;");
    expect(s.fragmentShader.indexOf("dtMul = 1.0;")).toBeLessThan(s.fragmentShader.indexOf("#include <map_fragment>"));
    expect(s.fragmentShader.indexOf("mat3(viewMatrix) * dtBend")).toBeGreaterThan(s.fragmentShader.indexOf("#include <normal_fragment_maps>"));
    expect(s.uniforms.dtMap.value).toBe(detailTexture("brick"));
    expect((s.uniforms.dtFade.value as THREE.Vector4).y).toBe(DETAIL_FADE.end);
    expect(DETAIL_FADE.end).toBeLessThanOrEqual(28);
    expect(DETAIL_FADE.normal[1]).toBeLessThanOrEqual(DETAIL_FADE.end);
  });
});

describe("detail on the materials", () => {
  const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const textured = (name: string) => {
    const orm = tex();
    return new THREE.MeshStandardMaterial({ name, map: tex(), aoMap: orm, roughnessMap: orm, metalnessMap: orm });
  };

  it.skipIf(!assetIndex)("classic (the tests' own tier: no page): a textured material takes no detail, no patch", () => {
    const toon = new AssetCache(ASSETS, new LayoutIndex(LAYOUT, assetIndex!)).toon;
    const m = toon.material(textured("brick"), false, { set: "buildings", asset: "noodle_shop" });
    expect(m).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(m.userData.detail).toBeUndefined();
    expect(m.customProgramCacheKey()).not.toContain(DETAIL_KEY);
  });

  it.skipIf(!assetIndex)("real look (full / lite): textured world materials take their family's detail (one program key), flat / game-owned / ceramic / character ones none; ramp none", async () => {
    vi.resetModules();
    vi.doMock("../src/look", async (orig) => ({ ...(await orig<typeof import("../src/look")>()), LOOK: { real: true, ramp: false } }));
    try {
      const world = await import("../src/world");
      const layout = await import("../src/layout");
      const toon = new world.AssetCache(ASSETS, new layout.LayoutIndex(layout.LAYOUT, assetIndex!)).toon;
      const from = { set: "buildings", asset: "noodle_shop" };
      const brick = toon.material(textured("brick"), false, from) as unknown as THREE.MeshStandardMaterial;
      expect(brick.userData.detail).toMatchObject({ kind: "brick", family: "brick" });
      expect(brick.userData.asset).toBe("noodle_shop");
      expect(brick.customProgramCacheKey()).toBe(`see-through-objects|${DETAIL_KEY}`);
      const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
      brick.onBeforeCompile(s as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      expect(s.fragmentShader).toContain("stSeeThrough();"); // chained after the see-through's patch
      expect(s.fragmentShader).toContain("dtMul");
      expect((toon.material(textured("wood"), false, from) as unknown as THREE.MeshStandardMaterial).userData.detail.kind).toBe("wood");
      expect(toon.material(textured("wood"), false, from).customProgramCacheKey()).toBe(brick.customProgramCacheKey());
      expect(toon.material(new THREE.MeshStandardMaterial({ name: "brick", color: 0x993322 })).userData.detail).toBeUndefined();
      expect(toon.material(textured("glass"), false, from).userData.detail).toBeUndefined();
      expect(toon.material(textured("pi_ceramic"), false, { set: "props", asset: "bowl_soup" }).userData.detail).toBeUndefined();
      expect(toon.material(textured("brick"), false, { set: "props", asset: "plant_bamboo_pot" }).userData.detail).toBeUndefined();
      expect(toon.material(textured("wood"), true, { set: "characters", asset: "cook" }).userData.detail).toBeUndefined();
    } finally {
      vi.doUnmock("../src/look");
      vi.resetModules();
    }
    vi.resetModules();
    vi.doMock("../src/look", async (orig) => ({ ...(await orig<typeof import("../src/look")>()), LOOK: { real: true, ramp: true } }));
    try {
      const world = await import("../src/world");
      const layout = await import("../src/layout");
      const toon = new world.AssetCache(ASSETS, new layout.LayoutIndex(layout.LAYOUT, assetIndex!)).toon;
      expect(toon.material(textured("brick"), false, { set: "buildings", asset: "noodle_shop" }).userData.detail).toBeUndefined();
    } finally {
      vi.doUnmock("../src/look");
      vi.resetModules();
    }
  });
});

describe("the lantern's evening glow (envlook.ts emissives)", () => {
  it("lantern_red glows on the lantern with emissiveMap = its map, red-orange; the buildings' lantern_red trim never; a flat lantern_red as before", () => {
    const scene = new THREE.Scene();
    const add = (m: THREE.MeshStandardMaterial) => {
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), m));
      return m;
    };
    const mk = (asset?: string) => {
      const m = new THREE.MeshStandardMaterial({ name: "lantern_red", map: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
      if (asset) m.userData.asset = asset;
      return add(m);
    };
    const lantern = mk("lantern");
    const trims = ["noodle_shop", "tea_house", "red_door"].map((a) => mk(a));
    const flat = add(new THREE.MeshStandardMaterial({ name: "lantern_red", color: 0xcc2211 }));
    const glow = emissives(scene);
    expect(lantern.emissiveMap).toBe(lantern.map);
    for (const t of trims) expect(t.emissiveMap).toBeNull();
    glow(1);
    expect(lantern.emissiveIntensity).toBeCloseTo(LANTERN_GLOW.gain);
    const c = lantern.emissive;
    expect(c.r).toBeGreaterThan(0.9);
    expect(c.g).toBeLessThan(c.r * 0.3);
    expect(c.b).toBeLessThan(c.g);
    // warm red-orange after the tone mapping: the gain stays low (the old flat 2.2 blew out to cream)
    expect(LANTERN_GLOW.gain).toBeLessThanOrEqual(1.5);
    for (const t of trims) {
      expect(t.emissiveIntensity).toBe(1);
      expect(t.emissive.getHex()).toBe(0);
    }
    expect(flat.emissiveMap).toBeNull();
    expect(flat.emissiveIntensity).toBeCloseTo(2.2);
    glow(0);
    expect(lantern.emissive.getHex()).toBe(0);
    expect(lantern.emissiveIntensity).toBe(1);
  });
});
