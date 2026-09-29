// The "real look" prototype (look.ts, `?look=real`): its own chunk, imported by main.ts only when
// the flag is on, so the default page never loads or builds any of this. It owns the renderer's
// shadow map / tone mapping settings and an EffectComposer: the scene into a multisampled half-float
// target, GTAO (ground-truth ambient occlusion) over it, then OutputPass (ACES filmic + sRGB). Each
// space's environment map is a PMREM of a gradient equirect made from its sky (SceneSpace writes
// scene.userData.lookSky: dome zenith, horizon, the hemisphere's ground), rebuilt when the daylight
// moves it. GTAO's normal pass carries the see-through cutout. The see-through detector (seethrough.ts) renders its id pass on its own target with the
// plain renderer and restores the state it touched; the composer doesn't change that.
// Environment layers (`&env=`, look.ts LOOK.env; default all): envlook.ts builds each space's town
// layers (ground, grass, leaves, sky, particles) and evening emissives the first time it renders;
// here, `bloom` adds an UnrealBloomPass before the output (HDR highlights only, at half its usual
// resolution) and `grade` folds a lift / gamma / gain + saturation + vignette + grain grade into the
// OutputPass shader. The AO pass never sees the env's cards, sky or particles (like the hulls).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { buildEnv, type EnvScene } from "./envlook";
import type { LookSky } from "./look";

export const REAL = {
  exposure: 0.9,
  /** scene.environmentIntensity: the sky's share of the fill light */
  envIntensity: 0.45,
  ao: { radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 16, distanceFallOff: 1 },
  aoBlend: 0.9,
  /** bloom (the `bloom` layer): only HDR highlights (the sun disc, evening emissives) pass the threshold; stronger toward evening */
  bloom: { threshold: 2.4, smooth: 1.2, radius: 0.55, day: 0.18, evening: 0.55 },
  /** the colour grade (the `grade` layer, display space after ACES): midday warm-clean, evening amber */
  grade: {
    midday: { lift: [0.004, 0.004, 0.006], gamma: [1.0, 1.0, 1.01], gain: [1.02, 1.01, 0.985], saturation: 1.06, vignette: 0.22 },
    // amber highlights over cooler shadows (the evening light is already orange: this pulls the reds back)
    evening: { lift: [0.0, 0.012, 0.03], gamma: [0.97, 1.0, 1.05], gain: [1.0, 0.97, 0.93], saturation: 0.88, vignette: 0.34 },
    grain: 0.022,
  },
};

/** Options main.ts passes in (values of main-bundle modules: importing them here would split them off). */
export interface RealLookOptions {
  /** look.ts LOOK.env: the environment layers on */
  env?: readonly string[];
  /** seethrough.ts SEE_ATTR */
  seeAttr?: string;
}

/**
 * The `grade` layer, folded into OutputPass's own shader (no extra full-screen pass): after ACES and
 * the sRGB transfer, in display space, lift / gamma / gain (ASC-CDL-like), saturation, vignette, grain.
 */
function gradeUniforms() {
  return {
    uLift: { value: new THREE.Vector3() },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uVignette: { value: 0 },
    uGrain: { value: 0 },
    uSeed: { value: 0 },
  };
}
const GRADE_PARS = /* glsl */ `
uniform vec3 uLift, uGamma, uGain;
uniform float uSat, uVignette, uGrain, uSeed;
float envGrainHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;
const GRADE_MAIN = /* glsl */ `
  {
    vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0);
    c = uGain * (c + uLift * (1.0 - c));
    c = pow(max(c, 0.0), 1.0 / uGamma);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSat);
    vec2 q = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
    c += (envGrainHash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
    gl_FragColor.rgb = clamp(c, 0.0, 1.0);
  }
`;

export interface RealLook {
  /** `focus`: the player (the grass, dust and shadow box centre on it); the camera's position if absent */
  render(scene: THREE.Scene, camera: THREE.Camera, focus?: THREE.Vector3): void;
  setSize(w: number, h: number, pixelRatio: number): void;
  /** ms per composer frame, a running mean (window.world3d.lookInfo) */
  readonly stats: { frameMs: number; frames: number; envBuilds: number; envLayers: readonly string[]; envBuildMs: number };
}

/** The sky as a small equirect: zenith -> horizon above, horizon -> ground below (linear). */
function skyEquirect(k: LookSky, sun = false): THREE.DataTexture {
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
      if (!sun) continue;
      // the sky layer (envlook.ts): the sun's glow in the fill light too (three's equirect: u = atan(z, x) / 2pi + 0.5)
      const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const ce = Math.cos(el);
      const mu = Math.max(0, Math.cos(phi) * ce * k.sun.x + Math.sin(el) * k.sun.y + Math.sin(phi) * ce * k.sun.z);
      const g = 0.06 * Math.pow(mu, 4) + 0.12 * Math.pow(mu, 24);
      const sl = Math.max(k.sunColor.r, k.sunColor.g, k.sunColor.b, 1e-3);
      data[i] += (k.sunColor.r / sl) * g * (1 + k.daylight);
      data[i + 1] += (k.sunColor.g / sl) * g * (1 + k.daylight);
      data[i + 2] += (k.sunColor.b / sl) * g * (1 + k.daylight);
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
export function createRealLook(renderer: THREE.WebGLRenderer, seeThrough: (m: THREE.Material) => void, hulls: readonly THREE.Material[] = [], opts: RealLookOptions = {}): RealLook {
  const layers = new Set(opts.env ?? []);
  /** what the AO pass never sees: the hulls, and the environment's cards / sky / particles (envlook.ts adds them) */
  const aoHidden: THREE.Material[] = [...hulls];
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
  // ...and never sees the outline hulls (`hulls`: their materials, world.ts OUTLINE_MATERIALS). Under
  // the pass's override material a hull is its mesh again, un-pushed, at the same depth: the two
  // z-fight into a diagonal hatch of wrong normals, dark stripes on any mesh that isn't batched (a
  // textured asset's one mesh). Hidden by material for the AO pass only (the renderer skips an
  // object whose own material is invisible, override or not); the colour pass still draws them.
  const aoRender = gtao.render.bind(gtao);
  gtao.render = (...args: Parameters<GTAOPass["render"]>) => {
    for (const m of aoHidden) m.visible = false;
    try {
      aoRender(...args);
    } finally {
      for (const m of aoHidden) m.visible = true;
    }
  };
  composer.addPass(renderPass);
  composer.addPass(gtao);
  // `bloom` layer: HDR highlights only, before the tone map
  const bloom = layers.has("bloom") ? new UnrealBloomPass(new THREE.Vector2(size.x, size.y), REAL.bloom.day, REAL.bloom.radius, REAL.bloom.threshold) : null;
  if (bloom) {
    (bloom as unknown as { highPassUniforms: Record<string, THREE.IUniform> }).highPassUniforms.smoothWidth.value = REAL.bloom.smooth;
    // at half the pass's own resolution (its mips from a quarter of the frame): a soft glow needs no more, and it's the pass's cost
    const bloomSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => bloomSize(Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2)));
    composer.addPass(bloom);
  }
  const output = new OutputPass();
  // `grade` layer: in the output pass's shader, after ACES + sRGB (display space)
  const grade = layers.has("grade") ? { uniforms: gradeUniforms() } : null;
  if (grade) {
    Object.assign(output.uniforms, grade.uniforms);
    const f = output.material.fragmentShader;
    const end = f.lastIndexOf("}");
    output.material.fragmentShader = f.slice(0, end).replace("void main() {", `${GRADE_PARS}\nvoid main() {`) + GRADE_MAIN + f.slice(end);
    output.material.needsUpdate = true;
  }
  composer.addPass(output);
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envs = new WeakMap<THREE.Scene, { version: number; rt: THREE.WebGLRenderTarget }>();
  const stats = { frameMs: 0, frames: 0, envBuilds: 0, envLayers: [] as readonly string[], envBuildMs: 0 };
  const envScenes = new WeakMap<THREE.Scene, EnvScene>();
  const envDeps = { seeThrough, seeAttr: opts.seeAttr ?? "seeThru", aoHidden };
  const tStart = performance.now();
  const lerp3 = (out: THREE.Vector3, a: number[], b: number[], t: number) => out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);

  function envFor(scene: THREE.Scene): EnvScene | undefined {
    if (!layers.size || !scene.userData.lookSky) return undefined;
    let e = envScenes.get(scene);
    if (!e) {
      const b0 = performance.now();
      e = buildEnv(scene, layers, envDeps);
      stats.envBuildMs = +(performance.now() - b0).toFixed(1);
      envScenes.set(scene, e);
    }
    stats.envLayers = e.layers;
    return e;
  }

  function environment(scene: THREE.Scene) {
    const k = scene.userData.lookSky as LookSky | undefined;
    if (!k) return;
    const had = envs.get(scene);
    if (had && had.version === k.version) return;
    const eq = skyEquirect(k, layers.has("sky") && !!(scene.userData.lookGround as { town?: boolean } | undefined)?.town);
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
    render(scene, camera, focus) {
      const t0 = performance.now();
      environment(scene);
      const env = envFor(scene);
      const time = (t0 - tStart) / 1000;
      env?.update(camera, focus, time);
      const evening = env?.evening ?? 0;
      if (bloom) bloom.strength = REAL.bloom.day + (REAL.bloom.evening - REAL.bloom.day) * evening;
      if (grade) {
        const g = REAL.grade;
        const u = grade.uniforms;
        lerp3(u.uLift.value, g.midday.lift, g.evening.lift, evening);
        lerp3(u.uGamma.value, g.midday.gamma, g.evening.gamma, evening);
        lerp3(u.uGain.value, g.midday.gain, g.evening.gain, evening);
        u.uSat.value = g.midday.saturation + (g.evening.saturation - g.midday.saturation) * evening;
        u.uVignette.value = g.midday.vignette + (g.evening.vignette - g.midday.vignette) * evening;
        u.uGrain.value = g.grain;
        // reduced motion: a still grain (no crawl)
        u.uSeed.value = reducedMotion ? 0 : (stats.frames % 64) * 7.31;
      }
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
