import { describe, expect, it } from "vitest";
import type { Course, RenderedLine } from "@silver-tongue/core";
import { canOpenPaper, deskReady, firstUnread, foldRomanization, readsAs, romanize, soundedTokens } from "../src/desk";
import type { CourseExtra } from "../src/course-extra";

describe("romanize", () => {
  it.each([
    ["주민등록증", "jumindeungnokjeung"],
    ["김민준", "gimminjun"],
    ["760314", "760314"],
    ["서울신문", "seoulsinmun"],
    ["2000년 9월 30일", "2000nyeon 9wol 30il"],
    ["월세 고지서", "wolse gojiseo"],
    ["50,000원", "50,000won"],
    ["한국어", "hangugeo"],
    ["합니다", "hamnida"],
    ["신라", "silla"],
    ["종로", "jongno"],
    ["설날", "seollal"],
    ["좋아", "joa"],
  ])("%s → %s", (ko, rr) => expect(romanize(ko)).toBe(rr));

  it("plain spells each syllable on its own", () => expect(romanize("주민등록증", true)).toBe("jumindeungrokjeung"));
});

describe("readsAs", () => {
  it.each([
    ["kim min jun", "김민준"],
    ["gimminjun", "김민준"],
    ["Kim Minjun", "김민준"],
    ["Kim Min-jun", "김민준"],
    ["jumin deungnok jeung", "주민등록증"],
    ["jumin deungrok jeung", "주민등록증"],
    ["chumin tungnok chung", "주민등록증"],
    ["760314", "760314"],
    ["seoul sinmun", "서울신문"],
    ["seoul shinmun", "서울신문"],
    ["Soul Sinmun", "서울신문"],
    ["2000nyeon 9wol 30il", "2000년 9월 30일"],
    ["2000 nyon 9 wol 30 il", "2000년 9월 30일"],
    ["wolse gojiseo", "월세 고지서"],
    ["wolse kojiso", "월세 고지서"],
    ["50,000won", "50,000원"],
    ["50000 won", "50,000원"],
  ])("%s reads as %s", (typed, ko) => expect(readsAs(typed, ko)).toBe(true));

  it.each([
    ["", "김민준"],
    ["kim", "김민준"],
    ["minjun kim", "김민준"],
    ["seoul", "서울신문"],
    ["5000 won", "50,000원"],
    ["760315", "760314"],
    ["jumindeungnok", "주민등록증"],
  ])("%s does not read as %s", (typed, ko) => expect(readsAs(typed, ko)).toBe(false));

  it("folds spelling variants", () => {
    expect(foldRomanization("Seo-ul")).toBe(foldRomanization("soul"));
    expect(foldRomanization("kkachi")).toBe(foldRomanization("gaji"));
  });
});

describe("soundedTokens", () => {
  const course = { language: { book: true }, papers: [{ id: "idcard", kind: "card", lines: [{ id: "name", text: "김민준" }] }] } as unknown as Course & CourseExtra;
  const line = { text: "민준 씨?", tokens: [{ word: "a", start: 0, end: 2 }, { word: "b", start: 3, end: 4 }] } as unknown as RenderedLine;

  it("marks a word whose text is inside a line of a paper already read", () => {
    expect([...soundedTokens(course, new Set(["idcard"]), line)]).toEqual([0]);
  });
  it("recognises the name when only that line was read", () => {
    expect([...soundedTokens(course, new Set(["idcard.name"]), line)]).toEqual([0]);
  });
  it("marks nothing before the paper is read", () => {
    expect(soundedTokens(course, new Set(), line).size).toBe(0);
  });
  it("ignores one-syllable words, which turn up inside other words by chance", () => {
    const one = { text: "준", tokens: [{ word: "c", start: 0, end: 1 }] } as unknown as RenderedLine;
    expect(soundedTokens(course, new Set(["idcard"]), one).size).toBe(0);
  });
});

describe("canOpenPaper", () => {
  const papers = ["idcard", "bill", "news"].map((id) => ({ id, kind: "card", lines: [] }) as unknown as Parameters<typeof canOpenPaper>[0][number]);
  it("opens read papers and the first unread, never a later one", () => {
    const open = (read: string[]) => papers.map((p) => canOpenPaper(papers, new Set(read), p.id));
    expect(open([])).toEqual([true, false, false]);
    expect(open(["idcard"])).toEqual([true, true, false]);
    expect(open(["idcard", "bill", "news"])).toEqual([true, true, true]);
  });
  it("counts a paper's required lines as done for the order too, and never holds the desk on an optional paper", () => {
    const line = (id: string) => ({ id, text: "가" });
    const desk = [
      { id: "book", kind: "masthead", required: ["title"], lines: [line("title"), line("name")] },
      { id: "news", kind: "masthead", required: [], lines: [line("title")] },
      { id: "bill", kind: "bill", required: ["title"], lines: [line("title"), line("amount")] },
    ] as unknown as Parameters<typeof canOpenPaper>[0];
    const open = (read: string[]) => desk.map((p) => canOpenPaper(desk, new Set(read), p.id));
    expect(firstUnread(desk, new Set())).toBe("book");
    expect(open([])).toEqual([true, true, false]);
    // The book's title read: the next required paper opens, though the book's name line is still unread.
    expect(firstUnread(desk, new Set(["book.title"]))).toBe("bill");
    expect(open(["book.title"])).toEqual([true, true, true]);
    expect(deskReady(desk, new Set(["book.title"]))).toBe(false);
    expect(deskReady(desk, new Set(["book.title", "bill.title"]))).toBe(true);
    expect(firstUnread(desk, new Set(["book.title", "bill.title"]))).toBeUndefined();
  });
});
