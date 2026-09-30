// The phone HUD's coverage guard on the rendered page (README "Phone HUD"): reads the report
// look-capture.mjs SET=phone-hud wrote (REPORT=file) and fails unless, at 390x844 with the phone
// HUD on, the idle chrome covers at most 12% of the viewport and nothing reaches the centre
// 60% x 50%, a dialogue sheet open (3 replies) at most 30%, nothing sits within 8 px of the
// screen's edge, and no page logged an error.
//   node scripts/phone-hud-check.mjs shots/look/phone-hud/report.json
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "shots/look/phone-hud/report.json";
const r = JSON.parse(readFileSync(file, "utf8")).phoneHud;
const fails = [];
const check = (ok, msg) => (ok ? console.log(`ok   ${msg}`) : (fails.push(msg), console.log(`FAIL ${msg}`)));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
if (!r) throw new Error(`${file}: no phoneHud section (run SET=phone-hud with REPORT=${file})`);
for (const s of ["idle", "guide", "dialogue", "goto", "menu", "notebook"]) check(!!r[s], `${s}: captured`);
check(r.idle?.phoneHud === true, "idle: the phone HUD is on at 390x844");
check(r.idle?.coverage <= 0.12, `idle: chrome covers ${pct(r.idle?.coverage)} (at most 12%)`);
check(r.idle?.centre.length === 0, `idle: nothing in the centre 60% x 50% [${r.idle?.centre}]`);
check(r.guide?.coverage <= 0.12, `guide line open: ${pct(r.guide?.coverage)} (at most 12%)`);
check(r.guide?.centre.length === 0, `guide line open: nothing in the centre [${r.guide?.centre}]`);
check(r.replies >= 3, `dialogue: ${r.replies} replies`);
check(r.dialogue?.coverage <= 0.3, `dialogue: chrome covers ${pct(r.dialogue?.coverage)} (at most 30%)`);
for (const s of ["idle", "guide", "dialogue", "goto"]) check(r[s]?.nearEdge.length === 0, `${s}: nothing within 8 px of the edge [${r[s]?.nearEdge}]`);
check(r.errors.length === 0, `console errors: ${r.errors.length}`);
if (fails.length) {
  console.log(`${fails.length} failed`);
  process.exit(1);
}
