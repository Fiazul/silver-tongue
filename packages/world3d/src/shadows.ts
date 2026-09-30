// The real look's sun shadow (README "Shadows"), steady while the player walks:
//   - the box: an ortho box round the player whose centre is snapped, in the light's own frame, to
//     whole shadow texels (snapShadowBox; the light never turns per frame), so a map redrawn after
//     the box moved samples the static world at the same texel positions: no edge shimmer;
//   - two layers in one map: the static casters (the town, the trees' crowns) drawn into a cached
//     depth target only when the sun, the box or the static set changes, and the animated casters
//     (every top-level root holding a skinned mesh, or flagged userData.dynamicShadow: the player,
//     NPCs, walkers, pets and what they hold) drawn on top every frame one of them moves (every
//     `every` frames while they only animate in place): the player's own shadow never lags them;
//   - the box's edge fades (SHADOW_EDGE, a patch of three's lights chunk) instead of cutting off;
//   - the bias in world units, from the texel size (shadowBias).
// SunShadow.draw plans the frame's redraw just before the scene's render (reallook.ts); the passes
// run inside that render's own shadow pass (hookShadowPass). The light's shadow.autoUpdate stays
// off, so three never redraws the map by itself.
import * as THREE from "three";

/** the shadow-map texel's size (m) of a square ortho box `half` m either side, drawn at `mapSize` */
export const shadowTexel = (half: number, mapSize: number) => (2 * half) / mapSize;

/** Matrix4.lookAt's frame for a light at `dir` (unit, target -> light) with up +y: x = up x z, y = z x x */
export function lightBasis(dir: THREE.Vector3): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const z = dir.clone().normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return { x, y, z };
}

/**
 * The shadow box's centre for a focus `p`: its light-space coordinates rounded to `step` (a whole
 * number of texels, at least one: `cell` m rounded to texels), the world target and the key the
 * static cache is valid for.
 */
export function snapShadowBox(p: THREE.Vector3, dir: THREE.Vector3, half: number, mapSize: number, cell: number, target = new THREE.Vector3()) {
  const { x, y, z } = lightBasis(dir);
  const texel = shadowTexel(half, mapSize);
  const texels = Math.max(1, Math.round(cell / texel));
  const step = texels * texel;
  const snap = (v: number) => Math.round(v / step) * texels;
  const i = [snap(p.dot(x)), snap(p.dot(y)), snap(p.dot(z))];
  target.copy(x).multiplyScalar(i[0] * texel).addScaledVector(y, i[1] * texel).addScaledVector(z, i[2] * texel);
  return { target, texel, step, texels: i, key: i.join(",") };
}

/**
 * The sun shadow's bias in world units: normalBias 1.5 texels (the receiver pushed off along its
 * normal: no acne on slopes at any map size), the depth bias a fixed 1.5 cm (a large one lifts the
 * shadow off the feet: peter-panning), as the depth range's fraction three wants.
 */
export function shadowBias(half: number, mapSize: number, near: number, far: number) {
  const normalBias = 1.5 * shadowTexel(half, mapSize);
  return { bias: -SHADOW_DEPTH_BIAS_M / (far - near), normalBias, texel: shadowTexel(half, mapSize) };
}
/** m: the depth bias (shadowBias) */
export const SHADOW_DEPTH_BIAS_M = 0.015;

/**
 * The fraction (of the box's width, from each edge) over which the shadow fades out toward the
 * box's edge: 0.12 of 44 m is 5.3 m, starting 11 m past the focus at the least (the focus is within
 * half a SHADOW_CELL of the centre).
 */
export const SHADOW_EDGE = 0.12;
/** 1 inside the box's inner part, easing to 0 at its edge (the GLSL in patchShadowEdge; shadow coord in [0, 1]) */
export function shadowEdgeFade(u: number, v: number, edge = SHADOW_EDGE): number {
  const e = Math.min(u, 1 - u, v, 1 - v);
  const t = Math.max(0, Math.min(1, e / edge));
  return t * t * (3 - 2 * t);
}

let edgePatched = false;
/** three's lights chunk: the directional lights' shadow faded toward the box's edge (once; before any real-look program compiles) */
export function patchShadowEdge() {
  if (edgePatched) return;
  edgePatched = true;
  const pars = THREE.ShaderChunk.shadowmap_pars_fragment;
  THREE.ShaderChunk.shadowmap_pars_fragment = `${pars}
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
float sunShadowEdge( vec4 c ) {
  float e = min( min( c.x, 1.0 - c.x ), min( c.y, 1.0 - c.y ) );
  return smoothstep( 0.0, ${SHADOW_EDGE.toFixed(4)}, e );
}
#endif
`;
  const from = "getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )";
  const begin = THREE.ShaderChunk.lights_fragment_begin;
  if (!begin.includes(from)) throw new Error("shadows.ts: three's lights_fragment_begin changed (the sun shadow's edge fade)");
  THREE.ShaderChunk.lights_fragment_begin = begin.replace(from, `mix( 1.0, ${from}, sunShadowEdge( vDirectionalShadowCoord[ i ] ) )`);
}

/**
 * When each layer redraws: the static layer at once when the sun (LookSky.version), the box
 * (snapShadowBox key) or the static set (its key) changed, else never: a still town keeps it. The
 * casters layer with every static redraw, every frame a caster moved (`moving`: translated or
 * turned), else every `every` frames while casters only animate in place (`animated`).
 */
export class ShadowScheduler {
  private sun = NaN;
  private box = "";
  private statics = "";
  private lastCasters = -Infinity;
  private frame = 0;
  /** static-layer redraws */
  updates = 0;
  /** frames the animated casters' shadow was redrawn (with the static layer or alone) */
  casterUpdates = 0;
  frames = 0;
  constructor(public every: number) {}

  due(sunVersion: number, boxKey: string, staticKey: string, moving: boolean, animated: boolean): { statics: boolean; casters: boolean } {
    const f = this.frame++;
    this.frames++;
    const statics = sunVersion !== this.sun || boxKey !== this.box || staticKey !== this.statics;
    const casters = statics || moving || (animated && f - this.lastCasters >= this.every);
    if (statics) {
      this.sun = sunVersion;
      this.box = boxKey;
      this.statics = staticKey;
      this.updates++;
    }
    if (casters) {
      this.lastCasters = f;
      this.casterUpdates++;
    }
    return { statics, casters };
  }
}

/** a top-level root that animates: flagged, or holding a skinned mesh (an actor) */
function isAnimated(o: THREE.Object3D): boolean {
  if (o.userData.dynamicShadow) return true;
  let skinned = false;
  o.traverse((c) => {
    if ((c as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  return skinned;
}

type Pose = { p: THREE.Vector3; q: THREE.Quaternion };
type ShadowPass = (lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera) => void;

/** the scenes with a redraw planned this frame (SunShadow.draw), taken by the next shadow pass of that scene */
const PENDING = new WeakMap<THREE.Object3D, { sun: SunShadow; dyn: THREE.Object3D[]; statics: boolean }>();
const HOOKED = new WeakSet<object>();
/**
 * The renderer's shadow pass, wrapped once: a scene's first render of the frame (the colour pass;
 * the AO's normal pass after it finds nothing pending) runs its SunShadow's layers first, inside
 * three's render (its render state, programs and lights), then three's own pass (which skips the
 * sun: its shadow.needsUpdate is false again).
 */
function hookShadowPass(renderer: THREE.WebGLRenderer) {
  const sm = renderer.shadowMap as unknown as { render: ShadowPass };
  if (HOOKED.has(sm)) return;
  HOOKED.add(sm);
  const pass = sm.render.bind(sm);
  sm.render = (lights, scene, camera) => {
    const p = PENDING.get(scene);
    if (p) {
      PENDING.delete(scene);
      p.sun.redraw(renderer, pass, scene, camera, p.dyn, p.statics);
    }
    pass(lights, scene, camera);
  };
}

/**
 * The two-layer sun shadow of one space (see the header). `aim` each frame with the box
 * (world.ts followSun), `draw` before the scene's render.
 */
export class SunShadow {
  readonly plan: ShadowScheduler;
  private box = "";
  private sunVersion = 0;
  private staticRT: THREE.WebGLRenderTarget | null = null;
  private readonly kind = new WeakMap<THREE.Object3D, boolean>();
  private readonly poses = new Map<THREE.Object3D, Pose>();
  private readonly holder = new THREE.Object3D();
  /** the merge: one full-screen triangle (its own: Pass.js stays in the real look's chunk) */
  private merge: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private readonly mergeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly light: THREE.DirectionalLight, every: number) {
    this.plan = new ShadowScheduler(every);
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = false;
  }

  /** this frame's box (snapShadowBox key) and sun (LookSky.version) */
  aim(boxKey: string, sunVersion: number) {
    this.box = boxKey;
    this.sunVersion = sunVersion;
  }

  /**
   * Plans this frame's redraw (before the scene's render); the passes themselves run inside
   * three's own shadow pass of that render (hookShadowPass: three draws only inside a render call).
   */
  draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene, _camera?: THREE.Camera) {
    if (!renderer.shadowMap.enabled || !this.light.castShadow || !this.light.parent) return;
    // the animated roots (top-level), and whether one moved since the last frame
    const dyn: THREE.Object3D[] = [];
    let statics = 0;
    let moving = false;
    for (const o of scene.children) {
      let k = this.kind.get(o);
      if (k === undefined) {
        k = isAnimated(o);
        this.kind.set(o, k);
      }
      if (!k) {
        statics++;
        continue;
      }
      if (!o.visible) continue;
      dyn.push(o);
      const pose = this.poses.get(o);
      if (!pose) {
        this.poses.set(o, { p: o.position.clone(), q: o.quaternion.clone() });
        moving = true;
      } else if (pose.p.distanceToSquared(o.position) > 1e-8 || Math.abs(pose.q.dot(o.quaternion)) < 1 - 1e-9) {
        pose.p.copy(o.position);
        pose.q.copy(o.quaternion);
        moving = true;
      }
    }
    if (this.poses.size > dyn.length) for (const o of this.poses.keys()) if (!dyn.includes(o)) this.poses.delete(o);
    const due = this.plan.due(this.sunVersion, this.box, String(statics), moving, dyn.length > 0);
    if (!due.statics && !due.casters) return;
    hookShadowPass(renderer);
    this.primeMerge(renderer);
    const prev = PENDING.get(scene);
    PENDING.set(scene, { sun: this, dyn, statics: due.statics || (prev?.statics ?? false) });
  }

  /** inside three's shadow pass (`pass`: the renderer's own, perf.ts's timer round it under ?perf=1) */
  redraw(renderer: THREE.WebGLRenderer, pass: ShadowPass, scene: THREE.Object3D, camera: THREE.Camera, dyn: THREE.Object3D[], statics: boolean) {
    const light = this.light;
    const shadow = light.shadow;
    // this frame's transforms and poses (already the scene's; cheap, and the bones of casters out of the camera's view too)
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    for (const o of dyn) {
      o.updateMatrixWorld();
      o.traverse((c) => (c as THREE.SkinnedMesh).isSkinnedMesh && (c as THREE.SkinnedMesh).skeleton.update());
    }
    const size = shadow.mapSize;
    if (!this.staticRT || this.staticRT.width !== size.x || this.staticRT.height !== size.y) {
      this.staticRT?.dispose();
      const depth = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
      depth.minFilter = depth.magFilter = THREE.NearestFilter;
      // the colour attachment is never drawn (the passes write depth only): one byte a texel
      this.staticRT = new THREE.WebGLRenderTarget(size.x, size.y, { depthTexture: depth, depthBuffer: true, format: THREE.RedFormat, generateMipmaps: false });
      statics = true;
    }
    if (statics) {
      // the static layer, into its own target: the animated roots hidden, the light's map swapped for it
      const map = shadow.map;
      for (const o of dyn) o.visible = false;
      shadow.map = this.staticRT;
      shadow.needsUpdate = true;
      try {
        pass([light], scene, camera);
      } finally {
        // three replaces a map it can't use (a shadow type change): keep what it drew, sampled plainly
        if (shadow.map !== this.staticRT && shadow.map?.depthTexture) {
          this.staticRT = shadow.map as THREE.WebGLRenderTarget;
          const d = shadow.map.depthTexture;
          d.compareFunction = null;
          d.minFilter = d.magFilter = THREE.NearestFilter;
          d.needsUpdate = true;
        }
        shadow.map = map;
        for (const o of dyn) o.visible = true;
      }
    }
    // the casters alone into the light's map (cleared), then the static layer's depth merged in (the nearer wins)
    this.holder.children = dyn;
    shadow.needsUpdate = true;
    try {
      pass([light], this.holder, camera);
    } finally {
      this.holder.children = [];
      shadow.needsUpdate = false;
    }
    if (!shadow.map) return;
    const merge = this.mergePass(renderer);
    merge.material.uniforms.tStatic.value = this.staticRT!.depthTexture;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(shadow.map as THREE.WebGLRenderTarget);
    try {
      renderer.renderBufferDirect(this.mergeCamera, null as unknown as THREE.Scene, merge.geometry, merge.material, merge, null as unknown as THREE.GeometryGroup);
    } finally {
      renderer.setRenderTarget(target);
    }
  }

  /**
   * The merge draws with renderBufferDirect inside the shadow pass, which binds the geometry's
   * buffers but never uploads them (a render's object update does): one render of the triangle
   * first, outside any render, into a 1 x 1 target.
   */
  private primeMerge(renderer: THREE.WebGLRenderer) {
    if (this.merge) return;
    const merge = this.mergePass(renderer);
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    try {
      renderer.render(merge, this.mergeCamera);
    } finally {
      renderer.setRenderTarget(prev);
      rt.dispose();
    }
  }

  private mergePass(renderer: THREE.WebGLRenderer) {
    if (this.merge) return this.merge;
    const reversed = renderer.state.buffers.depth.getReversed();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const m = new THREE.ShaderMaterial({
      name: "sunShadowMerge",
      uniforms: { tStatic: { value: null } },
      vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D tStatic;\nvarying vec2 vUv;\nvoid main() { gl_FragDepth = texture2D(tStatic, vUv).r; gl_FragColor = vec4(1.0); }",
      depthTest: true,
      depthWrite: true,
      depthFunc: reversed ? THREE.GreaterEqualDepth : THREE.LessEqualDepth,
      colorWrite: false,
      blending: THREE.NoBlending,
    });
    this.merge = new THREE.Mesh(g, m);
    this.merge.frustumCulled = false;
    return this.merge;
  }

  dispose() {
    this.staticRT?.dispose();
    this.merge?.geometry.dispose();
    this.merge?.material.dispose();
  }
}
