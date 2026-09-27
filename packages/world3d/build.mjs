// Builds dist/: index.html (CSS inlined), main.js (the app with three.js) and chunks/ (split off:
// the start flow, the GLTF loader + meshopt decoder, the orbit camera), courses/ (the catalog
// and every course file, copied from the repo's dist/courses/ as packages/tui-web's build does; the
// page fetches the course it plays, so it needs a web server), assets/ (only the GLBs layout.json
// and town.json use, meshopt-compressed by scripts/meshopt.mjs, plus a matching index.json with
// each file's bytes), manifest.webmanifest and icons/. GLBs are copied, never
// inlined. Every URL is relative, so dist/ works at any path (GitHub Pages serves it under /world3d/).
//
//   node build.mjs          one-off build
//   node build.mjs --dev    build, then serve dist/ and rebuild main.js on change
//
// Audio: each course's clips (content/audio/<language>, ~870 clips, ~7 MB) are loaded by URL as
// they are said, never inlined. A one-off build doesn't copy them (dist/ stays near 10 MB): the page
// loads them from ../courses/<course>/audio/, the browser TUI's copy at the Pages site root (pages.yml
// puts world3d under /world3d/). --dev, or WORLD3D_AUDIO=bundle, copies the clips each course uses
// into dist/courses/<course>/audio/ and loads them from there. Clips missing: the game plays silently
// and the HUD says "no audio".
//
// Barks (barks/audio/<language>/, scripts/bark-audio.mjs) go to assets/audio/barks/<language>/.
//
// Music, ambience, effects (assets/audio/, make-it-in-china tools/audio) and the title backdrop
// (assets/ui/) are copied as files with a manifest listing what ships: both .ogg and .m4a (the
// page picks by canPlayType), except that a one-off build whose total would pass the 15 MB
// budget ships the music as .ogg only (MUSIC_OGG_ONLY: the looping beds are the big files; a
// browser without Vorbis then has no music, ambience and effects still in .m4a). --dev and
// WORLD3D_AUDIO=bundle ship both.
//
// Assets come from the vendored packages/world3d/assets (refreshed from the make-it-in-china
// library by `npm run assets:sync`); WORLD3D_ASSETS overrides it (any library dir with index.json).
import { context } from "esbuild";
import { cpSync, copyFileSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyUsed } from "./scripts/used-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const port = Number(process.env.PORT ?? 8173);
const assetsSrc = process.env.WORLD3D_ASSETS ?? join(here, "assets");
const dist = join(here, "dist");

const coursesSrc = join(repo, "dist", "courses");
if (!existsSync(join(coursesSrc, "index.json"))) throw new Error(`no ${join(coursesSrc, "index.json")}: run npm run build:course first`);
const bundleAudio = dev || process.env.WORLD3D_AUDIO === "bundle";
const audioRoot = bundleAudio ? "" : "../";
if (!existsSync(join(assetsSrc, "index.json"))) throw new Error(`no asset library at ${assetsSrc} (set WORLD3D_ASSETS)`);

/** Copies the GLBs layout.json and town.json use (meshopt-compressed) and an index.json listing only those (scripts/used-assets.mjs). */
function copyAssets() {
  return copyUsed(assetsSrc, join(dist, "assets"), [join(here, "src", "layout.json"), join(here, "src", "town.json")]);
}

const BUDGET = 15 * 1024 * 1024;

/**
 * Copies assets/ui/ and assets/audio/ (every manifest entry's files) into dist/assets/, with a
 * manifest of what shipped. `oggOnlyMusic`: the music's .m4a stays behind (and out of the manifest).
 * Returns the bytes copied.
 */
function copySounds(oggOnlyMusic) {
  const src = join(here, "assets");
  let bytes = 0;
  if (existsSync(join(src, "ui"))) {
    cpSync(join(src, "ui"), join(dist, "assets", "ui"), { recursive: true });
    bytes += size(join(dist, "assets", "ui"));
  }
  const mf = join(src, "audio", "manifest.json");
  if (!existsSync(mf)) return bytes;
  const shipped = [];
  for (const e of JSON.parse(readFileSync(mf, "utf8"))) {
    const out = { ...e };
    for (const key of ["file_ogg", "file_m4a"]) {
      const f = e[key];
      if (!f) continue;
      if (oggOnlyMusic && e.kind === "music" && key === "file_m4a") {
        delete out[key];
        continue;
      }
      const rel = f.replace(/^assets\//, "");
      mkdirSync(join(dist, "assets", dirname(rel)), { recursive: true });
      copyFileSync(join(src, rel), join(dist, "assets", rel));
      bytes += statSync(join(src, rel)).size;
    }
    shipped.push(out);
  }
  writeFileSync(join(dist, "assets", "audio", "manifest.json"), JSON.stringify(shipped));
  return bytes;
}

/**
 * Copies the barks' clips (barks/audio/<language>/, scripts/bark-audio.mjs: .ogg + .m4a, the page
 * picks by canPlayType) into dist/assets/audio/barks/<language>/; returns the bytes copied.
 */
function copyBarks() {
  const src = join(here, "barks", "audio");
  if (!existsSync(src)) return 0;
  const out = join(dist, "assets", "audio", "barks");
  cpSync(src, out, { recursive: true });
  return size(out);
}

/** Bytes the music's .m4a files would add. */
function musicM4aBytes() {
  const mf = join(here, "assets", "audio", "manifest.json");
  if (!existsSync(mf)) return 0;
  return JSON.parse(readFileSync(mf, "utf8"))
    .filter((e) => e.kind === "music" && e.file_m4a)
    .reduce((n, e) => n + statSync(join(here, "assets", e.file_m4a.replace(/^assets\//, ""))).size, 0);
}

/** The home-screen bits: manifest and icons (icons/, made by scripts/make-icons.py; outside src/, which holds no particular language). */
function copyStatic() {
  copyFileSync(join(here, "src", "manifest.webmanifest"), join(dist, "manifest.webmanifest"));
  mkdirSync(join(dist, "icons"), { recursive: true });
  for (const f of readdirSync(join(here, "icons"))) copyFileSync(join(here, "icons", f), join(dist, "icons", f));
}

/** Every clip id the course says: lines, replies, words, reactions in each NPC's voice. */
function courseClips(c) {
  const ids = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (k === "audio" && Array.isArray(v)) v.forEach((id) => ids.add(id));
      else walk(v);
    }
  };
  walk([c.scenes, c.words, c.reactions]);
  // reaction id -> npc id -> clip ids
  for (const byNpc of Object.values(c.reactionAudio ?? {})) for (const clips of Object.values(byNpc)) clips.forEach((id) => ids.add(id));
  return ids;
}

/** Copies the catalog and every course file (dist/courses/, from npm run build:course); returns the catalog. */
function copyCourses() {
  const out = join(dist, "courses");
  rmSync(join(dist, "audio"), { recursive: true, force: true }); // where 0.12 builds kept the clips
  rmSync(out, { recursive: true, force: true });
  cpSync(coursesSrc, out, { recursive: true });
  return JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
}

/**
 * Copies the clips each course uses (in any of its reading languages: the clips are the language's)
 * into dist/courses/<course>/audio/ (bundled builds); returns [count, bytes, missing].
 */
function copyAudio(catalog) {
  if (!bundleAudio) return null;
  let n = 0;
  let bytes = 0;
  let missing = 0;
  for (const entry of catalog) {
    const ids = new Set();
    for (const learner of entry.learners) for (const id of courseClips(JSON.parse(readFileSync(join(coursesSrc, entry.id, `${learner}.json`), "utf8")))) ids.add(id);
    const src = join(repo, "content", "audio", entry.language);
    const out = join(dist, "courses", entry.id, "audio");
    mkdirSync(out, { recursive: true });
    for (const id of ids) {
      const f = join(src, `${id}.mp3`);
      if (!existsSync(f)) {
        missing++;
        continue;
      }
      cpSync(f, join(out, `${id}.mp3`));
      n++;
      bytes += statSync(f).size;
    }
  }
  return [n, bytes, missing];
}

/** index.html with the CSS inlined: the UI skin (start/start.css, the start flow's design system) first, then page.css. */
function writeHtml() {
  const css = readFileSync(join(here, "src", "start", "start.css"), "utf8") + "\n" + readFileSync(join(here, "src", "page.css"), "utf8");
  const html = readFileSync(join(here, "src", "index.html"), "utf8").replace("/*CSS*/", () => css);
  writeFileSync(join(dist, "index.html"), html);
}

/**
 * <link rel="modulepreload"> in index.html for every chunk main.js imports, and for the GLTF
 * loader's and the meshopt decoder's (imported on first use, needed at once): the browser fetches
 * them alongside main.js instead of after it. The start flow and the orbit camera stay lazy.
 */
function preloadChunks(meta) {
  const main = Object.entries(meta.outputs).find(([, o]) => o.entryPoint?.endsWith("src/main.ts"))?.[0];
  if (!main) return;
  const want = new Set();
  const walk = (out) => {
    for (const imp of meta.outputs[out]?.imports ?? []) {
      const lazy = imp.kind === "dynamic-import";
      if (lazy && !/GLTFLoader|meshopt_decoder/.test(imp.path)) continue;
      if (want.has(imp.path)) continue;
      want.add(imp.path);
      walk(imp.path);
    }
  };
  walk(main);
  const rel = (p) => "./" + relative(dist, resolve(p)).split(sep).join("/");
  const links = [...want].map((p) => `    <link rel="modulepreload" href="${rel(p)}" />`).join("\n");
  const f = join(dist, "index.html");
  writeFileSync(f, readFileSync(f, "utf8").replace("  </head>", `${links}\n  </head>`));
}

/** Total bytes under a directory. */
function size(dir) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    n += s.isDirectory() ? size(p) : s.size;
  }
  return n;
}

mkdirSync(dist, { recursive: true });
const glbs = await copyAssets();
copyStatic();
writeHtml();
const catalog = copyCourses();
const clips = copyAudio(catalog);
// Everything but main.js is in place: would both formats of the music pass the budget?
let sounds = copySounds(false) + copyBarks();
const MUSIC_OGG_ONLY = !bundleAudio && size(dist) + 1.2 * 1024 * 1024 > BUDGET; // + main.js
if (MUSIC_OGG_ONLY) {
  rmSync(join(dist, "assets", "audio"), { recursive: true, force: true });
  rmSync(join(dist, "assets", "ui"), { recursive: true, force: true });
  sounds = copySounds(true) + copyBarks();
}
rmSync(join(dist, "chunks"), { recursive: true, force: true });
const ctx = await context({
  entryPoints: [join(here, "src", "main.ts")],
  outdir: dist,
  // main.js plus chunks/: what only some pages need (the start flow, a new player's; the GLTF
  // loader and meshopt decoder, fetched while main.js starts up; the orbit camera, off) loads apart
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  define: { __AUDIO_ROOT__: JSON.stringify(audioRoot) },
  legalComments: "none",
  metafile: true,
  logLevel: dev ? "info" : "warning",
});
if (dev) {
  await ctx.watch();
  const { hosts, port: p } = await ctx.serve({ servedir: dist, port, host: "0.0.0.0" });
  console.log(`world3d dev: ${glbs} GLBs copied; serving dist/ on http://localhost:${p}/ (also ${hosts.join(", ")})`);
} else {
  const result = await ctx.rebuild();
  await ctx.dispose();
  preloadChunks(result.metafile);
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  const chunks = existsSync(join(dist, "chunks")) ? readdirSync(join(dist, "chunks")).map((f) => `${f} ${kb(statSync(join(dist, "chunks", f)).size)}`) : [];
  console.log(
    `built packages/world3d/dist: sound + title + barks ${kb(sounds)}${MUSIC_OGG_ONLY ? ` (music .ogg only: over the 15 MB budget with both, -${kb(musicM4aBytes())})` : " (.ogg + .m4a)"}, courses/ ${catalog.map((e) => `${e.id} (${e.learners.join(", ")})`).join(", ")}, audio ${clips ? `${clips[0]} clips in courses/<course>/audio/ (${kb(clips[1])}${clips[2] ? `, ${clips[2]} missing` : ""})` : `loaded from ${audioRoot}courses/<course>/audio/`}, index.html ${kb(statSync(join(dist, "index.html")).size)}, main.js ${kb(statSync(join(dist, "main.js")).size)} + chunks/ ${chunks.join(", ") || "none"}, assets/ ${kb(size(join(dist, "assets")))} (${glbs} GLBs); total ${kb(size(dist))}`,
  );
}
