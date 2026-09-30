// The render look, fixed per page load: a graphics tier (Settings → Graphics, prefs.ts `graphics`).
//   full     the real look (reallook.ts, its own chunk, loaded only then): sun shadows, an
//            image-based sky light, GTAO + ACES filmic through an EffectComposer, standard materials
//            in place of the toon ramp, a lower, tighter camera; every environment layer (envlook.ts)
//   lite     the real look with ground, grass (half the blades), sky and grade only: no bloom, no
//            leaf cards, no particles
//   classic  the toon look, untouched: every real-look change is gated on LOOK.real; with it false
//            no code path differs and the composer is never built
// The tier resolves once, at import (camera.ts and world.ts read LOOK then): the URL (`?look=` /
// `?env=`: a debug and capture override, it wins), else the saved choice, else a default from the
// device (resolveLook, autoTier). `?look=real&ramp=1`: the real look with the toon materials kept,
// to compare what the materials alone do. After load only the safety valve moves it (LookValve:
// full -> lite, this session, when the first seconds run slow). Each real tier also carries a render
// budget (BUDGETS, budgetFor: resolution, AO, antialiasing, shadow map, frame rate) and the pure
// pieces of the frame loop's performance logic: DynamicScale, FramePacer, ShadowScheduler.
import type * as THREE from "three";
import { PREFS_KEY } from "./prefs";
import { coarsePointer } from "./touch";

/** The real look's environment layers (envlook.ts), in build order; `?env=` picks a subset. */
export const ENV_LAYERS = ["ground", "grass", "leaves", "sky", "bloom", "grade", "particles"] as const;
export type EnvLayer = (typeof ENV_LAYERS)[number];

/** Settings → Graphics, best first. */
export const TIERS = ["full", "lite", "classic"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

/** lite's layers: no bloom, leaf cards or particles */
export const LITE_LAYERS: readonly EnvLayer[] = ["ground", "grass", "sky", "grade"];
/** lite's grass: this share of the blades */
export const LITE_GRASS = 0.5;

/** The layers and grass share a tier builds (classic: none). */
export function tierLayers(tier: Tier): { env: readonly EnvLayer[]; grassDensity: number } {
  if (tier === "full") return { env: [...ENV_LAYERS], grassDensity: 1 };
  if (tier === "lite") return { env: [...LITE_LAYERS], grassDensity: LITE_GRASS };
  return { env: [], grassDensity: 1 };
}

/**
 * The real look's render budget (README "Performance"): what it draws at and how often. Classic
 * never reads it (its renderer keeps the DPR cap of 2, no pacing: unchanged).
 */
export interface RenderBudget {
  /** the device pixel ratio is capped here before the scale */
  dprCap: number;
  /** canvas pixels per capped CSS pixel: the renderer (every pass) draws at min(dpr, dprCap) * renderScale; the browser scales the canvas up, the DOM HUD stays crisp */
  renderScale: number;
  /** DynamicScale (below) moves the scale between minScale and renderScale by the frame time */
  dynamic: boolean;
  minScale: number;
  /** GTAO: at the frame's resolution, at half of it (depth-aware upsample), or none */
  ao: "full" | "half" | "off";
  /** the colour pass's MSAA samples (4x at 1080p cost the Vega 11 4 ms a frame) */
  msaa: number;
  /** FXAA after the output pass (in place of MSAA: ~0.5 ms at 1080p) */
  fxaa: boolean;
  /** the sun's shadow map (square) */
  shadowSize: number;
  /** ShadowScheduler: with animated casters in the shadow box, the map redraws every this many frames (the sun or the box moving: at once) */
  shadowEvery: number;
  /** frame pacing: draws at most this many frames a second (0: every animation frame, uncapped) */
  fps: number;
}

export const BUDGETS: Record<"full" | "lite", RenderBudget> = {
  full: { dprCap: 2, renderScale: 1, dynamic: false, minScale: 0.6, ao: "half", msaa: 0, fxaa: true, shadowSize: 2048, shadowEvery: 2, fps: 60 },
  // a phone at DPR 2.6 draws 1.5 * 0.75 = 1.125 px per CSS px: 467x1038 of a 1080x2400 screen (19 % of its pixels)
  lite: { dprCap: 1.5, renderScale: 0.75, dynamic: true, minScale: 0.5, ao: "off", msaa: 0, fxaa: true, shadowSize: 1024, shadowEvery: 3, fps: 60 },
};
/** The frame rates Settings offers (prefs.ts `fps`): the display's (60 cap) or 30, which about halves the GPU's work and a phone's heat */
export const FPS_CHOICES = [60, 30] as const;

/**
 * A tier's budget with the URL's overrides (debug and capture): `scale=` (0.25-2), `dpr=` (the
 * cap), `ao=full|half|off`, `msaa=0..8`, `fxaa=0|1`, `shadow=256..4096`, `shadowEvery=1..60`, `dynres=0|1`, `fps=` (0 uncapped,
 * else 10-240); `fpsPref`: the saved Settings frame rate (the URL wins).
 */
export function budgetFor(tier: Tier, search = "", fpsPref?: number): RenderBudget {
  const b: RenderBudget = { ...BUDGETS[tier === "lite" ? "lite" : "full"] };
  if (fpsPref !== undefined && (FPS_CHOICES as readonly number[]).includes(fpsPref)) b.fps = fpsPref;
  const q = new URLSearchParams(search);
  const num = (k: string, lo: number, hi: number) => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
  };
  const scale = num("scale", 0.25, 2);
  if (scale !== undefined) {
    b.renderScale = scale;
    b.dynamic = false;
  }
  b.dprCap = num("dpr", 0.5, 4) ?? b.dprCap;
  const ao = q.get("ao");
  if (ao === "full" || ao === "half" || ao === "off") b.ao = ao;
  const msaa = num("msaa", 0, 8);
  if (msaa !== undefined) b.msaa = Math.round(msaa);
  const shadow = num("shadow", 256, 4096);
  if (shadow !== undefined) b.shadowSize = Math.round(shadow);
  const every = num("shadowEvery", 1, 60);
  if (every !== undefined) b.shadowEvery = Math.round(every);
  if (q.get("fxaa") === "0") b.fxaa = false;
  if (q.get("fxaa") === "1") b.fxaa = true;
  if (q.get("dynres") === "1") b.dynamic = true;
  if (q.get("dynres") === "0") b.dynamic = false;
  const fps = num("fps", 0, 240);
  if (fps !== undefined) b.fps = fps === 0 ? 0 : Math.max(10, Math.round(fps));
  b.minScale = Math.min(b.minScale, b.renderScale);
  return b;
}

/** The renderer's pixel ratio for a budget at `scale` on a `dpr` screen: the capped DPR times the scale. */
export function renderPixelRatio(b: Pick<RenderBudget, "dprCap">, dpr: number, scale: number): number {
  return Math.min(dpr > 0 ? dpr : 1, b.dprCap) * scale;
}

/**
 * Dynamic resolution (RenderBudget.dynamic): fed each drawn frame's cost (GPU ms where the timer
 * query is there, else the interval between drawn frames), judged every `window` frames by the
 * p95. Over `high` (the frame budget x 1.2: 20 ms at 60 fps) for two windows running: 10 % less
 * scale; under `low` (x 0.72: 12 ms at 60) for three: 10 % more. Between minScale and the budget's
 * renderScale; after a change `cooldown` windows are ignored (a resize reallocates every target:
 * its own frames are slow) and the counts start fresh (hysteresis, no oscillation).
 */
export class DynamicScale {
  scale: number;
  private samples: number[] = [];
  private calm = 0;
  private hot = 0;
  private rest = 0;
  changes = 0;

  constructor(
    readonly max: number,
    readonly min: number,
    /** ms: the frame's budget (1000 / fps) */
    public budgetMs = 1000 / 60,
    readonly window = 60,
    readonly cooldown = 2,
  ) {
    this.scale = max;
  }

  get high() {
    return this.budgetMs * 1.2;
  }
  get low() {
    return this.budgetMs * 0.72;
  }

  /** One drawn frame's cost; true when the scale changed. */
  frame(ms: number): boolean {
    if (!(ms > 0) || !Number.isFinite(ms)) return false;
    this.samples.push(ms);
    if (this.samples.length < this.window) return false;
    const s = this.samples.sort((a, b) => a - b);
    const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    this.samples = [];
    if (this.rest > 0) {
      this.rest--;
      return false;
    }
    const was = this.scale;
    if (p95 > this.high) {
      this.calm = 0;
      if (++this.hot >= 2) {
        this.hot = 0;
        this.scale = Math.max(this.min, +(this.scale * 0.9).toFixed(3));
      }
    } else if (p95 < this.low) {
      this.hot = 0;
      if (++this.calm >= 3) {
        this.calm = 0;
        this.scale = Math.min(this.max, +(this.scale / 0.9).toFixed(3));
      }
    } else this.calm = this.hot = 0;
    if (this.scale === was) return false;
    this.changes++;
    this.rest = this.cooldown;
    return true;
  }
}

/**
 * Frame pacing (RenderBudget.fps): the animation loop runs at the display's rate; this says which
 * of its callbacks draw so that at most `fps` frames a second do. A callback within 1/4 of a
 * display frame of the next slot draws (a 60 Hz display at 30 draws every other one, not a jittery
 * mix); a slot missed by more than a frame is dropped, never caught up. `fps` 0: every callback.
 */
export class FramePacer {
  private next = -Infinity;
  constructor(public fps: number) {}

  /** the callback at `now` (ms) draws */
  tick(now: number): boolean {
    if (!(this.fps > 0)) return true;
    const interval = 1000 / this.fps;
    // tolerance: callbacks come at the display's own rate, a little early or late
    if (now < this.next - Math.min(4, interval * 0.25)) return false;
    this.next = now - this.next > interval ? now + interval : this.next + interval;
    return true;
  }
}

/**
 * When the sun's shadow map redraws (RenderBudget.shadowEvery; the light's shadow.autoUpdate is
 * off): at once when the sun moved (LookSky.version) or the shadow box moved (its centre snaps to
 * SHADOW_CELL m: `boxKey`), else every `every` frames while animated casters (the player, NPCs,
 * walkers) are in the box (`dynamic`), else never: a still scene keeps its map.
 */
export class ShadowScheduler {
  private sun = NaN;
  private key = "";
  private last = -Infinity;
  private frame = 0;
  updates = 0;
  frames = 0;
  constructor(public every: number) {}

  due(sunVersion: number, boxKey: string, dynamic: boolean): boolean {
    const f = this.frame++;
    this.frames++;
    const go = sunVersion !== this.sun || boxKey !== this.key || (dynamic && f - this.last >= this.every);
    if (go) {
      this.sun = sunVersion;
      this.key = boxKey;
      this.last = f;
      this.updates++;
    }
    return go;
  }
}
/** m: the shadow box's centre moves in steps of this (a whole number of shadow texels) */
export const SHADOW_CELL = 2;

/** Idle (README "Performance"): no input for IDLE_S seconds and no cutscene, the real look paces at IDLE_FPS */
export const IDLE_S = 20;
export const IDLE_FPS = 30;

/** What the auto default reads off the device (autoTier); navigator's own fields, absent where the browser has none. */
export interface DeviceSignals {
  /** a coarse primary pointer (touch.ts coarsePointer: a phone, a tablet) */
  coarse: boolean;
  /** navigator.deviceMemory, GB (Chromium only, capped at 8) */
  deviceMemory?: number;
  /** navigator.hardwareConcurrency */
  cores?: number;
}

/** The default without a URL or saved choice: lite on a touch device or a small one (<= 4 GB, <= 4 cores), full otherwise. */
export function autoTier(d: DeviceSignals): { tier: Tier; reason: string } {
  if (d.coarse) return { tier: "lite", reason: "auto: coarse pointer" };
  if (d.deviceMemory !== undefined && d.deviceMemory <= 4) return { tier: "lite", reason: `auto: deviceMemory ${d.deviceMemory}` };
  if (d.cores !== undefined && d.cores <= 4) return { tier: "lite", reason: `auto: ${d.cores} cores` };
  return { tier: "full", reason: "auto: capable device" };
}

export interface LookState {
  tier: Tier;
  /** who chose it: the URL override, the player (Settings, saved), the device default, the safety valve */
  source: "url" | "pref" | "auto" | "valve" | "none";
  /** why, for world3d.look() */
  reason: string;
  /** the real look (full / lite) */
  real: boolean;
  /** real look with the toon materials kept (the 3-step ramp on): `&ramp=1` */
  ramp: boolean;
  /** the environment layers on (envlook.ts); [] in the toon look */
  env: readonly EnvLayer[];
  /** the grass layer's share of its blades (lite: LITE_GRASS) */
  grassDensity: number;
  /** the real look's render budget (budgetFor); classic: full's, never read */
  budget: RenderBudget;
}

/** A tier's look (`env`: a `?env=` subset in place of the tier's layers). */
export function lookFor(tier: Tier, source: LookState["source"], reason: string, opts: { ramp?: boolean; env?: string | null; search?: string; fps?: number } = {}): LookState {
  const layers = tierLayers(tier);
  const real = tier !== "classic";
  let env = layers.env;
  if (real && opts.env !== undefined && opts.env !== null) {
    const want = new Set(opts.env.split(",").map((s) => s.trim()));
    env = ENV_LAYERS.filter((l) => want.has(l));
  }
  return { tier, source, reason, real, ramp: real && !!opts.ramp, env, grassDensity: layers.grassDensity, budget: budgetFor(tier, opts.search ?? "", opts.fps) };
}

/**
 * The tier, in order: the URL (`?look=full|real` full, `?look=lite`, `?look=classic|toon`; `?env=a,b`
 * alone is the real look with just those layers, `&env=` none), the saved choice, the device's default.
 */
export function resolveLook(search: string, pref: Tier | undefined, device: DeviceSignals, fpsPref?: number): LookState {
  const q = new URLSearchParams(search);
  const look = q.get("look");
  const env = q.get("env");
  const ramp = q.get("ramp") === "1";
  const url: Tier | null = look === "real" || look === "full" ? "full" : look === "lite" ? "lite" : look === "classic" || look === "toon" ? "classic" : env !== null ? "full" : null;
  if (url) return lookFor(url, "url", `url: ${look !== null ? `look=${look}` : `env=${env}`}`, { ramp, env, search, fps: fpsPref });
  if (pref) return lookFor(pref, "pref", "saved choice", { search, fps: fpsPref });
  const a = autoTier(device);
  return lookFor(a.tier, "auto", a.reason, { search, fps: fpsPref });
}

/** The saved choices (prefs.ts `graphics`, `fps`), read straight from storage: LOOK resolves before main.ts loads its prefs. */
function saved(): { tier?: Tier; fps?: number } {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as { graphics?: unknown; fps?: unknown } | null;
    return { tier: isTier(d?.graphics) ? d.graphics : undefined, fps: typeof d?.fps === "number" ? d.fps : undefined };
  } catch {
    return {};
  }
}

function deviceSignals(): DeviceSignals {
  const n = navigator as Navigator & { deviceMemory?: number };
  return { coarse: coarsePointer(), deviceMemory: typeof n.deviceMemory === "number" ? n.deviceMemory : undefined, cores: typeof n.hardwareConcurrency === "number" && n.hardwareConcurrency > 0 ? n.hardwareConcurrency : undefined };
}

/**
 * The look this page renders. No page (the tests, Node): classic, nothing of the real look built;
 * a test can setLook() a tier.
 */
export const LOOK: LookState = typeof location === "undefined" || typeof navigator === "undefined" ? lookFor("classic", "none", "no page") : (() => {
        const sv = saved();
        return resolveLook(location.search, sv.tier, deviceSignals(), sv.fps);
      })();

/** Replaces the look in place (the safety valve's drop; tests). Import-time readers (camera.ts) keep what they read. */
export function setLook(s: LookState) {
  Object.assign(LOOK, s);
}

/**
 * The safety valve: at full on the device's default (never a URL or a saved choice), the first
 * `windowMs` of play averaging over `limitMs` per frame drops the session to lite, once. It never
 * goes below lite; a choice in Settings disarms it (manual()).
 */
export class LookValve {
  private armed: boolean;
  private sum = 0;
  private n = 0;
  private elapsed = 0;
  /** "watching" (armed, measuring), "dropped" (it fired), "idle" (never armed, disarmed, or the window passed) */
  state: "watching" | "dropped" | "idle";
  meanMs = 0;

  constructor(
    look: Pick<LookState, "tier" | "source">,
    readonly windowMs = 3000,
    readonly limitMs = 33,
  ) {
    this.armed = look.tier === "full" && look.source === "auto";
    this.state = this.armed ? "watching" : "idle";
  }

  /** One frame's interval (ms; a stall past 250 ms counts as 250: a background tab, a GC). True once: drop to lite now. */
  frame(ms: number): boolean {
    if (!this.armed || !(ms > 0)) return false;
    const d = Math.min(ms, 250);
    this.sum += d;
    this.n++;
    this.elapsed += d;
    if (this.elapsed < this.windowMs) return false;
    this.armed = false;
    this.meanMs = +(this.sum / this.n).toFixed(1);
    this.state = this.meanMs > this.limitMs ? "dropped" : "idle";
    return this.state === "dropped";
  }

  /** The player chose a tier in Settings: never override it. */
  manual() {
    this.armed = false;
    if (this.state === "watching") this.state = "idle";
  }
}

/**
 * Real look only: a space's sky, for its environment map (reallook.ts rebuilds the PMREM when
 * `version` moves). Written by SceneSpace (world.ts) at build and on every setDaylight, kept on
 * `scene.userData.lookSky`.
 */
export interface LookSky {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  /** unit vector toward the sun, and its colour */
  sun: THREE.Vector3;
  sunColor: THREE.Color;
  /** the day's position, 0 morning .. 1 evening (setDaylight's, interiors scaled) */
  daylight: number;
  version: number;
}

/**
 * Real look only: what the environment layers (envlook.ts) need from a space, kept on
 * `scene.userData.lookGround` by SceneSpace.setupRealLook: whether it is the town (the ground,
 * grass, leaves, sky and particle layers are the town's), what blocks walking (building footprints:
 * no grass there), and the town's sky dome's object name (hidden under the sky layer).
 */
export interface LookGround {
  town: boolean;
  blockers: readonly { min: readonly number[]; max: readonly number[]; obb?: { centre: readonly number[]; half: readonly number[]; rotY: number } }[];
  sky?: string;
}

/** Real look: hemisphere light scale (the environment map carries the ambient instead). */
export const REAL_HEMI = 0.35;
/** Real look: sun intensity scale (the direct light carries the shadows; the sky fill is lower) */
export const REAL_SUN = 1.3;
/** Real look: half-size (m) of the sun's ortho shadow box round the player, and the map size. */
export const REAL_SHADOW = { half: 22, mapSize: 2048, distance: 80, bias: -0.0004, normalBias: 0.03 };
