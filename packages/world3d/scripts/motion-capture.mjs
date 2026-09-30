// Character motion contact strips (src/animator.ts): motion needs sequences, not stills. For each
// shot, 12 frames of a 4 s window, cropped around the characters, composed into one horizontal strip
// PNG (the frames laid out in a page and screenshotted by the same headless Chromium: no image
// library needed). Shots, NPC motion only (the player keeps its baked clips): Old Wang idle, in
// dialogue with the player standing still, and in dialogue while the player walks round him; each a
// 4 s window (12 frames a third of a second apart) with his head's world yaw / pitch / roll traced
// on every drawn frame (report.json: max change per frame, direction reversals).
// Same browser setup as scripts/look-capture.mjs (Playwright from PLAYWRIGHT, ANGLE Vulkan).
// Serves nothing itself: point URL at a served dist/.
//
//   python3 -m http.server 8910 -d dist &
//   URL=http://127.0.0.1:8910/ nice -n 15 node scripts/motion-capture.mjs [outDir=shots/motion]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PW = process.env.PLAYWRIGHT ?? "/home/fiazul/Desktop/chinese_immi/node_modules/playwright/index.mjs";
const { chromium } = await import(PW);
const URL_ = process.env.URL ?? "http://127.0.0.1:8910/";
const out = process.argv[2] ?? "shots/motion";
mkdirSync(out, { recursive: true });
const FRAMES = 12;
const STEP_MS = 80;
/** a strip's frame height cap (px) */
const STRIP_H = 420;
const W = 1280;
const H = 720;
/** Market Street by the noodle shop (look-capture's SPOT): the idle and walk shots */
const SPOT = [-15.5, 31.5];
/** Old Wang's stand and the player's talk stand (town.json npcs.wang) */
const WANG = [-13.2, 9.8];

const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit").split(" ").filter(Boolean);
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${URL_}?promo=1`);
await page.waitForFunction(() => !!window.world3d?.model?.() && !!window.world3d?.state?.(), null, { timeout: 120000 });
await page.evaluate(() => {
  window.world3d.promo("hud", false);
  window.world3d.setDaylight(1 / 3);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frameOf = (who) => page.evaluate((w) => window.world3d.frameOf(w), who);

/** A held camera for `seconds` (promo dolly with from == to); resolves when it hands the camera back. */
function hold(from, lookAt, seconds) {
  return page.evaluate((c) => window.world3d.promo("dolly", c), { from, to: from, lookAt, seconds });
}

/**
 * 12 frames 80 ms apart, copied out of the WebGL canvas right after the game draws them
 * (world3d.afterDraw: page screenshots take ~300 ms each here, far over the 80 ms step). The crop
 * is a box around these characters' screen boxes (world3d.frameOf), sized on the first frame;
 * `track`: re-centred on them every frame (a moving subject).
 */
async function frames(name, who, { track = false, step = STEP_MS, trace = null } = {}) {
  const r = await page.evaluate(
    ({ who, n, step, track, trace }) =>
      new Promise((resolve) => {
        const w3 = window.world3d;
        const boxOf = () => {
          const fs = who.map((x) => w3.frameOf(x)).filter(Boolean);
          const xs = fs.flatMap((f) => [f.top.x, f.foot.x]);
          const ys = fs.flatMap((f) => [f.top.y, f.foot.y]);
          const h = Math.max(...ys) - Math.min(...ys);
          const x0 = Math.min(...xs) - h * 0.35;
          const x1 = Math.max(...xs) + h * 0.35;
          const width = Math.max(260, x1 - x0);
          return { cx: (x0 + x1) / 2, y: Math.min(...ys) - h * 0.12, width, height: h * 1.2 };
        };
        let size = null;
        const cells = [];
        let t0 = 0;
        /** every drawn frame: the traced character's head (world yaw / pitch / roll, degrees) */
        const heads = [];
        w3.afterDraw((canvas) => {
          const now = performance.now();
          if (!t0) t0 = now;
          if (trace) heads.push({ t: Math.round(now - t0), ...w3.frameOf(trace).head });
          if (cells.length && now - t0 - cells[cells.length - 1].at < step - 4) return;
          const b = boxOf();
          size ??= b;
          const W = innerWidth;
          const H = innerHeight;
          const k = canvas.width / canvas.clientWidth;
          const cx = track ? b.cx : size.cx;
          const x = Math.max(0, Math.min(W - size.width, cx - size.width / 2));
          const y = Math.max(0, Math.min(H - size.height, size.y));
          const c = document.createElement("canvas");
          c.width = Math.round(size.width);
          c.height = Math.round(size.height);
          c.getContext("2d").drawImage(canvas, x * k, y * k, size.width * k, size.height * k, 0, 0, c.width, c.height);
          cells.push({ at: Math.round(now - t0), c, anim: cells.length === 0 || cells.length === n - 1 ? w3.anim() : null });
          if (cells.length === n) {
            w3.afterDraw(null);
            resolve({ size, heads, cells: cells.map((e) => ({ at: e.at, anim: e.anim, url: e.c.toDataURL("image/png") })) });
          }
        });
      }),
    { who, n: FRAMES, step, track, trace },
  );
  const shots = r.cells.map((c) => ({ at: c.at, anim: c.anim, buf: Buffer.from(c.url.split(",")[1], "base64") }));
  return { name, shots, heads: r.heads, clip: { width: Math.round(r.size.width), height: Math.round(r.size.height) } };
}

/** A head trace's per-frame stats: the largest change in one drawn frame and the direction reversals (changes under `eps` degrees are noise). */
function headStats(heads, eps = 0.005) {
  const out = { frames: heads.length };
  for (const k of ["yaw", "pitch", "roll"]) {
    let maxStep = 0;
    let reversals = 0;
    let last = 0;
    let acc = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < heads.length; i++) {
      let d = heads[i][k] - heads[i - 1][k];
      if (k === "yaw") d = ((d + 540) % 360) - 180;
      acc += d;
      lo = Math.min(lo, acc);
      hi = Math.max(hi, acc);
      maxStep = Math.max(maxStep, Math.abs(d));
      if (Math.abs(d) > eps) {
        const sg = Math.sign(d);
        if (last && sg !== last) reversals++;
        last = sg;
      }
    }
    out[k] = { maxStepDeg: +maxStep.toFixed(3), reversals, rangeDeg: +(hi - lo).toFixed(3) };
  }
  return out;
}

/** The frames side by side on a page of their own, screenshotted: the strip PNG. */
async function strip({ name, shots, clip }, title) {
  const p = await ctx.newPage();
  // frames at most STRIP_H tall (the strips stay a few MB)
  const k = Math.min(1, STRIP_H / clip.height);
  const w = Math.round(clip.width * k);
  const h = Math.round(clip.height * k);
  const cells = shots
    .map((s) => `<figure><img width="${w}" height="${h}" src="data:image/png;base64,${s.buf.toString("base64")}"><figcaption>+${s.at} ms</figcaption></figure>`)
    .join("");
  await p.setViewportSize({ width: w * FRAMES + 8 * (FRAMES + 1), height: h + 60 });
  await p.setContent(
    `<html><body style="margin:0;background:#1d1d22;color:#ddd;font:13px sans-serif"><div style="padding:4px 8px">${title}</div><div style="display:flex;gap:8px;padding:0 8px">${cells}</div><style>figure{margin:0}img{display:block}figcaption{text-align:center;padding-top:2px}</style></body></html>`,
  );
  await p.waitForFunction(() => [...document.images].every((i) => i.complete));
  const file = join(out, `${name}.png`);
  await p.screenshot({ path: file, fullPage: true });
  await p.close();
  return file;
}

const report = [];
async function shot(name, title, who, setup, opts = {}) {
  const r = await setup();
  const f = await frames(name, who, opts);
  const file = await strip(f, title);
  const head = opts.trace ? headStats(f.heads) : null;
  report.push({ file, first: f.shots[0].anim, last: f.shots[FRAMES - 1].anim, timesMs: f.shots.map((s) => s.at), head, headTrace: opts.trace ? f.heads : undefined });
  console.log(`${file}: ${f.shots.map((s) => s.at).join(",")} ms${head ? `\n  head (${opts.trace}, ${head.frames} frames): ${JSON.stringify({ yaw: head.yaw, pitch: head.pitch, roll: head.roll })}` : ""}`);
  await r?.done;
}

/** a camera beside Old Wang's stand (he faces +x, town.json facing [0.986, 0, -0.164]; the talk stand is 1.2 m in front of him): both in profile */
const wangCam = () => hold([WANG[0] + 0.9, 1.5, WANG[1] + 4.4], [WANG[0] + 0.7, 0.9, WANG[1]], 6);
/** 4 s windows: 12 frames a third of a second apart; the head traced on every drawn frame */
const WINDOW = { step: 4000 / FRAMES, trace: "wang" };

// (a) Old Wang idle: the player out of his face range (3 m, kept to 3.5 m)
await shot("01-wang-idle", "Old Wang idle, 4 s (12 frames, 333 ms): breathing and weight shift; a glance at most every 6-12 s", ["wang"], async () => {
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), [WANG[0] + 6, WANG[1] + 5]);
  await sleep(4000);
  const done = wangCam();
  await sleep(900);
  return { done };
}, WINDOW);

// (b) in dialogue, the player standing at the talk stand
await shot("02-wang-dialogue-still", "Old Wang in dialogue, the player standing still, 4 s: aimed once, small nods only", ["wang"], async () => {
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), [WANG[0] + 2.2, WANG[1] + 0.4]);
  await sleep(1500);
  await page.evaluate(() => window.world3d.talk("wang"));
  await page.waitForFunction(() => !!window.world3d.model()?.scene, null, { timeout: 30000 });
  await sleep(3500); // the walk to the stand and the scene-start greeting are over
  const done = wangCam();
  await sleep(900);
  return { done };
}, WINDOW);

// (c) still in the scene, the player walks round him (scripted walks: the scene locks input)
await shot("03-wang-dialogue-player-walks", "Old Wang in dialogue while the player walks round him, 4 s: re-aims past a 0.6 m / 12 degree dead zone, one smooth turn each", ["wang", "player"], async () => {
  const done = hold([WANG[0] + 4.2, 2.2, WANG[1] + 3.0], [WANG[0], 0.9, WANG[1]], 7);
  await sleep(900);
  void page.evaluate(async ([cx, cz]) => {
    const w3 = window.world3d;
    for (let k = 0; k < 14; k++) {
      const a = 0.25 + k * 0.45; // round his front, 1.7 m out
      w3.walkTo(cx + Math.cos(a) * 1.7, cz + Math.sin(a) * 1.7, true);
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 80));
      while (performance.now() - t0 < 1500) {
        const [x, , z] = w3.player();
        if (Math.hypot(x - (cx + Math.cos(a) * 1.7), z - (cz + Math.sin(a) * 1.7)) < 0.12) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }, WANG);
  await sleep(400);
  return { done };
}, WINDOW);

writeFileSync(join(out, "report.json"), JSON.stringify({ url: URL_, errors, shots: report }, null, 2));
console.log(`${errors.length} console errors${errors.length ? `:\n${errors.join("\n")}` : ""}`);
await browser.close();
