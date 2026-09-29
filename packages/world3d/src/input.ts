// The one movement input: keyboard (WASD / arrows), the on-screen joystick and a gamepad feed a single
// screen-space vector (x right, y up the screen, length 0..1), which main.ts turns into a ground
// direction through the camera's axes. Taps (tap-to-walk, tap an NPC) are told apart from joystick
// drags by `isTap`. Pure maths, no DOM: tested in test/input.test.ts.

export const JOYSTICK = {
  /** knob travel (CSS px): a full push */
  radius: 60,
  /** fraction of the radius that does nothing (a resting thumb) */
  deadZone: 0.18,
  /** a touch shorter than this and moving less than tapPx is a tap, not a joystick */
  tapMs: 200,
  tapPx: 10,
};

export interface Vec {
  x: number;
  y: number;
}

/** The knob's offset from the base: the touch offset clamped to the radius (CSS px, screen axes). */
export function knobOffset(dx: number, dy: number, radius = JOYSTICK.radius): Vec {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

/**
 * The movement vector for a touch at (dx, dy) CSS px from where the thumb landed (screen y down).
 * Returns x right, y up; zero inside the dead zone, then 0..1 rescaled from its edge to the rim,
 * clamped at 1 past the rim. Direction is exact at every length.
 */
export function joystickVector(dx: number, dy: number, radius = JOYSTICK.radius, deadZone = JOYSTICK.deadZone): Vec {
  const len = Math.hypot(dx, dy);
  const dead = radius * deadZone;
  if (len <= dead || radius <= dead) return { x: 0, y: 0 };
  const mag = Math.min(1, (len - dead) / (radius - dead));
  return { x: (dx / len) * mag, y: (-dy / len) * mag };
}

/** A press is a tap (walk there / tap that NPC) when short and still. Mice have no time limit (a slow click is still a click). */
export function isTap(ms: number, movedPx: number, pointerType: string): boolean {
  if (movedPx >= JOYSTICK.tapPx) return false;
  return pointerType === "mouse" || ms < JOYSTICK.tapMs;
}

/** Keys that walk, as screen directions. */
export const MOVE_KEYS: Record<string, [number, number]> = {
  w: [0, 1],
  arrowup: [0, 1],
  s: [0, -1],
  arrowdown: [0, -1],
  a: [-1, 0],
  arrowleft: [-1, 0],
  d: [1, 0],
  arrowright: [1, 0],
};

/** Keyboard + joystick + gamepad in, one screen-space vector out. Keys win while any is held (they are unit length), then the touch stick. */
export class MoveInput {
  readonly keys = new Set<string>();
  stick: Vec = { x: 0, y: 0 };
  /** the gamepad's left stick / d-pad (gamepad.ts) */
  pad: Vec = { x: 0, y: 0 };

  /** true if the key walks (and is now held) */
  press(key: string): boolean {
    const k = key.toLowerCase();
    if (!MOVE_KEYS[k]) return false;
    this.keys.add(k);
    return true;
  }

  release(key: string) {
    this.keys.delete(key.toLowerCase());
  }

  clear() {
    this.keys.clear();
    this.stick = { x: 0, y: 0 };
    this.pad = { x: 0, y: 0 };
  }

  /** The screen-space movement vector, length 0..1. */
  vector(): Vec {
    let x = 0;
    let y = 0;
    for (const k of this.keys) {
      x += MOVE_KEYS[k][0];
      y += MOVE_KEYS[k][1];
    }
    const len = Math.hypot(x, y);
    if (len > 0) return { x: x / len, y: y / len };
    const v = this.stick.x || this.stick.y ? this.stick : this.pad;
    const s = Math.hypot(v.x, v.y);
    return s > 1 ? { x: v.x / s, y: v.y / s } : { ...v };
  }

  get active(): boolean {
    const v = this.vector();
    return v.x !== 0 || v.y !== 0;
  }
}

/** A screen-space vector onto the ground (x/z) through the camera's walking axes; keeps its length. */
export function toGround(v: Vec, axes: { right: Vec; up: Vec }): Vec {
  return { x: axes.right.x * v.x + axes.up.x * v.y, y: axes.right.y * v.x + axes.up.y * v.y };
}
