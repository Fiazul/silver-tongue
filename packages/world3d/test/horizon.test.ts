// The town's far edge and its sky objects (src/horizon.ts): no view the game has (the gameplay
// camera at every rim cell and at the spawn, the fly-over at 24 fps, on desktop, phone portrait and
// phone landscape) sees past the ground or has a cloud close up or at the frame's centre; the
// landscape pieces meet without an open step; and the checks themselves catch the old edge.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { describe, expect, it } from "vitest";
import { CAMERA } from "../src/camera";
import { cloudExposure, edgeExposure, flyoverViews, HORIZON, moveClouds, playFov, rigView, rimCells, SCREENS, skirtGeometry, type Backdrop, type View } from "../src/horizon";
import { LAYOUT, type Vec3 } from "../src/layout";
import { ASSETS, assetIndex, readGlb } from "./helpers";

const town = LAYOUT.town;
const rig = { elevationDeg: CAMERA.elevationDeg, azimuthDeg: CAMERA.azimuthDeg, distance: CAMERA.distance, aimHeight: CAMERA.aimHeight };

/** Every view: the spawn, each rim cell (36 bearings), the fly-over at 24 fps and at each key, on each screen. */
function allViews(): View[] {
  const out: View[] = [];
  const rim = rimCells(town.grid, 36);
  const end = town.camera.keys.at(-1)!;
  for (const s of SCREENS) {
    const fov = playFov(CAMERA.fovDeg, s.aspect);
    out.push({ name: `spawn ${s.name}`, pos: end.pos, lookAt: end.lookAt, fovDeg: fov, aspect: s.aspect });
    for (const c of rim) out.push(rigView(`rim ${c.bearing} ${s.name}`, [c.x, c.y, c.z], rig, fov, s.aspect));
    out.push(...flyoverViews(town.camera.keys, s.aspect, fov / CAMERA.fovDeg, 24, `${s.name} `));
    for (const k of town.camera.keys) out.push({ name: `key t=${k.t} ${s.name}`, pos: k.pos, lookAt: k.lookAt, fovDeg: k.fovDeg * (fov / CAMERA.fovDeg), aspect: s.aspect });
  }
  return out;
}

const after: Backdrop = { groundRadius: HORIZON.skirt.outer, groundY: HORIZON.skirt.y, fogNear: town.fog.near, fogFar: town.fog.far, far: CAMERA.far };
/** what shipped before: the apron's 48-gon (r 760) as the last ground, the haze full at 950 m */
const before: Backdrop = { groundRadius: 760 * Math.cos(Math.PI / 48), groundY: -0.5, fogNear: 110, fogFar: 950, far: CAMERA.far };

describe("the town's far edge", () => {
  const views = allViews();

  it("samples the rim at 36 bearings, the fly-over at 24 fps, three screens", () => {
    expect(rimCells(town.grid, 36).length).toBe(36);
    expect(views.length).toBe(3 * (1 + 36 + Math.round(town.camera.duration * 24) + 1 + town.camera.keys.length));
  });

  it("the check sees the old edge: the fly-over looked past the apron (r 760) under a 950 m haze", () => {
    const open = views.filter((v) => edgeExposure(v, before).open > 0);
    expect(open.length).toBeGreaterThan(100);
    expect(open.some((v) => v.name.startsWith("key t=0 "))).toBe(true); // the first key: the disc the player saw
  });

  it("no view sees past the ground now (the skirt runs out past every view's haze)", () => {
    const open = views.filter((v) => edgeExposure(v, after).open > 0).map((v) => v.name);
    expect(open).toEqual([]);
    // the skirt reaches past the haze from the furthest camera, and the haze is full before the dome
    const furthest = Math.max(...views.map((v) => Math.hypot(v.pos[0], v.pos[2])));
    expect(HORIZON.skirt.outer).toBeGreaterThan(town.fog.far + furthest);
    expect(town.fog.far).toBeLessThan(800);
    expect(town.fog.far).toBeLessThan(CAMERA.far);
  });

  it("the skirt faces up, starts under the apron's rim and sits below it", () => {
    const g = skirtGeometry();
    const n = g.getAttribute("normal");
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBeCloseTo(1, 5);
    const p = g.getAttribute("position");
    let rMin = Infinity;
    let rMax = 0;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getZ(i));
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
    expect(rMin).toBeCloseTo(HORIZON.skirt.inner, 3);
    expect(rMax).toBeCloseTo(HORIZON.skirt.outer, 3);
    expect(HORIZON.skirt.inner).toBeLessThan(760 * Math.cos(Math.PI / 48)); // the apron's 48-gon, inscribed
  });
});

describe("clouds", () => {
  const views = allViews();
  const slots = (assetIndex?.assets.find((a) => a.name === "clouds")?.anchors?.cloud_slots ?? []) as Vec3[];

  it("moveClouds carries each cluster with its nearest slot", () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, 100, 0, 5, 101, 0, 300, 80, 0], 3));
    moveClouds(g, [[0, 100, 0], [300, 80, 0]], [[0, 200, -400], [300, 180, 50]]);
    expect([...g.getAttribute("position").array]).toEqual([0, 200, -400, 5, 201, -400, 300, 180, 50]);
  });

  it("every new slot is high over the plateau and out past it, one per source slot", () => {
    expect(HORIZON.clouds.length).toBe(slots.length || HORIZON.clouds.length);
    for (const c of HORIZON.clouds) {
      expect(c[1]).toBeGreaterThanOrEqual(120 + 20); // the cloud's centre: its underside stays over 120 m
      expect(Math.hypot(c[0], c[2])).toBeGreaterThan(100); // the plateau reaches 99 m at its corners
      expect(Math.hypot(c[0], c[2])).toBeLessThan(700); // inside the sky dome
    }
  });

  describe.skipIf(!assetIndex)("against the real clouds.glb", () => {
    const boxes = async (move: boolean) => {
      const e = assetIndex!.assets.find((a) => a.name === "clouds")!;
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readGlb(`${ASSETS}/${e.path}`), "");
      const out = slots.map(() => new THREE.Box3());
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const src = m.geometry.getAttribute("position");
        const g = m.geometry.clone();
        if (move) moveClouds(g, slots, HORIZON.clouds);
        const p = g.getAttribute("position");
        for (let i = 0; i < p.count; i++) {
          const v = new THREE.Vector3().fromBufferAttribute(src, i);
          let k = 0;
          slots.forEach((s, j) => {
            if (v.distanceToSquared(new THREE.Vector3(...s)) < v.distanceToSquared(new THREE.Vector3(...slots[k]))) k = j;
          });
          out[k].expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i));
        }
      });
      return out;
    };

    it("the check sees the old cloud the fly-over flew through", async () => {
      const b = await boxes(false);
      const hit = views.filter((v) => {
        const r = cloudExposure(v, b);
        return r.close || r.centre;
      });
      expect(hit.length).toBeGreaterThan(0);
    });

    it("no view has a cloud within 150 m or at the frame's centre; none comes within 150 m of the fly-over's path", async () => {
      const a = await boxes(true);
      for (const box of a) {
        expect(box.min.y).toBeGreaterThanOrEqual(120);
        expect(Math.hypot(box.min.x, box.min.z) > 99 || Math.hypot(box.max.x, box.max.z) > 99).toBe(true);
      }
      const hits = views.filter((v) => {
        const r = cloudExposure(v, a);
        return r.close || r.centre || r.nearest < HORIZON.cloudClearance;
      });
      expect(hits.map((v) => v.name)).toEqual([]);
    });
  });
});

describe.skipIf(!assetIndex)("seams between the landscape pieces (the real GLBs)", () => {
  const verts = async (name: string) => {
    const e = assetIndex!.assets.find((a) => a.name === name)!;
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readGlb(`${ASSETS}/${e.path}`), "");
    gltf.scene.updateMatrixWorld(true);
    const out: THREE.Vector3[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const p = m.geometry.getAttribute("position");
      for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
    });
    return out;
  };

  it("the plateau's rim meets the apron at the same height, or a cap closes the step", async () => {
    const terrain = await verts("terrain_town");
    const apron = await verts("ground_apron");
    const key = (v: THREE.Vector3) => `${Math.round(v.x * 10)},${Math.round(v.z * 10)}`;
    const at = new Map<string, number[]>();
    for (const v of apron) (at.get(key(v)) ?? at.set(key(v), []).get(key(v))!).push(v.y);
    const rim = terrain.filter((v) => Math.abs(Math.abs(v.x) - 70) < 0.01 || Math.abs(Math.abs(v.z) - 70) < 0.01);
    expect(rim.length).toBeGreaterThan(400);
    const capped = (v: THREE.Vector3, top: number) =>
      HORIZON.caps.some((c) => {
        const onLine = Math.abs((c.to[0] - c.from[0]) * (v.z - c.from[2]) - (c.to[2] - c.from[2]) * (v.x - c.from[0])) < 1e-3;
        const within = v.x >= Math.min(c.from[0], c.to[0]) - 0.01 && v.x <= Math.max(c.from[0], c.to[0]) + 0.01 && v.z >= Math.min(c.from[2], c.to[2]) - 0.01 && v.z <= Math.max(c.from[2], c.to[2]) + 0.01;
        return onLine && within && c.from[1] <= Math.min(v.y, top) && c.to[1] >= Math.max(v.y, top);
      });
    const open: string[] = [];
    let shared = 0;
    for (const v of rim) {
      const ys = at.get(key(v));
      if (!ys) continue;
      shared++;
      const step = Math.min(...ys.map((y) => Math.abs(y - v.y)));
      if (step > 0.05 && !capped(v, ys[0])) open.push(`${v.x},${v.z}: ${v.y.toFixed(2)} vs ${ys.map((y) => y.toFixed(2))}`);
    }
    expect(shared).toBe(rim.length); // the apron's inner edge follows the plateau's vertex for vertex
    expect(open).toEqual([]);
  });

  it("the hills and both mountain rings stand sunk into the apron (no gap under a base)", async () => {
    const apron = await verts("ground_apron");
    const apronY = (x: number, z: number) => {
      let best = Infinity;
      let y = 0;
      for (const v of apron) {
        const d = (v.x - x) ** 2 + (v.z - z) ** 2;
        if (d < best) {
          best = d;
          y = v.y;
        }
      }
      return y;
    };
    for (const name of ["hills_ring", "mountains_far"]) {
      const vs = await verts(name);
      const base = Math.min(...vs.map((v) => v.y));
      // the echo ring: the same mesh turned and scaled about the origin
      const k = name === "mountains_far" ? [1, HORIZON.mountainEcho.scale] : [1];
      for (const s of k) {
        const low = vs.filter((v) => v.y < base + 0.01).map((v) => (s === 1 ? v : v.clone().multiplyScalar(s).applyAxisAngle(new THREE.Vector3(0, 1, 0), (HORIZON.mountainEcho.rotYDeg * Math.PI) / 180)));
        expect(low.filter((v) => v.y > apronY(v.x, v.z) + 0.05).length, `${name} x${s}`).toBe(0);
      }
    }
  });

  it("the two mountain rings together cover every bearing", async () => {
    const vs = await verts("mountains_far");
    const bins = new Set<number>();
    const turn = (HORIZON.mountainEcho.rotYDeg * Math.PI) / 180;
    for (const v of vs) {
      if (v.y < 20) continue; // the peaks, not the foothills' skirts
      for (const w of [v, v.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn)]) bins.add(Math.floor((((Math.atan2(w.x, -w.z) * 180) / Math.PI + 360) % 360) / 10));
    }
    expect(bins.size).toBe(36);
  });
});
