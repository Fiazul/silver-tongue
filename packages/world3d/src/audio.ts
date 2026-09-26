// Audio unlock: mobile browsers start every AudioContext suspended until a user gesture. Whatever
// plays sound later (TTS clips) registers its context here; the first touch / click / key resumes
// every registered one, and any registered after that gesture is resumed at once. Nothing
// registered: the gesture is a no-op.
const contexts = new Set<AudioContext>();
let unlocked = false;

export function registerAudioContext(ctx: AudioContext) {
  contexts.add(ctx);
  if (unlocked) void ctx.resume().catch(() => {});
}

/** Resumes the registered contexts; true once a gesture has unlocked audio. */
export function unlockAudio(): boolean {
  unlocked = true;
  for (const ctx of contexts) if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return unlocked;
}

/** Listens for the first gesture on `target` (capture phase, so an overlay button counts too). */
export function unlockAudioOnFirstGesture(target: EventTarget = window) {
  const events = ["pointerdown", "touchend", "keydown"] as const;
  const once = () => {
    unlockAudio();
    for (const ev of events) target.removeEventListener(ev, once, true);
  };
  for (const ev of events) target.addEventListener(ev, once, true);
}

export function audioUnlocked(): boolean {
  return unlocked;
}
