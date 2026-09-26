// Walking between places, as pure state (no three.js, no DOM): which scene space the player is
// in, which trigger zone they are in (edge-triggered, with hysteresis and a cooldown so a position
// jittering on a boundary can't flood core with goTo), and what happens when core moves them to a
// place shown by another space (the street <-> an interior). Also the one prompt resolver: which
// thing near the player gets the floating "E · Talk" / "Enter" / "Sleep" hint.
import { STREET, type LayoutIndex, type Stand, type Vec3 } from "./layout";

/** Must be this far (m) inside a trigger to count as in it, this far outside all to count as out. */
export const ZONE_MARGIN = 0.25;
/** Seconds after a zone change before another can fire. */
export const ZONE_COOLDOWN = 0.5;

/**
 * Edge-triggered zone state for one space. `update` returns a place only when the stable zone
 * under the player changes from the one last committed; in the margin band around a boundary the
 * previous zone holds, so jitter never flips it.
 */
export class ZoneTracker {
  private stable: string;
  private committed: string;
  private cooldown = 0;

  constructor(
    private L: LayoutIndex,
    private space: string,
    place: string,
  ) {
    this.stable = place;
    this.committed = place;
  }

  /** The place core is known to be at (after a transition, a resume, a travel from a list). */
  reset(space: string, place: string) {
    this.space = space;
    this.stable = place;
    this.committed = place;
    this.cooldown = 0;
  }

  get current(): string {
    return this.committed;
  }

  update(dt: number, x: number, z: number): string | null {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const deep = this.L.triggerAt(this.space, x, z, ZONE_MARGIN);
    if (deep) this.stable = deep.place;
    else if (!this.L.triggerAt(this.space, x, z, -ZONE_MARGIN)) this.stable = this.L.space(this.space).defaultPlace;
    // else: in the margin band, the previous zone holds
    if (this.stable === this.committed || this.cooldown > 0) return null;
    this.committed = this.stable;
    this.cooldown = ZONE_COOLDOWN;
    return this.committed;
  }
}

export interface Arrival {
  from: string;
  space: string;
  stand: Stand;
}

/**
 * The player's space and zone. `step` per frame while walking is free: a place to send to
 * game.enterPlace, or null. `sync` after core's place changed: the arrival when the place is shown
 * by another space (swap scenes, put the player at `stand`), else null.
 */
export class SpaceNav {
  space: string;
  readonly zones: ZoneTracker;

  constructor(
    private L: LayoutIndex,
    place: string,
  ) {
    this.space = L.spaceOf(place);
    this.zones = new ZoneTracker(L, this.space, place);
  }

  step(dt: number, x: number, z: number): string | null {
    return this.zones.update(dt, x, z);
  }

  sync(place: string): Arrival | null {
    const want = this.L.spaceOf(place);
    if (want === this.space) {
      if (this.zones.current !== place) this.zones.reset(this.space, place);
      return null;
    }
    const from = this.space;
    const { space, stand } = this.L.arrival(place, from);
    this.space = space;
    this.zones.reset(space, place);
    return { from, space, stand };
  }

  /** Start (or restart) in `place`, e.g. after loading a save: its space and spawn. */
  jump(place: string): Arrival {
    const from = this.space;
    this.space = this.L.spaceOf(place);
    this.zones.reset(this.space, place);
    return { from, space: this.space, stand: this.L.spawn(place) };
  }

  /** The place the current interior's way out leads to (null on the street). */
  exitPlace(): string | null {
    if (this.space === STREET) return null;
    return this.L.space(this.space).triggers.find((t) => t.kind === "exit")?.place ?? null;
  }
}

export type PromptKind = "talk" | "enter" | "exit" | "sleep" | "notebook";

export interface PromptTarget {
  /** stable id: `talk:wang`, `enter:noodle_shop`, `exit:street`, `sleep:0` */
  id: string;
  kind: PromptKind;
  /** npc for talk, place for enter / exit */
  ref: string;
  /** where the hint floats (world, this space) */
  at: Vec3;
  /** how close (m) the player must be */
  range: number;
  /** distance of the player to the thing (m); filled by nearestPrompt */
  dist?: number;
}

/** Talk to an NPC from within this range (m). */
export const TALK_RANGE = 2.3;
const DOOR_RANGE = 1.6;
const EXIT_RANGE = 1.3;

const distToBox = (b: { min: number[]; max: number[] }, x: number, z: number) =>
  Math.hypot(Math.max(b.min[0] - x, 0, x - b.max[0]), Math.max(b.min[1] - z, 0, z - b.max[1]));

/** Everything in a space that can show a prompt. `canSleep` from core (UiModel.canSleep): the bed only offers sleep where core allows it. */
export function promptTargets(L: LayoutIndex, space: string, canSleep: boolean): PromptTarget[] {
  const s = L.space(space);
  const out: PromptTarget[] = [];
  for (const npc of s.npcs) {
    const p = L.npcStand(npc).pos;
    out.push({ id: `talk:${npc}`, kind: "talk", ref: npc, at: [p[0], p[1] + 2.1, p[2]], range: TALK_RANGE });
  }
  for (const t of s.triggers) {
    if (t.kind === "door") out.push({ id: `enter:${t.place}`, kind: "enter", ref: t.place, at: t.at, range: DOOR_RANGE });
    if (t.kind === "exit") out.push({ id: `exit:${t.place}`, kind: "exit", ref: t.place, at: t.at, range: EXIT_RANGE });
  }
  s.interactables.forEach((x, i) => {
    if (x.kind === "sleep" && !canSleep) return;
    out.push({ id: `${x.kind}:${i}`, kind: x.kind, ref: String(i), at: [x.pos[0], x.pos[1] + 0.6, x.pos[2]], range: x.range });
  });
  return out;
}

/** The nearest target in range of (x, z), or null. Door / exit distances are to their trigger box. */
export function nearestPrompt(L: LayoutIndex, space: string, targets: PromptTarget[], x: number, z: number): PromptTarget | null {
  const s = L.space(space);
  let best: PromptTarget | null = null;
  for (const t of targets) {
    let d: number;
    if (t.kind === "enter" || t.kind === "exit") {
      const trig = s.triggers.find((g) => g.place === t.ref && (g.kind === "door" ? t.kind === "enter" : t.kind === "exit"));
      d = trig ? distToBox(trig.box, x, z) : Infinity;
    } else if (t.kind === "talk") {
      const p = L.npcStand(t.ref).pos;
      d = Math.hypot(p[0] - x, p[2] - z);
    } else d = Math.hypot(t.at[0] - x, t.at[2] - z);
    if (d <= t.range && (!best || d < best.dist!)) best = { ...t, dist: d };
  }
  return best;
}
