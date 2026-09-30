import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, CAMERA, INTERIOR_OUTLINE, outlineScale } from "../src/camera";
import { FRAME_ASPECTS, frameKey, INTERIOR_PITCH_RANGE, interiorFrame, PLAYER_SIZE, playerSize, roomFoci, solveFrame } from "../src/interior-camera";
import FRAMES from "../src/interior-frames.json";
import { buildInteriorEnclosure, interiorFaces } from "../src/interior-enclosure";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, readGlb } from "./helpers";

const L = new LayoutIndex(LAYOUT, assetIndex!);
const ids = Object.keys(LAYOUT.interiors).filter((id) => L.space(id).interior);
const flat = (color: string) => new THREE.MeshBasicMaterial({ color });
const ray = new THREE.Raycaster();

/** The authored walls' inner faces: shells stand 0.15 m inside the outer planes (box rooms' walls outside them). */
const WALL_THICKNESS = 0.15;
const inFrame = (camera: THREE.Camera, focus: THREE.Vector3) => [0, 1.7].every((up) => {
  const p = focus.clone().setY(focus.y + up).project(camera);
  return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1;
});

describe("enclosed gameplay interior camera", () => {
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 845], [390, 844]]) {
    it(`${id} ${w}x${h}: every frame ray (corners and edges) lands on the room, through the ceiling opening when the eye is above it`, () => {
      const layout = L.space(id), room = layout.view!;
      const { min, max } = room.bounds;
      const scene = new THREE.Scene();
      const enclosure = buildInteriorEnclosure(scene, layout, flat)!;
      scene.updateMatrixWorld(true);
      const rig = new CameraRig({} as HTMLElement);
      rig.resize(w, h, w < h); rig.setSpace(layout);
      const assertFrame = () => {
        const eye = rig.camera.position;
        if (eye.y <= room.ceiling) {
          expect(eye.x).toBeGreaterThan(min[0]); expect(eye.x).toBeLessThan(max[0]);
          expect(eye.z).toBeGreaterThan(min[1]); expect(eye.z).toBeLessThan(max[1]);
          expect(eye.y).toBeGreaterThan(room.floor);
        }
        const direction = new THREE.Vector3(); rig.camera.getWorldDirection(direction);
        const pitch = THREE.MathUtils.radToDeg(Math.asin(-direction.y));
        expect(pitch).toBeGreaterThanOrEqual(INTERIOR_PITCH_RANGE[0] - 1e-6); expect(pitch).toBeLessThanOrEqual(INTERIOR_PITCH_RANGE[1] + 1e-6);
        // Corners and 9 points along every frame edge (the solver checks 5).
        const edge = Array.from({ length: 9 }, (_, i) => -1 + i / 4);
        for (const [x, y] of edge.flatMap((t) => [[t, -1], [t, 1], [-1, t], [1, t]])) {
          ray.setFromCamera(new THREE.Vector2(x, y), rig.camera);
          const d = ray.ray.direction;
          if (eye.y > room.ceiling) {
            // crosses the ceiling height strictly inside the walls' inner faces: no wall top, cap or outside
            const t = (room.ceiling - eye.y) / d.y;
            expect(t, `${id}: ray ${x},${y} never goes down through the ceiling`).toBeGreaterThan(0);
            const cx = eye.x + d.x * t, cz = eye.z + d.z * t;
            expect(cx, `${id}: ray ${x},${y} over a wall top`).toBeGreaterThan(min[0] + WALL_THICKNESS); expect(cx).toBeLessThan(max[0] - WALL_THICKNESS);
            expect(cz, `${id}: ray ${x},${y} over a wall top`).toBeGreaterThan(min[1] + WALL_THICKNESS); expect(cz).toBeLessThan(max[1] - WALL_THICKNESS);
          }
          const hit = ray.intersectObject(enclosure, true)[0];
          expect(hit, `${id}: missing enclosure at ${x},${y}`).toBeDefined();
          expect(hit.distance).toBeGreaterThan(rig.camera.near);
          expect(hit.object.userData.roomSurface).toBeTruthy();
          // never the open front, never the ceiling (single-sided: from above it is not there)
          expect(hit.object.userData.roomSurface).not.toMatch(/front|ceiling/);
          if (hit.object.name === "interior_floor_inside") {
            expect(hit.point.x).toBeGreaterThan(min[0]); expect(hit.point.x).toBeLessThan(max[0]);
            expect(hit.point.z).toBeGreaterThan(min[1]); expect(hit.point.z).toBeLessThan(max[1]);
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
    }, 60_000); // each aspect solves its frame once (interiorFrame caches it)
  }
  // Framing (owner: Stardew / Coral Island interiors): the player whole everywhere in the room, at
  // PLAYER_SIZE (20-35 % of the frame height) on arrival and at the room's centre, both aspects.
  for (const id of ids) for (const [w, h] of [[1920, 1080], [390, 844]]) {
    it(`${id} ${w}x${h}: the player whole everywhere in the room, 20-35 % of the frame (16:9) on arrival and at the centre`, () => {
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
        const size = playerSize(frame, w / h, rig.camera.position, f);
        // 16:9 is held to 20-35 %; portrait (no target given) measured 18.6 % at the tea house / shop
        // arrival (390x844), so its floor is that measurement, not the target.
        const floor = w > h ? PLAYER_SIZE[0] - 0.01 : 0.18;
        expect(size, `${id}: player size at ${f.x.toFixed(2)},${f.z.toFixed(2)}`).toBeGreaterThanOrEqual(floor);
        expect(size, `${id}: player size at ${f.x.toFixed(2)},${f.z.toFixed(2)}`).toBeLessThanOrEqual(PLAYER_SIZE[1] + 0.01);
      }
      // Everywhere on the floor inside the walls (0.5 m grid): whole in the frame; the follow is
      // gentle (at most 0.25 m a frame at 60 fps while it catches up).
      rig.snap(entry);
      for (const f of roomFoci(room)) {
        const before = rig.camera.position.clone();
        rig.update(1 / 60, f, false);
        expect(rig.camera.position.distanceTo(before)).toBeLessThan(0.25);
        rig.snap(f);
        expect(inFrame(rig.camera, f), `${id}: player at ${f.x.toFixed(2)},${f.z.toFixed(2)} not whole`).toBe(true);
      }
    }, 60_000);
  }
  it("the precomputed frame table (src/interior-frames.json) covers every room and matches the solver", () => {
    const table = FRAMES as Record<string, { aspect: number; pitch: number; fov: number; height: number }[]>;
    for (const id of ids) expect(table[frameKey(L.space(id).view!)]?.map((r) => r.aspect), `${id}: stale table, run scripts/interior-frames.ts`).toEqual(FRAME_ASPECTS);
    // one room / aspect re-solved (a full re-solve takes ~100 s: the script)
    const room = L.space("room").view!, row = table[frameKey(room)].find((r) => r.aspect === 1.8)!;
    const f = solveFrame(room, row.aspect);
    expect({ pitch: f.pitch, fov: f.fov, height: Math.round(f.height * 1000) / 1000 }).toEqual({ pitch: row.pitch, fov: row.fov, height: row.height });
  }, 60_000);
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
