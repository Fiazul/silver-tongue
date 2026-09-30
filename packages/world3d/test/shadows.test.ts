// The sun shadow while walking (README "Shadows", src/shadows.ts): the box's centre on whole
// texels in the light's frame (a static point lands on the same texel position after any step),
// sub-texel moves not moving it, the bias in world units within bounds, the edge fade continuous,
// the two-layer draw (the static layer only when due, the animated casters every frame one moves),
// and the grass bands' fades soft (no hard band following the camera).
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { GRASS, grassBands } from "../src/envlook";
import { BUDGETS, REAL_SHADOW, SHADOW_CELL } from "../src/look";
import { lightBasis, patchShadowEdge, SHADOW_DEPTH_BIAS_M, SHADOW_EDGE, shadowBias, shadowEdgeFade, shadowTexel, snapShadowBox, SunShadow } from "../src/shadows";

/** the town's sun at midday and low at evening (azimuth 150 degrees, as town.json) */
const SUNS = [new THREE.Vector3(Math.sin(2.6), Math.tan(0.9), Math.cos(2.6)).normalize(), new THREE.Vector3(Math.sin(2.6), Math.tan(0.2), Math.cos(2.6)).normalize()];
const SIZES = [BUDGETS.full.shadowSize, BUDGETS.lite.shadowSize];

/** a world point's position in the shadow map, in texels, for a box on `target` (the shadow camera three builds: at target + dir * distance, looking at target) */
function texelOf(w: THREE.Vector3, target: THREE.Vector3, dir: THREE.Vector3, mapSize: number) {
  const h = REAL_SHADOW.half;
  const cam = new THREE.OrthographicCamera(-h, h, h, -h, 1, REAL_SHADOW.distance * 2);
  cam.position.copy(target).addScaledVector(dir, REAL_SHADOW.distance);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const v = w.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
  return [((v.x + 1) / 2) * mapSize, ((v.y + 1) / 2) * mapSize];
}
const frac = (x: number) => x - Math.floor(x);

describe("texel snapping (snapShadowBox)", () => {
  it("lightBasis is the shadow camera's own frame (Matrix4.lookAt, up +y)", () => {
    for (const dir of SUNS) {
      const { x, y, z } = lightBasis(dir);
      const cam = new THREE.OrthographicCamera();
      cam.position.copy(dir).multiplyScalar(80);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      expect(new THREE.Vector3(e[0], e[1], e[2]).distanceTo(x)).toBeLessThan(1e-9);
      expect(new THREE.Vector3(e[4], e[5], e[6]).distanceTo(y)).toBeLessThan(1e-9);
      expect(new THREE.Vector3(e[8], e[9], e[10]).distanceTo(z)).toBeLessThan(1e-9);
    }
  });

  it("the box's light-space centre is a whole number of texels; a static point keeps its sub-texel position wherever the player walks", () => {
    for (const dir of SUNS)
      for (const size of SIZES) {
        const texel = shadowTexel(REAL_SHADOW.half, size);
        const { x, y, z } = lightBasis(dir);
        const w = new THREE.Vector3(-17.2, 0.3, 6.3); // a point of the great tree's shadow
        let ref: number[] | null = null;
        for (let i = 0; i < 40; i++) {
          const p = new THREE.Vector3(-26 + i * 0.137, 0, 12 + i * 0.061); // a walk in 13.7 cm frames
          const b = snapShadowBox(p, dir, REAL_SHADOW.half, size, SHADOW_CELL);
          for (const a of [x, y, z]) {
            const k = b.target.dot(a) / texel;
            expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
          }
          const t = texelOf(w, b.target, dir, size).map(frac);
          if (!ref) ref = t;
          // the same fraction of a texel in every box (mod 1: the map's grid is fixed to the world)
          for (let j = 0; j < 2; j++) expect(Math.min(Math.abs(t[j] - ref[j]), 1 - Math.abs(t[j] - ref[j]))).toBeLessThan(1e-3);
        }
      }
  });

  it("moving the focus less than a texel (or less than half a cell) never moves the box; a cell's move steps it a whole number of texels", () => {
    for (const dir of SUNS)
      for (const size of SIZES) {
        const { x, y } = lightBasis(dir);
        const a = snapShadowBox(new THREE.Vector3(3, 0, 4), dir, REAL_SHADOW.half, size, SHADOW_CELL);
        const c = a.target.clone(); // a snapped centre: its own box
        const at = snapShadowBox(c, dir, REAL_SHADOW.half, size, SHADOW_CELL);
        for (const d of [a.texel * 0.9, a.step * 0.45])
          for (const ax of [x, y]) {
            const b = snapShadowBox(c.clone().addScaledVector(ax, d), dir, REAL_SHADOW.half, size, SHADOW_CELL);
            expect(b.key).toBe(at.key);
            expect(b.target.distanceTo(at.target)).toBeLessThan(1e-9);
          }
        const moved = snapShadowBox(c.clone().addScaledVector(x, a.step), dir, REAL_SHADOW.half, size, SHADOW_CELL);
        expect(moved.texels[0] - at.texels[0]).toBe(Math.round(a.step / a.texel));
        expect(a.step).toBeGreaterThanOrEqual(a.texel);
        expect(Math.abs(a.step - SHADOW_CELL)).toBeLessThanOrEqual(a.texel / 2 + 1e-9);
      }
  });
});

describe("shadow bias (shadowBias)", () => {
  it("normalBias 1-2 texels and 2-8 cm at both tiers' maps; the depth bias under 3 cm in world units", () => {
    const near = 1;
    const far = REAL_SHADOW.distance * 2;
    for (const size of SIZES) {
      const b = shadowBias(REAL_SHADOW.half, size, near, far);
      expect(b.normalBias / b.texel).toBeGreaterThanOrEqual(1);
      expect(b.normalBias / b.texel).toBeLessThanOrEqual(2);
      expect(b.normalBias).toBeGreaterThanOrEqual(0.02);
      expect(b.normalBias).toBeLessThanOrEqual(0.08);
      expect(b.bias).toBeLessThan(0);
      expect(-b.bias * (far - near)).toBeCloseTo(SHADOW_DEPTH_BIAS_M, 9);
      expect(-b.bias * (far - near)).toBeLessThanOrEqual(0.03);
    }
  });
});

describe("the box's edge (shadowEdgeFade, patchShadowEdge)", () => {
  it("full inside, 0 at the edge, continuous (no step anywhere across the box)", () => {
    expect(shadowEdgeFade(0.5, 0.5)).toBe(1);
    expect(shadowEdgeFade(0, 0.5)).toBe(0);
    expect(shadowEdgeFade(0.5, 1)).toBe(0);
    let prev = shadowEdgeFade(0, 0.5);
    let worst = 0;
    for (let i = 1; i <= 2000; i++) {
      const f = shadowEdgeFade(i / 2000, 0.5);
      worst = Math.max(worst, Math.abs(f - prev));
      prev = f;
    }
    expect(worst).toBeLessThan(0.02); // 0.0005 of the box per sample: a ramp, not a cut
    // the fade starts well past the focus (at most half a cell off the box's centre) and the screen's near ground
    const inner = REAL_SHADOW.half * (1 - 2 * SHADOW_EDGE) - SHADOW_CELL / 2;
    expect(inner).toBeGreaterThan(10);
    const u = 0.5 + inner / (2 * REAL_SHADOW.half);
    expect(shadowEdgeFade(u, 0.5)).toBeCloseTo(1, 6);
  });

  it("patches three's lights chunk once: the directional shadow wrapped in the fade", () => {
    patchShadowEdge();
    patchShadowEdge();
    const begin = THREE.ShaderChunk.lights_fragment_begin;
    expect(begin.match(/sunShadowEdge\( vDirectionalShadowCoord\[ i \] \)/g)?.length).toBe(1);
    expect(THREE.ShaderChunk.shadowmap_pars_fragment.match(/float sunShadowEdge/g)?.length).toBe(1);
    // spot lights untouched
    expect(begin).toContain("getShadow( spotShadowMap[ i ]");
  });
});

/**
 * A renderer stub: its shadow pass records what each call drew (the static target's pass: the
 * roots visible; the casters' pass: the holder's children) when the sun's map is due, as three's
 * does; `frame` is one frame: SunShadow plans, then the scene's render runs the (hooked) pass.
 */
function stubRenderer() {
  const passes: { kind: "static" | "casters"; visible: string[] }[] = [];
  const renderer = {
    shadowMap: {
      enabled: true,
      render(lights: THREE.Light[], scene: THREE.Object3D) {
        const light = lights[0] as THREE.DirectionalLight | undefined;
        if (!light || (!light.shadow.autoUpdate && !light.shadow.needsUpdate)) return; // three's skip
        const visible: string[] = [];
        for (const c of scene.children) if (c.visible && c.name) visible.push(c.name);
        passes.push({ kind: (scene as THREE.Scene).isScene ? "static" : "casters", visible });
        if (!light.shadow.map) light.shadow.map = new THREE.WebGLRenderTarget(4, 4);
        light.shadow.needsUpdate = false;
      },
    },
    state: { buffers: { depth: { getReversed: () => false } } },
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    renderBufferDirect: vi.fn(),
    render: vi.fn(),
  };
  const r = renderer as unknown as THREE.WebGLRenderer;
  const frame = (s: SunShadow, scene: THREE.Scene, sun: THREE.DirectionalLight) => {
    s.draw(r, scene);
    renderer.shadowMap.render([sun], scene); // the colour pass's shadow pass
    renderer.shadowMap.render([sun], scene); // the AO normal pass's: nothing left pending
  };
  return { renderer: r, passes, merges: renderer.renderBufferDirect, frame };
}

describe("the two-layer draw (SunShadow)", () => {
  function world() {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(64, 64);
    scene.add(sun, sun.target);
    const house = new THREE.Mesh(new THREE.BoxGeometry());
    house.name = "house";
    house.castShadow = true;
    const player = new THREE.Group();
    player.name = "player";
    player.userData.dynamicShadow = true;
    const npc = new THREE.Group(); // an actor: a skinned mesh inside
    npc.name = "npc";
    const bone = new THREE.Bone();
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    npc.add(skinned);
    scene.add(house, player, npc);
    return { scene, sun, house, player, npc };
  }

  it("the static layer without the casters, only when due; the casters every frame one moves, every `every` frames idle", () => {
    const { scene, sun, house, player } = world();
    const s = new SunShadow(sun, 3);
    expect(sun.shadow.autoUpdate).toBe(false);
    const { renderer, passes, merges, frame } = stubRenderer();
    s.aim("0,0,0", 1);
    frame(s, scene, sun);
    expect(passes.map((p) => p.kind)).toEqual(["static", "casters"]);
    expect(passes[0].visible).toEqual(["house"]); // the casters hidden from the static layer
    expect(passes[1].visible.sort()).toEqual(["npc", "player"]);
    expect(house.visible && player.visible).toBe(true); // restored
    expect(merges).toHaveBeenCalledTimes(1); // the static depth merged into the map
    expect(renderer.render).toHaveBeenCalledTimes(1); // the merge's buffers uploaded once, outside the pass
    expect(sun.shadow.needsUpdate).toBe(false); // three's own pass skips the sun
    // walking: the casters every frame, the static layer untouched (the box within its cell)
    passes.length = 0;
    for (let i = 0; i < 12; i++) {
      player.position.x += 0.05;
      frame(s, scene, sun);
    }
    expect(passes.filter((p) => p.kind === "casters").length).toBe(12);
    expect(passes.filter((p) => p.kind === "static").length).toBe(0);
    expect(merges).toHaveBeenCalledTimes(13);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    // turning in place counts as moving; then still: every 3rd frame for the idle animations
    passes.length = 0;
    player.rotation.y = 0.5;
    frame(s, scene, sun);
    expect(passes.length).toBe(1);
    passes.length = 0;
    for (let i = 0; i < 12; i++) frame(s, scene, sun);
    expect(passes.map((p) => p.kind)).toEqual(["casters", "casters", "casters", "casters"]);
    // the box steps a cell: both layers
    passes.length = 0;
    s.aim("93,0,0", 1);
    frame(s, scene, sun);
    expect(passes.map((p) => p.kind)).toEqual(["static", "casters"]);
    // a static root lands: the static layer again
    passes.length = 0;
    scene.add(new THREE.Mesh());
    frame(s, scene, sun);
    expect(passes[0].kind).toBe("static");
    expect(s.plan.updates).toBe(3);
  });

  it("shadows off (the classic look's renderer): nothing planned or drawn", () => {
    const { scene, sun } = world();
    const s = new SunShadow(sun, 2);
    const { renderer, passes, frame } = stubRenderer();
    (renderer.shadowMap as { enabled: boolean }).enabled = false;
    s.aim("0,0,0", 1);
    frame(s, scene, sun);
    expect(passes.length).toBe(0);
    expect(s.plan.frames).toBe(0);
  });

  it("world.ts hands the box to the SunShadow, reallook.ts plans it before the scene's render, the player root is flagged", () => {
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    expect(src("world.ts")).toMatch(/snapShadowBox\(/);
    expect(src("world.ts")).toMatch(/this\.sunShadow\?\.aim\(/);
    expect(src("world.ts")).not.toMatch(/shadow\.needsUpdate\s*=/); // only SunShadow redraws the map
    const real = src("reallook.ts");
    expect(real.indexOf("sunShadow as SunShadowDraw")).toBeGreaterThan(-1);
    expect(real.indexOf("sunShadow as SunShadowDraw")).toBeLessThan(real.indexOf("composer.render();"));
    expect(src("main.ts")).toMatch(/player\.root\.userData\.dynamicShadow = true/);
  });
});

describe("grass bands: soft fades (no hard band moving with the camera)", () => {
  it("every band fades over at least 3 m, with each blade's own jitter on top (the shader's smoothstep)", () => {
    for (const lite of [false, true])
      for (const b of grassBands(lite)) expect(b.fade[1] - b.fade[0]).toBeGreaterThanOrEqual(3);
    expect(GRASS.near.fade[1]).toBeLessThan(GRASS.far.fade[0]); // the near band is gone before the far one thins
    const env = readFileSync(new URL("../src/envlook.ts", import.meta.url), "utf8");
    expect(env).toMatch(/smoothstep\(envFade\.x, envFade\.y, bd \+ r \* 1\.5\)/);
  });
});
