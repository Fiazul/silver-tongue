// Real-look comparison shots (src/look.ts, `?look=real`): the same spot in the toon look
// (`?look=toon`: the classic tier), the real look and the real look with the toon ramp kept, at
// morning and evening, plus a frame-time sample of each. SET=tiers: the shipped default (no look
// params) on a desktop and a phone, Settings → Graphics, Classic chosen there (20-23). SET=timing:
// page open -> loading screen gone -> first frame, the env build, the worst frame after (any build). Headless Chromium on the machine's GPU (ANGLE Vulkan; without it SwiftShader renders at
// ~1 fps and the follow camera never settles) through Playwright (imported from an absolute path, as
// scripts/cache-repro does; set PLAYWRIGHT to a local install). Serves nothing itself: point URL at
// a served dist/ (e.g. `python3 -m http.server 8190 -d dist`).
//
//   URL=http://127.0.0.1:8190/ node scripts/look-capture.mjs [outDir]
//
// Each shot: `?promo=1` (no start flow, no fly-over), HUD off (world3d.promo("hud", false)),
// teleport to SPOT, set the daylight, wait for the follow camera to settle, screenshot the page.
import { mkdirSync, readFileSync } from "node:fs";
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

/** the real look's environment layers (look.ts ENV_LAYERS), for SET=env */
const ENV_LAYERS = ["ground", "grass", "leaves", "sky", "bloom", "grade", "particles"];
const variants = [
  { name: "toon", q: "&look=toon" },
  { name: "real", q: "&look=real" },
  { name: "real-ramp", q: "&look=real&ramp=1" },
  // its own page: the held dolly never hands the camera back, so no see-through check after it
  { name: "real-close", q: "&look=real", noSee: true },
  // SET=env: every layer (the default), the fly-over, a close camera, then none (`env=`, the step-2 look) and each layer alone
  { name: "env", q: "&look=real" },
  { name: "env-flyover", q: "&look=real", noSee: true },
  { name: "env-close", q: "&look=real", noSee: true },
  { name: "env-none", q: "&look=real&env=", noSee: true },
  ...ENV_LAYERS.map((l) => ({ name: `env-${l}`, q: `&look=real&env=${l}`, noSee: true })),
];
/**
 * SET=env: the environment layers (look.ts ENV_LAYERS, `&env=`): 10 midday and 11 evening at SPOT with
 * every layer, 12 from the fly-over (FLY_T seconds in), 13 low over the lawn by the great tree, 14 a
 * 2-up of 07 beside 10; then `env=` (none: step 2's real look) and each layer alone, their spot
 * checks into LAYERS_OUT (not committed) and their frame times into the report (REPORT=file).
 */
/**
 * SET=textured: the textured assets' set (the noodle shop, street dressing: docs/asset-conventions.md
 * "Textures" in the library) at the same spot, 06-08 beside 01 / 02 / 05, plus 09, a close camera
 * on the noodle shop's facade (`close`: a held promo dolly, from == to), and see-*-textured.png.
 */
const SET = process.env.SET ?? "";
/** close on the noodle shop's facade (its front at z ~31.5 facing +z), from the south-east, a little above head height */
const CLOSE = { from: [-12.2, 3.1, 37.2], to: [-12.2, 3.1, 37.2], lookAt: [-16.6, 2.0, 31.2], seconds: 600 };
/** SET=env: low over the lawn west of the great tree (the tree at (-17.2, 6.3)), toward its base; the player just behind the camera (the grass centres on them) */
const CLOSE_GRASS = { from: [-31.0, 2.6, 4.6], to: [-31.0, 2.6, 4.6], lookAt: [-19.5, 0.6, 7.2], seconds: 600 };
/** SET=env: up from the street toward the evening sun */
const SUN_VIEW = { from: [5, 12, 40], to: [5, 12, 40], lookAt: [255, 100, 473], seconds: 600 };
const CLOSE_GRASS_AT = [-25.6, 5.2];
/** SET=env: the per-layer spot checks go here (not committed), frame times into the report */
const LAYERS_OUT = process.env.LAYERS_OUT ?? join(out, "layers");
const shots =
  SET === "env"
    ? [
        { file: "10-env-midday.png", v: "env", day: 1 / 3 },
        { file: "11-env-evening.png", v: "env", day: 1 },
        { file: "env-morning.png", v: "env", day: 0, dir: LAYERS_OUT },
        { file: "12-env-wide.png", v: "env-flyover", day: 1 / 3, flyover: Number(process.env.FLY_T ?? 14) },
        { file: "13-env-close-grass.png", v: "env-close", day: 1 / 3, close: CLOSE_GRASS, at: CLOSE_GRASS_AT },
        // frame times: every variant at midday (1/3); `none` at morning too (07's daylight), bloom at evening too (its glow)
        { file: "none-morning.png", v: "env-none", day: 0, dir: LAYERS_OUT },
        { file: "none.png", v: "env-none", day: 1 / 3, dir: LAYERS_OUT },
        ...ENV_LAYERS.map((l) => ({ file: `${l}.png`, v: `env-${l}`, day: 1 / 3, dir: LAYERS_OUT })),
        { file: "bloom-evening.png", v: "env-bloom", day: 1, dir: LAYERS_OUT },
        // toward the evening sun (town.json sun azimuth 150, ~11 degrees up at evening): the sky layer's disc and glow, beside none
        { file: "sky-evening-sun.png", v: "env-sky", day: 1, close: SUN_VIEW, dir: LAYERS_OUT },
        { file: "none-evening-sun.png", v: "env-none", day: 1, close: SUN_VIEW, dir: LAYERS_OUT },
        // the sky from the fly-over's opening (it looks over the town to the hills), evening; last on its page (the fly-over keeps the camera)
        { file: "sky-evening-flyover.png", v: "env-sky", day: 1, flyover: 2.5, dir: LAYERS_OUT },
        { file: "none-evening-flyover.png", v: "env-none", day: 1, flyover: 2.5, dir: LAYERS_OUT },
      ]
    : SET === "textured"
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
const tiersSet = SET === "tiers" || SET === "timing" || SET === "interiors";
const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit").split(" ").filter(Boolean);
// CHROME=/usr/bin/google-chrome: a browser of its own when Playwright's download isn't there
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const report = {};
/** ONLY=real,real-ramp: a subset of the variants (their shots only) */
const only = process.env.ONLY?.split(",");
/**
 * Before the page's own scripts: when #loading is hidden (the first time, after the load), and every
 * rAF interval for 3 s after it; works on a build without the world3d:* performance marks too.
 */
const TIMING_INIT = () => {
  const t = (window.__lookTiming = { hiddenMs: null, frames: [] });
  const watch = () => {
    const el = document.querySelector("#loading");
    if (!el) return requestAnimationFrame(watch);
    const seen = () => {
      if (t.hiddenMs !== null || !el.hidden || !window.world3d?.model?.()) return false;
      t.hiddenMs = performance.now();
      let last = null;
      // rAF timestamps: the first one is the frame the loading screen came off; each interval after is one frame
      const f = (now) => {
        if (last !== null) t.frames.push(now - last);
        last = now;
        if (now - t.hiddenMs < 3000) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
      return true;
    };
    const tick = () => void (seen() || setTimeout(tick, 5));
    tick();
  };
  watch();
};
/** the timing a page recorded (TIMING_INIT and the world3d:* marks, when the build has them) */
const timing = (page) =>
  page.evaluate(() => {
    const t = window.__lookTiming;
    const mark = (n) => performance.getEntriesByName(n)[0];
    const f = t?.frames ?? [];
    return {
      loadingHiddenMs: t?.hiddenMs !== null && t ? Math.round(t.hiddenMs) : null,
      firstFrameMark: mark("world3d:first-frame") ? Math.round(mark("world3d:first-frame").startTime) : null,
      envMs: mark("world3d:env") ? Math.round(mark("world3d:env").duration) : null,
      /** the first frame after the loading screen, and the worst / mean over the 3 s after it (rAF intervals) */
      firstFrameMs: f.length ? +f[0].toFixed(1) : null,
      worstFrameMs: f.length ? +Math.max(...f).toFixed(1) : null,
      meanFrameMs: f.length ? +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1) : null,
      look: window.world3d?.look?.() ? (({ tier, source, reason, env, grassDensity, valve, envBuildMs }) => ({ tier, source, reason, env, grassDensity, valve, envBuildMs }))(window.world3d.look()) : null,
    };
  });
const errorsOf = (page) => {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
};
/** a returning player: a promo game ("Mei") saved in this context first, so the plain URL resumes it (no start flow) */
async function seedSave(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${URL_}?promo=1&look=toon`);
  await p.waitForFunction(() => !!window.world3d?.model?.() && !!window.world3d?.state?.(), null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  await p.close();
}
async function openPlain(ctx, q = "") {
  const page = await ctx.newPage();
  await page.addInitScript(TIMING_INIT);
  const errors = errorsOf(page);
  await page.goto(`${URL_}${q}`);
  await page.waitForFunction(() => !!window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 120000 });
  await page.waitForTimeout(4000); // past the valve's 3 s window; the town's people stream in
  // a resumed first-day game opens on the fly-over: skip it (a tap or click on its letterbox) for the play view
  if (await page.locator(".letterbox").count()) {
    await page.locator(".letterbox").first().tap().catch(() => page.locator(".letterbox").first().click({ force: true }).catch(() => {}));
    await page.waitForTimeout(2500);
  }
  return { page, errors };
}
/** a frame-time sample: rAF intervals over 3 s */
const sample = (page) =>
  page.evaluate(
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
            res({ n: d.length, meanMs: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), medMs: +d[Math.floor(d.length / 2)].toFixed(2) });
          }
        };
        requestAnimationFrame(f);
      }),
  );
if (SET === "tiers") {
  // desktop: the default, Settings → Graphics open, Classic picked there and the page reloaded
  const desk = await browser.newContext({ viewport: { width: W, height: H } });
  await seedSave(desk);
  const d = await openPlain(desk);
  report.desktop = { timing: await timing(d.page), frames: await sample(d.page) };
  await d.page.screenshot({ path: join(out, "20-default-desktop.png") });
  console.log(`20-default-desktop.png: ${JSON.stringify(report.desktop.timing.look)}`);
  await d.page.evaluate(() => [...document.querySelectorAll(".actions button")].find((b) => b.textContent === "Menu")?.click());
  await d.page.waitForSelector("dialog.menu[open]");
  await d.page.evaluate(() => [...document.querySelectorAll("dialog.menu button")].find((b) => b.textContent === "Settings")?.click());
  await d.page.waitForSelector(".set-graphics");
  await d.page.evaluate(() => document.querySelector(".set-graphics").scrollIntoView({ block: "center" }));
  await d.page.waitForTimeout(300);
  await d.page.screenshot({ path: join(out, "22-settings-graphics.png") });
  report.settings = await d.page.evaluate(() => [...document.querySelectorAll(".set-graphics button")].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? " (on)" : ""}`));
  console.log(`22-settings-graphics.png: ${report.settings.join(" | ")}`);
  await d.page.evaluate(() => document.querySelector('.set-graphics button[data-tier="classic"]').click());
  report.settingsMsg = await d.page.evaluate(() => document.querySelector(".set-msg")?.textContent);
  report.desktop.errors = d.errors;
  await d.page.close();
  const c = await openPlain(desk);
  report.classic = { timing: await timing(c.page), frames: await sample(c.page), errors: c.errors };
  await c.page.screenshot({ path: join(out, "23-classic.png") });
  console.log(`23-classic.png: ${JSON.stringify(report.classic.timing.look)}`);
  // back to lite and full by the saved choice, for their frame times at the same place
  for (const tier of ["lite", "full"]) {
    await c.page.evaluate((t) => {
      const k = "silver-tongue:world3d:prefs";
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? "{}"), graphics: t }));
    }, tier);
    const x = await openPlain(desk);
    report[tier] = { timing: await timing(x.page), frames: await sample(x.page), errors: x.errors };
    await x.page.close();
  }
  await c.page.close();
  await desk.close();
  // phone: 390x844, touch, a phone's user agent
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  });
  await seedSave(phone);
  const ph = await openPlain(phone);
  report.phone = {
    timing: await timing(ph.page),
    frames: await sample(ph.page),
    touch: await ph.page.evaluate(() => ({ touchUi: window.world3d.touch().touchUi, compact: window.world3d.touch().layout.compact, joystickZone: window.world3d.touch().layout.stickZone })),
    errors: ph.errors,
  };
  await ph.page.screenshot({ path: join(out, "21-default-phone.png") });
  console.log(`21-default-phone.png: ${JSON.stringify(report.phone.timing.look)}`);
  await ph.page.close();
  await phone.close();
} else if (SET === "timing") {
  // TIMING_Q (e.g. "&look=real", "&look=toon", ""): RUNS fresh promo pages, each timed
  const runs = [];
  for (let i = 0; i < Number(process.env.RUNS ?? 3); i++) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();
    await page.addInitScript(TIMING_INIT);
    const errors = errorsOf(page);
    await page.goto(`${URL_}?promo=1${process.env.TIMING_Q ?? ""}`);
    await page.waitForFunction(() => window.__lookTiming?.frames.length > 0 && performance.now() - window.__lookTiming.hiddenMs > 3100, null, { timeout: 120000, polling: 100 });
    const t = await timing(page);
    // then the frame time at SPOT (Market Street by the noodle shop), HUD off, midday, as the variants above
    await page.evaluate(() => window.world3d.promo("hud", false));
    await page.evaluate((d) => window.world3d.setDaylight(d), 1 / 3);
    await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SPOT);
    await page.waitForTimeout(4000);
    runs.push({ ...t, spot: await sample(page), errors: errors.length });
    await ctx.close();
  }
  report.timing = runs;
}
// SET=interiors: fixed dollhouse views, one fresh page per shot so held cameras never leak.
// These are capture poses only: gameplay cameras and spawn positions are unchanged.
if (SET === "interiors") {
  const layout = JSON.parse(readFileSync(new URL("../src/layout.json", import.meta.url), "utf8"));
  const cameras = {
    noodle_shop: { from: [9, 7, 10], lookAt: [0, 0.8, -2] },
    room: { from: [6, 5, 7], lookAt: [0, 0.8, -1.5] },
    shop: { from: [9, 7, 10], lookAt: [0, 0.8, -2] },
    stairs: { from: [6, 5, 7], lookAt: [0, 0.8, -1.5] },
    tea_house: { from: [9, 7, 10], lookAt: [0, 0.8, -2] },
  };
  report.interiors = [];
  for (const [id, interior] of Object.entries(layout.interiors).filter(([, i]) => !i.outdoor)) {
    if (!cameras[id]) throw new Error(`Missing interior capture camera: ${id}`);
    for (const [tier, time, day] of [["classic", "midday", 1 / 3], ["full", "midday", 1 / 3], ["full", "evening", 1]]) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      const errors = errorsOf(page);
      await page.goto(`${URL_}?promo=1&look=${tier}`);
      await page.waitForFunction(() => window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 120000 });
      await page.evaluate((place) => window.world3d.teleport(place), interior.place);
      await page.waitForFunction((space) => window.world3d.info().space === space && !window.world3d.info().transitioning && document.querySelector("#loading")?.hidden, id, { timeout: 120000 });
      await page.waitForTimeout(4000); // asset load / fade-through and streamed characters
      await page.evaluate((d) => { window.world3d.promo("hud", false); window.world3d.setDaylight(d); }, day);
      await page.evaluate((c) => { void window.world3d.promo("dolly", { ...c, to: c.from, seconds: 600 }); }, cameras[id]);
      await page.waitForTimeout(1500);
      const file = `${id}-${tier}-${time}.png`;
      await page.screenshot({ path: join(out, file) });
      const info = await page.evaluate(() => window.world3d.info());
      report.interiors.push({ file, calls: info.calls, triangles: info.triangles, errors });
      console.log(`${file}: ${info.calls} calls, ${info.triangles} triangles, ${errors.length} errors`);
      await page.close();
    }
  }
  if (report.interiors.some((s) => s.errors.length)) process.exitCode = 1;
}
for (const v of variants.filter((v) => !tiersSet && (!only || only.includes(v.name)) && shots.some((s) => s.v === v.name))) {
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
    await page.evaluate(([x, z]) => window.world3d.teleport(x, z), s.at ?? SPOT);
    if (s.close) void page.evaluate((c) => void window.world3d.promo("dolly", c), s.close === true ? CLOSE : s.close); // held for its 600 s: never awaited
    if (s.flyover) {
      // the fly-over from the spawn, shot when it reaches `flyover` seconds (the town's cameraFull keys); no frame sample
      await page.evaluate(() => window.world3d.promo("flyover"));
      await page.waitForFunction((t) => (window.world3d.info().cutscene?.t ?? 0) >= t, s.flyover, { timeout: 120000, polling: 16 });
      r.flyover = await page.evaluate(() => window.world3d.info().cutscene);
      await page.screenshot({ path: join(s.dir ?? out, s.file) });
      console.log(`${s.file}: ${v.name} fly-over t=${r.flyover?.t}`);
      continue;
    }
    await page.waitForTimeout(2500);
    // frame time: rAF intervals over 3 s (vsync / frame cap off in CHROME_ARGS, so it tracks the work)
    r.frames[+s.day.toFixed(2)] = await page.evaluate(
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
              res({ n: d.length, meanMs: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), medMs: +d[Math.floor(d.length / 2)].toFixed(2), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(2) });
            }
          };
          requestAnimationFrame(f);
        }),
    );
    r.look = await page.evaluate(() => window.world3d.look?.());
    r.info = await page.evaluate(() => { const i = window.world3d.info(); return { calls: i.calls, triangles: i.triangles }; });
    mkdirSync(s.dir ?? out, { recursive: true });
    await page.screenshot({ path: join(s.dir ?? out, s.file) });
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
// SET=env: 14, a 2-up of 07 (step 2's real look, env layers not built yet) beside 10 (every layer), drawn by the browser (no image tooling)
if (SET === "env") {
  const { existsSync, readFileSync } = await import("node:fs");
  const before = process.env.BEFORE ?? join(out, "07-real-textured.png");
  const after = join(out, "10-env-midday.png");
  if (existsSync(before) && existsSync(after)) {
    const url = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
    const page = await browser.newPage({ viewport: { width: W * 2, height: H + 40 } });
    const cap = "font:600 20px sans-serif;color:#fff;position:absolute;top:8px;left:12px;text-shadow:0 1px 3px #000";
    await page.setContent(`<body style="margin:0;background:#111;display:flex"><div style="position:relative"><img src="${url(before)}" width=${W} height=${H}><div style="${cap}">07 real look (step 2)</div></div><div style="position:relative"><img src="${url(after)}" width=${W} height=${H}><div style="${cap}">10 environment layers, midday</div></div></body>`);
    await page.screenshot({ path: join(out, "14-env-off-vs-on.png"), clip: { x: 0, y: 0, width: W * 2, height: H } });
    await page.close();
    console.log("14-env-off-vs-on.png: 07 | 10");
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
// REPORT=file: the same JSON, for a table
if (process.env.REPORT) (await import("node:fs")).writeFileSync(process.env.REPORT, JSON.stringify(report, null, 1));
