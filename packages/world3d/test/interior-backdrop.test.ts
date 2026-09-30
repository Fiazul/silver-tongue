import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { interiorPaving, interiorGroundMaterial } from "../src/interior-ground";
import { buildInteriorBackdrop } from "../src/interior-backdrop";
import { LAYOUT, LayoutIndex, STREET } from "../src/layout";
import { AssetCache, SceneSpace } from "../src/world";
import { ASSETS, assetIndex, readGlb } from "./helpers";

const flat = (color: string) => new THREE.MeshLambertMaterial({ color });
/** Upper bound for a colour pass, with every backdrop mesh visible (no frustum culling). */
function cost(root: THREE.Object3D, ao = false) {
  let calls = 0, triangles = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (ao && o.material.userData.interiorBackdropAir) return;
    calls++;
    triangles += (o.geometry.index?.count ?? o.geometry.getAttribute("position").count) / 3;
  });
  return { calls, triangles };
}

describe("shared interior backdrop", () => {
  const L = new LayoutIndex(LAYOUT, assetIndex!);
  const ids = Object.keys(LAYOUT.interiors).filter((id) => L.space(id).interior);
  it("covers all five rooms and leaves the street untouched", () => {
    expect(ids.sort()).toEqual(["noodle_shop", "room", "shop", "stairs", "tea_house"]);
    const scene = new THREE.Scene();
    expect(buildInteriorBackdrop(scene, L.space(STREET), true, flat)).toBeUndefined();
    expect(scene.children).toHaveLength(0);
    expect(scene.fog).toBeNull();
  });
  it("uses one repeating <=256² texture and contact shading without extra geometry", () => {
    const map = interiorPaving();
    expect(map).toBe(interiorPaving());
    expect((map.image as { width: number }).width).toBeLessThanOrEqual(256);
    expect((map.image as { height: number }).height).toBeLessThanOrEqual(256);
    expect(map.wrapS).toBe(THREE.RepeatWrapping);
    expect(map.repeat.x).toBeGreaterThan(1);
    const material = interiorGroundMaterial(flat("#ffffff"), 6, 5);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.toon.vertexShader, fragmentShader: THREE.ShaderLib.toon.fragmentShader };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("exp(-length(outside) * 4.5)");
    expect(shader.uniforms).toHaveProperty("interiorFootprint");
  });
  it("room shell and grille glazing show the daylight sky instead of opaque ground-coloured glass", async () => {
    const space = await SceneSpace.create(L, new AssetCache(ASSETS, L, { read: readGlb }), "room");
    const panes: THREE.ShaderMaterial[] = [];
    space.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.outline) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        expect(mat.name).not.toBe("pi_glass");
        if (mat.name === "interior_window_sky") panes.push(mat as THREE.ShaderMaterial);
      }
    });
    expect(panes.length).toBeGreaterThanOrEqual(2);
    space.setDaylight(1 / 3);
    expect(panes[0].uniforms.top.value.getHexString()).toBe("9cbbd0");
    space.setDaylight(1);
    expect(panes[0].uniforms.top.value.getHexString()).toBe("152942");
  });
  for (const id of ids) {
    it(`${id}: the actual scene builds ground and caps for every omitted wall`, async () => {
      const space = await SceneSpace.create(L, new AssetCache(ASSETS, L, { read: readGlb }), id);
      const root = space.scene.getObjectByName("interior_backdrop")!;
      expect(root).toBeDefined();
      const ground = root.getObjectByName("interior_ground") as THREE.Mesh<THREE.PlaneGeometry>;
      expect(ground.geometry.parameters.width).toBeGreaterThanOrEqual(40);
      expect(ground.position.y).toBeLessThan(0);
      expect((space.scene.fog as THREE.Fog).far).toBeLessThan(ground.geometry.parameters.width / 2);
      for (const side of L.space(id).backdrop!.cutSides) expect(root.getObjectByName(`interior_cut_${side}`)).toBeDefined();
      expect(root.children.filter((o) => o.name.startsWith("interior_silhouette_"))).toHaveLength(3);
      expect(root.getObjectByName("interior_lamp")).toBeUndefined();
      expect(root.getObjectByName("interior_light_shaft")).toBeUndefined();
      expect(space.scene.userData.lookSky).toBeUndefined();
      root.traverse((o) => expect(o.castShadow || o.receiveShadow).toBe(false));
      const budget = cost(root);
      expect(budget.calls).toBeLessThanOrEqual(30);
      expect(budget.triangles).toBeLessThanOrEqual(30000);
    });
    it(`${id}: every silhouette is beyond the shell and camera target; props stay outside the slab`, () => {
      const layout = L.space(id), [w, d] = layout.backdrop!.size;
      const scene = new THREE.Scene(); scene.background = new THREE.Color();
      const { root } = buildInteriorBackdrop(scene, layout, false, flat)!;
      root.updateMatrixWorld(true);
      const target = new THREE.Vector3(0, 0.8, -d / 2);
      const poses = [new THREE.Vector3(9, 7, 10), new THREE.Vector3(6, 5, 7), ...[32, 42].map((e) => {
        const elevation = THREE.MathUtils.degToRad(e), azimuth = THREE.MathUtils.degToRad(36);
        return target.clone().add(new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)).multiplyScalar(10));
      })];
      for (const object of root.children.filter((o) => o.name.startsWith("interior_silhouette_"))) {
        const bounds = new THREE.Box3().setFromObject(object);
        expect(bounds.max.z, object.name).toBeLessThanOrEqual(-d - 6 + 1e-6);
        expect(bounds.max.x, object.name).toBeLessThanOrEqual(-w / 2 - 6 + 1e-6);
        const source = object.userData.assetSize;
        const actual = bounds.getSize(new THREE.Vector3());
        expect(actual.x).toBeLessThanOrEqual(source[0] + 1e-5);
        expect(actual.z).toBeLessThanOrEqual(source[2] + 1e-5);
        if (!object.name.endsWith("lantern")) expect(actual.y).toBeLessThanOrEqual(source[1] + 1e-5);
        for (const eye of poses) {
          const camera = new THREE.PerspectiveCamera(27, 16 / 9, 0.5, 2500);
          camera.position.copy(eye); camera.lookAt(target); camera.updateMatrixWorld(true);
          const forward = target.clone().sub(eye).normalize();
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z);
            expect(corner.clone().sub(target).dot(forward), object.name).toBeGreaterThan(0);
            expect(corner.project(camera).y, `${object.name}: outside bottom third`).toBeGreaterThan(-1 / 3);
          }
        }
      }
      const props = root.children.filter((o) => o.userData.groundProp);
      expect(props).toHaveLength(2);
      for (const object of props) {
        const b = new THREE.Box3().setFromObject(object);
        expect(b.max.x < -w / 2 || b.min.x > w / 2 || b.max.z < -d || b.min.z > 0).toBe(true);
        expect(b.getSize(new THREE.Vector3()).length()).toBeLessThan(1.2);
      }
    });
    for (const tier of ["classic", "full", "lite"]) {
      it(`${id} ${tier}: bounded geometry, day/night lighting, layout palette`, () => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color();
        const backdrop = buildInteriorBackdrop(scene, L.space(id), tier !== "classic", flat)!;
        const budget = cost(backdrop.root);
        console.log(`${id} ${tier}: ${budget.calls} calls / ${budget.triangles} triangles (colour pass upper bound)`);
        expect(budget.calls).toBeLessThanOrEqual(30);
        expect(budget.triangles).toBeLessThanOrEqual(30000);
        if (tier !== "classic") {
          const normal = cost(backdrop.root, true);
          expect(normal.calls).toBe(13);
          expect(budget.calls + normal.calls).toBeLessThanOrEqual(30);
          expect(budget.triangles + normal.triangles).toBeLessThanOrEqual(30000);
        }
        backdrop.update(1 / 3);
        expect(backdrop.top.equals(new THREE.Color(L.space(id).backdrop!.sky.day))).toBe(true);
        const lamp = backdrop.root.getObjectByName("interior_lamp") as THREE.PointLight | undefined;
        const dayIntensity = lamp?.intensity;
        backdrop.update(1);
        expect(backdrop.top.getHexString()).toBe(new THREE.Color(L.space(id).backdrop!.sky.night).getHexString());
        expect((scene.fog as THREE.Fog).color.equals(backdrop.horizon)).toBe(true);
        if (tier !== "classic") {
          expect(lamp!.intensity).toBeGreaterThan(dayIntensity!);
          expect(lamp!.castShadow).toBe(false);
          const shaft = backdrop.root.getObjectByName("interior_light_shaft") as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
          expect(shaft.material.uniforms.strength.value).toBe(0);
          const top = new THREE.Vector3(0, shaft.geometry.parameters.height / 2, 0);
          shaft.localToWorld(top);
          expect(top.y).toBeCloseTo(L.space(id).backdrop!.opening[1]);
          expect(top.z).toBeCloseTo(L.space(id).backdrop!.opening[2]);
        } else expect(lamp).toBeUndefined();
      });
    }
  }
});
