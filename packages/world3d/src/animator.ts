// Layered procedural character animation, no three.js: every human and pet in the game (player,
// NPCs, walkers, extras, pets) runs one Animator, which writes a pose (per-joint rotations in the
// character's own axes plus a hips offset) from time and state. actor.ts puts the pose on the
// rig's bones. It replaces the baked sin-loop clips (idle / talk swung the hips, spine and head
// left-right on a 2-4 s metronome, every character in unison).
//
// Layers, summed each frame, each with its own eased weight (critically damped: ease-in and
// ease-out, never a pop):
//   idle    breathing, weight shift every few seconds, head look-around at random intervals
//   walk    gait from the ground speed (step length and cadence grow with speed, run blends in),
//           planted feet (two-bone IK per leg), arm counter-swing, bob, lean into acceleration,
//           a stabilised head; a settle dip when it stops
//   talk    head nods on a pseudo-syllable clock, hand gestures now and then, a lean to the listener
//   listen  a head tilt toward the speaker and slow nods with skips
//   carry   both forearms up in front (a box, a bag)
//   sit     hips and knees at 90 degrees, hips lowered to the seat
//   react   one-shot poses: greet (wave), happy (hop), confused (shrug), nod, reach (hand over)
//   face    turn-to-face: the head leads (up to 45 degrees), the body follows on a critically
//           damped turn (no overshoot, no oscillation)
// Every interval, tempo and amplitude is jittered from a per-character seed, so two NPCs never
// move in unison and the same seed always moves the same way.
//
// Axes (glTF / three.js character space): +X = the character's left, +Y = up, +Z = front.
// A joint rotation (Euler order YXZ) is applied relative to its parent's posed frame. So for a
// bone pointing up (spine, head) +X pitches it forward; for a bone hanging down (legs, arms) -X
// swings it forward. -Z rolls the top toward the character's left.

export const DEG = Math.PI / 180;

/** The joints a human pose drives (actor.ts maps them to the rig's bones). */
export const HUMAN_JOINTS = [
  "Hips", "Spine", "Chest", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot",
] as const;
/** The pet rig (st-pet-v1): pose slots 1 / 4 / 19 (spine, head, tail). */
export const PET_JOINTS = { Spine: 1, Head: 4, Tail: 19 } as const;
export const NJ = 20;

const HIPS = 0, SPINE = 1, CHEST = 2, NECK = 3, HEAD = 4;
/** per side: shoulder, arm, forearm, hand, thigh, shin, foot */
const SIDE = {
  left: { sho: 5, arm: 6, fore: 7, hand: 8, thigh: 13, shin: 14, foot: 15, s: 1 },
  right: { sho: 9, arm: 10, fore: 11, hand: 12, thigh: 16, shin: 17, foot: 18, s: -1 },
} as const;
const TAIL = 19;
type Side = keyof typeof SIDE;

/** The tuning constants (README "Character animation"). Ranges are [min, max], jittered per character. */
export const TUNE = {
  /** s: how fast a state's weight eases in / out (critically damped, ~this to settle) */
  blendS: 0.35,
  breathHz: [0.22, 0.3],
  breathChestDeg: 1.1,
  breathShoulderDeg: 0.8,
  shiftEveryS: [4, 8],
  shiftCm: 1.5,
  shiftHipDeg: 1.5,
  /** look-around: only idle and out of dialogue, one glance every 6-12 s, eased over lookEaseS, at most 20 degrees */
  lookEveryS: [6, 12],
  lookEaseS: 2,
  lookYawDeg: 20,
  lookPitchDeg: 4,
  /** step length (m) = min(max, base + perMps * speed) * height/1.7 */
  stepBaseM: 0.25,
  stepPerMps: 0.16,
  stepMaxM: 0.8,
  /** run blends in between these speeds (m/s) */
  runFrom: 1.6,
  runTo: 3.0,
  armSwingDeg: [17, 24],
  bobCm: [2.2, 3],
  crouchCm: [1.8, 3.5],
  liftCm: [5.5, 8.5],
  leanDeg: [2.5, 7],
  accelLeanDegPerMps2: 0.9,
  accelLeanMaxDeg: 5,
  settleS: 0.5,
  settleCm: 1.6,
  headLeadMaxDeg: 45,
  /** the head's own turn (1/s, critically damped, faster than the body's): it gets there first, then holds */
  headTurnOmega: 11,
  /** default turn-to-face stiffness (1/s): ~0.65 s to settle a big turn */
  turnOmega: 7,
  /** talking: a small nod every 2.2-3.5 s (never more than one a second), 0.6-1.5 degrees, over nodS */
  nodEveryS: [2.2, 3.5],
  nodDeg: [0.6, 1.5],
  nodS: 0.6,
  gestureEveryS: [2, 5],
  gestureS: [0.5, 0.75],
  gestureForeDeg: [20, 40],
  talkLeanDeg: 2.5,
  listenTiltDeg: [3, 5],
  listenNodEveryS: [2.2, 3.5],
  listenNodDeg: [0.6, 1.5],
  listenSkip: 0.3,
  /** dialogue aim dead zone: re-aim at the player only once they move this far (m) or this much (deg) */
  aimDeadM: 0.6,
  aimDeadDeg: 12,
} as const;

/** One-shot poses. greet: a raised-hand wave; happy: a little hop; confused: a shrug with a head tilt; nod: agreeing; reach: hand something over. */
export type Reaction = "greet" | "happy" | "confused" | "nod" | "reach";
export const REACTION_S: Record<Reaction, number> = { greet: 2.0, happy: 1.0, confused: 1.1, nod: 0.8, reach: 1.1 };

export interface AnimatorInputs {
  /** ground speed this frame, m/s */
  speed: number;
  /** walking per the state machine (anim.ts, with its hysteresis) */
  walking: boolean;
  talking: boolean;
  listening: boolean;
  carrying: boolean;
  sitting: boolean;
}

/** The rig measurements a human animator needs (actor.ts reads them from the rest pose). */
export interface RigDims {
  /** height / 1.7: every distance scales with it (the kid moves smaller) */
  k: number;
  /** thigh and shin lengths (m) */
  thigh: number;
  shin: number;
  /** hip joint -> ankle at rest: forward (z) and down (y, positive) */
  legZ: number;
  legY: number;
}

export const DEFAULT_DIMS: RigDims = { k: 1, thigh: 0.314, shin: 0.248, legZ: 0, legY: 0.562 };

/** FNV-1a: a seed string -> 32 bits. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG, [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
/** A bump over u in 0..1: 0 at both ends with zero slope (sin^2). */
const bumpOf = (u: number) => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) ** 2);
/** attack / hold / release envelope over t in 0..dur, smoothstep edges */
const envelopeOf = (t: number, dur: number, attack: number, release: number) =>
  t <= 0 || t >= dur ? 0 : Math.min(smooth(t / attack), smooth((dur - t) / release));

/**
 * A critically damped value (exact step: stable at any dt). From rest it eases in and out and
 * never overshoots a fixed target.
 */
export class Damped {
  v = 0;
  constructor(public x = 0) {}
  step(target: number, omega: number, dt: number): number {
    const e = this.x - target;
    const ex = Math.exp(-omega * dt);
    const tmp = (this.v + omega * e) * dt;
    this.v = (this.v - omega * tmp) * ex;
    this.x = target + (e + tmp) * ex;
    return this.x;
  }
}

/**
 * Where an NPC looks in dialogue: the player's position when it last aimed. It re-aims only once
 * the player has moved more than TUNE.aimDeadM from that point or TUNE.aimDeadDeg around it, so
 * the head and body make one smooth turn per re-aim instead of tracking every step.
 */
export class FaceAim {
  private ax = NaN;
  private az = NaN;
  yaw = 0;
  /** re-aims so far (tests, debug) */
  aims = 0;
  /** The committed yaw for a character at (sx, sz) looking at (px, pz). */
  aim(sx: number, sz: number, px: number, pz: number): number {
    const want = Math.atan2(px - sx, pz - sz);
    if (Number.isNaN(this.ax) || Math.hypot(px - this.ax, pz - this.az) > TUNE.aimDeadM || Math.abs(wrapAngle(want - this.yaw)) > TUNE.aimDeadDeg * DEG) {
      this.ax = px;
      this.az = pz;
      this.yaw = want;
      this.aims++;
    }
    return this.yaw;
  }
  /** Looking elsewhere: the next aim starts fresh. */
  clear() {
    this.ax = NaN;
  }
}

/** A countdown that fires at random intervals in [lo, hi]. */
class Every {
  t: number;
  constructor(private r: () => number, private lo: number, private hi: number, first = 0.5) {
    this.t = (lo + (hi - lo) * r()) * first;
  }
  tick(dt: number): boolean {
    this.t -= dt;
    if (this.t > 0) return false;
    this.t += this.lo + (this.hi - this.lo) * this.r();
    return true;
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const pick = (r: () => number, range: readonly [number, number]) => lerp(range[0], range[1], r());

interface Active {
  kind: Reaction;
  t: number;
  side: Side;
  /** the seeded tilt side etc. */
  sign: number;
  /** seconds since a newer one of its kind replaced it (it fades out over REPLACE_S), else -1 */
  out: number;
}

/** A reaction replaced mid-way fades out over this long (s) under the new one. */
const REPLACE_S = 0.25;

/** Soft IK starts here (fraction of the leg's full length). */
const SOFT_IK = 0.92;

/** A two-bone leg in its sagittal plane: thigh / shin angles from straight down, forward positive (rad). */
function legIk(dims: RigDims, dz: number, dy: number, out: { thigh: number; shin: number }) {
  const L1 = dims.thigh;
  const L2 = dims.shin;
  // soft reach: past SOFT_IK of full length the distance saturates smoothly, so the knee never
  // snaps straight (acos is steep there: a hard clamp pops the knee at full stride)
  const L = L1 + L2;
  const ds = L * SOFT_IK;
  const r = L * 0.999 - ds;
  let d = Math.max(Math.hypot(dz, dy), Math.abs(L1 - L2) + 1e-4);
  if (d > ds) d = ds + r * (1 - Math.exp(-(d - ds) / r));
  const a = Math.atan2(dz, dy);
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const knee = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  out.thigh = a + alpha;
  out.shin = out.thigh - knee;
  return out;
}

/**
 * One character's procedural animation. `update` writes `rot` (NJ joints x [pitch X, yaw Y,
 * roll Z], radians, Euler YXZ, relative to the parent's posed frame) and `hips` (offset, metres).
 */
export class Animator {
  readonly rot = new Float32Array(NJ * 3);
  readonly hips = new Float32Array(3);
  readonly kind: "human" | "pet";
  private r: () => number;
  private dims: RigDims;
  private restLeg = { thigh: 0, shin: 0 };
  private ik = { thigh: 0, shin: 0 };
  t = 0;
  // personality (from the seed)
  private energy: number;
  private breathHz: number;
  private breathPh: number;
  private tiltSide: number;
  /** walkers, pigeons: the head keeps to the body's heading (no look-around, no turn lead) */
  fixedHead: boolean;
  // weights
  readonly w = { walk: new Damped(), talk: new Damped(), listen: new Damped(), dialogue: new Damped(), carry: new Damped(), sit: new Damped() };
  // idle
  private shift = new Damped();
  private shiftTarget = 0;
  private shiftEvery: Every;
  /** the look-around glance: a smoothstep tween from `from` to `to` over `dur` */
  private look = { from: [0, 0], to: [0, 0], t: 0, dur: 1 };
  private lookEvery: Every;
  // walk
  /** gait phase, cycles (one cycle = two steps) */
  phase = 0;
  private speedS = new Damped();
  private runS = new Damped();
  private accelLean = new Damped();
  private lastSpeedS = 0;
  private settleT = -1;
  private wasWalking = false;
  // talk
  private nodEvery: Every;
  private nod = { t: -1, amp: 0 };
  private gestureEvery: Every;
  private gesture = { t: -1, dur: 0.6, side: "right" as Side, amp: 0.5 };
  // listen
  // react
  private active: Active[] = [];
  // face
  private turnV = 0;
  /** the head's world yaw on its own critically damped turn (NaN: not turning) */
  private headYaw = NaN;
  private headV = 0;
  private leadFresh = false;
  private lead = new Damped();
  // pets
  private wagEvery: Every;
  private wagT = -1;

  constructor(seed: string | number, kind: "human" | "pet" = "human", dims: RigDims = DEFAULT_DIMS, fixedHead = false) {
    this.kind = kind;
    this.fixedHead = fixedHead;
    this.r = rng(typeof seed === "number" ? seed : hashSeed(seed));
    const r = this.r;
    this.dims = dims;
    this.energy = lerp(0.85, 1.15, r());
    this.breathHz = pick(r, TUNE.breathHz);
    this.breathPh = r() * 2 * Math.PI;
    this.tiltSide = r() < 0.5 ? -1 : 1;
    this.shiftTarget = (r() < 0.5 ? -1 : 1) * lerp(0.4, 1, r());
    this.shift.x = this.shiftTarget;
    this.shiftEvery = new Every(r, TUNE.shiftEveryS[0], TUNE.shiftEveryS[1], r());
    this.lookEvery = new Every(r, TUNE.lookEveryS[0], TUNE.lookEveryS[1], r());
    this.nodEvery = new Every(r, TUNE.nodEveryS[0], TUNE.nodEveryS[1], r());
    this.gestureEvery = new Every(r, TUNE.gestureEveryS[0], TUNE.gestureEveryS[1], r());
    this.wagEvery = new Every(r, 3, 8, r());
    this.t = r() * 100;
    legIk(dims, dims.legZ, dims.legY, this.restLeg);
  }

  /** Starts a one-shot pose (replacing one of the same kind); `side`: the arm to use (reach, greet). */
  react(kind: Reaction, side?: Side) {
    for (const a of this.active) if (a.kind === kind && a.out < 0) a.out = 0;
    if (this.active.length >= 4) this.active.shift();
    this.active.push({ kind, t: 0, side: side ?? (kind === "reach" || kind === "greet" ? "right" : "left"), sign: this.r() < 0.5 ? -1 : 1, out: -1 });
  }

  /** Seconds left of a reaction of `kind` (0: none). */
  reacting(kind?: Reaction): number {
    let left = 0;
    for (const a of this.active) if ((!kind || a.kind === kind) && a.out < 0) left = Math.max(left, REACTION_S[a.kind] - a.t);
    return left;
  }

  /**
   * Turn-to-face: the body's new yaw from `current` toward `target` (critically damped, `omega`
   * 1/s: no overshoot from rest). The head runs its own, faster critically damped turn toward the
   * same target in world yaw, so it gets there first and holds while the body catches up; its
   * lead over the body is capped at TUNE.headLeadMaxDeg. Fixed heads (walkers, pigeons) don't lead.
   */
  turn(current: number, target: number, dt: number, omega: number = TUNE.turnOmega): number {
    const e = wrapAngle(current - target);
    const ex = Math.exp(-omega * dt);
    const tmp = (this.turnV + omega * e) * dt;
    this.turnV = (this.turnV - omega * tmp) * ex;
    let e2 = (e + tmp) * ex;
    if (Math.abs(e2) < 1e-4 && Math.abs(this.turnV) < 1e-3) {
      e2 = 0;
      this.turnV = 0;
    }
    const body = target + e2;
    if (this.fixedHead) return body;
    // the head's world yaw, as an error from the target (starts where the head is now)
    let h = Number.isNaN(this.headYaw) ? wrapAngle(current + this.lead.x - target) : wrapAngle(this.headYaw - target);
    const hw = TUNE.headTurnOmega;
    const hx = Math.exp(-hw * dt);
    const ht = (this.headV + hw * h) * dt;
    this.headV = (this.headV - hw * ht) * hx;
    h = (h + ht) * hx;
    this.headYaw = target + h;
    const max = TUNE.headLeadMaxDeg * DEG;
    this.lead.x = clamp(wrapAngle(this.headYaw - body), -max, max);
    this.lead.v = 0;
    this.leadFresh = true;
    return body;
  }

  /** The body was placed (a teleport, a scene start): no turn in flight. */
  resetTurn() {
    this.turnV = 0;
    this.headYaw = NaN;
    this.headV = 0;
    this.lead.x = this.lead.v = 0;
  }

  /** The head's lead over the body right now (rad). */
  get headLead(): number {
    return this.lead.x;
  }

  update(dt: number, i: AnimatorInputs) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.t += dt;
    this.rot.fill(0);
    this.hips.fill(0);
    for (const a of this.active) {
      a.t += dt;
      if (a.out >= 0) a.out += dt;
    }
    this.active = this.active.filter((a) => a.t < REACTION_S[a.kind] && a.out < REPLACE_S);
    const bw = 2.2 / TUNE.blendS;
    const W = this.w;
    const walkW = clamp(W.walk.step(i.walking ? 1 : 0, bw, dt), 0, 1);
    const talkW = clamp(W.talk.step(i.talking && !i.walking ? 1 : 0, bw, dt), 0, 1);
    const listenW = clamp(W.listen.step(i.listening && !i.talking && !i.walking ? 1 : 0, bw, dt), 0, 1);
    const dialogueW = clamp(W.dialogue.step((i.talking || i.listening) && !i.walking ? 1 : 0, bw, dt), 0, 1);
    const carryW = clamp(W.carry.step(i.carrying ? 1 : 0, bw, dt), 0, 1);
    const sitW = clamp(W.sit.step(i.sitting && !i.walking ? 1 : 0, bw * 0.7, dt), 0, 1);
    // a frame without turn(): the lead eases back to the body, the head's own turn is dropped
    if (!this.leadFresh) {
      this.lead.step(0, 6, dt);
      this.headYaw = NaN;
      this.headV = 0;
    }
    this.leadFresh = false;
    if (this.kind === "pet") return this.pet(dt, walkW);
    const feet = { left: { z: 0, lift: 0, pitch: 0 }, right: { z: 0, lift: 0, pitch: 0 } };
    this.idle(dt, 1 - walkW, walkW > 0.02 || talkW > 0.02 || listenW > 0.02 || i.talking || i.listening || this.active.length > 0);
    this.walk(dt, i.speed, walkW, carryW, feet);
    if (talkW > 1e-3) this.talk(dt, talkW, carryW);
    else this.gesture.t = -1;
    if (dialogueW > 1e-3) this.dialogue(dt, dialogueW, i.talking);
    else this.nod.t = -1;
    if (carryW > 1e-3) this.carry(carryW);
    for (const a of this.active) this.reaction(a);
    // turn-to-face lead: mostly the head, some neck
    this.add(HEAD, 1, this.lead.x * 0.7);
    this.add(NECK, 1, this.lead.x * 0.3);
    this.legs(feet, sitW);
  }

  private add(j: number, axis: 0 | 1 | 2, v: number) {
    this.rot[j * 3 + axis] += v;
  }

  /** breathing, weight shift, look-around; `w` fades it out while walking; `busy` (walking, dialogue, a reaction): no look-around */
  private idle(dt: number, w: number, busy: boolean) {
    const k = this.dims.k;
    const b = Math.sin(2 * Math.PI * this.breathHz * this.t + this.breathPh);
    // breathing: the chest lifts (pitches back a touch), the shoulders rise, all at ~0.25 Hz
    this.add(CHEST, 0, -TUNE.breathChestDeg * DEG * b * w);
    this.add(SPINE, 0, -0.3 * DEG * b * w);
    this.add(NECK, 0, (TUNE.breathChestDeg + 0.3) * DEG * b * w); // the neck undoes it exactly: the head stays level
    for (const side of ["left", "right"] as const) {
      const S = SIDE[side];
      this.add(S.sho, 2, S.s * TUNE.breathShoulderDeg * DEG * (0.5 + 0.5 * b) * w);
      this.add(S.fore, 0, -6 * DEG * w); // arms hang relaxed, a little bent
    }
    this.hips[1] += 0.0015 * k * b * w;
    // weight shift: onto one leg, every 4-8 s, eased over ~1.5 s
    // (not in dialogue or a reaction: a shift there tips the head through the chain; the last one just settles)
    if (!busy && this.shiftEvery.tick(dt)) this.shiftTarget = -Math.sign(this.shiftTarget || 1) * lerp(0.4, 1, this.r());
    const s = this.shift.step(this.shiftTarget, 2.4, dt) * w * this.energy;
    this.hips[0] += s * TUNE.shiftCm * 0.01 * k;
    this.add(HIPS, 2, s * TUNE.shiftHipDeg * DEG); // the loaded side's hip rises
    this.add(CHEST, 2, -s * TUNE.shiftHipDeg * 1.3 * DEG); // shoulders counter it
    this.add(HEAD, 2, s * TUNE.shiftHipDeg * 0.25 * DEG);
    const [ly, lp] = this.lookAround(dt, busy);
    this.add(HEAD, 1, ly * 0.7 * w);
    this.add(NECK, 1, ly * 0.3 * w);
    this.add(HEAD, 0, lp * w);
  }

  /**
   * The look-around glance (yaw, pitch): only when idle and out of dialogue, one every 6-12 s,
   * eased over TUNE.lookEaseS with a smoothstep (one monotonic turn, no spring), often back to the
   * front. Busy or a fixed head: back to the front in 0.8 s and the countdown waits.
   */
  private lookAround(dt: number, busy: boolean): [number, number] {
    const L = this.look;
    L.t += dt;
    const u = smooth(L.t / L.dur);
    const y = L.from[0] + (L.to[0] - L.from[0]) * u;
    const p = L.from[1] + (L.to[1] - L.from[1]) * u;
    const start = (ty: number, tp: number, dur: number) => {
      L.from = [y, p];
      L.to = [ty, tp];
      L.t = 0;
      L.dur = dur;
    };
    if (busy || this.fixedHead) {
      if (L.to[0] !== 0 || L.to[1] !== 0) start(0, 0, 0.8);
    } else if (this.lookEvery.tick(dt)) {
      const home = this.r() < 0.4 && (L.to[0] !== 0 || L.to[1] !== 0);
      start(home ? 0 : (this.r() * 2 - 1) * TUNE.lookYawDeg * DEG, home ? 0 : (this.r() * 2 - 1) * TUNE.lookPitchDeg * DEG, TUNE.lookEaseS);
    }
    return [y, p];
  }

  private walk(dt: number, speed: number, w: number, carryW: number, feet: Record<Side, { z: number; lift: number; pitch: number }>) {
    const k = this.dims.k;
    const v = this.speedS.step(Math.max(0, speed), 14, dt);
    const accel = dt > 0 ? (v - this.lastSpeedS) / dt : 0;
    this.lastSpeedS = v;
    this.accelLean.step(clamp(accel * TUNE.accelLeanDegPerMps2, -TUNE.accelLeanMaxDeg, TUNE.accelLeanMaxDeg) * DEG, 6, dt);
    // stop: a short settle dip (and it starts from zero: no pop)
    const walking = w > 0.5;
    if (this.wasWalking && !walking) this.settleT = 0;
    this.wasWalking = walking;
    if (this.settleT >= 0) {
      this.settleT += dt;
      const u = this.settleT / TUNE.settleS;
      if (u >= 1) this.settleT = -1;
      else {
        const s = bumpOf(u) * (1 - u * 0.5);
        this.hips[1] -= TUNE.settleCm * 0.01 * k * s;
        this.add(SPINE, 0, -1.5 * DEG * s);
        this.add(HEAD, 0, 1.0 * DEG * s);
      }
    }
    if (w < 1e-4) return;
    // the run blend follows the pace more slowly than the feet do: a stop doesn't snap the elbows
    const run = clamp(this.runS.step(smooth((v - TUNE.runFrom) / (TUNE.runTo - TUNE.runFrom)), 4, dt), 0, 1);
    const step = Math.min(TUNE.stepMaxM, TUNE.stepBaseM + TUNE.stepPerMps * Math.max(v, 0.6)) * k;
    // cycles per second: one cycle is two steps, so the feet cover 2 * step per cycle
    this.phase = (this.phase + (Math.max(v, 0.3) / (2 * step)) * dt) % 1;
    const ph = this.phase;
    const c = Math.cos(2 * Math.PI * ph);
    const duty = lerp(0.5, 0.4, run);
    const lift = lerp(TUNE.liftCm[0], TUNE.liftCm[1], run) * 0.01 * k;
    for (const side of ["left", "right"] as const) {
      const psi = (ph + (side === "left" ? 0 : 0.5)) % 1;
      const f = feet[side];
      const travel = 2 * step * duty; // body travel while this foot is down
      if (psi < duty) {
        f.z += (travel / 2 - (travel * psi) / duty) * w;
      } else {
        const u = (psi - duty) / (1 - duty);
        f.z += (-travel / 2 + travel * (0.5 - 0.5 * Math.cos(Math.PI * u))) * w;
        f.lift += lift * Math.sin(Math.PI * u) * w;
        f.pitch += 25 * DEG * Math.sin(Math.PI * u) * (u - 0.35) * w; // toe down at lift-off, up at strike
      }
    }
    // bob: lowest at each foot strike (twice a cycle), a small crouch under it
    const bob = lerp(TUNE.bobCm[0], TUNE.bobCm[1], run) * 0.01 * k;
    this.hips[1] -= (lerp(TUNE.crouchCm[0], TUNE.crouchCm[1], run) * 0.01 * k + bob * (0.5 + 0.5 * Math.cos(4 * Math.PI * ph))) * w;
    this.hips[0] += 0.008 * k * Math.sin(2 * Math.PI * ph) * (1 - run) * w; // over the stance foot
    // pelvis turns with the forward leg, shoulders counter it; a little pelvic drop
    const tw = (1 - 0.65 * carryW) * this.energy;
    const hipsYaw = -5 * DEG * c * tw * w;
    const chestYaw = 7 * DEG * c * tw * w;
    this.add(HIPS, 1, hipsYaw);
    this.add(CHEST, 1, chestYaw);
    const roll = -1.5 * DEG * Math.sin(2 * Math.PI * ph) * w;
    this.add(HIPS, 2, roll);
    // lean: into the pace and into acceleration; the head looks ahead (counters the chain)
    const lean = (lerp(TUNE.leanDeg[0], TUNE.leanDeg[1], run) * DEG + this.accelLean.x) * w;
    this.add(SPINE, 0, lean * 0.5);
    this.add(CHEST, 0, lean * 0.5);
    // the head keeps the heading exactly (cancels the pelvis / shoulder twist), looks ahead, stays level
    this.add(HEAD, 1, -(hipsYaw + chestYaw));
    this.add(HEAD, 0, -lean * 0.7);
    this.add(HEAD, 2, -roll);
    // arms: counter-swing (left arm forward with the right leg), elbows bend more going forward
    const amp = lerp(TUNE.armSwingDeg[0], TUNE.armSwingDeg[1], run) * DEG * this.energy * (1 - carryW) * w;
    for (const side of ["left", "right"] as const) {
      const S = SIDE[side];
      const fwd = amp * (side === "left" ? -1 : 1) * Math.cos(2 * Math.PI * (ph - 0.03));
      this.add(S.arm, 0, -fwd);
      this.add(S.arm, 2, S.s * 2 * DEG * w * (1 - carryW));
      this.add(S.fore, 0, -(8 * DEG + 50 * DEG * run) * w * (1 - carryW) - 0.6 * Math.max(0, fwd));
    }
  }

  /** the speaker's body: a lean toward the listener, a hand gesture now and then (the head is the dialogue layer's) */
  private talk(dt: number, w: number, carryW: number) {
    this.add(SPINE, 0, TUNE.talkLeanDeg * 0.5 * DEG * w);
    this.add(CHEST, 0, TUNE.talkLeanDeg * 0.5 * DEG * w);
    // a gesture: one forearm comes up 20-40 degrees for ~0.6 s
    const g = this.gesture;
    if (g.t < 0 && this.gestureEvery.tick(dt)) {
      g.t = 0;
      g.dur = pick(this.r, TUNE.gestureS);
      g.side = this.r() < 0.7 ? "right" : "left";
      g.amp = pick(this.r, TUNE.gestureForeDeg) * DEG;
    }
    if (g.t >= 0) {
      g.t += dt;
      const e = envelopeOf(g.t, g.dur, 0.18, 0.25) * w * (1 - carryW);
      const S = SIDE[g.side];
      this.add(S.fore, 0, -g.amp * e);
      this.add(S.arm, 0, -10 * DEG * e);
      this.add(S.arm, 2, S.s * 6 * DEG * e);
      this.add(S.hand, 0, -12 * DEG * e);
      if (g.t >= g.dur) g.t = -1;
    }
  }

  /**
   * The head in dialogue (talking or listening: one weight, so a line changing hands doesn't tip it
   * to and fro): a still tilt toward the other one, eyes a touch down, and a small nod (0.6-1.5
   * degrees, pitch only) every 2.2-3.5 s; listening skips some.
   */
  private dialogue(dt: number, w: number, talking: boolean) {
    const tilt = lerp(TUNE.listenTiltDeg[0], TUNE.listenTiltDeg[1], (this.energy - 0.85) / 0.3) * DEG;
    this.add(HEAD, 2, -this.tiltSide * tilt * w);
    this.add(HEAD, 0, 2 * DEG * w);
    const n = this.nod;
    if (this.nodEvery.tick(dt) && n.t < 0 && (talking || this.r() > TUNE.listenSkip)) {
      n.t = 0;
      n.amp = pick(this.r, talking ? TUNE.nodDeg : TUNE.listenNodDeg) * DEG;
    }
    if (n.t >= 0) {
      n.t += dt;
      const u = n.t / TUNE.nodS;
      this.add(HEAD, 0, n.amp * bumpOf(u) * w);
      if (u >= 1) n.t = -1;
    }
  }

  /** both forearms up in front of the chest, the chest back a touch */
  private carry(w: number) {
    for (const side of ["left", "right"] as const) {
      const S = SIDE[side];
      this.add(S.arm, 0, -22 * DEG * w);
      this.add(S.arm, 2, -S.s * 8 * DEG * w);
      this.add(S.fore, 0, -68 * DEG * w);
      this.add(S.hand, 0, 8 * DEG * w);
    }
    this.add(CHEST, 0, -2.5 * DEG * w);
  }

  private reaction(a: Active) {
    const d = REACTION_S[a.kind];
    const t = a.t;
    const k = this.dims.k;
    // a replaced one fades out: every term below is scaled through the envelope helpers
    const g = a.out < 0 ? 1 : 1 - smooth(a.out / REPLACE_S);
    const envelope = (tt: number, dd: number, at: number, rel: number) => g * envelopeOf(tt, dd, at, rel);
    const bump = (u: number) => g * bumpOf(u);
    const S = SIDE[a.side];
    switch (a.kind) {
      case "greet": {
        // hand up beside the head, forearm upright, three waves
        const e = envelope(t, d, 0.35, 0.4);
        const wave = Math.sin(2 * Math.PI * 2.2 * Math.max(0, t - 0.3)) * smooth((t - 0.25) / 0.2) * smooth((d - 0.35 - t) / 0.2);
        this.add(S.arm, 2, S.s * 112 * DEG * e);
        this.add(S.arm, 1, -S.s * 25 * DEG * e); // a little in front of the shoulder (the arm is out sideways: a yaw brings it forward)
        this.add(S.fore, 2, S.s * (56 + 22 * wave) * DEG * e);
        this.add(S.hand, 2, S.s * 8 * wave * DEG * e);
        this.add(CHEST, 2, -S.s * 3 * DEG * e);
        this.add(HEAD, 2, -S.s * 3 * DEG * e);
        this.add(HEAD, 0, -3 * DEG * e);
        break;
      }
      case "happy": {
        // anticipation (knees give), a small hop up, a soft landing
        const antic = bump(t / 0.28);
        const hop = bump((t - 0.2) / 0.38);
        const land = bump((t - 0.55) / 0.35);
        this.hips[1] += (0.05 * hop - 0.03 * antic - 0.015 * land) * k;
        const e = envelope(t, d, 0.2, 0.35);
        this.add(CHEST, 0, -4 * DEG * e);
        this.add(HEAD, 0, -5 * DEG * e);
        for (const side of ["left", "right"] as const) {
          const s = SIDE[side];
          this.add(s.arm, 2, s.s * 18 * DEG * e);
          this.add(s.fore, 0, -35 * DEG * e);
        }
        break;
      }
      case "confused": {
        // shoulders up, palms out, head tilted, a slight lean back
        const e = envelope(t, d, 0.25, 0.4);
        for (const side of ["left", "right"] as const) {
          const s = SIDE[side];
          this.add(s.sho, 2, s.s * 12 * DEG * e);
          this.add(s.arm, 2, s.s * 16 * DEG * e);
          this.add(s.fore, 0, -55 * DEG * e);
          this.add(s.hand, 2, s.s * 20 * DEG * e);
        }
        this.add(HEAD, 2, -a.sign * 9 * DEG * e);
        this.add(HEAD, 0, -2 * DEG * e);
        this.add(CHEST, 0, -3 * DEG * e);
        break;
      }
      case "nod": {
        const n = bump(t / d);
        this.add(HEAD, 0, 4 * DEG * n);
        this.add(NECK, 0, 1 * DEG * n);
        break;
      }
      case "reach": {
        // the near arm reaches forward, holds 0.4 s, comes back
        const e = envelope(t, d, 0.35, 0.35);
        this.add(S.arm, 0, -58 * DEG * e);
        this.add(S.arm, 2, -S.s * 8 * DEG * e);
        this.add(S.fore, 0, -18 * DEG * e);
        this.add(S.hand, 0, -10 * DEG * e);
        this.add(SPINE, 0, 3 * DEG * e);
        this.add(CHEST, 1, -S.s * 6 * DEG * e);
        this.add(HEAD, 0, 4 * DEG * e);
        break;
      }
    }
  }

  /** Both legs: IK to the feet targets under the hips offset, the weight shift kept planted, then the sit blend. */
  private legs(feet: Record<Side, { z: number; lift: number; pitch: number }>, sitW: number) {
    const D = this.dims;
    const hipsRoll = this.rot[HIPS * 3 + 2];
    const hipsYaw = this.rot[HIPS * 3 + 1];
    const dx = this.hips[0];
    // sitting: hips come down to the knees' rest height (the seat), thighs forward, shins down
    const sitDrop = D.thigh * sitW;
    this.hips[1] -= sitDrop;
    for (const side of ["left", "right"] as const) {
      const S = SIDE[side];
      const f = feet[side];
      legIk(D, D.legZ + f.z - this.hips[2], D.legY + this.hips[1] + sitDrop - f.lift, this.ik);
      const dThigh = this.ik.thigh - this.restLeg.thigh;
      const dShin = this.ik.shin - this.restLeg.shin;
      const stand = 1 - sitW;
      const thighX = -dThigh * stand - 90 * DEG * sitW;
      const shinX = (-dShin + dThigh) * stand + 90 * DEG * sitW;
      const footX = dShin * stand + f.pitch * stand;
      this.rot[S.thigh * 3 + 0] += thighX;
      this.rot[S.shin * 3 + 0] += shinX;
      this.rot[S.foot * 3 + 0] += footX;
      // keep the feet under the weight shift and level through the pelvis roll / turn
      const side_ = -Math.asin(clamp(dx / D.legY, -0.5, 0.5)) * stand;
      this.rot[S.thigh * 3 + 2] += side_ - hipsRoll;
      this.rot[S.thigh * 3 + 1] += -hipsYaw;
      this.rot[S.foot * 3 + 2] += -side_;
    }
  }

  /** pets: breathing, the look-around, a tail that rests and now and then wags in a burst */
  private pet(dt: number, walkW: number) {
    const b = Math.sin(2 * Math.PI * this.breathHz * 1.6 * this.t + this.breathPh);
    this.add(SPINE, 0, 1.5 * DEG * b);
    // the same look-around rules as people: idle only, one eased glance every 6-12 s, at most 20 degrees
    const [ly, lp] = this.lookAround(dt, walkW > 0.02);
    this.add(HEAD, 1, ly + this.lead.x);
    this.add(HEAD, 0, lp);
    if (this.wagT < 0 && this.wagEvery.tick(dt)) this.wagT = 0;
    let wag = 0;
    if (this.wagT >= 0) {
      this.wagT += dt;
      wag = envelopeOf(this.wagT, 1.4, 0.25, 0.4) * 18 * DEG * Math.sin(2 * Math.PI * 2.4 * this.wagT);
      if (this.wagT >= 1.4) this.wagT = -1;
    }
    this.add(TAIL, 1, wag + 8 * DEG * walkW); // no idle sway: the tail rests between wags
  }
}
