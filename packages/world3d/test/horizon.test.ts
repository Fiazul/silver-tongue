// The town's far edge and its sky objects (src/horizon.ts): no view the game has (the gameplay
// camera at every rim cell and at the spawn, the fly-over at 24 fps, on desktop, phone portrait and
// phone landscape) sees past the ground or has a cloud close up or at the frame's centre; the
// landscape pieces meet without an open step; the land round the town reads as one country (no
// colour step at the ring, hills all round it); and the checks themselves catch the old edge and
// the old disc.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { describe, expect, it } from "vitest";
import { CAMERA } from "../src/camera";
import {
  blocksView,
  buildCountryside,
  cloudExposure,
  discStep,
  domeHeight,
  edgeExposure,
  flyoverViews,
  groundColour,
  hazeColour,
  HORIZON,
  moveClouds,
  playFov,
  rampAt,
  rigView,
  rimCells,
  ringOpen,
  SCREENS,
  skirtGeometry,
  subdivideForRamp,
  Surface,
  type Backdrop,
  type Countryside,
  type Haze,
  type Part,
  type View,
} from "../src/horizon";
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

describe("countryside: the ramp and the checks (pure)", () => {
  const pal = { near: new THREE.Color("#78A152"), far: new THREE.Color("#93AF86") };

  it("the ramp: the plateau's grass to r inner, the far grass from r full, smooth between", () => {
    const c = HORIZON.countryside;
    expect(groundColour(0, pal).equals(pal.near)).toBe(true);
    expect(groundColour(c.inner, pal).equals(pal.near)).toBe(true);
    expect(groundColour(c.full, pal).equals(pal.far)).toBe(true);
    expect(groundColour(3000, pal).equals(pal.far)).toBe(true);
    let last = 0;
    for (let r = c.inner; r <= c.full; r += 5) {
      const t = rampAt(r);
      expect(t).toBeGreaterThanOrEqual(last);
      expect(t - last).toBeLessThan(0.04); // no step: at most 4 % of the way per 5 m
      last = t;
    }
  });

  it("subdivideForRamp cuts a long face along circles, shares every cut, keeps it flat", () => {
    // one fan face of the apron (165 m -> 760 m) and its neighbour across the radial edge
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([165, 0, 0, 760, -0.5, 0, 753.5, -0.5, -99.2, 163.7, 0, -21.5], 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const out = subdivideForRamp(g, new THREE.Matrix4());
    const p = out.getAttribute("position");
    const idx = out.index!;
    expect(idx.count / 3).toBeGreaterThan(20);
    expect(idx.count / 3).toBeLessThan(120);
    // along any edge the ramp moves at most one level (13 m of radius, or the whole flat part)
    const r = (i: number) => Math.hypot(p.getX(i), p.getZ(i));
    for (let t = 0; t < idx.count; t += 3) {
      const rs = [0, 1, 2].map((k) => r(idx.getX(t + k)));
      const inRamp = rs.filter((x) => x > HORIZON.countryside.inner + 0.5 && x < HORIZON.countryside.full - 0.5);
      if (inRamp.length === 3) expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(14);
    }
    // conforming: every edge used by one face only is on the source's outline (no T-junction inside)
    const count = new Map<string, number>();
    const key = (i: number) => `${p.getX(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    for (let t = 0; t < idx.count; t += 3)
      for (let k = 0; k < 3; k++) {
        const e = [key(idx.getX(t + k)), key(idx.getX(t + ((k + 1) % 3)))].sort().join("|");
        count.set(e, (count.get(e) ?? 0) + 1);
      }
    const onOutline = (e: string) => {
      const [a, b] = e.split("|").map((q) => q.split(",").map(Number));
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // the diagonal 0-2 is inside; everything else lies on the quad's four sides
      const side = (x0: number, z0: number, x1: number, z1: number) => Math.abs((x1 - x0) * (mid[1] - z0) - (z1 - z0) * (mid[0] - x0)) / Math.hypot(x1 - x0, z1 - z0) < 0.01;
      return side(165, 0, 760, 0) || side(760, 0, 753.5, -99.2) || side(753.5, -99.2, 163.7, -21.5) || side(163.7, -21.5, 165, 0);
    };
    for (const [e, n] of count) if (n === 1) expect(onOutline(e), e).toBe(true);
    // flat: every new vertex on the source plane (y from x/z as the two faces have it)
    const area = (t: number) => {
      const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, idx.getX(t + k)));
      return new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0])).y;
    };
    for (let t = 0; t < idx.count; t += 3) expect(area(t)).toBeGreaterThan(0); // all wound as the source (their normal +y)
    for (let i = 0; i < p.count; i++) {
      // on the source's plane(s): y from the radius as the fan has it (0 at 165 m, -0.5 at 760 m)
      const r = Math.hypot(p.getX(i), p.getZ(i));
      expect(Math.abs(p.getY(i) + (0.5 * (r - 165)) / 595)).toBeLessThan(0.02);
    }
  });

  it("ringOpen: no hills leaves the whole ring open; a hill covers the arc within 60 m of it", () => {
    expect(ringOpen([])).toBe(1);
    const one = ringOpen([{ x: 0, z: -200, radius: 30 }]);
    expect(one).toBeGreaterThan(0.8);
    expect(one).toBeLessThan(0.9);
  });

  it("blocksView: a hill on the line from the camera to its target blocks it; one beside it does not", () => {
    const v: View = { name: "low", pos: [300, 20, 0], lookAt: [0, 0, 0], fovDeg: 40, aspect: 1 };
    expect(blocksView({ x: 150, z: 0, radius: 30, height: 20 }, [v])).toBe(true);
    expect(blocksView({ x: 150, z: 80, radius: 30, height: 20 }, [v])).toBe(false);
    expect(domeHeight({ radius: 30, height: 20 }, 0)).toBe(20);
    expect(domeHeight({ radius: 30, height: 20 }, 30)).toBe(0);
  });

  it("discStep sees a hard colour step at the ring and none on one colour", () => {
    const disc = (colourAt: (r: number) => THREE.Color, flatQuads = false) => {
      // a flat ground out to 800 m: 96-gon rings every 5 m, coloured by radius
      const pos: number[] = [];
      const col: number[] = [];
      for (let r = 0; r < 800; r += 5)
        for (let k = 0; k < 96; k++) {
          const a0 = (2 * Math.PI * k) / 96;
          const a1 = (2 * Math.PI * (k + 1)) / 96;
          const quad = [
            [r, a0],
            [r + 5, a0],
            [r + 5, a1],
            [r, a0],
            [r + 5, a1],
            [r, a1],
          ];
          for (const [rr, a] of quad) {
            pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
            const c = colourAt(flatQuads ? r + 2.5 : rr);
            col.push(c.r, c.g, c.b);
          }
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      return new Surface([{ geometry: g, matrix: new THREE.Matrix4(), colour: new THREE.Color(1, 1, 1) }]);
    };
    const haze: Haze = { colour: new THREE.Color("#D6E8EE"), near: town.fog.near, far: town.fog.far };
    const key0 = town.camera.keys[0];
    const v: View = { name: "key 0", pos: key0.pos, lookAt: key0.lookAt, fovDeg: key0.fovDeg, aspect: 16 / 9 };
    const hard = discStep(v, disc((r) => (r < 165 ? pal.near : pal.far), true), haze);
    const soft = discStep(v, disc((r) => groundColour(r, pal)), haze);
    const flat = discStep(v, disc(() => pal.far), haze);
    expect(hard.pairs).toBeGreaterThan(100);
    expect(hard.step).toBeGreaterThan(HORIZON.disc.maxStep * 4);
    expect(soft.step).toBeLessThan(HORIZON.disc.maxStep);
    expect(flat.step).toBeLessThan(1e-9);
  });
});

describe.skipIf(!assetIndex)("countryside round the town (the real GLBs)", () => {
  const views = allViews();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const parts = async (name: string, rotY = 0, scale = 1): Promise<Part[]> => {
    const e = assetIndex!.assets.find((a) => a.name === name)!;
    const gltf = await loader.parseAsync(readGlb(`${ASSETS}/${e.path}`), "");
    gltf.scene.rotation.y = rotY;
    gltf.scene.scale.setScalar(scale);
    gltf.scene.updateMatrixWorld(true);
    const out: Part[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      out.push({ geometry: m.geometry, matrix: m.matrixWorld.clone(), colour: mat.color.clone(), material: mat.name });
    });
    return out;
  };
  let built: Promise<{ cs: Countryside; again: Countryside; apron: Part[]; terrain: Part[]; mountains: Part[]; haze: Haze }> | undefined;
  const build = () =>
    (built ??= (async () => {
      const echo = HORIZON.mountainEcho;
      const apron = await parts("ground_apron");
      const terrain = await parts("terrain_town");
      const mountains = [...(await parts(echo.asset)), ...(await parts(echo.asset, (echo.rotYDeg * Math.PI) / 180, echo.scale))];
      const input = {
        apron,
        mountains,
        hillsRing: await parts("hills_ring"),
        hillTops: (assetIndex!.assets.find((a) => a.name === "hills_ring")?.anchors?.hill_tops ?? []) as Vec3[],
        tree: await parts(HORIZON.countryside.trees.asset),
        views: flyoverViews(town.camera.keys, 16 / 9, 1, 24),
      };
      const sky = await parts(town.sky ?? "sky_dome");
      return { cs: buildCountryside(input), again: buildCountryside(input), apron, terrain, mountains, haze: { colour: hazeColour(sky.map((p) => p.colour))!, near: town.fog.near, far: town.fog.far } };
    })());
  const white = new THREE.Color(1, 1, 1);

  it("measures the ramp's colours from the apron: the plateau's grass inside the ring, its own far grass outside", async () => {
    const { cs } = await build();
    console.log(`countryside ramp: near #${cs.palette.near.getHexString()}, far #${cs.palette.far.getHexString()}`);
    expect(`#${cs.palette.near.getHexString()}`).toBe("#78a152"); // grass_hill: terrain_town's rim, hills_ring's slopes
    expect(`#${cs.palette.far.getHexString()}`).toBe("#93af86"); // grass_far
  }, 60_000);

  it("the apron, the skirt and the mountains' feet carry the ramp; seams meet in one colour", async () => {
    const { cs, apron, mountains } = await build();
    const c = new THREE.Color();
    const w = new THREE.Vector3();
    // every apron vertex: the ramp's colour at its radius (the plateau's grass at the plateau's rim)
    const at = new Map<string, string>();
    cs.apron.forEach((g, i) => {
      const p = g.getAttribute("position");
      const col = g.getAttribute("color");
      for (let k = 0; k < p.count; k++) {
        w.fromBufferAttribute(p, k).applyMatrix4(apron[i].matrix);
        const want = groundColour(Math.hypot(w.x, w.z), cs.palette);
        c.setRGB(col.getX(k), col.getY(k), col.getZ(k));
        expect(Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b)).toBeLessThan(1e-5);
        const key = `${w.x.toFixed(2)},${w.z.toFixed(2)}`;
        const hex = c.getHexString();
        if (at.has(key)) expect(at.get(key), key).toBe(hex); // the two meshes' shared ring at 165 m: one colour
        at.set(key, hex);
        if (Math.hypot(w.x, w.z) < 100) expect(hex).toBe(cs.palette.near.getHexString());
      }
    });
    // the skirt: the apron's rim colour all over (it starts under the rim, past r full)
    const sc = cs.skirt.getAttribute("color");
    for (let k = 0; k < sc.count; k++) expect(new THREE.Color(sc.getX(k), sc.getY(k), sc.getZ(k)).getHexString()).toBe(cs.palette.far.getHexString());
    // the mountains: the ground's colour at their feet, their own higher up (the snow its own everywhere)
    let feet = 0;
    cs.mountains.forEach((g, i) => {
      const p = g.getAttribute("position");
      const col = g.getAttribute("color");
      const snow = HORIZON.countryside.mountainKeep.test(mountains[i].material ?? "");
      for (let k = 0; k < p.count; k++) {
        w.fromBufferAttribute(p, k).applyMatrix4(mountains[i].matrix);
        c.setRGB(col.getX(k), col.getY(k), col.getZ(k));
        const want = snow || w.y >= HORIZON.countryside.mountainBlend[1] ? mountains[i].colour : w.y <= HORIZON.countryside.mountainBlend[0] ? groundColour(Math.hypot(w.x, w.z), cs.palette) : null;
        if (!want) continue;
        if (!snow && w.y <= HORIZON.countryside.mountainBlend[0]) feet++;
        expect(Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b)).toBeLessThan(1e-5);
      }
    });
    expect(feet).toBeGreaterThan(100);
  }, 60_000);

  it("the check sees the old disc: the aerial key (and the fly-over's first seconds) had a hard step at the ring", async () => {
    const { cs, apron, terrain, haze } = await build();
    const before = new Surface([...terrain, ...apron, { geometry: skirtGeometry(), matrix: new THREE.Matrix4(), colour: cs.palette.far }]);
    for (const s of SCREENS) {
      const fov = playFov(CAMERA.fovDeg, s.aspect) / CAMERA.fovDeg;
      const k0 = town.camera.keys[0];
      const r = discStep({ name: "key 0", pos: k0.pos, lookAt: k0.lookAt, fovDeg: k0.fovDeg * fov, aspect: s.aspect }, before, haze);
      expect(r.step, s.name).toBeGreaterThan(HORIZON.disc.maxStep * 4); // 38/255 measured
    }
    expect(ringOpen([])).toBe(1); // and nothing but flat ground round the ring
  }, 60_000);

  it("no view sees a colour step at the ring now (every rim cell, the spawn, the fly-over at 24 fps, three screens)", async () => {
    const { cs, terrain, haze } = await build();
    const after = new Surface([...terrain, ...cs.ground.map((p) => ({ ...p, colour: white }))]);
    const over: string[] = [];
    let worst = 0;
    for (const v of views) {
      const r = discStep(v, after, haze);
      worst = Math.max(worst, r.step);
      if (r.step >= HORIZON.disc.maxStep) over.push(`${v.name}: ${(r.step * 255).toFixed(1)}`);
    }
    console.log(`countryside disc: worst step ${(worst * 255).toFixed(1)}/255 over ${views.length} views (limit ${(HORIZON.disc.maxStep * 255).toFixed(1)})`);
    expect(over).toEqual([]);
  }, 60_000);

  it("hills all round the ring: 24-40 of them, turned and scaled 0.6-1.6, r 150-600, under a quarter of the ring without one within 60 m", async () => {
    const { cs } = await build();
    const o = HORIZON.countryside.hills;
    expect(cs.hills.length).toBeGreaterThanOrEqual(24);
    expect(cs.hills.length).toBeLessThanOrEqual(40);
    for (const h of cs.hills) {
      const r = Math.hypot(h.x, h.z);
      expect(h.scale).toBeGreaterThanOrEqual(0.6);
      expect(h.scale).toBeLessThanOrEqual(1.6);
      expect(r).toBeGreaterThanOrEqual(150);
      expect(r).toBeLessThanOrEqual(600);
      expect(r - h.radius).toBeGreaterThanOrEqual(o.ringClear);
    }
    expect(new Set(cs.hills.map((h) => h.rotY.toFixed(6))).size).toBe(cs.hills.length); // each turned its own way
    // denser near the ring
    const near = cs.hills.filter((h) => Math.hypot(h.x, h.z) < 300).length;
    expect(near / cs.hills.length).toBeGreaterThan(0.5);
    const open = ringOpen(cs.hills);
    console.log(`countryside: ${cs.hills.length} hills, ${cs.trees.length} trees; ring open ${(open * 100).toFixed(1)} % (was 100 %)`);
    expect(open).toBeLessThan(HORIZON.shape.maxOpen);
    // the same on every load
    const { again } = await build();
    expect(again.hills).toEqual(cs.hills);
    expect(again.trees).toEqual(cs.trees);
  }, 60_000);

  it("hills and trees keep off the mountains, stand sunk in the apron, and never block the fly-over or stand on a rim camera", async () => {
    const { cs, mountains, apron } = await build();
    const peaks: [number, number][] = [];
    const w = new THREE.Vector3();
    for (const p of mountains) {
      const pos = p.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        w.fromBufferAttribute(pos, i).applyMatrix4(p.matrix);
        if (w.y > HORIZON.countryside.hills.mountainY) peaks.push([w.x, w.z]);
      }
    }
    for (const h of cs.hills) expect(peaks.some((q) => Math.hypot(q[0] - h.x, q[1] - h.z) < h.radius * 0.85)).toBe(false);
    for (const t of cs.trees) {
      expect(peaks.some((q) => Math.hypot(q[0] - t.x, q[1] - t.z) < 12)).toBe(false);
      expect(cs.hills.some((h) => Math.hypot(h.x - t.x, h.z - t.z) < h.radius)).toBe(false);
    }
    // sunk: each hill's lowest ring of vertices under the apron
    const ground = new Surface(apron.map((p, i) => ({ ...p, geometry: cs.apron[i] })));
    const p = cs.scatter.getAttribute("position");
    let checked = 0;
    let above = 0;
    const byHill = cs.hills.map((h) => ({ h, min: Infinity }));
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = byHill.find((b) => Math.hypot(b.h.x - x, b.h.z - z) <= b.h.radius + 0.5);
      if (h) h.min = Math.min(h.min, p.getY(i) - ground.height(x, z));
    }
    for (const b of byHill) {
      checked++;
      if (b.min > -0.05) above++;
    }
    expect(checked).toBe(cs.hills.length);
    expect(above).toBe(0);
    // the fly-over: no hill in any frame's sight line, none within 6 m of its camera
    const frames = views.filter((v) => /t=/.test(v.name));
    for (const h of cs.hills) expect(blocksView(h, frames), `hill at ${h.x.toFixed(0)}, ${h.z.toFixed(0)}`).toBe(false);
    // the gameplay camera at every rim cell stands outside every hill
    for (const c of rimCells(town.grid, 36)) {
      const v = rigView("rim", [c.x, c.y, c.z], rig, CAMERA.fovDeg, 16 / 9);
      for (const h of cs.hills) {
        const d = Math.hypot(v.pos[0] - h.x, v.pos[2] - h.z);
        expect(d > h.radius || v.pos[1] > h.height + 2).toBe(true);
      }
    }
  }, 60_000);
});
