// The 3D game's own settings, apart from the shared `silver-tongue:settings` (course + reading
// language, which tui-web also reads and rewrites whole): four sound switches, each for one bus and
// nothing else (the music volume, 0 = off, with the HUD's ♪ tap; voice: the word clips and barks,
// core's setSound; sound effects; ambience), whether ambience plays
// its full set of beds or just the quiet default (ambienceFull), whether the first-steps guide
// (and wayfinding's "lost?" reminder) is hidden (and whether its note after the first bark was
// shown), whether the ground path hint is off, and the graphics tier the player chose in Settings
// (look.ts: absent until they choose; look.ts reads it itself, before this loads), and the frame rate
// (Settings → Frame rate: the real look's pacing, look.ts FramePacer). Unreadable or
// blocked storage: the defaults.
import type { KeyValue } from "@silver-tongue/web-common";
// type only: look.ts imports PREFS_KEY from here at its own import time (a value import back would be a cycle)
import type { Tier } from "./look";

export const PREFS_KEY = "silver-tongue:world3d:prefs";

/** the music volume this build shipped with before "quiet by default": a stored 0.8 with no musicSet is never a real choice */
export const OLD_DEFAULT_MUSIC = 0.8;

export interface Prefs {
  /** the voices: the word clips and the barks (core's state.sound follows it) */
  voice: boolean;
  /** the sound effects bus: UI taps, the bubble, doors, coins, the bell… */
  sfx: boolean;
  /** the ambience bus (ambienceFull: which beds, when it is on) */
  ambience: boolean;
  /** 0..1; 0 is music off */
  music: number;
  /** the last music volume above 0: the ♪ chip's tap brings it back (musicTap) */
  musicLast?: number;
  /** the player moved the music slider at least once: music holds its stored value even at 0 or at OLD_DEFAULT_MUSIC */
  musicSet: boolean;
  /** ambience plays every bed (Settings "Ambience: Full") rather than just the quiet default (AMBIENT_LIGHT_CAPS) */
  ambienceFull: boolean;
  guideHidden: boolean;
  /** Menu → Show path: off (wayfinding's ground path hint; on by default) */
  pathHidden: boolean;
  /** the guide's one-off note after the first bark (src/barks.ts) has been shown */
  barkHint?: boolean;
  /** Settings → Graphics (look.ts): absent is the device's default; applies from the next page load */
  graphics?: Tier;
  /** Settings → Frame rate (look.ts FPS_CHOICES, the real look's pacing): absent is 60; applies at once */
  fps?: 30 | 60;
}

/** look.ts TIERS (a test holds the two lists equal) */
export const GRAPHICS_TIERS: readonly Tier[] = ["full", "lite", "classic"];

export const DEFAULT_PREFS: Prefs = { voice: true, sfx: true, ambience: true, music: 0.6, musicSet: false, ambienceFull: false, guideHidden: false, pathHidden: false };

export function loadPrefs(kv: KeyValue): Prefs {
  try {
    const d = JSON.parse(kv.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!d || typeof d !== "object") return { ...DEFAULT_PREFS };
    const musicSet = d.musicSet === true;
    const storedMusic = typeof d.music === "number" && d.music >= 0 && d.music <= 1 ? d.music : undefined;
    // musicSet: honour whatever was stored (even 0, even the old default). Not musicSet: a prefs
    // blob from before this flag existed; 0 and 0.8 were both shipped defaults, while another
    // valid value records a real legacy slider choice.
    const historicalDefault = storedMusic === 0 || storedMusic === OLD_DEFAULT_MUSIC;
    let music = musicSet ? (storedMusic ?? DEFAULT_PREFS.music) : storedMusic !== undefined && !historicalDefault ? storedMusic : DEFAULT_PREFS.music;
    const last = typeof d.musicLast === "number" && d.musicLast > 0 && d.musicLast <= 1 ? d.musicLast : undefined;
    // Before the four switches one `sound` muted music, ambience, effects and voices together. A
    // player who had it off keeps effects, ambience and music off (music at 0, its volume one ♪ tap
    // away); the voices come back (their own switch now; losing them with the music was the bug).
    const legacyMuted = (d as { sound?: unknown }).sound === false && typeof d.sfx !== "boolean" && typeof d.ambience !== "boolean";
    let musicLast = last;
    let setFlag = musicSet;
    if (legacyMuted) {
      if (music > 0) musicLast = music;
      music = 0;
      setFlag = true; // a real choice: the stored 0 holds
    }
    const flag = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
    return {
      voice: flag(d.voice, DEFAULT_PREFS.voice),
      sfx: flag(d.sfx, legacyMuted ? false : DEFAULT_PREFS.sfx),
      ambience: flag(d.ambience, legacyMuted ? false : DEFAULT_PREFS.ambience),
      music,
      ...(musicLast !== undefined ? { musicLast } : {}),
      musicSet: setFlag,
      ambienceFull: typeof d.ambienceFull === "boolean" ? d.ambienceFull : DEFAULT_PREFS.ambienceFull,
      guideHidden: typeof d.guideHidden === "boolean" ? d.guideHidden : DEFAULT_PREFS.guideHidden,
      pathHidden: typeof d.pathHidden === "boolean" ? d.pathHidden : DEFAULT_PREFS.pathHidden,
      ...(d.barkHint === true ? { barkHint: true } : {}),
      ...(GRAPHICS_TIERS.includes(d.graphics as Tier) ? { graphics: d.graphics } : {}),
      ...(d.fps === 30 || d.fps === 60 ? { fps: d.fps } : {}),
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

/**
 * The HUD's ♪ tap: music off (volume 0, the volume it had remembered in musicLast), or back on at
 * the last volume above 0 (the default when there never was one). Voice, effects and ambience untouched.
 */
export function musicTap(p: Pick<Prefs, "music" | "musicLast">): Pick<Prefs, "music" | "musicLast" | "musicSet"> {
  if (p.music > 0) return { music: 0, musicLast: p.music, musicSet: true };
  const back = p.musicLast && p.musicLast > 0 ? p.musicLast : DEFAULT_PREFS.music;
  return { music: back, musicLast: back, musicSet: true };
}

/** The Settings music slider at `v` (0..1): a volume above 0 is also the one ♪ brings back. */
export function musicSlider(p: Pick<Prefs, "musicLast">, v: number): Pick<Prefs, "music" | "musicLast" | "musicSet"> {
  const music = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  return { music, musicSet: true, ...(music > 0 ? { musicLast: music } : p.musicLast !== undefined ? { musicLast: p.musicLast } : {}) };
}
