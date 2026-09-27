// Walking between places, as pure state (no three.js, no DOM): which scene space the player is
// in, which trigger zone they are in (edge-triggered, with hysteresis and a cooldown so a position
// jittering on a boundary can't flood core with goTo), and what happens when core moves them to a
// place shown by another space (the street <-> an interior). Also the one prompt resolver: which
// thing near the player gets the floating "E · Talk" / "Enter" / "Sleep" hint.
import { inBox, STREET, type LayoutIndex, type Stand, type Vec3 } from "./layout";

/** Must be this far (m) inside a trigger to count as in it, this far outside all to count as out. */
export const ZONE_MARGIN = 0.25;
/** Seconds after a zone change before another can fire. */
export const ZONE_COOLDOWN = 0.5;

/**
 * Edge-triggered zone state for one space. `update` returns a place only when the stable zone
 * under the player changes from the one last committed; in the margin band around a boundary the
 * previous zone holds, so jitter never flips it. Doors and ways out come first (a door inside a
 * zone: its band holds too, so the zone round it can't flip it either); a travel-only place's stay
 * spot holds that place while it is the committed one, and never draws the player in.
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
    const place = this.placeUnder(x, z);
    if (place !== null) this.stable = place; // null: in a margin band, the previous zone holds
    if (this.stable === this.committed || this.cooldown > 0) return null;
    this.committed = this.stable;
    this.cooldown = ZONE_COOLDOWN;
    return this.committed;
  }

  /** The stable place under (x, z), or null in a margin band (hold the previous one). */
  private placeUnder(x: number, z: number): string | null {
    const ts = this.L.space(this.space).triggers;
    const near = (kinds: string[]) => ts.filter((t) => kinds.includes(t.kind) && inBox(t.box, x, z, -ZONE_MARGIN));
    if (near(["stay"]).some((t) => t.place === this.committed)) return this.committed;
    for (const kinds of [["door", "exit"], ["zone"]]) {
      const ours = near(kinds);
      const deep = ours.find((t) => inBox(t.box, x, z, ZONE_MARGIN));
      if (deep) return deep.place;
      if (ours.length) return null;
    }
    return this.L.space(this.space).defaultPlace;
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
 * by another space (swap scenes, put the player at `stand`), or by this one where the player isn't
 * standing (the Go to list: a zone across the town, a travel-only spot), else null.
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

  /** `at`: where the player stands now (x, z); without it, only a change of space moves them. */
  sync(place: string, at?: { x: number; z: number }): Arrival | null {
    const want = this.L.spaceOf(place);
    if (want === this.space) {
      if (this.zones.current === place) return null;
      this.zones.reset(this.space, place);
      // Core put the player somewhere they aren't standing: take them to its spawn.
      if (at && !this.L.holds(this.space, place, at.x, at.z, ZONE_MARGIN)) return { from: this.space, space: this.space, stand: this.L.spawn(place) };
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

/** `bark`: someone outside the course (a walker, a pet, a stall keeper; src/barks.ts), `at` their live position (main.ts). */
export type PromptKind = "talk" | "bark" | "enter" | "exit" | "sleep" | "notebook";

export interface PromptTarget {
  /** stable id: `talk:wang`, `bark:walker:0`, `enter:noodle_shop`, `exit:street`, `sleep:0` */
  id: string;
  kind: PromptKind;
  /** npc for talk, the figure id for bark, place for enter / exit */
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
