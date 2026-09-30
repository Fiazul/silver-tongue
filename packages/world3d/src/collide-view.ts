// `?collide=1`: every collider's outline drawn on the ground (world-space lines, always on top), so
// where walking stops can be checked against what is drawn. Geometry colliders red, the town's
// authored rects kept for a piece with no footprint orange, NPC stands blue; a faint line where the
// player's centre stops (the outline grown by the player's radius).
import * as THREE from "three";
import { shapeOf, type P2 } from "./collision";
import type { Blocker } from "./layout";
import { PLAYER_RADIUS } from "./movement";

export const COLLIDE_VIEW = typeof location !== "undefined" && new URLSearchParams(location.search).get("collide") === "1";

const COLOURS = { geometry: 0xff2050, authored: 0xff9a1a, npc: 0x2a8cff } as const;

/** The outline of a blocker, grown by `grow` m, as a closed ring of points. */
export function outline(b: Blocker, grow = 0): P2[] {
  const s = shapeOf(b);
  const ring = (c: P2, r: number, n = 28): P2[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2) * r, c[1] + Math.sin((i / n) * Math.PI * 2) * r]);
  if (s.kind === "circle") return ring(s.c, s.r + grow);
  if (grow <= 0) return s.pts;
  // the rounded offset: each corner's arc between its edges' normals
  const out: P2[] = [];
  const p = s.pts;
  for (let i = 0; i < p.length; i++) {
    const a = p[(i + p.length - 1) % p.length];
    const b0 = p[i];
    const c = p[(i + 1) % p.length];
    const n1 = Math.atan2(-(b0[0] - a[0]), b0[1] - a[1]);
    let n2 = Math.atan2(-(c[0] - b0[0]), c[1] - b0[1]);
    while (n2 < n1) n2 += Math.PI * 2;
    const steps = Math.max(1, Math.ceil((n2 - n1) / 0.35));
    for (let k = 0; k <= steps; k++) {
      const t = n1 + ((n2 - n1) * k) / steps;
      out.push([b0[0] + Math.cos(t) * grow, b0[1] + Math.sin(t) * grow]);
    }
  }
  return out;
}

/** One LineSegments per colour: the outlines 3 cm over the walking height under them. */
export function colliderLines(blockers: readonly Blocker[], heightAt: (x: number, z: number) => number): THREE.Group {
  const root = new THREE.Group();
  root.name = "collide_view";
  const lines = new Map<string, number[]>();
  const add = (key: string, ring: P2[]) => {
    let a = lines.get(key);
    if (!a) lines.set(key, (a = []));
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      a.push(p[0], heightAt(p[0], p[1]) + 0.03, p[1], q[0], heightAt(q[0], q[1]) + 0.03, q[1]);
    }
  };
  for (const b of blockers) {
    const src = b.source ?? "authored";
    add(src, outline(b));
    add(`${src}:grown`, outline(b, PLAYER_RADIUS));
  }
  for (const [key, a] of lines) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
    const [src, grown] = key.split(":");
    const mat = new THREE.LineBasicMaterial({ color: COLOURS[src as keyof typeof COLOURS] ?? 0xffffff, depthTest: false, transparent: true, opacity: grown ? 0.35 : 1, fog: false });
    const seg = new THREE.LineSegments(geo, mat);
    seg.name = `collide_view:${key}`;
    seg.renderOrder = 10;
    seg.frustumCulled = false;
    root.add(seg);
  }
  return root;
}
