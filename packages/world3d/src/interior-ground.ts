import * as THREE from "three";
import { patchSeeThrough } from "./seethrough";

let paving: THREE.Texture | undefined;
/** One deterministic 128² canvas tile shared by interiors; DataTexture fallback for DOM-free tests. */
export function interiorPaving(): THREE.Texture {
  if (paving) return paving;
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / 32);
    const mortar = y % 32 < 1 || (x + (row % 2) * 32) % 64 < 1;
    const noise = ((x * 37 + y * 71 + x * y * 13) % 17) - 8;
    const shade = (mortar ? 214 : 245) + noise * 0.45;
    const i = (y * size + x) * 4;
    pixels.set([shade, shade, shade, 255], i);
  }
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : undefined;
  const ctx = canvas?.getContext?.("2d");
  if (canvas && ctx) {
    canvas.width = canvas.height = size;
    const data = ctx.createImageData(size, size);
    data.data.set(pixels);
    ctx.putImageData(data, 0, 0);
    paving = new THREE.CanvasTexture(canvas);
  } else paving = new THREE.DataTexture(pixels, size, size);
  paving.name = "interior_paving_128";
  paving.wrapS = paving.wrapT = THREE.RepeatWrapping;
  paving.repeat.set(100, 100); // 1.6 m tiles on a 160 m plane; each paving block is 0.8 x 0.4 m.
  paving.colorSpace = THREE.SRGBColorSpace;
  paving.magFilter = THREE.LinearFilter;
  paving.minFilter = THREE.LinearMipmapLinearFilter;
  paving.generateMipmaps = true;
  paving.needsUpdate = true;
  return paving;
}

/** Texture and contact darkening share the ground's existing draw; no decal or extra shadow pass. */
export function interiorGroundMaterial(base: THREE.Material, width: number, depth: number): THREE.Material {
  const material = base.clone() as THREE.MeshStandardMaterial;
  material.name = "interior_textured_ground";
  material.map = interiorPaving();
  // clone() does not copy onBeforeCompile: reinstall the shared never-fade shader patch.
  patchSeeThrough(material);
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.interiorFootprint = { value: new THREE.Vector2(width / 2, depth) };
    shader.vertexShader = `varying vec2 interiorGroundXZ;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>", "#include <begin_vertex>\ninteriorGroundXZ = (modelMatrix * vec4(position, 1.0)).xz;");
    shader.fragmentShader = `varying vec2 interiorGroundXZ; uniform vec2 interiorFootprint;\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>", `#include <map_fragment>
      vec2 outside = max(abs(interiorGroundXZ + vec2(0.0, interiorFootprint.y * 0.5)) - vec2(interiorFootprint.x, interiorFootprint.y * 0.5), 0.0);
      diffuseColor.rgb *= 1.0 - 0.25 * exp(-length(outside) * 4.5);`);
  };
  material.customProgramCacheKey = () => "interior-ground-contact-v1";
  return material;
}
