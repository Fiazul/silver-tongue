// The one movement input (input.ts): joystick maths (vector from the touch offset, dead zone,
// clamp at the rim), tap vs drag, and keys + joystick feeding one vector.
import { describe, expect, it } from "vitest";
import { isTap, JOYSTICK, joystickVector, knobOffset, MoveInput, toGround } from "../src/input";
import { outlineScale } from "../src/camera";

const len = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);
const R = JOYSTICK.radius;
const DEAD = R * JOYSTICK.deadZone;

describe("joystick vector", () => {
  it("is zero inside the dead zone, in every direction", () => {
    for (let a = 0; a < 360; a += 15) {
      const r = DEAD * 0.99;
      const v = joystickVector(Math.cos((a * Math.PI) / 180) * r, Math.sin((a * Math.PI) / 180) * r);
      expect(v).toEqual({ x: 0, y: 0 });
    }
    expect(joystickVector(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("points where the thumb went, screen y flipped to up", () => {
    const right = joystickVector(R, 0);
    expect(right.x).toBeCloseTo(1);
    expect(right.y).toBeCloseTo(0);
    const up = joystickVector(0, -R); // thumb pushed up the screen
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(1);
    const downLeft = joystickVector(-R, R);
    expect(Math.atan2(downLeft.y, downLeft.x)).toBeCloseTo((-3 * Math.PI) / 4);
  });

  it("ramps 0..1 from the dead zone's edge to the rim, and clamps at 1 past it", () => {
    expect(len(joystickVector(DEAD + 0.001, 0))).toBeLessThan(0.01);
    expect(len(joystickVector((DEAD + R) / 2, 0))).toBeCloseTo(0.5);
    expect(len(joystickVector(R, 0))).toBeCloseTo(1);
    expect(len(joystickVector(R * 3, R * 3))).toBeCloseTo(1);
    // monotonic with distance
    let last = 0;
    for (let d = 0; d <= R * 1.5; d += 2) {
      const m = len(joystickVector(0, d));
      expect(m).toBeGreaterThanOrEqual(last);
      last = m;
    }
  });

  it("knob stays on the rim when the thumb goes past it", () => {
    expect(knobOffset(10, 5)).toEqual({ x: 10, y: 5 });
    const k = knobOffset(300, -400);
    expect(len(k)).toBeCloseTo(R);
    expect(k.x / k.y).toBeCloseTo(300 / -400);
  });
});

describe("tap or drag", () => {
  it("a touch is a tap only when short and still", () => {
    expect(isTap(120, 3, "touch")).toBe(true);
    expect(isTap(JOYSTICK.tapMs - 1, JOYSTICK.tapPx - 1, "touch")).toBe(true);
    expect(isTap(JOYSTICK.tapMs, 0, "touch")).toBe(false); // held: the joystick
    expect(isTap(50, JOYSTICK.tapPx, "touch")).toBe(false); // dragged
    expect(isTap(80, 2, "pen")).toBe(true);
  });

  it("a mouse click has no time limit, the same distance limit", () => {
    expect(isTap(900, 3, "mouse")).toBe(true);
    expect(isTap(50, JOYSTICK.tapPx + 1, "mouse")).toBe(false);
  });
});

describe("MoveInput: keys and the joystick, one vector", () => {
  it("keys give unit vectors, diagonals normalised; releasing stops", () => {
    const m = new MoveInput();
    expect(m.press("W")).toBe(true);
    expect(m.vector()).toEqual({ x: 0, y: 1 });
    m.press("d");
    expect(len(m.vector())).toBeCloseTo(1);
    expect(m.vector().x).toBeCloseTo(Math.SQRT1_2);
    m.release("w");
    m.release("D");
    expect(m.active).toBe(false);
    expect(m.press("q")).toBe(false);
  });

  it("the joystick feeds the same vector, keeping its length (a half push walks at half speed)", () => {
    const m = new MoveInput();
    m.stick = joystickVector((DEAD + R) / 2, 0);
    expect(m.active).toBe(true);
    expect(len(m.vector())).toBeCloseTo(0.5);
    m.stick = { x: 3, y: 4 }; // never longer than 1
    expect(len(m.vector())).toBeCloseTo(1);
    m.press("arrowleft"); // keys win while held
    expect(m.vector()).toEqual({ x: -1, y: 0 });
    m.clear();
    expect(m.active).toBe(false);
  });

  it("onto the ground through the camera's axes, length kept", () => {
    const axes = { right: { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, up: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 } };
    const g = toGround({ x: 0, y: 0.5 }, axes);
    expect(len(g)).toBeCloseTo(0.5);
    expect(g.x).toBeCloseTo(-0.5 * Math.SQRT1_2);
  });
});

describe("phone outline width", () => {
  it("thicker on a phone, more on denser screens, capped with the pixel ratio at 2", () => {
    expect(outlineScale(3, false)).toBe(1);
    expect(outlineScale(1, true)).toBeGreaterThan(1);
    expect(outlineScale(2, true)).toBeGreaterThan(outlineScale(1, true));
    expect(outlineScale(3, true)).toBe(outlineScale(2, true));
  });
});
