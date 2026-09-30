// The textured assets (make-it-in-china docs/asset-conventions.md "Textures": one base colour and one
// half-resolution ORM atlas embedded as PNGs, shared by every textured material of the asset, UVs on
// TEXCOORD_0, no normal map; game-owned surfaces such as glass stay flat): the vendored copies keep every texture and UV through
// the sync (scripts/textures.mjs: base colour / ORM as JPEG q88 when smaller; scripts/meshopt.mjs:
// compression; checkSurfaces holds both to it), and the toon / real-look conversion (world.ts
// Toon.material) carries the maps while leaving flat materials as they were.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS script, no types
import { checkSurfaces, compressGlb, jpegSize, parseGlb, pngSize, ready, surfaces } from "../scripts/meshopt.mjs";
import { LAYOUT, LayoutIndex } from "../src/layout";
import { AssetCache } from "../src/world";
import { ASSETS, assetIndex } from "./helpers";

/** the textured assets the game uses: every vendored entry with a `texture` record (the library's index) */
const TEXTURED = (assetIndex?.assets ?? []).filter((a) => (a as { texture?: unknown }).texture).map((a) => a.name);
/** an index entry's texture record: atlas sizes in px */
const texOf = (name: string) => (assetIndex!.assets.find((a) => a.name === name) as unknown as { texture: { px: number[]; orm_px: number[] } }).texture;
/** the library next to the repo checkout, when it's there (as scripts/sync-assets.mjs) */
const LIBRARY = process.env.WORLD3D_LIBRARY ?? join(ASSETS, "..", "..", "..", "..", "assets");

/** One image's bytes inside a GLB. */
function imageBytes(buf: Buffer, i: number): Buffer {
  const { json, bin } = parseGlb(buf);
  const bv = json.bufferViews[json.images[i].bufferView];
  return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
}

describe("textured assets", () => {
  it.skipIf(!assetIndex)("every vendored textured GLB keeps its 2 atlases (base colour, ORM at the index's sizes; no normal map) and TEXCOORD_0; against the library: PNGs byte for byte, JPEGs at the same size", async () => {
    await ready();
    expect(TEXTURED.length, "textured assets in the vendored index").toBeGreaterThanOrEqual(50);
    for (const name of ["noodle_shop", "lantern", "stool_plastic", "table_folding"]) expect(TEXTURED).toContain(name);
    for (const name of TEXTURED) {
      const e = assetIndex!.assets.find((a) => a.name === name)!;
      const game = readFileSync(join(ASSETS, e.path));
      const s = surfaces(game);
      expect(s.images.length, `${name} images`).toBe(2);
      expect(s.textures, `${name} textures`).toBeGreaterThanOrEqual(2);
      expect(s.uvs.every(Boolean), `${name} TEXCOORD_0 on every primitive`).toBe(true);
      const { json } = parseGlb(game);
      type Mat = { name: string; normalTexture?: unknown; occlusionTexture?: { index: number }; pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } } };
      const textured = (json.materials as Mat[]).filter((m) => m.pbrMetallicRoughness?.baseColorTexture);
      expect(textured.length, `${name} textured materials`).toBeGreaterThan(0);
      const src = (i: number) => json.textures[i].source;
      const { px, orm_px } = texOf(name);
      for (const m of textured) {
        expect(m.normalTexture, `${name} ${m.name} normal map`).toBeUndefined();
        const orm = src(m.occlusionTexture!.index);
        expect(src(m.pbrMetallicRoughness!.metallicRoughnessTexture!.index), `${name} ${m.name} ORM: one image for occlusion and metallic-roughness`).toBe(orm);
        expect(s.images[src(m.pbrMetallicRoughness!.baseColorTexture!.index)].size, `${name} ${m.name} base colour size`).toEqual(px);
        expect(s.images[orm].size, `${name} ${m.name} ORM size`).toEqual(orm_px);
      }
      // game-owned surfaces stay flat: glass and panes (envlook emissives, interior-backdrop), ground / grass / water / canopy (envlook GRASS_RE, GROUND_RE, WATER_RE, CANOPY_RE)
      const owned = /^(glass|pi_glass|sky_blue|grass_.*|water_.*|land_(path|dirt|plaza|plaza_ring|stone_edge|bank_stone|coping)|canopy_green|leaf_green|leaf_dark|leaf_pale|town_willow)$/;
      for (const m of json.materials as Mat[]) if (owned.test(m.name)) expect(m.pbrMetallicRoughness?.baseColorTexture, `${name} ${m.name} flat`).toBeUndefined();
      for (const im of s.images) expect(im.size, `${name} ${im.mime} readable`).toBeTruthy();
      const lib = join(LIBRARY, e.path);
      if (existsSync(lib)) expect(() => checkSurfaces(readFileSync(lib), game, name)).not.toThrow();
    }
  });

  it.skipIf(!assetIndex)("checkSurfaces throws on a copy that lost its images, or whose PNG bytes changed", async () => {
    await ready();
    // bottle_water: its 6 px ORM stays PNG (JPEG wouldn't be smaller)
    const src = readFileSync(join(ASSETS, assetIndex!.assets.find((a) => a.name === "bottle_water")!.path));
    expect(() => checkSurfaces(src, compressGlb(src) ?? src, "bottle_water")).not.toThrow();
    const jl = src.readUInt32LE(12);
    const json = JSON.parse(src.subarray(20, 20 + jl).toString("utf8"));
    json.images = [];
    json.textures = [];
    const text = Buffer.from(JSON.stringify(json));
    const chunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const head = Buffer.from(src.subarray(0, 20));
    head.writeUInt32LE(chunk.length, 12);
    expect(() => checkSurfaces(src, Buffer.concat([head, chunk, src.subarray(20 + jl)]), "bottle_water")).toThrow(/lost its textures/);
    // a PNG byte flipped in place
    const png = parseGlb(src).json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/png");
    expect(png).toBeGreaterThanOrEqual(0);
    const bent = Buffer.from(src);
    const at = imageBytes(bent, png);
    at[at.length - 20] ^= 0xff;
    expect(() => checkSurfaces(src, bent, "bottle_water")).toThrow(/bytes changed/);
  });

  it.skipIf(!assetIndex)("jpegSize / pngSize read the vendored maps' sizes; a truncated JPEG doesn't parse", () => {
    const glb = readFileSync(join(ASSETS, assetIndex!.assets.find((a) => a.name === "noodle_shop")!.path));
    const { json } = parseGlb(glb);
    const sizes = json.images.map((im: { mimeType: string }, i: number) => (im.mimeType === "image/jpeg" ? jpegSize : pngSize)(imageBytes(glb, i)));
    const { px, orm_px } = texOf("noodle_shop");
    expect(sizes.sort((a: number[], b: number[]) => a[0] - b[0])).toEqual([orm_px, px]); // the ORM at half the base colour's size
    const jpeg = json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/jpeg");
    expect(jpegSize(imageBytes(glb, jpeg).subarray(0, 600))).toBeNull();
    const bottle = readFileSync(join(ASSETS, assetIndex!.assets.find((a) => a.name === "bottle_water")!.path));
    const png = parseGlb(bottle).json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/png");
    expect(pngSize(imageBytes(bottle, png))).toEqual(texOf("bottle_water").orm_px);
  });

  it.skipIf(!assetIndex)("toon conversion: a textured source keeps map, normalMap, aoMap (same textures, same UV channel); flat palette materials convert exactly as before", () => {
    const toon = new AssetCache(ASSETS, new LayoutIndex(LAYOUT, assetIndex!)).toon;
    const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const map = tex();
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = tex();
    const orm = tex();
    orm.channel = 0;
    const src = new THREE.MeshStandardMaterial({ map, normalMap, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, side: THREE.DoubleSide, name: "lantern_PBR" });
    const m = toon.material(src);
    expect(m).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(m.map).toBe(map);
    expect(m.normalMap).toBe(normalMap);
    expect(m.aoMap).toBe(orm);
    expect(m.aoMap!.channel).toBe(0);
    expect(m.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.side).toBe(THREE.DoubleSide);
    // another textured source with the same (white) colour: its own material, not the first one's
    const other = new THREE.MeshStandardMaterial({ map: tex(), side: THREE.DoubleSide });
    expect(toon.material(other)).not.toBe(m);
    expect(toon.material(other).map).toBe(other.map);
    // the same source again: shared
    expect(toon.material(src)).toBe(m);
    // flat palette material: no maps, shared by colour as before
    const flat = toon.material(new THREE.MeshStandardMaterial({ color: 0xc0392b, side: THREE.DoubleSide }));
    expect(flat.map).toBeNull();
    expect(flat.normalMap).toBeNull();
    expect(flat.aoMap).toBeNull();
    expect(toon.material(new THREE.MeshStandardMaterial({ color: 0xc0392b, side: THREE.DoubleSide }))).toBe(flat);
  });

  it.skipIf(!assetIndex)("real look: a textured source keeps all five maps and its own roughness / metalness factors; a flat one stays roughness 0.8, metalness 0", async () => {
    vi.resetModules();
    vi.doMock("../src/look", async (orig) => ({ ...(await orig<typeof import("../src/look")>()), LOOK: { real: true, ramp: false } }));
    try {
      const world = await import("../src/world");
      const layout = await import("../src/layout");
      const toon = new world.AssetCache(ASSETS, new layout.LayoutIndex(layout.LAYOUT, assetIndex!)).toon;
      const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
      const orm = tex();
      const src = new THREE.MeshStandardMaterial({ map: tex(), normalMap: tex(), normalScale: new THREE.Vector2(1, -1), aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1 });
      const m = toon.material(src) as unknown as THREE.MeshStandardMaterial;
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect([m.map, m.normalMap, m.aoMap, m.roughnessMap, m.metalnessMap]).toEqual([src.map, src.normalMap, orm, orm, orm]);
      expect([m.roughness, m.metalness]).toEqual([1, 1]);
      expect(m.normalScale.toArray()).toEqual([1, -1]);
      const flat = toon.material(new THREE.MeshStandardMaterial({ color: 0x336699 })) as unknown as THREE.MeshStandardMaterial;
      expect([flat.map, flat.roughnessMap, flat.roughness, flat.metalness]).toEqual([null, null, 0.8, 0]);
    } finally {
      vi.doUnmock("../src/look");
      vi.resetModules();
    }
  });
});
