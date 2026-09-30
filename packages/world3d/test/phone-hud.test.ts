// The phone HUD (ui/viewport.ts phoneHud, page.css "Phone HUD", ui/hud.ts, ui/icons.ts): the
// coverage guard (idle: the HUD pieces cover at most 12% of the viewport and none reaches the
// centre 60% x 50%; a dialogue sheet open: at most 30%), every piece inside the safe area and 8 px
// clear of it, 44 px targets, the one glass material (no ink outlines), the guide line's fold, the
// icons and their aria text, the edge arrow kept clear of the HUD. The rendered page is measured
// the same way by scripts/look-capture.mjs SET=phone-hud (scripts/phone-hud-check.mjs asserts it).
import { newGame } from "@silver-tongue/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHROME_KEYS } from "../src/strings";
import { UI_LOCALES } from "../locale";
import { GUIDE_FOLD_MS, HudView } from "../src/ui/hud";
import { ICON_NAMES, iconSvg } from "../src/ui/icons";
import { columnHeight, intersects, NO_INSETS, PH, phoneHud, PHONE_HUD_W, screenLayout, unionArea, usePhoneHud, type Insets, type Rect } from "../src/ui/viewport";
import { edgeArrow, edgeArrowClear } from "../src/wayfind";
import { fire, installFakeDom, type FakeElement } from "./fake-dom";
import { course, makeGame } from "./helpers";

const IPHONE_PORTRAIT: Insets = { top: 47, right: 0, bottom: 34, left: 0 };
const IPHONE_LANDSCAPE: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
const cases: [string, number, number, Insets][] = [
  ["portrait 390x844", 390, 844, NO_INSETS],
  ["portrait 390x844, notch", 390, 844, IPHONE_PORTRAIT],
  ["small portrait 360x640", 360, 640, NO_INSETS],
  ["small portrait 320x568", 320, 568, NO_INSETS],
  ["landscape 844x390", 844, 390, NO_INSETS],
  ["landscape 844x390, notch", 844, 390, IPHONE_LANDSCAPE],
];
const area = (r: Rect) => r.w * r.h;

describe.each(cases)("phone HUD %s", (_name, w, h, insets) => {
  const l = screenLayout(w, h, insets);
  const p = phoneHud(l, 4);
  const vp = l.viewport;
  // idle at rest: the guide line folded to its pill (it folds GUIDE_FOLD_MS after a step changes)
  const idle = [p.strip, p.guidePill, p.column];
  const idleOpen = [p.strip, p.guide, p.column];
  const dialogue = [p.menuDock, p.sheet];

  it("applies (a phone either way up)", () => {
    expect(usePhoneHud(l, false)).toBe(true);
  });

  it("idle: strip, guide pill and the icon column cover at most 12% and stay out of the centre", () => {
    expect(unionArea(idle, vp) / area(vp)).toBeLessThanOrEqual(0.12);
    for (const r of idleOpen) expect(intersects(r, p.centre), JSON.stringify(r)).toBe(false);
  });

  it("idle with the guide line open at its widest: at most 12% on a 390 x 844 phone either way up (a smaller one: 15%)", () => {
    expect(unionArea(idleOpen, vp) / area(vp)).toBeLessThanOrEqual(w * h >= 390 * 844 ? 0.12 : 0.15);
  });

  it("idle with the action button up too: still out of the centre", () => {
    expect(intersects(p.actionButton, p.centre)).toBe(false);
    expect(intersects(p.narration, p.centre)).toBe(false);
  });

  it("a dialogue sheet open: the sheet at its tallest and the ≡ cover at most 30%", () => {
    expect(unionArea(dialogue, vp) / area(vp)).toBeLessThanOrEqual(0.3);
    // on a 390 x 844 phone three replies under a two-line bubble fit without scrolling: the bubble
    // 87, the rows 3 x 44 + 2 x 8, the replies' padding 18, the sheet's hairline 2
    if (w < h && h >= 800) expect(p.sheet.h).toBeGreaterThanOrEqual(87 + 3 * 44 + 2 * 8 + 18 + 2);
  });

  it("every piece inside the safe area, 8 px clear of its edge", () => {
    const s = l.safe;
    for (const [k, r] of Object.entries(p)) {
      if (k === "centre") continue;
      expect(r.x, k).toBeGreaterThanOrEqual(s.x + PH.edge);
      expect(r.y, k).toBeGreaterThanOrEqual(s.y + PH.edge);
      expect(r.x + r.w, k).toBeLessThanOrEqual(s.x + s.w - PH.edge);
      expect(r.y + r.h, k).toBeLessThanOrEqual(s.y + s.h - PH.edge);
    }
  });

  it("pieces shown together never overlap (idle: strip, guide, column, action button, a narration line; a sheet: ≡, sheet)", () => {
    const shown = [p.strip, p.guide, p.column, p.actionButton, p.narration];
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(intersects(shown[i], shown[j]), `${i} ${j}`).toBe(false);
    expect(intersects(p.menuDock, p.sheet)).toBe(false);
    // five buttons (the mentor's too) still clear of the guide line
    expect(intersects(phoneHud(l, 5).column, p.guide)).toBe(false);
  });

  it("44 px targets: the round buttons, the ≡, the action button", () => {
    expect(p.column.w).toBe(44);
    expect(p.column.h).toBe(columnHeight(4));
    expect(p.menuDock.w).toBeGreaterThanOrEqual(44);
    expect(p.menuDock.h).toBeGreaterThanOrEqual(44);
    expect(p.actionButton.h).toBeGreaterThanOrEqual(44);
  });
});

describe("where the phone HUD applies", () => {
  it("a phone, a coarse pointer, a window under 700 px; a desktop keeps its layout", () => {
    expect(usePhoneHud(screenLayout(1280, 720), false)).toBe(false);
    expect(usePhoneHud(screenLayout(1280, 720), true)).toBe(true);
    expect(usePhoneHud(screenLayout(PHONE_HUD_W - 1, 900), false)).toBe(true);
    expect(usePhoneHud(screenLayout(PHONE_HUD_W, 900), false)).toBe(false);
  });

  it("a narrow desktop window gets the same pieces, out of the centre", () => {
    const l = screenLayout(600, 900);
    const p = phoneHud(l, 4);
    for (const r of [p.strip, p.guide, p.column, p.actionButton, p.narration]) expect(intersects(r, p.centre)).toBe(false);
    expect(unionArea([p.strip, p.guide, p.column], l.viewport) / (600 * 900)).toBeLessThanOrEqual(0.12);
  });
});

describe("unionArea", () => {
  it("counts an overlap once and clips to the viewport", () => {
    const vp = { x: 0, y: 0, w: 100, h: 100 };
    expect(unionArea([{ x: 0, y: 0, w: 10, h: 10 }], vp)).toBe(100);
    expect(unionArea([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], vp)).toBe(175);
    expect(unionArea([{ x: 95, y: 95, w: 10, h: 10 }], vp)).toBe(25);
    expect(unionArea([], vp)).toBe(0);
  });
});

describe("page.css: the phone HUD's material", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/page.css", import.meta.url)), "utf8");
  const phone = css.slice(css.indexOf("Phone HUD (html.phone-hud"));
  const rules = phone.split("}").filter((r) => r.includes("html.phone-hud"));

  it("translucent dark glass with a hairline and an 8 px blur", () => {
    expect(phone).toContain("--ph-bg: rgba(20, 18, 14, 0.55)");
    expect(phone).toContain("--ph-line: 1px solid rgba(255, 255, 255, 0.12)");
    expect(phone).toContain("--ph-blur: blur(8px)");
  });

  it("no ink outlines or hard ink shadows anywhere in it", () => {
    for (const r of rules) {
      expect(r, r).not.toMatch(/var\(--border\)|2px solid var\(--ink\)|var\(--lift\)|var\(--shadow\)|var\(--chip-lift\)/);
    }
  });

  it("the sheet slides up in 160 ms ease-out; nothing bounces (no scale in the phone keyframes)", () => {
    expect(phone).toMatch(/@keyframes ph-up \{ from \{ opacity: 0; transform: translateY\(16px\); \} \}/);
    expect(phone).toMatch(/\.sheet \{[^}]*animation: ph-up 160ms ease-out/);
    const frames = phone.match(/@keyframes ph-[^{]+\{[^}]*\}[^}]*\}/g) ?? [];
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const f of frames) expect(f).not.toMatch(/scale/);
  });

  it("safe areas: every edge-anchored piece is placed from the --ph-* rects (viewport.ts, insets included)", () => {
    for (const sel of [".hud {", ".actions {", ".action-btn {", ".toasts {", ".sheet {", ".choices {"]) {
      const r = rules.find((x) => x.includes(`html.phone-hud ${sel}`));
      expect(r, sel).toBeDefined();
      expect(r!, sel).toMatch(/var\(--ph-/);
    }
  });

  it("a visible focus ring on the icon buttons", () => {
    expect(phone).toMatch(/\.act-btn:focus-visible \{[^}]*outline: 2px solid/);
  });
});

describe("icons", () => {
  it("inline SVG for every action, no fetch, no text", () => {
    for (const n of ["notebook", "travel", "sleep", "menu", "mentor", "route", "music", "chevron"]) expect(ICON_NAMES).toContain(n);
    for (const n of ICON_NAMES) {
      const svg = iconSvg(n);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).not.toMatch(/href|url\(|<text/);
    }
  });
});

describe("the phone HUD's strings", () => {
  it("every hud- key in bn and zh", () => {
    const keys = CHROME_KEYS.filter((k) => k.startsWith("hud-"));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const lang of ["bn", "zh"]) for (const k of keys) expect(UI_LOCALES[lang].game, `${lang} ${k}`).toHaveProperty([k]);
  });
});

describe("the HUD's phone parts (ui/hud.ts)", () => {
  afterEach(() => vi.useRealTimers());

  it("the strip's ◐ n, the ♪ and Take me there as labelled icons; the guide line folds 6 s after a new step, a tap opens it", () => {
    vi.useFakeTimers();
    installFakeDom();
    const { game } = makeGame({ ...newGame(course), player: "Mina" });
    const hud = new HudView(game.s, game.t, () => {}, () => {}, () => true);
    const node = hud.node as unknown as FakeElement;
    const o = { text: "Walk to Old Wang", kind: "story" } as never;
    hud.render(game.model.hud, o, null, { step: { n: 1, total: 5 }, take: true });
    expect(node.querySelector(".chip.slots .tiny")!.textContent).toBe(`◐ ${game.model.hud.slotsLeft}`);
    const sound = node.querySelector(".chip.sound")!;
    expect(sound.getAttribute("aria-label")).toBe(game.s("music-toggle"));
    expect(sound.querySelector(".ico")).not.toBeNull();
    const go = node.querySelector(".obj-go")!;
    expect(go.getAttribute("aria-label")).toBe(game.s("way-take"));
    expect(go.textContent).toBe(game.s("way-take"));
    const line = node.querySelector(".objective")!;
    expect(node.querySelector(".obj-pill")!.textContent).toBe("Step 1/5");
    expect(line.classList.contains("folded")).toBe(false);
    vi.advanceTimersByTime(GUIDE_FOLD_MS - 1);
    expect(line.classList.contains("folded")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(line.classList.contains("folded")).toBe(true);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    fire(line, "click");
    expect(line.classList.contains("folded")).toBe(false);
    vi.advanceTimersByTime(GUIDE_FOLD_MS);
    expect(line.classList.contains("folded")).toBe(true);
    // a new step opens it again
    hud.render(game.model.hud, { text: "Talk: tap Old Wang", kind: "story" } as never, null, { step: { n: 1, total: 5 }, take: true });
    expect(line.classList.contains("folded")).toBe(false);
  });
});

describe("the edge arrow keeps clear of the HUD (wayfind.ts edgeArrowClear)", () => {
  const view = { w: 390, h: 844 };
  const inset = { top: 46, right: 46, bottom: 64, left: 46 };

  it("an arrow under the strip moves down the same edge, one under the icon column moves off it", () => {
    const strip = { x: 8, y: 8, w: 300, h: 66 };
    const up = { x: -0.8, y: 1.6, w: 1 }; // up and a little left: the top edge, under the strip
    const a0 = edgeArrow(up, view, inset);
    expect(a0.y).toBeLessThan(strip.y + strip.h + 24);
    const a = edgeArrowClear(up, view, inset, [strip]);
    expect(a.onScreen).toBe(false);
    expect(a.y >= strip.y + strip.h + 24 || a.x >= strip.x + strip.w + 24).toBe(true);
    const column = { x: 338, y: 506, w: 44, h: 206 };
    const right = { x: 1.6, y: -0.4, w: 1 };
    const b0 = edgeArrow(right, view, inset);
    expect(b0.y > column.y - 24 && b0.y < column.y + column.h + 24).toBe(true);
    const b = edgeArrowClear(right, view, inset, [strip, column]);
    expect(b.x).toBeLessThanOrEqual(column.x - 24);
    // same direction from the centre
    expect(Math.abs(b.angle - b0.angle)).toBeLessThan(1e-9);
  });

  it("a target just below the screen with the narration line, the action button and the column in the way: the arrow lands clear of all of them", () => {
    const boxes = [
      { x: 8, y: 8, w: 237, h: 66 },
      { x: 338, y: 506, w: 44, h: 206 },
      { x: 12, y: 724, w: 366, h: 56 },
      { x: 214, y: 788, w: 168, h: 48 },
    ];
    for (const clip of [{ x: 0.5, y: -1.3, w: 1 }, { x: 0.9, y: -1.05, w: 1 }, { x: 1.2, y: -0.2, w: 1 }, { x: -0.3, y: -2, w: 1 }]) {
      const a = edgeArrowClear(clip, view, inset, boxes);
      for (const r of boxes) expect(a.x > r.x - 24 && a.x < r.x + r.w + 24 && a.y > r.y - 24 && a.y < r.y + r.h + 24, `${JSON.stringify(clip)} in ${JSON.stringify(r)}`).toBe(false);
    }
  });

  it("nothing in the way: the plain arrow", () => {
    const c = { x: -1.5, y: -0.2, w: 1 };
    expect(edgeArrowClear(c, view, inset, [{ x: 338, y: 506, w: 44, h: 206 }])).toEqual(edgeArrow(c, view, inset));
  });
});
