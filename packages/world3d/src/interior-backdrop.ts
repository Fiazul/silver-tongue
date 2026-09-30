import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { interiorGroundMaterial } from "./interior-ground";
import { SEE_ATTR, SEE_NEVER, seeAttribute } from "./seethrough";
import type { SpaceLayout } from "./layout";

/** Small, unbatched scenery group: it never blocks walking, picking or see-through detection. */
export function buildInteriorBackdrop(
  scene: THREE.Scene,
  layout: SpaceLayout,
  real: boolean,
  flat: (colour: string) => THREE.Material,
) {
  if (!layout.interior || !layout.backdrop) return undefined;
  const spec = layout.backdrop;
  const [width, depth] = spec.size;
  const root = new THREE.Group();
  root.name = "interior_backdrop";
  scene.add(root);
  const mesh = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, mat);
    o.name = name;
    geo.setAttribute(SEE_ATTR, seeAttribute(geo, o, { tag: SEE_NEVER }, undefined, false));
    o.position.set(x, y, z);
    root.add(o);
    return o;
  };
  const box = (name: string, size: number[], pos: number[], colour: string) =>
    mesh(name, new THREE.BoxGeometry(...size as [number, number, number]), flat(colour), ...pos as [number, number, number]);
  if (spec.exteriorVisible) {
    const ground = mesh("interior_ground", new THREE.PlaneGeometry(160, 160), interiorGroundMaterial(flat(spec.ground), width, depth), 0, -0.025, 0);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = real;
  }
  // Room remains clear; the surrounding ground disappears well before its 80 m edge.
  const horizon = new THREE.Color(spec.sky.horizon);
  scene.fog = new THREE.Fog(horizon.clone(), 18, 58);
  const top = new THREE.Color(spec.sky.day);
  if (spec.exteriorVisible) {
    const skyMat = new THREE.ShaderMaterial({
      name: "interior_sky_gradient", side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: top }, horizon: { value: horizon } },
      vertexShader: `varying vec3 direction;
        void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top, horizon; varying vec3 direction;
        void main() {
          float h = smoothstep(0.0, 0.65, normalize(direction).y);
          gl_FragColor = vec4(mix(horizon, top, h), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    skyMat.userData.interiorBackdropAir = true;
    const sky = mesh("interior_sky", new THREE.SphereGeometry(180, 16, 8), skyMat, 0, 0, 0);
    sky.renderOrder = -2;
  }
  const floor = layout.surfaces.default;
  if (spec.exteriorVisible) {
    // Every silhouette's complete bounds are at least 6 m beyond the back wall, on the
    // north-west (far) side of both the fixed gameplay camera and all capture cameras.
    const facadeDepth = spec.silhouettes.find((s) => s.kind === "facade")?.size[2] ?? 2;
    for (const source of spec.silhouettes) {
      const group = new THREE.Group();
      group.name = `interior_silhouette_${source.kind}`;
      group.userData.sourceAsset = source.asset;
      group.userData.assetSize = source.size;
      const before = new Set(root.children);
      const [w, h, d] = source.size;
      const x = -width / 2 - 6 - w / 2;
      const z = -depth - 6 - d / 2 - (source.kind === "tree" ? facadeDepth + 4 : source.kind === "lantern" ? facadeDepth + 1 : 0);
      if (source.kind === "facade") {
        box("facade", [w, h - 0.2, 0.35], [x, (h - 0.2) / 2, z], "#A89A85");
        box("eaves", [w, 0.2, d], [x, h - 0.1, z], "#665D53");
        box("window", [w * 0.5, 0.9, 0.02], [x, h * 0.6, z + 0.185], "#5C727B");
      } else if (source.kind === "tree") {
        mesh("trunk", new THREE.CylinderGeometry(0.10, 0.16, h * 0.65, 5), flat("#75634D"), x, h * 0.325, z);
        const crown = mesh("crown", new THREE.IcosahedronGeometry(1, 1), flat("#71856C"), x, h * 0.7, z);
        crown.scale.set(w / 2, h * 0.3, d / 2);
      } else {
        box("lantern_post", [0.09, 2.7, 0.09], [x, 1.35, z], "#665D53");
        const lantern = mesh("lantern", new THREE.SphereGeometry(1, 8, 6), flat("#CA8858"), x, 2.7 - h / 2, z);
        lantern.scale.set(w / 2, h / 2, d / 2);
      }
      for (const child of [...root.children]) if (!before.has(child)) group.add(child);
      root.add(group);
    }
    // Two human-scale street props, clear of the slab and exit. Merge coloured parts to one draw
    // each: the texture/contact effect adds no draws, and the props add just two per colour pass.
    const prop = (name: string, x: number, z: number, parts: { geo: THREE.BufferGeometry; colour: string; at: number[] }[]) => {
      const geometries = parts.map(({ geo, colour, at }) => {
        geo.translate(at[0], at[1], at[2]);
        const c = new THREE.Color(colour), count = geo.getAttribute("position").count;
        const colours = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) colours.set([c.r, c.g, c.b], i * 3);
        geo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
        const unindexed = geo.index ? geo.toNonIndexed() : geo;
        if (unindexed !== geo) geo.dispose();
        return unindexed;
      });
      // A fresh factory colour avoids mutating any room or street material.
      const mat = flat("#FFFFFE").clone() as THREE.MeshStandardMaterial;
      mat.vertexColors = true;
      const o = mesh(name, mergeGeometries(geometries)!, mat, x, -0.025, z);
      o.userData.groundProp = true;
      for (const g of geometries) g.dispose();
    };
    prop("interior_prop_planter", width / 2 + 0.9, -depth + 0.65, [
      { geo: new THREE.CylinderGeometry(0.24, 0.17, 0.36, 8), colour: "#9B7155", at: [0, 0.18, 0] },
      { geo: new THREE.IcosahedronGeometry(0.26, 1), colour: "#698568", at: [0, 0.56, 0] },
    ]);
    prop("interior_prop_stool", -width / 2 - 0.65, 0.6, [
      { geo: new THREE.BoxGeometry(0.34, 0.07, 0.34), colour: "#977655", at: [0, 0.415, 0] },
      ...[-0.12, 0.12].flatMap((x) => [-0.12, 0.12].map((z) => ({ geo: new THREE.BoxGeometry(0.05, 0.38, 0.05), colour: "#806348", at: [x, 0.19, z] }))),
    ]);
  }
  // Authored glazing is opaque (including the grille panel). Give those panes a sky view,
  // rather than tracing the steep dollhouse camera down into the paving beyond the window.
  const dressWindows = (object: THREE.Object3D) => {
    object.updateMatrixWorld(true);
    object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      if (!materials.some((m) => m.name === "pi_glass")) return;
      const bounds = new THREE.Box3().setFromObject(o);
      if (shaft && !shaft.visible) {
        const start = bounds.getCenter(new THREE.Vector3());
        start.y = bounds.max.y;
        const end = new THREE.Vector3(0, floor + 0.02, -depth / 2);
        const direction = start.clone().sub(end);
        shaft.geometry.dispose();
        shaft.geometry = new THREE.PlaneGeometry(0.7, direction.length());
        shaft.position.copy(start).add(end).multiplyScalar(0.5);
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        shaft.visible = true;
      }
      const windowMat = new THREE.ShaderMaterial({
        name: "interior_window_sky", side: THREE.FrontSide,
        uniforms: { top: { value: top }, horizon: { value: horizon }, bottom: { value: bounds.min.y }, height: { value: Math.max(0.1, bounds.max.y - bounds.min.y) } },
        vertexShader: `varying float skyHeight; uniform float bottom, height;
          void main() { skyHeight = ((modelMatrix * vec4(position, 1.0)).y - bottom) / height;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying float skyHeight; uniform vec3 top, horizon;
          void main() { gl_FragColor = vec4(mix(horizon, top, smoothstep(0.0, 0.85, skyHeight)), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      o.material = Array.isArray(o.material) ? materials.map((m) => m.name === "pi_glass" ? windowMat : m) : windowMat;
      for (const child of o.children) if (child.userData.outline) child.visible = false;
    });
  };
  let lamp: THREE.PointLight | undefined;
  let shaft: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined;
  if (real) {
    lamp = new THREE.PointLight("#FFB66C", 3, 7, 2);
    lamp.name = "interior_lamp";
    lamp.position.set(spec.lamp[0], spec.height - 0.22, spec.lamp[2]);
    root.add(lamp);
    const mat = new THREE.ShaderMaterial({
      name: "interior_light_shaft", transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { strength: { value: 0.08 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float strength;
        void main() {
          float edge = 1.0 - smoothstep(0.15, 0.5, abs(vUv.x - 0.5));
          float fade = sin(vUv.y * 3.14159265);
          gl_FragColor = vec4(1.0, 0.78, 0.48, edge * fade * fade * strength);
        }`,
    });
    mat.userData.interiorBackdropAir = true;
    const reach = Math.min(2.6, depth * 0.7);
    const height = Math.max(0.2, spec.opening[1] - floor);
    shaft = new THREE.Mesh(new THREE.PlaneGeometry(1.6, Math.hypot(height, reach)), mat);
    shaft.name = "interior_light_shaft";
    shaft.visible = false; // only a window may supply a shaft; closed doors/open-front cuts do not
    shaft.position.set(spec.opening[0], floor + height / 2, spec.opening[2] - reach / 2);
    shaft.rotation.x = Math.atan2(reach, height);
    root.add(shaft);
  }
  const dayTop = new THREE.Color(spec.sky.day), dayHorizon = new THREE.Color(spec.sky.horizon);
  const night = new THREE.Color(spec.sky.night);
  const update = (daylight: number) => {
    const evening = THREE.MathUtils.smoothstep(daylight, 0.55, 1);
    top.copy(dayTop).lerp(night, evening);
    horizon.copy(dayHorizon).lerp(night, evening);
    (scene.background as THREE.Color).copy(horizon);
    (scene.fog as THREE.Fog).color.copy(horizon);
    if (lamp) lamp.intensity = 2 + evening * 12;
    if (shaft) shaft.material.uniforms.strength.value = 0.075 * (1 - evening);
    return evening;
  };
  update(1 / 3);
  return { root, update, top, horizon, dressWindows };
}
