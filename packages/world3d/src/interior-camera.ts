import * as THREE from "three";
import type { InteriorView } from "./layout";

const PITCH = THREE.MathUtils.degToRad(38);
const SIN = Math.sin(PITCH), COS = Math.cos(PITCH), DIAGONAL = Math.SQRT1_2;
const FORWARD = new THREE.Vector3(-COS * DIAGONAL, -SIN, -COS * DIAGONAL);
const RIGHT = new THREE.Vector3(DIAGONAL, 0, -DIAGONAL);
const UP = new THREE.Vector3(-SIN * DIAGONAL, COS, -SIN * DIAGONAL);
const MARGIN = 0.22; // inside the authored wall thickness, not the walking bounds / exit trigger

/** Solve the bottom-ray footprint first, then constrain follow motion to that valid eye region.
 * All rays face the two far walls; portrait increases vertical FOV without revealing near walls.
 * The camera stays below the ceiling and the near plane cannot clip an enclosure surface.
 */
export function applyInteriorCamera(camera: THREE.PerspectiveCamera, room: InteriorView, focus: THREE.Vector3) {
  const aspect = Math.max(0.1, camera.aspect);
  const tangent = 0.94 * COS / (aspect + SIN);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tangent));
  camera.near = 0.04;
  if (camera.view) camera.clearViewOffset(); // scene UI lifting must not break the enclosure clamp
  const offsets = [-1, 1].map((x) => {
    const ray = FORWARD.clone().addScaledVector(RIGHT, x * tangent * aspect).addScaledVector(UP, -tangent);
    return new THREE.Vector2(-ray.x / ray.y, -ray.z / ray.y); // floor hit relative to an eye 1 m high
  });
  const minX = Math.min(...offsets.map((p) => p.x));
  const maxX = Math.max(...offsets.map((p) => p.x));
  const minZ = Math.min(...offsets.map((p) => p.y));
  const maxZ = Math.max(...offsets.map((p) => p.y));
  const { min, max } = room.bounds;
  const height = Math.min(room.ceiling - room.floor - 0.16,
    (max[0] - min[0] - 2 * MARGIN) / -minX,
    (max[1] - min[1] - 2 * MARGIN) / -minZ);
  const clampEye = (value: number, lo: number, hi: number, a: number, b: number) =>
    THREE.MathUtils.clamp(value, Math.max(lo + MARGIN, lo + MARGIN - a * height), Math.min(hi - MARGIN, hi - MARGIN - b * height));
  const followOffset = Math.max(0.2, height - 1.05) / Math.tan(PITCH) * DIAGONAL;
  camera.position.set(
    clampEye(focus.x + followOffset, min[0], max[0], minX, maxX),
    room.floor + height,
    clampEye(focus.z + followOffset, min[1], max[1], minZ, maxZ),
  );
  camera.lookAt(camera.position.clone().add(FORWARD));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
