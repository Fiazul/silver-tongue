// Prints the town's edge and sky report (src/horizon.ts): every landscape GLB's footprint and
// height, the seams between them, and for every view the game has (the gameplay camera at each
// rim cell, the fly-over at 24 fps; desktop, phone portrait, phone landscape) whether it sees past
// the ground or into a cloud, before (the GLBs as shipped, town.json's old haze) and after (the
// skirt, the second mountain ring, the moved clouds, the haze now). Re-run after a Blender rebuild:
//
//   npx tsx packages/world3d/scripts/horizon-report.ts        (WORLD3D_ASSETS=... for another library)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CAMERA } from "../src/camera";
import { bearingOf, buildCountryside, cloudExposure, discStep, edgeExposure, flyoverViews, groundColour, hazeColour, HORIZON, meanColour, moveClouds, playFov, rigView, rimCells, ringOpen, ringOpenInView, SCREENS, skirtGeometry, Surface, type Backdrop, type Haze, type Part, type View } from "../src/horizon";
import { LAYOUT, type Vec3 } from "../src/layout";

const ASSETS = process.env.WORLD3D_ASSETS ?? join(import.meta.dirname, "..", "assets");
const index = JSON.parse(readFileSync(join(ASSETS, "index.json"), "utf8")) as { assets: { name: string; path: string; anchors?: Record<string, unknown> }[] };
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

async function load(name: string): Promise<THREE.Object3D> {
  const e = index.assets.find((a) => a.name === name)!;
  const b = readFileSync(join(ASSETS, e.path));
  const g = await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
  g.scene.updateMatrixWorld(true);
  return g.scene;
}

function vertices(root: THREE.Object3D): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const p = m.geometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
  });
  return out;
}

const f1 = (n: number) => n.toFixed(1);
const town = LAYOUT.town;
const names = [...town.landscape, ...(town.sky ? [town.sky] : [])];
const geo = new Map<string, THREE.Vector3[]>();
await MeshoptDecoder.ready;
for (const n of names) geo.set(n, vertices(await load(n)));

console.log("## Landscape GLBs (world frame, m)\n");
console.log("| GLB | verts | XZ radius min-max | x | z | y | bearings covered (10° bins) |");
console.log("| --- | ---: | --- | --- | --- | --- | --- |");
for (const [n, vs] of geo) {
  const box = new THREE.Box3().setFromPoints(vs);
  const rs = vs.map((v) => Math.hypot(v.x, v.z));
  const bins = new Set(vs.map((v) => Math.floor(bearingOf(v.x, v.z) / 10)));
  const covered = bins.size === 36 ? "all" : `${bins.size}/36 (open: ${[...Array(36).keys()].filter((k) => !bins.has(k)).map((k) => k * 10).join(",")})`;
  console.log(`| ${n} | ${vs.length} | ${f1(Math.min(...rs))}-${f1(Math.max(...rs))} | ${f1(box.min.x)}..${f1(box.max.x)} | ${f1(box.min.z)}..${f1(box.max.z)} | ${f1(box.min.y)}..${f1(box.max.y)} | ${covered} |`);
}

// Seams: the plateau's outer edge against the apron's inner edge (same x/z, height step), the hills'
// and mountains' lowest vertices against the apron under them (sunk in = no gap).
console.log("\n## Seams\n");
const terrain = geo.get("terrain_town")!;
const apron = geo.get("ground_apron")!;
const key = (v: THREE.Vector3) => `${Math.round(v.x * 10)},${Math.round(v.z * 10)}`;
const apronAt = new Map<string, number[]>();
for (const v of apron) (apronAt.get(key(v)) ?? apronAt.set(key(v), []).get(key(v))!).push(v.y);
const rimT = terrain.filter((v) => Math.abs(Math.abs(v.x) - 70) < 0.01 || Math.abs(Math.abs(v.z) - 70) < 0.01);
let matched = 0;
let worst = 0;
for (const v of rimT) {
  const ys = apronAt.get(key(v));
  if (!ys) continue;
  matched++;
  worst = Math.max(worst, Math.min(...ys.map((y) => Math.abs(y - v.y))));
}
console.log(`- plateau rim -> apron: ${rimT.length} rim vertices, ${matched} with an apron vertex at the same x/z, worst height step ${worst.toFixed(3)} m`);
// the apron surface height under a point: the nearest apron vertices (it is a coarse fan; a lower bound check)
function apronBelow(x: number, z: number): number {
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
}
for (const n of ["hills_ring", "mountains_far"]) {
  const vs = geo.get(n)!;
  const base = Math.min(...vs.map((v) => v.y));
  const low = vs.filter((v) => v.y < base + 0.01);
  const over = low.filter((v) => v.y > apronBelow(v.x, v.z) + 0.05).length;
  console.log(`- ${n} -> apron: base y ${base.toFixed(2)}; ${low.length} base vertices, ${over} above the apron near them (0 = sunk in, no gap)`);
}
const apronR = Math.max(...apron.map((v) => Math.hypot(v.x, v.z)));
const rimY = apron.filter((v) => Math.hypot(v.x, v.z) > apronR - 1).map((v) => v.y);
console.log(`- apron rim r=${f1(apronR)}: y ${Math.min(...rimY).toFixed(2)}..${Math.max(...rimY).toFixed(2)}; skirt at y ${HORIZON.skirt.y} from r ${HORIZON.skirt.inner} to ${HORIZON.skirt.outer}`);
const dome = geo.get(town.sky ?? "sky_dome")!;
const domeR = Math.max(...dome.map((v) => Math.hypot(v.x, v.z)));
console.log(`- sky dome r=${f1(domeR)}, bottom y ${f1(Math.min(...dome.map((v) => v.y)))}; haze now ${town.fog.near}-${town.fog.far} m`);

// The views
const rig = { elevationDeg: CAMERA.elevationDeg, azimuthDeg: CAMERA.azimuthDeg, distance: CAMERA.distance, aimHeight: CAMERA.aimHeight };
const rim = rimCells(town.grid, 36);
const views: { group: string; v: View }[] = [];
for (const s of SCREENS) {
  const fov = playFov(CAMERA.fovDeg, s.aspect);
  const spawn = LAYOUT.town.camera.keys.at(-1)!;
  views.push({ group: `spawn ${s.name}`, v: { name: "spawn", pos: spawn.pos, lookAt: spawn.lookAt, fovDeg: fov, aspect: s.aspect } });
  for (const c of rim) views.push({ group: `rim ${s.name}`, v: rigView(`rim ${c.bearing.toFixed(0)}° (${c.x}, ${c.z})`, [c.x, c.y, c.z], rig, fov, s.aspect) });
  for (const v of flyoverViews(town.camera.keys, s.aspect, fov / CAMERA.fovDeg, 24)) views.push({ group: `fly-over ${s.name}`, v });
  town.camera.keys.forEach((k, i) => views.push({ group: `key ${i} ${s.name}`, v: { name: `key ${i} t=${k.t}`, pos: k.pos, lookAt: k.lookAt, fovDeg: k.fovDeg * (fov / CAMERA.fovDeg), aspect: s.aspect } }));
}

const before: Backdrop = { groundRadius: apronR * Math.cos(Math.PI / 48), groundY: -0.5, fogNear: 110, fogFar: 950, far: CAMERA.far };
const after: Backdrop = { groundRadius: HORIZON.skirt.outer, groundY: HORIZON.skirt.y, fogNear: town.fog.near, fogFar: town.fog.far, far: CAMERA.far };

// clouds: each source cluster's box, before and after the move
const slots = (index.assets.find((a) => a.name === "clouds")?.anchors?.cloud_slots ?? []) as Vec3[];
const cloudRoot = await load("clouds");
function cloudBoxes(move: boolean): THREE.Box3[] {
  const boxes = slots.map(() => new THREE.Box3());
  cloudRoot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    if (move) moveClouds(g, slots, HORIZON.clouds);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const src = new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute("position"), i);
      let k = 0;
      let bd = Infinity;
      slots.forEach((s, j) => {
        const d = src.distanceToSquared(new THREE.Vector3(...s));
        if (d < bd) {
          bd = d;
          k = j;
        }
      });
      boxes[k].expandByPoint(v);
    }
  });
  return boxes;
}
const cloudsBefore = cloudBoxes(false);
const cloudsAfter = cloudBoxes(true);

console.log("\n## A. Views past the ground (open = rays that cross the ground's edge under 99 % haze)\n");
console.log("| view group | views | before: views open | before: least haze at an edge | after: views open | after: least haze |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
const groups = [...new Set(views.map((x) => x.group))];
for (const g of groups) {
  const vs = views.filter((x) => x.group === g).map((x) => x.v);
  const b = vs.map((v) => edgeExposure(v, before));
  const a = vs.map((v) => edgeExposure(v, after));
  const openB = b.filter((r) => r.open > 0).length;
  const openA = a.filter((r) => r.open > 0).length;
  console.log(`| ${g} | ${vs.length} | ${openB} | ${Math.min(...b.map((r) => r.minFog)).toFixed(2)} | ${openA} | ${Math.min(...a.map((r) => r.minFog)).toFixed(2)} |`);
}

console.log("\n## B. Clouds (per slot: centre before -> after; the views that came within 150 m in frame or had it at the centre)\n");
console.log("| slot | before centre | after centre | after r / height | views hit before | views hit after | nearest camera before -> after (m) |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
const cams = views.map((x) => x.v);
slots.forEach((s, k) => {
  const hits = (boxes: THREE.Box3[]) => {
    const names = new Set<string>();
    let nearest = Infinity;
    for (const v of cams) {
      const r = cloudExposure(v, [boxes[k]]);
      nearest = Math.min(nearest, r.nearest);
      if (r.close || r.centre) names.add(v.name.replace(/t=([\d.]+)/, (_m, t) => `t=${Number(t).toFixed(1)}`));
    }
    return { names, nearest };
  };
  const b = hits(cloudsBefore);
  const a = hits(cloudsAfter);
  const t = HORIZON.clouds[k];
  const list = (n: Set<string>) => (n.size ? `${n.size}: ${[...n].slice(0, 4).join("; ")}${n.size > 4 ? " ..." : ""}` : "none");
  console.log(`| ${k} | (${s.join(", ")}) | (${t.join(", ")}) | ${f1(Math.hypot(t[0], t[2]))} / ${t[1]} | ${list(b.names)} | ${list(a.names)} | ${f1(b.nearest)} -> ${f1(a.nearest)} |`);
});

// ---------------------------------------------------------------------------------------------
// C. The countryside (horizon.ts buildCountryside): the ramp's colours, the hills, the disc check
// ---------------------------------------------------------------------------------------------
async function parts(name: string, rotY = 0, scale = 1): Promise<Part[]> {
  const root = await load(name);
  root.rotation.y = rotY;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const out: Part[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    out.push({ geometry: m.geometry, matrix: m.matrixWorld.clone(), colour: mat.color.clone(), material: mat.name });
  });
  return out;
}
const hex = (c: THREE.Color) => `#${c.getHexString().toUpperCase()}`;
const apronParts = await parts("ground_apron");
const terrainParts = await parts("terrain_town");
const hillParts = await parts("hills_ring");
const echo = HORIZON.mountainEcho;
const cs = buildCountryside({
  apron: apronParts,
  mountains: [...(await parts(echo.asset)), ...(await parts(echo.asset, (echo.rotYDeg * Math.PI) / 180, echo.scale))],
  hillsRing: hillParts,
  hillTops: (index.assets.find((a) => a.name === "hills_ring")?.anchors?.hill_tops ?? []) as Vec3[],
  tree: await parts(HORIZON.countryside.trees.asset),
  views: flyoverViews(town.camera.keys, 16 / 9, 1, 24),
});
const skyParts = await parts(town.sky ?? "sky_dome");
const haze: Haze = { colour: hazeColour(skyParts.map((p) => p.colour))!, near: town.fog.near, far: town.fog.far };
const plateauHills = meanColour([...terrainParts, ...hillParts], (p) => {
  const r = Math.hypot(p.x, p.z);
  return r > 63 && r < 140; // what is seen round the ring from above
});
console.log("\n## C. Countryside\n");
console.log(`- ramp: near ${hex(cs.palette.near)} (the apron's faces inside r ${HORIZON.countryside.inner}: the plateau's grass_hill), far ${hex(cs.palette.far)} (its faces past r ${HORIZON.countryside.full}: grass_far); haze ${hex(haze.colour)}`);
console.log(`- measured for comparison: plateau + hills seen from above in r 63-140 (area-weighted, all materials) ${hex(plateauHills)}`);
console.log(`- ground colour by radius: ${[99, 140, 165, 200, 250, 300, 350, 400, 760].map((r) => `${r} m ${hex(groundColour(r, cs.palette))}`).join(", ")}`);
const sc = cs.hills.map((h) => h.scale);
const hr = cs.hills.map((h) => Math.hypot(h.x, h.z));
console.log(`- hills: ${cs.hills.length} (mounds ${cs.mounds.map((m) => `r ${m.radius.toFixed(0)} h ${m.height.toFixed(0)}`).join("; ")}), scale ${Math.min(...sc).toFixed(2)}-${Math.max(...sc).toFixed(2)}, centres r ${Math.min(...hr).toFixed(0)}-${Math.max(...hr).toFixed(0)} m, footprints from r ${Math.min(...cs.hills.map((h) => Math.hypot(h.x, h.z) - h.radius)).toFixed(0)} m`);
console.log(`- trees: ${cs.trees.length} ${HORIZON.countryside.trees.asset} in ${HORIZON.countryside.trees.clumps} clumps; scatter ${(cs.scatter.index?.count ?? 0) / 3} triangles; apron ${apronParts.map((p) => (p.geometry.index?.count ?? 0) / 3).join("+")} -> ${cs.apron.map((g) => (g.index?.count ?? 0) / 3).join("+")} triangles`);
console.log(`- shape: the ring (r ${HORIZON.shape.r}) with no extra hill within ${HORIZON.shape.within} m: before ${(ringOpen([]) * 100).toFixed(0)} %, after ${(ringOpen(cs.hills) * 100).toFixed(1)} % (limit ${HORIZON.shape.maxOpen * 100} %)`);
const white = new THREE.Color(1, 1, 1);
const groundBefore = new Surface([...terrainParts, ...apronParts, { geometry: skirtGeometry(), matrix: new THREE.Matrix4(), colour: cs.palette.far }]);
const groundAfter = new Surface([...terrainParts, ...cs.ground.map((p) => ({ ...p, colour: white }))]);
const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(0)} %`);
console.log(`\n### Disc: the largest colour step (sRGB 0-255, any channel / luma, after the haze) between neighbouring 2 m ground samples in r ${HORIZON.disc.band.join("-")} m (discStep); limit ${(HORIZON.disc.maxStep * 255).toFixed(1)}; n/v: the band is not in any of the group's frames\n`);
console.log("| view group | views | before: worst step / luma | after: worst step / luma | after: views over | ring in frame with no hill near (worst view) |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const g of groups) {
  const vs = views.filter((x) => x.group === g).map((x) => x.v);
  const b = vs.map((v) => discStep(v, groundBefore, haze));
  const a = vs.map((v) => discStep(v, groundAfter, haze));
  const w = (rs: typeof b, k: "step" | "luma") => (rs.some((r) => r.pairs) ? (Math.max(...rs.map((r) => r[k])) * 255).toFixed(1) : "n/v");
  const over = a.filter((r) => r.step > HORIZON.disc.maxStep).length;
  const shapes = vs.map((v) => ringOpenInView(v, cs.hills)).filter((x): x is number => x !== null);
  console.log(`| ${g} | ${vs.length} | ${w(b, "step")} / ${w(b, "luma")} | ${w(a, "step")} / ${w(a, "luma")} | ${over} | ${shapes.length ? pct(Math.max(...shapes)) : "-"} |`);
}
console.log("\n### Per view (desktop; phone portrait in brackets)\n");
console.log("| view | before step | after step | ring in frame open, before -> after |");
console.log("| --- | ---: | ---: | --- |");
const portrait = SCREENS.find((s) => s.name === "phone-portrait")!;
const pick: { name: string; at: (aspect: number, fovScale: number) => View }[] = [
  ...[0, 1, 2, 2.8, 3.9, 5].map((t) => ({ name: `fly-over t=${t}`, at: (aspect: number, k: number) => flyoverViews(town.camera.keys, aspect, k, 24).reduce((best, v) => (Math.abs(Number(v.name.slice(2)) - t) < Math.abs(Number(best.name.slice(2)) - t) ? v : best)) })),
  ...rim.filter((_, i) => i % 6 === 0).map((c) => ({ name: `rim ${c.bearing.toFixed(0)}° (${c.x}, ${c.z})`, at: (aspect: number, k: number) => rigView("rim", [c.x, c.y, c.z], rig, CAMERA.fovDeg * k, aspect) })),
];
for (const p of pick) {
  const d = p.at(16 / 9, 1);
  const ph = p.at(portrait.aspect, playFov(CAMERA.fovDeg, portrait.aspect) / CAMERA.fovDeg);
  const st = (v: View, gnd: Surface) => {
    const r = discStep(v, gnd, haze);
    return r.pairs ? (r.step * 255).toFixed(1) : "band not in view";
  };
  console.log(`| ${p.name} | ${st(d, groundBefore)} (${st(ph, groundBefore)}) | ${st(d, groundAfter)} (${st(ph, groundAfter)}) | ${pct(ringOpenInView(d, []))} -> ${pct(ringOpenInView(d, cs.hills))} (${pct(ringOpenInView(ph, []))} -> ${pct(ringOpenInView(ph, cs.hills))}) |`);
}
