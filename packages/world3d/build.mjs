// Builds dist/: index.html (CSS inlined), main.js (the app with three.js and the built course
// injected as __COURSE__, like packages/tui-web), assets/ (only the GLBs layout.json uses, plus a
// matching index.json), manifest.webmanifest and icons/. GLBs are copied, never inlined. Every
// URL is relative, so dist/ works at any path (GitHub Pages serves it under /world3d/).
//
//   node build.mjs [courseId]          one-off build
//   node build.mjs --dev [courseId]    build, then serve dist/ and rebuild main.js on change
//
// Assets come from the vendored packages/world3d/assets (refreshed from the make-it-in-china
// library by `npm run assets:sync`); WORLD3D_ASSETS overrides it (any library dir with index.json).
import { context } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const ctx = await context({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(dist, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  define: { __COURSE__: course },
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
    `built packages/world3d/dist: index.html ${kb(statSync(join(dist, "index.html")).size)}, main.js ${kb(statSync(join(dist, "main.js")).size)}, assets/ ${kb(size(join(dist, "assets")))} (${glbs} GLBs); total ${kb(size(dist))}`,
  );
}
