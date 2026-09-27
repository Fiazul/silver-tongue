// Text for the 3D front end, in two layers over the course's learner text (makeText):
// - FALLBACK: strings the learner FTL (packages/tui UI_KEYS) doesn't have yet, read with `s(id)`.
// - TEXT_3D: learner messages whose TUI wording doesn't fit here (key hints like "Press [w]"), read
//   through `display(t)`, the Text every 3D view uses.
// A learner language overrides either with a `w3d-<id>` message. Under that, the chrome's UI
// language (the reading language picked at the start, `?ui=` to preview another) has its own table
// in locale/<ui>.json `game` (bn and zh partial); a key it lacks falls back to the English here.
import type { Text } from "@silver-tongue/tui";
import { FALLBACK_UI, UI_LOCALES } from "../locale";

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
  "replay": "Say it again",
  "play": "Play",
  "sound-menu-on": "Sound: on",
  "sound-menu-off": "Sound: off",
  "sound-menu-none": "Sound: no audio here",
  "sound-toggle": "Turn sound on or off",
  "name-go": "Start",
  "slots-left": "{n} left today",
  day: "Day {n}",
  "day-short": "D{n}",
  "slots-short": "{n} left",
  "walk-hint-touch": "Drag on the left to walk, or tap the street. Tap someone, or the round button, to talk.",
  "name-placeholder": "Your name",
  "you-say": "You: {text}",
  "walk-hint": "Tap the street to walk (or WASD / arrows). Tap someone, or press E next to them, to talk.",
  // the fly-over over the town at the start of a new game
  "cutscene-skip": "Tap to skip",
  "cutscene-skip-key": "Click or press any key to skip",
  // prompts over things near the player
  "prompt-talk": "Talk to {npc}",
  "prompt-enter": "Enter {place}",
  "prompt-go": "Go to {place}",
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
  "obj-deliver": "Deliver the parcel: go to {place} and find {npc}",
  "obj-deliver-here": "Deliver the parcel to {npc}",
  "errand-chip": "Parcel for {place}",
  "errand-chip-short": "→ {place}",
  "fx-delivery": "delivery",
  "reply-cost": "Costs {currency}{cost}",
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
  // settings (Menu → Settings)
  settings: "Settings",
  "settings-title": "Settings",
  "settings-reading": "I speak (menus and meanings)",
  "settings-course": "I'm learning",
  "settings-soon": "Coming soon",
  "settings-name": "Your name",
  "settings-name-save": "Save",
  "settings-name-saved": "Name saved",
  "settings-name-bad": "That name can't be used.",
  "settings-sound": "Sound",
  "settings-sound-on": "On",
  "settings-sound-off": "Off",
  "settings-music": "Music volume",
  "settings-intro": "Replay the six words",
  "settings-guide": "First-steps guide",
  "settings-switch-failed": "That course didn't load; this one goes on.",
  // the first-steps guide (guide.ts)
  "guide-hide": "Hide guide",
  "guide-show": "Show guide",
  "guide-label": "Guide",
  "guide-walk": "Walk to {npc}",
  "guide-talk": "Talk: tap {npc}",
  "guide-reply": "Reply: pick a line",
  "guide-word": "Tap a word to see its meaning",
  "guide-go": "Go to {place}",
  "guide-do": "{task}: tap {npc}",
  // barks (src/barks.ts): everyone outside the course says a line; the prompt names them by role
  "bark-continue": "Carry on",
  "bark-hint": "Everyone here will talk to you. The hint chip shows what they said in {native}.",
  "role-passerby": "Passer-by",
  "role-egg_seller": "Egg seller",
  "role-stroller": "Stroller",
  "role-shopper": "Shopper",
  "role-worker": "Office worker",
  "role-kid": "Kid",
  "role-granny": "Granny",
  "role-tourist": "Tourist",
  "role-courier": "Courier",
  "role-boatman": "Boatman",
  "role-diner": "Diner",
  "role-tea_guest": "Tea drinker",
  "role-cat": "Cat",
  "role-dog": "Dog",
  "role-pigeon": "Pigeon",
};

/** The UI language the chrome can show: `ui` when locale/ has it, else English. */
export function uiLanguage(ui: string | undefined): string {
  return ui && UI_LOCALES[ui] ? ui : FALLBACK_UI;
}

/** Learner messages reworded for the 3D world: the TUI's key hints become taps. */
export const TEXT_3D: Record<string, string> = {
  "scene-street-hello-start":
    "The old man pats the bench beside him and points at himself. He seems to have decided you need lessons: he says something, you answer. Stuck? Tap a word in his bubble to look it up, the little “?” at the end of the line to peek at what it means, or the “…” button for the whole sentence with its reading.",
  "tiles-title": "Your reply: tap the words in order, then Say it.",
  "reject-no-pick": "Tap one of the replies.",
  // the TUI's bottom-right "♪ [m]": the HUD's sound chip, tapped to turn it on or off
  "sound-on": "♪",
  "sound-off": "♪ off",
};

const fill = (text: string, args: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(args[k] ?? `{${k}}`));

/** The chrome's strings: a `w3d-<id>` learner override, else the UI language's table, else English. */
export function makeStrings(t: Text, ui?: string) {
  const table = UI_LOCALES[uiLanguage(ui)].game ?? {};
  return (id: string, args: Record<string, string | number> = {}): string => {
    if (t.has(`w3d-${id}`)) return t(`w3d-${id}`, args);
    return fill(table[id] ?? FALLBACK[id] ?? id, args);
  };
}

/** Every English chrome key (tests: the bn / zh tables name no key that isn't here). */
export const CHROME_KEYS: readonly string[] = Object.keys(FALLBACK);
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
