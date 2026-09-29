// The render look, fixed per page load by the URL. Default (no param): the toon look, untouched.
// `?look=real`: the "real look" prototype (reallook.ts, its own chunk, loaded only then): sun
// shadows, an image-based sky light, GTAO + ACES filmic through an EffectComposer, standard
// materials in place of the toon ramp, a lower, tighter camera. `?look=real&ramp=1`: the same with
// the toon materials kept, to compare what the materials alone do. Every change it makes is gated
// on LOOK.real; with it false no code path differs and the composer is never built.
import type * as THREE from "three";

const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const LOOK = {
  real: q.get("look") === "real",
  /** real look with the toon materials kept (the 3-step ramp on) */
  ramp: q.get("look") === "real" && q.get("ramp") === "1",
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
  version: number;
}

/** Real look: hemisphere light scale (the environment map carries the ambient instead). */
export const REAL_HEMI = 0.35;
/** Real look: sun intensity scale (the direct light carries the shadows; the sky fill is lower) */
export const REAL_SUN = 1.3;
/** Real look: half-size (m) of the sun's ortho shadow box round the player, and the map size. */
export const REAL_SHADOW = { half: 22, mapSize: 2048, distance: 80, bias: -0.0004, normalBias: 0.03 };
