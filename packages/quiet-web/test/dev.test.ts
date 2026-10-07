import { describe, expect, it } from "vitest";
import { createCore, mulberry32, newGame, type Course } from "@silver-tongue/core";
import { deskPapers } from "@silver-tongue/view";
import { readFileSync } from "node:fs";
import { deskSteps, driveTo, lastScreen, maxScreen, screenOf } from "../src/dev";
import { createQuiet, type PaperStore } from "../src/quiet";

const course = JSON.parse(readFileSync(new URL("../../../dist/courses/ko-seoul/en.json", import.meta.url), "utf8")) as Course;
const P = deskSteps(course).length;

function fresh() {
  const core = createCore(course, newGame(course), { now: () => 1_000_000, rng: mulberry32(1) });
  let clock = 1_000_000;
  const advance = () => void (clock += 1000);
  const store = { ids: [] as string[], progress: undefined as unknown };
  const papers: PaperStore = {
    load: () => store.ids,
    save: (ids) => void (store.ids = ids),
    saveProgress: (p) => void (store.progress = p),
  };
  const q = createQuiet({ course, core, now: () => clock, papers });
  return { q, core, store, advance };
}

describe("screen numbering", () => {
  it("a fresh game is the crawl, then the name screen", () => {
    const { q } = fresh();
    expect(screenOf(q)).toBe(1);
    expect(screenOf(q, true)).toBe(2);
  });
  it("papers, the knock and exchanges follow in order", () => {
    const { q } = fresh();
    expect(P).toBeGreaterThan(0);
    q.setName("Dev");
    expect(screenOf(q)).toBe(3);
    q.readPaper(deskSteps(course)[0].id);
    expect(screenOf(q)).toBe(4);
    for (const p of deskSteps(course)) q.readPaper(p.id);
    expect(screenOf(q)).toBe(3 + P);
  });
});

describe("jumping", () => {
  const exchanges = 10;
  for (let n = 1; n <= lastScreen(course, exchanges); n++) {
    it(`screen ${n}`, () => {
      const { q, core, advance } = fresh();
      expect(driveTo(q, n, advance, n === 2)).toBe(n);
      // the driver only ever picks the right reply
      expect(core.state.run?.misses ?? 0).toBe(0);
      expect(Object.values(core.state.words).reduce((a, w) => a + w.wrong, 0)).toBe(0);
      expect(screenOf(q, n === 2)).toBe(n);
      if (n > 3 + P) expect(["pick", "tiles", "type"]).toContain(q.view().phase.kind);
    });
  }
  it("never goes past the clamp", () => {
    expect(maxScreen(course)).toBe(3 + P + 60);
  });
  it("saves papers read and letters met as normal play does", () => {
    const { q, store, advance } = fresh();
    driveTo(q, 5, advance);
    expect(store.ids).toEqual(deskPapers(course).slice(0, 2).map((p) => p.id));
    expect((store.progress as { met: string[] }).met.length).toBeGreaterThan(0);
  });
});
