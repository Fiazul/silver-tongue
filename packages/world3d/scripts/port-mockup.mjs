// One-off port of the Blender street mock-up (tools/blender/mockup.py, exported as
// assets/street_mockup.glb) into src/layout.json. The mock-up places every asset through manifest
// anchors; its GLB holds the resulting instance transforms, so this reads them back instead of
// re-deriving mockup.py's maths. Re-running overwrites src/layout.json: after the first port the
// JSON is the source of truth and can be edited by hand.
//
//   node scripts/port-mockup.mjs [assetsDir]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = process.argv[2] ?? process.env.WORLD3D_ASSETS ?? join(here, "..", "..", "..", "..", "assets");
const index = JSON.parse(readFileSync(join(assets, "index.json"), "utf8"));
const byName = new Map(index.assets.map((a) => [a.name, a]));

function readGlbJson(path) {
  const b = readFileSync(path);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
}

const gltf = readGlbJson(join(assets, "street_mockup.glb"));
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const deg = (rad) => Math.round((rad * 180) / Math.PI * 10) / 10;

/** Quaternion [x,y,z,w] -> {rotY, tiltX} in degrees; the mock-up only rotates about Y, or tilts crates about X. */
function rotOf(q = [0, 0, 0, 1]) {
  const [x, y, z, w] = q;
  if (Math.abs(x) < 1e-4 && Math.abs(z) < 1e-4) return { rotY: deg(2 * Math.atan2(y, w)) };
  if (Math.abs(y) < 1e-4 && Math.abs(z) < 1e-4) return { rotY: 0, tiltX: deg(2 * Math.atan2(x, w)) };
  throw new Error(`unsupported rotation ${q}`);
}

/** World AABB of a mock-up-only mesh node (forecourt, road/pavement extensions): its accessor bounds + translation. */
function meshBox(node) {
  const mesh = gltf.meshes[node.mesh];
  const t = node.translation ?? [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.primitives) {
    const acc = gltf.accessors[p.attributes.POSITION];
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], acc.min[i] + t[i]);
      hi[i] = Math.max(hi[i], acc.max[i] + t[i]);
    }
  }
  return { min: r3(lo), max: r3(hi) };
}

// Palette sRGB (tools/blender/lib/palette.py) for the mock-up's own ground boxes.
const GROUND_COLOUR = { forecourt: "#C8C1B2", pave_ext: "#C8C1B2", road_ext: "#4A4A4E" };
// Characters that are game NPCs or the player: placed from world.json + building anchors, not copied.
const NPC_CHARACTER = { wang: "old_wang", cook: "cook", landlord: "landlord", foreman: "warehouse_boss" };
const SKIP = new Set([...Object.values(NPC_CHARACTER), "player", "power_wires"]);

const tiles = [];
const buildings = [];
const dressing = [];
const ground = [];
const skipped = [];
for (const node of gltf.nodes) {
  const name = node.name.replace(/\.\d+$/, "");
  const pos = r3(node.translation ?? [0, 0, 0]);
  if (GROUND_COLOUR[name]) {
    ground.push({ name, colour: GROUND_COLOUR[name], ...meshBox(node) });
    continue;
  }
  if (SKIP.has(name)) continue;
  const asset = byName.get(name);
  if (!asset) {
    skipped.push(name);
    continue;
  }
  const entry = { asset: name, pos, ...rotOf(node.rotation) };
  if (/^(road_|pavement_)/.test(name)) tiles.push(entry);
  else if (asset.set === "buildings") buildings.push({ id: name, ...entry });
  else dressing.push(entry);
}

const building = (id) => {
  const b = buildings.find((x) => x.id === id);
  if (!b) throw new Error(`mock-up has no ${id}`);
  return b;
};

/**
 * A place's trigger zone: the buildings' footprints in x (facade origin = footprint centred in x),
 * from the facade line out to 0.6 m past the building's player_stand, where the player talks.
 */
function zoneFor(ids) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const id of ids) {
    const b = building(id);
    const a = byName.get(b.asset);
    if (b.rotY !== 0) throw new Error(`zone rule assumes unrotated far-row buildings (${id})`);
    const half = a.size_m[0] / 2;
    x0 = Math.min(x0, b.pos[0] - half);
    x1 = Math.max(x1, b.pos[0] + half);
    z0 = Math.min(z0, b.pos[2]);
    z1 = Math.max(z1, b.pos[2] + a.anchors.player_stand.pos[2] + 0.6);
  }
  return { min: r3([x0, z0]), max: r3([x1, z1]) };
}

const placeBuildings = {
  noodle_shop: ["noodle_shop"],
  market: ["fruit_stall", "supermarket"],
  room: ["rented_room"],
  warehouse: ["warehouse"],
};
const places = {
  // Main Street is everywhere outside the other zones; a new game starts on the near pavement in
  // front of the noodle shop, looking at it.
  street: {
    buildings: [],
    spawn: { pos: r3([building("noodle_shop").pos[0] + 0.3, 0.18, 3.2]), facing: [0, 0, -1] },
  },
  ...Object.fromEntries(
    Object.entries(placeBuildings).map(([p, ids]) => [
      p,
      { buildings: ids, zone: zoneFor(ids), spawn: { building: ids[0], anchor: "player_stand" } },
    ]),
  ),
};

// Where each NPC stands: its building's npc_stand anchor. Old Wang (Main Street) sits at the bus stop, as in the mock-up.
const npcBuilding = { wang: "bus_stop", cook: "noodle_shop", landlord: "rented_room", foreman: "warehouse" };
// What each NPC holds in its RightHandGrip bone (characters/ props, origin at the grip).
const npcHeldProp = { wang: "folding_fan", cook: "ladle", landlord: "key_ring", foreman: "clipboard" };
const npcs = Object.fromEntries(
  Object.entries(NPC_CHARACTER).map(([npc, character]) => [
    npc,
    { character, building: npcBuilding[npc], stand: "npc_stand", playerStand: "player_stand", heldProp: npcHeldProp[npc] },
  ]),
);

const xs = tiles.map((t) => t.pos[0]);
const layout = {
  $comment:
    "Ported from assets/street_mockup.glb (tools/blender/mockup.py) by scripts/port-mockup.mjs. glTF/three.js axes: x right, y up, +z towards the camera. Rotations in degrees about +Y (rotY) and +X (tiltX).",
  defaultPlace: "street",
  bounds: { min: [Math.min(...xs) - 4, -4.6], max: [Math.max(...xs) + 4, 4.6] },
  surfaces: { default: 0.18, bands: [{ zMin: -2, zMax: 2, y: 0.05 }] },
  player: { character: "player" },
  places,
  npcs,
  buildings,
  tiles,
  ground,
  dressing,
};
writeFileSync(join(here, "..", "src", "layout.json"), JSON.stringify(layout, null, 1) + "\n");
console.log(
  `layout.json: ${buildings.length} buildings, ${tiles.length} tiles, ${dressing.length} dressing, ${ground.length} ground boxes` +
    (skipped.length ? `; skipped (not in index.json): ${skipped.join(", ")}` : ""),
);
