import { reject, reply, replyTiles, setWord, startScene, type Ctx } from "./dialogue";
import { recordHelp, rankFor } from "./learner";
import { availableSceneIds, endDay } from "./life";
import { newlyTriggered, visitMentor } from "./mentor";
import { cleanName } from "./player";
import type { Course, GameEvent, GameState, Input } from "./types";

export { newGame } from "./life";

/** Play-test log length: enough for a few days of play, small enough to keep saves light. */
export const LOG_LIMIT = 500;

export interface CoreDeps {
  now: () => number;
  rng: () => number;
}

export interface Core {
  readonly state: GameState;
  send(input: Input): GameEvent[];
}

function handle(ctx: Ctx, input: Input): void {
  const { course, state } = ctx;
  switch (input.type) {
    case "goTo":
      if (state.run) return reject(ctx, "in-scene");
      if (!course.world.places[state.place]?.links.includes(input.place)) return reject(ctx, "not-linked");
      state.place = input.place;
      ctx.ev.push({ type: "placeEntered", place: input.place });
      return;
    case "startScene":
      return startScene(ctx, input.scene, input.pick);
    case "reply":
      return reply(ctx, input.choice);
    case "replyTiles":
      return replyTiles(ctx, input.tiles);
    case "helpWord":
      if (!course.words[input.word]) return reject(ctx, "unknown-word");
      return setWord(ctx, input.word, recordHelp);
    case "setName": {
      const name = cleanName(input.name);
      if (!name) return reject(ctx, "bad-name");
      state.player = name;
      ctx.ev.push({ type: "playerNamed", name });
      return;
    }
    case "visitMentor":
      return visitMentor(ctx);
    case "setSound":
      state.sound = input.on;
      ctx.ev.push({ type: "soundSet", on: input.on });
      return;
    case "sleep": {
      if (state.run) return reject(ctx, "in-scene");
      // Before the home scene is done, sleep is allowed anywhere (a rough night): the player must
      // never be stuck with a full day and nowhere to sleep before they've been given a home.
      const { homeScene } = course.world;
      const hasHome = !homeScene || (state.scenesDone[homeScene] ?? 0) > 0;
      if (hasHome && course.world.home && state.place !== course.world.home) return reject(ctx, "not-home");
      ctx.ev.push(...endDay(course, state, !hasHome));
      return;
    }
  }
}

/** One entry point: send an input, get events. A rejected input leaves the state untouched. */
export function createCore(course: Course, initial: GameState, deps: CoreDeps): Core {
  const wordIds = Object.keys(course.words);
  // States from before notes and the log existed (not loaded through parseSave) get empty ones.
  let state: GameState = { ...initial, notes: initial.notes ?? { ready: [], read: [] }, log: initial.log ?? [] };
  return {
    get state() {
      return state;
    },
    send(input) {
      const now = deps.now();
      const ctx: Ctx = { course, state: structuredClone(state), now, rng: deps.rng, ev: [] };
      handle(ctx, input);
      if (ctx.ev.some((e) => e.type === "inputRejected")) return ctx.ev;
      // The sound setting isn't play: it stays out of the log (and older versions can load the save).
      if (input.type !== "setSound") ctx.state.log = [...ctx.state.log, { t: now, day: state.day, slot: state.slot, input }].slice(-LOG_LIMIT);
      const before = new Set(availableSceneIds(course, state));
      for (const id of availableSceneIds(course, ctx.state)) {
        // A drop-off opens with every pickup; errandStarted says so, without naming the place.
        // A repeatable scene already played can close and reopen (a parcel in hand, a price out of
        // reach); it was news only the first time.
        const scene = course.scenes.find((s) => s.id === id);
        const again = !!scene?.repeatable && (ctx.state.scenesDone[id] ?? 0) > 0;
        if (!before.has(id) && !scene?.endsErrand && !again) ctx.ev.push({ type: "unlocked", scene: id });
      }
      for (const note of newlyTriggered(course, ctx.state)) {
        ctx.state.notes.ready.push(note);
        ctx.ev.push({ type: "noteReady", note });
      }
      const rank = rankFor(ctx.state.words, wordIds, now);
      if (rank !== rankFor(state.words, wordIds, now)) ctx.ev.push({ type: "rankChanged", rank });
      state = ctx.state;
      return ctx.ev;
    },
  };
}
