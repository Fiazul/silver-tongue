// The asset subset the game uses, shared by build.mjs and sync-assets.mjs: every asset /
// character / heldProp value anywhere in src/layout.json (the interiors) and src/town.json (the
// town outdoors: placements, walkers, pets; its `landscape` / `sky` GLBs too), plus the furniture
// slots of every shell (the same scan as layout.ts usedAssets).
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jpegTextures } from "./textures.mjs";

/** scripts/meshopt.mjs, or null when meshoptimizer isn't installed (then the GLBs ship as they are). */
async function meshopt() {
  try {
    const m = await import("./meshopt.mjs");
    await m.ready();
    return m;
  } catch (e) {
    console.warn(`meshopt: ${e.message}; GLBs copied uncompressed`);
    return null;
  }
}

/** The index.json entries the layout uses; throws when the layout names an asset the index lacks. */
export function usedEntries(index, layout) {
  const used = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "asset" || k === "character" || k === "heldProp" || k === "sky") && typeof x === "string") used.add(x);
      else if (k === "landscape" && Array.isArray(x)) x.forEach((n) => used.add(n));
      else walk(x);
    }
  };
  walk(layout);
  for (const name of [...used]) {
    const slots = index.assets.find((a) => a.name === name)?.anchors?.furniture_slots ?? [];
    for (const s of slots) used.add(s.asset);
  }
  const entries = index.assets.filter((a) => used.has(a.name));
  const missing = [...used].filter((n) => !entries.some((a) => a.name === n));
  if (missing.length) throw new Error(`the layout uses assets not in index.json: ${missing.join(", ")}`);
  return entries;
}

/**
 * Copies the used GLBs from `src` (an asset library dir with index.json) into `out`, meshopt-compressed
 * (scripts/meshopt.mjs; one already compressed is copied as is), with a trimmed index.json whose
 * entries carry each file's `bytes` (the loading screen's sizes). `layoutPaths`: the layout files
 * (layout.json, town.json). Returns the number of GLBs.
 */
export async function copyUsed(src, out, layoutPaths) {
  const index = JSON.parse(readFileSync(join(src, "index.json"), "utf8"));
  const layouts = layoutPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  const entries = usedEntries(index, layouts);
  rmSync(out, { recursive: true, force: true });
  const mo = await meshopt();
  const shipped = [];
  for (const a of entries) {
    mkdirSync(join(out, dirname(a.path)), { recursive: true });
    const to = join(out, a.path);
    shipped.push(copyGlb(mo, src, out, a));
  }
  writeFileSync(join(out, "index.json"), JSON.stringify({ frame: index.frame, axes: index.axes, assets: shipped }));
  return entries.length;
}

/**
 * One GLB from `src` to `out` (same relative path): base colour / ORM PNGs as JPEG
 * (scripts/textures.mjs), then meshopt-compressed when it can be, its textures and UVs checked
 * kept (scripts/meshopt.mjs checkSurfaces); its index entry with `bytes`.
 */
function copyGlb(mo, src, out, a) {
  const to = join(out, a.path);
  const raw = readFileSync(join(src, a.path));
  const jpeg = jpegTextures(raw, a.path);
  const packed = mo?.compressGlb(jpeg) ?? (jpeg !== raw ? jpeg : null);
  if (packed) {
    mo?.checkSurfaces(raw, packed, a.path);
    writeFileSync(to, packed);
  } else copyFileSync(join(src, a.path), to);
  return { ...a, bytes: statSync(to).size };
}

/**
 * Refreshes only the named GLBs in the vendored `out` from the library `src` (and their index.json
 * entries, added when new), leaving every other file as it is: for bringing in one rebuilt batch
 * (the textured assets) without taking the rest of a library that has moved on. Returns the entries.
 */
export async function refreshNamed(src, out, names) {
  const index = JSON.parse(readFileSync(join(src, "index.json"), "utf8"));
  const vendored = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  const mo = await meshopt();
  const done = [];
  for (const name of names) {
    const a = index.assets.find((e) => e.name === name);
    if (!a) throw new Error(`refresh: ${name} is not in ${join(src, "index.json")}`);
    mkdirSync(join(out, dirname(a.path)), { recursive: true });
    const entry = copyGlb(mo, src, out, a);
    const at = vendored.assets.findIndex((e) => e.name === name);
    if (at >= 0) vendored.assets[at] = entry;
    else vendored.assets.push(entry);
    done.push(entry);
  }
  writeFileSync(join(out, "index.json"), JSON.stringify(vendored));
  return done;
}
