// Phone layout overflow (ui/viewport.ts, the rects page.css places the compact panels from): at
// 390x844 and 844x390, with and without notch / home-bar insets, every panel stays inside the
// safe area, panels shown together don't overlap, thumb targets are big enough, and the speech
// bubble is never off-screen wherever the NPC's head projects.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clampBox, placeBubble, screenLayout, SMALL_TARGET, TOUCH_TARGET, NO_INSETS, type Insets, type Rect, type ScreenLayout } from "../src/ui/viewport";

const inside = (r: Rect, outer: Rect) => r.x >= outer.x - 1e-9 && r.y >= outer.y - 1e-9 && r.x + r.w <= outer.x + outer.w + 1e-9 && r.y + r.h <= outer.y + outer.h + 1e-9;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const IPHONE_PORTRAIT: Insets = { top: 47, right: 0, bottom: 34, left: 0 };
const IPHONE_LANDSCAPE: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
const cases: [string, number, number, Insets][] = [
  ["portrait 390x844", 390, 844, NO_INSETS],
  ["portrait 390x844, notch", 390, 844, IPHONE_PORTRAIT],
  ["landscape 844x390", 844, 390, NO_INSETS],
  ["landscape 844x390, notch", 844, 390, IPHONE_LANDSCAPE],
  ["small portrait 360x640", 360, 640, NO_INSETS],
  ["small landscape 640x360", 640, 360, NO_INSETS],
];

const panels = (l: ScreenLayout) => ({ hud: l.hud, toasts: l.toasts, replies: l.replies, choices: l.choices, actions: l.actions, actionButton: l.actionButton, stickZone: l.stickZone, bubble: l.bubble });

describe.each(cases)("phone layout %s", (_name, w, h, insets) => {
  const l = screenLayout(w, h, insets);

  it("is the compact layout, the right way up", () => {
    expect(l.compact).toBe(true);
    expect(l.orientation).toBe(w > h ? "landscape" : "portrait");
  });

  it("no panel overflows the viewport or the safe area; none is empty", () => {
    for (const [name, r] of Object.entries(panels(l))) {
      expect(inside(r, l.viewport), `${name} ${JSON.stringify(r)}`).toBe(true);
      expect(inside(r, l.safe), `${name} in safe area`).toBe(true);
      expect(r.w, name).toBeGreaterThan(0);
      expect(r.h, name).toBeGreaterThan(0);
    }
  });

  it("panels on screen together don't overlap", () => {
    // in a scene: HUD, bubble, reply panel; exploring: HUD, joystick zone, action button + column
    expect(overlap(l.hud, l.replies)).toBe(false);
    expect(overlap(l.hud, l.bubble)).toBe(false);
    expect(overlap(l.bubble, l.replies)).toBe(false);
    expect(overlap(l.actionButton, l.stickZone)).toBe(false);
    expect(overlap(l.actions, l.actionButton)).toBe(false);
    expect(overlap(l.hud, l.actions)).toBe(false);
  });

  it("thumb targets: the action button is at least 56 px and in the right half", () => {
    expect(l.actionButton.h).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(l.actionButton.w).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(l.actionButton.x).toBeGreaterThanOrEqual(w / 2);
    // the action column fits a 56 px notebook button and four 44 px ones
    expect(l.actions.h).toBeGreaterThanOrEqual(TOUCH_TARGET + 4 * 44);
  });

  it(w > h ? "landscape: reply panel and lists in the right third, full height" : "portrait: reply panel a bottom sheet, at most 45% of the height", () => {
    if (w > h) {
      expect(l.replies.x).toBeGreaterThanOrEqual(l.safe.x + (l.safe.w * 2) / 3 - 1);
      expect(l.choices).toEqual(l.replies);
      expect(l.hud.x + l.hud.w).toBeLessThanOrEqual(l.replies.x);
      expect(l.bubble.x + l.bubble.w).toBeLessThanOrEqual(l.replies.x);
    } else {
      expect(l.replies.h).toBeLessThanOrEqual(h * 0.45);
      expect(l.replies.y + l.replies.h).toBeGreaterThan(l.safe.y + l.safe.h - 10); // at the bottom
      expect(l.replies.w).toBeGreaterThan(l.safe.w * 0.9); // full width
      expect(l.bubble.h).toBeGreaterThan(150); // room for a two-line bubble
    }
  });

  it("the speech bubble stays inside its area for any head position; off-screen heads pin it top-centre", () => {
    const sizes = [
      [160, 90],
      [l.bubble.w, 140],
      [l.bubble.w * 0.8, l.bubble.h - 20],
    ];
    for (const [bw, bh] of sizes)
      for (let hx = -2 * w; hx <= 3 * w; hx += w / 7)
        for (let hy = -2 * h; hy <= 3 * h; hy += h / 7) {
          const onScreen = hx >= 0 && hx <= w && hy >= 0 && hy <= h;
          const p = placeBubble(hx, hy, onScreen, bw, bh, l.bubble);
          const box = { x: p.x, y: p.y, w: bw, h: bh };
          expect(inside(box, l.bubble), `${hx},${hy} ${JSON.stringify(box)}`).toBe(true);
          expect(inside(box, l.viewport)).toBe(true);
          if (!onScreen) {
            expect(p.pinned).toBe(true);
            expect(p.y).toBe(l.bubble.y);
            expect(p.x + bw / 2).toBeCloseTo(l.bubble.x + l.bubble.w / 2);
          } else expect(p.pinned).toBe(false);
        }
    // behind the camera / NaN projections pin too
    expect(placeBubble(NaN, NaN, true, 100, 60, l.bubble).pinned).toBe(true);
  });

  it("an on-screen head gets the bubble centred right above it when there's room", () => {
    const hx = l.bubble.x + l.bubble.w / 2;
    const hy = l.bubble.y + l.bubble.h - 20;
    const p = placeBubble(hx, hy, true, 120, 60, l.bubble);
    expect(p.x + 60).toBeCloseTo(hx);
    expect(p.y + 60).toBeLessThanOrEqual(hy);
  });
});

describe("desktop layout", () => {
  it("is not compact; clamps still inside the viewport", () => {
    const l = screenLayout(1280, 800);
    expect(l.compact).toBe(false);
    for (const [name, r] of Object.entries(panels(l))) expect(inside(r, l.viewport), name).toBe(true);
    const p = placeBubble(5000, -300, false, 300, 100, l.bubble);
    expect(inside({ x: p.x, y: p.y, w: 300, h: 100 }, l.viewport)).toBe(true);
  });
});

// Category: a scene started through the topic picker (main.ts) can leave the head position, the
// NPC actor lookup or the layout's bubble rect missing for a frame; clampBox / placeBubble must
// never throw on any of them (main.ts also stopped assuming the lookup always succeeds - see
// test/world.test.ts "the topic-picker path").
describe("clampBox / placeBubble: undefined or missing inputs never throw", () => {
  const area: Rect = { x: 10, y: 20, w: 300, h: 200 };

  it("clampBox: a missing/null area, or a non-finite x/y/w/h, falls back to a finite box instead of throwing", () => {
    expect(() => clampBox(50, 50, 100, 60, undefined)).not.toThrow();
    expect(() => clampBox(50, 50, 100, 60, null)).not.toThrow();
    expect(() => clampBox(NaN, NaN, NaN, NaN, undefined)).not.toThrow();
    expect(() => clampBox(50, 50, 100, 60, {} as Rect)).not.toThrow();
    expect(() => clampBox(50, 50, 100, 60, { x: 0, y: 0, w: NaN, h: NaN })).not.toThrow();
    const p = clampBox(50, 50, 100, 60, undefined);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    // a real area, but a missing size/position: still a finite box, still inside the area
    const p2 = clampBox(undefined as unknown as number, undefined as unknown as number, undefined as unknown as number, undefined as unknown as number, area);
    expect(inside({ ...p2, w: 0, h: 0 }, area)).toBe(true);
  });

  it("placeBubble: a missing area/size/head position pins top-centre instead of throwing", () => {
    for (const bad of [undefined, null, {} as Rect, { x: NaN, y: 0, w: 100, h: 100 }]) {
      expect(() => placeBubble(50, 50, true, 120, 60, bad)).not.toThrow();
      const p = placeBubble(50, 50, true, 120, 60, bad);
      expect(p.pinned).toBe(true);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // a good area, but the head position / size missing (an NPC actor lookup or offsetWidth that
    // came back undefined): still pinned, still finite, never throws.
    expect(() => placeBubble(undefined as unknown as number, undefined as unknown as number, true, 120, 60, area)).not.toThrow();
    const p = placeBubble(undefined as unknown as number, undefined as unknown as number, true, 120, 60, area);
    expect(p.pinned).toBe(true);
    expect(inside({ x: p.x, y: p.y, w: 120, h: 60 }, area)).toBe(true);
    const p2 = placeBubble(50, 50, true, undefined as unknown as number, undefined as unknown as number, area);
    expect(() => p2).not.toThrow();
    expect(Number.isFinite(p2.x) && Number.isFinite(p2.y)).toBe(true);
    // headVisible false with everything else fine: still pins, as before.
    expect(placeBubble(50, 50, false, 120, 60, area).pinned).toBe(true);
  });
});

// Category: every list/dialog row a thumb taps (page.css) must floor to a real touch target height
// on a compact/touch layout, from one shared rule - not a size that only a coarse-pointer media
// query happens to grant (a test harness or a touchscreen laptop at desktop width can report
// `pointer: fine` even at a phone-sized viewport, per .claude/playbooks/localhost-8173.md).
describe("page.css: shared touch-target rule for dialog / list buttons", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/page.css", import.meta.url)), "utf8");
  // The rule block right before the (still-present) `@media (pointer: coarse)` companion.
  const compactRule = css.split("@media (pointer: coarse)")[0];

  it(`sets min-height: ${SMALL_TARGET}px for .choice, .option, .actions button and dialog button, gated on .compact / .touch (not only pointer: coarse)`, () => {
    for (const sel of [".choice", ".option", ".actions button", "dialog button"]) {
      expect(compactRule, `${sel} under .compact`).toMatch(new RegExp(`\\.compact ${sel.replace(/\./g, "\\.")}\\s*,`));
      expect(compactRule, `${sel} under .touch`).toMatch(new RegExp(`\\.touch ${sel.replace(/\./g, "\\.")}\\s*,?`));
    }
    expect(compactRule).toMatch(new RegExp(`min-height:\\s*${SMALL_TARGET}px`));
  });

  it("the pointer: coarse rule still covers the same selectors, as a second, independent layer", () => {
    const coarseRule = css.slice(css.indexOf("@media (pointer: coarse)"));
    for (const sel of [".choice", ".option", ".actions button", "dialog button"]) expect(coarseRule, sel).toContain(sel);
    expect(coarseRule).toMatch(new RegExp(`min-height:\\s*${SMALL_TARGET}px`));
  });
});
