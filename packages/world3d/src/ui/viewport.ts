// Screen layout: where each overlay panel may sit for a viewport (CSS px) and its safe-area insets.
// The one source of truth for phone geometry: Overlay.layout writes these rects as CSS custom
// properties (--<name>-x/-y/-w/-h/-bottom) that page.css positions the compact layout from, and the
// speech bubble / prompt / gloss popover clamp into them. Pure maths, no DOM: the overflow tests
// (test/viewport.test.ts) run it at phone sizes in both orientations.
//
// Compact (a phone, either way up: the short side at most COMPACT_MAX):
// - portrait: HUD one row at the top, reply panel a bottom sheet (at most 45% of the height), the
//   bubble between them, the action button and column bottom-right;
// - landscape: HUD + bubble on the left two thirds, reply panel / lists in the right third.
// Otherwise (desktop, tablet) page.css's own layout applies; only the clamps come from here.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The short side (CSS px) at or under which the phone layout applies. */
export const COMPACT_MAX = 540;
/** Minimum thumb target for the action button and the notebook (CSS px). */
export const TOUCH_TARGET = 56;
/** Other action-column buttons on a phone. */
export const SMALL_TARGET = 44;
/** The compact HUD: one chip row + one objective line (page.css clips it to this height). */
export const HUD_H = 60;
/** The action button's height ("E" disc + "Talk to …"), bottom-right on a touch screen. */
export const ACTION_BUTTON = 64;
/** The most buttons the action column shows at once (notebook, travel, mentor, sleep, menu). */
export const MAX_ACTIONS = 5;
const MARGIN = 8;
const GAP = 6;
/** The bubble's tail under its box (page.css .bubble::after). */
export const BUBBLE_TAIL = 12;

export interface ScreenLayout {
  compact: boolean;
  orientation: "portrait" | "landscape";
  viewport: Rect;
  /** the viewport minus the safe-area insets */
  safe: Rect;
  hud: Rect;
  toasts: Rect;
  /** the reply panel's largest box (it sizes to its content, bottom-anchored, scrolling past this) */
  replies: Rect;
  /** the scene / travel list's largest box */
  choices: Rect;
  /** the action column (notebook, travel, …) above the action button, bottom-anchored */
  actions: Rect;
  /** the action button mirroring the prompt */
  actionButton: Rect;
  /** where a thumb landing starts the joystick */
  stickZone: Rect;
  /** where the speech bubble may sit: never under the HUD or the reply panel */
  bubble: Rect;
}

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

export function isCompact(w: number, h: number): boolean {
  return Math.min(w, h) <= COMPACT_MAX;
}

export function screenLayout(w: number, h: number, insets: Insets = NO_INSETS): ScreenLayout {
  const viewport = { x: 0, y: 0, w, h };
  const safe = { x: insets.left, y: insets.top, w: Math.max(0, w - insets.left - insets.right), h: Math.max(0, h - insets.top - insets.bottom) };
  const compact = isCompact(w, h);
  const orientation = w >= h ? "landscape" : "portrait";
  const m = MARGIN;
  // A pill: the key disc and the prompt's label, in the right half (the left half is the joystick's).
  const actionW = Math.max(ACTION_BUTTON, Math.min(220, Math.floor(safe.w / 2) - 2 * m));
  const actionButton = { x: right(safe) - m - actionW, y: bottom(safe) - m - ACTION_BUTTON, w: actionW, h: ACTION_BUTTON };
  const actionsH = TOUCH_TARGET + (MAX_ACTIONS - 1) * SMALL_TARGET + (MAX_ACTIONS - 1) * GAP;
  const actionsW = Math.min(180, Math.floor(safe.w * 0.42));
  const actions = { x: right(safe) - m - actionsW, y: actionButton.y - m - actionsH, w: actionsW, h: actionsH };
  const stick = (top: number) => ({ x: safe.x, y: top, w: Math.floor(safe.w / 2), h: bottom(safe) - top });

  if (!compact) {
    // Desktop / tablet: page.css places the panels; the bubble keeps to the upper 62% (the reply
    // panel is bottom-centre), under a HUD that may wrap to two rows.
    const hud = { x: safe.x + m, y: safe.y + m, w: safe.w - 2 * m, h: 70 };
    const top = bottom(hud) + m;
    const bubble = { x: safe.x + m, y: top, w: safe.w - 2 * m, h: Math.max(0, Math.floor(h * 0.62) - top) };
    const repliesW = Math.min(Math.floor(w * 0.96), 560);
    const replies = { x: Math.floor((w - repliesW) / 2), y: top, w: repliesW, h: bottom(safe) - m - top };
    const choicesW = Math.min(Math.floor(w * 0.92), 420);
    const choices = { x: Math.floor((w - choicesW) / 2), y: top, w: choicesW, h: bottom(safe) - m - top };
    const toasts = { x: safe.x + m, y: top, w: safe.w - 2 * m, h: Math.floor(safe.h * 0.4) };
    return { compact, orientation, viewport, safe, hud, toasts, replies, choices, actions, actionButton, stickZone: stick(top), bubble };
  }

  if (orientation === "portrait") {
    const hud = { x: safe.x + m, y: safe.y + m, w: safe.w - 2 * m, h: HUD_H };
    const repliesH = Math.min(Math.floor(h * 0.45), Math.floor(safe.h - HUD_H - 3 * m));
    const replies = { x: safe.x + m / 2, y: bottom(safe) - m / 2 - repliesH, w: safe.w - m, h: repliesH };
    const top = bottom(hud) + GAP;
    const bubble = { x: safe.x + m, y: top, w: safe.w - 2 * m, h: Math.max(0, replies.y - m - top) };
    const choicesW = Math.min(safe.w - 2 * m, 420);
    const choices = { x: safe.x + Math.floor((safe.w - choicesW) / 2), y: top, w: choicesW, h: bottom(safe) - m - top };
    const toasts = { x: hud.x, y: top, w: hud.w, h: Math.floor(safe.h * 0.3) };
    return { compact, orientation, viewport, safe, hud, toasts, replies, choices, actions, actionButton, stickZone: stick(top), bubble };
  }

  // Landscape phone: the right third holds the reply panel and the lists.
  const panelW = Math.floor(safe.w / 3) - m;
  const panel = { x: right(safe) - m - panelW, y: safe.y + m, w: panelW, h: safe.h - 2 * m };
  const hud = { x: safe.x + m, y: safe.y + m, w: panel.x - m - (safe.x + m), h: HUD_H };
  const top = bottom(hud) + GAP;
  const bubble = { x: hud.x, y: top, w: hud.w, h: bottom(safe) - m - top };
  const toasts = { x: hud.x, y: top, w: hud.w, h: Math.floor(safe.h * 0.4) };
  return { compact, orientation, viewport, safe, hud, toasts, replies: panel, choices: { ...panel }, actions, actionButton, stickZone: stick(top), bubble };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** A usable Rect (every field a finite number), else a 0x0 box at the origin: the shared fallback so a caller with no real geometry yet still gets a defined, on-screen answer. */
const safeArea = (area: Rect | null | undefined): Rect => (area && finite(area.x) && finite(area.y) && finite(area.w) && finite(area.h) ? area : { x: 0, y: 0, w: 0, h: 0 });
const safeNum = (n: number | null | undefined, fallback: number): number => (finite(n) ? n : fallback);

/**
 * Top-left for a box of size (w, h) that wants its top-left at (x, y), kept inside `area`
 * (top-left wins when it can't fit). Never throws: a missing/non-finite `area`, size or position
 * (the layout not computed yet, an NPC's head position that failed to project) falls back to a 0x0
 * box at the origin rather than reading a property of `undefined`.
 */
export function clampBox(x: number, y: number, w: number, h: number, area: Rect | null | undefined): { x: number; y: number } {
  const a = safeArea(area);
  const bw = safeNum(w, 0);
  const bh = safeNum(h, 0);
  return {
    x: Math.max(a.x, Math.min(right(a) - bw, safeNum(x, a.x))),
    y: Math.max(a.y, Math.min(bottom(a) - bh, safeNum(y, a.y))),
  };
}

/**
 * The speech bubble's top-left for a head projected at (hx, hy): centred above the head, tail
 * down, clamped inside `area`. A head off-screen (or behind the camera), a non-finite projection,
 * or a missing/invalid `area`/size (the layout not computed yet, an NPC actor lookup that came back
 * undefined) all pin the bubble top-centre of the area instead of throwing (`pinned`: the tail is
 * hidden, it points nowhere).
 */
export function placeBubble(hx: number, hy: number, headVisible: boolean, w: number, h: number, area: Rect | null | undefined): { x: number; y: number; pinned: boolean } {
  const areaOk = !!area && finite(area.x) && finite(area.y) && finite(area.w) && finite(area.h);
  const a = safeArea(area);
  const bw = safeNum(w, 0);
  const bh = safeNum(h, 0);
  if (!areaOk || !headVisible || !finite(hx) || !finite(hy)) {
    const p = clampBox(a.x + (a.w - bw) / 2, a.y, bw, bh, a);
    return { ...p, pinned: true };
  }
  // The tail hangs BUBBLE_TAIL under the box: keep that inside the area too.
  const p = clampBox(hx - bw / 2, hy - BUBBLE_TAIL - bh, bw, bh, { ...a, h: a.h - BUBBLE_TAIL });
  return { ...p, pinned: false };
}

/** The rects Overlay.layout writes as CSS custom properties. */
export const LAYOUT_VARS = ["hud", "toasts", "replies", "choices", "actions", "actionButton", "bubble"] as const;

/** CSS custom properties for a layout: --<name>-x/-y/-w/-h and -bottom / -right (distance from the viewport's bottom / right edge). */
export function layoutVars(l: ScreenLayout): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LAYOUT_VARS) {
    const r = l[name];
    const k = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out[`--${k}-x`] = `${r.x}px`;
    out[`--${k}-y`] = `${r.y}px`;
    out[`--${k}-w`] = `${r.w}px`;
    out[`--${k}-h`] = `${r.h}px`;
    out[`--${k}-bottom`] = `${l.viewport.h - bottom(r)}px`;
    out[`--${k}-right`] = `${l.viewport.w - right(r)}px`;
  }
  return out;
}
