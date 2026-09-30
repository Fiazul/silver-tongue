// See-through: a stencil-masked character silhouette records the ids of static triangles in front
// of each focus. Mesh AABBs were too coarse for canopies, eaves and small props. A one-row texture
// eases each hit root into the existing whole-object ordered-dither cutout.
import * as THREE from "three";

export const SEE_THROUGH = {
  sampleSize: 96,
  /** an object fades once it covers this fraction of a focus's silhouette ("more than 40 % blocked") */
  coverFraction: 0.4,
  /** a faded object is released only once its coverage drops below this (hysteresis, no flicker) */
  releaseFraction: 0.3,
  /** floor: fewer covered pixels never fade, whatever the fraction (a far, tiny silhouette) */
  minPixels: 6,
  holdSeconds: 0.35,
  /** visibility of an occluding object */
  fadeTo: 0.13,
  /** 1/s, easing into and out of a fade */
  fadeRate: 4,
  /** bounded texture/id table for one space */
  maxOccluders: 1024,
};

export const SEE_ATTR = "seeThru";
export const SEE_NEVER = 0;
/** An unassigned fadeable root; SceneSpace replaces this with SEE_ID0 + id. */
export const SEE_OCCLUDER = 1;
export const SEE_ID0 = 2;

/** Canopy parts that share their root's occluder id; all other parts remain SEE_NEVER. */
export const CANOPIES: Record<string, { parts: RegExp; above?: number }> = {
  great_tree: { parts: /^(canopy_green|leaf_green|leaf_dark)$/, above: 3.4 },
  willow: { parts: /^(leaf_green|leaf_pale|town_willow)$/ },
  willow_small: { parts: /^(leaf_green|leaf_pale|town_willow)$/ },
  bamboo_grove: { parts: /^(leaf_green|leaf_dark)$/ },
};

export interface SeeSpec {
  tag: number;
  /** the root's world y, used by the great tree's `above` rule */
  baseY?: number;
}

const GROUND_SETS = new Set(["tiles", "landscape"]);
const FLAT = /^(road_|pavement_|manhole|drain_grate|decal_)/;

/** Classifies an asset before SceneSpace assigns fadeable roots an id. */
export function seeSpecFor(set: string | undefined, name: string): SeeSpec {
  return { tag: (set && GROUND_SETS.has(set)) || FLAT.test(name) ? SEE_NEVER : SEE_OCCLUDER };
}

function partName(mesh: THREE.Mesh): string {
  const src = mesh.userData.outline && (mesh.parent as THREE.Mesh | null)?.isMesh ? (mesh.parent as THREE.Mesh) : mesh;
  const m = src.material as THREE.Material | THREE.Material[];
  return Array.isArray(m) ? "" : m.name;
}

/** Builds the per-vertex root id for a static mesh (world-space when copied into a batch). */
export function seeAttribute(geo: THREE.BufferGeometry, mesh: THREE.Mesh, spec: SeeSpec | undefined, rootAsset: string | undefined, world: boolean): THREE.BufferAttribute {
  const n = geo.getAttribute("position").count;
  const canopy = rootAsset ? CANOPIES[rootAsset] : undefined;
  if (!canopy) return new THREE.BufferAttribute(new Float32Array(n).fill(spec?.tag ?? SEE_NEVER), 1);

  const out = new Float32Array(n).fill(SEE_NEVER);
  if (!spec || spec.tag < SEE_ID0) return new THREE.BufferAttribute(out, 1);
  if (canopy.parts.test(partName(mesh))) out.fill(spec.tag);
  else if (canopy.above !== undefined) {
    const pos = geo.getAttribute("position");
    const v = new THREE.Vector3();
    const cut = (spec.baseY ?? 0) + canopy.above;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      if (!world) v.applyMatrix4(mesh.matrixWorld);
      if (v.y > cut) out[i] = spec.tag;
    }
  }
  return new THREE.BufferAttribute(out, 1);
}

const fadeData = new Float32Array(SEE_THROUGH.maxOccluders).fill(1);
export const fadeTexture = new THREE.DataTexture(fadeData, SEE_THROUGH.maxOccluders, 1, THREE.RedFormat, THREE.FloatType);
fadeTexture.minFilter = THREE.NearestFilter;
fadeTexture.magFilter = THREE.NearestFilter;
fadeTexture.generateMipmaps = false;
fadeTexture.needsUpdate = true;

/** One uniform set shared by every patched material. */
export const seeUniforms = { stFade: { value: fadeTexture } };

export const SEE_VERT_PARS = /* glsl */ `
attribute float ${SEE_ATTR};
varying float vStId;
`;

export const SEE_VERT = /* glsl */ `
  vStId = ${SEE_ATTR};
`;

export const SEE_FRAG_PARS = /* glsl */ `
uniform sampler2D stFade;
varying float vStId;
float stBayer(vec2 p) {
  ivec2 i = ivec2(mod(floor(p), 4.0));
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}
void stSeeThrough() {
  if (vStId < 1.5) return;
  float x = (floor(vStId + 0.5) - 1.5) / ${SEE_THROUGH.maxOccluders.toFixed(1)};
  float vis = texture2D(stFade, vec2(x, 0.5)).r;
  if (vis < 0.999 && vis <= stBayer(gl_FragCoord.xy)) discard;
}
`;

export const SEE_FRAG = /* glsl */ `
  stSeeThrough();
`;

function inject(src: string, anchor: string, add: string, before = false): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`see-through: no "${anchor}" in the shader`);
  return before ? src.slice(0, i) + add + src.slice(i) : src.slice(0, i + anchor.length) + add + src.slice(i + anchor.length);
}

export function seeThroughCompile(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  Object.assign(shader.uniforms, seeUniforms);
  shader.vertexShader = inject(inject(shader.vertexShader, "void main() {", SEE_VERT_PARS, true), "#include <project_vertex>", SEE_VERT);
  shader.fragmentShader = inject(inject(shader.fragmentShader, "void main() {", SEE_FRAG_PARS, true), "#include <clipping_planes_fragment>", SEE_FRAG);
}

const patched = new WeakSet<THREE.Material>();

export function isSeeThrough(m: THREE.Material): boolean {
  return patched.has(m);
}

export function patchSeeThrough<M extends THREE.Material>(m: M): M {
  if (patched.has(m) || m.transparent) return m;
  m.onBeforeCompile = seeThroughCompile as THREE.Material["onBeforeCompile"];
  m.customProgramCacheKey = () => "see-through-objects";
  markSeeThrough(m);
  return m;
}

export function markSeeThrough(m: THREE.Material) {
  const d = m as THREE.Material & { defaultAttributeValues?: Record<string, number[]> };
  d.defaultAttributeValues = { ...(d.defaultAttributeValues ?? {}), [SEE_ATTR]: [SEE_NEVER] };
  patched.add(m);
}

export interface Occluder {
  id: number;
  asset: string;
}

/** A small crop of the actual camera projection, including portrait camera offsets. */
export function silhouetteProjection(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, width: number, height: number): THREE.Matrix4 {
  const centre = focus.clone().add(new THREE.Vector3(0, 1, 0)).project(camera);
  const extent = new THREE.Vector3(0.6, 1.3, 0).add(focus).project(camera);
  const extent2 = new THREE.Vector3(-0.6, 0, 0).add(focus).project(camera);
  const halfW = Math.max(24, Math.abs(extent2.x - centre.x) * width / 2 + 24);
  const halfH = Math.max(24, Math.abs(extent.y - centre.y) * height / 2 + 24);
  const sx = width / (2 * halfW);
  const sy = height / (2 * halfH);
  return new THREE.Matrix4().set(sx, 0, 0, -centre.x * sx, 0, sy, 0, -centre.y * sy, 0, 0, 1, 0, 0, 0, 0, 1).multiply(camera.projectionMatrix);
}

/**
 * The reserved RG code the character's proxy writes before the occluders: a silhouette pixel that
 * nothing covers. Occluder codes are id + 1 (at most maxOccluders), so they never reach it.
 */
export const SEE_SILHOUETTE_CODE = 0xffff;

/** One pass's result for one focus. */
export interface SeeSample {
  /** every pixel of the focus's silhouette, covered or not */
  silhouette: number;
  /** per occluder id: the silhouette pixels it is the front-most cover of */
  covered: ReadonlyMap<number, number>;
}

export const EMPTY_SAMPLE: SeeSample = Object.freeze({ silhouette: 0, covered: new Map() });

/**
 * Extracts the silhouette and per-root coverage from the RGB id target. Code zero means untouched,
 * SEE_SILHOUETTE_CODE an uncovered silhouette pixel, anything else a root id + 1. The id pass is
 * stencil-masked to the silhouette, so every covered pixel is also a silhouette pixel.
 */
export function idHistogram(pixels: Uint8Array): SeeSample {
  const covered = new Map<number, number>();
  let silhouette = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const encoded = pixels[i] + 256 * pixels[i + 1];
    if (!encoded) continue;
    silhouette++;
    if (encoded !== SEE_SILHOUETTE_CODE) covered.set(encoded - 1, (covered.get(encoded - 1) ?? 0) + 1);
  }
  return { silhouette, covered };
}

/** The fraction of the silhouette an id covers (0 for an empty silhouette). */
export function coverage(sample: SeeSample, id: number): number {
  return sample.silhouette > 0 ? (sample.covered.get(id) ?? 0) / sample.silhouette : 0;
}

const idMaterial = new THREE.ShaderMaterial({
  vertexShader: `attribute float ${SEE_ATTR}; varying float vId; void main() { vId = ${SEE_ATTR}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying float vId; void main() { if (vId < 1.5) discard; float n = floor(vId - 1.0); gl_FragColor = vec4(mod(n, 256.0) / 255.0, floor(n / 256.0) / 255.0, 0.0, 1.0); }`,
  depthWrite: true,
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.EqualStencilFunc,
  stencilFail: THREE.KeepStencilOp,
  stencilZFail: THREE.KeepStencilOp,
  stencilZPass: THREE.KeepStencilOp,
});
const idMaterials = new Map<THREE.Side, THREE.ShaderMaterial>([[THREE.FrontSide, idMaterial]]);
function idMaterialFor(side: THREE.Side): THREE.ShaderMaterial {
  let material = idMaterials.get(side);
  if (!material) {
    material = idMaterial.clone();
    material.side = side;
    idMaterials.set(side, material);
  }
  return material;
}
/** The capsule stand-in for the character: depth, stencil, and the reserved silhouette code. */
const proxyMaterial = new THREE.ShaderMaterial({
  vertexShader: `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `void main() { gl_FragColor = vec4(${((SEE_SILHOUETTE_CODE & 255) / 255).toFixed(1)}, ${((SEE_SILHOUETTE_CODE >> 8) / 255).toFixed(1)}, 0.0, 1.0); }`,
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.AlwaysStencilFunc,
  stencilFail: THREE.KeepStencilOp,
  stencilZFail: THREE.KeepStencilOp,
  stencilZPass: THREE.ReplaceStencilOp,
});

/** One small render per focus. Static meshes reuse the already batched geometry. */
interface DetectionPose {
  focus: THREE.Vector3;
  camera: THREE.Vector3;
  rotation: THREE.Quaternion;
  projection: number[];
}

interface PendingRead {
  buffer: WebGLBuffer;
  fence: WebGLSync;
  pixels: Uint8Array;
  generation: number;
  /** performance.now() when the read was queued */
  queuedAt: number;
}

/**
 * Wall-clock budget for a fence (animation frames are no time base: a slow or throttled frame
 * rate stretched a frame-count budget into seconds). Past it the read is dropped, the pass re-runs.
 */
export const FENCE_TIMEOUT_MS = 400;
/**
 * The freshness the async read keeps on a GPU that signals its fences a frame or two later: a
 * fresh sample at least this often while walking (a test holds it). Nothing enforces it by
 * blocking: the read is never synchronous (a sync read waits for the whole GPU queue, 100-1400 ms
 * frames on the Vega 11); a slot without a result has no evidence and its fades run out their hold.
 */
export const MAX_SAMPLE_AGE_MS = 250;
/** Consecutive async-read failures (timeouts, throws) that pause the pass for ASYNC_RETRY_MS. */
export const ASYNC_MAX_FAILURES = 3;
/** ms the pass rests after ASYNC_MAX_FAILURES failures (or a failed wait) before it tries again */
export const ASYNC_RETRY_MS = 2000;

/** Per-slot bookkeeping: freshness of `latest[slot]` and the async read's health. */
interface SlotState {
  /** `latest[slot]` predates the slot's current pose (a newer pass is in flight or was dropped) */
  stale: boolean;
  /** a fresh result arrived that current() has not handed out yet */
  unconsumed: boolean;
  /** performance.now() of the last fresh result, null if none since the last invalidate */
  freshAt: number | null;
  /** performance.now() since which the slot has had no valid result (it went stale then) */
  staleSince: number;
  timeouts: number;
  /** passes rendered for this slot (each read back asynchronously) */
  passes: number;
  /** why sample() ran no pass: a read in flight, nothing moved, not a sampled frame (skip()), or no async read here (no WebGL2 fences, or resting after failures) */
  skipped: { pending: number; unmoved: number; cadence: number; unavailable: number };
}

export interface SeeSlotDebug {
  slot: number;
  pending: boolean;
  timeouts: number;
  /** the async read is resting after failures (or the context has none): no passes until it retries */
  asyncPaused: boolean;
  lastSampleAgeMs: number | null;
  /** passes rendered for this slot since the detector was made */
  passes: number;
  /** calls that ran no pass, by reason (cumulative): all frozen while walking means sample() is not reached */
  skipped: { pending: number; unmoved: number; cadence: number; unavailable: number };
  /** the silhouette pixel count of the slot's last result (null: none since the last invalidate) */
  silhouettePixels: number | null;
}

export class SeeThroughDetector {
  private readonly target = new THREE.WebGLRenderTarget(SEE_THROUGH.sampleSize, SEE_THROUGH.sampleSize, { stencilBuffer: true, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private readonly latest: SeeSample[] = [];
  private readonly pending = new Map<number, PendingRead>();
  private readonly poses = new Map<number, DetectionPose>();
  private readonly slots = new Map<number, SlotState>();
  private readonly gl?: WebGL2RenderingContext;
  private generation = 0;
  lastSampleMs = 0;
  lastReadMs = 0;
  /** performance.now() until which the async read rests (failures); 0: not resting */
  private pausedUntil = 0;
  /** consecutive async-read failures on this context; reset by any applied async read */
  private asyncFailures = 0;
  private warned = false;
  private warnedPause = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly proxy = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.1, 4, 8), proxyMaterial);
  private source?: THREE.Scene;
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    // WebGL2 only (three 0.186 needs it anyway): a context without fences or pixel-pack buffers runs no pass at all (no fades), never a sync read.
    const gl = renderer.getContext?.() as Partial<WebGL2RenderingContext> | undefined;
    if (typeof gl?.fenceSync === "function" && typeof gl.clientWaitSync === "function" && typeof gl.getBufferSubData === "function") this.gl = gl as WebGL2RenderingContext;
    this.target.viewport.set(0, 0, SEE_THROUGH.sampleSize, SEE_THROUGH.sampleSize);
    this.target.scissor.set(0, 0, SEE_THROUGH.sampleSize, SEE_THROUGH.sampleSize);
    this.target.scissorTest = true;
    this.proxy.renderOrder = -1;
    this.scene.add(this.proxy);
  }

  /** Rebuild on space change; source geometry and batches are shared, never split. */
  private bind(source: THREE.Scene) {
    if (this.source === source) return;
    this.source = source;
    this.invalidate();
    for (const child of [...this.scene.children]) if (child !== this.proxy) this.scene.remove(child);
    source.updateMatrixWorld(true);
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.outline || !mesh.geometry.hasAttribute(SEE_ATTR)) return;
      const tags = mesh.geometry.getAttribute(SEE_ATTR).array;
      if (!Array.from(tags).some((tag) => tag >= SEE_ID0)) return;
      const sourceMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const copy = new THREE.Mesh(mesh.geometry, idMaterialFor(sourceMaterial.side));
      copy.matrix.copy(mesh.matrixWorld);
      copy.matrixAutoUpdate = false;
      copy.frustumCulled = mesh.frustumCulled;
      this.scene.add(copy);
    });
  }

  private slot(slot: number): SlotState {
    let s = this.slots.get(slot);
    if (!s) this.slots.set(slot, (s = { stale: true, unconsumed: false, freshAt: null, staleSince: performance.now(), timeouts: 0, passes: 0, skipped: { pending: 0, unmoved: 0, cadence: 0, unavailable: 0 } }));
    return s;
  }

  /** A fresh result for the slot's remembered pose. */
  private apply(slot: number, pixels: Uint8Array) {
    this.latest[slot] = idHistogram(pixels);
    const s = this.slot(slot);
    s.stale = false;
    s.unconsumed = true;
    s.freshAt = performance.now();
  }

  /** The slot's pose no longer has a result coming: the next sample() runs a pass even if unmoved. */
  private drop(slot: number) {
    this.pending.delete(slot);
    this.poses.delete(slot);
    this.slot(slot).stale = true;
  }

  /** Three in a row rest the pass for ASYNC_RETRY_MS (never a sync read), then it tries again. */
  private asyncFailed(why: string) {
    if (!this.warned) {
      this.warned = true;
      console.warn(`see-through: async read ${why}; the pass re-runs`);
    }
    if (++this.asyncFailures >= ASYNC_MAX_FAILURES) this.pause(`${ASYNC_MAX_FAILURES} async reads failed in a row`);
  }

  private pause(why: string) {
    if (!this.warnedPause) {
      this.warnedPause = true;
      console.warn(`see-through: ${why}; resting ${ASYNC_RETRY_MS} ms at a time (no sync read)`);
    }
    this.pausedUntil = performance.now() + ASYNC_RETRY_MS;
    this.asyncFailures = 0;
  }

  /** the async read can run now (a WebGL2 context, not resting) */
  private asyncReady(): boolean {
    if (!this.gl) return false;
    if (this.pausedUntil && performance.now() < this.pausedUntil) return false;
    this.pausedUntil = 0;
    return true;
  }

  /** Drop decisions from the previous space or a teleport, including in-flight GPU reads. */
  invalidate() {
    this.generation++;
    this.latest.length = 0;
    this.poses.clear();
    for (const read of this.pending.values()) this.release(read);
    this.pending.clear();
    const now = performance.now();
    for (const s of this.slots.values()) Object.assign(s, { stale: true, unconsumed: false, freshAt: null, staleSince: now });
  }

  invalidateSlot(slot: number) {
    this.latest[slot] = EMPTY_SAMPLE;
    const read = this.pending.get(slot);
    if (read) this.release(read);
    this.drop(slot);
    const s = this.slot(slot);
    s.unconsumed = false;
    s.freshAt = null;
    s.staleSince = performance.now();
  }

  private release(read: PendingRead) {
    try {
      this.gl?.deleteSync(read.fence);
    } finally {
      this.gl?.deleteBuffer(read.buffer);
    }
  }

  /**
   * Polls without waiting for the GPU. main.ts calls it at the top of every animation frame and
   * sample() calls it for its own slot, so a read that landed is used before a pass is judged stuck.
   */
  poll() {
    for (const slot of [...this.pending.keys()]) this.pollSlot(slot);
  }

  private pollSlot(slot: number) {
    const gl = this.gl;
    const read = this.pending.get(slot);
    if (!gl || !read) return;
    const started = performance.now();
    // Every exit below leaves the slot either still pending (fence not yet signalled, inside
    // FENCE_TIMEOUT_MS) or not pending with its read released; nothing can wedge the slot's pass.
    let done = true;
    try {
      const state = gl.clientWaitSync(read.fence, 0, 0);
      if (state === gl.TIMEOUT_EXPIRED) {
        const waited = started - read.queuedAt;
        if (waited < FENCE_TIMEOUT_MS) {
          done = false;
          return;
        }
        this.slot(slot).timeouts++;
        this.drop(slot);
        this.asyncFailed(`fence unsignalled after ${Math.round(waited)} ms`);
        return;
      }
      if (state === gl.WAIT_FAILED) {
        this.drop(slot);
        this.pause("a fence wait failed");
        return;
      }
      if (read.generation !== this.generation) {
        this.drop(slot);
        return;
      }
      const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, read.pixels);
      } finally {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
      }
      this.pending.delete(slot);
      this.apply(slot, read.pixels);
      this.asyncFailures = 0;
    } catch (error) {
      this.drop(slot);
      this.asyncFailed(`poll threw (${(error as Error)?.message ?? error})`);
    } finally {
      if (done) {
        if (this.pending.get(slot) === read) this.drop(slot);
        this.release(read);
        this.lastReadMs = performance.now() - started;
      }
    }
  }

  /** The slot's last result, whether or not it still describes the present pose (debug and tests). */
  counts(slot: number): SeeSample {
    return this.latest[slot] ?? EMPTY_SAMPLE;
  }

  /**
   * The sample the fade may act on: a fresh result (once, even if a newer pass was queued in the
   * same frame), or the last result while neither focus nor camera has moved since it was taken.
   * Otherwise null (no evidence this frame), so a reused result never extends a hold.
   */
  current(slot: number): SeeSample | null {
    const s = this.slots.get(slot);
    if (!s) return null;
    const usable = s.unconsumed || !s.stale;
    s.unconsumed = false;
    return usable ? this.latest[slot] ?? EMPTY_SAMPLE : null;
  }

  /** Per-slot async state for world3d.seeThrough(). */
  debug(): SeeSlotDebug[] {
    const now = performance.now();
    return [...this.slots.entries()].sort(([a], [b]) => a - b).map(([slot, s]) => ({
      slot,
      pending: this.pending.has(slot),
      timeouts: s.timeouts,
      asyncPaused: !this.gl || (this.pausedUntil > 0 && now < this.pausedUntil),
      lastSampleAgeMs: s.freshAt === null ? null : Math.round(now - s.freshAt),
      passes: s.passes,
      skipped: { ...s.skipped },
      silhouettePixels: s.freshAt === null ? null : this.latest[slot]?.silhouette ?? null,
    }));
  }

  /** main.ts: a frame on which the slot is not sampled (every other frame); counted for debug() only. */
  skip(slot: number) {
    this.slot(slot).skipped.cadence++;
  }

  private moved(slot: number, camera: THREE.PerspectiveCamera, focus: THREE.Vector3): boolean {
    const pose = this.poses.get(slot);
    if (!pose) return true;
    if (pose.focus.distanceToSquared(focus) > 1e-4 || pose.camera.distanceToSquared(camera.position) > 1e-4) return true;
    if (pose.rotation.angleTo(camera.quaternion) > 1e-3) return true;
    return pose.projection.some((v, i) => Math.abs(v - camera.projectionMatrix.elements[i]) > 1e-5);
  }

  private remember(slot: number, camera: THREE.PerspectiveCamera, focus: THREE.Vector3) {
    this.poses.set(slot, { focus: focus.clone(), camera: camera.position.clone(), rotation: camera.quaternion.clone(), projection: [...camera.projectionMatrix.elements] });
  }

  /** Queues the async read of the pass just rendered; false if it could not be queued. */
  private queue(gl: WebGL2RenderingContext, slot: number, pixels: Uint8Array): boolean {
    const buffer = gl.createBuffer();
    if (!buffer) return false;
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    let fence: WebGLSync | null = null;
    let queued = false;
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
      gl.readPixels(0, 0, SEE_THROUGH.sampleSize, SEE_THROUGH.sampleSize, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) return false;
      gl.flush();
      this.pending.set(slot, { buffer, fence, pixels, generation: this.generation, queuedAt: performance.now() });
      queued = true;
      return true;
    } catch (error) {
      this.asyncFailed(`queue threw (${(error as Error)?.message ?? error})`);
      return false;
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
      if (!queued) {
        if (fence) gl.deleteSync(fence);
        gl.deleteBuffer(buffer);
      }
    }
  }

  sample(source: THREE.Scene, camera: THREE.PerspectiveCamera, focus: THREE.Vector3, slot = 0): SeeSample {
    this.bind(source);
    const s = this.slot(slot);
    this.pollSlot(slot);
    // A read in flight is waited for (poll drops it past FENCE_TIMEOUT_MS); never abandoned for a
    // synchronous read, which would stall the frame on the whole GPU queue.
    if (this.pending.has(slot)) {
      s.skipped.pending++;
      return this.latest[slot] ?? EMPTY_SAMPLE;
    }
    const gl = this.asyncReady() ? this.gl : undefined;
    if (!gl) {
      s.skipped.unavailable++;
      // moved meanwhile: the last result no longer vouches for this pose (current() hands out nothing)
      if (!s.stale && this.moved(slot, camera, focus)) {
        s.stale = true;
        s.staleSince = performance.now();
        this.poses.delete(slot);
      }
      return this.latest[slot] ?? EMPTY_SAMPLE;
    }
    if (!s.stale && !this.moved(slot, camera, focus)) {
      s.skipped.unmoved++;
      return this.latest[slot] ?? EMPTY_SAMPLE;
    }
    s.passes++;
    const started = performance.now();
    this.renderer.getDrawingBufferSize(this.size);
    camera.updateMatrixWorld();
    this.camera.copy(camera);
    this.camera.projectionMatrix.copy(silhouetteProjection(camera, focus, this.size.x, this.size.y));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.proxy.position.copy(focus).add(new THREE.Vector3(0, 1, 0));
    const old = this.renderer.getRenderTarget();
    const viewport = this.renderer.getViewport(new THREE.Vector4());
    const scissor = this.renderer.getScissor(new THREE.Vector4());
    const scissorTest = this.renderer.getScissorTest();
    const clearColor = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    const autoClear = this.renderer.autoClear;
    // The last result no longer describes this pose, whatever happens below; if it did until now,
    // the decision's age starts here.
    if (!s.stale) s.staleSince = started;
    s.stale = true;
    this.poses.delete(slot);
    try {
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this.target);
      // three's clear() forces the depth and stencil masks but not the colour mask, which another
      // material may have left off: a skipped colour clear would re-read old ids.
      this.renderer.state?.buffers.color.setMask(true);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      const pixels = new Uint8Array(SEE_THROUGH.sampleSize ** 2 * 4);
      // queued: its pose is remembered for the result; not queued (a throw, counted by queue()): the slot stays stale, the next sample re-runs it
      if (this.queue(gl, slot, pixels)) this.remember(slot, camera, focus);
    } finally {
      this.renderer.state?.buffers.color.setMask(true);
      this.renderer.setRenderTarget(null);
      if (old) this.renderer.setRenderTarget(old);
      this.renderer.setViewport(viewport);
      this.renderer.setScissor(scissor);
      this.renderer.setScissorTest(scissorTest);
      this.renderer.setClearColor(clearColor, clearAlpha);
      this.renderer.autoClear = autoClear;
    }
    this.lastSampleMs = performance.now() - started;
    return this.latest[slot] ?? EMPTY_SAMPLE;
  }
}

/**
 * Drives the shared fade texture from per-focus samples. An object fades when it covers at least
 * coverFraction of some focus's silhouette (and minPixels), stays wanted while it covers at least
 * releaseFraction, and a hit holds it for holdSeconds after the last one.
 */
export class SeeThroughControl {
  on = true;
  readonly vis = new Float32Array(SEE_THROUGH.maxOccluders).fill(1);
  /** each id's largest coverage fraction over the focuses, from the last frame with evidence */
  readonly cover = new Float32Array(SEE_THROUGH.maxOccluders);
  private readonly want = new Uint8Array(SEE_THROUGH.maxOccluders);
  private readonly hold = new Float32Array(SEE_THROUGH.maxOccluders);

  reset() {
    this.vis.fill(1);
    this.cover.fill(0);
    this.want.fill(0);
    this.hold.fill(0);
    fadeData.fill(1);
    fadeTexture.needsUpdate = true;
  }

  /** `samples[i]` belongs to focus i; null means no evidence for it this frame. */
  update(dt: number, focus: readonly (THREE.Vector3 | null | undefined)[], occluders: readonly Occluder[], samples: readonly (SeeSample | null | undefined)[] = [], active = true) {
    if (occluders.length > SEE_THROUGH.maxOccluders) throw new Error(`see-through: ${occluders.length} occluders exceeds ${SEE_THROUGH.maxOccluders}`);
    const enabled = this.on && active;
    const evidence = samples.filter((x): x is SeeSample => !!x);
    this.want.fill(0);
    for (const o of occluders) {
      if (o.id < 0 || o.id >= SEE_THROUGH.maxOccluders) throw new Error(`see-through: invalid occluder id ${o.id}`);
      // Hysteresis: a held object needs releaseFraction to stay, a clear one coverFraction to fade.
      const need = this.hold[o.id] > 0 ? SEE_THROUGH.releaseFraction : SEE_THROUGH.coverFraction;
      let hit = false;
      if (evidence.length) {
        let best = 0;
        for (const x of evidence) {
          const f = coverage(x, o.id);
          best = Math.max(best, f);
          if ((x.covered.get(o.id) ?? 0) >= SEE_THROUGH.minPixels && f >= need) hit = true;
        }
        this.cover[o.id] = best;
      }
      hit &&= enabled;
      this.hold[o.id] = !enabled ? 0 : hit ? SEE_THROUGH.holdSeconds : Math.max(0, this.hold[o.id] - dt);
      if (hit || this.hold[o.id] > 0) this.want[o.id] = 1;
    }
    const k = dt > 0 ? 1 - Math.exp(-SEE_THROUGH.fadeRate * dt) : 1;
    for (let i = 0; i < this.vis.length; i++) {
      const target = this.want[i] ? SEE_THROUGH.fadeTo : 1;
      this.vis[i] += (target - this.vis[i]) * k;
      if (Math.abs(target - this.vis[i]) < 1e-3) this.vis[i] = target;
      fadeData[i] = this.vis[i];
    }
    fadeTexture.needsUpdate = true;
  }

  status(occluders: readonly Occluder[] = []) {
    return {
      on: this.on,
      faded: occluders.filter((o) => this.vis[o.id] < 0.999).map((o) => ({ id: o.id, asset: o.asset, vis: +this.vis[o.id].toFixed(3), coverage: +this.cover[o.id].toFixed(3) })),
    };
  }
}
