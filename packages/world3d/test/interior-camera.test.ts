import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, CAMERA } from "../src/camera";
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
        expect(THREE.MathUtils.radToDeg(Math.asin(-direction.y))).toBeCloseTo(38);
        for (const x of [-1, 1]) for (const y of [-1, 1]) {
          ray.setFromCamera(new THREE.Vector2(x, y), rig.camera);
          const hit = ray.intersectObject(enclosure, true)[0];
          expect(hit, `${id}: missing enclosure at corner ${x},${y}`).toBeDefined();
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
