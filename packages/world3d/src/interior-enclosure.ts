import * as THREE from "three";
import type { SpaceLayout } from "./layout";
import { patchSeeThrough, SEE_ATTR, seeAttribute, SEE_NEVER } from "./seethrough";

/** Close the room behind its authored surfaces, never add caps or exterior wall thickness.
 * Each plane has only its inward face. The omitted near-wall assets remain omitted; their
 * enclosure faces are behind the fixed interior camera and automatically culled from outside.
 */
export function buildInteriorEnclosure(scene: THREE.Scene, layout: SpaceLayout, flat: (colour: string) => THREE.Material) {
  const view = layout.view;
  if (!layout.interior || !view) return undefined;
  const root = new THREE.Group(); root.name = "interior_enclosure";
  const [x0, z0] = view.bounds.min, [x1, z1] = view.bounds.max;
  const w = x1 - x0, d = z1 - z0, h = view.ceiling - view.floor;
  const material = (colour: string) => {
    const mat = flat(colour).clone(); mat.side = THREE.FrontSide;
    return patchSeeThrough(mat);
  };
  const walls = material(layout.ground.find((g) => g.name.endsWith("_back"))?.colour ?? "#E6DCC4");
  const ceiling = material(layout.backdrop?.ceiling ?? "#E8DFC9");
  const floor = material(layout.ground.find((g) => g.name.endsWith("_floor"))?.colour ?? "#BEB8A6");
  const add = (name: string, width: number, height: number, mat: THREE.Material, pos: number[], rx = 0, ry = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    mesh.name = `interior_${name}`;
    mesh.userData.roomSurface = name;
    mesh.position.set(pos[0], pos[1], pos[2]); mesh.rotation.set(rx, ry, 0);
    mesh.geometry.setAttribute(SEE_ATTR, seeAttribute(mesh.geometry, mesh, { tag: SEE_NEVER }, undefined, false));
    root.add(mesh);
  };
  const cy = view.floor + h / 2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  add("wall_back", w, h, walls, [cx, cy, z0]);
  add("wall_left", d, h, walls, [x0, cy, cz], 0, Math.PI / 2);
  add("wall_front", w, h, walls, [cx, cy, z1], 0, Math.PI);
  add("wall_right", d, h, walls, [x1, cy, cz], 0, -Math.PI / 2);
  add("ceiling", w, d, ceiling, [cx, view.ceiling, cz], Math.PI / 2);
  // Just beneath the original slab: avoids z-fighting and preserves its authored appearance.
  add("floor_inside", w, d, floor, [cx, view.floor - 0.005, cz], -Math.PI / 2);
  scene.add(root);
  return root;
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
