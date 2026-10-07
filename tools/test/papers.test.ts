import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deskPapers, extra, readsAs, romanize } from "@silver-tongue/view";
import { buildCourse } from "../src/build-course";
import { paperMessageIds, paperProblems } from "../src/papers";

const CONTENT = fileURLToPath(new URL("../../content", import.meta.url));
const ok = { papers: [{ id: "idcard", kind: "card", names: "room", lines: [{ id: "name", text: "김민준" }, { id: "born", text: "760314", say: "칠육공삼일사" }] }] };

describe("papers.json", () => {
  it("accepts a friend reward and rejects invalid reward ids", () => {
    expect(paperProblems({ papers: [{ ...ok.papers[0], reward: "friend" }] }, ["room"])).toEqual([]);
    expect(paperProblems({ papers: [{ ...ok.papers[0], reward: "a b" }] }, ["room"]).join("\n")).toContain("reward must be a simple id");
  });

  it("accepts a well-formed desk", () => expect(paperProblems(ok, ["room"])).toEqual([]));
  it("accepts a name printed in Latin letters beside the Hangul, as on an ID card", () =>
    expect(paperProblems({ papers: [{ ...ok.papers[0], lines: [...ok.papers[0].lines, { id: "latin", text: "KIM MIN-JUN", say: "김민준", latin: true }] }] }, ["room"])).toEqual([]));

  it.each([
    [{ papers: [] }, '"papers" must be a non-empty list'],
    [{ papers: [{ ...ok.papers[0], id: "a b" }] }, "id must be"],
    [{ papers: [ok.papers[0], ok.papers[0]] }, "used twice"],
    [{ papers: [{ ...ok.papers[0], kind: "poster" }] }, "kind must be"],
    [{ papers: [{ ...ok.papers[0], names: "moon" }] }, "is not a place"],
    [{ papers: [{ ...ok.papers[0], lines: [] }] }, '"lines" must be a non-empty list'],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: " " }] }] }, "has no text"],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: "Kim 민준" }] }] }, "only use Hangul"],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: "민준", say: "min" }] }] }, "say must be Hangul"],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: "Kim Minjun", say: "김민준", latin: true }] }] }, "capital Latin letters"],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: "KIM MINJUN", latin: true }] }] }, "needs its Hangul say"],
    [{ papers: [{ ...ok.papers[0], lines: [{ id: "x", text: "KIM MINJUN", say: "김민준" }] }] }, "only use Hangul"],
  ])("rejects %j", (json, problem) => expect(paperProblems(json, ["room"]).join("\n")).toContain(problem));

  it("needs the knock, what each paper tells, and the renamed place", () => expect(paperMessageIds(ok.papers as never)).toEqual(["desk-done", "paper-idcard-learned", "place-room-known"]));
});

describe("ko-seoul's desk", () => {
  const { course, errors } = buildCourse(CONTENT, "ko-seoul");
  const papers = course ? (extra(course).papers ?? []) : [];

  it("builds without errors, four papers, each line with a clip", () => {
    expect(errors).toEqual([]);
    expect(deskPapers(course!).map((p) => p.id)).toEqual(["book", "idcard", "bill", "newspaper"]);
    expect(papers.map((p) => p.id)).toEqual(["book", "idcard", "bill", "newspaper"]);
    for (const l of papers.flatMap((p) => p.lines)) expect(l.audio?.length).toBeGreaterThan(0);
  });

  it("every line reads as its own romanization", () => {
    for (const l of papers.flatMap((p) => p.lines).filter((l) => !l.latin)) expect(readsAs(romanize(l.text), l.text)).toBe(true);
  });

  it.each(["zh-china", "ja-japan"])("%s has no desk", (id) => expect(extra(buildCourse(CONTENT, id).course!).papers).toBeUndefined());
});
