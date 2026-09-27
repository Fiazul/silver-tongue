// The one objective resolver: a short "what now" line for the HUD, derived from core state alone
// (available scenes, a parcel to deliver, mentor notes, slots left, rent). Pure, so tests can walk a day through it.
import { availableSceneIds, type Course, type GameState } from "@silver-tongue/core";
import type { Text } from "@silver-tongue/tui";
import type { Strings } from "./strings";

/** Which rule below produced the objective (wayfind.ts gives each a target rule). */
export type ObjectiveKind = "name" | "scene" | "sleep" | "go-home" | "deliver" | "story" | "mentor" | "work" | "practice" | "rest";

/** What the objective sends the player to: someone (at their place), or the bed at home. */
export type ObjectiveGoal = { kind: "npc"; npc: string; place: string } | { kind: "bed"; place: string };

export interface Objective {
  /** the next thing to do */
  text: string;
  /** a standing reminder (rent) */
  sub?: string;
  /** the scene the objective points at, if any */
  scene?: string;
  kind?: ObjectiveKind;
  /** where it is done (none: the name dialog, a scene running) */
  goal?: ObjectiveGoal;
}

/** Graph distance (hops) from `from` to every place. */
function hops(course: Course, from: string): Map<string, number> {
  const d = new Map([[from, 0]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    for (const n of course.world.places[cur]?.links ?? []) if (!d.has(n)) (d.set(n, d.get(cur)! + 1), q.push(n));
  }
  return d;
}

/** Days until rent is taken (0: tonight). Rent is taken when sleeping on a day that is a multiple of 7. */
export function daysToRent(day: number): number {
  return (7 - (day % 7)) % 7;
}

export function objective(course: Course, st: GameState, t: Text, s: Strings, needsName: boolean): Objective {
  const w = course.world;
  const npcName = (n: string) => t(`npc-${n}`);
  const placeName = (p: string) => t(`place-${p}`);
  const home = w.home ?? st.place;
  const rentArgs = { currency: w.currency, rent: w.rentPerWeek };
  const due = daysToRent(st.day);
  const sub = st.rentLate
    ? s("obj-rent-late", rentArgs)
    : due === 0
      ? s("obj-rent-tonight", rentArgs)
      : s("obj-rent-due", { ...rentArgs, n: due });

  if (needsName && !st.player) return { text: s("obj-name"), sub, kind: "name" };
  if (st.run) {
    const scene = course.scenes.find((x) => x.id === st.run!.scene);
    return { text: s("obj-in-scene", { npc: scene ? npcName(scene.npc) : "" }), sub, scene: st.run.scene, kind: "scene" };
  }
  if (st.slot >= w.slotsPerDay) {
    const kind = st.place === home ? "sleep" : "go-home";
    return { text: st.place === home ? s("obj-sleep-here") : s("obj-go-home", { place: placeName(home) }), sub, kind, goal: { kind: "bed", place: home } };
  }
  // Carrying a parcel: its drop-off comes first (core offers it only at the parcel's place).
  if (st.errand) {
    const drop = availableSceneIds(course, st)
      .map((id) => course.scenes.find((x) => x.id === id)!)
      .find((x) => x.endsErrand && x.place === st.errand!.to);
    if (drop) {
      const args = { place: placeName(drop.place), npc: npcName(drop.npc), task: t(`scene-${drop.id}`) };
      return { text: s(drop.place === st.place ? "obj-deliver-here" : "obj-deliver", args), sub, scene: drop.id, kind: "deliver", goal: { kind: "npc", npc: drop.npc, place: drop.place } };
    }
  }
  const dist = hops(course, st.place);
  const scenes = availableSceneIds(course, st)
    .map((id) => course.scenes.find((x) => x.id === id)!)
    .sort((a, b) => (dist.get(a.place) ?? 99) - (dist.get(b.place) ?? 99)); // stable: course order within a distance
  const story = scenes.find((x) => !x.repeatable);
  const say = (x: (typeof scenes)[number], here: string, there: string, kind: ObjectiveKind): Objective => {
    const args = { task: t(`scene-${x.id}`), npc: npcName(x.npc), place: placeName(x.place) };
    return { text: s(x.place === st.place ? here : there, args), sub, scene: x.id, kind, goal: { kind: "npc", npc: x.npc, place: x.place } };
  };
  if (story) return say(story, "obj-talk", "obj-go", "story");
  const m = w.mentor;
  if (m && st.notes.ready.length && (st.scenesDone[m.after] ?? 0) > 0) {
    const place = w.npcs[m.npc]?.place;
    const args = { npc: npcName(m.npc), place: placeName(place ?? st.place) };
    return { text: s(place === st.place ? "obj-mentor" : "obj-mentor-go", args), sub, kind: "mentor", goal: { kind: "npc", npc: m.npc, place: place ?? st.place } };
  }
  // Paid repeatable scenes (shifts) before unpaid ones (practice).
  const paid = (x: (typeof scenes)[number]) => x.exchanges.some((e) => e.pay > 0);
  const work = scenes.find((x) => x.repeatable && paid(x));
  if (work) return say(work, "obj-work", "obj-work-go", "work");
  const practice = scenes.find((x) => x.repeatable);
  if (practice) return say(practice, "obj-talk", "obj-go", "practice");
  return { text: st.place === home ? s("obj-sleep-now") : s("obj-nothing", { place: placeName(home) }), sub, kind: "rest", goal: { kind: "bed", place: home } };
}
