// The render look, fixed per page load by the URL. Default (no param): the toon look, untouched.
// `?look=real`: the "real look" prototype (reallook.ts, its own chunk, loaded only then): sun
// shadows, an image-based sky light, GTAO + ACES filmic through an EffectComposer, standard
// materials in place of the toon ramp, a lower, tighter camera. `?look=real&ramp=1`: the same with
// the toon materials kept, to compare what the materials alone do. Every change it makes is gated
// on LOOK.real; with it false no code path differs and the composer is never built.
import type * as THREE from "three";

const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** The real look's environment layers (envlook.ts), in build order; `?env=` picks a subset. */
export const ENV_LAYERS = ["ground", "grass", "leaves", "sky", "bloom", "grade", "particles"] as const;
export type EnvLayer = (typeof ENV_LAYERS)[number];

/**
 * `?look=real&env=grass,sky`: only those layers; `&env=` (empty): none (the step-2 real look);
 * no `env`: all of them. Always empty without `?look=real`: nothing of envlook.ts is ever built then.
 */
function envLayers(real: boolean, v: string | null): readonly EnvLayer[] {
  if (!real) return [];
  if (v === null) return [...ENV_LAYERS];
  const want = new Set(v.split(",").map((s) => s.trim()));
  return ENV_LAYERS.filter((l) => want.has(l));
}

export const LOOK = {
  real: q.get("look") === "real",
  /** real look with the toon materials kept (the 3-step ramp on) */
  ramp: q.get("look") === "real" && q.get("ramp") === "1",
  /** real look only: the environment layers on (envlook.ts); [] in the toon look */
  env: envLayers(q.get("look") === "real", q.get("env")),
};

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
