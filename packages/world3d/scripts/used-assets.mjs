// The asset subset the game uses, shared by build.mjs and sync-assets.mjs: every asset /
// character / heldProp value anywhere in src/layout.json (the interiors) and src/town.json (the
// town outdoors: placements, walkers, pets; its `landscape` / `sky` GLBs too), plus the furniture
// slots of every shell (the same scan as layout.ts usedAssets).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Copies the used GLBs from `src` (an asset library dir with index.json) into `out`, with a trimmed index.json. `layoutPaths`: the layout files (layout.json, town.json). */
export function copyUsed(src, out, layoutPaths) {
  const index = JSON.parse(readFileSync(join(src, "index.json"), "utf8"));
  const layouts = layoutPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  const entries = usedEntries(index, layouts);
  rmSync(out, { recursive: true, force: true });
  for (const a of entries) {
    mkdirSync(join(out, dirname(a.path)), { recursive: true });
    copyFileSync(join(src, a.path), join(out, a.path));
  }
  writeFileSync(join(out, "index.json"), JSON.stringify({ frame: index.frame, axes: index.axes, assets: entries }));
  return entries.length;
}
