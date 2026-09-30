import * as THREE from "three";
import type { SpaceLayout } from "./layout";
import { patchSeeThrough, SEE_ATTR, seeAttribute, SEE_NEVER } from "./seethrough";

/** The enclosure's reach: walls rise to TOP m above the floor and the side walls run FRONT m past
 * the open front, so a camera above the ceiling or in front of the room never sees a wall top, a
 * wall's end or the outside beside a wall (interior-camera.ts keeps its eye inside that volume). */
export const ENCLOSURE = { top: 8, front: 4 } as const;

/**
 * Close the room without caps or exterior wall thickness; every plane has only its inward face.
 * - Below the ceiling the back / left planes stand just behind the authored walls; above it (and in
 *   front of the open front, for the sides) they stand on the walls' inner faces, so they cover the
 *   walls' tops and front ends, up to ENCLOSURE.top and ENCLOSURE.front.
 * - The +x wall asset is not built (the library's is from a newer, textured batch than the vendored
 *   shells): its plane stands on the inner face, floor to top; bandWalls paints it in the left
 *   wall's bands (dado, trim, plaster) once the room's statics are in.
 * - The ceiling (single-sided, facing down) is invisible from above; the floor plane lies just under
 *   the slab; the open front's plane faces in (invisible from the camera in front of it).
 */
export function buildInteriorEnclosure(scene: THREE.Scene, layout: SpaceLayout, flat: (colour: string) => THREE.Material) {
  const view = layout.view;
  if (!layout.interior || !view) return undefined;
  const root = new THREE.Group(); root.name = "interior_enclosure";
  const [x0, z0] = view.bounds.min, [x1, z1] = view.bounds.max;
  const t = view.wall ?? 0, w = x1 - x0, d = z1 - z0, h = view.ceiling - view.floor;
  const material = (colour: string) => {
    const mat = flat(colour).clone(); mat.side = THREE.FrontSide;
    return patchSeeThrough(mat);
  };
  const wallColour = layout.ground.find((g) => g.name.endsWith("_back"))?.colour ?? "#E6DCC4";
  const walls = material(wallColour);
  const ceiling = material(layout.backdrop?.ceiling ?? "#E8DFC9");
  const floor = material(layout.ground.find((g) => g.name.endsWith("_floor"))?.colour ?? "#BEB8A6");
  const add = (name: string, width: number, height: number, mat: THREE.Material, pos: number[], rx = 0, ry = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    mesh.name = `interior_${name}`;
    mesh.userData.roomSurface = name;
    mesh.position.set(pos[0], pos[1], pos[2]); mesh.rotation.set(rx, ry, 0);
    mesh.geometry.setAttribute(SEE_ATTR, seeAttribute(mesh.geometry, mesh, { tag: SEE_NEVER }, undefined, false));
    root.add(mesh);
    return mesh;
  };
  // Below the ceiling: just behind the authored walls (BEHIND: no z-fight with a box room's wall
  // face), reaching SEAM past the floor and ceiling planes: no hairline gap along the edges.
  // They reach DOWN under the floor plane, which reaches under them: a ray grazing the corner
  // behind an authored wall still meets a surface.
  const SEAM = 0.02, BEHIND = 0.01, DOWN = 0.1, wh = h + SEAM + DOWN;
  const cy = view.floor + (h + SEAM - DOWN) / 2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  add("wall_back", w + 2 * BEHIND, wh, walls, [cx, cy, z0 - BEHIND]);
  add("wall_left", d + BEHIND, wh, walls, [x0 - BEHIND, cy, cz - BEHIND / 2], 0, Math.PI / 2);
  add("wall_front", w, h + 2 * SEAM, walls, [cx, view.floor + h / 2, z1], 0, Math.PI);
  add("ceiling", w, d, ceiling, [cx, view.ceiling, cz], Math.PI / 2);
  // Just beneath the original slab: avoids z-fighting and preserves its authored appearance.
  add("floor_inside", w + 2 * BEHIND, d + BEHIND, floor, [cx, view.floor - 0.005, cz - BEHIND / 2], -Math.PI / 2);
  // Above the walls' tops, on their inner faces, up to the enclosure's top (from 1 cm under the top).
  const top = view.floor + ENCLOSURE.top, upFrom = view.ceiling - 0.01, up = top - upFrom;
  // 5 mm in front of the inner faces: never coplanar with a box room's wall face (no z-fight)
  const zi0 = z0 + t + 0.005, xi0 = x0 + t + 0.005, xi1 = x1 - t - 0.005, zf = z1 + ENCLOSURE.front;
  add("wall_back_up", xi1 - xi0, up, walls, [(xi0 + xi1) / 2, upFrom + up / 2, zi0]);
  add("wall_left_up", zf - zi0, up, walls, [xi0, upFrom + up / 2, (zi0 + zf) / 2], 0, Math.PI / 2);
  // In front of the open front, floor height to the top (from 1 cm inside the front plane).
  const fromZ = z1 - 0.01, low = view.floor - SEAM;
  const leftFront = add("wall_left_front", zf - fromZ, upFrom - low, walls, [xi0, (low + upFrom) / 2, (fromZ + zf) / 2], 0, Math.PI / 2);
  leftFront.userData.bands = { x: xi0, za: fromZ, zb: zf, low, top: upFrom, ry: Math.PI / 2 };
  // The right wall: on the inner face, whole height, from the back wall to the enclosure's front.
  const right = add("wall_right", zf - zi0, top - low, walls, [xi1, (low + top) / 2, (zi0 + zf) / 2], 0, -Math.PI / 2);
  right.userData.bands = { x: xi1, za: zi0, zb: zf, low, top, ry: -Math.PI / 2 };
  scene.add(root);
  return root;
}

/**
 * Paint the right wall and the left wall's run in front of the room in the left wall's horizontal
 * bands: sample what the left wall shows (its first hit, looking -x from inside the room, at 2 cm
 * steps up the wall and 25 depths; the most common colour per height), merge runs into bands,
 * one strip each; the top band continues to the top, and the walls' upward extensions take its
 * colour. Call once the room's statics are placed (before static batching).
 */
export function bandWalls(root: THREE.Object3D | undefined, layout: SpaceLayout, statics: THREE.Object3D[], flat: (colour: string) => THREE.Material) {
  const view = layout.view;
  if (!view || !root) return;
  const [x0, z0] = view.bounds.min, [, z1] = view.bounds.max, t = view.wall ?? 0;
  // the wall itself: the shell (userData.shell, world.ts) or a box room's "<room>_left" box, never
  // the furniture or pictures on it
  const walls = statics.filter((o) => o.userData.shell || o.name.endsWith("_left"));
  if (!walls.length) return;
  for (const o of walls) o.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), step = 0.02, DEPTHS = 25;
  const colourAt = (y: number) => {
    const votes = new Map<string, number>();
    for (let k = 1; k <= DEPTHS; k++) {
      const z = z0 + t + ((z1 - z0 - t) * k) / (DEPTHS + 1);
      ray.set(new THREE.Vector3(x0 + t + 0.4, y, z), new THREE.Vector3(-1, 0, 0));
      ray.far = 0.6;
      const hit = ray.intersectObjects(walls, true).find((h) => (h.object as THREE.Mesh).isMesh && !h.object.userData.outline);
      const mat = hit && ((hit.object as THREE.Mesh).material as THREE.Material & { color?: THREE.Color });
      if (mat && !Array.isArray(mat) && mat.color) { const c = `#${mat.color.getHexString()}`; votes.set(c, (votes.get(c) ?? 0) + 1); }
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const bands: { from: number; to: number; colour: string }[] = [];
  for (let y = view.floor + step / 2; y < view.ceiling; y += step) {
    const c = colourAt(y);
    if (!c) continue;
    const last = bands[bands.length - 1];
    if (last && last.colour === c) last.to = y + step / 2;
    else bands.push({ from: y - step / 2, to: y + step / 2, colour: c });
  }
  if (!bands.length) return; // nothing sampled: the plain planes stay
  for (let i = 1; i < bands.length; i++) bands[i].from = bands[i - 1].to; // no gaps between strips
  const materials = new Map<string, THREE.Material>();
  const material = (colour: string) => {
    let m = materials.get(colour);
    if (!m) { m = flat(colour).clone(); m.side = THREE.FrontSide; patchSeeThrough(m); materials.set(colour, m); }
    return m;
  };
  const topColour = bands[bands.length - 1].colour;
  for (const name of ["interior_wall_back_up", "interior_wall_left_up"]) {
    const m = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (m) m.material = material(topColour);
  }
  for (const name of ["interior_wall_right", "interior_wall_left_front"]) {
    const plane = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (!plane) continue;
    const p = plane.userData.bands as { x: number; za: number; zb: number; low: number; top: number; ry: number };
    bands.forEach((b, i) => {
      const from = i === 0 ? p.low : Math.max(p.low, b.from), to = i === bands.length - 1 ? p.top : Math.min(p.top, b.to);
      if (to <= from) return;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.zb - p.za, to - from), material(b.colour));
      mesh.name = `${name}_${i}`;
      mesh.userData.roomSurface = plane.userData.roomSurface;
      mesh.position.set(p.x, (from + to) / 2, (p.za + p.zb) / 2); mesh.rotation.set(0, p.ry, 0);
      mesh.geometry.setAttribute(SEE_ATTR, seeAttribute(mesh.geometry, mesh, { tag: SEE_NEVER }, undefined, false));
      root.add(mesh);
    });
    plane.removeFromParent();
    plane.geometry.dispose();
  }
}

/** One front-side twin per source material, shared by every shell mesh: keeps static batching intact. */
const FRONT = new WeakMap<THREE.Material, THREE.Material>();

/** Materials on an instance only: street templates and furniture remain unchanged. */
export function interiorFaces(object: THREE.Object3D) {
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.userData.outline) { o.visible = false; return; }
    const single = (source: THREE.Material) => {
      if (source.side === THREE.FrontSide) return source;
      let mat = FRONT.get(source);
      if (!mat) {
        mat = source.clone(); mat.side = THREE.FrontSide;
        FRONT.set(source, patchSeeThrough(mat));
      }
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(single) : single(o.material);
  });
}
