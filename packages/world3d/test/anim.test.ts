// The character animation state machine and walk playback maths (anim.ts), and CharacterActor
// (actor.ts) run headless on a synthetic rig: clips, crossfades, bones, the no-clip fallback.
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import { CharacterActor } from "../src/actor";
import { AnimMachine, clipFor, FADE, nextState, walkSpeed, walkTimeScale, WALK_OFF, WALK_ON, type AnimState } from "../src/anim";
import { WALK_SPEED } from "../src/movement";

const still = { speed: 0, talking: false, carrying: false };

describe("anim state machine", () => {
  it("idle -> walk -> idle from the ground speed, with hysteresis", () => {
    const m = new AnimMachine();
    expect(m.state).toBe("idle");
    expect(m.update({ ...still, speed: WALK_ON / 2 })).toBeNull(); // too slow to start
    expect(m.update({ ...still, speed: WALK_SPEED })).toEqual({ from: "idle", to: "walk" });
    expect(m.update({ ...still, speed: (WALK_ON + WALK_OFF) / 2 })).toBeNull(); // slowing, still walking
    expect(m.update({ ...still, speed: 0 })).toEqual({ from: "walk", to: "idle" });
  });

  it("talk on / off while standing; walking wins over talking", () => {
    const m = new AnimMachine();
    expect(m.update({ ...still, talking: true })).toEqual({ from: "idle", to: "talk" });
    expect(m.update({ ...still, talking: true })).toBeNull();
    expect(m.update({ ...still, talking: true, speed: 1 })).toEqual({ from: "talk", to: "walk" });
    expect(m.update({ ...still, talking: true })).toEqual({ from: "walk", to: "talk" });
    expect(m.update(still)).toEqual({ from: "talk", to: "idle" });
  });

  it("carry on / off, standing and walking; talking with a prop uses talk", () => {
    const m = new AnimMachine();
    expect(m.update({ ...still, carrying: true })).toEqual({ from: "idle", to: "carry_idle" });
    expect(m.update({ ...still, carrying: true, speed: 2 })).toEqual({ from: "carry_idle", to: "carry_walk" });
    expect(m.update({ ...still, carrying: false, speed: 2 })).toEqual({ from: "carry_walk", to: "walk" });
    expect(m.update({ ...still, carrying: true, speed: 2 })).toEqual({ from: "walk", to: "carry_walk" });
    expect(m.update({ ...still, carrying: true })).toEqual({ from: "carry_walk", to: "carry_idle" });
    expect(nextState("carry_idle", { ...still, carrying: true, talking: true })).toBe("talk");
    expect(m.update(still)).toEqual({ from: "carry_idle", to: "idle" });
  });

  it("falls back to the clips a GLB has", () => {
    const pet = new Set(["idle"]);
    for (const s of ["idle", "walk", "talk", "carry_idle", "carry_walk"] as AnimState[]) expect(clipFor(s, pet)).toBe("idle");
    const human = new Set(["idle", "walk", "talk"]);
    expect(clipFor("carry_walk", human)).toBe("walk");
    expect(clipFor("carry_idle", human)).toBe("idle");
    expect(clipFor("talk", human)).toBe("talk");
    expect(clipFor("walk", new Set())).toBeNull();
  });

  it("walk timeScale: feet cover exactly the move speed", () => {
    // 1.4 m per 1 s loop walks at 1.4 m/s at timeScale 1; at WALK_SPEED 3.2 m/s it plays 3.2/1.4 as fast.
    expect(walkSpeed(1.4, 1)).toBeCloseTo(1.4);
    expect(walkSpeed(1.4, 1, 2)).toBeCloseTo(2.8);
    const ts = walkTimeScale(WALK_SPEED, 1.4, 1);
    expect(ts).toBeCloseTo(3.2 / 1.4);
    expect(walkSpeed(1.4, 1, ts)).toBeCloseTo(WALK_SPEED);
    // 24-frame loop (1 s at 24 fps) vs a 32-frame one: the longer clip plays faster for the same stride.
    expect(walkTimeScale(2, 1.2, 32 / 24) / walkTimeScale(2, 1.2, 1)).toBeCloseTo(32 / 24);
  });
});

/** A two-bone skinned box with HeadTop and RightHandGrip bones and the given clips (1 s each). */
function rig(clipNames: string[]): THREE.Object3D {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  const head = new THREE.Bone();
  head.name = "HeadTop";
  head.position.y = 1.7;
  const grip = new THREE.Bone();
  grip.name = "RightHandGrip";
  grip.position.set(-0.3, 0.9, 0);
  hips.add(head, grip);
  const geo = new THREE.BoxGeometry(0.4, 1.7, 0.3);
  const n = geo.getAttribute("position").count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(n).fill([1, 0, 0, 0]).flat(), 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.name = "body";
  root.add(hips, mesh);
  mesh.bind(new THREE.Skeleton([hips, head, grip]));
  root.animations = clipNames.map(
    (name) => new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack("Hips.position[y]", [0, 0.5, 1], [0, 0.02, 0])]),
  );
  return root;
}

describe("CharacterActor", () => {
  const all = ["idle", "walk", "talk", "carry_idle", "carry_walk"];

  it("crossfades between clips as the state changes", () => {
    const a = new CharacterActor(cloneSkinned(rig(all)), { strideM: 1.4 });
    expect(a.animated).toBe(true);
    expect(a.playing?.getClip().name).toBe("idle");
    a.update(1 / 60, WALK_SPEED);
    expect(a.state).toBe("walk");
    expect(a.playing?.getClip().name).toBe("walk");
    const idle = a.action("idle")!;
    for (let t = 0; t < FADE + 0.05; t += 1 / 60) a.update(1 / 60, WALK_SPEED);
    expect(idle.getEffectiveWeight()).toBe(0); // faded out
    expect(a.playing!.getEffectiveWeight()).toBe(1);
    expect(a.playing!.timeScale).toBeCloseTo(walkTimeScale(WALK_SPEED, 1.4, 1)); // no foot slide
    a.update(1 / 60, 0);
    expect(a.playing?.getClip().name).toBe("idle");
    a.talking = true;
    a.update(1 / 60, 0);
    expect(a.playing?.getClip().name).toBe("talk");
    a.talking = false;
    a.update(1 / 60, 0);
    expect(a.playing?.getClip().name).toBe("idle");
  });

  it("a hand prop (fan, ladle, keys, clipboard) keeps idle and talk: no carry pose", () => {
    const a = new CharacterActor(cloneSkinned(rig(all)));
    const fan = new THREE.Group();
    expect(a.hold(fan)).toBe(true);
    expect(fan.parent?.name).toBe("RightHandGrip");
    expect(a.carrying).toBe(false);
    a.update(1 / 60, 0);
    expect(a.state).toBe("idle");
    expect(a.playing?.getClip().name).toBe("idle");
    a.talking = true;
    a.update(1 / 60, 0);
    expect(a.playing?.getClip().name).toBe("talk");
  });

  it("a mix-up shrug: talk plus a head shake when the rig has no shrug clip, then back to idle", () => {
    const a = new CharacterActor(cloneSkinned(rig(all)));
    a.shrug();
    a.update(1 / 60, 0);
    expect(a.shrugging).toBe(true);
    expect(a.playing?.getClip().name).toBe("talk");
    for (let t = 0; t < 1.3; t += 1 / 60) a.update(1 / 60, 0);
    expect(a.shrugging).toBe(false);
    expect(a.playing?.getClip().name).toBe("idle");
  });

  it("holds a carry prop (carry: true) on the grip bone (carry_*), anchors the head on HeadTop", () => {
    const a = new CharacterActor(cloneSkinned(rig(all)));
    a.root.position.set(5, 0, 2);
    const prop = new THREE.Group();
    expect(a.hold(prop, { carry: true })).toBe(true);
    expect(prop.parent?.name).toBe("RightHandGrip");
    a.update(1 / 60, 0);
    expect(a.state).toBe("carry_idle");
    a.update(1 / 60, WALK_SPEED);
    expect(a.playing?.getClip().name).toBe("carry_walk");
    const head = a.headTop();
    expect(head.x).toBeCloseTo(5);
    expect(head.y).toBeCloseTo(1.7, 1); // the clips bob the hips 2 cm
    expect(head.z).toBeCloseTo(2);
  });

  it("clones bind to their own bones (SkeletonUtils)", () => {
    const template = rig(all);
    const a = cloneSkinned(template);
    const mesh = a.getObjectByName("body") as THREE.SkinnedMesh;
    expect(mesh.skeleton.bones[0]).toBe(a.getObjectByName("Hips"));
    expect(mesh.skeleton.bones[0]).not.toBe(template.getObjectByName("Hips"));
  });

  it("pets: idle is all they play", () => {
    const a = new CharacterActor(cloneSkinned(rig(["idle"])));
    a.update(1 / 60, WALK_SPEED);
    expect(a.playing?.getClip().name).toBe("idle");
  });

  it("no clips: the procedural bob, no mixer", () => {
    const a = new CharacterActor(new THREE.Group(), { headTopY: 1.6 });
    expect(a.animated).toBe(false);
    a.update(0.1, WALK_SPEED);
    expect(a.state).toBe("walk");
    expect(a.body.rotation.x).toBeGreaterThan(0); // leaning into the walk
    expect(a.hold(new THREE.Group())).toBe(false); // no grip bone: no prop, no carry
    expect(a.headTop().y).toBeCloseTo(1.6);
  });
});
