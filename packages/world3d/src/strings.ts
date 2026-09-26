// Text for the 3D front end, in two layers over the course's learner text (makeText):
// - FALLBACK: strings the learner FTL (packages/tui UI_KEYS) doesn't have yet, read with `s(id)`.
// - TEXT_3D: learner messages whose TUI wording doesn't fit here (key hints like "Press [w]"), read
//   through `display(t)`, the Text every 3D view uses.
// A learner language overrides either with a `w3d-<id>` message; until then the English here shows.
import type { Text } from "@silver-tongue/tui";

const FALLBACK: Record<string, string> = {
  notebook: "Notebook",
  close: "Close",
  "new-game-confirm": "Start a new game? This one stays saved.",
  "nothing-to-say": "{npc} has nothing to talk about right now.",
  "talk-title": "Talk to {npc}",
  cancel: "Never mind",
  "tiles-give-up": "Give up on this one",
  "tiles-say": "Say it",
  "tiles-undo": "Undo",
  "word-help": "Word help",
  "word-help-on": "Tap a word to look it up",
  "sentence": "Whole sentence",
  "replay": "Replay audio",
  "name-go": "Start",
  "slots-left": "{n} left today",
  day: "Day {n}",
  "day-short": "D{n}",
  "slots-short": "{n} left",
  "walk-hint-touch": "Drag on the left to walk, or tap the street. Tap someone, or the round button, to talk.",
  "name-placeholder": "Your name",
  "you-say": "You: {text}",
  "walk-hint": "Tap the street to walk (or WASD / arrows). Tap someone, or press E next to them, to talk.",
  // prompts over things near the player
  "prompt-talk": "Talk to {npc}",
  "prompt-enter": "Enter {place}",
  "prompt-exit": "Leave for {place}",
  "prompt-sleep": "Sleep",
  "prompt-notebook": "Read your notebook",
  "prompt-key": "E",
  // objective line
  "obj-name": "Tell them your name",
  "obj-in-scene": "Talking with {npc}",
  "obj-talk": "{task}: talk to {npc}",
  "obj-go": "Go to {place} and find {npc} ({task})",
  "obj-mentor": "Ask {npc} about the language",
  "obj-mentor-go": "Go to {place}: {npc} has something to explain",
  "obj-work": "Earn money: {task} with {npc}",
  "obj-work-go": "Earn money: go to {place} ({task} with {npc})",
  "obj-sleep-here": "Out of time today: sleep in your bed",
  "obj-go-home": "Out of time today: go home to {place} and sleep",
  "obj-sleep-now": "Nothing more today: sleep in your bed",
  "obj-nothing": "Nothing more today: go home to {place} and sleep",
  "obj-rent-due": "Rent {currency}{rent} is due in {n} days",
  "obj-rent-tonight": "Rent {currency}{rent} is due tonight",
  "obj-rent-late": "Rent is late: {currency}{rent} is taken as soon as you have it",
  // travel list, menu, save line
  travel: "Go to…",
  "travel-title": "Where to?",
  menu: "Menu",
  "menu-title": "Menu",
  help: "How to play",
  "export-copy-failed": "Select the text and copy it.",
  // day summary card
  "day-card-title": "Day {day} is over",
  "day-card-food": "Food",
  "day-card-rent": "Rent",
  "day-card-rent-late": "Rent: not paid (not enough money). Mr Li will ask again tomorrow.",
  "day-card-earned": "Earned today",
  "day-card-mixups": "Mix-ups",
  "day-card-wallet": "Wallet",
  "day-card-change": "Change today",
  "day-card-next": "Next day",
};

/** Learner messages reworded for the 3D world: the TUI's key hints become taps. */
export const TEXT_3D: Record<string, string> = {
  "scene-street-hello-start":
    "The old man pats the bench beside him and points at himself. He seems to have decided you need lessons: he says something, you answer. Stuck? Tap a word in his bubble to look it up, or the “…” button to see what the whole sentence means.",
  "tiles-title": "Your reply: tap the words in order, then Say it.",
  "reject-no-pick": "Tap one of the replies.",
};

const fill = (text: string, args: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(args[k] ?? `{${k}}`));

export function makeStrings(t: Text) {
  return (id: string, args: Record<string, string | number> = {}): string => {
    if (t.has(`w3d-${id}`)) return t(`w3d-${id}`, args);
    return fill(FALLBACK[id] ?? id, args);
  };
}
export type Strings = ReturnType<typeof makeStrings>;

/**
 * The learner text as the 3D world shows it: a `w3d-<id>` override in the FTL, else TEXT_3D, else
 * the course's message. Every 3D view reads learner text through this.
 */
export function display(t: Text): Text {
  const d = (id: string, args?: Record<string, string | number>) => {
    if (t.has(`w3d-${id}`)) return t(`w3d-${id}`, args);
    if (TEXT_3D[id] !== undefined) return fill(TEXT_3D[id], args ?? {});
    return t(id, args);
  };
  return Object.assign(d, { has: (id: string) => t.has(`w3d-${id}`) || TEXT_3D[id] !== undefined || t.has(id) }) as Text;
}

/** Learner messages only the terminal front ends show (key legends, terminal prompts): never displayed in 3D. */
export const TUI_ONLY = new Set([
  "hud",
  "menu-title",
  "menu-quit",
  "help-title",
  "help-in-replies",
  "help-sentence",
  "tiles-answer",
  "resume-ask",
  "resume-none",
  "export-none",
  "import-done",
  "web-tap-to-type",
  "web-saved",
  "reject-bad-tile",
  "reject-no-tiles",
  "reject-bad-choice",
]);
/** A TUI key hint: "[w]", "[enter]", "[1-4]", "number keys". */
export const KEY_HINT = /\[(?:[a-z0-9]|esc|enter|⌫|↑↓|\d-\d|\{ ?\$keys ?\})\]|number keys/i;
