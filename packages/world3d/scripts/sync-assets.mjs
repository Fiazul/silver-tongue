// Refreshes the vendored assets/ from the make-it-in-china asset library: the town's sources
// (town_layout/town.json and the walk grid it names), then src/town.json ported from them
// (scripts/port-town.mjs), then only the GLBs src/layout.json and src/town.json use, meshopt-
// compressed on the way (scripts/meshopt.mjs), plus an index.json listing only those (with each
// file's bytes); the music, ambience and effects (audio/: every .ogg and .m4a in
// the library's manifest.json, and the manifest); and the title screen's backdrop (ui/title/: the
// fly-over's frames TITLE_FRAMES as JPEG q80, at most 1280 px wide, via Pillow). Run after the
// library is rebuilt (tools/blender/build_all.py, tools/blender/town_layout.py,
// tools/audio/make_audio.py) or a layout starts using a new asset:
//
//   npm run assets:sync -w @silver-tongue/world3d      (WORLD3D_ASSETS=... to point elsewhere)
//
// The library defaults to ../assets next to the repo checkout (the make-it-in-china layout).
//
//   npm run assets:sync -w @silver-tongue/world3d -- --only noodle_shop,lantern,...
//
// refreshes just those GLBs and their index.json entries (added when new), nothing else: one
// rebuilt batch (e.g. the textured assets) without the rest of a library that has moved on.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portTown, readTownSources, townJsonText } from "./port-town.mjs";
import { copyUsed, refreshNamed } from "./used-assets.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.WORLD3D_ASSETS ?? join(here, "..", "..", "..", "assets");
const out = join(here, "assets");
if (!existsSync(join(src, "index.json"))) throw new Error(`no asset library at ${src} (set WORLD3D_ASSETS)`);

const only = process.argv.indexOf("--only");
if (only >= 0) {
  const names = (process.argv[only + 1] ?? "").split(",").filter(Boolean);
  if (!names.length) throw new Error("--only wants a comma-separated list of asset names");
  for (const e of await refreshNamed(src, out, names)) console.log(`refreshed packages/world3d/assets/${e.path} (${(e.bytes / 1024).toFixed(0)} KB)`);
  process.exit(0);
}

// Prune audio that the authoritative manifest no longer ships before copyUsed refreshes assets/.
const manifest = JSON.parse(readFileSync(join(src, "audio", "manifest.json"), "utf8"));
const audioFiles = new Set(
  manifest.flatMap((e) => [e.file_ogg, e.file_m4a, e.metadata]).filter(Boolean).map((f) => f.replace(/^assets\//, "")),
);
for (const kind of ["music", "ambient", "sfx"]) {
  const dir = join(out, "audio", kind);
  if (!existsSync(dir)) continue;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile()) continue;
    const rel = join("audio", kind, item.name);
    if (audioFiles.has(rel)) continue;
    rmSync(join(out, rel));
    console.log(`pruned packages/world3d/assets/${rel}`);
  }
}

// The town first: its port decides which GLBs the outdoors uses.
const { town, grid, index } = readTownSources(src);
const ported = portTown(town, grid, index);
writeFileSync(join(here, "src", "town.json"), townJsonText(ported));

const n = await copyUsed(src, out, [join(here, "src", "layout.json"), join(here, "src", "town.json")]);
// The town's sources, so `npm run port-town` and the staleness test run from the repo alone.
const townFiles = [join("town_layout", "town.json"), town.walkable.grid.replace(/\.json$/, "") + ".json"];
for (const f of townFiles) {
  mkdirSync(join(out, dirname(f)), { recursive: true });
  copyFileSync(join(src, f), join(out, f));
}
// Music, ambience, effects: every file named by the manifest (the build decides what ships).
for (const e of manifest)
  for (const f of [e.file_ogg, e.file_m4a, e.metadata]) {
    if (!f) continue;
    const rel = f.replace(/^assets\//, "");
    mkdirSync(join(out, dirname(rel)), { recursive: true });
    copyFileSync(join(src, rel), join(out, rel));
  }
copyFileSync(join(src, "audio", "manifest.json"), join(out, "audio", "manifest.json"));

// The title backdrop: the fly-over's frames (start/flow.ts DEFAULT_FRAMES), downscaled to JPEG.
const TITLE_FRAMES = ["f002", "f004", "f005", "f006", "f009", "f010"];
mkdirSync(join(out, "ui", "title"), { recursive: true });
const py = `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
for name in sys.argv[3:]:
    im = Image.open(f"{src}/{name}.png").convert("RGB")
    if im.width > 1280:
        im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
    im.save(f"{out}/{name}.jpg", "JPEG", quality=80, optimize=True, progressive=True)
`;
const frames = spawnSync("python3", ["-c", py, join(src, "town_layout", "cutscene_frames"), join(out, "ui", "title"), ...TITLE_FRAMES], { stdio: "inherit" });
if (frames.status !== 0) throw new Error("title frames: python3 with Pillow is needed (pip install pillow)");

writeFileSync(
  join(out, "README.md"),
  `# Vendored assets\n\nGenerated by make-it-in-china tools/blender/build_all.py (GLBs) and tools/blender/town_layout.py\n(\`town_layout/town.json\`, \`landscape/terrain_town_walkable.json\`); do not hand-edit. Only the GLBs\n\`src/layout.json\` and \`src/town.json\` use, plus an \`index.json\` listing only those, and the town's\nsources that \`scripts/port-town.mjs\` turns into \`src/town.json\`. \`audio/\`: tools/audio/owner_theme.py (music) and\ntools/audio/make_audio.py (ambience and effects; .ogg + .m4a, metadata, and manifest.json). \`ui/title/\`: the title screen's\nbackdrop, the fly-over's frames (town_layout/cutscene_frames) as JPEG q80.\n\nRegenerate with \`npm run assets:sync -w @silver-tongue/world3d\` (copies from \`WORLD3D_ASSETS\`,\ndefault \`../assets\` next to the repo checkout, and re-ports the town).\n`,
);
const size = (d) => readdirSync(d).reduce((s, f) => s + (statSync(join(d, f)).isDirectory() ? size(join(d, f)) : statSync(join(d, f)).size), 0);
console.log(`synced packages/world3d/assets: ${n} GLBs and the town's sources from ${src}, ${(size(out) / 1048576).toFixed(1)} MB; ported src/town.json`);
