// Builds dist/: index.html (CSS inlined), main.js (the app with three.js and the built course
// injected as __COURSE__, like packages/tui-web), assets/ (only the GLBs layout.json uses, plus a
// matching index.json), manifest.webmanifest and icons/. GLBs are copied, never inlined. Every
// URL is relative, so dist/ works at any path (GitHub Pages serves it under /world3d/).
//
//   node build.mjs [courseId]          one-off build
//   node build.mjs --dev [courseId]    build, then serve dist/ and rebuild main.js on change
//
// Audio: the course's clips (content/audio/<lang>, 870 clips, ~7 MB) are loaded by URL as they are
// said, never inlined. A one-off build doesn't copy them (dist/ stays near 10 MB): the page loads
// them from ../audio/, the browser TUI's copy at the Pages site root (pages.yml puts world3d under
// /world3d/). --dev, or WORLD3D_AUDIO=bundle, copies the clips the course uses into dist/audio/ and
// loads them from there. Clips missing: the game plays silently and the HUD says "no audio".
//
// Assets come from the vendored packages/world3d/assets (refreshed from the make-it-in-china
// library by `npm run assets:sync`); WORLD3D_ASSETS overrides it (any library dir with index.json).
import { context } from "esbuild";
import { cpSync, copyFileSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyUsed } from "./scripts/used-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const courseId = args.find((a) => !a.startsWith("--")) ?? "zh-china-en";
const port = Number(process.env.PORT ?? 8173);
const assetsSrc = process.env.WORLD3D_ASSETS ?? join(here, "assets");
const dist = join(here, "dist");

const coursePath = join(repo, "dist", "courses", courseId, "course.json");
if (!existsSync(coursePath)) throw new Error(`no ${coursePath}: run npm run build:course first`);
const course = readFileSync(coursePath, "utf8");
const bundleAudio = dev || process.env.WORLD3D_AUDIO === "bundle";
const audioBase = bundleAudio ? "audio/" : "../audio/";
if (!existsSync(join(assetsSrc, "index.json"))) throw new Error(`no asset library at ${assetsSrc} (set WORLD3D_ASSETS)`);

/** Copies the GLBs layout.json uses and an index.json listing only those (scripts/used-assets.mjs). */
function copyAssets() {
  return copyUsed(assetsSrc, join(dist, "assets"), join(here, "src", "layout.json"));
}

/** The home-screen bits: manifest and icons (src/icons, made by scripts/make-icons.py). */
function copyStatic() {
  copyFileSync(join(here, "src", "manifest.webmanifest"), join(dist, "manifest.webmanifest"));
  mkdirSync(join(dist, "icons"), { recursive: true });
  for (const f of readdirSync(join(here, "src", "icons"))) copyFileSync(join(here, "src", "icons", f), join(dist, "icons", f));
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

/** Copies the clips the course uses into dist/audio/ (bundled builds); returns [count, bytes, missing]. */
function copyAudio() {
  const out = join(dist, "audio");
  rmSync(out, { recursive: true, force: true });
  if (!bundleAudio) return null;
  const c = JSON.parse(course);
  const { language } = JSON.parse(readFileSync(join(repo, "content", "courses", `${courseId}.json`), "utf8"));
  const src = join(repo, "content", "audio", language);
  mkdirSync(out, { recursive: true });
  let n = 0;
  let bytes = 0;
  let missing = 0;
  for (const id of courseClips(c)) {
    const f = join(src, `${id}.mp3`);
    if (!existsSync(f)) {
      missing++;
      continue;
    }
    cpSync(f, join(out, `${id}.mp3`));
    n++;
    bytes += statSync(f).size;
  }
  return [n, bytes, missing];
}

function writeHtml() {
  const css = readFileSync(join(here, "src", "page.css"), "utf8");
  const html = readFileSync(join(here, "src", "index.html"), "utf8").replace("/*CSS*/", () => css);
  writeFileSync(join(dist, "index.html"), html);
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
const glbs = copyAssets();
copyStatic();
writeHtml();
const clips = copyAudio();
const ctx = await context({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(dist, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  define: { __COURSE__: course, __AUDIO_BASE__: JSON.stringify(audioBase) },
  legalComments: "none",
  logLevel: dev ? "info" : "warning",
});
if (dev) {
  await ctx.watch();
  const { hosts, port: p } = await ctx.serve({ servedir: dist, port, host: "0.0.0.0" });
  console.log(`world3d dev: ${glbs} GLBs copied; serving dist/ on http://localhost:${p}/ (also ${hosts.join(", ")})`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(
    `built packages/world3d/dist: audio ${clips ? `${clips[0]} clips in audio/ (${kb(clips[1])}${clips[2] ? `, ${clips[2]} missing` : ""})` : `loaded from ${audioBase}`}, index.html ${kb(statSync(join(dist, "index.html")).size)}, main.js ${kb(statSync(join(dist, "main.js")).size)}, assets/ ${kb(size(join(dist, "assets")))} (${glbs} GLBs); total ${kb(size(dist))}`,
  );
}
