// The first-steps guide (guide.ts) from a scripted game against the real course: the steps as
// core state moves (walk → talk → reply → word → … → go to the noodle shop → do its scene →
// handed over), the targets the 3D marker floats over, hidden from the menu, over on day 2.
import { describe, expect, it } from "vitest";
import { newGame } from "@silver-tongue/core";
import { Guide, guideFinished, guideStep, type GuideFacts } from "../src/guide";
import { course, makeGame, playScene, rightOption } from "./helpers";

function start() {
  const { game } = makeGame(newGame(course));
  game.setName("Mina");
  const step = (facts: Omit<GuideFacts, "scene"> = {}) => guideStep(course, game.core.state, { scene: game.model.objective.scene, ...facts }, game.t, game.s);
  return { game, step };
}

describe("the first-steps guide", () => {
  it("walks a new game through its first minutes, then hands over to the objective line", () => {
    const { game, step } = start();
    const wang = course.scenes.find((x) => x.id === game.model.objective.scene)!.npc;
    // (a) walk to Wang, marker over him; (b) next to him: talk.
    expect(step()).toMatchObject({ id: "walk", text: `Walk to ${game.npcName(wang)}`, target: { kind: "npc", npc: wang } });
    expect(step({ near: true })).toMatchObject({ id: "talk", text: `Talk: tap ${game.npcName(wang)}`, target: { kind: "npc", npc: wang } });
    game.talkTo(wang);
    // (c) reply: the sheet glows once (the overlay plays the highlight)
    expect(step()).toMatchObject({ id: "reply", text: "Reply: pick a line", target: null, highlight: "replies" });
    game.reply(rightOption(game));
    // (d) tap a word (pulse one); a look-up ends it
    expect(game.core.state.run).not.toBeNull();
    expect(step()).toMatchObject({ id: "word", highlight: "word" });
    const word = game.model.bubble!.line.tokens[0].word;
    game.helpWord(word);
    expect(step()).toBeNull(); // the rest of the scene: the normal objective line
    playScene(game);
    // Wang's next scenes: walk / talk again (no reply or word steps: taught once).
    for (let guard = 0; guard < 5; guard++) {
      const s = step({ near: true });
      if (s?.id !== "talk") break;
      const t = s.target;
      game.talkTo(t?.kind === "npc" ? t.npc : "");
      if (game.model.choices) game.choose(0);
      expect(step()).toBeNull();
      playScene(game);
    }
    // (e) go to the noodle shop: the marker on its door
    const go = step();
    expect(go).toMatchObject({ id: "go", text: "Go to Noodle Shop", target: { kind: "place", place: "noodle_shop" } });
    game.enterPlace("noodle_shop");
    // (f) there: its scene with the cook
    const there = step();
    expect(there).toMatchObject({ id: "do", target: { kind: "npc", npc: "cook" } });
    expect(there!.text).toBe(`${game.t(`scene-${game.model.objective.scene}`)}: tap ${game.npcName("cook")}`);
    game.talkTo("cook");
    expect(step()).toBeNull();
    playScene(game);
    // handed over
    expect(guideFinished(course, game.core.state)).toBe(true);
    expect(step()).toBeNull();
  });

  it("hidden from the menu: no step; the rest of the game: over from day 2", () => {
    const { game } = start();
    const g = new Guide(course);
    const facts = { scene: game.model.objective.scene };
    expect(g.step(game.core.state, facts, game.t, game.s)?.id).toBe("walk");
    expect(g.active(game.core.state)).toBe(true);
    g.hidden = true;
    expect(g.step(game.core.state, facts, game.t, game.s)).toBeNull();
    const st = { ...game.core.state, day: 2 };
    expect(guideFinished(course, st)).toBe(true);
  });

  it("before the name there is nothing to guide to", () => {
    const { game } = makeGame(newGame(course));
    expect(guideStep(course, game.core.state, { scene: game.model.objective.scene }, game.t, game.s)).toBeNull();
  });
});
