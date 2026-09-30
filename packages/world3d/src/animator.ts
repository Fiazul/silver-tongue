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
  lookEveryS: [2.5, 7],
  lookYawDeg: 28,
  lookPitchDeg: 5,
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
  headLeadS: 0.06,
  /** default turn-to-face stiffness (1/s): ~0.65 s to settle a big turn */
  turnOmega: 7,
  syllableHz: [2, 4],
  nodDeg: [1.2, 3.5],
  syllableSkip: 0.18,
  gestureEveryS: [2, 5],
  gestureS: [0.5, 0.75],
  gestureForeDeg: [20, 40],
  talkLeanDeg: 2.5,
  listenTiltDeg: [3, 5],
  listenNodEveryS: 2,
  listenNodDeg: [1.8, 3.2],
  listenSkip: 0.3,
} as const;

/** One-shot poses. greet: a raised-hand wave; happy: a little hop; confused: a shrug with a head tilt; nod: agreeing; reach: hand something over. */
export type Reaction = "greet" | "happy" | "confused" | "nod" | "reach";
export const REACTION_S: Record<Reaction, number> = { greet: 2.0, happy: 1.0, confused: 1.1, nod: 0.7, reach: 1.1 };

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
  private syllableHzLo: number;
  private tiltSide: number;
  // weights
  readonly w = { walk: new Damped(), talk: new Damped(), listen: new Damped(), carry: new Damped(), sit: new Damped() };
  // idle
  private shift = new Damped();
  private shiftTarget = 0;
  private shiftEvery: Every;
  private lookYaw = new Damped();
  private lookPitch = new Damped();
  private lookTarget = [0, 0];
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
  private syl = { t: 0, dur: 0.3, amp: 0 };
  private emphasis = new Damped();
  private phraseTilt = 0;
  private emphasisEvery: Every;
  private gestureEvery: Every;
  private gesture = { t: -1, dur: 0.6, side: "right" as Side, amp: 0.5 };
  // listen
  private listenEvery: Every;
  private listenNod = { t: -1, amp: 0 };
  // react
  private active: Active[] = [];
  // face
  private turnV = 0;
  private leadTarget = 0;
  private lead = new Damped();
  // pets
  private wagEvery: Every;
  private wagT = -1;

  constructor(seed: string | number, kind: "human" | "pet" = "human", dims: RigDims = DEFAULT_DIMS) {
    this.kind = kind;
    this.r = rng(typeof seed === "number" ? seed : hashSeed(seed));
    const r = this.r;
    this.dims = dims;
    this.energy = lerp(0.85, 1.15, r());
    this.breathHz = pick(r, TUNE.breathHz);
    this.breathPh = r() * 2 * Math.PI;
    this.syllableHzLo = lerp(TUNE.syllableHz[0], 2.6, r());
    this.tiltSide = r() < 0.5 ? -1 : 1;
    this.shiftTarget = (r() < 0.5 ? -1 : 1) * lerp(0.4, 1, r());
    this.shift.x = this.shiftTarget;
    this.shiftEvery = new Every(r, TUNE.shiftEveryS[0], TUNE.shiftEveryS[1], r());
    this.lookEvery = new Every(r, TUNE.lookEveryS[0], TUNE.lookEveryS[1], r());
    this.emphasisEvery = new Every(r, 1.5, 3.5, r());
    this.gestureEvery = new Every(r, TUNE.gestureEveryS[0], TUNE.gestureEveryS[1], r());
    this.listenEvery = new Every(r, TUNE.listenNodEveryS * 0.7, TUNE.listenNodEveryS * 1.3, r());
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
   * 1/s); the head leads by the rest of the way (up to TUNE.headLeadMaxDeg), eased in `update`.
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
    this.leadTarget = clamp(wrapAngle(-e2), -TUNE.headLeadMaxDeg * DEG, TUNE.headLeadMaxDeg * DEG);
    return target + e2;
  }

  /** The body was placed (a teleport, a scene start): no turn in flight. */
  resetTurn() {
    this.turnV = 0;
    this.leadTarget = 0;
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
    const carryW = clamp(W.carry.step(i.carrying ? 1 : 0, bw, dt), 0, 1);
    const sitW = clamp(W.sit.step(i.sitting && !i.walking ? 1 : 0, bw * 0.7, dt), 0, 1);
    // the head leads the body's turn (consumed: a frame without turn() lets it ease back)
    this.lead.step(this.leadTarget, 1 / TUNE.headLeadS, dt);
    this.leadTarget = 0;
    if (this.kind === "pet") return this.pet(dt, walkW);
    const feet = { left: { z: 0, lift: 0, pitch: 0 }, right: { z: 0, lift: 0, pitch: 0 } };
    this.idle(dt, 1 - walkW, talkW + listenW);
    this.walk(dt, i.speed, walkW, carryW, feet);
    if (talkW > 1e-3) this.talk(dt, talkW, carryW);
    else this.gesture.t = -1;
    if (listenW > 1e-3) this.listen(dt, listenW);
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

  /** breathing, weight shift, look-around; `w` fades it out while walking, `busy` damps the look-around (talking, listening) */
  private idle(dt: number, w: number, busy: number) {
    const k = this.dims.k;
    const b = Math.sin(2 * Math.PI * this.breathHz * this.t + this.breathPh);
    // breathing: the chest lifts (pitches back a touch), the shoulders rise, all at ~0.25 Hz
    this.add(CHEST, 0, -TUNE.breathChestDeg * DEG * b * w);
    this.add(SPINE, 0, -0.3 * DEG * b * w);
    this.add(NECK, 0, TUNE.breathChestDeg * 0.6 * DEG * b * w); // the head stays level
    for (const side of ["left", "right"] as const) {
      const S = SIDE[side];
      this.add(S.sho, 2, S.s * TUNE.breathShoulderDeg * DEG * (0.5 + 0.5 * b) * w);
      this.add(S.fore, 0, -6 * DEG * w); // arms hang relaxed, a little bent
    }
    this.hips[1] += 0.0015 * k * b * w;
    // weight shift: onto one leg, every 4-8 s, eased over ~1.5 s
    if (this.shiftEvery.tick(dt)) this.shiftTarget = -Math.sign(this.shiftTarget || 1) * lerp(0.4, 1, this.r());
    const s = this.shift.step(this.shiftTarget, 2.4, dt) * w * this.energy;
    this.hips[0] += s * TUNE.shiftCm * 0.01 * k;
    this.add(HIPS, 2, s * TUNE.shiftHipDeg * DEG); // the loaded side's hip rises
    this.add(CHEST, 2, -s * TUNE.shiftHipDeg * 1.3 * DEG); // shoulders counter it
    this.add(HEAD, 2, s * TUNE.shiftHipDeg * 0.25 * DEG);
    // look-around: now and then a glance somewhere, held, often back to the front
    if (this.lookEvery.tick(dt)) {
      const home = this.r() < 0.4;
      this.lookTarget[0] = home ? 0 : (this.r() * 2 - 1) * TUNE.lookYawDeg * DEG;
      this.lookTarget[1] = home ? 0 : (this.r() * 2 - 1) * TUNE.lookPitchDeg * DEG;
    }
    const quiet = 1 - clamp(busy, 0, 1) * 0.85;
    const ly = this.lookYaw.step(this.lookTarget[0] * quiet, 4, dt) * w;
    const lp = this.lookPitch.step(this.lookTarget[1] * quiet, 4, dt) * w;
    this.add(HEAD, 1, ly * 0.75);
    this.add(NECK, 1, ly * 0.25);
    this.add(CHEST, 1, ly * 0.12);
    this.add(HEAD, 0, lp);
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
    this.add(HEAD, 1, -(hipsYaw + chestYaw) * 0.9);
    this.add(HEAD, 0, -lean * 0.7 + 1.2 * DEG * Math.cos(4 * Math.PI * ph) * w * 0.4);
    this.add(HEAD, 2, -roll * 0.8);
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

  /** a pseudo-syllable clock (2-4 Hz, random amplitude and skips) nods the head; gestures now and then; a lean toward the listener */
  private talk(dt: number, w: number, carryW: number) {
    const s = this.syl;
    s.t += dt;
    if (s.t >= s.dur) {
      s.t -= s.dur;
      s.dur = 1 / lerp(this.syllableHzLo, TUNE.syllableHz[1], this.r());
      s.amp = this.r() < TUNE.syllableSkip ? 0 : pick(this.r, TUNE.nodDeg) * DEG;
    }
    const nod = s.amp * bumpOf(s.t / s.dur);
    // phrase by phrase (every 1.5-3.5 s) the head settles into a new slight tilt
    if (this.emphasisEvery.tick(dt)) this.phraseTilt = (this.r() * 2 - 1) * 3 * DEG;
    const emph = this.emphasis.step(this.phraseTilt, 3, dt);
    this.add(HEAD, 0, (nod + 1.5 * DEG) * w);
    this.add(NECK, 0, nod * 0.35 * w);
    this.add(HEAD, 2, -emph * w);
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

  /** a head tilt toward the speaker, slow nods (~0.5 Hz) with random skips */
  private listen(dt: number, w: number) {
    const tilt = lerp(TUNE.listenTiltDeg[0], TUNE.listenTiltDeg[1], (this.energy - 0.85) / 0.3) * DEG;
    this.add(HEAD, 2, -this.tiltSide * tilt * w);
    this.add(HEAD, 0, 2 * DEG * w);
    if (this.listenEvery.tick(dt) && this.listenNod.t < 0 && this.r() > TUNE.listenSkip) {
      this.listenNod.t = 0;
      this.listenNod.amp = pick(this.r, TUNE.listenNodDeg) * DEG;
    }
    if (this.listenNod.t >= 0) {
      this.listenNod.t += dt;
      const u = this.listenNod.t / 0.55;
      this.add(HEAD, 0, this.listenNod.amp * bumpOf(u) * w);
      if (u >= 1) this.listenNod.t = -1;
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
        this.add(HEAD, 0, 9 * DEG * n);
        this.add(NECK, 0, 3 * DEG * n);
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

  /** pets: breathing, look-around (quicker), a tail that idles and now and then wags in a burst */
  private pet(dt: number, walkW: number) {
    const b = Math.sin(2 * Math.PI * this.breathHz * 1.6 * this.t + this.breathPh);
    this.add(SPINE, 0, 1.5 * DEG * b);
    if (this.lookEvery.tick(dt)) {
      const home = this.r() < 0.35;
      this.lookTarget[0] = home ? 0 : (this.r() * 2 - 1) * 35 * DEG;
      this.lookTarget[1] = home ? 0 : (this.r() * 2 - 1) * 10 * DEG;
    }
    this.add(HEAD, 1, this.lookYaw.step(this.lookTarget[0], 7, dt) + this.lead.x);
    this.add(HEAD, 0, this.lookPitch.step(this.lookTarget[1], 7, dt));
    if (this.wagT < 0 && this.wagEvery.tick(dt)) this.wagT = 0;
    let wag = 0;
    if (this.wagT >= 0) {
      this.wagT += dt;
      wag = envelopeOf(this.wagT, 1.4, 0.25, 0.4) * 18 * DEG * Math.sin(2 * Math.PI * 2.4 * this.wagT);
      if (this.wagT >= 1.4) this.wagT = -1;
    }
    const drift = 6 * DEG * Math.sin(2 * Math.PI * 0.37 * this.t + this.breathPh) * (0.6 + 0.4 * Math.sin(0.23 * this.t));
    this.add(TAIL, 1, drift + wag + 8 * DEG * walkW);
  }
}
