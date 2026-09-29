// The textured assets (make-it-in-china docs/asset-conventions.md "Textures": base colour, normal and
// ORM embedded as PNGs, UVs on TEXCOORD_0): the vendored copies keep every texture and UV through
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

/** the textured assets the game uses (the rest of the library's batch isn't placed anywhere, so isn't vendored) */
const TEXTURED = ["noodle_shop", "lantern", "stool_plastic", "table_folding"];
/** the library next to the repo checkout, when it's there (as scripts/sync-assets.mjs) */
const LIBRARY = process.env.WORLD3D_LIBRARY ?? join(ASSETS, "..", "..", "..", "..", "assets");

/** One image's bytes inside a GLB. */
function imageBytes(buf: Buffer, i: number): Buffer {
  const { json, bin } = parseGlb(buf);
  const bv = json.bufferViews[json.images[i].bufferView];
  return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
}

describe("textured assets", () => {
  it.skipIf(!assetIndex)("every vendored textured GLB keeps its 3 images (normal still PNG), 3 textures and TEXCOORD_0; against the library: PNGs byte for byte, JPEGs at the same size", async () => {
    await ready();
    for (const name of TEXTURED) {
      const e = assetIndex!.assets.find((a) => a.name === name);
      expect(e, `${name} in index.json`).toBeTruthy();
      const game = readFileSync(join(ASSETS, e!.path));
      const s = surfaces(game);
      expect(s.images.length, `${name} images`).toBe(3);
      expect(s.textures, `${name} textures`).toBe(3);
      expect(s.uvs.every(Boolean), `${name} TEXCOORD_0 on every primitive`).toBe(true);
      const { json } = parseGlb(game);
      const normal = json.textures[json.materials[0].normalTexture.index].source;
      expect(json.images[normal].mimeType, `${name} normal map`).toBe("image/png");
      for (const im of s.images) expect(im.size, `${name} ${im.mime} readable`).toBeTruthy();
      const lib = join(LIBRARY, e!.path);
      if (existsSync(lib)) expect(() => checkSurfaces(readFileSync(lib), game, name)).not.toThrow();
    }
  });

  it.skipIf(!assetIndex)("checkSurfaces throws on a copy that lost its images, or whose PNG bytes changed", async () => {
    await ready();
    const src = readFileSync(join(ASSETS, assetIndex!.assets.find((a) => a.name === "lantern")!.path));
    expect(() => checkSurfaces(src, compressGlb(src) ?? src, "lantern")).not.toThrow();
    const jl = src.readUInt32LE(12);
    const json = JSON.parse(src.subarray(20, 20 + jl).toString("utf8"));
    json.images = [];
    json.textures = [];
    const text = Buffer.from(JSON.stringify(json));
    const chunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const head = Buffer.from(src.subarray(0, 20));
    head.writeUInt32LE(chunk.length, 12);
    expect(() => checkSurfaces(src, Buffer.concat([head, chunk, src.subarray(20 + jl)]), "lantern")).toThrow(/lost its textures/);
    // a PNG byte flipped in place
    const png = parseGlb(src).json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/png");
    const bent = Buffer.from(src);
    const at = imageBytes(bent, png);
    at[at.length - 20] ^= 0xff;
    expect(() => checkSurfaces(src, bent, "lantern")).toThrow(/bytes changed/);
  });

  it.skipIf(!assetIndex)("jpegSize / pngSize read the vendored maps' sizes; a truncated JPEG doesn't parse", () => {
    const glb = readFileSync(join(ASSETS, assetIndex!.assets.find((a) => a.name === "noodle_shop")!.path));
    const { json } = parseGlb(glb);
    const jpeg = json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/jpeg");
    const png = json.images.findIndex((im: { mimeType: string }) => im.mimeType === "image/png");
    expect(jpeg).toBeGreaterThanOrEqual(0);
    const size = jpegSize(imageBytes(glb, jpeg));
    expect(size).toEqual(pngSize(imageBytes(glb, png))); // one atlas size for all three maps
    expect(jpegSize(imageBytes(glb, jpeg).subarray(0, 600))).toBeNull();
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
