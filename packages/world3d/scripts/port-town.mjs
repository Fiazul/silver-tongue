// Ports the beginner canal town (make-it-in-china tools/blender/town_layout.py ->
// assets/town_layout/town.json + assets/landscape/terrain_town_walkable.json) into src/town.json,
// the outdoor half of the game's layout (layout.ts merges it with src/layout.json, which keeps the
// interiors). Checked in, so the build needs nothing but the repo; test/town.test.ts fails when
// src/town.json is stale against the vendored sources.
//
//   npm run port-town -w @silver-tongue/world3d     (WORLD3D_ASSETS=... for another library)
//
// What comes from town.json as is: every placement (pos, rotY, scale), the landscape GLBs (loaded
// at the origin), the blockers (oriented rects), the walk grid (classes 1-5 walkable, heights),
// the bridge and pier decks (walk paths), the spawn, the sun and the fly-over camera path. What is
// decided here (the mapping onto the course's places; see README "Outdoors"): the zone boxes, the
// doors, the travel-only spots and where the outdoor NPCs, walkers and pets stand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// The mapping (decided in the brief; boxes are x/z, [xmin, zmin, xmax, zmax], metres)
// ---------------------------------------------------------------------------------------------

/**
 * Outdoor zones. `street` is the town's default place: plaza, spokes, great tree, pier, the north
 * pads and loops, every walkable cell outside the boxes below. Boxes of different places keep
 * 0.5 m apart (the hysteresis margin both sides); boxes of one place may touch.
 */
const ZONES = {
  // pad_canal_s shops + promenade + loop_south (the whole band between the plaza's rim and the
  // south loop, bridges included), and the meadow south of the loop either side of the gate
  market: [
    [-50, 12, 50, 34],
    [-50, 34, -12.5, 52],
    [12.5, 34, 50, 52],
  ],
  // the east side: pad_ne (corner shop, rented room), pad_east (the pavilion), the town gate / bus stop
  station_road: [
    [3.5, -25, 25, -11.5],
    [13, 3, 25, 11.5],
    [-12, 34.5, 12, 52],
  ],
};

/** Doors: a place's trigger `depth` metres out from its building's door anchor (doors win over the zone round them). */
const DOORS = {
  noodle_shop: { building: "noodle_shop", anchor: "door", width: 1.4, depth: [0.35, 1.1] },
  room: { building: "rented_room", anchor: "door", width: 1.4, depth: [0.35, 1.1] },
  shop: { building: "supermarket", anchor: "door", width: 1.4, depth: [0.35, 1.1] },
  tea_house: { building: "tea_house", anchor: "door", width: 1.4, depth: [0.35, 1.1] },
  // no interior: the stand in front of the shelter is the station
  station: { building: "bus_stop", anchor: "door", width: 3.0, depth: [0.35, 2.4] },
};

/** The pier deck: shore end, far end (town.json piers[0].walk_path). */
const pierPoint = (pier, along) => {
  const [a, b] = pier.walk_path;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const u = [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
  return { pos: [a[0] + u[0] * along, a[2] + u[1] * along], u };
};

/**
 * NPCs outdoors (the rest stand in their interiors, layout.json). `stand` / `playerStand`: a
 * building anchor name, or a fixed x/z with a facing (y is the walking height, snapped at runtime).
 */
function outdoorNpcs(town) {
  const pier = town.walkable.piers[0];
  const foreman = pierPoint(pier, 4.6);
  const foremanTalk = pierPoint(pier, 3.3);
  const fixed = (x, z, fx, fz) => ({ pos: [x, 0, z], facing: [r3(fx), 0, r3(fz)] });
  const toward = (from, to) => {
    const d = [to[0] - from[0], to[1] - from[1]];
    const l = Math.hypot(d[0], d[1]);
    return [d[0] / l, d[1] / l];
  };
  const pair = (npc, talk) => {
    const f = toward(talk, npc);
    return { stand: fixed(npc[0], npc[1], -f[0], -f[1]), playerStand: fixed(talk[0], talk[1], f[0], f[1]) };
  };
  return {
    // street: by the benches round the great tree, facing the plaza and the spawn
    wang: { space: "street", ...pair([-13.2, 9.8], [-12.0, 9.6]) },
    // market: behind the fruit stall's counter (its npc_stand), talked to across it
    dispatcher: { building: "fruit_stall", stand: "npc_stand", playerStand: fixed(13.5, 28.9, 0, -1) },
    // warehouse (travel-only): out on the pier
    foreman: { space: "street", ...pair(foreman.pos.map(r3), foremanTalk.pos.map(r3)) },
    // school and hospital (travel-only): either side of the pavilion
    teacher: { space: "street", ...pair([15.3, 7.6], [14.1, 7.6]) },
    classmate: { space: "street", ...pair([15.3, 6.0], [14.1, 6.0]) },
    doctor: { space: "street", ...pair([22.7, 7.0], [23.9, 7.0]) },
    // station: the driver in the shelter (its npc_stand), the traveller waiting beside it
    driver: { building: "bus_stop", stand: "npc_stand", playerStand: fixed(-2.35, 40.825, -1, 0) },
    traveller: { space: "street", ...pair([-1.6, 42.9], [-1.6, 41.9]) },
  };
}

/** Travel-only places (no building in this town): reached from the Go to list; the spot holds the place while you stay near it. */
const TRAVEL_ONLY = {
  warehouse: { npcs: ["foreman"], box: "pier" },
  school: { npcs: ["teacher", "classmate"], box: [13.3, 4.6, 16.2, 8.9] },
  hospital: { npcs: ["doctor"], box: [21.9, 5.2, 24.8, 8.8] },
};

/**
 * Ambient walkers, there and back along the paths (layout_hints paths, off their lanterns). `role`:
 * who they are when talked to (barks/<language>.json roles, src/barks.ts).
 */
const WALKERS = [
  { character: "customer_a_green", role: "stroller", path: [[-22, 13.4], [22, 13.4]], speed: 1.1 },
  { character: "customer_a", role: "shopper", path: [[-26, 32.5], [26, 32.5]], speed: 1.25 },
  { character: "customer_a_blue", role: "worker", path: [[11.5, 0.6], [27.4, 0.6], [27.4, 11]], speed: 1 },
  { character: "kid", role: "kid", path: [[0.6, -11], [0.6, -26], [-6, -27.4]], speed: 1.4 },
  { character: "customer_b", role: "granny", path: [[-24, -27.4], [24, -27.4]], speed: 0.9 },
  { character: "customer_a_khaki", role: "tourist", path: [[-27.4, -22], [-27.4, 12], [-27.6, 24], [-20, 24.6]], speed: 1 },
  { character: "courier", role: "courier", path: [[-12, 36.2], [0.4, 36.2], [0.4, 46]], speed: 1.2 },
];

/** Pets: the cat by the noodle shop, a dog on the lake shore, pigeons on the plaza (they scatter). Their role is their asset (cat, dog, pigeon). */
const PETS = [
  { asset: "cat", pos: [-13.6, 0, 29.7], rotY: 200 },
  { asset: "dog", pos: [-33.4, 0, 1.2], rotY: 120 },
  { asset: "pigeon", pos: [2.2, 0.05, -3.2], rotY: 30, behaviour: "scatter" },
  { asset: "pigeon", pos: [3.1, 0.05, -2.4], rotY: 160, behaviour: "scatter" },
  { asset: "pigeon", pos: [1.6, 0.05, -1.6], rotY: 260, behaviour: "scatter" },
];

/**
 * People standing about who aren't in the course (they only say a line, src/barks.ts): the egg
 * seller's stall on the south bank (a folding table with egg trays, in the gap between the phone
 * shop and the shuttered shop, the seller behind it facing the promenade; the town has no egg stall
 * of its own), and a boatman on the lake shore by the pier. The fruit stall already has its keeper
 * (Miss Gao, outdoorNpcs). Dressing: not blocked (the town's blockers are town.json's own).
 */
const STANDING = [
  { asset: "table_folding", pos: [-4, 0, 28.3], rotY: 0 },
  { asset: "egg_tray", pos: [-4.3, 0.75, 28.25], rotY: 0 },
  { asset: "egg_tray", pos: [-3.7, 0.75, 28.32], rotY: 12 },
  { asset: "fruit_seller", role: "egg_seller", pos: [-4, 0, 27.55], rotY: 0 },
  { asset: "bus_driver", role: "boatman", pos: [-33.8, -0.15, 3.1], rotY: 250 },
];

/** Outdoor fog for a 140 m plateau under mountains 360-400 m out: clear over the town, a haze on the far ring. */
const FOG = { near: 110, far: 950 };

// ---------------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------------

/** "set/name" (town.json) -> the index.json entry's name, checked against the index. */
function assetName(index, ref) {
  const [set, name] = ref.split("/");
  const a = index.assets.find((x) => x.name === name);
  if (!a || a.set !== set) throw new Error(`town.json names ${ref}: not in index.json`);
  return name;
}

const facingOf = (deg) => [r3(Math.sin(deg * DEG)), 0, r3(Math.cos(deg * DEG))];
const box = ([x0, z0, x1, z1]) => ({ min: [x0, z0], max: [x1, z1] });

/** The walking checks the port runs on its own output (the same rules as layout.ts walkable). */
function walkChecks(out) {
  const g = out.grid;
  const cls = (x, z) => {
    const i = Math.floor((x - g.x0) / g.cell);
    const j = Math.floor((z - g.z0) / g.cell);
    return i < 0 || j < 0 || i >= g.cols || j >= g.rows ? 0 : Number(g.classes[j][i]);
  };
  const onDeck = (x, z) =>
    out.decks.some((d) => {
      for (let k = 0; k + 1 < d.path.length; k++) {
        const a = d.path[k];
        const b = d.path[k + 1];
        const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
        const t = ((x - a[0]) * (b[0] - a[0]) + (z - a[2]) * (b[2] - a[2])) / (len * len);
        if (t < 0 || t > 1) continue;
        const lat = Math.abs(((x - a[0]) * (b[2] - a[2]) - (z - a[2]) * (b[0] - a[0])) / len);
        if (lat <= d.width / 2 - 0.28) return true;
      }
      return false;
    });
  const walkable = (x, z) => onDeck(x, z) || (cls(x, z) >= 1 && cls(x, z) <= 4);
  const nearBlocker = (x, z, r) =>
    out.blockers.some((b) => {
      const a = b.rotY * DEG;
      const dx = x - b.centre[0];
      const dz = z - b.centre[1];
      const lx = dx * Math.cos(a) - dz * Math.sin(a);
      const lz = dx * Math.sin(a) + dz * Math.cos(a);
      return Math.abs(lx) < b.half[0] + r && Math.abs(lz) < b.half[1] + r;
    });
  const problems = [];
  for (const w of out.walkers)
    for (let k = 0; k + 1 < w.path.length; k++) {
      const [a, b] = [w.path[k], w.path[k + 1]];
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25);
      for (let s = 0; s <= n; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / n;
        const z = a[1] + ((b[1] - a[1]) * s) / n;
        if (!walkable(x, z) || nearBlocker(x, z, 0.3)) problems.push(`walker ${w.character} at ${x.toFixed(2)},${z.toFixed(2)}`);
      }
    }
  for (const p of out.dressing) if (!walkable(p.pos[0], p.pos[2]) || nearBlocker(p.pos[0], p.pos[2], 0.2)) problems.push(`dressing ${p.asset} at ${p.pos}`);
  if (problems.length) throw new Error(`port-town: off the walkable ground or in a blocker:\n  ${problems.slice(0, 20).join("\n  ")}`);
}

/** town.json + its walk grid + the asset index -> src/town.json's content. */
export function portTown(town, grid, index) {
  if (town.version !== 1 || town.frame !== "gltf") throw new Error("port-town: expects town.json version 1, glTF frame");
  const buildings = town.placements.map((p) => ({
    id: p.id,
    asset: assetName(index, p.asset),
    pos: p.pos.map(r3),
    rotY: r3(p.rot_y_deg),
    ...(p.scale && p.scale !== 1 ? { scale: p.scale } : {}),
  }));
  const ids = new Set(buildings.map((b) => b.id));
  const landscape = town.landscape.filter((l) => !l.optional).map((l) => assetName(index, l.asset));
  const sky = town.landscape.filter((l) => l.optional).map((l) => assetName(index, l.asset))[0];
  const blockers = town.walkable.blockers.map((b) => ({ id: b.id, centre: b.centre.map(r3), half: b.half_size.map(r3), rotY: r3(b.rot_y_deg) }));
  // Walk grid: classes as digit rows, heights (glTF y at the cell corners) in whole centimetres.
  const heights = grid.heights.flat().map((h) => Math.round(h * 100));
  if (grid.heights.length !== grid.rows + 1 || grid.heights[0].length !== grid.cols + 1) throw new Error("port-town: heights grid is not (rows+1) x (cols+1)");
  const classes = grid.walkable.map((row) => row.join(""));
  const decks = [
    ...town.walkable.bridges.map((b) => ({ id: b.id, kind: "bridge", width: b.width, path: b.walk_path.map((p) => p.map(r3)) })),
    ...town.walkable.piers.map((b) => ({ id: b.id, kind: "pier", width: b.width, path: b.walk_path.map((p) => p.map(r3)) })),
  ];
  const plazaPlacement = town.placements.find((p) => p.asset === "landscape/plaza_round");
  const plazaEntry = index.assets.find((a) => a.name === "plaza_round");
  const plaza = plazaPlacement
    ? { centre: [plazaPlacement.pos[0], plazaPlacement.pos[2]], radius: plazaEntry.size_m[0] / 2, y: r3(plazaPlacement.pos[1] + (plazaEntry.anchors?.top_z ?? 0)) }
    : undefined;

  // Places: zones, doors, travel-only spots, spawns.
  const npcs = outdoorNpcs(town);
  const talkOf = (n) => npcs[n].playerStand;
  const places = {
    street: { buildings: [], spawn: { pos: town.spawn.pos.map(r3), facing: facingOf(town.spawn.face_deg) } },
    market: {
      buildings: ["fruit_stall"],
      zone: box(ZONES.market[0]),
      zones: ZONES.market.slice(1).map(box),
      spawn: { pos: [13.5, 0, 30.2], facing: [0, 0, -1] },
    },
    station_road: {
      buildings: ["supermarket", "rented_room", "pavilion", "town_gate"],
      zone: box(ZONES.station_road[0]),
      zones: ZONES.station_road.slice(1).map(box),
      spawn: { pos: [14, 0, -12.5], facing: [0, 0, -1] },
    },
    station: { buildings: ["bus_stop"], door: DOORS.station, spawn: { pos: [-1.9, 0, 40.6], facing: [-1, 0, 0] } },
    noodle_shop: { buildings: ["noodle_shop"], door: DOORS.noodle_shop },
    room: { buildings: ["rented_room"], door: DOORS.room },
    shop: { buildings: ["supermarket"], door: DOORS.shop },
    tea_house: { buildings: ["tea_house"], door: DOORS.tea_house },
  };
  for (const [place, t] of Object.entries(TRAVEL_ONLY)) {
    let b = t.box;
    if (b === "pier") {
      const [a, e] = town.walkable.piers[0].walk_path;
      const w = town.walkable.piers[0].width / 2 + 0.3;
      b = [Math.min(a[0], e[0]) - w, Math.min(a[2], e[2]) - w, Math.max(a[0], e[0]) + w, Math.max(a[2], e[2]) + w].map(r3);
    }
    const talk = talkOf(t.npcs[0]);
    places[place] = { buildings: [], travelOnly: true, stay: box(b), spawn: { pos: talk.pos, facing: talk.facing } };
  }
  for (const [p, d] of Object.entries(DOORS)) if (!ids.has(d.building)) throw new Error(`port-town: door of ${p} on missing building ${d.building}`);
  for (const [n, s] of Object.entries(npcs)) if (s.building && !ids.has(s.building)) throw new Error(`port-town: ${n} stands at missing building ${s.building}`);

  const cp = town.camera_path;
  const out = {
    $comment:
      "Generated by scripts/port-town.mjs from the make-it-in-china town (assets/town_layout/town.json + landscape/terrain_town_walkable.json); do not edit. glTF axes, metres; rotY in degrees as layout.ts anchorToWorld. Merged with src/layout.json by layout.ts.",
    source: { version: town.version, placements: town.placements.length, blockers: town.walkable.blockers.length },
    bounds: { min: [grid.x0, grid.z0], max: [grid.x0 + grid.cols * grid.cell_m, grid.z0 + grid.rows * grid.cell_m] },
    landscape,
    ...(sky ? { sky } : {}),
    buildings,
    blockers,
    grid: { x0: grid.x0, z0: grid.z0, cell: grid.cell_m, cols: grid.cols, rows: grid.rows, classes, heights },
    decks,
    ...(plaza ? { plaza } : {}),
    sun: { azimuthDeg: town.sun.azimuth_deg, elevationDeg: town.sun.elevation_deg },
    fog: FOG,
    camera: {
      duration: cp.duration_s,
      endPose: { elevationDeg: cp.end_pose.elevation_deg, azimuthDeg: cp.end_pose.azimuth_deg, distance: cp.end_pose.distance, aimHeight: cp.end_pose.aim_height, fovDeg: cp.end_pose.fov_deg },
      keys: cp.keys.map((k) => ({ t: k.t, pos: k.pos, lookAt: k.look_at, fovDeg: k.fov_deg, posTangent: k.pos_tangent, lookTangent: k.look_tangent })),
    },
    places,
    npcs,
    walkers: WALKERS,
    dressing: [...PETS, ...STANDING],
  };
  out.grid.cell = grid.cell_m;
  walkChecks(out);
  return out;
}

/** The town sources in an asset library dir: town.json and the walk grid it names. */
export function readTownSources(dir) {
  const town = JSON.parse(readFileSync(join(dir, "town_layout", "town.json"), "utf8"));
  const grid = JSON.parse(readFileSync(join(dir, town.walkable.grid.replace(/\.json$/, "") + ".json"), "utf8"));
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  return { town, grid, index };
}

/** The same JSON text every time (the staleness test compares it byte for byte). */
export const townJsonText = (out) => JSON.stringify(out) + "\n";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.env.WORLD3D_ASSETS ?? join(here, "assets");
  if (!existsSync(join(src, "town_layout", "town.json"))) throw new Error(`no town at ${src}/town_layout/town.json (run npm run assets:sync, or set WORLD3D_ASSETS)`);
  const { town, grid, index } = readTownSources(src);
  const out = portTown(town, grid, index);
  writeFileSync(join(here, "src", "town.json"), townJsonText(out));
  console.log(`ported ${src}/town_layout/town.json -> src/town.json: ${out.buildings.length} placements, ${out.blockers.length} blockers, ${Object.keys(out.places).length} places, ${out.walkers.length} walkers`);
}
