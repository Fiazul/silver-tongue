import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, CAMERA, INTERIOR_OUTLINE, outlineScale } from "../src/camera";
import { INTERIOR_PITCH_DEG } from "../src/interior-camera";
import { buildInteriorEnclosure, interiorFaces } from "../src/interior-enclosure";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { assetIndex } from "./helpers";

const L = new LayoutIndex(LAYOUT, assetIndex!);
const ids = Object.keys(LAYOUT.interiors).filter((id) => L.space(id).interior);
const flat = (color: string) => new THREE.MeshBasicMaterial({ color });
const ray = new THREE.Raycaster();

describe("enclosed gameplay interior camera", () => {
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 845], [390, 844]]) {
    it(`${id} ${w}x${h}: every first corner hit belongs to the room, bottom corners hit interior floor`, () => {
      const layout = L.space(id), room = layout.view!;
      const scene = new THREE.Scene();
      const enclosure = buildInteriorEnclosure(scene, layout, flat)!;
      scene.updateMatrixWorld(true);
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < h); rig.setSpace(layout);
      const assertFrame = () => {
        const eye = rig.camera.position;
        expect(eye.x).toBeGreaterThan(room.bounds.min[0]); expect(eye.x).toBeLessThan(room.bounds.max[0]);
        expect(eye.z).toBeGreaterThan(room.bounds.min[1]); expect(eye.z).toBeLessThan(room.bounds.max[1]);
        expect(eye.y).toBeGreaterThan(room.floor); expect(eye.y).toBeLessThan(room.ceiling);
        const direction = new THREE.Vector3(); rig.camera.getWorldDirection(direction);
        expect(THREE.MathUtils.radToDeg(Math.asin(-direction.y))).toBeCloseTo(INTERIOR_PITCH_DEG);
        expect(INTERIOR_PITCH_DEG).toBeGreaterThanOrEqual(40); expect(INTERIOR_PITCH_DEG).toBeLessThanOrEqual(45);
        // Corners and points along every frame edge (not only the corners).
        const edge = [-1, -0.5, 0, 0.5, 1];
        const samples = edge.flatMap((t) => [[t, -1], [t, 1], [-1, t], [1, t]]);
        for (const [x, y] of samples) {
          ray.setFromCamera(new THREE.Vector2(x, y), rig.camera);
          const hit = ray.intersectObject(enclosure, true)[0];
          expect(hit, `${id}: missing enclosure at ${x},${y}`).toBeDefined();
          expect(hit.distance).toBeGreaterThan(rig.camera.near);
          expect(hit.object.userData.roomSurface).toBeTruthy();
          expect(hit.object.userData.roomSurface).not.toMatch(/front|right/);
          if (y === -1) {
            expect(hit.object.name).toBe("interior_floor_inside");
            expect(hit.point.x).toBeGreaterThan(room.bounds.min[0]); expect(hit.point.x).toBeLessThan(room.bounds.max[0]);
            expect(hit.point.z).toBeGreaterThan(room.bounds.min[1]); expect(hit.point.z).toBeLessThan(room.bounds.max[1]);
          }
        }
      };
      // Include exit bounds (outside the shell), both extreme NPC/player positions and dialogue zoom.
      for (const x of [layout.bounds.min[0], 0, layout.bounds.max[0]]) for (const z of [layout.bounds.min[1], -1, layout.bounds.max[1]]) {
        const focus = new THREE.Vector3(x, room.floor, z);
        rig.snap(focus); assertFrame();
        for (let f = 0; f < 30; f++) { rig.update(1 / 60, focus.clone().negate(), f % 2 === 0); assertFrame(); }
        rig.resize(h, w, h < w); assertFrame(); rig.resize(w, h, w < h); assertFrame();
      }
      // Ceiling is a real inward surface, not sky if an upward ray is ever introduced.
      ray.set(new THREE.Vector3(0, room.floor + 0.5, -1), new THREE.Vector3(0, 1, 0));
      expect(ray.intersectObject(enclosure, true)[0].object.name).toBe("interior_ceiling");
    });
  }
  // Framing (owner: "far too close"): the camera stands as far back as the room allows and the
  // player, on arrival and across the room, stays whole in the frame at a readable size.
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 844]]) {
    it(`${id} ${w}x${h}: arrival framed whole from the far side of the room`, () => {
      const layout = L.space(id), room = layout.view!;
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < h); rig.setSpace(layout);
      const inFrame = (focus: THREE.Vector3) => [0, 1.7].every((up) => {
        const p = focus.clone().setY(focus.y + up).project(rig.camera);
        return Math.abs(p.x) <= 0.9 && Math.abs(p.y) <= 0.95;
      });
      const entry = new THREE.Vector3(room.entry![0], room.floor, room.entry![1]);
      rig.snap(entry);
      expect(inFrame(entry), `${id}: arrival out of frame`).toBe(true);
      // as far as it can: within reach of a near wall plane in at least one axis, eye near the ceiling
      const eye = rig.camera.position;
      expect(Math.min(room.bounds.max[0] - eye.x, room.bounds.max[1] - eye.z)).toBeLessThan(1.1);
      expect(eye.y).toBeGreaterThan(room.ceiling - 1.2);
      expect(Math.hypot(eye.x - entry.x, eye.z - entry.z)).toBeGreaterThan(1.3);
      expect(rig.camera.fov).toBeGreaterThanOrEqual(30);
      // gentle follow: walking across the room, the eye moves at most ~2.5 m/s and the player stays in frame
      // for most of the room (the strip under the camera by the near walls is the exception)
      const { min, max } = room.bounds;
      let framed = 0, total = 0;
      for (let x = min[0] + 0.6; x <= max[0] - 1.5; x += 0.5) for (let z = min[1] + 0.6; z <= max[1] - 1.5; z += 0.5) {
        const f = new THREE.Vector3(x, room.floor, z);
        const before = rig.camera.position.clone();
        rig.update(1 / 60, f, false);
        expect(rig.camera.position.distanceTo(before)).toBeLessThan(0.2);
        rig.snap(f); total++; if (inFrame(f)) framed++;
      }
      // Measured limit, not a target: a 3 m deep room seen diagonally on a landscape screen leaves the
      // eye ~1.5 m from the player (the frame's lateral spread meets the near walls), so the
      // player fills ~80 % of the frame height and head or feet leave it in part of the room.
      const small = Math.min(max[0] - min[0], max[1] - min[1]) < 4 && w > h;
      expect(framed / total).toBeGreaterThanOrEqual(small ? 0.5 : 0.85);
    });
  }
  it("interior outlines are drawn thinner (the camera is ~6x closer than on the street)", () => {
    expect(outlineScale(1, false, true)).toBeCloseTo(INTERIOR_OUTLINE);
    expect(outlineScale(2, true, true)).toBeCloseTo(outlineScale(2, true) * INTERIOR_OUTLINE);
    expect(INTERIOR_OUTLINE).toBeLessThan(1);
  });
  it("enclosure walls have only inward faces; existing wall material conversion doesn't mutate shared templates", () => {
    const scene = new THREE.Scene(), layout = L.space("room");
    const enclosure = buildInteriorEnclosure(scene, layout, flat)!;
    enclosure.updateMatrixWorld(true);
    const back = enclosure.getObjectByName("interior_wall_back")!;
    ray.set(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1));
    expect(ray.intersectObject(back)).toHaveLength(0);
    ray.set(new THREE.Vector3(0, 1, -2), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(back).length).toBeGreaterThan(0);
    const source = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const instance = new THREE.Mesh(new THREE.PlaneGeometry(), source);
    interiorFaces(instance);
    expect(instance.material.side).toBe(THREE.FrontSide); expect(source.side).toBe(THREE.DoubleSide);
  });
  it("leaving restores the street near plane and FOV; street builds no enclosure", () => {
    const rig = new CameraRig({} as HTMLElement); rig.resize(1920, 1080);
    rig.setSpace(L.space("room")); rig.snap(new THREE.Vector3(0, 0.06, -1));
    rig.setSpace(L.space(STREET)); rig.snap(new THREE.Vector3());
    expect(rig.camera.fov).toBe(CAMERA.fovDeg); expect(rig.camera.near).toBe(CAMERA.near);
    expect(buildInteriorEnclosure(new THREE.Scene(), L.space(STREET), flat)).toBeUndefined();
  });
});
