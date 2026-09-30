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
// full -> lite, this session, when the first seconds run slow).
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
}

/** A tier's look (`env`: a `?env=` subset in place of the tier's layers). */
export function lookFor(tier: Tier, source: LookState["source"], reason: string, opts: { ramp?: boolean; env?: string | null } = {}): LookState {
  const layers = tierLayers(tier);
  const real = tier !== "classic";
  let env = layers.env;
  if (real && opts.env !== undefined && opts.env !== null) {
    const want = new Set(opts.env.split(",").map((s) => s.trim()));
    env = ENV_LAYERS.filter((l) => want.has(l));
  }
  return { tier, source, reason, real, ramp: real && !!opts.ramp, env, grassDensity: layers.grassDensity };
}

/**
 * The tier, in order: the URL (`?look=full|real` full, `?look=lite`, `?look=classic|toon`; `?env=a,b`
 * alone is the real look with just those layers, `&env=` none), the saved choice, the device's default.
 */
export function resolveLook(search: string, pref: Tier | undefined, device: DeviceSignals): LookState {
  const q = new URLSearchParams(search);
  const look = q.get("look");
  const env = q.get("env");
  const ramp = q.get("ramp") === "1";
  const url: Tier | null = look === "real" || look === "full" ? "full" : look === "lite" ? "lite" : look === "classic" || look === "toon" ? "classic" : env !== null ? "full" : null;
  if (url) return lookFor(url, "url", `url: ${look !== null ? `look=${look}` : `env=${env}`}`, { ramp, env });
  if (pref) return lookFor(pref, "pref", "saved choice");
  const a = autoTier(device);
  return lookFor(a.tier, "auto", a.reason);
}

/** The saved choice (prefs.ts `graphics`), read straight from storage: LOOK resolves before main.ts loads its prefs. */
function savedTier(): Tier | undefined {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as { graphics?: unknown } | null;
    return isTier(d?.graphics) ? d.graphics : undefined;
  } catch {
    return undefined;
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
export const LOOK: LookState = typeof location === "undefined" || typeof navigator === "undefined" ? lookFor("classic", "none", "no page") : resolveLook(location.search, savedTier(), deviceSignals());

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
