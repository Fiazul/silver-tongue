// The first-steps guide: a short list of steps for the first minutes of a new game, derived from
// core state alone (the objective's scene, the log of accepted inputs, the scenes done) plus one
// world fact (the player stands within talk range of the target). No new core inputs. While a step
// is on, the objective line shows it (with a "Guide" tag) and main.ts floats the 3D marker over its
// target; the reply sheet glows once, a word pulses once (ui/overlay.ts). Steps:
//   walk   Walk to <npc>                 marker over the NPC (the objective scene's, here)
//   talk   Talk: tap <npc>               in talk range of them
//   reply  Reply: pick a line            in the first scene, until the first reply (the sheet glows)
//   word   Tap a word to see its meaning in the first scene, until the first word look-up (a word pulses)
//   go     Go to <place>                 the objective scene is elsewhere: marker on its door
//   do     <task>: tap <npc>             there (the noodle shop's first scene)
// It hands over to the normal objective line once a story scene away from the start place is done
// (the noodle shop's), on day 2, or when hidden (Menu → Hide guide, remembered in the settings).
import type { Course, GameState } from "@silver-tongue/core";
import type { Text } from "@silver-tongue/tui";
import type { Strings } from "./strings";

export type GuideStepId = "walk" | "talk" | "reply" | "word" | "go" | "do";
export type GuideTarget = { kind: "npc"; npc: string } | { kind: "place"; place: string };

export interface GuideStep {
  id: GuideStepId;
  text: string;
  /** what the 3D marker floats over, if anything */
  target: GuideTarget | null;
  /** the one-off highlight of this step */
  highlight?: "replies" | "word";
}

export interface GuideFacts {
  /** the objective's scene (objective.ts), if it points at one */
  scene?: string;
  /** the player is within talk range of the step's NPC (main.ts, from the prompt) */
  near?: boolean;
}

/** The guide is over: a story scene away from the start place is done, or the first day is over. */
export function guideFinished(course: Course, st: GameState): boolean {
  if (st.day > 1) return true;
  return course.scenes.some((x) => !x.repeatable && x.place !== course.world.start && (st.scenesDone[x.id] ?? 0) > 0);
}

const sent = (st: GameState, ...types: string[]) => st.log.some((l) => types.includes(l.input.type));

/** The step for this state, or null when the guide has nothing to say right now (or is over). */
export function guideStep(course: Course, st: GameState, facts: GuideFacts, t: Text, s: Strings): GuideStep | null {
  if (guideFinished(course, st)) return null;
  const npcName = (n: string) => t(`npc-${n}`);
  if (st.run) {
    // The first scene of the game teaches the two moves: reply, then look a word up.
    const first = !course.scenes.some((x) => x.id !== st.run!.scene && (st.scenesDone[x.id] ?? 0) > 0);
    if (!first) return null;
    if (!sent(st, "reply", "replyTiles")) return { id: "reply", text: s("guide-reply"), target: null, highlight: "replies" };
    if (!sent(st, "helpWord")) return { id: "word", text: s("guide-word"), target: null, highlight: "word" };
    return null;
  }
  const scene = facts.scene ? course.scenes.find((x) => x.id === facts.scene) : undefined;
  if (!scene) return null;
  const npc = { kind: "npc" as const, npc: scene.npc };
  if (scene.place !== st.place) return { id: "go", text: s("guide-go", { place: t(`place-${scene.place}`) }), target: { kind: "place", place: scene.place } };
  if (scene.place !== course.world.start) return { id: "do", text: s("guide-do", { task: t(`scene-${scene.id}`), npc: npcName(scene.npc) }), target: npc };
  if (!facts.near) return { id: "walk", text: s("guide-walk", { npc: npcName(scene.npc) }), target: npc };
  return { id: "talk", text: s("guide-talk", { npc: npcName(scene.npc) }), target: npc };
}

/** The guide as main.ts holds it: hidden from the menu (remembered in prefs.ts), else guideStep. */
export class Guide {
  hidden = false;

  constructor(private course: Course) {}

  step(st: GameState, facts: GuideFacts, t: Text, s: Strings): GuideStep | null {
    if (this.hidden) return null;
    return guideStep(this.course, st, facts, t, s);
  }

  /** The guide still has steps ahead in this game (the menu offers Hide / Show guide). */
  active(st: GameState): boolean {
    return !guideFinished(this.course, st);
  }
}
