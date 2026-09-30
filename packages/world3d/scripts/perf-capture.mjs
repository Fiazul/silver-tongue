// Performance capture (README "Performance"): `?perf=1` pages (src/perf.ts) in headless Chrome on
// this machine's GPU (ANGLE Vulkan), each tier (TIERS, default full,lite) x viewport (desktop
// 1920x1080 DPR 1; phone 1080x2400 device pixels, DPR 2.6, a touch device's user agent) x scenario
// (spot: Market Street by the noodle shop, midday, HUD off; flyover: the canonical fly-over from its
// start), SECONDS (10) recorded each. Also each page's load: first-frame time, bytes fetched
// before it, the env build, and a second visit in the same context (the env cache).
// vsync and Chrome's frame cap are off (CHROME_ARGS) so rAF intervals track the work; `fps=0` in
// the query keeps the game's own pacing off too (the default FPS_Q), so the tables compare work.
//
//   URL=http://127.0.0.1:8190/ node scripts/perf-capture.mjs shots/perf/before.md
//
// Phone numbers are emulated pixels on this machine's GPU: desktop Chrome emulating a phone does
// not model the phone's GPU; the tables report its pixel count so the phone cost can be scaled.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PW = process.env.PLAYWRIGHT ?? "/home/fiazul/Desktop/chinese_immi/node_modules/playwright/index.mjs";
const { chromium } = await import(PW);
const URL_ = process.env.URL ?? "http://127.0.0.1:8190/";
const out = process.argv[2] ?? "shots/perf/capture.md";
const SECONDS = Number(process.env.SECONDS ?? 10);
const TIERS = (process.env.TIERS ?? "full,lite").split(",");
const VIEWS = (process.env.VIEWS ?? "desktop,phone").split(",");
const SCENARIOS = (process.env.SCENARIOS ?? "spot,flyover").split(",");
/** extra query for every page (e.g. "&fps=30"); FPS_Q the pacing (default: off, `fps=0`, where the build knows it) */
const EXTRA_Q = process.env.EXTRA_Q ?? "";
const FPS_Q = process.env.FPS_Q ?? "&fps=0";
const TITLE = process.env.TITLE ?? "Performance capture";
const SPOT = [-15.5, 31.5];
const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit").split(" ").filter(Boolean);
/** a browser of its own for each row: a closed page's context lingers in the GPU process (its memory, its teardown) and stalled the next row's frames */
const launch = () => chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

const VIEW = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  // 1080x2400 device pixels at DPR 2.6 (OnePlus Nord CE 5 class)
  phone: {
    viewport: { width: 415, height: 923 },
    deviceScaleFactor: 2.6,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; CPH2717) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  },
};

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(1));
const r2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(2));

/** the causes perf.ts's longFrameCause gives (copied: this script runs in Node on plain JSON) */
function cause(f) {
  if (f.flags.includes("syncRead")) return "sync read-back";
  if (f.flags.includes("compile")) return "shader compile";
  if (f.flags.includes("upload")) return "texture / buffer upload";
  if (f.flags.includes("envBuild")) return "env build";
  const gpu = f.gpuTotal ?? 0;
  if (f.cpu >= 0.5 * f.interval) {
    const top = Object.entries(f.cpuPass).sort((a, b) => b[1] - a[1])[0];
    return `cpu${top ? `: ${top[0]}` : ""}`;
  }
  if (gpu >= 0.5 * f.interval) return "gpu";
  if (f.flags.includes("asset")) return "asset landed (upload / GC)";
  return "outside the frame (GC, compositor, the tab)";
}

function summarize(frames, t0) {
  // frame callbacks that drew (pacing may skip some); intervals between drawn frames
  const drawn = frames.filter((f) => f.drawn !== false);
  const iv = [];
  // the interval from one drawn frame's start to the next is that first frame's work (and whatever ran after it): charged to it
  for (let i = 1; i < drawn.length; i++) iv.push({ ms: drawn[i].t - drawn[i - 1].t, f: drawn[i - 1] });
  const after1 = iv.filter((x) => x.f.t - t0 >= 1000);
  const ms = after1.map((x) => x.ms).sort((a, b) => a - b);
  const long = after1.filter((x) => x.ms > 50);
  const causes = {};
  for (const x of long) {
    const c = cause({ ...x.f, interval: x.ms });
    causes[c] = (causes[c] ?? 0) + 1;
  }
  // a timer result over a second is a driver's garbage (a disjoint the extension didn't report): the frame's GPU is unknown
  const gpuFrames = drawn.filter((f) => f.gpu && f.gpuTotal !== null && f.gpuTotal < 1000 && !f.flags.includes("disjoint"));
  const passes = {};
  for (const f of gpuFrames) for (const [k, v] of Object.entries(f.gpu)) passes[k] = (passes[k] ?? 0) + v;
  for (const k of Object.keys(passes)) passes[k] = r2(passes[k] / gpuFrames.length);
  const cpuPasses = {};
  for (const f of drawn) for (const [k, v] of Object.entries(f.cpuPass)) cpuPasses[k] = (cpuPasses[k] ?? 0) + v;
  for (const k of Object.keys(cpuPasses)) cpuPasses[k] = r2(cpuPasses[k] / drawn.length);
  const gpuT = gpuFrames.map((f) => f.gpuTotal).sort((a, b) => a - b);
  return {
    seconds: r1((frames.at(-1)?.t - frames[0]?.t) / 1000),
    drawn: drawn.length,
    callbacks: frames.length,
    fps: r1(drawn.length / ((frames.at(-1)?.t - frames[0]?.t) / 1000)),
    mean: r2(mean(ms)),
    p95: r2(pct(ms, 0.95)),
    max: r1(ms.at(-1) ?? 0),
    over50: long.length,
    causes,
    worst: long.sort((a, b) => b.ms - a.ms).slice(0, 5).map((x) => ({ at: r1((x.f.t - t0) / 1000), ms: r1(x.ms), cpu: r1(x.f.cpu), gpu: r1(x.f.gpuTotal), flags: x.f.flags.concat(Object.entries(x.f.gl ?? {}).filter(([, v]) => v > 1).map(([k, v]) => `${k} ${v.toFixed(0)} ms`)), cpuTop: Object.entries(x.f.cpuPass).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(1)}`) })),
    cpuMean: r2(mean(drawn.map((f) => f.cpu))),
    cpuP95: r2(pct(drawn.map((f) => f.cpu).sort((a, b) => a - b), 0.95)),
    gpuMean: r2(mean(gpuT)),
    gpuP95: r2(pct(gpuT, 0.95)),
    passes,
    cpuPasses,
    calls: Math.round(mean(drawn.map((f) => f.calls))),
    triangles: Math.round(mean(drawn.map((f) => f.triangles))),
    syncReads: drawn.filter((f) => f.flags.includes("syncRead")).length,
  };
}

const loadInfo = (page) =>
  page.evaluate(() => {
    const ff = performance.getEntriesByName("world3d:first-frame")[0]?.startTime ?? null;
    const env = performance.getEntriesByName("world3d:env")[0]?.duration ?? null;
    const res = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    let bytes = nav?.transferSize ?? 0;
    let bytesAll = bytes;
    let files = 0;
    for (const r of res) {
      const b = r.transferSize || r.encodedBodySize || 0;
      bytesAll += b;
      if (ff !== null && r.responseEnd <= ff) {
        bytes += b;
        files++;
      }
    }
    return { firstFrameMs: ff === null ? null : Math.round(ff), envMs: env === null ? null : Math.round(env), bytesBeforeFirst: bytes, filesBeforeFirst: files, bytesTotal: bytesAll, look: window.world3d?.look?.() ?? null };
  });

async function run(tier, view, scenario) {
  const browser = await launch();
  const ctx = await browser.newContext(VIEW[view]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const q = `?promo=1&perf=1&look=${tier}${FPS_Q}${EXTRA_Q}`;
  await page.goto(`${URL_}${q}`);
  await page.waitForFunction(() => !!window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 180000, polling: 100 });
  await page.waitForTimeout(1500);
  const load = await loadInfo(page);
  await page.evaluate(() => window.world3d.promo("hud", false));
  await page.evaluate((d) => window.world3d.setDaylight(d), 1 / 3);
  if (scenario === "spot") {
    await page.evaluate(([x, z]) => window.world3d.teleport(x, z), SPOT);
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.world3d.perf("start"));
  } else {
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.world3d.perf("start");
      window.world3d.promo("flyover");
    });
  }
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(SECONDS * 1000);
  const rec = await page.evaluate(() => window.world3d.perf("stop"));
  const mem = await page.evaluate(() => window.world3d.perf("mem"));
  const look = await page.evaluate(() => window.world3d.look());
  let repeat = null;
  if (scenario === "spot") {
    // a second visit, same context (HTTP cache, IndexedDB kept): the load again
    await page.close();
    const p2 = await ctx.newPage();
    await p2.goto(`${URL_}${q}`);
    await p2.waitForFunction(() => !!window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 180000, polling: 100 });
    await p2.waitForTimeout(500);
    repeat = await loadInfo(p2);
    await p2.close();
  }
  await ctx.close();
  await browser.close();
  const s = summarize(rec.frames, t0);
  return { tier, view, scenario, gpuTimer: rec.gpuTimer, load, repeat, mem, look: { tier: look.tier, env: look.envLayers, grassDensity: look.grassDensity, renderScale: look.renderScale ?? 1, fps: look.fps ?? null }, errors: errors.slice(0, 5), ...s };
}

const results = [];
for (const tier of TIERS)
  for (const view of VIEWS)
    for (const scenario of SCENARIOS) {
      const r = await run(tier, view, scenario);
      results.push(r);
      console.log(`${tier} ${view} ${scenario}: mean ${r.mean} p95 ${r.p95} max ${r.max} >50 ${r.over50} gpu ${r.gpuMean} cpu ${r.cpuMean} calls ${r.calls} ${JSON.stringify(r.passes)}`);
    }

// the tables
const PASSES = ["shadow", "colour", "aoNormal", "ao", "bloom", "output", "seeThrough", "render"];
const L = [];
L.push(`# ${TITLE}`, "");
L.push(`Captured ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with scripts/perf-capture.mjs on ${URL_}, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query \`?promo=1&perf=1&look=<tier>${FPS_Q}${EXTRA_Q}\`. ${SECONDS} s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).`, "");
L.push("## Frame time (ms, rAF interval between drawn frames)", "");
L.push("| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const px = r.mem?.drawingBuffer ? `${r.mem.drawingBuffer[0]}x${r.mem.drawingBuffer[1]}` : "?";
  L.push(`| ${r.tier} | ${r.view} | ${r.scenario} | ${px} | ${r.mem?.renderScale ?? 1} | ${r.drawn} | ${r.mean} | ${r.p95} | ${r.max} | ${r.over50} | ${Object.entries(r.causes).map(([k, v]) => `${k} x${v}`).join(", ") || "-"} | ${r.cpuMean} / ${r.cpuP95} | ${r.gpuMean} / ${r.gpuP95} | ${r.calls} | ${r.triangles} | ${r.syncReads} |`);
}
L.push("", "## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)", "");
const passNames = [...new Set([...PASSES, ...results.flatMap((r) => Object.keys(r.passes))])].filter((p) => results.some((r) => r.passes[p] !== undefined));
L.push(`| tier | view | scenario | ${passNames.join(" | ")} | total |`);
L.push(`|---|---|---|${passNames.map(() => "---").join("|")}|---|`);
for (const r of results) L.push(`| ${r.tier} | ${r.view} | ${r.scenario} | ${passNames.map((p) => r.passes[p] ?? "-").join(" | ")} | ${r.gpuMean} |`);
L.push("", "## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)", "");
const cpuNames = [...new Set(results.flatMap((r) => Object.keys(r.cpuPasses)))];
L.push(`| tier | view | scenario | ${cpuNames.join(" | ")} |`);
L.push(`|---|---|---|${cpuNames.map(() => "---").join("|")}|`);
for (const r of results) L.push(`| ${r.tier} | ${r.view} | ${r.scenario} | ${cpuNames.map((p) => r.cpuPasses[p] ?? "-").join(" | ")} |`);
L.push("", "## Worst frames (> 50 ms, top 5 per row)", "");
for (const r of results.filter((r) => r.worst.length)) L.push(`- ${r.tier} ${r.view} ${r.scenario}: ${r.worst.map((w) => `${w.ms} ms at ${w.at} s (cpu ${w.cpu}, gpu ${w.gpu}, ${w.flags.join("+") || "no flags"}; ${w.cpuTop.join(", ")})`).join("; ")}`);
L.push("", "## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)", "");
L.push("| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const MB = (b) => (b / 1048576).toFixed(1);
for (const r of results.filter((r) => r.scenario === "spot"))
  L.push(`| ${r.tier} | ${r.view} | ${r.load.firstFrameMs} | ${r.load.envMs} (build ${r.load.look?.envBuildMs ?? "?"}) | ${MB(r.load.bytesBeforeFirst)} MB | ${r.load.filesBeforeFirst} | ${r.repeat?.firstFrameMs} | ${r.repeat?.envMs} (build ${r.repeat?.look?.envBuildMs ?? "?"}) | ${MB(r.repeat?.bytesBeforeFirst ?? 0)} MB | ${MB(r.mem.bytes)} | ${MB(r.mem.targetBytes)} | ${r.mem.glTextures} | ${r.mem.programs} |`);
const errs = results.filter((r) => r.errors.length);
if (errs.length) L.push("", "## Page errors", "", ...errs.map((r) => `- ${r.tier} ${r.view} ${r.scenario}: ${r.errors.join(" / ")}`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, L.join("\n") + "\n");
writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify(results, null, 1));
console.log(`wrote ${out}`);
