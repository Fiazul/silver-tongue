// Real-look comparison shots (src/look.ts, `?look=real`): the same spot in the toon look, the real
// look and the real look with the toon ramp kept, at morning and evening, plus a frame-time sample
// of each. Headless Chromium on the machine's GPU (ANGLE Vulkan; without it SwiftShader renders at
// ~1 fps and the follow camera never settles) through Playwright (imported from an absolute path, as
// scripts/cache-repro does; set PLAYWRIGHT to a local install). Serves nothing itself: point URL at
// a served dist/ (e.g. `python3 -m http.server 8190 -d dist`).
//
//   URL=http://127.0.0.1:8190/ node scripts/look-capture.mjs [outDir]
//
// Each shot: `?promo=1` (no start flow, no fly-over), HUD off (world3d.promo("hud", false)),
// teleport to SPOT, set the daylight, wait for the follow camera to settle, screenshot the page.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PW = process.env.PLAYWRIGHT ?? "/home/fiazul/Desktop/chinese_immi/node_modules/playwright/index.mjs";
const { chromium } = await import(PW);
const URL_ = process.env.URL ?? "http://127.0.0.1:8190/";
const out = process.argv[2] ?? "shots/look";
mkdirSync(out, { recursive: true });
/** Market Street, in front of the noodle shop (town.json noodle_shop at (-17, 28), its door toward +z) */
const SPOT = (process.env.SPOT ?? "-15.5,31.5").split(",").map(Number);
/** behind the noodle shop (north of it, the camera looks from the south-east): the see-through should fade it */
const SEE_SPOT = (process.env.SEE_SPOT ?? "-17,22.5").split(",").map(Number);
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);

const variants = [
  { name: "toon", q: "" },
  { name: "real", q: "&look=real" },
  { name: "real-ramp", q: "&look=real&ramp=1" },
  // its own page: the held dolly never hands the camera back, so no see-through check after it
  { name: "real-close", q: "&look=real", noSee: true },
];
/**
 * SET=textured: the textured assets' set (the noodle shop, street dressing: docs/asset-conventions.md
 * "Textures" in the library) at the same spot, 06-08 beside 01 / 02 / 05, plus 09, a close camera
 * on the noodle shop's facade (`close`: a held promo dolly, from == to), and see-*-textured.png.
 */
const SET = process.env.SET ?? "";
/** close on the noodle shop's facade (its front at z ~31.5 facing +z), from the south-east, a little above head height */
const CLOSE = { from: [-12.2, 3.1, 37.2], to: [-12.2, 3.1, 37.2], lookAt: [-16.6, 2.0, 31.2], seconds: 600 };
const shots =
  SET === "textured"
    ? [
        { file: "06-toon-textured.png", v: "toon", day: 0 },
        { file: "07-real-textured.png", v: "real", day: 0 },
        { file: "08-real-evening-textured.png", v: "real", day: 1 },
        { file: "09-real-textured-close.png", v: "real-close", day: 0, close: true },
      ]
    : [
        { file: "01-toon.png", v: "toon", day: 0 },
        { file: "02-real.png", v: "real", day: 0 },
        { file: "03-real-ramp.png", v: "real-ramp", day: 0 },
        { file: "04-toon-evening.png", v: "toon", day: 1 },
        { file: "05-real-evening.png", v: "real", day: 1 },
      ];
const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit").split(" ").filter(Boolean);
// CHROME=/usr/bin/google-chrome: a browser of its own when Playwright's download isn't there
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const report = {};
/** ONLY=real,real-ramp: a subset of the variants (their shots only) */
const only = process.env.ONLY?.split(",");
for (const v of variants.filter((v) => (!only || only.includes(v.name)) && shots.some((s) => s.v === v.name))) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  const t0 = Date.now();
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`+${Date.now() - t0}ms ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${URL_}?promo=1${v.q}`);
  await page.waitForFunction(() => window.world3d?.model?.() && !document.querySelector("#loading:not([hidden])"), null, { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => !!window.world3d?.model?.(), null, { timeout: 120000 });
  const r0 = {};
  const gl = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas");
    const g = c?.getContext("webgl2");
    const d = g?.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  r0.ready = Date.now() - t0;
  await page.evaluate(() => window.world3d.promo("hud", false));
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SPOT);
  await page.waitForTimeout(4000); // the town's characters stream in; the camera settles on the player
  const r = { gl, ...r0, logs, frames: {} };
  for (const s of shots.filter((s) => s.v === v.name)) {
    await page.evaluate((d) => window.world3d.setDaylight(d), s.day);
    await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SPOT);
    if (s.close) void page.evaluate((c) => void window.world3d.promo("dolly", c), CLOSE); // held for its 600 s: never awaited
    await page.waitForTimeout(2500);
    // frame time: rAF intervals over 3 s (vsync / frame cap off in CHROME_ARGS, so it tracks the work)
    r.frames[s.day] = await page.evaluate(
      () =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const t0 = last;
          const f = (t) => {
            d.push(t - last);
            last = t;
            if (t - t0 < 3000) requestAnimationFrame(f);
            else {
              d.sort((a, b) => a - b);
              res({ n: d.length, meanMs: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(2) });
            }
          };
          requestAnimationFrame(f);
        }),
    );
    r.look = await page.evaluate(() => window.world3d.look?.());
    r.info = await page.evaluate(() => { const i = window.world3d.info(); return { calls: i.calls, triangles: i.triangles }; });
    await page.screenshot({ path: join(out, s.file) });
    console.log(`${s.file}: ${v.name} day=${s.day}`);
  }
  // see-through check (seethrough.ts): the player behind the noodle shop, seen from the street
  if (v.noSee) {
    report[v.name] = r;
    await page.close();
    continue;
  }
  await page.evaluate((d) => window.world3d.setDaylight(d), 0);
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SEE_SPOT);
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => window.world3d.seeThrough());
  r.seeThrough = Object.fromEntries(Object.entries(st).filter(([k]) => k !== "slots"));
  await page.screenshot({ path: join(out, `see-${v.name}${SET ? `-${SET}` : ""}.png`) });
  report[v.name] = r;
  await page.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
