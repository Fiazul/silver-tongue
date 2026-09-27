// Controls nested inside something tappable (ui/dom.ts nested / tappable): a tap on a reply
// option's hint chip, ▶ or (word help) word never picks that reply, by the click, the pointer or
// touch press that begins on the control and lifts onto the row, or Enter / Space on the focused
// control; a tap on the row itself still picks it. Same for the bubble's chip, "…", ▶ and words.
import { beforeEach, describe, expect, it } from "vitest";
import type { RenderedLine } from "@silver-tongue/core";
import { makeStrings } from "../src/strings";
import { BubbleView } from "../src/ui/bubble";
import { isNestedControl, nested, tappable } from "../src/ui/dom";
import { RepliesView } from "../src/ui/replies";
import { fakeDocument, fire, installFakeDom, type FakeElement } from "./fake-dom";
import { course } from "./helpers";

const s = makeStrings(Object.assign((id: string) => id, { has: () => false }) as never);
const t = Object.assign((id: string) => id, { has: () => false }) as never;
/** a reply line with a meaning (its chip) and words (word help) */
const option: RenderedLine = (() => {
  for (const sc of course.scenes)
    for (const ex of sc.exchanges)
      for (const v of Object.values(ex.variants)) if (v.reply?.meaning && v.reply.tokens.length) return v.reply as RenderedLine;
  throw new Error("no reply line with a meaning");
})();

let picks: number[];
let heard: number;
let words: string[];
function replies() {
  picks = [];
  heard = 0;
  words = [];
  const view = new RepliesView(course, t, s, {
    onPick: (i) => picks.push(i),
    onTiles: () => {},
    onWord: (w) => words.push(w),
    onGiveUp: () => {},
    onHear: () => heard++,
  });
  view.render({ mode: "pick", options: [option, option] });
  fakeDocument.body.append(view.node as unknown as FakeElement);
  return view.node as unknown as FakeElement;
}

beforeEach(() => {
  installFakeDom();
});

describe("a reply option's nested controls never pick it", () => {
  it("the chip clicked: it opens, no reply; the row clicked outside the chip: that reply", () => {
    const node = replies();
    const row = node.querySelectorAll(".option")[1];
    const chip = row.querySelector(".hint-chip")!;
    expect(chip.getAttribute("data-nested")).toBe("");
    chip.click();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(picks).toEqual([]);
    row.querySelector(".option-text")!.click();
    expect(picks).toEqual([1]);
    row.click();
    expect(picks).toEqual([1, 1]);
  });

  it("the touch / pointer path: a press on the chip that lifts on the row (the click lands on the row) picks nothing", () => {
    const node = replies();
    const row = node.querySelectorAll(".option")[0];
    const chip = row.querySelector(".hint-chip")!;
    for (const down of ["pointerdown", "touchstart", "mousedown"]) {
      fire(chip, down);
      fire(row, "pointerup");
      fire(row, "touchend");
      fire(row, "click"); // the browser's click at the common ancestor, or retargeted to the row
      expect(picks, down).toEqual([]);
    }
    // the next real tap on the row picks (the flag doesn't stick)
    fire(row, "pointerdown");
    fire(row, "click");
    expect(picks).toEqual([0]);
  });

  it("the lift on the chip stops there (no pointerup / touchend reaches the row)", () => {
    const node = replies();
    const row = node.querySelectorAll(".option")[0];
    const chip = row.querySelector(".hint-chip")!;
    const seen: string[] = [];
    for (const type of ["pointerup", "touchend", "click"]) row.addEventListener(type, () => seen.push(type));
    fire(chip, "pointerdown");
    fire(chip, "pointerup");
    fire(chip, "touchend");
    fire(chip, "click");
    expect(seen).toEqual([]);
    expect(picks).toEqual([]);
  });

  it("the keyboard: Enter / Space on the focused chip opens it and never picks; on the focused row they pick", () => {
    const node = replies();
    const row = node.querySelectorAll(".option")[1];
    const chip = row.querySelector(".hint-chip")!;
    const keysAtRow: string[] = [];
    row.addEventListener("keydown", (e: { key: string }) => keysAtRow.push(e.key));
    for (const key of ["Enter", " "]) fire(chip, "keydown", { key });
    expect(keysAtRow).toEqual([]);
    expect(picks).toEqual([]);
    fire(row, "keydown", { key: "Enter" });
    fire(row, "keydown", { key: " " });
    expect(picks).toEqual([1, 1]);
  });

  it("the ▶ says the option without picking it", () => {
    const node = replies();
    const row = node.querySelectorAll(".option")[0];
    const play = row.querySelectorAll("button.icon").at(-1)!;
    expect(play.getAttribute("data-nested")).toBe("");
    fire(play, "pointerdown");
    play.disabled = false;
    play.click();
    fire(row, "click");
    expect(picks).toEqual([]);
  });

  it("word help: a word looks up, never picks", () => {
    const node = replies();
    node.querySelector(".replies-title .help")!.click(); // word help on
    const row = node.querySelectorAll(".option")[0];
    const word = row.querySelector(".tok.tappable")!;
    expect(word.getAttribute("data-nested")).toBe("");
    word.click();
    expect(words.length).toBe(1);
    expect(picks).toEqual([]);
  });
});

describe("the bubble's nested controls", () => {
  it("the chip, the … and the ▶ and each word are fenced: nothing reaches a handler round the bubble", () => {
    const view = new BubbleView(course, s, { onWord: () => {}, onSentence: () => {}, onReplay: () => {} });
    const line = Object.values(course.scenes[0].exchanges[0].variants)[0].npc;
    view.render({ seq: 1, npc: "wang", npcName: "Old Wang", line, kind: "line", slow: false, fresh: [], audio: ["x"] });
    const node = view.node as unknown as FakeElement;
    let outer = 0;
    tappable(node as unknown as HTMLElement, () => outer++);
    const inner = [node.querySelector(".bubble-line .hint-chip")!, ...node.querySelectorAll(".bubble-tools button"), node.querySelector(".tok.tappable")!];
    expect(inner.length).toBeGreaterThanOrEqual(4);
    for (const c of inner) {
      expect(c.getAttribute("data-nested")).toBe("");
      fire(c, "pointerdown");
      c.click();
      fire(node, "click");
    }
    expect(outer).toBe(0);
  });
});

describe("the guard itself", () => {
  it("isNestedControl: inside a marked control yes, the row itself or plain content no", () => {
    const doc = installFakeDom();
    const row = doc.createElement("div");
    const chip = nested(doc.createElement("button") as unknown as HTMLElement) as unknown as FakeElement;
    const inner = doc.createElement("span");
    chip.append(inner);
    const plain = doc.createElement("span");
    row.append(chip, plain);
    const ev = (target: FakeElement) => ({ target }) as unknown as Event;
    expect(isNestedControl(ev(inner), row as unknown as Element)).toBe(true);
    expect(isNestedControl(ev(chip), row as unknown as Element)).toBe(true);
    expect(isNestedControl(ev(plain), row as unknown as Element)).toBe(false);
    expect(isNestedControl(ev(row), row as unknown as Element)).toBe(false);
  });
});
