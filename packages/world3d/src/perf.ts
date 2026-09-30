// `?perf=1` (README "Performance"): a per-frame profile of the render. Off (the default) nothing
// here runs: main.ts makes no Perf and every hook is `perf?.`. On: each animation frame records its
// rAF interval, the CPU ms of the frame callback and of its sections, the GPU ms of every pass
// (EXT_disjoint_timer_query_webgl2; exclusive time: a pass started inside another, as the shadow
// map inside the colour pass, pauses the outer one's query), draw calls and triangles over the whole
// frame (renderer.info summed across the composer's renders), and flags (a synchronous read-back,
// a shader compile, an asset landing). A frame over 50 ms gets a cause. world3d.perf() reads it:
// ("start") clears and records, ("stop") returns the frames, ("mem") the texture memory estimate.
import type * as THREE from "three";

export interface PerfFrame {
  /** performance.now() at the frame callback's start */
  t: number;
  /** ms since the previous frame callback */
  interval: number;
  /** ms in the frame callback */
  cpu: number;
  /** CPU ms per section (exclusive) */
  cpuPass: Record<string, number>;
  /** GPU ms per pass (exclusive); filled in a few frames later, null until then or when unavailable */
  gpu: Record<string, number> | null;
  gpuTotal: number | null;
  calls: number;
  triangles: number;
  programs: number;
  flags: string[];
  /** ms inside slow-prone GL calls: `compile` (link, shader / program status), `upload` (textures, buffers) */
  gl: Record<string, number>;
  /** false: the frame callback ran but drew nothing (frame pacing skipped it) */
  drawn: boolean;
}

/**
 * `?perf=1` only (main.ts turns it on): stall marks on the space-change path (performance.measure,
 * `world3d:<name>`): a GLB's fetch + decode, a SceneSpace's build, a scene's first draw and the
 * prefetcher's steps. Off (the default) nothing is measured.
 */
export const stallMarks = { on: false };
/** performance.measure(`world3d:${name}`) from `start` to now, when stallMarks is on */
export function markSince(name: string, start: number) {
  if (stallMarks.on) performance.measure(`world3d:${name}`, { start, end: performance.now() });
}

/** a measure of `ms` ending now (a part of a step timed elsewhere), when stallMarks is on */
export function markMs(name: string, ms: number) {
  if (!stallMarks.on || !(ms > 0)) return;
  const end = performance.now();
  performance.measure(`world3d:${name}`, { start: end - ms, end });
}

/** `?perf=1`: a line of text over the game, bottom left (the prefetcher's state: main.ts) */
export class PerfOverlay {
  readonly node: HTMLElement;
  private text = "";
  constructor(doc: Document) {
    this.node = doc.createElement("div");
    this.node.className = "perf-overlay";
    this.node.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:70;pointer-events:none;font:11px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,0.55);padding:2px 6px;border-radius:3px;white-space:pre";
    doc.body.append(this.node);
  }
  set(text: string) {
    if (text === this.text) return;
    this.text = text;
    this.node.textContent = text;
  }
}

/** ms: a frame over this is a long frame */
export const LONG_FRAME_MS = 50;

/** Why a long frame was long, from what it recorded (pure: the capture and the tests use it). */
export function longFrameCause(f: Pick<PerfFrame, "interval" | "cpu" | "cpuPass" | "gpuTotal" | "flags">): string {
  if (f.flags.includes("syncRead")) return "sync read-back";
  if (f.flags.includes("compile")) return "shader compile";
  if (f.flags.includes("upload")) return "texture / buffer upload";
  if (f.flags.includes("envBuild")) return "env build";
  const gpu = f.gpuTotal ?? 0;
  if (f.cpu >= 0.5 * f.interval) {
    const top = Object.entries(f.cpuPass).sort((a, b) => b[1] - a[1])[0];
    return `cpu${top ? `: ${top[0]}` : ""}`;
  }
  if (gpu >= 0.5 * f.interval) return "gpu";
  if (f.flags.includes("asset")) return "asset landed (upload / GC)";
  return "outside the frame (GC, compositor, the tab)";
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class Perf {
  recording = false;
  /** the GPU ms of the latest frame whose every query has landed, not yet taken (takeGpuMs) */
  private freshGpu: number | null = null;
  frames: PerfFrame[] = [];
  private cur: PerfFrame | null = null;
  private last = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  /** the GPU pass stack: the top is the one being timed */
  private readonly gstack: string[] = [];
  private active: WebGLQuery | null = null;
  private readonly inflight: { q: WebGLQuery; frame: PerfFrame; pass: string }[] = [];
  private readonly pool: WebGLQuery[] = [];
  /** the CPU section stack, with the time the top one (re)started */
  private readonly cstack: { name: string; t: number }[] = [];
  private flagsNext: string[] = [];
  /** frames not yet all resolved, by frame: queries outstanding */
  private readonly outstanding = new Map<PerfFrame, number>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = (this.gl.getExtension?.("EXT_disjoint_timer_query_webgl2") as TimerExt | null) ?? null;
    // the frame's calls and triangles across every render() of the composer (info resets per render otherwise)
    renderer.info.autoReset = false;
    // every synchronous read-back and every shader compile, wherever it comes from
    const r = renderer as unknown as Record<string, (...a: unknown[]) => unknown>;
    const read = r.readRenderTargetPixels.bind(renderer);
    r.readRenderTargetPixels = (...a: unknown[]) => {
      this.flag("syncRead");
      this.cpuBegin("syncRead");
      try {
        return read(...a);
      } finally {
        this.cpuEnd();
      }
    };
    // the GL calls that can hold a frame without a read-back: a program's link (and its status,
    // which waits for the driver's compile), a texture's upload: timed, and flagged when slow
    const g = this.gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    const glTimed = (name: string, flag: string, when: (a: unknown[]) => boolean = () => true) => {
      const fn = g[name]?.bind(this.gl);
      if (!fn) return;
      g[name] = (...a: unknown[]) => {
        if (!this.cur || !when(a)) return fn(...a);
        const t0 = performance.now();
        try {
          return fn(...a);
        } finally {
          const ms = performance.now() - t0;
          this.cur.gl[flag] = (this.cur.gl[flag] ?? 0) + ms;
          if (ms > 4) this.flag(flag);
        }
      };
    };
    const LINK_STATUS = this.gl.LINK_STATUS;
    glTimed("linkProgram", "compile");
    glTimed("compileShader", "compile");
    glTimed("getProgramParameter", "compile", (a) => a[1] === LINK_STATUS);
    glTimed("getShaderParameter", "compile");
    glTimed("getProgramInfoLog", "compile");
    for (const n of ["texImage2D", "texSubImage2D", "texStorage2D", "texImage3D", "compressedTexImage2D", "generateMipmap"]) glTimed(n, "upload");
    glTimed("bufferData", "upload");
    const sm = renderer.shadowMap as unknown as { render: (...a: unknown[]) => void };
    const shadow = sm.render.bind(sm);
    sm.render = (...a: unknown[]) => this.time("shadow", () => shadow(...a));
  }

  /** the GL ms of the frame being recorded so far (compile / upload), a copy; {} outside a frame */
  glNow(): Record<string, number> {
    return { ...(this.cur?.gl ?? {}) };
  }

  /** DynamicScale's signal under `?perf=1`: a newly landed frame's GPU ms, once; null: none since the last take */
  takeGpuMs(): number | null {
    const v = this.freshGpu;
    this.freshGpu = null;
    return v;
  }

  get gpuTimer(): boolean {
    return !!this.ext;
  }

  /** a flag on the current frame (or the next, between frames) */
  flag(name: string) {
    const to = this.cur ? this.cur.flags : this.flagsNext;
    if (!to.includes(name)) to.push(name);
  }

  frameStart() {
    const now = performance.now();
    this.poll();
    const interval = this.last ? now - this.last : 0;
    this.last = now;
    if (!this.recording) return;
    this.renderer.info.reset();
    this.cur = { t: now, interval, cpu: 0, cpuPass: {}, gpu: this.ext ? {} : null, gpuTotal: this.ext ? 0 : null, calls: 0, triangles: 0, programs: this.renderer.info.programs?.length ?? 0, flags: this.flagsNext, gl: {}, drawn: true };
    this.flagsNext = [];
    this.outstanding.set(this.cur, 0);
    this.cstack.length = 0;
    this.cpuBegin("frame");
  }

  /** the frame callback drew nothing (frame pacing) */
  skipped() {
    if (this.cur) this.cur.drawn = false;
  }

  frameEnd() {
    const f = this.cur;
    if (!f) return;
    this.cpuEnd();
    f.cpu = performance.now() - f.t;
    f.calls = this.renderer.info.render.calls;
    f.triangles = this.renderer.info.render.triangles;
    const progs = this.renderer.info.programs?.length ?? 0;
    if (progs > f.programs) f.flags.push("compile");
    f.programs = progs;
    this.frames.push(f);
    if (this.frames.length > 20000) this.frames.shift();
    this.cur = null;
    this.settle(f);
  }

  cpuBegin(name: string) {
    if (!this.cur) return;
    const now = performance.now();
    const top = this.cstack.at(-1);
    if (top) this.cur.cpuPass[top.name] = (this.cur.cpuPass[top.name] ?? 0) + now - top.t;
    this.cstack.push({ name, t: now });
  }

  cpuEnd() {
    if (!this.cur) return;
    const now = performance.now();
    const top = this.cstack.pop();
    if (top) this.cur.cpuPass[top.name] = (this.cur.cpuPass[top.name] ?? 0) + now - top.t;
    const next = this.cstack.at(-1);
    if (next) next.t = now;
  }

  private gpuStart(pass: string) {
    if (!this.ext || !this.cur) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.inflight.push({ q, frame: this.cur, pass });
    this.outstanding.set(this.cur, (this.outstanding.get(this.cur) ?? 0) + 1);
  }

  private gpuStop() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
  }

  gpuBegin(pass: string) {
    if (!this.cur) return;
    this.gpuStop();
    this.gstack.push(pass);
    this.gpuStart(pass);
  }

  gpuEnd() {
    if (!this.cur) return;
    this.gpuStop();
    this.gstack.pop();
    const top = this.gstack.at(-1);
    if (top) this.gpuStart(top);
  }

  /** `fn` timed as `pass` on both the CPU and the GPU */
  time<T>(pass: string, fn: () => T): T {
    if (!this.cur) return fn();
    this.cpuBegin(pass);
    this.gpuBegin(pass);
    try {
      return fn();
    } finally {
      this.gpuEnd();
      this.cpuEnd();
    }
  }

  /** obj[method] timed as `pass` from now on */
  wrap<O extends object>(obj: O, method: keyof O & string, pass: string) {
    const o = obj as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = o[method].bind(obj);
    o[method] = (...a: unknown[]) => this.time(pass, () => fn(...a));
  }

  /** results that have landed, into their frames */
  private poll() {
    if (!this.ext || !this.inflight.length) return;
    const gl = this.gl;
    const disjoint = !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.inflight.length) {
      const e = this.inflight[0];
      if (!disjoint && !gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inflight.shift();
      const raw = disjoint ? NaN : (gl.getQueryParameter(e.q, gl.QUERY_RESULT) as number) / 1e6;
      // over a second for one pass: a disjoint the driver didn't report
      const ms = raw < 1000 ? raw : NaN;
      this.pool.push(e.q);
      const g = e.frame.gpu;
      if (g && Number.isFinite(ms)) {
        g[e.pass] = (g[e.pass] ?? 0) + ms;
        e.frame.gpuTotal = (e.frame.gpuTotal ?? 0) + ms;
      } else if (g) e.frame.flags.includes("disjoint") || e.frame.flags.push("disjoint");
      const left = (this.outstanding.get(e.frame) ?? 1) - 1;
      this.outstanding.set(e.frame, left);
      this.settle(e.frame);
    }
  }

  private settle(f: PerfFrame) {
    if (f === this.cur) return;
    if ((this.outstanding.get(f) ?? 0) <= 0) {
      this.outstanding.delete(f);
      if (f.gpuTotal !== null && !f.flags.includes("disjoint")) this.freshGpu = f.gpuTotal;
    }
  }

  start() {
    this.frames = [];
    this.recording = true;
  }

  stop(): PerfFrame[] {
    this.recording = false;
    return this.frames;
  }
}

/** Texture memory, estimated (bytes): every texture a material or uniform holds in `scene`, plus `targets`. */
export function textureBytes(scene: THREE.Object3D, targets: readonly THREE.RenderTarget[] = []): { textures: number; bytes: number; targetBytes: number } {
  const seen = new Set<THREE.Texture>();
  const add = (v: unknown) => {
    const t = v as THREE.Texture | null;
    if (t && (t as { isTexture?: boolean }).isTexture) seen.add(t);
  };
  const env = (scene as THREE.Scene).environment;
  add(env);
  add((scene as THREE.Scene).background);
  const all: THREE.RenderTarget[] = [...targets];
  scene.traverse((o) => {
    const sm = (o as THREE.DirectionalLight).shadow?.map;
    if (sm) all.push(sm);
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of m ? (Array.isArray(m) ? m : [m]) : []) {
      for (const v of Object.values(mat)) add(v);
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const x of Object.values(u)) add(x?.value);
    }
  });
  const bpp = (t: THREE.Texture) => (t.type === 1016 /* HalfFloat */ ? 8 : t.type === 1015 /* Float */ ? 16 : 4);
  let bytes = 0;
  for (const t of seen) {
    const img = t.image as { width?: number; height?: number } | undefined;
    if (!img?.width || !img.height) continue;
    bytes += img.width * img.height * bpp(t) * (t.generateMipmaps ? 4 / 3 : 1);
  }
  let targetBytes = 0;
  for (const rt of all) targetBytes += rt.width * rt.height * (bpp(rt.texture) * Math.max(1, rt.samples) + (rt.depthBuffer ? 4 * Math.max(1, rt.samples) : 0));
  return { textures: seen.size, bytes: Math.round(bytes), targetBytes: Math.round(targetBytes) };
}

/**
 * One timer query round each drawn frame, for dynamic resolution (look.ts DynamicScale) when
 * `?perf=1` is off: begin() / end() round the frame, poll() the newest landed result (ms) or null.
 * create() is null where the browser has no EXT_disjoint_timer_query_webgl2 (most phones: the
 * scale then goes by the frame interval).
 */
export class FrameGpuTimer {
  private readonly inflight: WebGLQuery[] = [];
  private readonly pool: WebGLQuery[] = [];
  private active = false;
  private last: number | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerExt,
  ) {}

  static create(renderer: THREE.WebGLRenderer): FrameGpuTimer | null {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension?.("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    return ext ? new FrameGpuTimer(gl, ext) : null;
  }

  begin() {
    if (this.active || this.inflight.length >= 4) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.inflight.push(q);
    this.active = true;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  poll(): number | null {
    const gl = this.gl;
    const disjoint = !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let got: number | null = null;
    while (this.inflight.length > (this.active ? 1 : 0)) {
      const q = this.inflight[0];
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inflight.shift();
      const ms = disjoint ? NaN : (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.pool.push(q);
      if (ms > 0 && ms < 1000) got = ms;
    }
    if (got !== null) this.last = got;
    return got;
  }
}

