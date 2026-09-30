// Runtime atlas packing (src/atlas.ts) and the static families it feeds (world.ts
// StaticFamilies, mergeStatic): pages fit and are powers of two, padding repeats each image's
// border, UVs remap onto the page texel for texel, a packed page reproduces every source texel
// at the remapped UV, too much spills onto a second page, and a space's textured and flat
// surfaces merge into one draw per family with their colours per vertex, the see-through ids
// and the outline hulls carried through.
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ATLAS_PAD, blit, ORM_SCALE, packAtlas, packSources, remapUV, scaleRect, texelAt, type AtlasPageData, type PackItem, type PackRect } from "../src/atlas";
import { AssetCache, drawCalls, mergeStatic, packSpaceAtlas, StaticFamilies } from "../src/world";
import type { LayoutIndex } from "../src/layout";
import { isSeeThrough, SEE_ATTR, SEE_ID0, SEE_NEVER } from "../src/seethrough";

const isPot = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** A deterministic RGBA image, every texel distinct (its index in r / g, the seed in b). */
function image(w: number, h: number, seed: number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([i & 255, (i >> 8) & 255, seed & 255, 255], i * 4);
  return d;
}

/** Nearest-texel resample of RGBA rows (what the canvas reader returns, without smoothing). */
function resample(src: Uint8Array, sw: number, sh: number, w: number, h: number): Uint8Array {
  if (sw === w && sh === h) return src;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
      d.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * w + x) * 4);
    }
  return d;
}

const texel = (img: Uint8Array, w: number, x: number, y: number) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

function overlaps(a: PackRect, b: PackRect, pad: number) {
  return a.x - pad < b.x + b.w + pad && b.x - pad < a.x + a.w + pad && a.y - pad < b.y + b.h + pad && b.y - pad < a.y + a.h + pad;
}

describe("atlas packing", () => {
  const items: PackItem[] = [
    { key: "shop", w: 612, h: 612 },
    { key: "lantern", w: 108, h: 112 },
    { key: "stool", w: 68, h: 64 },
    { key: "bottle", w: 12, h: 12 },
    { key: "tall", w: 20, h: 828 },
    { key: "door", w: 236, h: 236 },
  ];

  it("fits every item on one power-of-two page, padded and aligned, none overlapping", () => {
    const { pages, rects, left } = packAtlas(items);
    expect(left).toEqual([]);
    expect(pages.length).toBe(1);
    expect(isPot(pages[0].w) && isPot(pages[0].h)).toBe(true);
    expect(pages[0].w).toBeLessThanOrEqual(2048);
    expect(rects.size).toBe(items.length);
    const all = [...rects.values()];
    for (const r of all) {
      // the image and its padding inside the page, the slot on even texels (the half-size ORM page)
      expect(r.x - ATLAS_PAD).toBeGreaterThanOrEqual(0);
      expect(r.y - ATLAS_PAD).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w + ATLAS_PAD).toBeLessThanOrEqual(pages[0].w);
      expect(r.y + r.h + ATLAS_PAD).toBeLessThanOrEqual(pages[0].h);
      expect(r.x % 2).toBe(0);
      expect(r.y % 2).toBe(0);
      for (const o of all) if (o !== r) expect(overlaps(r, o, ATLAS_PAD), `${r.key} / ${o.key}`).toBe(false);
    }
    // the smallest page that holds them: half of it in either direction would not
    const area = all.reduce((s, r) => s + (r.w + 2 * ATLAS_PAD) * (r.h + 2 * ATLAS_PAD), 0);
    expect(pages[0].w * pages[0].h).toBeLessThan(area * 4);
  });

  it("spills what doesn't fit one page onto a second; an item bigger than a page is left out", () => {
    const many: PackItem[] = [...Array(20).keys()].map((i) => ({ key: `b${i}`, w: 480, h: 480 })) // 16 slots of 496 a page;
    const { pages, rects, left } = packAtlas([...many, { key: "huge", w: 3000, h: 10 }]);
    expect(pages.length).toBe(2);
    expect(left.map((l) => l.key)).toEqual(["huge"]);
    expect(rects.size).toBe(20);
    for (const p of pages) expect(isPot(p.w) && isPot(p.h) && p.w <= 2048 && p.h <= 2048).toBe(true);
    const pageOf = [...rects.values()].map((r) => r.page);
    expect(new Set(pageOf)).toEqual(new Set([0, 1]));
    for (const a of rects.values()) for (const b of rects.values()) if (a !== b && a.page === b.page) expect(overlaps(a, b, ATLAS_PAD)).toBe(false);
    // the second page is only as big as its items need
    expect(pages[1].w * pages[1].h).toBeLessThan(2048 * 2048);
  });

  it("remaps a UV onto the page texel for texel (both ways), the half-size ORM rect the same UV", () => {
    const page = { w: 1024, h: 512 };
    const r: PackRect = { key: "a", page: 0, x: 40, y: 18, w: 100, h: 60 };
    for (const [i, j] of [
      [0, 0],
      [99, 59],
      [37, 12],
    ]) {
      const [u, v] = remapUV((i + 0.5) / r.w, (j + 0.5) / r.h, r, page);
      expect(u * page.w).toBeCloseTo(r.x + i + 0.5, 9);
      expect(v * page.h).toBeCloseTo(r.y + j + 0.5, 9);
      // round trip back to the item's own UV
      expect((u * page.w - r.x) / r.w).toBeCloseTo((i + 0.5) / r.w, 9);
      const o = scaleRect(r, ORM_SCALE);
      const [ou, ov] = remapUV((i + 0.5) / r.w, (j + 0.5) / r.h, o, { w: page.w * ORM_SCALE, h: page.h * ORM_SCALE });
      expect(ou).toBeCloseTo(u, 9);
      expect(ov).toBeCloseTo(v, 9);
    }
  });

  it("extends every edge into the padding (corners too): a mip read at the border sees the image's own colour", () => {
    const W = 32;
    const H = 32;
    const dst = new Uint8Array(W * H * 4);
    const src = image(6, 5, 7);
    blit(dst, W, H, src, 6, 5, 8, 10, 6, 5, 4);
    for (let y = 6; y < 19; y++)
      for (let x = 4; x < 18; x++) {
        const sx = Math.min(5, Math.max(0, x - 8));
        const sy = Math.min(4, Math.max(0, y - 10));
        expect(texel(dst, W, x, y), `${x},${y}`).toEqual(texel(src, 6, sx, sy));
      }
    // nothing outside the padding
    expect(texel(dst, W, 3, 10)).toEqual([0, 0, 0, 0]);
    expect(texel(dst, W, 18, 10)).toEqual([0, 0, 0, 0]);
    expect(texel(dst, W, 10, 5)).toEqual([0, 0, 0, 0]);
  });

  it("a packed page reproduces each source texel at the remapped UV (base colour and ORM)", () => {
    const sizes: [number, number][] = [
      [64, 48],
      [30, 30],
      [128, 20],
      [12, 12],
    ];
    const sources = sizes.map(([w, h], i) => ({ key: `s${i}`, base: { data: image(w, h, i), w, h }, bw: w, bh: h, orm: { data: image(w / 2, h / 2, 100 + i), w: w / 2, h: h / 2 } }));
    const out = { pages: [] as AtlasPageData[], rects: new Map<string, PackRect>() };
    const steps = [...packSources(sources, (img, w, h) => resample(img.data, img.w, img.h, w, h), out)];
    expect(steps.length).toBeGreaterThan(sources.length); // one step per read / blit: sliceable
    expect(out.pages.length).toBe(1);
    const p = out.pages[0];
    expect([p.ow, p.oh]).toEqual([p.w / 2, p.h / 2]);
    for (const s of sources) {
      const r = out.rects.get(s.key)!;
      for (let y = 0; y < s.bh; y++)
        for (let x = 0; x < s.bw; x++) {
          const [u, v] = remapUV((x + 0.5) / s.bw, (y + 0.5) / s.bh, r, p);
          expect(texelAt(p.base, p.w, p.h, u, v)).toEqual(texel(s.base.data, s.bw, x, y));
        }
      for (let y = 0; y < s.orm.h; y++)
        for (let x = 0; x < s.orm.w; x++) {
          const [u, v] = remapUV((x + 0.5) / s.orm.w, (y + 0.5) / s.orm.h, r, p);
          expect(texelAt(p.orm, p.ow, p.oh, u, v)).toEqual(texel(s.orm.data, s.orm.w, x, y));
        }
      // UV 0 / 1 (a face's corner) reads the border texel, via the padding
      const [u1, v1] = remapUV(1, 1, r, p);
      expect(texelAt(p.base, p.w, p.h, u1, v1)).toEqual(texel(s.base.data, s.bw, s.bw - 1, s.bh - 1));
      const [u0, v0] = remapUV(0, 0, r, p);
      expect(texelAt(p.base, p.w, p.h, u0 - 1e-6, v0 - 1e-6)).toEqual(texel(s.base.data, s.bw, 0, 0));
    }
  });
});

describe("static families: one draw per atlas page and family", () => {
  /** A DataTexture as GLTFLoader hands a textured asset's atlas on: UV 0, not flipped. */
  const tex = (w: number, h: number, seed: number, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.DataTexture(image(w, h, seed), w, h);
    t.colorSpace = colorSpace;
    t.needsUpdate = true;
    return t;
  };
  const read = (t: THREE.Texture, w: number, h: number) => {
    const img = t.image as { data: Uint8Array; width: number; height: number };
    return resample(img.data, img.width, img.height, w, h);
  };
  /** a quad with UVs inside [0, 1] (not just the corners), off texel edges on both test atlases */
  const quad = () => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0.1875, 0.21875, 0.8125, 0.28125, 0.0625, 0.78125, 0.6875, 0.96875]), 2));
    return g;
  };

  async function build() {
    const cache = new AssetCache("", {} as LayoutIndex);
    const toon = cache.toon;
    const baseA = tex(40, 40, 1, THREE.SRGBColorSpace);
    const ormA = tex(20, 20, 2, THREE.NoColorSpace);
    const baseB = tex(24, 16, 3, THREE.SRGBColorSpace);
    const ormB = tex(12, 8, 4, THREE.NoColorSpace);
    const src = (name: string, hex: number, map?: THREE.Texture, ao?: THREE.Texture) => new THREE.MeshStandardMaterial({ name, color: hex, map: map ?? null, aoMap: ao ?? null, side: THREE.DoubleSide });
    const roots: THREE.Object3D[] = [];
    const add = (name: string, id: number, x: number, mats: THREE.MeshStandardMaterial[]) => {
      const root = new THREE.Group();
      root.name = name;
      root.position.x = x;
      for (const m of mats) root.add(new THREE.Mesh(quad(), m));
      toon.apply(root, true);
      root.userData.see = { tag: id };
      roots.push(root);
      return root;
    };
    // two assets with their own atlases, several palette colours each, plus flat pieces and glass
    add("shopA", SEE_ID0, 0, [src("brick", 0xaa3322, baseA, ormA), src("wood", 0x664422, baseA, ormA), src("slate", 0x223344)]);
    add("shopB", SEE_ID0 + 1, 3, [src("metal", 0x8899aa, baseB, ormB), src("paper", 0xffeecc, baseB, ormB), src("concrete", 0x777066), src("glass", 0x88aacc)]);
    add("ground", SEE_NEVER, -3, [src("slate", 0x223344), src("concrete", 0x777066), src("glass", 0x88aacc)]);
    const scene = new THREE.Scene();
    scene.add(...roots);
    const atlas = await packSpaceAtlas(roots, read);
    const before = drawCalls(scene);
    mergeStatic(scene, roots, new StaticFamilies(toon, atlas));
    return { scene, atlas: atlas!, before, textures: { baseA, ormA, baseB, ormB } };
  }

  it("packs both assets' atlases into one page and merges every textured colour into one draw", async () => {
    const { scene, atlas, before, textures } = await build();
    expect(atlas.pages.length).toBe(1);
    expect(atlas.rects.size).toBe(2);
    const page = atlas.pages[0];
    expect([page.orm.image.width, page.orm.image.height]).toEqual([page.w / 2, page.h / 2]);
    expect(page.base.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(page.orm.colorSpace).toBe(THREE.NoColorSpace);
    expect(page.base.generateMipmaps).toBe(true);
    expect(page.base.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(atlas.sources).toEqual(new Set(Object.values(textures)));
    const batches = scene.children.filter((c) => c.name.startsWith("batch:")) as THREE.Mesh[];
    const textured = batches.filter((b) => (b.material as THREE.MeshToonMaterial).map === page.base);
    expect(textured.length).toBe(1);
    const t = textured[0];
    const mat = t.material as THREE.MeshToonMaterial;
    // a plain toon material: the page as map + aoMap, white, colours per vertex, see-through patched
    expect(mat.isMeshToonMaterial).toBe(true);
    expect(mat.aoMap).toBe(page.orm);
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    expect(isSeeThrough(mat)).toBe(true);
    expect((t.userData.parts as { material: string }[]).map((p) => p.material).sort()).toEqual(["brick", "metal", "paper", "wood"]);
    // flat pieces: one draw for every colour (no UVs kept); the glass (found by name) on its own
    const flat = batches.find((b) => b.name === "batch:flat")!;
    expect(flat.geometry.hasAttribute("uv")).toBe(false);
    expect((flat.userData.parts as { material: string }[]).map((p) => p.material).sort()).toEqual(["concrete", "concrete", "slate", "slate"]);
    expect(batches.find((b) => b.name === "batch:glass")).toBeTruthy();
    // hulls: one batch, their push-out normals and see-through tags intact
    const hulls = batches.filter((b) => b.userData.outline);
    expect(hulls.length).toBe(1);
    expect(hulls[0].geometry.hasAttribute("hullNormal")).toBe(true);
    expect(hulls[0].geometry.hasAttribute(SEE_ATTR)).toBe(true);
    // 3 roots x their meshes + hulls -> textured, flat, glass, hulls
    expect(drawCalls(scene)).toBe(4);
    expect(before).toBe(20);
  });

  it("carries colour, see-through ids and texels through: the page at each remapped UV is the source's texel", async () => {
    const { scene, atlas, textures } = await build();
    const page = atlas.pages[0];
    const t = scene.children.find((c) => (c as THREE.Mesh).isMesh && ((c as THREE.Mesh).material as THREE.MeshToonMaterial).map === page.base) as THREE.Mesh;
    const g = t.geometry;
    const uv = g.getAttribute("uv");
    const col = g.getAttribute("color");
    const see = g.getAttribute(SEE_ATTR);
    const src = quad().getAttribute("uv");
    const colours: Record<string, [number, number, number, THREE.DataTexture, number]> = { brick: [0xaa3322, 0, 0, textures.baseA, SEE_ID0], wood: [0x664422, 0, 0, textures.baseA, SEE_ID0], metal: [0x8899aa, 0, 0, textures.baseB, SEE_ID0 + 1], paper: [0xffeecc, 0, 0, textures.baseB, SEE_ID0 + 1] };
    const data = page.base.image.data as Uint8Array;
    for (const p of t.userData.parts as { material: string; first: number; count: number }[]) {
      const [hex, , , base, id] = colours[p.material];
      const c = new THREE.Color(hex);
      const img = base.image as { data: Uint8Array; width: number; height: number };
      for (let i = 0; i < p.count; i++) {
        const k = p.first + i;
        expect([col.getX(k), col.getY(k), col.getZ(k)]).toEqual([c.r, c.g, c.b].map((x) => Math.fround(x)));
        expect(see.getX(k)).toBe(id);
        const su = src.getX(i);
        const sv = src.getY(i);
        const sx = Math.min(img.width - 1, Math.floor(su * img.width));
        const sy = Math.min(img.height - 1, Math.floor(sv * img.height));
        expect(texelAt(data, page.w, page.h, uv.getX(k), uv.getY(k))).toEqual(texel(img.data, img.width, sx, sy));
      }
    }
  });

  it("without images (node, the tests' GLBs) the flat families still merge and nothing is packed", async () => {
    const cache = new AssetCache("", {} as LayoutIndex);
    const make = () =>
      [0xff0000, 0x00ff00, 0x0000ff].map((hex, i) => {
        const r = new THREE.Group();
        r.add(new THREE.Mesh(quad(), new THREE.MeshStandardMaterial({ color: hex, name: `c${i}` })));
        cache.toon.apply(r, false);
        r.userData.see = { tag: SEE_ID0 + i };
        return r;
      });
    const roots = make();
    expect(await packSpaceAtlas(roots)).toBeNull();
    const scene = new THREE.Scene();
    scene.add(...roots);
    mergeStatic(scene, roots, new StaticFamilies(cache.toon, null));
    expect(drawCalls(scene)).toBe(1);
    // without families (mergeStatic's own call) each colour stays its own draw
    const plain = make();
    const scene2 = new THREE.Scene();
    scene2.add(...plain);
    mergeStatic(scene2, plain);
    expect(drawCalls(scene2)).toBe(3);
  });
});

describe("static families in the real look: the tiling detail rides along", () => {
  it("textured members keep their detail kind: one family per (page, detail), each patched like Toon.material's", async () => {
    vi.resetModules();
    vi.doMock("../src/look", async (orig) => ({ ...(await orig<typeof import("../src/look")>()), LOOK: { real: true, ramp: false } }));
    try {
      const world = await import("../src/world");
      const { DETAIL_KEY } = await import("../src/detail");
      const cache = new world.AssetCache("", {} as LayoutIndex);
      const mk = (w: number, h: number, seed: number, cs: THREE.ColorSpace) => {
        const t = new THREE.DataTexture(image(w, h, seed), w, h);
        t.colorSpace = cs;
        return t;
      };
      const base = mk(32, 32, 1, THREE.SRGBColorSpace);
      const orm = mk(16, 16, 2, THREE.NoColorSpace);
      const src = (name: string, hex: number) => new THREE.MeshStandardMaterial({ name, color: hex, map: base, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1 });
      const root = new THREE.Group();
      for (const [n, c] of [["brick", 0xaa3322], ["brick", 0xaa3322], ["wood", 0x664422], ["wood_dark", 0x332211]] as const) root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), src(n, c)));
      cache.toon.apply(root, false, false, { set: "buildings", asset: "noodle_shop" });
      root.userData.see = { tag: SEE_ID0 };
      const scene = new THREE.Scene();
      scene.add(root);
      const read = (t: THREE.Texture, w: number, h: number) => {
        const img = t.image as { data: Uint8Array; width: number; height: number };
        return resample(img.data, img.width, img.height, w, h);
      };
      const atlas = await world.packSpaceAtlas([root], read);
      expect(atlas).not.toBeNull();
      world.mergeStatic(scene, [root], new world.StaticFamilies(cache.toon, atlas));
      const batches = scene.children.filter((c) => c.name.startsWith("batch:")) as THREE.Mesh[];
      // brick and wood (wood + wood_dark share the wood detail): two draws
      expect(batches.map((b) => b.name).sort()).toEqual(["batch:atlas_0_brick_front", "batch:atlas_0_wood_front"]);
      for (const b of batches) {
        const m = b.material as THREE.MeshStandardMaterial;
        expect(m.isMeshStandardMaterial).toBe(true);
        expect(m.map).toBe(atlas!.pages[0].base);
        expect(m.roughnessMap).toBe(atlas!.pages[0].orm);
        expect(m.userData.detail.kind).toBe(b.name.includes("brick") ? "brick" : "wood");
        expect(m.customProgramCacheKey()).toBe(`see-through-objects|${DETAIL_KEY}`);
        const sh = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
        m.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
        expect(sh.fragmentShader).toContain("stSeeThrough();");
        expect(sh.fragmentShader).toContain("dtMul");
      }
    } finally {
      vi.doUnmock("../src/look");
      vi.resetModules();
    }
  });
});

describe("an evicted space's atlas (prefetch.ts evict -> SceneSpace.dispose -> AssetCache.dropAtlas)", () => {
  it("drops that space's pages and family materials only; the space packs again when rebuilt", async () => {
    const cache = new AssetCache("", {} as LayoutIndex);
    const space = async (seed: number) => {
      const t = new THREE.DataTexture(image(16, 16, seed), 16, 16);
      const root = new THREE.Group();
      for (const hex of [0x112233, 0x445566]) root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: hex, map: t })));
      cache.toon.apply(root, false);
      root.userData.see = { tag: SEE_ID0 };
      const read = (x: THREE.Texture, w: number, h: number) => resample((x.image as { data: Uint8Array }).data, 16, 16, w, h);
      const atlas = (await packSpaceAtlas([root], read))!;
      const scene = new THREE.Scene();
      scene.add(root);
      mergeStatic(scene, [root], new StaticFamilies(cache.toon, atlas));
      const mat = (scene.children.find((c) => c.name.startsWith("batch:atlas")) as THREE.Mesh).material as THREE.Material;
      return { atlas, mat };
    };
    const a = await space(1);
    const b = await space(2);
    const atlases = (cache as unknown as { atlases: Map<string, Promise<unknown>> }).atlases;
    atlases.set("a", Promise.resolve(a.atlas));
    atlases.set("b", Promise.resolve(b.atlas));
    const disposed = new Set<object>();
    for (const x of [a.atlas.pages[0].base, a.atlas.pages[0].orm, b.atlas.pages[0].base, b.atlas.pages[0].orm, a.mat, b.mat]) x.addEventListener("dispose", () => disposed.add(x));
    await cache.dropAtlas("a");
    expect(disposed).toEqual(new Set([a.atlas.pages[0].base, a.atlas.pages[0].orm, a.mat]));
    expect(atlases.has("a")).toBe(false);
    expect(atlases.has("b")).toBe(true);
    // b's family material is still the one handed out for its page
    const fam = cache.toon.family({ key: `family|${b.atlas.pages[0].base.uuid}|0|0.8|0|1|`, name: "x", side: THREE.FrontSide, roughness: 0.8, metalness: 0, aoMapIntensity: 1, page: null });
    expect(fam).toBe(b.mat);
    // asked again, the space packs anew (node: nothing to read, so null) instead of reusing the dropped pages
    expect(await cache.spaceAtlas("a", [])).toBeNull();
  });
});
