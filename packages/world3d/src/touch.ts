// Pointer input on the canvas: mouse clicks and touch taps (tap-to-walk, tap an NPC) and the
// floating touch joystick. A touch landing in the stick zone (the left half, under the HUD) is a
// joystick candidate: released quickly without moving it is still a tap (input.ts isTap); held or
// dragged it becomes the joystick, drawn where the thumb landed, and writes MoveInput.stick, the
// same vector the keys feed. Other touches (the right half, a second finger) are taps only.
import { isTap, JOYSTICK, joystickVector, knobOffset, type MoveInput, type Vec } from "./input";
import type { Rect } from "./ui/viewport";
import { el } from "./ui/dom";

interface Press {
  id: number;
  type: string;
  x: number;
  y: number;
  t: number;
  moved: number;
  /** may turn into the joystick */
  stickable: boolean;
}

export interface PointerHooks {
  /** a tap / click at client (x, y) */
  onTap(x: number, y: number): void;
  /** false while taps and the joystick should do nothing (a dialog is open, a fade is running) */
  enabled(): boolean;
  /** the joystick zone in CSS px (from the screen layout) */
  stickZone(): Rect;
  /** first touch seen: the page switches to its touch look */
  onTouch?(): void;
}

export class PointerControls {
  private presses = new Map<number, Press>();
  /** the pointer driving the joystick, and where it landed */
  private stick: { id: number; x: number; y: number } | null = null;
  private base = el("div", { className: "stick hidden" });
  private knob = el("div", { className: "stick-knob" });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private touched = false;

  constructor(
    private canvas: HTMLElement,
    uiRoot: HTMLElement,
    private move: MoveInput,
    private hooks: PointerHooks,
  ) {
    this.base.append(this.knob);
    uiRoot.append(this.base);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.moveTo(e));
    canvas.addEventListener("pointerup", (e) => this.up(e, false));
    canvas.addEventListener("pointercancel", (e) => this.up(e, true));
    canvas.addEventListener("lostpointercapture", (e) => this.up(e, true));
  }

  /** For world3d.touch(): the last joystick vector and how many pointers are down. */
  debug(): { vector: Vec; pointers: number; stick: boolean } {
    return { vector: { ...this.move.stick }, pointers: this.presses.size, stick: !!this.stick };
  }

  /** Drop everything held (blur, a scene swap). */
  reset() {
    this.presses.clear();
    this.endStick();
  }

  private down(e: PointerEvent) {
    if (e.pointerType !== "mouse" && !this.touched) {
      this.touched = true;
      this.hooks.onTouch?.();
    }
    if (!this.hooks.enabled()) return;
    const z = this.hooks.stickZone();
    const inZone = e.clientX >= z.x && e.clientX <= z.x + z.w && e.clientY >= z.y && e.clientY <= z.y + z.h;
    const p: Press = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, stickable: e.pointerType !== "mouse" && inZone && !this.stick };
    this.presses.set(e.pointerId, p);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no capture: fine
    }
    if (p.stickable) {
      // Held still past the tap time: the joystick (at rest) under the thumb.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const q = this.presses.get(p.id);
        if (q?.stickable && !this.stick) this.startStick(q);
      }, JOYSTICK.tapMs);
    }
  }

  private moveTo(e: PointerEvent) {
    const p = this.presses.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.moved = Math.max(p.moved, Math.hypot(dx, dy));
    if (p.stickable && !this.stick && p.moved >= JOYSTICK.tapPx) this.startStick(p);
    if (this.stick?.id !== e.pointerId) return;
    if (!this.hooks.enabled()) return this.endStick();
    this.move.stick = joystickVector(dx, dy);
    const k = knobOffset(dx, dy);
    this.knob.style.transform = `translate(${k.x}px, ${k.y}px)`;
  }

  private up(e: PointerEvent, cancelled: boolean) {
    const p = this.presses.get(e.pointerId);
    if (!p) return;
    this.presses.delete(e.pointerId);
    if (this.stick?.id === e.pointerId) return this.endStick();
    if (cancelled || !this.hooks.enabled()) return;
    const moved = Math.max(p.moved, Math.hypot(e.clientX - p.x, e.clientY - p.y));
    if (isTap(performance.now() - p.t, moved, p.type)) this.hooks.onTap(e.clientX, e.clientY);
  }

  private startStick(p: Press) {
    clearTimeout(this.timer);
    p.stickable = false;
    this.stick = { id: p.id, x: p.x, y: p.y };
    this.base.style.left = `${p.x}px`;
    this.base.style.top = `${p.y}px`;
    this.knob.style.transform = "translate(0px, 0px)";
    this.base.classList.remove("hidden");
  }

  private endStick() {
    clearTimeout(this.timer);
    this.stick = null;
    this.move.stick = { x: 0, y: 0 };
    this.base.classList.add("hidden");
  }
}
