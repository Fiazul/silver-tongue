// Runtime texture atlases for the static world (README "Textured assets", "Draw calls"): every
// textured asset carries its own base-colour + ORM atlas (docs/asset-conventions.md "Textures"),
// so a space packs the ones its static meshes use into one power-of-two page (base colour up to
// 2048², ORM at half resolution with the same layout: one UV set serves both) and its static
// textured meshes merge into one draw per page and material family (world.ts mergeStatic).
//
// Pure parts (node-testable): shelf packing with padding, the UV remap, the pixel blit with edge
// extension (the padding repeats each image's border so mip levels don't bleed a neighbour in).
// The browser part reads the decoded images through a 2D canvas.

/** One image to place: `w` x `h` base-colour texels. */
export interface PackItem {
  key: string;
  w: number;
  h: number;
}

/** Where an item landed: its image's top-left texel (inside the padding) on page `page`. */
export interface PackRect extends PackItem {
  page: number;
  x: number;
  y: number;
}

export interface PackPage {
  w: number;
  h: number;
}

export interface PackOptions {
  /** the largest page side (power of two) */
  max?: number;
  /** texels of edge extension round every image (base colour; ORM gets half) */
  pad?: number;
  /** every slot starts on a multiple of this (2: the half-size ORM page keeps whole texels) */
  align?: number;
  /** the smallest page side tried */
  min?: number;
}

/** Base-colour page limit; ORM pages are half this. */
export const ATLAS_MAX = 2048;
/**
 * Padding in base-colour texels: 8 there is 4 on the half-size ORM page, so both keep at least 4
 * texels of edge extension (clean through mip level 2).
 */
export const ATLAS_PAD = 8;
/** ORM page (and rect) scale against the base-colour page */
export const ORM_SCALE = 0.5;

const pot = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const up = (n: number, a: number) => Math.ceil(n / a) * a;

/** Slot size of an item (image + padding both sides), aligned. */
function slot(it: PackItem, pad: number, align: number): [number, number] {
  return [up(it.w + 2 * pad, align), up(it.h + 2 * pad, align)];
}

/** Sorted tallest first (then widest, then key: deterministic). */
function order(items: PackItem[]): PackItem[] {
  return [...items].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Shelf-packs `items` (already ordered) into one W x H page: rows left to right, a new row under
 * the tallest of the last. Returns what was placed; the rest didn't fit.
 */
function shelf(items: PackItem[], W: number, H: number, pad: number, align: number): { placed: Omit<PackRect, "page">[]; rest: PackItem[] } {
  const placed: Omit<PackRect, "page">[] = [];
  const rest: PackItem[] = [];
  let x = 0;
  let y = 0;
  let row = 0;
  for (const it of items) {
    const [sw, sh] = slot(it, pad, align);
    if (sw > W || sh > H) {
      rest.push(it);
      continue;
    }
    if (x + sw > W) {
      y += row;
      x = 0;
      row = 0;
    }
    if (y + sh > H) {
      rest.push(it);
      continue;
    }
    placed.push({ ...it, x: x + pad, y: y + pad });
    x += sw;
    row = Math.max(row, sh);
  }
  return { placed, rest };
}

/** The smallest power-of-two page (by area, then squarer) that holds every item, or null past `max`. */
function smallestPage(items: PackItem[], max: number, min: number, pad: number, align: number): { page: PackPage; placed: Omit<PackRect, "page">[] } | null {
  const sides: number[] = [];
  for (let s = min; s <= max; s *= 2) sides.push(s);
  const sizes = sides.flatMap((w) => sides.map((h) => ({ w, h }))).filter((p) => p.w >= p.h && p.w <= p.h * 2);
  sizes.sort((a, b) => a.w * a.h - b.w * b.h || a.w - b.w);
  const area = items.reduce((s, it) => {
    const [w, h] = slot(it, pad, align);
    return s + w * h;
  }, 0);
  for (const p of sizes) {
    if (p.w * p.h < area) continue;
    const r = shelf(items, p.w, p.h, pad, align);
    if (!r.rest.length) return { page: p, placed: r.placed };
  }
  return null;
}

/**
 * Packs images into as few power-of-two pages as fit (each at most `max` a side), each page as
 * small as holds its items. An item too big for an empty page is left out (the caller keeps it
 * on its own texture).
 */
export function packAtlas(items: PackItem[], opts: PackOptions = {}): { pages: PackPage[]; rects: Map<string, PackRect>; left: PackItem[] } {
  const max = opts.max ?? ATLAS_MAX;
  const pad = opts.pad ?? ATLAS_PAD;
  const align = opts.align ?? 2;
  const min = Math.min(max, opts.min ?? 64);
  const pages: PackPage[] = [];
  const rects = new Map<string, PackRect>();
  const left: PackItem[] = [];
  let todo = order(items.filter((it, i) => items.findIndex((o) => o.key === it.key) === i));
  while (todo.length) {
    const fit = smallestPage(todo, max, min, pad, align);
    if (fit) {
      for (const r of fit.placed) rects.set(r.key, { ...r, page: pages.length });
      pages.push(fit.page);
      break;
    }
    // more than one full page: fill one, then the rest again
    const r = shelf(todo, max, max, pad, align);
    if (!r.placed.length) {
      left.push(...r.rest);
      break;
    }
    const tight = smallestPage(order(r.placed), max, min, pad, align);
    const placed = tight?.placed ?? r.placed;
    for (const p of placed) rects.set(p.key, { ...p, page: pages.length });
    pages.push(tight?.page ?? { w: max, h: max });
    // an item that can't fit even an empty page drops out, the others go round again
    const tooBig = (it: PackItem) => {
      const [w, h] = slot(it, pad, align);
      return w > max || h > max;
    };
    left.push(...r.rest.filter(tooBig));
    todo = order(r.rest.filter((it) => !tooBig(it)));
  }
  return { pages, rects, left };
}

/**
 * Maps a UV on the item's own texture to the page's: texel centre i + 0.5 of the item lands on
 * texel centre x + i + 0.5 of the page, the same for the half-size ORM page (every coordinate halves).
 */
export function remapUV(u: number, v: number, r: PackRect, page: PackPage): [number, number] {
  return [(r.x + u * r.w) / page.w, (r.y + v * r.h) / page.h];
}

/** Remaps a UV array (itemSize 2) in place. */
export function remapUVs(uv: Float32Array, r: PackRect, page: PackPage): Float32Array {
  for (let i = 0; i < uv.length; i += 2) {
    const [u, v] = remapUV(uv[i], uv[i + 1], r, page);
    uv[i] = u;
    uv[i + 1] = v;
  }
  return uv;
}

/** A rect scaled (the ORM page's copy of a base-colour rect). */
export function scaleRect(r: PackRect, k: number): PackRect {
  return { ...r, x: Math.round(r.x * k), y: Math.round(r.y * k), w: Math.max(1, Math.round(r.w * k)), h: Math.max(1, Math.round(r.h * k)) };
}

/**
 * Copies an RGBA image (`sw` x `sh`, rows top first, as a canvas reads it) into the page at
 * (x, y) as `w` x `h` (nearest texel when the sizes differ), then extends its edges `pad` texels
 * out on every side (corners too): the padding repeats the border, so a filtered or mipmapped
 * read at the rect's edge sees the image's own colour, never a neighbour's.
 */
export function blit(dst: Uint8Array | Uint8ClampedArray, dstW: number, dstH: number, src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, x: number, y: number, w: number, h: number, pad: number) {
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >> 2);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
  const same = sw === w && sh === h;
  const x0 = Math.max(0, x - pad);
  const x1 = Math.min(dstW, x + w + pad);
  for (let j = -pad; j < h + pad; j++) {
    const py = y + j;
    if (py < 0 || py >= dstH) continue;
    const jj = Math.min(h - 1, Math.max(0, j));
    const sy = same ? jj : Math.min(sh - 1, Math.floor(((jj + 0.5) * sh) / h));
    const row = py * dstW;
    const srow = sy * sw;
    if (same) d32.set(s32.subarray(srow, srow + w), row + x);
    else for (let i = 0; i < w; i++) d32[row + x + i] = s32[srow + Math.min(sw - 1, Math.floor(((i + 0.5) * sw) / w))];
    const left = d32[row + x];
    const right = d32[row + x + w - 1];
    for (let px = x0; px < x; px++) d32[row + px] = left;
    for (let px = x + w; px < x1; px++) d32[row + px] = right;
  }
}

/** Fills a rect (and its padding) with one RGBA colour: a source with no ORM map reads (1, 1, 1): the factors alone. */
export function fill(dst: Uint8Array | Uint8ClampedArray, dstW: number, dstH: number, rgba: [number, number, number, number], x: number, y: number, w: number, h: number, pad: number) {
  for (let py = Math.max(0, y - pad); py < Math.min(dstH, y + h + pad); py++)
    for (let px = Math.max(0, x - pad); px < Math.min(dstW, x + w + pad); px++) dst.set(rgba, (py * dstW + px) * 4);
}

/** The RGBA texel of a page at a UV (nearest), for tests and checks. */
export function texelAt(page: Uint8Array | Uint8ClampedArray, W: number, H: number, u: number, v: number): number[] {
  const x = Math.min(W - 1, Math.floor(u * W));
  const y = Math.min(H - 1, Math.floor(v * H));
  const o = (y * W + x) * 4;
  return [page[o], page[o + 1], page[o + 2], page[o + 3]];
}

/** One source to pack: its base-colour image (`bw` x `bh`) and its ORM image (any size: drawn at half the rect), or none (reads (1, 1, 1)). */
export interface AtlasSource<I> {
  key: string;
  base: I;
  bw: number;
  bh: number;
  orm: I | null;
}

/** A packed page: base colour `w` x `h`, ORM `ow` x `oh` (half), RGBA rows top first. */
export interface AtlasPageData {
  w: number;
  h: number;
  base: Uint8Array;
  ow: number;
  oh: number;
  orm: Uint8Array;
}

export interface PackedAtlas {
  pages: AtlasPageData[];
  /** by source key; a source too big for a page has none (it keeps its own textures) */
  rects: Map<string, PackRect>;
}

/**
 * Packs the sources' images into pages: `read(image, w, h)` returns an image's RGBA drawn at
 * `w` x `h` (the browser: a 2D canvas, readImage). A generator: one step per image read and per
 * blit, so a caller (sliced) can spread the work over frames. The result fills `out`.
 */
export function* packSources<I>(sources: AtlasSource<I>[], read: (image: I, w: number, h: number) => Uint8Array | Uint8ClampedArray, out: PackedAtlas, opts: PackOptions = {}): Generator<void> {
  const pad = opts.pad ?? ATLAS_PAD;
  const opad = Math.max(1, Math.round(pad * ORM_SCALE));
  const { pages, rects } = packAtlas(
    sources.map((s) => ({ key: s.key, w: s.bw, h: s.bh })),
    opts,
  );
  for (const p of pages) {
    const ow = Math.max(1, Math.round(p.w * ORM_SCALE));
    const oh = Math.max(1, Math.round(p.h * ORM_SCALE));
    out.pages.push({ w: p.w, h: p.h, base: new Uint8Array(p.w * p.h * 4), ow, oh, orm: new Uint8Array(ow * oh * 4) });
  }
  for (const s of sources) {
    const r = rects.get(s.key);
    if (!r) continue;
    const page = out.pages[r.page];
    const px = read(s.base, r.w, r.h);
    yield;
    blit(page.base, page.w, page.h, px, r.w, r.h, r.x, r.y, r.w, r.h, pad);
    yield;
    const o = scaleRect(r, ORM_SCALE);
    if (s.orm) {
      const opx = read(s.orm, o.w, o.h);
      yield;
      blit(page.orm, page.ow, page.oh, opx, o.w, o.h, o.x, o.y, o.w, o.h, opad);
    } else fill(page.orm, page.ow, page.oh, [255, 255, 255, 255], o.x, o.y, o.w, o.h, opad);
    yield;
    out.rects.set(s.key, r);
  }
}

type Drawable = CanvasImageSource & { width: number; height: number };

let reader: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null = null;

/** Whether this runtime can read a decoded image's texels (a browser: a 2D canvas); node can't. */
export function canReadImages(): boolean {
  try {
    if (typeof OffscreenCanvas !== "undefined") return !!new OffscreenCanvas(1, 1).getContext("2d");
    return typeof document !== "undefined" && !!document.createElement("canvas").getContext?.("2d");
  } catch {
    return false;
  }
}

/** A decoded image (ImageBitmap, <img>, canvas) as RGBA rows, top first, drawn at `w` x `h`. */
export function readImage(image: Drawable, w: number, h: number): Uint8ClampedArray {
  if (!reader) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("atlas: no 2D canvas");
    reader = { canvas, ctx };
  }
  const { canvas, ctx } = reader;
  if (canvas.width < w || canvas.height < h) {
    canvas.width = Math.max(canvas.width, w);
    canvas.height = Math.max(canvas.height, h);
  }
  ctx.globalCompositeOperation = "copy";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Runs `steps` in slices of at most `budgetMs` (a macrotask between slices: the page keeps drawing). */
export async function sliced(steps: Iterable<unknown>, budgetMs = 4): Promise<void> {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let start = now();
  for (const _ of steps) {
    if (now() - start >= budgetMs) {
      await new Promise((r) => setTimeout(r, 0));
      start = now();
    }
  }
}
