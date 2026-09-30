// One animated character (player, NPC, pet, street extra). A GLB with the shared human skeleton
// (st-human-v1) or the pet one (st-pet-v1) is posed procedurally every frame by animator.ts
// (layered idle / walk / talk / listen / carry / sit / reactions / turn-to-face, seeded per
// character); the baked clips are not played. The pose is in character axes; RigPose turns it into
// bone-local quaternions against the rest pose. A rig without those skeletons but with clips falls
// back to an AnimationMixer crossfading the states anim.ts picks; no bones at all: a small bob.
// The head bone anchors the speech bubble, grip bones hold props.
// No loader and no renderer here: it runs headless under vitest.
import * as THREE from "three";
import { ANIM_STATES, AnimMachine, clipFor, DEFAULT_STRIDE, FADE, WALK_ON, walkTimeScale, type AnimState } from "./anim";
import { Animator, DEFAULT_DIMS, FaceAim, HUMAN_JOINTS, NJ, PET_JOINTS, TUNE, type Reaction, type RigDims } from "./animator";
import { WALK_SPEED } from "./movement";

export const HEAD_BONE = "HeadTop";
/** The bone a head shake turns (the rig's neck-top head bone). */
export const SHAKE_BONE = "Head";
/** A one-shot shrug clip, if a rig ever brings one; without it, a shrug is `talk` plus a head shake. */
export const SHRUG_CLIP = "shrug";
export const SHRUG_SECONDS = 1.1;
export const GRIP_BONES = { right: "RightHandGrip", left: "LeftHandGrip" } as const;
export type Hand = keyof typeof GRIP_BONES;

export interface ActorOptions {
  /** metres covered by one loop of the walk clip (manifest `rig.stride_m`) */
  strideM?: number;
  /** head height (m) when the GLB has no HeadTop bone (manifest `anchors.head_top`) */
  headTopY?: number;
  /** seeds this character's timing (default: the rig's name and how many came before it) */
  seed?: string;
  /** false: never the procedural animator (the player: its baked clips on the mixer) */
  procedural?: boolean;
  /** the head keeps to the body's heading: no look-around, no turn lead (walkers, pigeons) */
  fixedHead?: boolean;
}

/** How many actors each rig name has had: the default seed, so two walkers of one GLB differ. */
const seedCounts = new Map<string, number>();

/** The rig's name: the `<name>_rig` armature node, else the first named node. */
function rigName(model: THREE.Object3D): string {
  let name = "";
  model.traverse((o) => {
    if (!name && o.name.endsWith("_rig")) name = o.name.slice(0, -4);
  });
  return name || model.name || "actor";
}

/**
 * The procedural pose on the bones: for each joint, local = rest * W^-1 * R * W, where W is the
 * bone's rest orientation in the model's frame and R the joint's rotation in character axes
 * (relative to its parent's posed frame); the hips offset goes through the parent's rest frame.
 */
class RigPose {
  private bones: (THREE.Object3D | null)[] = [];
  private restW: THREE.Quaternion[] = [];
  private w: THREE.Quaternion[] = [];
  private hipsBone: THREE.Object3D | null = null;
  private hipsRest = new THREE.Vector3();
  private hipsParentInv = new THREE.Matrix3();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(model: THREE.Object3D, slots: [string, number][], hips: string | null) {
    model.updateWorldMatrix(true, true);
    const inv = model.matrixWorld.clone().invert();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let i = 0; i < NJ; i++) {
      this.bones.push(null);
      this.restW.push(new THREE.Quaternion());
      this.w.push(new THREE.Quaternion());
    }
    for (const [name, i] of slots) {
      const b = model.getObjectByName(name);
      if (!b) continue;
      const W = new THREE.Quaternion();
      m.multiplyMatrices(inv, b.matrixWorld).decompose(p, W, sc);
      W.normalize();
      this.bones[i] = b;
      this.w[i] = W;
      this.restW[i] = b.quaternion.clone().multiply(W.clone().invert());
    }
    const h = hips ? model.getObjectByName(hips) : undefined;
    if (h?.parent) {
      this.hipsBone = h;
      this.hipsRest.copy(h.position);
      m.multiplyMatrices(inv, h.parent.matrixWorld);
      this.hipsParentInv.setFromMatrix4(m).invert();
    }
  }

  apply(a: Animator) {
    const r = a.rot;
    for (let i = 0; i < NJ; i++) {
      const b = this.bones[i];
      if (!b) continue;
      this.e.set(r[i * 3], r[i * 3 + 1], r[i * 3 + 2], "YXZ");
      this.q.setFromEuler(this.e);
      b.quaternion.copy(this.restW[i]).multiply(this.q).multiply(this.w[i]);
    }
    if (this.hipsBone) this.hipsBone.position.copy(this.hipsRest).add(this.v.fromArray(a.hips).applyMatrix3(this.hipsParentInv));
  }
}

const HUMAN_SLOTS: [string, number][] = HUMAN_JOINTS.map((n, i) => [n, i]);
const PET_SLOTS: [string, number][] = Object.entries(PET_JOINTS);

/** The rig's measurements from its rest pose (legs for the IK, height for the scale). */
function humanDims(model: THREE.Object3D, headTopY?: number): RigDims {
  model.updateWorldMatrix(true, true);
  const inv = model.matrixWorld.clone().invert();
  const at = (n: string) => model.getObjectByName(n)!.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const hip = at("LeftUpLeg");
  const knee = at("LeftLeg");
  const ankle = at("LeftFoot");
  const top = model.getObjectByName("HeadTop") ? at("HeadTop").y : headTopY ?? 1.7;
  return { k: top / 1.7, thigh: hip.distanceTo(knee), shin: knee.distanceTo(ankle), legZ: ankle.z - hip.z, legY: hip.y - ankle.y };
}

/** Blender may prefix clip names with the armature ("Armature|walk"): keep the last part. */
const clipName = (c: THREE.AnimationClip) => c.name.split("|").pop()!;

export class CharacterActor {
  /** moves and turns (owners set position / rotation.y); `body` inside it animates */
  readonly root = new THREE.Group();
  readonly body: THREE.Object3D;
  readonly machine = new AnimMachine();
  readonly mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<AnimState, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  /** metres one loop of the walk clip covers (footsteps follow it: audio.ts StrideClock) */
  readonly strideM: number;
  private headTopY: number;
  private headBone: THREE.Object3D | undefined;
  /** a scene is running and this character's line is on screen */
  talking = false;
  /** holding a prop flagged `carry` (a box, a bag): the carry pose */
  carrying = false;
  /** the prop on the grip bone, if any */
  held: THREE.Object3D | null = null;
  /** seconds left of a shrug (mix-up) */
  private shrugT = 0;
  private shakeBone: THREE.Object3D | undefined;
  private shrugAction: THREE.AnimationAction | null = null;
  /** the procedural animator (humans and pets on the shared skeletons), else null */
  readonly animator: Animator | null = null;
  private pose: RigPose | null = null;
  /** the dialogue aim with its dead zone (facePoint) */
  private aim = new FaceAim();
  /** the Head bone's rest orientation in the model, inverted (headAngles) */
  private headRestInv = new THREE.Quaternion();
  /** in a scene or a bark, the other one is talking: listen (head tilt, slow nods) */
  listening = false;
  /** seated (hips and knees bent) */
  sitting = false;
  // no-bones fallback
  private walkPhase = 0;
  private moving = 0; // 0..1, eased

  /** `model`: an instance from AssetCache.instance (SkeletonUtils clone, `animations` kept). */
  constructor(model: THREE.Object3D, opts: ActorOptions = {}) {
    this.body = model;
    this.root.add(model);
    this.strideM = opts.strideM ?? DEFAULT_STRIDE;
    this.headTopY = opts.headTopY ?? 1.7;
    this.headBone = model.getObjectByName(HEAD_BONE);
    this.shakeBone = model.getObjectByName(SHAKE_BONE);
    const base = opts.seed ?? rigName(model);
    const n = (seedCounts.get(base) ?? 0) + 1;
    seedCounts.set(base, n);
    const seed = opts.seed ?? `${base}#${n}`;
    const head = model.getObjectByName("Head");
    if (head) {
      model.updateWorldMatrix(true, true);
      const m = new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(head.matrixWorld);
      m.decompose(new THREE.Vector3(), this.headRestInv, new THREE.Vector3());
      this.headRestInv.normalize().invert();
    }
    const procedural = opts.procedural !== false;
    const has = (names: readonly string[]) => names.every((x) => model.getObjectByName(x));
    if (procedural && has(HUMAN_JOINTS)) {
      this.animator = new Animator(seed, "human", humanDims(model, opts.headTopY), opts.fixedHead === true);
      this.pose = new RigPose(model, HUMAN_SLOTS, "Hips");
      return;
    }
    if (procedural && has(Object.keys(PET_JOINTS))) {
      this.animator = new Animator(seed, "pet", DEFAULT_DIMS, opts.fixedHead === true);
      this.pose = new RigPose(model, PET_SLOTS, null);
      return;
    }
    const clips = model.animations.filter((c) => (ANIM_STATES as readonly string[]).includes(clipName(c)));
    if (clips.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const c of clips) this.actions.set(clipName(c) as AnimState, this.mixer.clipAction(c));
      this.current = this.action("idle");
      this.current?.play();
      const shrug = model.animations.find((c) => clipName(c) === SHRUG_CLIP);
      if (shrug) {
        this.shrugAction = this.mixer.clipAction(shrug);
        this.shrugAction.setLoop(THREE.LoopOnce, 1);
      }
    }
  }

  /** Whether the character animates beyond the no-bones bob (procedural pose or clips). */
  get animated(): boolean {
    return this.animator !== null || this.mixer !== null;
  }

  get state(): AnimState {
    return this.machine.state;
  }

  /** The action that plays `state` (after the clip fallbacks), if any. */
  action(state: AnimState): THREE.AnimationAction | null {
    const name = clipFor(state, new Set(this.actions.keys()));
    return name ? this.actions.get(name)! : null;
  }

  /** The action currently faded in. */
  get playing(): THREE.AnimationAction | null {
    return this.current;
  }

  bone(name: string): THREE.Object3D | undefined {
    return this.body.getObjectByName(name);
  }

  /**
   * Puts `prop` (origin at its grip) on a grip bone; false (and not attached) when the GLB has
   * none. Only `carry: true` props (boxes, bags) switch to the carry pose; a hand prop (fan, ladle,
   * keys, clipboard) keeps idle / walk / talk.
   */
  hold(prop: THREE.Object3D, opts: { hand?: Hand; carry?: boolean } = {}): boolean {
    const grip = this.bone(GRIP_BONES[opts.hand ?? "right"]);
    if (!grip) return false;
    grip.add(prop);
    this.held = prop;
    this.carrying = opts.carry === true;
    return true;
  }

  /** Puts down what `hold` gave it (the prop leaves the grip bone), back to the plain clips. */
  release(): THREE.Object3D | null {
    const prop = this.held;
    this.held = null;
    prop?.removeFromParent();
    this.carrying = false;
    return prop;
  }

  /** A mix-up: the confused pose (shoulders up, palms out, head tilt); clip rigs: a shrug clip or talk plus a head shake. */
  shrug() {
    if (this.animator) return this.react("confused");
    this.shrugT = SHRUG_SECONDS;
    if (this.shrugAction) this.shrugAction.reset().play();
  }

  get shrugging(): boolean {
    return this.animator ? this.animator.reacting("confused") > 0 : this.shrugT > 0;
  }

  /**
   * A one-shot pose (animator.ts Reaction). `toward`: a world point the reaction is aimed at (reach
   * and greet use the arm on that side). Clip rigs: confused shrugs, the rest is ignored.
   */
  react(kind: Reaction, toward?: THREE.Vector3) {
    if (!this.animator) {
      if (kind === "confused") this.shrug();
      return;
    }
    let side: "left" | "right" | undefined;
    if (toward && (kind === "reach" || kind === "greet")) {
      const local = this.root.worldToLocal(toward.clone());
      side = local.x > 0.05 ? "left" : "right";
      // a prop in the right hand: hand over / wave with the left
      if (this.held && this.held.parent?.name === GRIP_BONES.right && side === "right") side = "left";
    }
    this.animator.react(kind, side);
  }

  /**
   * Turn-to-face `yaw` (root.rotation.y): the body turns on a critically damped ease (no overshoot,
   * no oscillation) while the head leads by the rest of the turn. Without the animator: an ease.
   */
  face(yaw: number, dt: number, omega: number = TUNE.turnOmega) {
    this.aim.clear();
    this.turnTo(yaw, dt, omega);
  }

  /**
   * Turn-to-face a world point (the player): aimed once, re-aimed only when the point moves past
   * the dead zone (TUNE.aimDeadM / aimDeadDeg), each re-aim one smooth turn; never a continuous
   * track of every step.
   */
  facePoint(x: number, z: number, dt: number, omega: number = TUNE.turnOmega) {
    const p = this.root.position;
    this.turnTo(this.aim.aim(p.x, p.z, x, z), dt, omega);
  }

  /** The head's world orientation against its rest pose, degrees: yaw (0 = +z, toward +x positive), pitch (down positive), roll. */
  headAngles(): { yaw: number; pitch: number; roll: number } | null {
    const h = this.body.getObjectByName("Head");
    if (!h) return null;
    this.root.updateWorldMatrix(true, true);
    const q = h.getWorldQuaternion(new THREE.Quaternion()).multiply(this.headRestInv);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const R = 180 / Math.PI;
    const yaw = Math.atan2(f.x, f.z);
    // roll: the up vector's lean across the facing direction
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    return { yaw: yaw * R, pitch: Math.atan2(-f.y, Math.hypot(f.x, f.z)) * R, roll: Math.asin(Math.max(-1, Math.min(1, up.dot(side)))) * R };
  }

  private turnTo(yaw: number, dt: number, omega: number) {
    const r = this.root.rotation;
    if (this.animator) r.y = this.animator.turn(r.y, yaw, dt, omega);
    else {
      let d = yaw - r.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      r.y += d * Math.min(1, omega * 0.7 * dt);
    }
  }

  /** Sets the facing outright (a teleport, a placement): no turn in flight. */
  setFacing(yaw: number) {
    this.root.rotation.y = yaw;
    this.animator?.resetTurn();
  }

  /** Debug (world3d.anim()): the layer weights. */
  get layers(): Record<string, number> | null {
    const a = this.animator;
    if (!a) return null;
    const w = a.w;
    const out: Record<string, number> = {};
    for (const [k, d] of Object.entries(w)) out[k] = +Math.max(0, Math.min(1, d.x)).toFixed(2);
    out.react = +a.reacting().toFixed(2);
    return out;
  }

  /** The top of the head in world space: the HeadTop bone, else the manifest head_top height. */
  headTop(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.headBone) return this.headBone.getWorldPosition(out);
    this.root.updateWorldMatrix(true, false);
    return this.root.localToWorld(out.set(0, this.headTopY, 0));
  }

  /** `speed`: this frame's ground speed in m/s. */
  update(dt: number, speed: number) {
    this.shrugT = Math.max(0, this.shrugT - dt);
    const shaking = this.shrugT > 0 && !this.shrugAction;
    const change = this.machine.update({ speed, talking: this.talking || shaking, carrying: this.carrying });
    if (this.animator) {
      const st = this.machine.state;
      this.animator.update(dt, {
        speed,
        walking: st === "walk" || st === "carry_walk",
        talking: this.talking,
        listening: this.listening,
        carrying: this.carrying,
        sitting: this.sitting,
      });
      this.pose!.apply(this.animator);
      return;
    }
    if (!this.mixer) return this.bob(dt, speed);
    if (change) this.fadeTo(this.action(change.to));
    const st = this.machine.state;
    if (this.current && (st === "walk" || st === "carry_walk") && clipName(this.current.getClip()).endsWith("walk")) {
      // Feet match the ground: loop length scaled so one stride takes stride / speed seconds.
      this.current.timeScale = walkTimeScale(Math.max(speed, WALK_ON), this.strideM, this.current.getClip().duration);
    }
    this.mixer.update(dt);
    if (shaking && this.shakeBone) {
      // After the mixer (which rewrites the bone each frame): a no-no shake that eases out.
      const k = this.shrugT / SHRUG_SECONDS;
      this.shakeBone.rotation.y += Math.sin((SHRUG_SECONDS - this.shrugT) * 16) * 0.45 * k;
    }
  }

  private fadeTo(next: THREE.AnimationAction | null) {
    if (!next || next === this.current) return;
    next.reset();
    next.timeScale = 1;
    next.setEffectiveWeight(1);
    next.play();
    if (this.current) this.current.crossFadeTo(next, FADE, false);
    else next.fadeIn(FADE);
    this.current = next;
  }

  /** No bones: a step bob (twice a cycle) and a slight forward lean while moving; no side-to-side roll. */
  private bob(dt: number, speed: number) {
    const m = Math.min(1, speed / WALK_SPEED);
    this.moving += (m - this.moving) * Math.min(1, dt * 6);
    this.walkPhase += dt * 11 * this.moving;
    this.body.position.y = (0.5 - 0.5 * Math.cos(2 * this.walkPhase)) * 0.04 * this.moving;
    this.body.rotation.x = 0.1 * this.moving;
  }
}
