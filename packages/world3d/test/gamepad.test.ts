// A gamepad (gamepad.ts): the walking vector from the stick / d-pad, the direction it points in a
// panel, the control it moves focus to, and how it joins keys and the touch stick in MoveInput.
import { describe, expect, it } from "vitest";
import { dpadOf, nearestBox, navDirection, PAD, padFamily, padLayout, padVector } from "../src/gamepad";
import { MoveInput } from "../src/input";

const still = { x: 0, y: 0 };
const len = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

describe("pad vector", () => {
  it("ignores a resting stick inside the dead zone", () => {
    expect(padVector([PAD.deadZone * 0.9, 0], still)).toEqual({ x: 0, y: 0 });
    expect(padVector([], still)).toEqual({ x: 0, y: 0 });
  });

  it("flips the stick's y (down positive) to up, ramps from the dead zone, clamps at 1", () => {
    const up = padVector([0, -1], still);
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(1);
    expect(len(padVector([(1 + PAD.deadZone) / 2, 0], still))).toBeCloseTo(0.5);
    expect(len(padVector([1, 1], still))).toBeCloseTo(1);
  });

  it("walks at full speed on the d-pad, which beats the stick", () => {
    expect(padVector([0, 1], { x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
    const d = padVector([0, 0], { x: 1, y: -1 });
    expect(d.x).toBeCloseTo(Math.SQRT1_2);
    expect(d.y).toBeCloseTo(-Math.SQRT1_2);
  });
});

describe("which pad", () => {
  const CHROME_XBOX = "Xbox 360 Controller (XInput STANDARD GAMEPAD)";
  const CHROME_PS = "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)";
  const CHROME_SWITCH = "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)";
  const CHROME_DRAGONRISE = "Generic   USB  Joystick   (STANDARD GAMEPAD Vendor: 0079 Product: 0006)";
  const FIREFOX_DRAGONRISE = "79-6-Generic   USB  Joystick  ";

  it("knows the maker from Chrome's and Firefox's ids", () => {
    expect(padFamily(CHROME_XBOX)).toBe("xbox");
    expect(padFamily(CHROME_PS)).toBe("playstation");
    expect(padFamily(CHROME_SWITCH)).toBe("nintendo");
    expect(padFamily(CHROME_DRAGONRISE)).toBe("numbered");
    expect(padFamily(FIREFOX_DRAGONRISE)).toBe("numbered");
    expect(padFamily("Some Pad (Vendor: 1234 Product: 0001)")).toBe("generic");
  });

  it("confirms with the bottom face button, the right one on Nintendo, and names it as printed", () => {
    const xbox = padLayout(CHROME_XBOX, "standard", 4);
    expect([xbox.buttons.confirm, xbox.labels.confirm, xbox.labels.back]).toEqual([0, "A", "B"]);
    const ps = padLayout(CHROME_PS, "standard", 4);
    expect([ps.buttons.confirm, ps.labels.confirm]).toEqual([0, "✕"]);
    const sw = padLayout(CHROME_SWITCH, "standard", 4);
    expect([sw.buttons.confirm, sw.labels.confirm, sw.buttons.back, sw.labels.back]).toEqual([1, "A", 0, "B"]);
    const dr = padLayout(CHROME_DRAGONRISE, "standard", 4);
    expect([dr.buttons.confirm, dr.labels.confirm, dr.labels.back, dr.labels.menu]).toEqual([0, "3", "2", "10"]);
  });

  it("reads an unmapped generic pad raw: printed numbers, the hat on the last two axes", () => {
    const raw = padLayout(FIREFOX_DRAGONRISE, "", 7);
    expect(raw.family).toBe("numbered");
    expect([raw.buttons.confirm, raw.labels.confirm, raw.buttons.back, raw.labels.back]).toEqual([2, "3", 1, "2"]);
    expect(raw.dpad).toEqual({ axes: [5, 6] });
    const axes = [0, 0, 0, 0, 0, 1, -1];
    expect(dpadOf(raw, axes, () => false)).toEqual({ x: 1, y: 1 });
    expect(padLayout("mystery", "", 2).dpad).toBeNull();
  });

  it("reads a standard d-pad from buttons 12-15", () => {
    const xbox = padLayout(CHROME_XBOX, "standard", 4);
    expect(dpadOf(xbox, [], (i) => i === 12 || i === 14)).toEqual({ x: -1, y: 1 });
  });
});

describe("panel direction", () => {
  it("is null under the push, else the dominant axis in screen axes (y down)", () => {
    expect(navDirection({ x: 0.2, y: 0.1 })).toBeNull();
    expect(navDirection({ x: 0.1, y: 0.9 })).toEqual({ x: 0, y: -1 });
    expect(navDirection({ x: 0.1, y: -0.9 })).toEqual({ x: 0, y: 1 });
    expect(navDirection({ x: -0.8, y: 0.3 })).toEqual({ x: -1, y: 0 });
  });
});

describe("nearest box", () => {
  const row = (y: number, x = 0) => ({ x, y, w: 100, h: 20 });
  const list = [row(0), row(30), row(60), row(30, 120)];

  it("moves down and up a list", () => {
    expect(nearestBox(list[0], list, { x: 0, y: 1 })).toBe(1);
    expect(nearestBox(list[2], list, { x: 0, y: -1 })).toBe(1);
  });

  it("prefers the box straight that way over a closer one to the side", () => {
    expect(nearestBox(list[1], [row(55, 130), row(60)], { x: 0, y: 1 })).toBe(1);
  });

  it("goes to a narrow button right under a text box before a wide one further down", () => {
    const input = { x: 424, y: 382, w: 432, h: 56 };
    expect(nearestBox(input, [{ x: 424, y: 545, w: 432, h: 48 }, { x: 424, y: 475, w: 174, h: 48 }], { x: 0, y: 1 })).toBe(1);
  });

  it("finds the one to the right, and nothing past the edge", () => {
    expect(nearestBox(list[1], list, { x: 1, y: 0 })).toBe(3);
    expect(nearestBox(list[2], list, { x: 0, y: 1 })).toBe(-1);
  });
});

describe("MoveInput with a pad", () => {
  it("walks by the pad when nothing else is held; keys and the touch stick win", () => {
    const m = new MoveInput();
    m.pad = { x: 0.5, y: 0 };
    expect(m.vector()).toEqual({ x: 0.5, y: 0 });
    m.stick = { x: 0, y: 1 };
    expect(m.vector()).toEqual({ x: 0, y: 1 });
    m.press("a");
    expect(m.vector()).toEqual({ x: -1, y: 0 });
    m.clear();
    expect(m.active).toBe(false);
  });
});
