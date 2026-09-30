import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, CAMERA, INTERIOR_OUTLINE, outlineScale } from "../src/camera";
import { INTERIOR_PITCH_RANGE, interiorFrame, PLAYER_SIZE, playerSize } from "../src/interior-camera";
import { buildInteriorEnclosure, interiorFaces } from "../src/interior-enclosure";
import { LAYOUT, LayoutIndex, STREET, type InteriorView } from "../src/layout";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, readGlb } from "./helpers";

const L = new LayoutIndex(LAYOUT, assetIndex!);
const ids = Object.keys(LAYOUT.interiors).filter((id) => L.space(id).interior);
const flat = (color: string) => new THREE.MeshBasicMaterial({ color });
const ray = new THREE.Raycaster();

const inFrame = (camera: THREE.Camera, focus: THREE.Vector3) => [0, 1.7].every((up) => {
  const p = focus.clone().setY(focus.y + up).project(camera);
  return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1;
});
/** The floor inside the walls on a 0.5 m grid. */
function floorGrid(room: InteriorView) {
  const t = room.wall ?? 0, { min, max } = room.bounds, out: THREE.Vector3[] = [];
  for (let x = min[0] + t + 0.3; x <= max[0] - t - 0.3 + 1e-6; x += 0.5) for (let z = min[1] + t + 0.3; z <= max[1] - 0.3 + 1e-6; z += 0.5) out.push(new THREE.Vector3(x, room.floor, z));
  return out;
}
/** Frame points: every edge at 9 points and a 9 x 7 grid inside. */
const FRAME_POINTS = [
  ...Array.from({ length: 9 }, (_, i) => -1 + i / 4).flatMap((t) => [[t, -1], [t, 1], [-1, t], [1, t]]),
  ...Array.from({ length: 63 }, (_, i) => [-0.9 + (i % 9) * 0.225, -0.9 + Math.floor(i / 9) * 0.3]),
];

describe("interior camera: one fixed eye per room, like the street's", () => {
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 845], [390, 844]]) {
    it(`${id} ${w}x${h}: every frame ray lands on the floor or a wall face of the enclosure, never the open front, the ceiling or outside`, () => {
      const layout = L.space(id), room = layout.view!;
      const { min, max } = room.bounds;
      const scene = new THREE.Scene();
      const enclosure = buildInteriorEnclosure(scene, layout, flat)!;
      scene.updateMatrixWorld(true);
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < h); rig.setSpace(layout);
      const assertFrame = () => {
        const direction = new THREE.Vector3(); rig.camera.getWorldDirection(direction);
        const pitch = THREE.MathUtils.radToDeg(Math.asin(-direction.y));
        expect(pitch).toBeGreaterThanOrEqual(INTERIOR_PITCH_RANGE[0] - 1e-6); expect(pitch).toBeLessThanOrEqual(INTERIOR_PITCH_RANGE[1] + 1e-6);
        expect(Math.abs(direction.x)).toBeLessThan(1e-9); // straight at the back wall
        for (const [x, y] of FRAME_POINTS) {
          ray.setFromCamera(new THREE.Vector2(x, y), rig.camera);
          const hit = ray.intersectObject(enclosure, true)[0];
          expect(hit, `${id}: ${x},${y} sees outside`).toBeDefined();
          expect(hit.distance).toBeGreaterThan(rig.camera.near);
          expect(hit.object.userData.roomSurface, `${id}: ${x},${y}`).toMatch(/^(floor_inside|wall_back|wall_left|wall_right)/);
          if (hit.object.name === "interior_floor_inside") {
            // the floor plane runs 1 cm under the walls (behind the authored walls: hidden there)
            expect(hit.point.x).toBeGreaterThan(min[0] - 0.011); expect(hit.point.x).toBeLessThan(max[0] + 0.011);
            expect(hit.point.z).toBeGreaterThan(min[1] - 0.011); expect(hit.point.z).toBeLessThan(max[1]);
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
  // Framing (owner: Coral Island / The Sims): the player whole on arrival and over at least 90 % of
  // the floor, ~30-40 % of the frame height; the camera fixed, panning only past a dead zone.
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 844]]) {
    it(`${id} ${w}x${h}: player whole on arrival and over the floor, ~30-40 % of the frame; the eye never drifts`, () => {
      const layout = L.space(id), room = layout.view!;
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < h); rig.setSpace(layout);
      const frame = interiorFrame(room, w / h);
      const { min, max } = room.bounds;
      const entry = new THREE.Vector3(room.entry![0], room.floor, room.entry![1]);
      const centre = new THREE.Vector3((min[0] + max[0]) / 2, room.floor, (min[1] + max[1]) / 2);
      for (const f of [entry, centre]) {
        rig.snap(f);
        expect(inFrame(rig.camera, f), `${id}: ${f.x},${f.z} out of frame`).toBe(true);
        // PLAYER_SIZE is the solver's aim; the measured sizes are in the README
        const size = playerSize(frame, w / h, rig.camera.position, f);
        expect(size, `${id}: player size at ${f.x.toFixed(2)},${f.z.toFixed(2)}`).toBeGreaterThanOrEqual(PLAYER_SIZE[0] - 0.03);
        expect(size, `${id}: player size at ${f.x.toFixed(2)},${f.z.toFixed(2)}`).toBeLessThanOrEqual(PLAYER_SIZE[1] + 0.02);
      }
      // 16:9: the whole room from one eye (the back wall whole, all the floor); portrait pans.
      if (w > h) { expect(frame.floorShare).toBe(1); expect(frame.backShare).toBe(1); expect(frame.xMax).toBe(frame.xMin); }
      else expect(frame.floorShare).toBeGreaterThanOrEqual(0.5);
      // Walk the floor: whole in frame over at least 90 % of it; the eye's height and depth never
      // change, it moves sideways only (at most 0.2 m a frame), and not at all once settled.
      rig.snap(entry);
      const grid = floorGrid(room);
      let whole = 0;
      for (const f of grid) {
        for (let k = 0; k < 240; k++) {
          const before = rig.camera.position.clone();
          rig.update(1 / 60, f, false);
          const after = rig.camera.position;
          expect(after.y).toBe(frame.y); expect(after.z).toBe(frame.z);
          expect(Math.abs(after.x - before.x)).toBeLessThan(0.2);
        }
        if (inFrame(rig.camera, f)) whole++;
      }
      expect(whole / grid.length, `${id}: player whole over ${whole}/${grid.length}`).toBeGreaterThanOrEqual(0.9);
      const still = rig.camera.position.clone();
      for (let k = 0; k < 120; k++) rig.update(1 / 60, grid[grid.length - 1], false);
      expect(rig.camera.position.distanceTo(still)).toBeLessThan(1e-6); // settled: no drift
    });
  }
  it.skipIf(!assetIndex)("the built rooms: across the whole frame no wall top, wall end or outside shows, from every eye", async () => {
    const assets = new AssetCache(ASSETS, L, { read: readGlb });
    for (const id of ids) {
      const layout = L.space(id), room = layout.view!;
      const space = await SceneSpace.create(L, assets, id);
      space.scene.updateMatrixWorld(true);
      const enclosure = space.scene.getObjectByName("interior_enclosure")!;
      for (const [w, h] of [[1920, 1080], [390, 844]]) {
        const rig = new CameraRig({} as HTMLElement);
        rig.resize(w, h, w < h); rig.setSpace(layout);
        const frame = interiorFrame(room, w / h);
        for (const x of [frame.xMin, (frame.xMin + frame.xMax) / 2, frame.xMax]) {
          rig.camera.position.set(x, frame.y, frame.z); rig.camera.updateMatrixWorld(true);
          for (const [sx, sy] of FRAME_POINTS) {
            ray.setFromCamera(new THREE.Vector2(sx, sy), rig.camera);
            const hit = ray.intersectObject(space.scene, true).find((i) => i.object.visible && !i.object.userData.outline);
            expect(hit, `${id} ${w}x${h}: ${sx},${sy} sees outside`).toBeDefined();
            let inEnclosure = false;
            hit!.object.traverseAncestors((a) => { if (a === enclosure) inEnclosure = true; });
            if (inEnclosure) continue;
            const n = hit!.face!.normal.clone().transformDirection(hit!.object.matrixWorld);
            expect(hit!.point.y > room.ceiling - 0.02 && n.y > 0.5, `${id} ${w}x${h}: ${sx},${sy} sees a wall top (${hit!.object.name})`).toBe(false);
            expect(hit!.point.z > room.bounds.max[1] - 0.02 && n.z > 0.5, `${id} ${w}x${h}: ${sx},${sy} sees a wall end (${hit!.object.name})`).toBe(false);
          }
        }
      }
    }
  }, 120_000);
  it.skipIf(!assetIndex)("nothing in any built room stands above its ceiling (the eye may look down through it)", async () => {
    const assets = new AssetCache(ASSETS, L, { read: readGlb });
    for (const id of ids) {
      const space = await SceneSpace.create(L, assets, id), ceiling = L.space(id).view!.ceiling;
      space.scene.updateMatrixWorld(true);
      space.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible || o.parent?.name === "interior_enclosure") return;
        const top = new THREE.Box3().setFromObject(m).max.y;
        expect(top, `${id}: ${m.name} reaches ${top.toFixed(3)} m, ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling + 0.005);
      });
    }
  }, 60_000);
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
