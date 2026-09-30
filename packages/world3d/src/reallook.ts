// The "real look" (look.ts: the full and lite graphics tiers, `?look=real`): its own chunk, imported
// by main.ts only then, so the classic (toon) page never loads or builds any of this. It owns the renderer's
// shadow map / tone mapping settings and an EffectComposer: the scene into its own half-float target
// (MSAA per the tier's RenderBudget.msaa, with a depth texture), GTAO (ground-truth ambient
// occlusion) at the budget's resolution (full, half: upsampled depth-aware in the composite, or
// off) folded into one composite onto the composer's plain targets, then OutputPass (ACES filmic +
// sRGB) and FXAA (RenderBudget.fxaa). Each
// space's environment map is a PMREM of a gradient equirect made from its sky (SceneSpace writes
// scene.userData.lookSky: dome zenith, horizon, the hemisphere's ground), rebuilt when the daylight
// moves it. GTAO's normal pass carries the see-through cutout. The see-through detector (seethrough.ts) renders its id pass on its own target with the
// plain renderer and restores the state it touched; the composer doesn't change that.
// Environment layers (look.ts LOOK.env: the tier's, or `&env=`): envlook.ts builds each space's town
// layers (ground, grass, leaves, sky, particles) and evening emissives in prepare() (the town, behind
// the loading screen: main.ts) or else the first time it renders;
// here, `bloom` adds an UnrealBloomPass before the output (HDR highlights only, at half its usual
// resolution) and `grade` folds a lift / gamma / gain + saturation + vignette + grain grade into the
// OutputPass shader. The AO pass never sees the env's cards, sky or particles (like the hulls).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { openEnvCache } from "./envcache";
import { buildEnv, type EnvScene } from "./envlook";
import type { LookSky } from "./look";
import type { Perf } from "./perf";

export const REAL = {
  exposure: 0.9,
  /** scene.environmentIntensity: the sky's share of the fill light */
  envIntensity: 0.45,
  ao: { radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 16, distanceFallOff: 1 },
  aoBlend: 0.9,
  /** AO at half resolution (RenderBudget.ao "half"): half the GTAO and denoise samples too (their cost was the pass: 4.5 ms of it at 16 / 16 on the Vega 11) */
  aoHalf: { samples: 8, pdSamples: 8 },
  /** bloom (the `bloom` layer): only HDR highlights (the sun disc, evening emissives) pass the threshold; stronger toward evening */
  bloom: { threshold: 2.4, smooth: 1.2, radius: 0.55, day: 0.18, evening: 0.55, downscale: 4 },
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
  /** look.ts LOOK.grassDensity: the grass layer's share of its blades */
  grassDensity?: number;
  /** the lite tier (envlook.ts grassBands) */
  lite?: boolean;
  /** false (`?warm=0`, to measure it): prepare() draws its one frame culled as usual, no pipeline warm-up */
  warm?: boolean;
  /** version.ts BUILD: the env cache's key (envcache.ts; absent: no cache) */
  cacheStamp?: string;
  /** perf.ts (`?perf=1`): every pass timed; null / absent: nothing wrapped */
  perf?: Perf | null;
  /** look.ts RenderBudget's AO mode and MSAA samples (absent: full-resolution AO, 4 samples) */
  budget?: { ao: AoMode; msaa: number; fxaa?: boolean };
}

/** look.ts RenderBudget.ao */
export type AoMode = "full" | "half" | "off";

/** GTAOPass's internals the AO pass drives itself (three 0.186) */
interface GtaoInternals {
  normalRenderTarget: THREE.WebGLRenderTarget;
  gtaoRenderTarget: THREE.WebGLRenderTarget;
  pdRenderTarget: THREE.WebGLRenderTarget;
  _overrideVisibility(): void;
  _restoreVisibility(): void;
  _renderOverride(r: THREE.WebGLRenderer, m: THREE.Material, rt: THREE.WebGLRenderTarget, clear: number, alpha: number): void;
  _renderPass(r: THREE.WebGLRenderer, m: THREE.Material, rt: THREE.WebGLRenderTarget | null, clear?: number, alpha?: number): void;
}

/**
 * The AO composite: the scene's colour times the AO, in one full-screen pass. The AO (the denoised
 * GTAO, at half resolution in "half") is upsampled depth-aware: of the four AO texels round a
 * pixel, each weighs by its bilinear share and by how close its own depth (the AO's depth pass) is
 * to the pixel's (the scene's depth texture), so AO doesn't bleed across a silhouette. intensity 0:
 * a plain copy (AO off).
 */
export function aoComposite(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "RealLook.aoComposite",
    uniforms: {
      tScene: { value: null },
      tAO: { value: null },
      tLowDepth: { value: null },
      tFullDepth: { value: null },
      lowSize: { value: new THREE.Vector2(1, 1) },
      near: { value: 0.1 },
      far: { value: 1000 },
      intensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform sampler2D tScene, tAO, tLowDepth, tFullDepth;
uniform vec2 lowSize;
uniform float near, far, intensity;
varying vec2 vUv;
float viewZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
void main() {
  vec4 c = texture2D(tScene, vUv);
  if (intensity <= 0.0) { gl_FragColor = c; return; }
  float dz = viewZ(texture2D(tFullDepth, vUv).x);
  vec2 p = vUv * lowSize - 0.5;
  vec2 f = fract(p);
  vec2 base = (floor(p) + 0.5) / lowSize;
  float ao = 0.0, wsum = 0.0;
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      vec2 uv = base + vec2(float(i), float(j)) / lowSize;
      float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-3;
      float dl = viewZ(texture2D(tLowDepth, uv).x);
      w /= 1e-3 + abs(dl - dz) / max(dz, 1e-3) * 40.0;
      ao += texture2D(tAO, uv).r * w;
      wsum += w;
    }
  ao = wsum > 0.0 ? ao / wsum : 1.0;
  gl_FragColor = vec4(c.rgb * mix(1.0, ao, intensity), c.a);
}`,
    depthTest: false,
    depthWrite: false,
  });
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
  /**
   * Behind the loading screen, before the first frame: `scene`'s environment map and layers built,
   * its materials' programs compiled (async where the driver can), and one frame drawn so the
   * composer's passes compile too. The first frame on screen then has every layer and no hitch.
   */
  prepare(scene: THREE.Scene, camera: THREE.Camera, focus?: THREE.Vector3): Promise<void>;
  /** Down to `layers` (a subset of the ones on: the safety valve's full -> lite), the grass at `grassDensity`; every space built so far and every one after. */
  restrict(layers: readonly string[], grassDensity: number): void;
  /** ms per composer frame, a running mean (window.world3d.lookInfo) */
  stats: { frameMs: number; frames: number; envBuilds: number; envLayers: readonly string[]; envBuildMs: number; envTimings?: Readonly<Record<string, number>>; envCache?: { hits: string[]; misses: string[] }; grass?: { chunks: number; drawn: number; blades: number } };
  /** the composer's render targets (perf.ts textureBytes) */
  targets(): THREE.WebGLRenderTarget[];
  /** AO's mode now ("off": the valve's drop to lite, live) */
  setAo(mode: AoMode): void;
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
  const budget = opts.budget ?? { ao: "full" as AoMode, msaa: 4 };
  let aoMode: AoMode = budget.ao;
  // The scene draws into its own multisampled target (colour + a depth texture, resolved once);
  // the post passes run on plain single-sample targets (EffectComposer's, no depth): each full-
  // screen pass into a multisampled target paid a resolve of it, and the composer kept two.
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: budget.msaa, depthTexture: new THREE.DepthTexture(1, 1) });
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  const dummyScene = new THREE.Scene();
  const dummyCamera = new THREE.PerspectiveCamera();
  /** the scene into sceneRT (the composer's buffers untouched: the AO / composite pass reads it) */
  const renderPass = new RenderPass(dummyScene, dummyCamera);
  const sceneRender = (r: THREE.WebGLRenderer) => {
    r.setRenderTarget(sceneRT);
    r.clear();
    r.render(renderPass.scene, renderPass.camera);
  };
  renderPass.render = (r: THREE.WebGLRenderer) => sceneRender(r);
  const gtao = new GTAOPass(dummyScene, dummyCamera, size.x, size.y);
  gtao.updateGtaoMaterial(aoMode === "half" ? { ...REAL.ao, samples: REAL.aoHalf.samples } : REAL.ao);
  if (aoMode === "half") gtao.updatePdMaterial({ samples: REAL.aoHalf.pdSamples });
  gtao.blendIntensity = REAL.aoBlend;
  // the AO's depth / normal pass honours the see-through's dither, else a faded building still darkens what's behind it
  seeThrough(gtao.normalMaterial);
  // AO at half the frame's resolution ("half"): its three passes (normal / depth, GTAO, denoise) on
  // a quarter of the pixels; the composite upsamples it depth-aware (aoComposite)
  const gtaoSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w: number, h: number) => (aoMode === "half" ? gtaoSize(Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2))) : aoMode === "off" ? gtaoSize(2, 2) : gtaoSize(w, h));
  const composite = aoComposite();
  const fsQuad = new FullScreenQuad(composite);
  const g = gtao as unknown as GtaoInternals;
  // ...and never sees the outline hulls (`hulls`: their materials, world.ts OUTLINE_MATERIALS). Under
  // the pass's override material a hull is its mesh again, un-pushed, at the same depth: the two
  // z-fight into a diagonal hatch of wrong normals, dark stripes on any mesh that isn't batched (a
  // textured asset's one mesh). Hidden by material for the AO pass only (the renderer skips an
  // object whose own material is invisible, override or not); the colour pass still draws them.
  // Then GTAOPass's own normal / AO / denoise passes, and in place of its copy + multiply blend one
  // composite: the scene's colour times the (upsampled) AO into the composer's write buffer.
  gtao.render = (r: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) => {
    const u = composite.uniforms;
    u.tScene.value = sceneRT.texture;
    if (aoMode !== "off") {
      for (const m of aoHidden) m.visible = false;
      try {
        g._overrideVisibility();
        g._renderOverride(r, gtao.normalMaterial, g.normalRenderTarget, 0x7777ff, 1.0);
        g._restoreVisibility();
      } finally {
        for (const m of aoHidden) m.visible = true;
      }
      const cam = gtao.camera as THREE.PerspectiveCamera;
      const gu = gtao.gtaoMaterial.uniforms;
      gu.cameraNear.value = cam.near;
      gu.cameraFar.value = cam.far;
      gu.cameraProjectionMatrix.value.copy(cam.projectionMatrix);
      gu.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
      gu.cameraWorldMatrix.value.copy(cam.matrixWorld);
      g._renderPass(r, gtao.gtaoMaterial, g.gtaoRenderTarget, 0xffffff, 1.0);
      gtao.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
      g._renderPass(r, gtao.pdMaterial, g.pdRenderTarget, 0xffffff, 1.0);
      u.tAO.value = g.pdRenderTarget.texture;
      u.tLowDepth.value = g.normalRenderTarget.depthTexture;
      u.tFullDepth.value = sceneRT.depthTexture;
      u.lowSize.value.set(g.pdRenderTarget.width, g.pdRenderTarget.height);
      u.near.value = cam.near;
      u.far.value = cam.far;
      u.intensity.value = gtao.blendIntensity;
    } else u.intensity.value = 0;
    r.setRenderTarget(writeBuffer);
    fsQuad.render(r);
  };
  composer.addPass(renderPass);
  composer.addPass(gtao);
  // `bloom` layer: HDR highlights only, before the tone map
  const bloom = layers.has("bloom") ? new UnrealBloomPass(new THREE.Vector2(size.x, size.y), REAL.bloom.day, REAL.bloom.radius, REAL.bloom.threshold) : null;
  if (bloom) {
    (bloom as unknown as { highPassUniforms: Record<string, THREE.IUniform> }).highPassUniforms.smoothWidth.value = REAL.bloom.smooth;
    // at a quarter of the frame's resolution each way (its mips from there down): a soft glow needs no
    // more, and its blur chain was the pass's cost (half: 1.0-1.9 ms at 1080p on the Vega 11)
    const bloomSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => bloomSize(Math.max(2, Math.round(w / REAL.bloom.downscale)), Math.max(2, Math.round(h / REAL.bloom.downscale)));
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
  // FXAA (RenderBudget.fxaa) on the display-space frame, last: the antialiasing in place of MSAA
  // the output pass then writes an 8-bit target (display-space values: all FXAA needs), FXAA reads that to the screen
  const fxaa = budget.fxaa ? new FXAAPass() : null;
  const ldrRT = fxaa ? new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }) : null;
  if (fxaa && ldrRT) {
    const outRender = output.render.bind(output);
    output.render = (r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) => {
      output.renderToScreen = false;
      outRender(r, ldrRT, read, 0, false);
    };
    const fxaaRender = fxaa.render.bind(fxaa);
    fxaa.render = (r: THREE.WebGLRenderer, w: THREE.WebGLRenderTarget, _read: THREE.WebGLRenderTarget, ...rest: [number, boolean]) => fxaaRender(r, w, ldrRT, ...rest);
    const fxaaSize = fxaa.setSize.bind(fxaa);
    fxaa.setSize = (w: number, h: number) => {
      ldrRT.setSize(w, h);
      fxaaSize(w, h);
    };
    composer.addPass(fxaa);
  }
  const perf = opts.perf ?? null;
  if (perf) {
    perf.wrap(renderPass, "render", "colour");
    perf.wrap(g, "_renderOverride", "aoNormal");
    perf.wrap(gtao, "render", "ao");
    if (bloom) perf.wrap(bloom, "render", "bloom");
    perf.wrap(output, "render", "output");
    if (fxaa) perf.wrap(fxaa, "render", "fxaa");
  }
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  sceneRT.setSize(Math.max(1, Math.floor(size.x * renderer.getPixelRatio())), Math.max(1, Math.floor(size.y * renderer.getPixelRatio())));
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envs = new WeakMap<THREE.Scene, { version: number; rt: THREE.WebGLRenderTarget }>();
  const stats: RealLook["stats"] = { frameMs: 0, frames: 0, envBuilds: 0, envLayers: [], envBuildMs: 0 };
  const envScenes = new WeakMap<THREE.Scene, EnvScene>();
  const envDeps: Parameters<typeof buildEnv>[2] = { seeThrough, seeAttr: opts.seeAttr ?? "seeThru", aoHidden, grassDensity: opts.grassDensity ?? 1, lite: !!opts.lite };
  /** every space's layers built so far (restrict reaches them all) */
  const built: EnvScene[] = [];
  const tStart = performance.now();
  const lerp3 = (out: THREE.Vector3, a: number[], b: number[], t: number) => out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);

  const interiorAirRegistered = new WeakSet<THREE.Scene>();
  function envFor(scene: THREE.Scene): EnvScene | undefined {
    // A shaft/sky has no solid surface: exclude it from AO even with &env= (no layers).
    if (!interiorAirRegistered.has(scene)) {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          if (material.userData.interiorBackdropAir) aoHidden.push(material);
      });
      interiorAirRegistered.add(scene);
    }
    if (!layers.size || !scene.userData.lookSky) return undefined;
    let e = envScenes.get(scene);
    if (!e) {
      const b0 = performance.now();
      e = buildEnv(scene, layers, envDeps);
      stats.envBuildMs = +(performance.now() - b0).toFixed(1);
      stats.envTimings = e.timings;
      envScenes.set(scene, e);
      built.push(e);
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
    perf?.flag("envBuild");
    scene.environment = rt.texture;
    scene.environmentIntensity = REAL.envIntensity;
    stats.envBuilds++;
  }

  let bloomOn = !!bloom;
  let gradeOn = !!grade;
  function draw(scene: THREE.Scene, camera: THREE.Camera, focus: THREE.Vector3 | undefined) {
    const t0 = performance.now();
    environment(scene);
    const env = envFor(scene);
    const time = (t0 - tStart) / 1000;
    if (perf) perf.cpuBegin("env");
    env?.update(camera, focus, time);
    if (perf) perf.cpuEnd();
    if (env) stats.grass = env.grass;
    const evening = env?.evening ?? 0;
    if (bloom) bloom.strength = REAL.bloom.day + (REAL.bloom.evening - REAL.bloom.day) * evening;
    if (grade && !gradeOn) {
      // restricted without grade: the shader stays, at identity
      const u = grade.uniforms;
      u.uLift.value.set(0, 0, 0);
      u.uGamma.value.set(1, 1, 1);
      u.uGain.value.set(1, 1, 1);
      u.uSat.value = 1;
      u.uVignette.value = 0;
      u.uGrain.value = 0;
    } else if (grade) {
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
    return performance.now() - t0;
  }

  /** `fn` with every object's frustum culling off (the shadow pass's too), restored after */
  function warm(scene: THREE.Object3D, fn: () => void) {
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
    });
    try {
      fn();
    } finally {
      for (const o of culled) o.frustumCulled = true;
    }
  }
  return {
    stats,
    setAo(mode) {
      if (mode === aoMode) return;
      aoMode = mode;
      composer.setSize(size.x, size.y); // re-sizes the AO's targets for the mode
    },
    targets: () => [sceneRT, composer.renderTarget1, composer.renderTarget2, ...(ldrRT ? [ldrRT] : []), ...(aoMode === "off" ? [] : [g.gtaoRenderTarget, g.pdRenderTarget, g.normalRenderTarget]), ...(bloom ? (bloom as unknown as { renderTargetsHorizontal: THREE.WebGLRenderTarget[]; renderTargetsVertical: THREE.WebGLRenderTarget[]; renderTargetBright: THREE.WebGLRenderTarget }).renderTargetsHorizontal.concat((bloom as unknown as { renderTargetsVertical: THREE.WebGLRenderTarget[] }).renderTargetsVertical) : [])],
    render(scene, camera, focus) {
      const ms = draw(scene, camera, focus);
      stats.frames++;
      stats.frameMs += (ms - stats.frameMs) / Math.min(stats.frames, 120);
    },
    async prepare(scene, camera, focus) {
      environment(scene);
      // the generated textures and the field from the last visit of this build (envcache.ts)
      const cache = opts.cacheStamp && layers.size && !envScenes.has(scene) ? await openEnvCache(opts.cacheStamp) : undefined;
      if (cache) envDeps.cache = cache;
      envFor(scene);
      if (cache) {
        stats.envCache = { hits: cache.hits, misses: cache.misses };
        void cache.save(); // behind: the first frame doesn't wait for the write
        envDeps.cache = undefined;
      }
      // every material's program, frustum or not (compileAsync: in parallel where KHR_parallel_shader_compile is there)
      await renderer.compileAsync(scene, camera);
      // the passes' own programs, and one frame with nothing culled: the driver's pipelines for every
      // mesh in every pass (ANGLE builds a Vulkan / D3D pipeline per program, vertex layout and
      // target at its first draw: 100-1500 ms stalls the first time the fly-over or a turn showed
      // a mesh); under the loading screen
      if (opts.warm === false) draw(scene, camera, focus);
      else warm(scene, () => draw(scene, camera, focus));
    },
    restrict(want, grassDensity) {
      const keep = new Set(want);
      for (const l of [...layers]) if (!keep.has(l)) layers.delete(l);
      envDeps.grassDensity = grassDensity;
      for (const e of built) e.restrict(layers, grassDensity);
      if (bloom && bloomOn && !keep.has("bloom")) {
        bloomOn = false;
        bloom.enabled = false;
      }
      if (gradeOn && !keep.has("grade")) gradeOn = false;
      stats.envLayers = built.at(-1)?.layers ?? [];
    },
    setSize(w, h, pixelRatio) {
      size.set(w, h);
      sceneRT.setSize(Math.max(1, Math.floor(w * pixelRatio)), Math.max(1, Math.floor(h * pixelRatio)));
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
    },
  };
}
