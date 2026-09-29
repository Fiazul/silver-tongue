// A plugged-in gamepad (the Gamepad API). Walking, the left stick or the d-pad writes
// MoveInput.pad, the same screen-space vector as keys and the touch joystick. With a panel up (a
// dialog, the choices, the replies, the start screens) they move focus between its controls instead.
// The buttons become the keys the rest of the game already handles, so one code path serves both.
// Which button does what, and what it is called on screen, depends on the pad (padLayout): an Xbox
// or PlayStation pad confirms with the bottom face button, a Nintendo pad with the right one, a
// generic USB pad with the numbered button in the bottom position. The browser only lists a pad after
// a button press on it; there is no event per press, so this polls each frame while one is connected.
import type { MoveInput, Vec } from "./input";

export const PAD = {
  /** stick fraction that does nothing (a worn stick rests off-centre) */
  deadZone: 0.2,
  /** stick push that counts as a direction in a panel */
  navPush: 0.5,
  /** held direction in a panel: first repeat, then every */
  repeatFirstMs: 380,
  repeatMs: 140,
};

export type PadRole = "confirm" | "back" | "replay" | "notebook" | "actions" | "menu";
export type PadFamily = "xbox" | "playstation" | "nintendo" | "numbered" | "generic";

export interface PadLayout {
  family: PadFamily;
  /** role → button index in Gamepad.buttons */
  buttons: Record<PadRole, number>;
  /** role → what is printed on that button */
  labels: Record<PadRole, string>;
  /** where the d-pad reads from: four buttons (up, down, left, right), a hat as two axes (x, y), or nowhere */
  dpad: { buttons: [number, number, number, number] } | { axes: [number, number] } | null;
}

/** The pad's maker from its id: Chrome says "… (Vendor: 045e Product: 028e)", Firefox "045e-028e-…". */
export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  const vendor = /vendor: ([0-9a-f]{4})/.exec(s)?.[1] ?? /^([0-9a-f]{1,4})-[0-9a-f]{1,4}-/.exec(s)?.[1]?.padStart(4, "0");
  if (vendor === "045e" || /xbox|xinput|x-box/.test(s)) return "xbox";
  if (vendor === "054c" || /playstation|dualshock|dualsense|wireless controller/.test(s)) return "playstation";
  if (vendor === "057e" || /nintendo|pro controller|joy-con/.test(s)) return "nintendo";
  // DragonRise and the other cheap USB pads: buttons printed 1..12, 1-4 as top, right, bottom, left
  if (["0079", "0810", "0583", "11ff", "0e8f"].includes(vendor ?? "") || /generic|usb joystick|usb gamepad|twin ?shock/.test(s)) return "numbered";
  return "generic";
}

const STANDARD_DPAD = { buttons: [12, 13, 14, 15] as [number, number, number, number] };

/**
 * How this pad is played. With the browser's "standard" mapping the face buttons are by position
 * (0 bottom, 1 right, 2 left, 3 top): confirm is the bottom one, except on Nintendo pads where A is
 * on the right. Without it (a generic pad the browser doesn't know) the buttons are raw, numbered as
 * printed, 1-4 top, right, bottom, left, and the d-pad is a hat on the last two axes.
 */
export function padLayout(id: string, mapping: string, axisCount: number): PadLayout {
  const family = padFamily(id);
  if (mapping !== "standard") {
    const n = (i: number) => String(i + 1);
    const buttons = { confirm: 2, back: 1, replay: 3, notebook: 0, actions: 8, menu: 9 };
    return {
      family: family === "generic" ? "numbered" : family,
      buttons,
      labels: { confirm: n(2), back: n(1), replay: n(3), notebook: n(0), actions: n(8), menu: n(9) },
      dpad: axisCount >= 6 ? { axes: [axisCount - 2, axisCount - 1] } : null,
    };
  }
  const std = { confirm: 0, back: 1, replay: 2, notebook: 3, actions: 8, menu: 9 };
  const labels: Record<PadFamily, Record<PadRole, string>> = {
    xbox: { confirm: "A", back: "B", replay: "X", notebook: "Y", actions: "View", menu: "Menu" },
    playstation: { confirm: "✕", back: "○", replay: "□", notebook: "△", actions: "Share", menu: "Options" },
    nintendo: { confirm: "A", back: "B", replay: "X", notebook: "Y", actions: "−", menu: "+" },
    // the browser's standard mapping of a DragonRise-style pad: bottom = 3, right = 2, left = 4, top = 1
    numbered: { confirm: "3", back: "2", replay: "4", notebook: "1", actions: "9", menu: "10" },
    generic: { confirm: "A", back: "B", replay: "X", notebook: "Y", actions: "Select", menu: "Start" },
  };
  const buttons = family === "nintendo" ? { ...std, confirm: 1, back: 0, replay: 3, notebook: 2 } : std;
  return { family, buttons, labels: labels[family], dpad: STANDARD_DPAD };
}

/** The d-pad as (x right, y up), each -1, 0 or 1. */
export function dpadOf(layout: PadLayout, axes: readonly number[], pressed: (i: number) => boolean): Vec {
  const d = layout.dpad;
  if (!d) return { x: 0, y: 0 };
  if ("axes" in d) {
    const step = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.5 ? 0 : Math.sign(v));
    return { x: step(axes[d.axes[0]]), y: -step(axes[d.axes[1]]) };
  }
  const [u, dn, l, r] = d.buttons;
  return { x: (pressed(r) ? 1 : 0) - (pressed(l) ? 1 : 0), y: (pressed(u) ? 1 : 0) - (pressed(dn) ? 1 : 0) };
}

/** The walking vector (x right, y up, length 0..1): the d-pad when held, else the left stick past its dead zone, rescaled. */
export function padVector(axes: readonly number[], dpad: Vec, deadZone = PAD.deadZone): Vec {
  if (dpad.x || dpad.y) {
    const l = Math.hypot(dpad.x, dpad.y);
    return { x: dpad.x / l, y: dpad.y / l };
  }
  const x = axes[0] ?? 0;
  const y = -(axes[1] ?? 0);
  const len = Math.hypot(x, y);
  if (len <= deadZone) return { x: 0, y: 0 };
  const mag = Math.min(1, (len - deadZone) / (1 - deadZone));
  return { x: (x / len) * mag, y: (y / len) * mag };
}

/** The one direction a vector points in a panel (screen axes), or null under navPush. */
export function navDirection(v: Vec, push = PAD.navPush): Vec | null {
  if (Math.hypot(v.x, v.y) < push) return null;
  return Math.abs(v.x) > Math.abs(v.y) ? { x: Math.sign(v.x), y: 0 } : { x: 0, y: -Math.sign(v.y) };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The box to move to from `from` in `dir` (screen axes, y down): of those whose centre lies that way,
 * the nearest by edge gap, a sideways gap counting double, so a button under a text box beats a
 * wider one further down. -1 if none.
 */
export function nearestBox(from: Box, boxes: readonly Box[], dir: Vec): number {
  const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);
  const f = centre(from);
  let best = -1;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    const c = centre(b);
    if ((c.x - f.x) * dir.x + (c.y - f.y) * dir.y <= 1) return;
    const xGap = gap(from.x, from.x + from.w, b.x, b.x + b.w);
    const yGap = gap(from.y, from.y + from.h, b.y, b.y + b.h);
    const score = dir.x ? xGap + yGap * 2 : yGap + xGap * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export interface GamepadHooks {
  /** the panel the pad navigates, or null: the pad walks */
  scope(): HTMLElement | null;
  /** the world takes walking now (no dialog, fade, cutscene, start screen) */
  canWalk(): boolean;
  /** Start */
  menu(): void;
  /** Back / Select: the action bar (notebook, travel, sleep, menu) */
  actions(): HTMLElement | null;
  /** a pad was used: its button names on screen, focus rings */
  onUse(layout: PadLayout): void;
}

const FOCUSABLE = "button, [tabindex], input, select, textarea, a[href]";

export class GamepadControls {
  private prev: boolean[] = [];
  private raf = 0;
  private navDir: Vec | null = null;
  private navNext = 0;
  private layout: PadLayout | null = null;
  private layoutOf = "";

  constructor(
    private move: MoveInput,
    private hooks: GamepadHooks,
  ) {
    window.addEventListener("gamepadconnected", () => this.start());
    window.addEventListener("gamepaddisconnected", () => {
      if (!this.pad()) this.stop();
    });
    if (this.pad()) this.start();
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    return pads.find((p): p is Gamepad => !!p && p.connected) ?? null;
  }

  private start() {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.poll(performance.now());
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.prev = [];
    this.layout = null;
    this.move.pad = { x: 0, y: 0 };
  }

  private poll(now: number) {
    const pad = this.pad();
    if (!pad) return;
    const of = `${pad.id}|${pad.mapping}|${pad.axes.length}`;
    if (!this.layout || of !== this.layoutOf) {
      this.layout = padLayout(pad.id, pad.mapping, pad.axes.length);
      this.layoutOf = of;
    }
    const lay = this.layout;
    const down = pad.buttons.map((b) => b.pressed);
    const pressed = (i: number) => !!down[i];
    const was = this.prev;
    const edge = (role: PadRole) => pressed(lay.buttons[role]) && !was[lay.buttons[role]];
    this.prev = down;
    const v = padVector(pad.axes, dpadOf(lay, pad.axes, pressed));
    if (down.some(Boolean) || v.x || v.y) this.hooks.onUse(lay);

    const scope = this.hooks.scope();
    if (scope) {
      this.move.pad = { x: 0, y: 0 };
      this.navigate(scope, navDirection(v), now);
    } else {
      this.navDir = null;
      this.move.pad = this.hooks.canWalk() ? v : { x: 0, y: 0 };
    }

    if (edge("confirm")) this.accept(scope);
    if (edge("back")) this.back(scope);
    if (edge("replay")) key("r");
    if (edge("notebook")) key("n");
    if (edge("menu")) this.hooks.menu();
    if (edge("actions")) this.focusFirst(this.hooks.actions());
  }

  private navigate(scope: HTMLElement, dir: Vec | null, now: number) {
    if (!dir) {
      this.navDir = null;
      return;
    }
    const same = this.navDir && this.navDir.x === dir.x && this.navDir.y === dir.y;
    if (same && now < this.navNext) return;
    this.navNext = now + (same ? PAD.repeatMs : PAD.repeatFirstMs);
    this.navDir = dir;
    const items = focusables(scope);
    const active = document.activeElement as HTMLElement | null;
    if (!active || !items.includes(active)) return this.focusFirst(scope);
    const boxes = items.map(box);
    const i = nearestBox(box(active), boxes, dir);
    if (i >= 0) focus(items[i]);
  }

  private accept(scope: HTMLElement | null) {
    const active = document.activeElement as HTMLElement | null;
    const inside = !!scope && !!active && scope.contains(active) && active !== scope;
    if (!scope) return void key("e");
    if (inside && (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement)) return active.click();
    if (!key("Enter", inside ? active : scope) && !inside) this.focusFirst(scope);
  }

  private back(scope: HTMLElement | null) {
    if (key("Escape")) return;
    if (scope instanceof HTMLDialogElement && scope.open) {
      if (scope.dispatchEvent(new Event("cancel", { cancelable: true }))) scope.close();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
  }

  private focusFirst(scope: HTMLElement | null) {
    const first = scope && focusables(scope)[0];
    if (first) focus(first);
  }
}

function focusables(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) =>
      n !== scope &&
      (n.tabIndex >= 0 || n.getAttribute("role") === "radio") &&
      !(n as HTMLButtonElement).disabled && n.getAttribute("aria-disabled") !== "true" && n.getClientRects().length > 0,
  );
}

function box(n: HTMLElement): Box {
  const r = n.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function focus(n: HTMLElement) {
  n.focus({ preventScroll: false, focusVisible: true } as FocusOptions);
  n.scrollIntoView?.({ block: "nearest" });
}

/** A key press as the keyboard would send it, on the focused control; true if a handler used it. */
function key(k: string, target: Element | null = document.activeElement): boolean {
  const on = target && target !== document.body ? target : window;
  const down = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  on.dispatchEvent(down);
  on.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
  return down.defaultPrevented;
}
