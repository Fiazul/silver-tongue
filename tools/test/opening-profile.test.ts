import { describe, expect, it } from "vitest";
import { fixtureCourse } from "@silver-tongue/core/testing";
import { extra } from "@silver-tongue/view";
import { compileOpening, openingWordIds, scribeProblems, type OpeningSource } from "../src/opening-profile";

function fixture() {
  const course = fixtureCourse();
  course.words.w_ni.audio = ["clip-a"];
  course.words.w_hao.audio = ["clip-b"];
  extra(course).papers = [{ id: "kept-card", kind: "card", reward: "connection", lines: [{ id: "heading", text: "test" }] }];
  const options = Object.fromEntries(["reply", "alt1", "alt2", "silence"].map((option) => [option, { reaction: `reaction-${option}`, consequence: `later-${option}`, at: "shift" }]));
  const source: OpeningSource = {
    scenes: { intro: { glosses: true, prompt: "prompt" } },
    choices: { "intro:greet": options, "intro:menu": { reply: { reaction: "menu-reply" }, silence: { reaction: "menu-silence" } } },
    reward: { choice: "intro:greet", option: "reply", paper: "kept-card", place: "street", decoded: "decoded" },
    arrival: { scene: "intro", choice: "intro:greet", branches: { alt1: { text: "arrive", menu: "menu", audioWords: ["w_ni", "w_hao"] } }, fallback: { text: "arrive", menu: "menu" } },
    directions: { "intro:greet": "before" },
  };
  source.choices["intro:greet"].alt1.audioWords = ["w_ni", "w_hao"];
  const messages = new Set(["prompt", "decoded", "arrive", "menu", "before", ...Object.values(options).flatMap((effect) => [effect.reaction, effect.consequence]), "menu-reply", "menu-silence"]);
  return { course, source, messages };
}

describe("content-declared opening profile", () => {
  it("resolves existing word clips in declared order and removes source word references", () => {
    const { course, source, messages } = fixture();
    expect(openingWordIds(source)).toEqual(["w_ni", "w_hao", "w_ni", "w_hao"]);
    const { profile, errors } = compileOpening(source, course, messages);
    expect(errors).toEqual([]);
    expect(profile.choices["intro:greet"].alt1?.audio).toEqual(["clip-a", "clip-b"]);
    expect(profile.arrival!.branches.alt1?.audio).toEqual(["clip-a", "clip-b"]);
    expect(JSON.stringify(profile)).not.toMatch(/audioWords|w_ni|w_hao/);
    expect(source.choices["intro:greet"].alt1.audioWords).toEqual(["w_ni", "w_hao"]);
  });
  it.each(["exchange", "word", "paper", "message"] as const)("rejects a dangling %s reference", (kind) => {
    const { course, source, messages } = fixture();
    if (kind === "exchange") source.directions = { "intro:removed": "before" };
    if (kind === "word") source.choices["intro:greet"].alt1.audioWords = ["missing"];
    if (kind === "paper") source.reward!.paper = "missing";
    if (kind === "message") messages.delete("before");
    expect(compileOpening(source, course, messages).errors.length).toBeGreaterThan(0);
  });
  it("rejects an opening option with no reaction, and an arrival branch that is not an option", () => {
    const missing = fixture();
    delete (missing.source.choices["intro:menu"] as Record<string, unknown>).silence;
    expect(compileOpening(missing.source, missing.course, missing.messages).errors).toContain('opening.json: no reaction for "intro:menu/silence"');
    const stray = fixture();
    (stray.source.arrival!.branches as Record<string, unknown>).alt3 = { text: "arrive", menu: "menu" };
    expect(compileOpening(stray.source, stray.course, stray.messages).errors).toContain('opening.json: arrival branch "alt3" is not an option of "intro:greet"');
  });
  it("rejects a consequence said in a scene that does not come after its choice", () => {
    const { course, source, messages } = fixture();
    source.choices["intro:greet"].alt1.at = "intro";
    expect(compileOpening(source, course, messages).errors).toContain('opening.json: consequence of "intro:greet/alt1" is said in "intro", which does not come after it');
  });
  it("works lines out from cards: rejects unknown cards, a right card that isn't offered, a line left without one", () => {
    const withCards = () => {
      const f = fixture();
      f.source.cards = { a: { label: "card-a" }, b: { label: "card-b", learned: { choice: "intro:greet", option: "reply", label: "card-b-later" } } };
      f.source.deduce = { "intro:greet": { cards: ["a", "b"], right: "a", thought: "thought" }, "intro:menu": { cards: ["b", "a"], right: "b", thought: "thought" } };
      for (const m of ["card-a", "card-b", "card-b-later", "thought"]) f.messages.add(m);
      return f;
    };
    const good = withCards();
    expect(compileOpening(good.source, good.course, good.messages).errors).toEqual([]);
    const unknown = withCards();
    unknown.source.deduce!["intro:greet"].cards = ["a", "zzz"];
    expect(compileOpening(unknown.source, unknown.course, unknown.messages).errors).toContain('opening.json: deduction "intro:greet" names unknown card "zzz"');
    const absent = withCards();
    absent.source.deduce!["intro:greet"].right = "c";
    expect(compileOpening(absent.source, absent.course, absent.messages).errors).toContain('opening.json: deduction "intro:greet": the right card "c" is not one of its cards');
    const missing = withCards();
    delete missing.source.deduce!["intro:menu"];
    expect(compileOpening(missing.source, missing.course, missing.messages).errors).toContain('opening.json: no deduction for "intro:menu"');
    const stale = withCards();
    stale.source.cards!.b.learned!.option = "alt3" as never;
    expect(compileOpening(stale.source, stale.course, stale.messages).errors).toContain('opening.json: card "b" is learned by unknown choice "intro:greet/alt3"');
  });
  it("needs no reward or arrival", () => {
    const { course, source, messages } = fixture();
    delete source.reward; delete source.arrival;
    expect(compileOpening(source, course, messages).errors).toEqual([]);
  });
  it("accepts current learner fragments and rejects removed lines or stale meanings", () => {
    const { course } = fixture();
    expect(scribeProblems({ "intro:greet": { meaning: "Hello!", fragments: ["hello"] } }, course)).toEqual([]);
    expect(scribeProblems({ "intro:gone": { meaning: "Hello!", fragments: ["hello"] } }, course)).toEqual(['scribe accepts: unknown line "intro:gone"']);
    expect(scribeProblems({ "intro:greet": { meaning: "Sit here.", fragments: ["sit"] } }, course)).toEqual(['scribe accepts: stale meaning for "intro:greet"']);
  });
});
