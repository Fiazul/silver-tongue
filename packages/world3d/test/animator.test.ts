// The layered procedural animator (animator.ts) and its rig binding in CharacterActor (actor.ts):
// no pops between states, determinism per seed, the gait tracking speed, idle amplitudes, a
// turn-to-face that converges without overshoot, talk / listen rhythms, the reactions on the real
// rig (player / kid / cat GLBs), planted feet, and the per-frame cost.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { beforeAll, describe, expect, it } from "vitest";
import { CharacterActor } from "../src/actor";
import { Animator, DEFAULT_DIMS, DEG, HUMAN_JOINTS, NJ, TUNE, wrapAngle, type AnimatorInputs, type Reaction } from "../src/animator";
import { ASSETS, readGlb } from "./helpers";

const still: AnimatorInputs = { speed: 0, walking: false, talking: false, listening: false, carrying: false, sitting: false };
const J = (name: (typeof HUMAN_JOINTS)[number]) => HUMAN_JOINTS.indexOf(name);
const rot = (a: Animator, name: (typeof HUMAN_JOINTS)[number], axis: 0 | 1 | 2) => a.rot[J(name) * 3 + axis];

/** Runs `a` for `seconds` at `hz` with inputs `i`; `each` sees every frame. */
function run(a: Animator, seconds: number, i: Partial<AnimatorInputs>, hz = 60, each?: (t: number) => void) {
  const dt = 1 / hz;
  const n = Math.round(seconds * hz);
  for (let f = 0; f < n; f++) {
    a.update(dt, { ...still, ...i });
    each?.(f * dt);
  }
}

describe("animator: blending", () => {
  /** The whole state tour (every state, both paces, sit, each reaction re-triggered mid-way, turns) at `hz`: the largest joint / hips change in one frame. */
  const tour = (hz: number) => {
    const a = new Animator("blend");
    const prev = new Float32Array(NJ * 3);
    const prevH = new Float32Array(3);
    let maxRot = 0;
    let maxHips = 0;
    let first = true;
    const probe = () => {
      if (!first) {
        for (let j = 0; j < NJ * 3; j++) maxRot = Math.max(maxRot, Math.abs(a.rot[j] - prev[j]));
        for (let j = 0; j < 3; j++) maxHips = Math.max(maxHips, Math.abs(a.hips[j] - prevH[j]));
      }
      first = false;
      prev.set(a.rot);
      prevH.set(a.hips);
    };
    run(a, 2, {}, hz, probe);
    run(a, 2, { speed: 1.1, walking: true }, hz, probe);
    run(a, 2, { speed: 3.2, walking: true }, hz, probe);
    run(a, 1, {}, hz, probe); // a stop with its settle
    run(a, 2, { talking: true }, hz, probe);
    run(a, 2, { listening: true }, hz, probe);
    run(a, 1, { talking: true, speed: 1.1, walking: true }, hz, probe); // talk -> walk
    run(a, 1, { carrying: true }, hz, probe);
    run(a, 1, { carrying: true, speed: 1.1, walking: true }, hz, probe);
    run(a, 2, { sitting: true }, hz, probe);
    run(a, 2, {}, hz, probe);
    for (const r of ["greet", "happy", "confused", "nod", "reach"] as Reaction[]) {
      a.react(r);
      run(a, 0.5, { talking: r === "nod" }, hz, probe);
      a.react(r); // re-triggered mid-way: the old one fades under the new, no pop
      run(a, 2.2, {}, hz, probe);
    }
    let yaw = 0;
    for (let f = 0; f < 2 * hz; f++) {
      yaw = a.turn(yaw, f < hz ? 2.5 : -1, 1 / hz);
      a.update(1 / hz, still);
      probe();
    }
    return { rot: maxRot / DEG, hips: maxHips };
  };

  it("no pops: every state change and reaction eases (a jump would not shrink with the frame time)", () => {
    const at240 = tour(240);
    const at480 = tour(480);
    // continuous motion: half the frame time, about half the change; a pop stays the same size
    expect(at480.rot / at240.rot).toBeLessThan(0.6);
    expect(at480.hips / at240.hips).toBeLessThan(0.6);
    // and bounded: the fastest thing is a running knee (~860 degrees/s)
    expect(at240.rot).toBeLessThan(4);
    expect(at240.hips).toBeLessThan(0.005);
  });

  it("the same at 60 fps: state changes never move a joint more than a running stride does", () => {
    const measure = (fn: (a: Animator, probe: () => void) => void) => {
      const a = new Animator("fps60");
      const prev = new Float32Array(NJ * 3);
      let max = 0;
      let first = true;
      fn(a, () => {
        if (!first) for (let j = 0; j < NJ * 3; j++) max = Math.max(max, Math.abs(a.rot[j] - prev[j]));
        first = false;
        prev.set(a.rot);
      });
      return max / DEG;
    };
    const stride = measure((a, p) => run(a, 3, { speed: 3.2, walking: true }, 60, p));
    const changes = measure((a, p) => {
      for (const i of [{}, { talking: true }, { listening: true }, {}, { carrying: true }, { sitting: true }, {}]) run(a, 1.5, i, 60, p);
      for (const r of ["greet", "happy", "confused", "nod", "reach"] as Reaction[]) {
        a.react(r);
        run(a, 2.2, {}, 60, p);
      }
    });
    expect(stride).toBeLessThan(16);
    expect(changes).toBeLessThan(stride);
  });

  it("weights ease in and out: a state takes ~TUNE.blendS to come in, starting slow", () => {
    const a = new Animator("w");
    run(a, 1 / 60, { talking: true });
    const w1 = a.w.talk.x;
    run(a, TUNE.blendS, { talking: true });
    expect(w1).toBeLessThan(0.02); // ease-in: barely started after a frame
    expect(a.w.talk.x).toBeGreaterThan(0.6);
    run(a, 1, { talking: true });
    expect(a.w.talk.x).toBeGreaterThan(0.99);
    expect(a.w.talk.x).toBeLessThanOrEqual(1.0001);
  });
});

describe("animator: determinism and variety", () => {
  const trace = (seed: string) => {
    const a = new Animator(seed);
    const out: number[] = [];
    run(a, 20, {}, 60, () => out.push(rot(a, "Head", 1), rot(a, "Chest", 0), a.hips[0]));
    run(a, 10, { talking: true }, 60, () => out.push(rot(a, "Head", 0), rot(a, "RightForeArm", 0)));
    return out;
  };

  it("the same seed moves the same way", () => {
    expect(trace("old_wang#1")).toEqual(trace("old_wang#1"));
  });

  it("different seeds don't move in unison (breathing phase, look-around, gestures)", () => {
    const a = trace("customer_a#1");
    const b = trace("customer_a#2");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeGreaterThan(5 * DEG);
    // breathing: correlation of the two chests over 20 s is well short of lockstep
    const ca = a.filter((_, i) => i < 3600 && i % 3 === 1);
    const cb = b.filter((_, i) => i < 3600 && i % 3 === 1);
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    const ma = mean(ca);
    const mb = mean(cb);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < ca.length; i++) {
      num += (ca[i] - ma) * (cb[i] - mb);
      da += (ca[i] - ma) ** 2;
      db += (cb[i] - mb) ** 2;
    }
    expect(Math.abs(num / Math.sqrt(da * db))).toBeLessThan(0.9);
  });
});

describe("animator: walk", () => {
  /** gait cycles per second at `speed`: left thigh swings counted by its upward zero crossings */
  const cadence = (speed: number) => {
    const a = new Animator("gait");
    run(a, 2, { speed, walking: true });
    let crossings = 0;
    let last = rot(a, "LeftUpLeg", 0);
    let peak = 0;
    run(a, 20, { speed, walking: true }, 120, () => {
      const x = rot(a, "LeftUpLeg", 0);
      if (last < 0 && x >= 0) crossings++;
      last = x;
      peak = Math.max(peak, Math.abs(x));
    });
    return { hz: crossings / 20, peakDeg: peak / DEG };
  };
  const expected = (v: number) => v / (2 * Math.min(TUNE.stepMaxM, TUNE.stepBaseM + TUNE.stepPerMps * v));

  it("the cycle frequency tracks the ground speed (stride / cadence from speed)", () => {
    const slow = cadence(1.1);
    const mid = cadence(2);
    const fast = cadence(3.2);
    expect(slow.hz).toBeCloseTo(expected(1.1), 0);
    expect(Math.abs(slow.hz - expected(1.1)) / expected(1.1)).toBeLessThan(0.08);
    expect(Math.abs(fast.hz - expected(3.2)) / expected(3.2)).toBeLessThan(0.08);
    expect(slow.hz).toBeLessThan(mid.hz);
    expect(mid.hz).toBeLessThan(fast.hz);
    // legs swing wider running
    // thighs swing ~25-35 degrees walking (the swing leg's knee lift included), wider running
    expect(slow.peakDeg).toBeGreaterThan(20);
    expect(slow.peakDeg).toBeLessThan(36);
    expect(fast.peakDeg).toBeGreaterThan(slow.peakDeg);
    expect(fast.peakDeg).toBeLessThan(50);
  });

  it("arms counter-swing the legs, bob twice a cycle, and the head stays stabilised", () => {
    const a = new Animator("arms");
    run(a, 2, { speed: 1.4, walking: true });
    let corr = 0;
    let armPeak = 0;
    let headYaw = 0;
    let chestYaw = 0;
    const ys: number[] = [];
    run(a, 4, { speed: 1.4, walking: true }, 120, () => {
      corr += rot(a, "LeftArm", 0) * rot(a, "RightUpLeg", 0);
      armPeak = Math.max(armPeak, Math.abs(rot(a, "LeftArm", 0)));
      headYaw = Math.max(headYaw, Math.abs(rot(a, "Head", 1) + rot(a, "Chest", 1) + rot(a, "Hips", 1)));
      chestYaw = Math.max(chestYaw, Math.abs(rot(a, "Chest", 1)));
      ys.push(a.hips[1]);
    });
    expect(corr).toBeGreaterThan(0); // left arm goes forward (-X) with the right leg (-X)
    expect(armPeak / DEG).toBeGreaterThan(14);
    expect(armPeak / DEG).toBeLessThan(26);
    expect(headYaw).toBeLessThan(chestYaw * 0.5); // the chain's twist mostly cancelled at the head
    const bob = Math.max(...ys) - Math.min(...ys);
    expect(bob).toBeGreaterThan(0.015);
    expect(bob).toBeLessThan(0.035);
  });

  it("stopping settles: legs back to rest within ~1 s, no snap", () => {
    const a = new Animator("stop");
    let stride = 0;
    let last = 0;
    run(a, 2, { speed: 3.2, walking: true }, 60, () => {
      const x = rot(a, "LeftUpLeg", 0);
      stride = Math.max(stride, Math.abs(x - last));
      last = x;
    });
    run(a, 1 / 60, {});
    expect(Math.abs(rot(a, "LeftUpLeg", 0) - last)).toBeLessThanOrEqual(stride); // the first frame of the stop moves no more than running did
    run(a, 1, {});
    expect(Math.abs(rot(a, "LeftUpLeg", 0)) / DEG).toBeLessThan(1.5);
  });
});

describe("animator: idle", () => {
  it("breathing, weight shift and look-around stay within their bounds (kid smaller)", () => {
    const measure = (k: number) => {
      const a = new Animator("idle", "human", { ...DEFAULT_DIMS, k });
      const chest: number[] = [];
      let hipsX = 0;
      let headYaw = 0;
      let flips = 0;
      let lastSign = 0;
      run(a, 120, {}, 30, () => {
        chest.push(rot(a, "Chest", 0));
        hipsX = Math.max(hipsX, Math.abs(a.hips[0]));
        headYaw = Math.max(headYaw, Math.abs(rot(a, "Head", 1)));
        const s = Math.sign(a.hips[0]);
        if (s && lastSign && s !== lastSign) flips++;
        if (s) lastSign = s;
      });
      return { chestAmp: (Math.max(...chest) - Math.min(...chest)) / 2 / DEG, hipsX, headYaw: headYaw / DEG, flips };
    };
    const adult = measure(1);
    const kid = measure(0.65);
    expect(adult.chestAmp).toBeGreaterThan(0.5);
    expect(adult.chestAmp).toBeLessThan(3.5); // breathing + the counter to the weight shift
    expect(adult.hipsX).toBeGreaterThan(0.005);
    expect(adult.hipsX).toBeLessThanOrEqual(0.02 * 1.15);
    expect(kid.hipsX).toBeLessThan(adult.hipsX);
    expect(adult.headYaw).toBeGreaterThan(5); // it does look around
    expect(adult.headYaw).toBeLessThan(TUNE.lookYawDeg + 1);
    // weight shifts every 4-8 s: 120 s -> about 15-30 shifts (each a side change)
    expect(adult.flips).toBeGreaterThanOrEqual(12);
    expect(adult.flips).toBeLessThanOrEqual(31);
  });

  it("breathing runs at ~0.25 Hz", () => {
    const a = new Animator("breath");
    const xs: number[] = [];
    // no shift / look noise on the spine: the spine's pitch is breathing alone
    run(a, 60, {}, 30, () => xs.push(rot(a, "Spine", 0)));
    let c = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] < 0 && xs[i] >= 0) c++;
    expect(c / 60).toBeGreaterThanOrEqual(0.2);
    expect(c / 60).toBeLessThanOrEqual(0.32);
  });
});

describe("animator: turn-to-face", () => {
  it("converges without overshoot beyond 2 degrees; the head leads (<= 45 degrees) then recentres", () => {
    for (const target of [Math.PI / 2, 2.6, -3, 0.3]) {
      const a = new Animator(`turn${target}`);
      let yaw = 0;
      let over = 0;
      let lead = 0;
      let leadAt = -1;
      let bodyAt = -1;
      for (let f = 0; f < 120; f++) {
        yaw = a.turn(yaw, target, 1 / 60);
        a.update(1 / 60, still);
        const e = wrapAngle(yaw - target) * Math.sign(target);
        over = Math.max(over, e);
        lead = Math.max(lead, Math.abs(a.headLead));
        if (leadAt < 0 && Math.abs(a.headLead) > 10 * DEG) leadAt = f;
        if (bodyAt < 0 && Math.abs(wrapAngle(yaw)) > 10 * DEG) bodyAt = f;
      }
      expect(over / DEG).toBeLessThan(2);
      expect(lead / DEG).toBeLessThanOrEqual(45.01);
      expect(Math.abs(wrapAngle(yaw - target)) / DEG).toBeLessThan(1); // settled in 2 s
      expect(Math.abs(a.headLead) / DEG).toBeLessThan(2);
      if (Math.abs(target) > 0.5) expect(leadAt).toBeLessThanOrEqual(bodyAt); // head first
    }
  });

  it("a moving target (player walking round the NPC) is followed with no left-right oscillation", () => {
    const a = new Animator("follow");
    let yaw = 0;
    let dir = 0;
    let reversals = 0;
    let last = 0;
    for (let f = 0; f < 300; f++) {
      const target = Math.min(1.5, f / 100); // sweeps 0 -> 1.5 rad then holds
      const next = a.turn(yaw, target, 1 / 60);
      const d = Math.sign(next - yaw);
      if (d && last && d !== last && Math.abs(next - yaw) > 1e-4) reversals++;
      if (d) last = d;
      yaw = next;
      dir = d;
      a.update(1 / 60, still);
    }
    expect(reversals).toBe(0);
    expect(dir).toBeGreaterThanOrEqual(0);
    expect(Math.abs(yaw - 1.5) / DEG).toBeLessThan(1);
  });
});

describe("animator: talk, listen", () => {
  it("talk: nods on a 2-4 Hz syllable clock with random amplitude, a gesture every few seconds, a lean in", () => {
    const a = new Animator("talker");
    run(a, 1, { talking: true });
    const nods: number[] = [];
    let peaks = 0;
    let prev = 0;
    let rising = false;
    let gestures = 0;
    let inGesture = false;
    let foreMax = 0;
    run(a, 30, { talking: true }, 120, () => {
      const x = rot(a, "Neck", 0);
      if (x > prev) rising = true;
      else if (rising && x < prev) {
        peaks++;
        nods.push(prev);
        rising = false;
      }
      prev = x;
      const fore = Math.min(rot(a, "RightForeArm", 0), rot(a, "LeftForeArm", 0)) + 6 * DEG; // minus the relaxed bend
      foreMax = Math.max(foreMax, -fore);
      const g = -fore > 10 * DEG;
      if (g && !inGesture) gestures++;
      inGesture = g;
    });
    expect(peaks / 30).toBeGreaterThan(1.6);
    expect(peaks / 30).toBeLessThan(4.2);
    const amps = nods.filter((n) => n > 0.1 * DEG);
    expect(Math.max(...amps) - Math.min(...amps)).toBeGreaterThan(0.5 * DEG); // not a metronome
    expect(gestures).toBeGreaterThanOrEqual(30 / 5 - 1);
    expect(gestures).toBeLessThanOrEqual(30 / 2 + 1);
    expect(foreMax / DEG).toBeGreaterThan(18);
    expect(foreMax / DEG).toBeLessThan(42);
    expect((rot(a, "Spine", 0) + rot(a, "Chest", 0)) / DEG).toBeGreaterThan(1.5); // leaning toward the listener
  });

  it("listen: a 3-5 degree head tilt and slow nods (~0.5 Hz, some skipped)", () => {
    const a = new Animator("listener");
    run(a, 1, { listening: true });
    let nods = 0;
    let inNod = false;
    let tilt = 0;
    run(a, 40, { listening: true }, 60, () => {
      tilt = Math.max(tilt, Math.abs(rot(a, "Head", 2)));
      const p = rot(a, "Head", 0) - 2 * DEG;
      const n = p > 0.8 * DEG;
      if (n && !inNod) nods++;
      inNod = n;
    });
    expect(tilt / DEG).toBeGreaterThanOrEqual(2.9);
    expect(tilt / DEG).toBeLessThan(6);
    expect(nods / 40).toBeGreaterThan(0.2);
    expect(nods / 40).toBeLessThan(0.5); // ~0.5 Hz less the skips
  });
});

// ------------------------------------------------------------------------------------------
// On the real rigs
// ------------------------------------------------------------------------------------------

const templates = new Map<string, THREE.Object3D>();
beforeAll(async () => {
  for (const n of ["player", "kid", "cat", "old_wang"]) {
    const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readGlb(`${ASSETS}/characters/${n}.glb`), "");
    g.scene.animations = g.animations;
    templates.set(n, g.scene);
  }
});
const actor = (n: string, seed?: string) => new CharacterActor(cloneSkinned(templates.get(n)!), seed ? { seed } : {});
const world = (a: CharacterActor, bone: string) => {
  a.root.updateMatrixWorld(true);
  return a.bone(bone)!.getWorldPosition(new THREE.Vector3());
};

describe("CharacterActor on the real rigs", () => {
  it("humans and pets get the procedural animator; the kid is scaled down", () => {
    const p = actor("player");
    const kid = actor("kid");
    const cat = actor("cat");
    expect(p.animator?.kind).toBe("human");
    expect(kid.animator?.kind).toBe("human");
    expect(cat.animator?.kind).toBe("pet");
    expect(p.mixer).toBeNull(); // the baked sway clips aren't played
    expect(p.animated).toBe(true);
    // default seeds differ per instance: two walkers of one GLB aren't in step
    const w1 = actor("player");
    const w2 = actor("player");
    for (let i = 0; i < 120; i++) {
      w1.update(1 / 60, 0);
      w2.update(1 / 60, 0);
    }
    expect(world(w1, "Head").distanceTo(world(w2, "Head"))).toBeGreaterThan(1e-4);
  });

  it("the bind is intact: a zero pose is the rest pose", () => {
    const a = actor("player", "rest");
    const before = HUMAN_JOINTS.map((n) => a.bone(n)!.quaternion.clone());
    a.animator!.rot.fill(0);
    a.animator!.hips.fill(0);
    (a as unknown as { pose: { apply(x: Animator): void } }).pose.apply(a.animator!);
    // (angleTo is acos: a 1e-8 float32 wobble in the GLB's foot quaternions reads as ~0.03 degrees)
    HUMAN_JOINTS.forEach((n, i) => expect(a.bone(n)!.quaternion.angleTo(before[i])).toBeLessThan(1e-3));
  });

  it("walking plants the stance foot: it slips < 3 cm while the body moves over it", () => {
    for (const speed of [1.1, 3.2]) {
      const a = actor("player", "feet");
      let z = 0;
      let maxSlip = 0;
      let stanceStart: THREE.Vector3 | null = null;
      for (let f = 0; f < 360; f++) {
        z += speed / 120;
        a.root.position.z = z;
        a.update(1 / 120, speed);
        if (f < 120) continue;
        const foot = world(a, "LeftFoot");
        if (foot.y < 0.108) {
          stanceStart ??= foot.clone();
          maxSlip = Math.max(maxSlip, Math.abs(foot.z - stanceStart.z));
        } else stanceStart = null;
      }
      expect(maxSlip).toBeLessThan(0.03);
    }
  });

  it("reactions and poses land where they should on the rig", () => {
    const rest = actor("player", "r0");
    rest.update(1 / 60, 0);
    const hand0 = world(rest, "RightHand");
    const shoulder = world(rest, "RightArm");
    const hips0 = world(rest, "Hips");

    const greet = actor("player", "r1");
    greet.react("greet");
    for (let i = 0; i < 50; i++) greet.update(1 / 60, 0);
    expect(world(greet, "RightHand").y).toBeGreaterThan(shoulder.y + 0.2); // hand up beside the head
    expect(world(greet, "RightHand").y).toBeGreaterThan(world(greet, "RightForeArm").y + 0.12); // forearm upright

    const reach = actor("player", "r2");
    reach.react("reach", new THREE.Vector3(-0.5, 0, 2)); // someone in front, to its right
    for (let i = 0; i < 40; i++) reach.update(1 / 60, 0);
    expect(world(reach, "RightHand").z).toBeGreaterThan(hand0.z + 0.25);

    const left = actor("player", "r3");
    left.react("reach", new THREE.Vector3(0.8, 0, 1)); // to its left: the left arm
    for (let i = 0; i < 40; i++) left.update(1 / 60, 0);
    expect(world(left, "LeftHand").z).toBeGreaterThan(world(left, "RightHand").z + 0.2);

    const shrug = actor("player", "r4");
    shrug.shrug();
    expect(shrug.shrugging).toBe(true);
    for (let i = 0; i < 30; i++) shrug.update(1 / 60, 0);
    expect(world(shrug, "RightShoulder").distanceTo(world(rest, "RightShoulder"))).toBeLessThan(0.05);
    expect(world(shrug, "RightArm").y).toBeGreaterThan(shoulder.y + 0.01);
    for (let i = 0; i < 60; i++) shrug.update(1 / 60, 0);
    expect(shrug.shrugging).toBe(false);

    const carry = actor("player", "r5");
    carry.hold(new THREE.Group(), { carry: true });
    for (let i = 0; i < 60; i++) carry.update(1 / 60, 0);
    expect(world(carry, "RightHand").z).toBeGreaterThan(0.18);
    expect(world(carry, "LeftHand").z).toBeGreaterThan(0.18);
    expect(world(carry, "RightHand").y).toBeGreaterThan(hand0.y + 0.15);

    const sit = actor("player", "r6");
    sit.sitting = true;
    for (let i = 0; i < 90; i++) sit.update(1 / 60, 0);
    const knee = world(sit, "LeftLeg");
    expect(world(sit, "Hips").y).toBeLessThan(hips0.y - 0.25);
    expect(Math.abs(world(sit, "Hips").y - knee.y)).toBeLessThan(0.05); // thighs level
    expect(knee.z).toBeGreaterThan(0.25);
    expect(world(sit, "LeftFoot").y).toBeLessThan(0.13); // feet on the floor
  });

  it("face(): the head leads the body into a turn", () => {
    const a = actor("old_wang", "face");
    for (let i = 0; i < 10; i++) {
      a.face(Math.PI / 2, 1 / 60);
      a.update(1 / 60, 0);
    }
    expect(a.root.rotation.y).toBeGreaterThan(0);
    expect(a.animator!.headLead).toBeGreaterThan(10 * DEG);
    for (let i = 0; i < 120; i++) {
      a.face(Math.PI / 2, 1 / 60);
      a.update(1 / 60, 0);
    }
    expect(a.root.rotation.y).toBeCloseTo(Math.PI / 2, 2);
    a.setFacing(0);
    expect(a.root.rotation.y).toBe(0);
  });

  it("pets: head, spine and tail move, the root stays put", () => {
    const cat = actor("cat", "cat");
    const tail0 = cat.bone("Tail")!.quaternion.clone();
    let moved = 0;
    for (let i = 0; i < 600; i++) {
      cat.update(1 / 60, 0);
      moved = Math.max(moved, cat.bone("Tail")!.quaternion.angleTo(tail0));
    }
    expect(moved).toBeGreaterThan(3 * DEG);
    expect(cat.bone("Root")!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it("cost: 10 characters stay under 0.2 ms a frame (1000 updates)", () => {
    const cast = ["player", "old_wang", "kid", "player", "old_wang", "kid", "player", "old_wang", "kid", "player"].map((n, i) => actor(n, `cost${i}`));
    cast.forEach((a, i) => {
      a.talking = i % 3 === 0;
      a.listening = i % 3 === 1;
    });
    const frame = (f: number) => {
      for (let i = 0; i < cast.length; i++) {
        const walking = i % 2 === 0;
        cast[i].update(1 / 60, walking ? 1.1 + (f % 5) * 0.1 : 0);
      }
    };
    for (let f = 0; f < 200; f++) frame(f); // warm the JIT
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let f = 0; f < 1000; f++) frame(f);
      batches.push((performance.now() - t0) / 1000);
    }
    const best = Math.min(...batches);
    console.log(`animator cost: ${best.toFixed(4)} ms per frame of 10 characters (best of 5 x 1000; all: ${batches.map((b) => b.toFixed(4)).join(", ")})`);
    expect(best).toBeLessThan(0.2);
  });
});
