// Collision fidelity (src/collision.ts): what stops walking is what is drawn, in every space.
// - pure: shapes, push-out, sliding along walls and round corners;
// - from the real GLBs: every piece's colliders against its real footprint (within COLLIDE.tol),
//   every hotspot reachable from where the player arrives, a slide along every surface without
//   snagging, doorway widths as drawn, "Take me there" paths clear of every collider.
// COLLISION_AUDIT=1 also writes shots/collision/audit.md (before: the authored rects and index
// sizes; after: the derivation) for every piece in every space.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockerIndex, COLLIDE, mismatch, overlapping, overlaps, pushOut, sdShape, shapeBlocker, shapeOf, authoredOwner, type Mismatch, type P2 } from "../src/collision";
import { LAYOUT, LayoutIndex, STREET, type Blocker, type Box2 } from "../src/layout";
import { blocked, PLAYER_RADIUS, step } from "../src/movement";
import { ZONE_MARGIN } from "../src/spaces";
import { findPath } from "../src/wayfind";
import { spaceGrid } from "../src/wayview";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, readGlb } from "./helpers";

const R = PLAYER_RADIUS;
const box = (x0: number, z0: number, x1: number, z1: number, owner = "b"): Blocker => shapeBlocker({ kind: "poly", pts: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] }, owner, "geometry");
const BIG: Box2 = { min: [-50, -50], max: [50, 50] };

describe("collision shapes and the resolver (pure)", () => {
  it("signed distance: circle and polygon, inside negative, outward normals", () => {
    const c = sdShape({ kind: "circle", c: [0, 0], r: 1 }, 2, 0);
    expect(c.d).toBeCloseTo(1);
    expect(c.nx).toBeCloseTo(1);
    const b = shapeOf(box(0, 0, 2, 1));
    expect(sdShape(b, 1, 0.5).d).toBeCloseTo(-0.5);
    expect(sdShape(b, 3, 0.5).d).toBeCloseTo(1);
    const corner = sdShape(b, 3, 2);
    expect(corner.d).toBeCloseTo(Math.SQRT2);
    expect(corner.nx).toBeCloseTo(Math.SQRT1_2);
  });

  it("an authored oriented rect keeps its exact turned shape", () => {
    const obb = { id: "x:body", centre: [0, 0] as P2, half: [2, 0.5] as P2, rotY: 30 };
    const b: Blocker = { min: [-3, -3], max: [3, 3], obb };
    // the rect's long axis in world: (cos30, -sin30) (anchorToWorld's turn)
    const a = (30 * Math.PI) / 180;
    expect(sdShape(shapeOf(b), 1.9 * Math.cos(a), -1.9 * Math.sin(a)).d).toBeLessThan(0);
    expect(sdShape(shapeOf(b), 1.9 * Math.cos(a), 1.9 * Math.sin(a)).d).toBeGreaterThan(0);
    expect(authoredOwner(b)).toBe("x");
  });

  it("push-out: a disc overlapping a box ends touching it; a concave corner of two boxes settles", () => {
    const p = pushOut(1, 1.1, [box(0, 0, 2, 1)], R)!;
    expect(p[1]).toBeCloseTo(1 + R, 4);
    const q = pushOut(0.1, 0.1, [box(-2, -1, 2, 0), box(-1, -2, 0, 2)], R)!;
    expect(q[0]).toBeGreaterThanOrEqual(R - 1e-6);
    expect(q[1]).toBeGreaterThanOrEqual(R - 1e-6);
  });

  it("walking diagonally into a wall slides along it (monotonic, full tangential share); into a corner: stops, no jitter", () => {
    const wall = [box(-10, 0, 10, 0.2), box(10, 0, 30, 0.2)]; // two pieces meeting at a seam
    let [x, z] = [-5, -R - 0.001];
    const dir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]; // 30° into the wall
    let last = x;
    for (let i = 0; i < 700; i++) {
      [x, z] = step(x, z, dir[0], dir[1], 0.05, wall, BIG);
      expect(x).toBeGreaterThan(last);
      expect(overlaps(x, z, wall, R)).toBe(false);
      last = x;
    }
    expect(x).toBeGreaterThan(20); // past the seam at x = 10
    const corner = [box(-10, 0, 10, 0.2), box(10, -10, 10.2, 0.2)];
    let p: P2 = [9, -1];
    for (let i = 0; i < 100; i++) p = step(p[0], p[1], Math.SQRT1_2, Math.SQRT1_2, 0.05, corner, BIG);
    const settled = p;
    p = step(p[0], p[1], Math.SQRT1_2, Math.SQRT1_2, 0.05, corner, BIG);
    expect(Math.hypot(p[0] - settled[0], p[1] - settled[1])).toBeLessThan(1e-4);
    expect(settled[0]).toBeCloseTo(10 - R, 3);
    expect(settled[1]).toBeCloseTo(-R, 3);
  });

  it("rounds a convex corner smoothly (no catch where two faces meet)", () => {
    const b = [box(0, 0, 2, 2)];
    let [x, z] = [-R - 0.001, 0.5];
    const [ux, uz] = [0.3 / Math.hypot(0.3, 1), 1 / Math.hypot(0.3, 1)];
    for (let i = 0; i < 200; i++) [x, z] = step(x, z, ux, uz, 0.05, b, BIG);
    expect(z).toBeGreaterThan(2 + 3); // went up the left face and on past the corner
  });

  it("a long move never passes through a thin collider (short sub-moves)", () => {
    const pole = [shapeBlocker({ kind: "circle", c: [0, 0], r: 0.04 }, "pole", "geometry")];
    const [x] = step(-1, 0, 1, 0, 2, pole, BIG);
    expect(x).toBeLessThan(-R - 0.04 + 1e-3);
  });
});

// ---------------------------------------------------------------------------------------------

const L = assetIndex ? new LayoutIndex(LAYOUT, assetIndex) : undefined;
let built: Promise<Map<string, SceneSpace>> | undefined;
const buildAll = () =>
  (built ??= (async () => {
    const assets = new AssetCache(ASSETS, L!, { read: readGlb });
    const out = new Map<string, SceneSpace>();
    for (const id of L!.spaceIds()) out.set(id, await SceneSpace.create(L!, assets, id));
    return out;
  })());

/** Where the player arrives in a space: the town's default spawn, an interior's entry (pushed clear as player.ts place does). */
const arrival = (id: string, sp: SceneSpace): P2 => {
  const p = id === STREET ? L!.spawn(LAYOUT.defaultPlace).pos : L!.entrySpawn(id).pos;
  return pushOut(p[0], p[2], sp.blockers, R) ?? [p[0], p[2]];
};

/** The hotspots of a space: talk stands, a spot deep in each trigger, things to use. */
function hotspots(sp: SceneSpace): { name: string; ok: (x: number, z: number) => boolean; at: P2 }[] {
  const out: { name: string; ok: (x: number, z: number) => boolean; at: P2 }[] = [];
  for (const n of sp.layout.npcs) {
    const p = L!.talkStand(n).pos;
    out.push({ name: `talk ${n}`, at: [p[0], p[2]], ok: (x, z) => Math.hypot(x - p[0], z - p[2]) < 0.3 });
  }
  for (const t of sp.layout.triggers) {
    const b = t.box;
    out.push({
      name: `${t.kind} ${t.place}`,
      at: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2],
      ok: (x, z) => x > b.min[0] + ZONE_MARGIN && x < b.max[0] - ZONE_MARGIN && z > b.min[1] + ZONE_MARGIN && z < b.max[1] - ZONE_MARGIN,
    });
  }
  for (const x of sp.layout.interactables) out.push({ name: `use ${x.kind}`, at: [x.pos[0], x.pos[2]], ok: (a, b) => Math.hypot(a - x.pos[0], b - x.pos[2]) < x.range - 0.1 });
  return out;
}

/** Where the player can get to from `from` (a 0.1 m flood over the cells a disc of R stands on). */
function reach(sp: SceneSpace, from: P2, cell = 0.1) {
  const index = new BlockerIndex(sp.blockers);
  const { bounds } = sp.layout;
  const walk = sp.area.walkable;
  const free = (x: number, z: number) => !blocked(x, z, index.near(x, z, R), bounds, R, walk);
  const cols = Math.ceil((bounds.max[0] - bounds.min[0]) / cell);
  const rows = Math.ceil((bounds.max[1] - bounds.min[1]) / cell);
  const seen = new Uint8Array(cols * rows); // 1 reached, 2 blocked
  const at = (i: number, j: number): P2 => [bounds.min[0] + (i + 0.5) * cell, bounds.min[1] + (j + 0.5) * cell];
  const i0 = Math.floor((from[0] - bounds.min[0]) / cell);
  const j0 = Math.floor((from[1] - bounds.min[1]) / cell);
  const queue = [j0 * cols + i0];
  seen[queue[0]] = 1;
  const reached: number[] = [];
  while (queue.length) {
    const k = queue.pop()!;
    reached.push(k);
    const i = k % cols;
    const j = (k - i) / cols;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const n = nj * cols + ni;
      if (seen[n]) continue;
      const [x, z] = at(ni, nj);
      seen[n] = free(x, z) ? 1 : 2;
      if (seen[n] === 1) queue.push(n);
    }
  }
  return reached.map((k) => at(k % cols, Math.floor(k / cols)));
}

/** What the old code blocked each piece with: the town's authored rects, an interior piece's index size. */
function before(sp: SceneSpace): Map<string, Blocker[]> {
  const out = new Map<string, Blocker[]>();
  for (const b of sp.layout.blockers) out.set(authoredOwner(b), [...(out.get(authoredOwner(b)) ?? []), b]);
  for (const p of sp.layout.pieces) {
    const b = p.block === "size" ? L!.sizeBlocker(p) : null;
    if (b) out.set(p.id, [b]);
  }
  return out;
}

interface Row extends Mismatch {
  space: string;
  owner: string;
  asset: string;
  kind: string;
}
const kindOf = (bs: readonly Blocker[]) => {
  if (!bs.length) return "none";
  const n = { circle: 0, poly: 0, rect: 0 };
  for (const b of bs) {
    if (!b.shape) n.rect++;
    else n[b.shape.kind]++;
  }
  return Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(" + ");
};

describe.skipIf(!assetIndex)("collision from the real GLBs, every space", () => {
  it("every piece's colliders match its real footprint within COLLIDE.tol (over- and under-blocking); the audit", async () => {
    const spaces = await buildAll();
    const rowsBefore: Row[] = [];
    const rowsAfter: Row[] = [];
    const bad: string[] = [];
    for (const [id, sp] of spaces) {
      const old = before(sp);
      for (const d of sp.collision) {
        const piece = sp.layout.pieces.find((p) => p.id === d.owner);
        const origin: P2 = d.footprint ? [d.footprint.frame.ox, d.footprint.frame.oz] : piece ? [piece.pos[0], piece.pos[2]] : [0, 0];
        const rot = piece?.rotY ?? 0;
        const now = sp.blockers.filter((b) => b.owner === d.owner && b.source !== "npc");
        const was = old.get(d.owner) ?? [];
        const a = mismatch(d.footprint, now, origin, rot);
        const b = mismatch(d.footprint, was, origin, rot);
        rowsAfter.push({ space: id, owner: d.owner, asset: d.asset ?? "-", kind: kindOf(now), ...a });
        rowsBefore.push({ space: id, owner: d.owner, asset: d.asset ?? "-", kind: kindOf(was), ...b });
        // derived colliders: nothing more than tol from what is drawn, nothing drawn more than tol from a collider
        if (now.every((x) => x.source === "geometry") && (a.over > 0.01 || a.under > 0.01)) bad.push(`${id} ${d.owner}: over ${a.over.toFixed(4)} m², under ${a.under.toFixed(4)} m²`);
      }
    }
    if (process.env.COLLISION_AUDIT) writeAudit(rowsBefore, rowsAfter);
    // derived colliders: nothing more than tol from what is drawn, nothing drawn more than tol from a collider (a 10 cm square of raster slack per piece)
    expect(bad).toEqual([]);
  }, 300_000);

  it("the player reaches every hotspot (talk stands, doors, the way out, things to use) from where they arrive", async () => {
    const spaces = await buildAll();
    for (const [id, sp] of spaces) {
      const cells = reach(sp, arrival(id, sp));
      expect(cells.length, `${id}: arrival cell free`).toBeGreaterThan(10);
      for (const h of hotspots(sp)) expect(cells.some(([x, z]) => h.ok(x, z)), `${id}: ${h.name} not reachable from ${arrival(id, sp)}`).toBe(true);
    }
  }, 300_000);

  it("sliding along every surface (walls, counters, benches, buildings) never snags: progress each step until something else stops it", async () => {
    const spaces = await buildAll();
    const dirIn = Math.PI / 6; // 30° into the surface
    for (const [id, sp] of spaces) {
      const { bounds } = sp.layout;
      const walk = sp.area.walkable;
      const index = new BlockerIndex(sp.blockers);
      let slides = 0;
      for (const b of sp.blockers) {
        const s = shapeOf(b);
        if (b.source !== "geometry" || s.kind !== "poly") continue;
        const p = s.pts;
        for (let e = 0; e < p.length; e++) {
          const a = p[e];
          const c = p[(e + 1) % p.length];
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (len < 0.6) continue;
          const t: P2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
          const n: P2 = [t[1], -t[0]]; // outward (counter-clockwise)
          let x = a[0] + t[0] * 0.1 + n[0] * (R + 0.002);
          let z = a[1] + t[1] * 0.1 + n[1] * (R + 0.002);
          if (blocked(x, z, index.near(x, z, R), bounds, R, walk)) continue;
          const d: P2 = [t[0] * Math.cos(dirIn) - n[0] * Math.sin(dirIn), t[1] * Math.cos(dirIn) - n[1] * Math.sin(dirIn)];
          slides++;
          let along = 0.1;
          for (let k = 0; k < 400 && along < len - 0.1; k++) {
            const [nx, nz] = step(x, z, d[0], d[1], 0.05, sp.blockers, bounds, walk);
            const gain = (nx - x) * t[0] + (nz - z) * t[1];
            if (gain < 1e-4) {
              // a stop is only fair where something else faces the player: another collider at another angle, the ground's edge, the bounds
              const others = overlapping(nx, nz, index.near(nx, nz, R + 0.06), R + 0.06).filter((o) => o !== b); // within a step
              const facing = others.some((o) => {
                const q = sdShape(shapeOf(o), nx, nz);
                return q.nx * n[0] + q.nz * n[1] < Math.cos((20 * Math.PI) / 180);
              });
              const ahead: P2 = [nx + d[0] * 0.06, nz + d[1] * 0.06];
              const edge = blocked(ahead[0], ahead[1], [], bounds, R, walk) || blocked(nx + t[0] * 0.06, nz + t[1] * 0.06, [], bounds, R, walk);
              expect(facing || edge, `${id} ${b.owner}: snagged sliding along its edge at ${nx.toFixed(2)},${nz.toFixed(2)} (${along.toFixed(2)} of ${len.toFixed(2)} m)`).toBe(true);
              break;
            }
            along += gain;
            x = nx;
            z = nz;
          }
        }
      }
      expect(slides, `${id}: surfaces slid along`).toBeGreaterThan(0);
    }
  }, 300_000);

  it("doorways keep their drawn width: each room's way out, the town gate's passage", async () => {
    const spaces = await buildAll();
    const lines: { id: string; name: string; z: number; x0: number; x1: number; at: number }[] = [];
    for (const id of L!.spaceIds()) {
      if (id === STREET) continue;
      const sp = spaces.get(id)!;
      const exit = sp.layout.triggers.find((t) => t.kind === "exit")!;
      lines.push({ id, name: "way out", z: Math.min((exit.box.min[1] + exit.box.max[1]) / 2, -0.05), x0: sp.layout.bounds.min[0] - 1, x1: sp.layout.bounds.max[0] + 1, at: arrival(id, sp)[0] });
    }
    const gate = LAYOUT.town.buildings.find((b) => b.id === "town_gate")!;
    lines.push({ id: STREET, name: "town gate", z: gate.pos[2], x0: gate.pos[0] - 5, x1: gate.pos[0] + 5, at: gate.pos[0] });
    for (const l of lines) {
      const sp = spaces.get(l.id)!;
      const drawn = (x: number) =>
        sp.collision.some((d) => {
          const f = d.footprint;
          if (!f) return false;
          const dx = x - f.frame.ox;
          const dz = l.z - f.frame.oz;
          const i = Math.floor((dx * f.frame.c - dz * f.frame.s - f.x0) / f.cell);
          const j = Math.floor((dx * f.frame.s + dz * f.frame.c - f.z0) / f.cell);
          return i >= 0 && j >= 0 && i < f.cols && j < f.rows && f.cells[j * f.cols + i] === 1;
        });
      const gap = (hit: (x: number) => boolean) => {
        let a = l.at;
        let b = l.at;
        while (a > l.x0 && !hit(a - 0.005)) a -= 0.005;
        while (b < l.x1 && !hit(b + 0.005)) b += 0.005;
        return [a, b];
      };
      const [fa, fb] = gap(drawn);
      const [ca, cb] = gap((x) => overlaps(x, l.z, sp.blockers.filter((b) => b.source !== "npc"), 1e-4));
      expect(fb - fa, `${l.id} ${l.name}: drawn opening`).toBeGreaterThan(2 * R + 0.3);
      expect(Math.abs(ca - fa), `${l.id} ${l.name}: left jamb collider ${ca.toFixed(3)} vs drawn ${fa.toFixed(3)}`).toBeLessThanOrEqual(COLLIDE.tol);
      expect(Math.abs(cb - fb), `${l.id} ${l.name}: right jamb collider ${cb.toFixed(3)} vs drawn ${fb.toFixed(3)}`).toBeLessThanOrEqual(COLLIDE.tol);
      // and the player walks straight through it
      const [x, z] = step(l.at, l.z - 0.6, 0, 1, 1.2, sp.blockers.filter((b) => b.source !== "npc"), { min: [-1e3, -1e3], max: [1e3, 1e3] });
      expect(Math.hypot(x - l.at, z - (l.z + 0.6)), `${l.id} ${l.name}: walked through`).toBeLessThan(1e-3);
    }
  }, 300_000);

  it("'Take me there' paths reach every hotspot and never run through a collider", async () => {
    const spaces = await buildAll();
    for (const [id, sp] of spaces) {
      const grid = spaceGrid(sp);
      const from = arrival(id, sp);
      const index = new BlockerIndex(sp.blockers);
      for (const h of hotspots(sp)) {
        const path = findPath(grid, from, h.at);
        expect(path, `${id}: no path to ${h.name}`).not.toBeNull();
        let worst = Infinity;
        // the last leg ends on the target itself (an NPC's stand, a door): checked up to 0.4 m short of it
        for (let k = 0; k + 1 < path!.length; k++) {
          const [a, b] = [path![k], path![k + 1]];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const stop = k + 2 === path!.length ? Math.max(0, len - 0.4) : len;
          for (let s = 0; s <= stop; s += 0.05) {
            const x = a[0] + ((b[0] - a[0]) * s) / (len || 1);
            const z = a[1] + ((b[1] - a[1]) * s) / (len || 1);
            for (const o of index.near(x, z, R)) if (o.source !== "npc") worst = Math.min(worst, sdShape(shapeOf(o), x, z).d);
          }
        }
        expect(worst, `${id}: path to ${h.name} comes ${worst.toFixed(3)} m from a collider`).toBeGreaterThan(R - 0.08);
      }
    }
  }, 300_000);

  it("street walkers' authored routes stay clear of every collider", async () => {
    const sp = (await buildAll()).get(STREET)!;
    const index = new BlockerIndex(sp.blockers);
    const bad = new Set<string>();
    for (const w of sp.layout.walkers)
      for (let k = 0; k + 1 < w.path.length; k++) {
        const [a, b] = [w.path[k], w.path[k + 1]];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 0; s <= len; s += 0.05) {
          const x = a[0] + ((b[0] - a[0]) * s) / len;
          const z = a[1] + ((b[1] - a[1]) * s) / len;
          for (const o of overlapping(x, z, index.near(x, z, 0.25), 0.25)) if (o.source !== "npc") bad.add(`${w.role} through ${o.owner}`);
        }
      }
    expect([...bad]).toEqual([]);
  }, 300_000);
});

function writeAudit(before: Row[], after: Row[]) {
  const dir = new URL("../shots/collision/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const key = (r: Row) => `${r.space}|${r.owner}`;
  const now = new Map(after.map((r) => [key(r), r]));
  const f = (v: number) => v.toFixed(2);
  const rows = before
    .filter((r) => r.footprint > 0 || r.collider > 0)
    .map((b) => ({ b, a: now.get(key(b))! }))
    .sort((x, y) => y.b.over + y.b.under - (x.b.over + x.b.under));
  const head = "| space | piece (asset) | collider before | footprint m² | before: collider m² | before: over m² | before: under m² | after: collider | after: over m² | after: under m² |\n|---|---|---|---|---|---|---|---|---|---|";
  const line = ({ b, a }: { b: Row; a: Row }) =>
    `| ${b.space} | ${b.owner} (${b.asset}) | ${b.kind} | ${f(b.footprint)} | ${f(b.collider)} | ${f(b.over)} | ${f(b.under)} | ${a.kind} | ${a.over.toFixed(3)} | ${a.under.toFixed(3)} |`;
  const sum = (rs: Row[], k: "over" | "under") => rs.reduce((s, r) => s + r[k], 0);
  const text = [
    "# Collision audit: colliders vs the drawn footprint",
    "",
    `Generated by \`COLLISION_AUDIT=1 npx vitest run packages/world3d/test/collision.test.ts\`. Footprint: each piece's triangles between ${COLLIDE.step} m and ${COLLIDE.head} m over the walking height, projected to the ground, holes filled (${COLLIDE.cell * 100} cm raster; foliage excluded). Over = collider area more than ${COLLIDE.tol * 100} cm from the footprint (an invisible wall); under = footprint more than ${COLLIDE.tol * 100} cm from any collider (walking into what is drawn). Before: the town's authored rects and the interiors' index-size boxes; after: the colliders derived from the geometry (collision.ts).`,
    "",
    `Totals, every space: before over ${f(sum(before, "over"))} m², under ${f(sum(before, "under"))} m²; after over ${f(sum(after, "over"))} m², under ${f(sum(after, "under"))} m².`,
    "",
    head,
    ...rows.map(line),
    "",
  ].join("\n");
  writeFileSync(new URL("audit.md", dir), text);
}
