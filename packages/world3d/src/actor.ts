// One animated character (player, NPC, pet, street extra): an AnimationMixer over the GLB's clips,
// crossfading between the states anim.ts picks (idle / walk / talk / carry_*), walk playback
// scaled to the ground speed, the head bone for the speech bubble and grip bones for held props.
// A GLB without clips (the pre-rig exports) falls back to the procedural bob and lean.
// No loader and no renderer here: it runs headless under vitest with synthetic clips.
import * as THREE from "three";
import { ANIM_STATES, AnimMachine, clipFor, DEFAULT_STRIDE, FADE, WALK_ON, walkTimeScale, type AnimState } from "./anim";
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
  // procedural fallback
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

  /** Whether the GLB brought clips (else: the procedural bob). */
  get animated(): boolean {
    return this.mixer !== null;
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

  /** A mix-up: the rig's shrug clip if it has one, else talk plus a head shake. */
  shrug() {
    this.shrugT = SHRUG_SECONDS;
    if (this.shrugAction) this.shrugAction.reset().play();
  }

  get shrugging(): boolean {
    return this.shrugT > 0;
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

  /** No clips: bob and a slight forward lean while moving. */
  private bob(dt: number, speed: number) {
    const m = Math.min(1, speed / WALK_SPEED);
    this.moving += (m - this.moving) * Math.min(1, dt * 10);
    this.walkPhase += dt * 11 * this.moving;
    this.body.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.05 * this.moving;
    this.body.rotation.x = 0.1 * this.moving;
    this.body.rotation.z = Math.sin(this.walkPhase) * 0.035 * this.moving;
  }
}
