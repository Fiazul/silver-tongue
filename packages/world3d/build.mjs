// Builds dist/: index.html (CSS inlined), main-<hash>.js (the app with three.js) and chunks/ (split off:
// the start flow, the GLTF loader + meshopt decoder, the orbit camera), courses/ (the catalog
// and every course file, copied from the repo's dist/courses/ as packages/web-common's copy-courses.mjs does for tui-web and vn-web; the
// page fetches the course it plays, so it needs a web server), assets/ (only the GLBs layout.json
// and town.json use, meshopt-compressed by scripts/meshopt.mjs, plus a matching index.json with
// each file's bytes), manifest.webmanifest and icons/. GLBs are copied, never
// inlined. Every URL is relative, so dist/ works at any path (GitHub Pages serves it under /world3d/).
//
//   node build.mjs          one-off build
//   node build.mjs --dev    build, then serve dist/ and rebuild main.js (unhashed under --dev) on change
//
// Audio: each course's clips (content/audio/<language>, ~870 clips, ~7 MB) are loaded by URL as
// they are said, never inlined. A one-off build doesn't copy them (dist/ stays near 10 MB): the page
// loads them from ../courses/<course>/audio/, the site's shared courses/ folder (build:site;
// pages.yml puts world3d under /world3d/). --dev, or WORLD3D_AUDIO=bundle, copies the clips each course uses
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
import { build, context } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, copyFileSync, existsSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDist } from "./scripts/check-dist.mjs";
import { copyUsed } from "./scripts/used-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const port = Number(process.env.PORT ?? 8173);
const assetsSrc = process.env.WORLD3D_ASSETS ?? join(here, "assets");
const dist = join(here, "dist");

/**
 * The build's stamp, two strings. `tag`, the muted corner tag: "v" + the game's version
 * (packages/tui-node/package.json, where tui-web and vn-web read it too), "+" appended when
 * packages/world3d had uncommitted changes (git status --porcelain). `full`, for Settings, the
 * <html> tag and window.world3d.version: the tag, the git short sha (7) of HEAD and the UTC build
 * time ("v0.14.0 · e8dca2a · 2026-09-28 02:00"). Both "dev" under --dev, which never sits still
 * long enough for them to mean much. Baked into main.js (esbuild `define` __ST_VERSION__ and
 * __ST_BUILD__, src/version.ts) and into index.html (writeHtml: data-version on <html>, the tag on
 * the static loading card), so a build can be told apart before any JS runs.
 */
async function buildVersion() {
  if (dev) return { tag: "dev", full: "dev" };
  const pkg = JSON.parse(readFileSync(join(repo, "packages", "tui-node", "package.json"), "utf8")).version;
  const git = async (args) => (await promisify(execFile)("git", args, { cwd: repo, encoding: "utf8" })).stdout.trim();
  const sha = await git(["rev-parse", "--short=7", "HEAD"]);
  const dirty = (await git(["status", "--porcelain", "--", "packages/world3d"])) !== "";
  const tag = `v${pkg}${dirty ? "+" : ""}`;
  return { tag, full: `${tag} · ${sha} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}` };
}
const version = await buildVersion();

// Worktrees can reuse an existing course build without writing outside this package.
const coursesSrc = process.env.WORLD3D_COURSES ?? join(repo, "dist", "courses");
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

const TITLE = "Silver Tongue";
/** the loading screen's card as plain HTML (src/preload.js draws the same, in the page's language, a moment later); the version tag (page.css .build-version) is baked in, no JS needed to show it */
const loadingCard = (bytesText, item) =>
  `<div class="ld-card"><h1 class="ld-title">${TITLE}</h1><div class="ld-bar"><div class="ld-fill"></div></div><p class="ld-line"><b class="ld-pct">0%</b><span class="ld-bytes">${bytesText}</span></p><p class="ld-item">${item}</p><p class="ld-slow" hidden></p><button class="ld-retry st-btn primary" type="button"></button><p class="ld-err"></p><span class="build-version" aria-hidden="true">${version.tag}</span></div>`;

/**
 * index.html with the CSS inlined: the UI skin (start/start.css, the start flow's design system)
 * first, then page.css. --dev: the module script as is (chunk names change under watch); a build
 * fills the loading card and the preloader in after esbuild (inlinePreloader). The <html> tag
 * carries the version too (data-version), on every path.
 */
function writeHtml() {
  const css = readFileSync(join(here, "src", "start", "start.css"), "utf8") + "\n" + readFileSync(join(here, "src", "page.css"), "utf8");
  let html = readFileSync(join(here, "src", "index.html"), "utf8").replace("/*CSS*/", () => css);
  html = html.replace('<html data-version="">', `<html data-version="${version.full}">`);
  if (dev) html = html.replace("<!--LOADING-->", loadingCard("", "Loading…")).replace("<!--BOOT-->", `<script type="module" src="./main.js"></script>`);
  writeFileSync(join(dist, "index.html"), html);
}

/**
 * The files the page starts with: main-<hash>.js (first: the entry), every chunk it imports, and the GLTF loader's and the
 * meshopt decoder's (imported on first use, needed at once). The start flow and the orbit camera
 * stay lazy. [url relative to the page, bytes].
 */
function startFiles(meta) {
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
  return [main, ...want].map((p) => [rel(p), statSync(resolve(p)).size]);
}

/** most the inlined preloader may weigh (index.html's own script, before any module; its data, the files and the strings, sit apart in #ld-text) */
const PRELOAD_BUDGET = 3500;

/**
 * index.html's loading card ("Loading the game… 0.0 / 1.0 MB") and the preloader (src/preload.js,
 * ES5, minified, inlined; beside it as JSON, #ld-text: the files with their sizes, the loading
 * strings of every UI language, the watchdog's times):
 * it fetches the start files with a byte bar, a stall line, a failure with Retry, then adds the
 * module script (no modulepreload links: they would fetch every file a second time). Returns its
 * bytes and the entry (./main-<hash>.js).
 */
async function inlinePreloader(meta) {
  const files = startFiles(meta);
  if (!files) throw new Error("no main.ts output in the metafile");
  const loc = (l) => JSON.parse(readFileSync(join(here, "locale", `${l}.json`), "utf8")).loading;
  const langs = Object.fromEntries(["en", "bn", "zh"].map((l) => [l, loc(l)]));
  const s = Object.fromEntries(Object.entries(langs).map(([l, t]) => [l, { loading: t.loading, slow: t.slow, failed: t.failed, file: t.file, retry: t.retry, reload: t.reload }]));
  const cfg = { files, entry: files[0][0], s, fallback: "en", key: "silver-tongue:settings", slowMs: 15000, failMs: 45000, moduleMs: 60000 };
  const out = await build({
    stdin: { contents: `import { boot } from "./preload.js";\nboot(window, document);`, resolveDir: join(here, "src"), sourcefile: "preload-entry.js" },
    bundle: true,
    format: "iife",
    target: "es5",
    minify: true,
    write: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
  });
  const js = out.outputFiles[0].text.trim();
  if (/<\/script|<!--/i.test(js)) throw new Error("the preloader can't be inlined: it has </script or <!--");
  const bytes = Buffer.byteLength(js);
  if (bytes > PRELOAD_BUDGET) throw new Error(`the inlined preloader is ${bytes} bytes, over its ${PRELOAD_BUDGET}`);
  const total = files.reduce((n, f) => n + f[1], 0);
  const f = join(dist, "index.html");
  const html = readFileSync(f, "utf8")
    .replace("<!--LOADING-->", () => loadingCard(`0.0 / ${(total / 1048576).toFixed(1)} MB`, langs.en.loading))
    .replace("<!--BOOT-->", () => `<script type="application/json" id="ld-text">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>\n    <script>${js}</script>`);
  writeFileSync(f, html);
  return { bytes, entry: cfg.entry };
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
// Everything but the scripts is in place: would both formats of the music pass the budget?
let sounds = copySounds(false) + copyBarks();
const MUSIC_OGG_ONLY = !bundleAudio && size(dist) + 1.2 * 1024 * 1024 > BUDGET; // + the scripts
if (MUSIC_OGG_ONLY) {
  rmSync(join(dist, "assets", "audio"), { recursive: true, force: true });
  rmSync(join(dist, "assets", "ui"), { recursive: true, force: true });
  sounds = copySounds(true) + copyBarks();
}
rmSync(join(dist, "chunks"), { recursive: true, force: true });
for (const f of readdirSync(dist)) if (f.endsWith(".js")) rmSync(join(dist, f)); // an older build's main.js / main-<hash>.js
const ctx = await context({
  entryPoints: [join(here, "src", "main.ts")],
  outdir: dist,
  // main-<hash>.js plus chunks/: what only some pages need (the start flow, a new player's; the GLTF
  // loader and meshopt decoder, fetched while the entry starts up; the orbit camera, off) loads apart.
  // Every file content-hashed (Pages caches each for 10 minutes: an unhashed main.js would come
  // from a recent visit's cache and import chunks that are gone; scripts/check-dist.mjs); --dev
  // keeps a plain main.js (index.html names it; nothing caches a localhost watch build for long)
  entryNames: dev ? "[name]" : "[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  define: { __AUDIO_ROOT__: JSON.stringify(audioRoot), __ST_VERSION__: JSON.stringify(version.tag), __ST_BUILD__: JSON.stringify(version.full) },
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
  const { bytes: preload, entry } = await inlinePreloader(result.metafile);
  const bad = checkDist(dist);
  if (bad.length) throw new Error(`dist/ fails its check:\n  ${bad.join("\n  ")}`);
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  const chunks = existsSync(join(dist, "chunks")) ? readdirSync(join(dist, "chunks")).map((f) => `${f} ${kb(statSync(join(dist, "chunks", f)).size)}`) : [];
  console.log(
    `built packages/world3d/dist: version ${version.full}, sound + title + barks ${kb(sounds)}${MUSIC_OGG_ONLY ? ` (music .ogg only: over the 15 MB budget with both, -${kb(musicM4aBytes())})` : " (.ogg + .m4a)"}, courses/ ${catalog.map((e) => `${e.id} (${e.learners.join(", ")})`).join(", ")}, audio ${clips ? `${clips[0]} clips in courses/<course>/audio/ (${kb(clips[1])}${clips[2] ? `, ${clips[2]} missing` : ""})` : `loaded from ${audioRoot}courses/<course>/audio/`}, index.html ${kb(statSync(join(dist, "index.html")).size)} (preloader ${preload} B), ${entry.slice(2)} ${kb(statSync(join(dist, entry)).size)} + chunks/ ${chunks.join(", ") || "none"}, assets/ ${kb(size(join(dist, "assets")))} (${glbs} GLBs); total ${kb(size(dist))}`,
  );
}
