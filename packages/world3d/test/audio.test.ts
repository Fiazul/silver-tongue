// Spoken audio, DOM-free: the AudioPlayer's sequencing (clip order, the 300 ms beat, slow lines,
// the mobile unlock) with a fake audio element and fake timers, and what game.ts has said (as
// packages/tui app.ts does) with a fake AudioOut against the real course.
import { describe, expect, it } from "vitest";
import { comboKey, newGame, type WordRecord } from "@silver-tongue/core";
import type { AudioLike } from "@silver-tongue/tui-web/src/web-audio";
import { createAudioPlayer, silentWav, unlockAudioOnGesture } from "../src/audio";
import { course, fakeAudio, makeGame, rightOption, rightTiles } from "./helpers";

type FakeEl = AudioLike & { played: { src: string; rate: number }[]; paused: number; reject: boolean; pending: (() => void)[] };

/** An audio element whose play() resolves at once, unless `reject` (a browser refusing it) or held in `pending`. */
function fakeEl(): FakeEl {
  return {
    src: "",
    playbackRate: 1,
    defaultPlaybackRate: 1,
    onended: null,
    onerror: null,
    played: [],
    paused: 0,
    reject: false,
    pending: [],
    play() {
      this.played.push({ src: this.src, rate: this.playbackRate });
      return this.reject ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
    },
    pause() {
      this.paused++;
    },
  };
}

function timers() {
  const waits: { ms: number; cb: () => void; cancelled: boolean }[] = [];
  const wait = (ms: number, cb: () => void) => {
    const w = { ms, cb, cancelled: false };
    waits.push(w);
    return { cancel: () => void (w.cancelled = true) };
  };
  return { waits, wait };
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0));
const named = () => ({ ...newGame(course), player: "Sam" });

describe("AudioPlayer: sequencing", () => {
  it("plays every clip in order, a 300 ms beat between clips (tui-web's BEAT_MS), none after the last; slow lines at 0.8", () => {
    const el = fakeEl();
    const { waits, wait } = timers();
    const p = createAudioPlayer({ base: "../audio/", audio: el, wait });
    p.play([{ clips: ["a", "b"] }, { clips: ["c"], slow: true }]);
    expect(el.played.map((x) => x.src)).toEqual(["../audio/a.mp3"]);
    el.onended!(); // a ends: a beat, then b
    expect(waits.map((w) => w.ms)).toEqual([300]);
    expect(el.played).toHaveLength(1); // nothing during the beat
    waits[0].cb();
    el.onended!();
    expect(waits.map((w) => w.ms)).toEqual([300, 300]);
    waits[1].cb();
    el.onended!(); // the last clip: no beat after it
    expect(waits).toHaveLength(2);
    expect(el.played).toEqual([
      { src: "../audio/a.mp3", rate: 1 },
      { src: "../audio/b.mp3", rate: 1 },
      { src: "../audio/c.mp3", rate: 0.8 },
    ]);
  });

  it("a new play() stops the old one: its pending beat is cancelled and its later clips never play", () => {
    const el = fakeEl();
    const { waits, wait } = timers();
    const p = createAudioPlayer({ base: "", audio: el, wait });
    p.play([{ clips: ["a", "b"] }]);
    el.onended!();
    p.play([{ clips: ["x"] }]);
    expect(waits[0].cancelled).toBe(true);
    expect(el.played.map((x) => x.src)).toEqual(["a.mp3", "x.mp3"]);
    expect(el.paused).toBeGreaterThan(0);
  });

  it("no audio element: not available, play() does nothing", () => {
    const p = createAudioPlayer({ base: "", audio: undefined, wait: timers().wait });
    expect(p.available).toBe(false);
    p.play([{ clips: ["a"] }]);
    p.unlock();
    expect(p.unlocked).toBe(false);
  });

  it("three clips failing to load in a row (no clips beside the page): not available", () => {
    const el = fakeEl();
    const { waits, wait } = timers();
    const p = createAudioPlayer({ base: "", audio: el, wait });
    p.play([{ clips: ["a", "b", "c"] }]);
    el.onerror!();
    waits[0].cb();
    el.onerror!();
    waits[1].cb();
    expect(p.available).toBe(true);
    el.onerror!();
    expect(p.available).toBe(false);
  });
});

describe("AudioPlayer: mobile unlock", () => {
  it("the first gesture plays a silent clip through the same element and pauses it; later gestures do nothing", async () => {
    const el = fakeEl();
    const p = createAudioPlayer({ base: "", audio: el, wait: timers().wait });
    const target = new EventTarget();
    unlockAudioOnGesture(p, target);
    target.dispatchEvent(new Event("pointerup"));
    expect(el.played.map((x) => x.src)).toEqual([silentWav()]);
    await flushPromises();
    expect(p.unlocked).toBe(true);
    expect(el.paused).toBe(1);
    target.dispatchEvent(new Event("click")); // removes the listeners (unlocked)
    target.dispatchEvent(new Event("touchend"));
    expect(el.played).toHaveLength(1);
  });

  it("a refused unlock (a gesture that grants no play) is tried again on the next gesture", async () => {
    const el = fakeEl();
    el.reject = true;
    const p = createAudioPlayer({ base: "", audio: el, wait: timers().wait });
    const target = new EventTarget();
    unlockAudioOnGesture(p, target);
    target.dispatchEvent(new Event("pointerup"));
    await flushPromises();
    expect(p.unlocked).toBe(false);
    el.reject = false;
    target.dispatchEvent(new Event("touchend"));
    await flushPromises();
    expect(p.unlocked).toBe(true);
    expect(el.played).toHaveLength(2);
  });

  it("the gesture that starts a line (tapping an NPC): the silence doesn't pause the line", async () => {
    const el = fakeEl();
    const p = createAudioPlayer({ base: "", audio: el, wait: timers().wait });
    p.unlock(); // capture phase, before the tap's own handler
    p.play([{ clips: ["line"] }]);
    await flushPromises();
    expect(el.src).toBe("line.mp3");
    expect(el.paused).toBe(1); // play()'s own stop() only, not the unlock's
    expect(p.unlocked).toBe(true);
  });

  it("a clip that plays unlocks too (the browser allowed it)", async () => {
    const el = fakeEl();
    const p = createAudioPlayer({ base: "", audio: el, wait: timers().wait });
    p.play([{ clips: ["a"] }]);
    await flushPromises();
    expect(p.unlocked).toBe(true);
    p.unlock();
    expect(el.played).toHaveLength(1);
  });
});

describe("game.ts: what is said (as app.ts)", () => {
  it("a scene's line is said as it is spoken", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    const line = game.model.bubble!;
    expect(line.audio.length).toBeGreaterThan(0);
    expect(a.plays).toEqual([[{ clips: line.audio }]]);
  });

  it("a picked reply: the player's reply, then the NPC's reaction in their voice (course.reactionAudio), in one play", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    const r = game.model.reply!;
    expect(r.mode).toBe("pick");
    const wrong = rightOption(game) === 0 ? 1 : 0;
    const option = r.mode === "pick" ? r.options[wrong] : undefined;
    const n = game.model.events.length;
    game.reply(wrong);
    const reacted = game.model.events.slice(n).find((e) => e.type === "npcReacted");
    expect(reacted?.type).toBe("npcReacted");
    if (reacted?.type !== "npcReacted") return;
    const voice = course.reactionAudio![reacted.reaction][reacted.npc];
    expect(voice.length).toBeGreaterThan(0);
    expect(game.model.bubble!.audio).toEqual(voice);
    expect(a.plays.at(-1)).toEqual([{ clips: option!.audio }, { clips: voice }]);
  });

  it("a right pick: the reply, then the next line", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    const r = game.model.reply!;
    const i = rightOption(game);
    const reply = r.mode === "pick" ? r.options[i].audio : undefined;
    game.reply(i);
    expect(a.plays.at(-1)).toEqual([{ clips: reply }, { clips: game.model.bubble!.audio }]);
  });

  it("right tiles: the right reply's clips are said first", () => {
    const T = 1_000_000;
    const lapsed: WordRecord = { right: 1, wrong: 1, streak: 0, helps: 0, lapsed: true, firstSeen: T, lastSeen: T };
    const words = Object.fromEntries(Object.keys(course.words).map((w) => [w, { ...lapsed }]));
    const a = fakeAudio();
    const { game } = makeGame({ ...named(), words }, T, a);
    game.talkTo("wang");
    expect(game.model.reply?.mode).toBe("tiles");
    const run = game.core.state.run!;
    const right = course.scenes.find((x) => x.id === run.scene)!.exchanges[run.exchange].variants[comboKey(run.combo)].reply;
    expect(right.audio?.length).toBeGreaterThan(0);
    game.replyTiles(rightTiles(game));
    expect(a.plays.at(-1)![0]).toEqual({ clips: right.audio });
    // the echo is the reply itself, punctuation and all (0.12.2), not the bare tiles
    const you = game.model.feed.filter((f) => f.kind === "you").at(-1)!;
    expect(you.text).toMatch(/[。？！，?!.]/);
  });

  it("word help says the word; the gloss carries its clips for the popover's play button", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    const word = game.model.bubble!.line.tokens[0].word;
    const g = game.helpWord(word)!;
    expect(g.audio).toEqual(course.words[word].audio);
    expect(a.plays.at(-1)).toEqual([{ clips: course.words[word].audio }]);
    game.say(g.audio);
    expect(a.plays).toHaveLength(3);
  });

  it("the whole sentence button says the bubble's line; replay says it again", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    const b = game.model.bubble!;
    const g = game.sentence(b.line)!;
    expect(g.audio).toEqual(b.audio);
    expect(a.plays.at(-1)).toEqual([{ clips: b.audio }]);
    game.replay();
    expect(a.plays.at(-1)).toEqual([{ clips: b.audio }]);
    expect(a.plays).toHaveLength(3);
  });

  it("a slow repeat (lineRephrased slow) is said slowly, and replayed slowly", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    game.talkTo("wang");
    for (let guard = 0; guard < 6 && !game.model.bubble?.slow && game.core.state.run; guard++) {
      game.reply(rightOption(game) === 0 ? 1 : 0);
    }
    const b = game.model.bubble!;
    expect(b.kind).toBe("rephrase");
    expect(b.slow).toBe(true);
    expect(a.plays.at(-1)!.at(-1)).toEqual({ clips: b.audio, slow: true });
    game.replay();
    expect(a.plays.at(-1)).toEqual([{ clips: b.audio, slow: true }]);
  });

  it("sound off: nothing is said until it is turned on again; soundSet toggles the HUD chip", () => {
    const a = fakeAudio();
    const { game } = makeGame(named(), undefined, a);
    expect(game.model.hud.sound).toBe("on");
    game.setSound(false);
    expect(game.core.state.sound).toBe(false);
    expect(game.model.events.at(-1)).toEqual({ type: "soundSet", on: false });
    expect(game.model.hud.sound).toBe("off");
    expect(a.stops).toBeGreaterThan(0);
    game.talkTo("wang");
    game.replay();
    expect(a.plays).toEqual([]);
    game.setSound(true);
    expect(game.model.hud.sound).toBe("on");
    game.replay();
    expect(a.plays).toEqual([[{ clips: game.model.bubble!.audio }]]);
  });

  it("no audio here: the HUD says so and the sound toggle does nothing (as the TUI's [m])", () => {
    const { game } = makeGame(named(), undefined, fakeAudio(false));
    expect(game.model.hud.sound).toBe("none");
    game.setSound(false);
    expect(game.core.state.sound).toBeUndefined();
    const silent = makeGame(named());
    expect(silent.game.model.hud.sound).toBe("none");
  });
});
