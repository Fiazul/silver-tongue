// Shadow stability while walking (README "Shadows"): the player walks a few metres and the page is
// captured FRAMES times, STEP_MS apart, for each tier x scene; then, per consecutive pair, the
// per-pixel luma change inside the shadow band (pixels dark in either frame: under the frame's
// SHADOW_PCT percentile), its mean and 95th percentile. Scenes: `street` (the follow camera down
// Market Street), `tree` (a camera held still over the lawn and the great tree while the player
// walks past: any change in the static ROI there is the shadow itself flickering), `interior`
// (the noodle shop's fixed room camera). Beside the pixels, sampled every animation frame of the
// walk: how far the player is from where the shadow map last drew them (`lag`: 0 when their shadow
// is redrawn every frame), the frame times and the map's redraws. Contact strips (the frames, then
// the pair differences as heat) into OUT/<label>-<tier>-<scene>.png, the numbers into REPORT.
//
//   URL=http://127.0.0.1:9311/ LABEL=before node scripts/motion-capture.mjs [outDir]
//
// Headless Chrome on the machine's GPU as look-capture.mjs (CHROME, CHROME_ARGS, PLAYWRIGHT);
// reduced motion on so the grade's film grain is still (it would be every pixel's change).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PW = process.env.PLAYWRIGHT ?? "/home/fiazul/Desktop/chinese_immi/node_modules/playwright/index.mjs";
const { chromium } = await import(PW);
const URL_ = process.env.URL ?? "http://127.0.0.1:9311/";
const out = process.argv[2] ?? "shots/look/shadow-stability";
const LABEL = process.env.LABEL ?? "run";
const TIERS = (process.env.TIERS ?? "full,lite,classic").split(",");
const SCENES = (process.env.SCENES ?? "street,tree,interior").split(",");
const FRAMES = Number(process.env.FRAMES ?? 12);
const STEP_MS = Number(process.env.STEP_MS ?? 80);
const SHADOW_PCT = Number(process.env.SHADOW_PCT ?? 0.3);
/** fps=0: the game draws every animation frame (the copies need a drawn frame each) */
const Q = process.env.Q ?? "&fps=0";
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
mkdirSync(out, { recursive: true });

/**
 * Each scene: where the player starts and walks to, the camera (null: the game's own), and the
 * static ROI (fractions of the frame: x0, y0, x1, y1) away from the player's path and body.
 */
const SCENE = {
  street: { from: [-10.5, 31.5], to: [-17.5, 31.5], camera: null, roi: null },
  // the great tree at (-17.2, 6.3); the camera up and west of it, held; the player walks the lawn south of it
  tree: { from: [-26, 12.5], to: [-19, 12.5], camera: { from: [-34, 9, 24], to: [-34, 9, 24], lookAt: [-20, 0, 8], seconds: 600 }, roi: [0.45, 0.05, 1.0, 0.55] },
  interior: { place: "noodle_shop", walk: [-1.5, -1], camera: null, roi: null },
};

const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit").split(" ").filter(Boolean);
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: "reduce" });

/**
 * In the page: every animation frame until stopped, the player, the map's redraws (the casters'
 * when the build reports them), the interval; and, once `shoot` is set, FRAMES copies of the
 * canvas STEP_MS apart, taken in the animation frame right after the game drew (`fps=0`: it draws
 * every one), so the cadence is the page's own, not the screenshot round trip's.
 */
const SAMPLER = ({ frames, step }) => {
  const s = (window.__walk = { on: true, rec: [], shoot: false, shots: [], next: 0 });
  const canvas = document.querySelector("#stage canvas");
  let last = performance.now();
  const f = (t) => {
    const L = window.world3d.look();
    s.rec.push({ dt: t - last, u: L.shadowCasterUpdates ?? L.shadowUpdates ?? 0, st: L.shadowUpdates ?? 0, p: window.world3d.player(), shot: s.shoot });
    last = t;
    if (s.shoot && s.shots.length < frames && t >= s.next) {
      const c = new OffscreenCanvas(canvas.width, canvas.height);
      c.getContext("2d").drawImage(canvas, 0, 0);
      s.shots.push(c);
      s.next = (s.next || t) + step;
    }
    if (s.on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
};
/** the copies as PNG (base64) */
const SHOTS = async () => {
  const out = [];
  for (const c of window.__walk.shots) {
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out.push(btoa(bin));
  }
  return out;
};
const lagOf = (rec) => {
  let anchor = null;
  let lastU = -1;
  const lags = [];
  const dts = [];
  let moving = 0;
  let stale = 0;
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i];
    if (r.u !== lastU) {
      anchor = r.p;
      lastU = r.u;
    }
    if (i === 0) continue;
    dts.push(r.dt);
    const step = Math.hypot(r.p[0] - rec[i - 1].p[0], r.p[2] - rec[i - 1].p[2]);
    if (step < 1e-4) continue;
    moving++;
    const lag = Math.hypot(r.p[0] - anchor[0], r.p[2] - anchor[2]);
    if (lag > 1e-4) stale++;
    lags.push(lag);
  }
  lags.sort((a, b) => a - b);
  dts.sort((a, b) => a - b);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    frames: rec.length,
    movingFrames: moving,
    staleShadowFrames: stale,
    lagMeanM: +mean(lags).toFixed(4),
    lagMaxM: +(lags.at(-1) ?? 0).toFixed(4),
    frameMeanMs: +mean(dts).toFixed(2),
    frameP95Ms: +(dts[Math.floor(dts.length * 0.95)] ?? 0).toFixed(2),
    mapRedraws: rec.length ? rec.at(-1).st - rec[0].st : 0,
    casterRedraws: rec.length ? rec.at(-1).u - rec[0].u : 0,
  };
};

async function open(tier) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${URL_}?promo=1&look=${tier}${Q}`);
  await page.waitForFunction(() => !!window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 120000 });
  await page.evaluate(() => {
    window.world3d.promo("hud", false);
    window.world3d.setDaylight(1 / 3);
  });
  await page.waitForTimeout(4000); // the town's people stream in
  return { page, errors };
}

async function run(tier, name) {
  const sc = SCENE[name];
  const { page, errors } = await open(tier);
  let to;
  if (sc.place) {
    await page.evaluate((p) => window.world3d.teleport(p), sc.place);
    await page.waitForFunction((sp) => window.world3d.info().space === sp && !window.world3d.info().transitioning && document.querySelector("#loading")?.hidden, sc.place, { timeout: 120000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.world3d.setDaylight(1 / 3));
    const p = await page.evaluate(() => window.world3d.player());
    to = [p[0] + sc.walk[0], p[2] + sc.walk[1]];
  } else {
    await page.evaluate(([x, z]) => window.world3d.teleport(x, z), sc.from);
    to = sc.to;
  }
  if (sc.camera) void page.evaluate((c) => void window.world3d.promo("dolly", c), sc.camera); // held: never awaited
  await page.waitForTimeout(2500);
  const look = await page.evaluate(() => { const l = window.world3d.look(); return { tier: l.tier, shadowMap: l.shadowMap, budget: l.budget }; });
  await page.evaluate(SAMPLER, { frames: FRAMES, step: STEP_MS });
  await page.evaluate(([x, z]) => window.world3d.walkTo(x, z), to);
  await page.waitForTimeout(350); // up to walking speed
  const t0 = Date.now();
  if (Q.includes("perf=1")) await page.evaluate(() => window.world3d.perf("start"));
  await page.evaluate(() => (window.__walk.shoot = true));
  await page.waitForFunction((n) => window.__walk.shots.length >= n, FRAMES, { timeout: 60000, polling: 50 });
  const walkMs = Date.now() - t0;
  const rec = await page.evaluate(() => { window.__walk.on = false; return window.__walk.rec.filter((r) => r.shot); });
  // ?perf=1 (Q): GPU ms per drawn frame over the walk (perf.ts), the shadow pass and the total
  const gpu = Q.includes("perf=1")
    ? await page.evaluate(() => {
        const f = (window.world3d.perf("stop")?.frames ?? []).filter((x) => x.gpu && x.gpuTotal);
        const m = (k) => (f.length ? +(f.reduce((a, x) => a + (k === "total" ? x.gpuTotal : (x.gpu[k] ?? 0)), 0) / f.length).toFixed(3) : null);
        return { frames: f.length, shadowMs: m("shadow"), totalMs: m("total") };
      })
    : null;
  const shots = await page.evaluate(SHOTS);
  const p1 = await page.evaluate(() => window.world3d.player());
  await page.close();
  return { look, lag: lagOf(rec), gpu, walkMs, end: p1, shots, errors, roi: sc.roi };
}

/** in a blank page: the pair differences in the shadow band (and the ROI), and the contact strip */
async function analyse(r, file) {
  const page = await ctx.newPage();
  await page.setContent("<body></body>");
  const res = await page.evaluate(
    async ({ shots, pct, roi }) => {
      const imgs = await Promise.all(shots.map(async (b) => createImageBitmap(await (await fetch(`data:image/png;base64,${b}`)).blob())));
      const w = imgs[0].width;
      const h = imgs[0].height;
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d", { willReadFrequently: true });
      const luma = imgs.map((im) => {
        g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, w, h).data;
        const l = new Float32Array(w * h);
        for (let i = 0; i < l.length; i++) l[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
        return l;
      });
      const thr = (l) => {
        const s = Float32Array.from(l).sort();
        return s[Math.floor(s.length * pct)];
      };
      const rx = roi ? [Math.floor(roi[0] * w), Math.floor(roi[1] * h), Math.ceil(roi[2] * w), Math.ceil(roi[3] * h)] : null;
      const band = [];
      const inRoi = [];
      const pairs = [];
      const diffs = [];
      for (let k = 0; k + 1 < luma.length; k++) {
        const a = luma[k];
        const b = luma[k + 1];
        const ta = thr(a);
        const tb = thr(b);
        const dd = new Float32Array(w * h);
        let sum = 0;
        let n = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const d = Math.abs(a[i] - b[i]);
            dd[i] = d;
            if (a[i] > ta && b[i] > tb) continue;
            band.push(d);
            sum += d;
            n++;
            if (rx && x >= rx[0] && x < rx[2] && y >= rx[1] && y < rx[3]) inRoi.push(d);
          }
        pairs.push(+(sum / Math.max(1, n)).toFixed(2));
        diffs.push(dd);
      }
      const stat = (v) => {
        if (!v.length) return null;
        const s = Float32Array.from(v).sort();
        let m = 0;
        for (const x of s) m += x;
        return { n: s.length, mean: +(m / s.length).toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2) };
      };
      // the strip: the frames (a quarter size) in a row of 6 per line, then the pair differences as heat (x4)
      const tw = Math.round(w / 4);
      const th = Math.round(h / 4);
      const cols = 6;
      const rowsF = Math.ceil(imgs.length / cols);
      const rowsD = Math.ceil(diffs.length / cols);
      const strip = new OffscreenCanvas(tw * cols, th * (rowsF + rowsD));
      const sg = strip.getContext("2d");
      sg.fillStyle = "#111";
      sg.fillRect(0, 0, strip.width, strip.height);
      imgs.forEach((im, i) => sg.drawImage(im, (i % cols) * tw, Math.floor(i / cols) * th, tw, th));
      const hc = new OffscreenCanvas(w, h);
      const hg = hc.getContext("2d");
      diffs.forEach((dd, i) => {
        const id = hg.createImageData(w, h);
        for (let j = 0; j < dd.length; j++) {
          const v = Math.min(255, dd[j] * 4);
          id.data[j * 4] = v;
          id.data[j * 4 + 1] = v * 0.6;
          id.data[j * 4 + 2] = 0;
          id.data[j * 4 + 3] = 255;
        }
        hg.putImageData(id, 0, 0);
        if (rx) {
          hg.strokeStyle = "#39f";
          hg.lineWidth = 4;
          hg.strokeRect(rx[0], rx[1], rx[2] - rx[0], rx[3] - rx[1]);
        }
        sg.drawImage(hc, (i % cols) * tw, (rowsF + Math.floor(i / cols)) * th, tw, th);
      });
      const blob = await strip.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { band: stat(band), roi: stat(inRoi), pairs, png: btoa(bin) };
    },
    { shots: r.shots, pct: SHADOW_PCT, roi: r.roi },
  );
  writeFileSync(file, Buffer.from(res.png, "base64"));
  await page.close();
  return { band: res.band, roi: res.roi, pairs: res.pairs };
}

const report = { label: LABEL, url: URL_, q: Q, frames: FRAMES, stepMs: STEP_MS, load: (await import("node:os")).loadavg().map((x) => +x.toFixed(2)), rows: [] };
for (const tier of TIERS) {
  for (const name of SCENES) {
    const r = await run(tier, name);
    const file = join(out, `${LABEL}-${tier}-${name}.png`);
    const a = await analyse(r, file);
    const row = { tier, scene: name, look: r.look, walkMs: r.walkMs, end: r.end, ...a, lag: r.lag, gpu: r.gpu, errors: r.errors.length, errorText: r.errors.slice(0, 5) };
    report.rows.push(row);
    console.log(`${file}: band ${JSON.stringify(a.band)} roi ${JSON.stringify(a.roi)} lag ${JSON.stringify(r.lag)} gpu ${JSON.stringify(r.gpu)} errors ${r.errors.length}`);
  }
}
report.loadAfter = (await import("node:os")).loadavg().map((x) => +x.toFixed(2));
await browser.close();
if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(report, null, 1));
