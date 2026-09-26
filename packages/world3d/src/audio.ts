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

export function createAudioPlayer(deps: WebAudioDeps): AudioPlayer {
  const real = deps.audio;
  let unlocked = false;
  // The element as createWebAudio sees it, except that a play() that goes through marks audio unlocked.
  const el: AudioLike | undefined = real && {
    get src() {
      return real.src;
    },
    set src(v) {
      real.src = v;
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
