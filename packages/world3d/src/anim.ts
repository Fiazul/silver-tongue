// Character animation logic with no three.js: which clip a character should be playing, the clip
// fallbacks when a GLB lacks one, and the walk playback rate that keeps feet from sliding. The
// three.js side (mixer, crossfades, bones) is actor.ts; this part runs under vitest.

/** The clip names of the rig contract (humans: all five; pets: idle only). */
export type AnimState = "idle" | "walk" | "talk" | "carry_idle" | "carry_walk";
export const ANIM_STATES: readonly AnimState[] = ["idle", "walk", "talk", "carry_idle", "carry_walk"];

/** Start walking above this ground speed (m/s), stop below the lower one: no flicker at the edge. */
export const WALK_ON = 0.3;
export const WALK_OFF = 0.15;
/** Crossfade between states, seconds. */
export const FADE = 0.2;
/** Used when an asset has no `rig.stride_m`: metres covered by one loop of the walk clip. */
export const DEFAULT_STRIDE = 1.3;

export interface AnimInputs {
  /** ground speed this frame, m/s */
  speed: number;
  /** a scene is running and this character's line is on screen */
  talking: boolean;
  /** holding a prop in a grip bone */
  carrying: boolean;
}

/**
 * The state for the inputs, given the current one (for the walk hysteresis). Moving wins, then
 * talking, then carrying: there is no carry_talk clip, so a character holding a prop talks with
 * `talk` (the prop stays on the grip bone).
 */
export function nextState(current: AnimState, i: AnimInputs): AnimState {
  const wasWalking = current === "walk" || current === "carry_walk";
  const walking = i.speed > (wasWalking ? WALK_OFF : WALK_ON);
  if (walking) return i.carrying ? "carry_walk" : "walk";
  if (i.talking) return "talk";
  return i.carrying ? "carry_idle" : "idle";
}

/** Which clip plays a state when the GLB lacks it: carry_* -> plain, talk/walk -> idle. */
const FALLBACK: Record<AnimState, AnimState | null> = {
  carry_walk: "walk",
  carry_idle: "idle",
  talk: "idle",
  walk: "idle",
  idle: null,
};

/** The clip name to play for `state` among `available`, or null when not even idle is there. */
export function clipFor(state: AnimState, available: ReadonlySet<string>): AnimState | null {
  for (let s: AnimState | null = state; s; s = FALLBACK[s]) if (available.has(s)) return s;
  return null;
}

/** Ground speed (m/s) of the walk clip played at `timeScale`: stride per loop / loop length. */
export function walkSpeed(strideM: number, clipSeconds: number, timeScale = 1): number {
  return (strideM / clipSeconds) * timeScale;
}

/** The walk clip timeScale at which the feet cover exactly `speed` m/s (the inverse of walkSpeed). */
export function walkTimeScale(speed: number, strideM: number, clipSeconds: number): number {
  return speed / walkSpeed(strideM, clipSeconds);
}

/**
 * The state machine one character runs: feed it inputs each frame, it reports a change of state
 * (for the crossfade) or null.
 */
export class AnimMachine {
  state: AnimState = "idle";

  update(i: AnimInputs): { from: AnimState; to: AnimState } | null {
    const to = nextState(this.state, i);
    if (to === this.state) return null;
    const from = this.state;
    this.state = to;
    return { from, to };
  }
}

/** Eases angle `a` toward `b` by `k` (0..1+) along the short way round. */
export function turnToward(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * Math.min(1, k);
}
