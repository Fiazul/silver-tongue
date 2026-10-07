import { fileURLToPath } from "node:url";
import { buildCourse } from "../../../tools/src/build-course";
import type { RenderedLine } from "@silver-tongue/core";
import { describe, expect, it } from "vitest";
import { isScribeScene, romanLine, romanSegments, scribeScenes, scribeAccepts, scribeHelpAfter, scribeShowsExample } from "../src/scribe";

const course = buildCourse(fileURLToPath(new URL("../../../content", import.meta.url)), "ko-seoul").course!;

const line = (text: string, spans: [number, number][]): RenderedLine => ({ text, tokens: spans.map(([start, end], i) => ({ start, end, word: `w${i}` })) });

describe("scribe scenes", () => {
  it("are the opening: the door, Min-jun, and Grandpa Park", () => {
    expect(scribeScenes(course)).toEqual(["room-wake", "room-minjun", "street-introductions"]);
    expect(isScribeScene(course, "room-wake")).toBe(true);
    expect(isScribeScene(course, "street-again")).toBe(false);
    expect(isScribeScene(course, undefined)).toBe(false);
  });
});

describe("the fading", () => {
  it("lights help at the first miss for the first two exchanges, after three from then on", () => {
    expect([0, 1, 2, 3, 9].map(scribeHelpAfter)).toEqual([1, 1, 3, 3, 3]);
  });
  it("shows the worked example only at the very first", () => {
    expect([0, 1, 5].map(scribeShowsExample)).toEqual([true, false, false]);
  });
});

describe("accepts", () => {
  it("are none in the opening, where lines are worked out from cards and replies are picked", () => {
    expect(scribeAccepts(course, "room-wake", "call")).toEqual([]);
    expect(scribeAccepts(course, "unknown", "who")).toEqual([]);
  });
});

describe("romanSegments", () => {
  it("reads names and sentences naturally, one piece per word", () => {
    const l = line("민준 씨? 민준 씨!", [[0, 2], [3, 4], [6, 8], [9, 10]]);
    expect(romanLine(l)).toBe("Minjun ssi? Minjun ssi!");
    expect(romanSegments(l).filter((s) => s.word).map((s) => s.text)).toEqual(["Minjun", "ssi", "Minjun", "ssi"]);
  });
  it("keeps sound changes inside a word", () => {
    const text = "안녕히 계세요.";
    expect(romanLine(line(text, [[0, 3], [4, 7]]))).toBe("Annyeonghi gyeseyo.");
  });
  it("collapses a doubled ellipsis and keeps a mid-sentence word lower case", () => {
    expect(romanLine(line("네…… 안녕히 계세요.", [[0, 1], [6, 9], [10, 13]]))).toBe("Ne… annyeonghi gyeseyo.");
  });
  it("keeps a Latin name apart from the Hangul after it", () => {
    const text = "저는 Alex입니다.";
    expect(romanLine(line(text, [[0, 2], [7, 10]]))).toBe("Jeoneun Alex imnida.");
  });
});
