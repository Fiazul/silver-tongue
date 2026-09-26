// Parity with the TUI: every core Input has a 3D affordance (INPUT_AFFORDANCES, in the README's
// table too) and is actually sent by playing through the Game API; every GameEvent has a case in
// the dispatcher. The unions are read from core's source, so a new Input or event fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newGame, type Input, type WordRecord } from "@silver-tongue/core";
import { INPUT_AFFORDANCES, type Game } from "../src/game";
import { course, makeGame, playScene } from "./helpers";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/**
 * The `type: "…"` members of an exported union in core's types.ts. The union runs to the first
 * line that isn't indented (a member spread over several lines ends its own lines with ";", so
 * stopping at the first ";\n" would miss every member after it).
 */
function unionTypes(name: string): string[] {
  const src = read("../../core/src/types.ts");
  const start = src.indexOf(`export type ${name} =`);
  expect(start, name).toBeGreaterThan(-1);
  const lines = src.slice(start).split("\n");
  const end = lines.findIndex((l, i) => i > 0 && !/^\s/.test(l));
  const body = lines.slice(0, end < 0 ? undefined : end).join("\n");
  return [...new Set([...body.matchAll(/type: "(\w+)"/g)].map((m) => m[1]))];
}

describe("parity with the TUI", () => {
  const inputs = unionTypes("Input");

  it("every Input variant in core has a 3D affordance", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(INPUT_AFFORDANCES).sort()).toEqual([...inputs].sort());
  });

  it("the README's parity table lists every Input variant", () => {
    const readme = read("../README.md");
    const table = readme.slice(readme.indexOf("## Parity with the TUI"));
    for (const i of inputs) expect(table, i).toContain(`\`${i}\``);
  });

  it("every GameEvent variant has a case in the dispatcher, and the README's handled list names it", () => {
    const events = unionTypes("GameEvent");
    // the parse reaches past multi-line members (actionPerformed) to the end of the union
    expect(events).toEqual(expect.arrayContaining(["placeEntered", "actionPerformed", "mentorVisited", "errandStarted", "errandEnded", "inputRejected"]));
    const src = read("../src/game.ts");
    const dispatch = src.slice(src.indexOf("function dispatch("), src.indexOf("function persist("));
    const cases = new Set([...dispatch.matchAll(/case "(\w+)":/g)].map((m) => m[1]));
    for (const e of events) expect(cases.has(e), e).toBe(true);
    const readme = read("../README.md");
    const handled = readme.slice(readme.indexOf("Every `GameEvent` is handled"), readme.indexOf("## Seeing it"));
    for (const e of events) expect(handled, e).toMatch(new RegExp(`\\b${e}\\b`));
  });

  it("each Input is sent to core by its Game affordance (and accepted)", () => {
    const reached = new Set<Input["type"]>();
    const accepted = (game: Game) => {
      for (const l of game.core.state.log) reached.add(l.input.type);
    };
    // Name, talk, word help, pick replies, the mentor, walking, sleeping.
    const a = makeGame(newGame(course));
    const g = a.game;
    expect(g.setName("Sam")).toBe(true);
    g.talkTo("wang");
    g.helpWord(g.model.bubble!.line.tokens[0].word);
    playScene(g);
    g.visitMentor();
    g.enterPlace("room");
    g.sleep();
    accepted(g);
    // Tiles: every word known once and then missed, so replies are built from tiles.
    const T = 1_000_000;
    const lapsed: WordRecord = { right: 1, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T, lastSeen: T };
    const words = Object.fromEntries(Object.keys(course.words).map((w) => [w, { ...lapsed }]));
    const b = makeGame({ ...newGame(course), player: "Sam", words }, T);
    b.game.talkTo("wang");
    expect(b.game.model.reply?.mode).toBe("tiles");
    b.game.replyTiles([0]);
    accepted(b.game);
    for (const i of inputs) expect(reached.has(i as Input["type"]), i).toBe(true);
    // and the Game method each affordance names exists
    for (const [i, x] of Object.entries(INPUT_AFFORDANCES)) expect(typeof (g as unknown as Record<string, unknown>)[x.api], i).toBe("function");
  });
});
