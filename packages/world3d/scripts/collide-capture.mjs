// Collision debug shots (`?collide=1`, src/collide-view.ts): every collider's outline on the ground
// (red: from the geometry, orange: an authored rect kept where a piece has none, blue: NPC stands;
// the faint ring: where the player's centre stops), in the street at a few spots and in each
// interior, landscape 1920x1080, toon look, HUD off. Headless Chromium through Playwright (as
// look-capture.mjs). Serves nothing itself: point URL at a served dist/.
//
//   URL=http://127.0.0.1:9510/ node scripts/collide-capture.mjs [outDir]
//
// ONLY=shop.png,street-plaza.png: a subset.
// Prints each shot's console error count and the page's collider count; exits 1 on any error.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PW = process.env.PLAYWRIGHT ?? "/home/fiazul/Desktop/chinese_immi/node_modules/playwright/index.mjs";
const { chromium } = await import(PW);
const URL_ = process.env.URL ?? "http://127.0.0.1:9510/";
const out = process.argv[2] ?? "shots/collision";
mkdirSync(out, { recursive: true });
const layout = JSON.parse(readFileSync(new URL("../src/layout.json", import.meta.url), "utf8"));
const args = (process.env.CHROME_ARGS ?? "--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist").split(" ").filter(Boolean);
const browser = await chromium.launch({ headless: true, args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
/** street spots: the plaza's benches, Market Street (the fruit stall, the noodle shop), the great tree, the pavilion, the gate */
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const STREET = [
  { file: "street-plaza.png", at: [-5.5, 8.5] },
  { file: "street-market.png", at: [9, 31.5] },
  { file: "street-noodle.png", at: [-15.5, 31.5] },
  { file: "street-great-tree.png", at: [-12, 9] },
  { file: "street-pavilion.png", at: [15, 11] },
  { file: "street-gate.png", at: [0, 35] },
];
let failed = 0;
const shot = async (file, go) => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${URL_}?promo=1&look=toon&collide=1`);
  await page.waitForFunction(() => window.world3d?.model?.() && document.querySelector("#loading")?.hidden, null, { timeout: 180000 });
  await go(page);
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.world3d.promo("hud", false); window.world3d.setDaylight(1 / 3); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, file) });
  const info = await page.evaluate(() => window.world3d.info());
  console.log(`${file}: space ${info.space}, ${errors.length} console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  failed += errors.length;
  await page.close();
};
for (const s of STREET.filter((s) => !ONLY.length || ONLY.includes(s.file))) await shot(s.file, (page) => page.evaluate(([x, z]) => window.world3d.teleport(x, z), s.at));
for (const [id, interior] of Object.entries(layout.interiors).filter(([id]) => !ONLY.length || ONLY.includes(`${id}.png`)))
  await shot(`${id}.png`, async (page) => {
    await page.evaluate((place) => window.world3d.teleport(place), interior.place);
    await page.waitForFunction((space) => window.world3d.info().space === space && !window.world3d.info().transitioning && document.querySelector("#loading")?.hidden, id, { timeout: 180000 });
  });
await browser.close();
process.exit(failed ? 1 : 0);
