// The fly-over (cutscene.ts) against town.json's camera path: the Hermite maths, and the handover
// to the game camera at the spawn with no jump.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAMERA, CameraRig } from "../src/camera";
import { CameraPathPlayer, poseAt } from "../src/cutscene";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { assetIndex } from "./helpers";

const path = LAYOUT.town.camera;
const keys = path.keys;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("the fly-over's path", () => {
  it("is at most 5 s (player: 'the scene is too long, make it at most 3-5 second')", () => {
    expect(path.duration).toBeLessThanOrEqual(5);
  });

  it("passes through every key (pos, look-at, fov) and is continuous between them", () => {
    expect(keys.length).toBeGreaterThan(3);
    expect(path.duration).toBe(keys.at(-1)!.t);
    for (const k of keys) {
      const p = poseAt(keys, k.t);
      expect(dist(p.pos, k.pos)).toBeLessThan(1e-9);
      expect(dist(p.lookAt, k.lookAt)).toBeLessThan(1e-9);
      expect(p.fovDeg).toBeCloseTo(k.fovDeg, 9);
    }
    // no jump anywhere, and no spike in speed either: every 24 fps step's distance stays within
    // 3x the path's mean per-step distance (the cut's aerial descent is fast throughout, so a
    // fixed metre cap no longer means anything; a spike relative to the mean would mean a stray
    // tangent, not the intended smooth ease-in / ease-out).
    const steps: number[] = [];
    let prev = poseAt(keys, 0);
    for (let t = 1 / 24; t <= path.duration; t += 1 / 24) {
      const p = poseAt(keys, t);
      steps.push(dist(p.pos, prev.pos));
      prev = p;
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const [i, d] of steps.entries()) expect(d, `step ${i}: ${d.toFixed(2)} m vs mean ${mean.toFixed(2)} m`).toBeLessThan(mean * 3);
    // before the start / after the end: clamped
    expect(poseAt(keys, -1).pos).toEqual(keys[0].pos);
    expect(poseAt(keys, path.duration + 5).pos).toEqual(keys.at(-1)!.pos);
  });

  it("stays over the ground throughout (no dip through the terrain on the cut's sharper turn)", () => {
    let minY = Infinity;
    for (let t = 0; t <= path.duration; t += 1 / 96) minY = Math.min(minY, poseAt(keys, t).pos[1]);
    expect(minY).toBeGreaterThan(0);
  });

  it("uses the stored tangents (Hermite): halfway through a segment matches the formula", () => {
    const [a, b] = [keys[1], keys[2]];
    const dt = b.t - a.t;
    const s = 0.5;
    const h = [2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2];
    const want = [0, 1, 2].map((i) => h[0] * a.pos[i] + h[1] * dt * a.posTangent[i] + h[2] * b.pos[i] + h[3] * dt * b.posTangent[i]);
    expect(dist(poseAt(keys, a.t + dt * s).pos, want)).toBeLessThan(1e-9);
    expect(poseAt(keys, a.t + dt * s).fovDeg).toBeCloseTo((a.fovDeg + b.fovDeg) / 2, 9);
  });

  it("the player runs it to the end, or stops at once on skip", () => {
    const cam = new THREE.PerspectiveCamera();
    const p = new CameraPathPlayer(path);
    let frames = 0;
    while (!p.update(1 / 60, cam) && frames < 10_000) frames++;
    expect(frames / 60).toBeCloseTo(path.duration, 1);
    expect(dist(cam.position.toArray(), keys.at(-1)!.pos)).toBeLessThan(1e-9);
    const q = new CameraPathPlayer(path);
    q.update(1 / 60, cam);
    q.skip();
    expect(q.update(1 / 60, cam)).toBe(true);
    expect(q.done).toBe(true);
  });
});

describe.skipIf(!assetIndex)("handing over to the game camera", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);

  it("the last key is the rig's pose at the spawn, within 1e-3 (position, look-at, fov); portrait scales both alike", () => {
    // the path was made for this very camera
    expect(path.endPose).toEqual({ elevationDeg: CAMERA.elevationDeg, azimuthDeg: CAMERA.azimuthDeg, distance: CAMERA.distance, aimHeight: CAMERA.aimHeight, fovDeg: CAMERA.fovDeg });
    const spawn = L.spawn(LAYOUT.defaultPlace);
    expect(L.spaceOf(LAYOUT.defaultPlace)).toBe(STREET);
    // the player stands at the walking height there (the plaza's top)
    const focus = new THREE.Vector3(spawn.pos[0], L.heightAt(STREET, spawn.pos[0], spawn.pos[2]), spawn.pos[2]);
    expect(focus.y).toBeCloseTo(spawn.pos[1], 6);
    for (const [w, h] of [
      [1600, 900],
      [390, 844],
    ]) {
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < 540);
      const fly = new CameraPathPlayer(path);
      fly.update(path.duration, rig.camera, rig.fov / CAMERA.fovDeg);
      const end = { pos: rig.camera.position.clone(), fov: rig.camera.fov, dir: rig.camera.getWorldDirection(new THREE.Vector3()) };
      rig.snap(focus);
      rig.camera.updateMatrixWorld();
      expect(rig.camera.position.distanceTo(end.pos), `${w}x${h} position`).toBeLessThan(1e-3);
      expect(rig.camera.getWorldDirection(new THREE.Vector3()).distanceTo(end.dir), `${w}x${h} direction`).toBeLessThan(1e-3);
      expect(Math.abs(rig.camera.fov - end.fov), `${w}x${h} fov`).toBeLessThan(1e-3);
      // and the rig aims at the last key's look-at
      const aim = focus.clone().setY(focus.y + CAMERA.aimHeight);
      expect(dist(aim.toArray(), keys.at(-1)!.lookAt), "look-at").toBeLessThan(1e-3);
    }
  });
});
