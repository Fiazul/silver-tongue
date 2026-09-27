// The 3D game's own settings, apart from the shared `silver-tongue:settings` (course + reading
// language, which tui-web also reads and rewrites whole): sound on / off for music, ambience and
// effects (word clips follow core's setSound as well), the music volume, whether the first-steps
// guide (and wayfinding's "lost?" reminder) is hidden, and whether the ground path hint is off. Unreadable or blocked storage: the defaults.
import type { KeyValue } from "@silver-tongue/tui-web/src/web-storage";

export const PREFS_KEY = "silver-tongue:world3d:prefs";

export interface Prefs {
  sound: boolean;
  /** 0..1 */
  music: number;
  guideHidden: boolean;
  /** Menu → Show path: off (wayfinding's ground path hint; on by default) */
  pathHidden: boolean;
}

export const DEFAULT_PREFS: Prefs = { sound: true, music: 0.8, guideHidden: false, pathHidden: false };

export function loadPrefs(kv: KeyValue): Prefs {
  try {
    const d = JSON.parse(kv.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!d || typeof d !== "object") return { ...DEFAULT_PREFS };
    return {
      sound: typeof d.sound === "boolean" ? d.sound : DEFAULT_PREFS.sound,
      music: typeof d.music === "number" && d.music >= 0 && d.music <= 1 ? d.music : DEFAULT_PREFS.music,
      guideHidden: typeof d.guideHidden === "boolean" ? d.guideHidden : DEFAULT_PREFS.guideHidden,
      pathHidden: typeof d.pathHidden === "boolean" ? d.pathHidden : DEFAULT_PREFS.pathHidden,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(kv: KeyValue, p: Prefs): boolean {
  try {
    kv.setItem(PREFS_KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}
