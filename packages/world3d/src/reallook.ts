// The "real look" prototype (look.ts, `?look=real`): its own chunk, imported by main.ts only when
// the flag is on, so the default page never loads or builds any of this. It owns the renderer's
// shadow map / tone mapping settings and an EffectComposer: the scene into a multisampled half-float
// target, GTAO (ground-truth ambient occlusion) over it, then OutputPass (ACES filmic + sRGB). Each
// space's environment map is a PMREM of a gradient equirect made from its sky (SceneSpace writes
// scene.userData.lookSky: dome zenith, horizon, the hemisphere's ground), rebuilt when the daylight
// moves it. GTAO's normal pass carries the see-through cutout. The see-through detector (seethrough.ts) renders its id pass on its own target with the
// plain renderer and restores the state it touched; the composer doesn't change that.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import type { LookSky } from "./look";

export const REAL = {
  exposure: 0.9,
  /** scene.environmentIntensity: the sky's share of the fill light */
  envIntensity: 0.45,
  ao: { radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 16, distanceFallOff: 1 },
  aoBlend: 0.9,
};

export interface RealLook {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(w: number, h: number, pixelRatio: number): void;
  /** ms per composer frame, a running mean (window.world3d.lookInfo) */
  readonly stats: { frameMs: number; frames: number; envBuilds: number };
}

/** The sky as a small equirect: zenith -> horizon above, horizon -> ground below (linear). */
function skyEquirect(k: LookSky): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Float32Array(w * h * 4);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    // row 0 = bottom of the texture (flipY false, DataTexture): v = 0 looks straight down
    const v = (y + 0.5) / h;
    const el = (v - 0.5) * Math.PI; // -pi/2 .. pi/2
    if (el >= 0) c.copy(k.horizon).lerp(k.zenith, Math.pow(Math.sin(el), 0.6));
    else c.copy(k.horizon).lerp(k.ground, Math.min(1, Math.pow(-Math.sin(el), 0.5) * 1.2));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * `seeThrough`: seethrough.ts patchSeeThrough, passed in by main.ts (importing it here would split
 * seethrough.ts out of the main bundle into a chunk shared with this one, changing the default page).
 */
export function createRealLook(renderer: THREE.WebGLRenderer, seeThrough: (m: THREE.Material) => void): RealLook {
  renderer.shadowMap.enabled = true;
  // three 0.186 removed PCFSoftShadowMap (it falls back with a warning): PCF, softened by shadow.radius
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = REAL.exposure;

  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  const dummyScene = new THREE.Scene();
  const dummyCamera = new THREE.PerspectiveCamera();
  const renderPass = new RenderPass(dummyScene, dummyCamera);
  const gtao = new GTAOPass(dummyScene, dummyCamera, size.x, size.y);
  gtao.updateGtaoMaterial(REAL.ao);
  gtao.blendIntensity = REAL.aoBlend;
  // the AO's depth / normal pass honours the see-through's dither, else a faded building still darkens what's behind it
  seeThrough(gtao.normalMaterial);
  composer.addPass(renderPass);
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envs = new WeakMap<THREE.Scene, { version: number; rt: THREE.WebGLRenderTarget }>();
  const stats = { frameMs: 0, frames: 0, envBuilds: 0 };

  function environment(scene: THREE.Scene) {
    const k = scene.userData.lookSky as LookSky | undefined;
    if (!k) return;
    const had = envs.get(scene);
    if (had && had.version === k.version) return;
    const eq = skyEquirect(k);
    const rt = pmrem.fromEquirectangular(eq);
    eq.dispose();
    had?.rt.dispose();
    envs.set(scene, { version: k.version, rt });
    scene.environment = rt.texture;
    scene.environmentIntensity = REAL.envIntensity;
    stats.envBuilds++;
  }

  return {
    stats,
    render(scene, camera) {
      const t0 = performance.now();
      environment(scene);
      renderPass.scene = scene;
      renderPass.camera = camera;
      gtao.scene = scene;
      gtao.camera = camera;
      composer.render();
      const ms = performance.now() - t0;
      stats.frames++;
      stats.frameMs += (ms - stats.frameMs) / Math.min(stats.frames, 120);
    },
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
    },
  };
}
