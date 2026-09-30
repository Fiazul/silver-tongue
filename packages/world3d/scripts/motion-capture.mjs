// Character motion contact strips (src/animator.ts): motion needs sequences, not stills. For each
// shot, 12 frames 80 ms apart, cropped around the characters, composed into one horizontal strip
// PNG (the frames laid out in a page and screenshotted by the same headless Chromium: no image
// library needed). Shots: the player idling, the player walking (WALK_SPEED), a scene with Old Wang
// (he talks, the player listens), Old Wang's greeting wave and his mix-up shrug.
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
async function frames(name, who, track = false) {
  const r = await page.evaluate(
    ({ who, n, step, track }) =>
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
        w3.afterDraw((canvas) => {
          const now = performance.now();
          if (!t0) t0 = now;
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
            resolve({ size, cells: cells.map((e) => ({ at: e.at, anim: e.anim, url: e.c.toDataURL("image/png") })) });
          }
        });
      }),
    { who, n: FRAMES, step: STEP_MS, track },
  );
  const shots = r.cells.map((c) => ({ at: c.at, anim: c.anim, buf: Buffer.from(c.url.split(",")[1], "base64") }));
  return { name, shots, clip: { width: Math.round(r.size.width), height: Math.round(r.size.height) } };
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
  const f = await frames(name, who, opts.track);
  const file = await strip(f, title);
  report.push({ file, first: f.shots[0].anim, last: f.shots[FRAMES - 1].anim, timesMs: f.shots.map((s) => s.at) });
  console.log(`${file}: ${f.shots.map((s) => s.at).join(",")} ms`);
  await r?.done;
}

// 1. idle: the player stands; a camera in front of it
await shot("01-idle-player", "Player idle: breathing, weight shift, look-around (12 frames, 80 ms)", ["player"], async () => {
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SPOT);
  await sleep(2500);
  const f = await frameOf("player");
  const [x, y, z] = f.at;
  const a = f.yaw + 0.45;
  console.log(`idle: player at ${f.at.map((v) => v.toFixed(2))} yaw ${f.yaw.toFixed(2)}`);
  const done = hold([x + Math.sin(a) * 3.4, y + 1.4, z + Math.cos(a) * 3.4], [x, y + 0.9, z], 5);
  await sleep(900);
  return { done };
});

// 2. walking: the player walks past a camera beside the path
await shot("02-walk-player", "Player walking (WALK_SPEED 3.2 m/s): leg swing + knee bend, arm counter-swing, bob, lean, steady head", ["player"], async () => {
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), [SPOT[0] - 4, SPOT[1] + 1]);
  await sleep(1200);
  const f = await frameOf("player");
  const [x, y, z] = f.at;
  const done = hold([x + 4.5, y + 1.3, z + 5.5], [x + 4.5, y + 0.9, z], 5);
  await sleep(700);
  await page.evaluate(([x2, z2]) => window.world3d.walkTo(x2, z2), [x + 12, z]);
  await sleep(1100);
  return { done };
}, { track: true });

// 3. a scene with Old Wang: he talks, the player listens
await shot("03-talk-wang", "Talking to Old Wang: he nods on the syllables and gestures; the player listens (tilt, slow nods)", ["player", "wang"], async () => {
  await page.evaluate(([x, z]) => window.world3d.teleport(x, z), [WANG[0] + 2.2, WANG[1] + 0.4]);
  await sleep(1500);
  await page.evaluate(() => window.world3d.talk("wang"));
  await page.waitForFunction(() => window.world3d.anim().npcs.wang?.state === "talk", null, { timeout: 30000 });
  await sleep(1200);
  const done = hold([WANG[0] + 0.6, 1.5, WANG[1] + 4.6], [WANG[0] + 0.6, 0.9, WANG[1]], 4);
  await sleep(700);
  return { done };
});

// 4. reactions (the scene still open: he faces the player): the greeting wave, then the mix-up shrug
await shot("04-react-greet", "Old Wang greets: hand up, waving (his right hand holds the fan: the left waves; from +250 ms into the 2 s reaction)", ["wang"], async () => {
  const done = hold([WANG[0] + 1.6, 1.5, WANG[1] - 3.2], [WANG[0], 1.0, WANG[1]], 4);
  await sleep(900);
  await page.evaluate(() => window.world3d.react("wang", "greet"));
  await sleep(250);
  return { done };
});
await shot("05-react-confused", "Old Wang, a mix-up: shoulders up, palms out, head tilt", ["wang"], async () => {
  const done = hold([WANG[0] + 1.3, 1.5, WANG[1] + 2.8], [WANG[0], 1.0, WANG[1]], 3.5);
  await sleep(900);
  await page.evaluate(() => window.world3d.react("wang", "confused"));
  await sleep(100);
  return { done };
});

writeFileSync(join(out, "report.json"), JSON.stringify({ url: URL_, errors, shots: report }, null, 2));
console.log(`${errors.length} console errors${errors.length ? `:\n${errors.join("\n")}` : ""}`);
await browser.close();
