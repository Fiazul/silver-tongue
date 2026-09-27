// Spoken audio for the 3D front end: one AudioPlayer for the page, tui-web's createWebAudio under
// it (the same player the browser TUI uses: one audio element, clips in order with a 300 ms beat
// between them, a slow line at 0.8 speed, a clip that won't load skipped, three failing in a row
// and `available` goes false). game.ts decides what is said (as packages/tui app.ts does); this
// only says it. DOM-free: the element and the timer come in as deps, so tests use fakes.
//
// Mobile browsers refuse play() on an audio element until a gesture has played it once: a tap /
// click / key plays a silent clip through the same element (unlock(), retried on each gesture until
// one goes through), and every clip after that plays. A play() refused before that is ignored (the text is on screen anyway).
import type { AudioOut, Speech } from "@silver-tongue/tui";
import { createWebAudio, type AudioLike, type WebAudioDeps } from "@silver-tongue/tui-web/src/web-audio";
import type { WalkGrid } from "./layout";

export interface AudioPlayer extends AudioOut {
  /** Primes the element inside a user gesture, so later clips may play (mobile). Once. */
  unlock(): void;
  readonly unlocked: boolean;
}

/** 0.05 s of silence as a WAV data URI (8 kHz, 8-bit mono): what unlock() plays. */
export function silentWav(): string {
  const n = 400;
  const bytes = new Uint8Array(44 + n);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  bytes.fill(128, 44); // 8-bit silence
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/**
 * `ext`: the clips' file extension when they aren't createWebAudio's .mp3 (the barks' .ogg / .m4a,
 * picked by pickFormat): each clip URL's ".mp3" becomes it.
 */
export function createAudioPlayer(deps: WebAudioDeps, opts: { ext?: string } = {}): AudioPlayer {
  const real = deps.audio;
  let unlocked = false;
  const url = (v: string) => (opts.ext && v.endsWith(".mp3") ? `${v.slice(0, -4)}.${opts.ext}` : v);
  // The element as createWebAudio sees it, except that a play() that goes through marks audio unlocked.
  const el: AudioLike | undefined = real && {
    get src() {
      return real.src;
    },
    set src(v) {
      real.src = url(v);
    },
    get playbackRate() {
      return real.playbackRate;
    },
    set playbackRate(v) {
      real.playbackRate = v;
    },
    get defaultPlaybackRate() {
      return real.defaultPlaybackRate;
    },
    set defaultPlaybackRate(v) {
      real.defaultPlaybackRate = v;
    },
    get onended() {
      return real.onended;
    },
    set onended(f) {
      real.onended = f;
    },
    get onerror() {
      return real.onerror;
    },
    set onerror(f) {
      real.onerror = f;
    },
    play: () =>
      real.play().then(() => {
        unlocked = true;
      }),
    pause: () => real.pause(),
  };
  const out = createWebAudio({ ...deps, audio: el });
  return {
    get available() {
      return out.available;
    },
    get unlocked() {
      return unlocked;
    },
    play: (lines: Speech[]) => out.play(lines),
    stop: () => out.stop(),
    unlock() {
      if (unlocked || !real) return;
      // Nothing has played yet, so nothing is playing: a clip set earlier was refused. If this same
      // gesture goes on to start a line (tapping an NPC), that clip replaces the silence.
      const silent = silentWav();
      real.src = silent;
      real
        .play()
        .then(() => {
          unlocked = true;
          if (real.src === silent) real.pause();
        })
        .catch(() => {});
    },
  };
}

/**
 * Calls player.unlock() on each gesture on `target` (capture phase, so an overlay button counts
 * too) until audio is unlocked. Touch counts at touchend / pointerup (iOS grants no play() at
 * pointerdown of a touch).
 */
export function unlockAudioOnGesture(player: Pick<AudioPlayer, "unlock" | "unlocked">, target: EventTarget = window) {
  const events = ["pointerup", "touchend", "click", "keydown"] as const;
  const on = () => {
    player.unlock();
    if (player.unlocked) for (const ev of events) target.removeEventListener(ev, on, true);
  };
  for (const ev of events) target.addEventListener(ev, on, true);
}

// ---------------------------------------------------------------------------------------------
// Music, ambience and sound effects (make-it-in-china assets/audio, vendored in assets/audio/):
// three buses under one master gain, on Web Audio (iOS ignores an audio element's volume, and
// crossfades, distance fades and pitch need gains and playback rates). The choices are pure
// functions below (tests: test/audio.test.ts); SoundMixer only plays what they pick.
//   music    title_theme → cutscene_flyover → town_day / town_evening by daylight, 1.5 s crossfades;
//            inside a building the music ducks −6 dB
//   ambient  canal_water by distance to the canal / lake (full at the edge, silent from 25 m),
//            birds_day / crickets_evening by daylight, market_murmur in the market; outdoors only
//   sfx      one-shots: ui_*, bubble, tiles, coin, jingle, fail, doors, notebook, skip, bell, steps
// Nothing starts before the first gesture (unlock() inside it resumes the context). Word clips stay
// on the AudioPlayer above (tui-web's element), untouched.
// ---------------------------------------------------------------------------------------------
export type AudioFormat = "ogg" | "m4a";
export type AudioKind = "music" | "ambient" | "sfx";

/** One entry of assets/audio/manifest.json (the build drops a file it doesn't ship). */
export interface SoundEntry {
  id: string;
  kind: AudioKind;
  file_ogg?: string;
  file_m4a?: string;
  seconds: number;
  loop: boolean;
  gain_db?: number;
}

export const CROSSFADE_S = 1.5;
/** interiors duck the music by 6 dB */
export const INTERIOR_DUCK_DB = -6;
/** daylight (0 morning .. 1 evening, world3d.daylight()) from which the evening bed plays */
export const EVENING_AT = 0.6;
/** canal_water is heard within this many metres of water */
export const WATER_RANGE_M = 25;
/** the place whose zone plays market_murmur */
export const MARKET_PLACE = "market";
/** grid vertex heights (cm) below the waterline: the canal and the lake (terrain_town_walkable water_y −0.6 m) */
export const WATER_BELOW_CM = -60;

export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** ogg (Vorbis) where the browser plays it, else m4a (AAC: Safari), else nothing. */
export function pickFormat(canPlayType: ((mime: string) => string) | undefined): AudioFormat | null {
  if (!canPlayType) return null;
  if (canPlayType('audio/ogg; codecs="vorbis"')) return "ogg";
  if (canPlayType('audio/mp4; codecs="mp4a.40.2"') || canPlayType("audio/mp4")) return "m4a";
  return null;
}

/** The file to load for an entry: the preferred format, else the other one the build shipped (if the browser plays it). */
export function fileFor(e: SoundEntry, format: AudioFormat, canPlayType?: (mime: string) => string): string | null {
  const own = format === "ogg" ? e.file_ogg : e.file_m4a;
  if (own) return own;
  const other = format === "ogg" ? e.file_m4a : e.file_ogg;
  if (!other || !canPlayType) return null;
  return canPlayType(format === "ogg" ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/ogg; codecs="vorbis"') ? other : null;
}

export type SoundPhase = "title" | "cutscene" | "game";

export interface SoundScene {
  phase: SoundPhase;
  /** 0 morning .. 1 evening */
  daylight: number;
  /** inside a building (an interior space that isn't a side street) */
  interior: boolean;
  /** core's place */
  place?: string;
  /** metres to the nearest water (canal, lake) */
  waterDistance?: number;
}

/** The music bed for the moment, and its gain (interiors duck it). */
export function musicFor(s: SoundScene): { track: string; gain: number } {
  if (s.phase === "title") return { track: "title_theme", gain: 1 };
  if (s.phase === "cutscene") return { track: "cutscene_flyover", gain: 1 };
  const track = s.daylight >= EVENING_AT ? "town_evening" : "town_day";
  return { track, gain: s.interior ? dbToGain(INTERIOR_DUCK_DB) : 1 };
}

/** Each ambient loop's gain (0: silent) for the moment. */
export function ambientFor(s: SoundScene): Record<string, number> {
  const out: Record<string, number> = { canal_water: 0, birds_day: 0, crickets_evening: 0, market_murmur: 0 };
  if (s.phase === "title" || s.interior) return out;
  const d = s.waterDistance ?? Infinity;
  out.canal_water = d >= WATER_RANGE_M ? 0 : Math.round((1 - Math.max(0, d) / WATER_RANGE_M) * 1000) / 1000;
  if (s.daylight >= EVENING_AT) out.crickets_evening = 0.7;
  else out.birds_day = 0.6;
  if (s.phase === "game" && s.place === MARKET_PLACE) out.market_murmur = 0.8;
  return out;
}

export type Surface = "stone" | "grass" | "wood";

/**
 * What the feet are on: the walk grid's class (1 ground/grass → grass; 2 path, 3 plaza, 4 pad →
 * stone), a deck (the pier and the wooden bridge → wood, the stone arch → stone), and indoors the
 * floorboards (wood).
 */
export function surfaceFor(o: { gridClass: number; deck?: { id: string; kind: "bridge" | "pier" } | null; interior?: boolean }): Surface {
  if (o.interior) return "wood";
  if (o.deck) return o.deck.kind === "bridge" && /stone/.test(o.deck.id) ? "stone" : "wood";
  if (o.gridClass === 1) return "grass";
  if (o.gridClass === 5) return "wood";
  return "stone";
}

/** One of the surface's four footsteps at random, played at ±10 % pitch. */
export function footstep(surface: Surface, rng: () => number): { id: string; rate: number } {
  return { id: `step_${surface}_${1 + Math.min(3, Math.floor(rng() * 4))}`, rate: 0.9 + rng() * 0.2 };
}

/**
 * Footfalls in step with the walk clip: one loop of it covers `strideM` metres (the rig's
 * stride_m, which the actor's timeScale follows), with two footfalls, so a step sounds every
 * strideM / 2 metres walked. The first comes half a step in.
 */
export class StrideClock {
  private acc: number;
  constructor(private strideM: number) {
    this.acc = strideM / 4;
  }
  /** metres walked this frame → footfalls due (0, 1, rarely more) */
  advance(metres: number): number {
    const step = this.strideM / 2;
    this.acc += Math.max(0, metres);
    let n = 0;
    while (this.acc >= step) {
      this.acc -= step;
      n++;
    }
    return n;
  }
  /** standing still: the next walk starts half a step in again */
  reset() {
    this.acc = this.strideM / 4;
  }
}

/**
 * Distance (m) to the nearest water vertex of the town's walk grid (heights under WATER_BELOW_CM:
 * the canal and the lake), as a function of (x, z). A two-pass chamfer transform over the vertex
 * grid, once at start (141 x 141 vertices); nearest vertex lookup after. Infinity when there is no water.
 */
export function waterDistance(grid: WalkGrid, belowCm = WATER_BELOW_CM): (x: number, z: number) => number {
  const w = grid.cols + 1;
  const hgt = grid.rows + 1;
  const d = new Float32Array(w * hgt).fill(Infinity);
  for (let k = 0; k < w * hgt; k++) if (grid.heights[k] < belowCm) d[k] = 0;
  const c = grid.cell;
  const diag = Math.SQRT2 * c;
  const relax = (k: number, n: number, cost: number) => {
    if (d[n] + cost < d[k]) d[k] = d[n] + cost;
  };
  for (let j = 0; j < hgt; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (i > 0) relax(k, k - 1, c);
      if (j > 0) {
        relax(k, k - w, c);
        if (i > 0) relax(k, k - w - 1, diag);
        if (i < w - 1) relax(k, k - w + 1, diag);
      }
    }
  for (let j = hgt - 1; j >= 0; j--)
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      if (i < w - 1) relax(k, k + 1, c);
      if (j < hgt - 1) {
        relax(k, k + w, c);
        if (i < w - 1) relax(k, k + w + 1, diag);
        if (i > 0) relax(k, k + w - 1, diag);
      }
    }
  return (x, z) => {
    const i = Math.round((x - grid.x0) / c);
    const j = Math.round((z - grid.z0) / c);
    const ci = Math.min(w - 1, Math.max(0, i));
    const cj = Math.min(hgt - 1, Math.max(0, j));
    // off the grid: add the way back onto it
    return d[cj * w + ci] + Math.hypot((i - ci) * c, (j - cj) * c);
  };
}

/** The minimal Web Audio surface SoundMixer uses (an AudioContext). */
export interface MixerContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export interface MixerDeps {
  /** where assets/audio/... paths are relative to ("./" for the page) */
  base: string;
  manifest: SoundEntry[];
  format: AudioFormat | null;
  canPlayType?: (mime: string) => string;
  /** makes the AudioContext (called inside the first gesture) */
  context: () => MixerContext | null;
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
  muted?: boolean;
  /** 0..1 */
  musicVolume?: number;
}

interface Voice {
  id: string;
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  /** a load in progress was superseded */
  cancelled?: boolean;
}

/**
 * Plays the buses on Web Audio. Every method is safe before unlock() (it remembers the wanted
 * music and ambience and starts them once the context runs) and without Web Audio at all (silent).
 */
export class SoundMixer {
  private ctx: MixerContext | null = null;
  private master: GainNode | null = null;
  private buses: Partial<Record<AudioKind, GainNode>> = {};
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private entries = new Map<string, SoundEntry>();
  private music: Voice | null = null;
  private musicWanted: { track: string; gain: number } | null = null;
  private ambient = new Map<string, Voice>();
  private ambientWanted: Record<string, number> = {};
  private _muted: boolean;
  private _musicVolume: number;

  constructor(private deps: MixerDeps) {
    for (const e of deps.manifest) this.entries.set(e.id, e);
    this._muted = !!deps.muted;
    this._musicVolume = deps.musicVolume ?? 0.8;
  }

  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }
  get muted(): boolean {
    return this._muted;
  }
  get musicVolume(): number {
    return this._musicVolume;
  }
  /** what the music bus plays now (for world3d.sound()) */
  get playing(): { music: string | null; ambient: Record<string, number> } {
    return { music: this.music?.id ?? null, ambient: { ...this.ambientWanted } };
  }

  /** Inside a user gesture: makes / resumes the context, then starts what is wanted. */
  unlock() {
    if (!this.deps.format) return;
    if (!this.ctx) {
      try {
        this.ctx = this.deps.context();
      } catch {
        this.ctx = null;
      }
      if (!this.ctx) return;
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      for (const k of ["music", "ambient", "sfx"] as const) {
        const g = this.ctx.createGain();
        g.gain.value = k === "music" ? this._musicVolume : 1;
        g.connect(this.master);
        this.buses[k] = g;
      }
      // the short ones ahead, so the first tap has its click
      for (const e of this.deps.manifest) if (e.kind === "sfx") void this.buffer(e.id);
    }
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    if (this.musicWanted) this.setMusic(this.musicWanted.track, this.musicWanted.gain, true);
    this.setAmbient(this.ambientWanted, true);
  }

  setMuted(on: boolean) {
    this._muted = on;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  setMusicVolume(v: number) {
    this._musicVolume = Math.max(0, Math.min(1, v));
    const bus = this.buses.music;
    if (this.ctx && bus) bus.gain.setTargetAtTime(this._musicVolume, this.ctx.currentTime, 0.05);
  }

  private buffer(id: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(id);
    if (!p) {
      const e = this.entries.get(id);
      const file = e && this.deps.format ? fileFor(e, this.deps.format, this.deps.canPlayType) : null;
      const ctx = this.ctx;
      p =
        !file || !ctx
          ? Promise.resolve(null)
          : this.deps
              .fetchBytes(this.deps.base + file)
              .then((bytes) => ctx.decodeAudioData(bytes))
              .catch(() => null);
      if (ctx) this.buffers.set(id, p);
    }
    return p;
  }

  /** A looping (or once-through) voice on a bus, fading in to `gain`. */
  private startVoice(id: string, kind: AudioKind, gain: number, fade: number): Voice | null {
    const ctx = this.ctx;
    const bus = this.buses[kind];
    if (!ctx || !bus) return null;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);
    const voice: Voice = { id, src: null, gain: g };
    void this.buffer(id).then((buf) => {
      if (!buf || voice.cancelled) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = this.entries.get(id)?.loop ?? false;
      src.connect(g);
      src.start();
      voice.src = src;
      const now = ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gain, now + fade);
    });
    return voice;
  }

  private stopVoice(v: Voice, fade: number) {
    const ctx = this.ctx;
    v.cancelled = true;
    if (!ctx) return;
    const now = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fade);
    try {
      v.src?.stop(now + fade + 0.05);
    } catch {
      // never started
    }
  }

  /** The music bed: another track crossfades over 1.5 s; the same one only moves its gain. */
  setMusic(track: string, gain = 1, force = false) {
    const same = this.musicWanted && this.musicWanted.track === track && Math.abs(this.musicWanted.gain - gain) < 1e-3;
    this.musicWanted = { track, gain };
    if (!this.ctx || (same && !force && this.music)) return;
    if (this.music?.id === track) {
      const now = this.ctx.currentTime;
      this.music.gain.gain.cancelScheduledValues(now);
      this.music.gain.gain.setValueAtTime(this.music.gain.gain.value, now);
      this.music.gain.gain.linearRampToValueAtTime(gain, now + CROSSFADE_S / 2);
      return;
    }
    if (this.music) this.stopVoice(this.music, CROSSFADE_S);
    this.music = this.startVoice(track, "music", gain, CROSSFADE_S);
  }

  /** Each ambient loop at its gain: started when first heard, eased (0.4 s) as the gains move. */
  setAmbient(levels: Record<string, number>, force = false) {
    const changed = force || Object.keys({ ...levels, ...this.ambientWanted }).some((k) => Math.abs((levels[k] ?? 0) - (this.ambientWanted[k] ?? 0)) > 0.01);
    if (!changed) return;
    this.ambientWanted = { ...levels };
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [id, level] of Object.entries(levels)) {
      let v = this.ambient.get(id);
      if (!v && level > 0) {
        v = this.startVoice(id, "ambient", level, 1) ?? undefined;
        if (v) this.ambient.set(id, v);
        continue;
      }
      if (v) v.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.4);
    }
  }

  /** A one-shot on the sfx bus (skipped until unlocked, or if it won't load). */
  sfx(id: string, opts: { rate?: number; gain?: number } = {}) {
    const ctx = this.ctx;
    const bus = this.buses.sfx;
    if (!ctx || !bus || this._muted || ctx.state !== "running") return;
    const asked = ctx.currentTime;
    void this.buffer(id).then((buf) => {
      if (!buf || ctx.currentTime - asked > 0.25) return; // too late to still belong to its moment
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = opts.rate ?? 1;
      const g = ctx.createGain();
      g.gain.value = opts.gain ?? 1;
      src.connect(g);
      g.connect(bus);
      src.start();
    });
  }
}

/** The effect a game event plays, if any: a scene done, a mix-up, money paid in a shop or earned. */
export function sfxForEvent(e: { type: string; matched?: boolean; tilesWrong?: boolean; reason?: string }): string | null {
  if (e.type === "sceneEnded") return "success_jingle";
  if (e.type === "actionPerformed" && (e.matched === false || e.tilesWrong)) return "fail_soft";
  if (e.type === "walletChanged" && (e.reason === "shopping" || e.reason === "wages")) return "coin";
  return null;
}
