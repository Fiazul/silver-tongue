import { FluentBundle, FluentResource, type FluentVariable } from "@fluent/bundle";
import { REJECT_REASONS, WALLET_REASONS } from "@silver-tongue/core";

export type Text = ((id: string, args?: Record<string, FluentVariable>) => string) & {
  /** Whether the text has this message: for optional text such as scene narration. */
  has(id: string): boolean;
};

/** Learner-language text. A missing message shows its id, so gaps are visible, never fatal. */
export function makeText(ftl: string, locale: string): Text {
  const bundle = new FluentBundle(locale, { useIsolating: false });
  bundle.addResource(new FluentResource(ftl));
  const t = (id: string, args?: Record<string, FluentVariable>) => {
    const msg = bundle.getMessage(id);
    // Passing an errors array makes Fluent render problems inline ({$day}) instead of throwing.
    return msg?.value ? bundle.formatPattern(msg.value, args ?? {}, []) : id;
  };
  return Object.assign(t, { has: (id: string) => !!bundle.getMessage(id)?.value });
}

/**
 * Message ids the TUI uses, with the variables it passes to each.
 * The course build fails a learner language that lacks any of them or uses other variables.
 * Not listed, because they depend on the catalog: `language-<code>` for every course's language,
 * which the build checks against the catalog (tools/src/build-course.ts languageNameProblems).
 */
export const UI_KEYS: Record<string, string[]> = {
  "hud-top": ["day"],
  "hud-goal": ["goal"],
  "hud-goal-sleep": [],
  "day-part-morning": [],
  "day-part-midday": [],
  "day-part-afternoon": [],
  "day-part-evening": [],
  "day-part-night": [],
  "sleep-go": ["place"],
  "person-at": ["place"],
  "person-at-via": ["place", "via"],
  "person-after": ["scene"],
  "person-after-with": ["scene", "npc"],
  "person-trust": ["trust"],
  "person-trust-with": ["trust", "npc"],
  "person-costs": ["currency", "cost"],
  "person-bring-parcel": [],
  "person-parcel-first": [],
  "person-gains-trust": ["trust"],
  "sleep-go-via": ["place", "via"],
  "hud-rent": ["days"],
  "hud-rent-late": [],
  "hud-parcel": [],
  credit: [],
  "rank-0": [],
  "rank-1": [],
  "rank-2": [],
  "rank-3": [],
  "rank-4": [],
  "menu-title": [],
  "menu-talk": ["npc", "scene"],
  "menu-go": ["place"],
  "menu-mentor": ["npc"],
  "menu-cost-money": ["currency", "cost"],
  "menu-no-time": [],
  "note-hint": ["npc"],
  "mentor-nothing": ["npc"],
  "menu-sleep": [],
  "menu-review": ["count"],
  "keys-type": [],
  "keys-review": ["keys"],
  "keys-review-next": [],
  "type-prompt": [],
  "type-send": [],
  "hint-title": ["level"],
  "hint-level-1": [],
  "hint-level-2": [],
  "hint-level-3": [],
  "hint-question": [],
  "hint-statement": [],
  "hint-words": ["count"],
  "hint-use": [],
  "hint-more": [],
  "hint-last": [],
  "review-title": [],
  "review-fill": [],
  "review-right": [],
  "review-wrong": ["word"],
  "review-memory": [],
  "review-done": ["right", "of"],
  "review-due": [],
  "job-delivery": [],
  "job-step-pickup": [],
  "job-step-walk": [],
  "job-step-handover": [],
  "job-time-left": ["time"],
  "job-words": [],
  "notebook-phrases": [],
  "notebook-people": [],
  "notebook-places": [],
  "notebook-phrases-empty": [],
  "notebook-people-empty": [],
  "notebook-trust": [],
  "notebook-talked": ["scenes"],
  "notebook-here": [],
  "notebook-letters": [],
  "notebook-papers": [],
  "notebook-papers-empty": [],
  "notebook-paper-progress": ["known", "total"],
  "notebook-paper-from": ["npc", "place"],
  "menu-quit": [],
  "keys-explore": ["keys"],
  "keys-explore-book": ["keys"],
  "keys-pick": ["keys"],
  "keys-pick-book": ["keys"],
  "keys-tiles": ["keys"],
  "keys-tiles-book": ["keys"],
  "keys-help": ["keys"],
  "keys-notebook": [],
  "keys-notebook-scroll": [],
  "keys-book": ["tabs"],
  "keys-book-scroll": ["tabs"],
  "book-title": [],
  "notebook-title": [],
  "notebook-words": [],
  "notebook-recent": [],
  "notebook-notes-empty": [],
  "notebook-label-new": [],
  "notebook-label-met": [],
  "notebook-label-shaky": [],
  "notebook-label-known": [],
  "keys-name": [],
  "name-prompt": [],
  "notebook-progress": ["stage", "known", "total"],
  "notebook-rank": ["rank"],
  "notebook-empty": [],
  "notebook-elsewhere": [],
  "notebook-notes": [],
  "keys-help-sentence": ["keys"],
  "help-sentence": [],
  "help-example": [],
  "help-play": [],
  "help-in-replies": [],
  "help-title": [],
  "reply-title": [],
  "reply-confused": [],
  "tiles-answer": [],
  you: [],
  mismatch: [],
  rephrased: [],
  "gesture-narration": ["npc"],
  "sound-on": [],
  "sound-off": [],
  "sound-none": [],
  "wallet-change": ["sign", "currency", "amount", "reason"],
  ...Object.fromEntries(WALLET_REASONS.map((r) => [`reason-${r}`, []])),
  "trust-up": ["npc"],
  "scene-done": ["currency", "earned"],
  "scene-done-short": [],
  unlocked: ["scene"],
  "unlocked-many": ["scenes"],
  "place-revealed": ["count", "places"],
  "errand-started": [],
  "errand-ended": [],
  "menu-needs-money": ["npc", "scene", "currency", "cost"],
  "rank-up": ["rank"],
  "day-ended": ["day"],
  "day-ended-rough": ["day"],
  "notice-bad-save": [],
  "notice-read-only": [],
  "resume-title": [],
  "settings-title": [],
  "settings-learning": ["language"],
  "settings-reading": ["learner"],
  "settings-sound": ["sound"],
  "settings-sound-on": [],
  "settings-sound-off": [],
  "settings-sound-none": [],
  "settings-sound-hint": [],
  "settings-speed": ["speed"],
  "settings-speed-slow": [],
  "settings-speed-normal": [],
  "settings-speed-fast": [],
  "settings-ruby": ["ruby"],
  "settings-ruby-auto": [],
  "settings-ruby-on": [],
  "settings-ruby-off": [],
  "settings-pick-course": [],
  "settings-pick-reading": [],
  "settings-current": [],
  "keys-settings": ["keys"],
  "keys-settings-pick": ["keys"],
  "keys-o": [],
  "start-title": [],
  "start-ask": [],
  "resume-item": ["name", "day", "place", "currency", "wallet", "done", "date"],
  "resume-ask": [],
  "resume-none": [],
  "export-none": [],
  "import-bad": ["reason"],
  "import-done": ["game"],
  ...Object.fromEntries(
    ["new", "games", "games-none", "export", "export-hint", "copy", "copied", "import", "import-hint", "import-go", "close", "saved", "tap-to-type", "load-failed"].map(
      (k) => [`web-${k}`, []],
    ),
  ),
  ...Object.fromEntries(REJECT_REASONS.map((c) => [`reject-${c}`, []])),
};

/** Message ids the visual novel uses, with their variables; checked like UI_KEYS. */
export const VN_UI_KEYS: Record<string, string[]> = {
  "vn-tagline": [],
  "vn-continue": [],
  "vn-new-game": [],
  "vn-tap": [],
  "vn-notebook": [],
  "vn-book": [],
  "vn-backlog": [],
  "vn-settings": [],
  "vn-games": [],
  "vn-menu": [],
  "vn-play-text": [],
  "vn-play-visual": [],
  "vn-play-quiet": [],
  "vn-replay": [],
  "vn-slow": [],
  "vn-meaning": [],
  "vn-undo": [],
  "vn-send": [],
  "vn-hint": [],
  "vn-name-go": [],
  "vn-sound": [],
  "vn-speed": ["speed"],
  "vn-speed-slow": [],
  "vn-speed-normal": [],
  "vn-speed-fast": [],
  "vn-advance": ["mode"],
  "vn-advance-auto": [],
  "vn-advance-tap": [],
  "vn-day": ["day"],
  "vn-parcel": [],
  "vn-rent-late": [],
  "vn-turn-phone": [],
  "vn-dismiss": [],
  "vn-play-word": [],
};

/** Message ids the quiet terminal page uses, with their variables; checked like UI_KEYS. */
export const QUIET_UI_KEYS: Record<string, string[]> = {
  "quiet-anchor": ["place", "day", "part"],
  "quiet-anchor-time": ["place", "part"],
  "quiet-tiles-tap": [],
  "quiet-tiles-click": [],
  "quiet-again-slower": [],
  "quiet-again": [],
  "quiet-say-nothing": [],
  "day-ended-food": ["day", "currency", "amount"],
  "day-ended-rough-food": ["day", "currency", "amount"],
  "menu-go-sleep": ["place"],
  "quiet-rent": ["currency", "rent", "days", "wallet"],
  "quiet-rent-late": [],
  "quiet-scene-with": ["scene", "npc"],
  "quiet-scene-done": ["scene", "currency", "earned"],
  "quiet-no-audio": [],
  "quiet-repeat": [],
  "quiet-repeat-pays": ["currency", "pays"],
  "quiet-resume": ["place"],
  "quiet-press-enter": [],
  "quiet-enter": [],
  "quiet-name-title": [],
  "quiet-desk-why": [],
  "quiet-desk-read": [],
  "quiet-desk-done": [],
  "quiet-open-door": [],
  "quiet-lookup-tap": [],
  "quiet-lookup-click": [],
  "quiet-read-intro": [],
  "quiet-read-placeholder": [],
  "quiet-read-help": [],
  "quiet-read-tab-book": [],
  "quiet-read-help-full": ["reading"],
  "quiet-read-example": ["parts", "reading"],
  "quiet-scribe-choose": [],
  "quiet-scribe-hear": [],
  "quiet-scribe-hear-door": [],
  "quiet-scribe-say": [],
  "quiet-scribe-example": ["line", "meaning"],
  "quiet-scribe-full": ["meaning"],
  "quiet-deduce-prompt": [],
  "quiet-deduce-miss": [],
  "quiet-deduce-again": [],
  "quiet-deduce-conclude": [],
  "quiet-hint-meaning": ["meaning"],
  "quiet-letter-end": [],
  "quiet-letters-count": ["n", "total"],
  "quiet-letters-none": [],
  "quiet-letters-guide": [],
  "quiet-new": [],
  "quiet-rephrase": [],
  "quiet-reveal": [],
  "quiet-notebook": [],
  "quiet-book": [],
  "quiet-status": [],
  "quiet-why-missed": ["count"],
  "quiet-why-helped": [],
  "quiet-why-decayed": [],
  "quiet-tab-shaky": ["count"],
  "quiet-tab-met": ["count"],
  "quiet-tab-known": ["count"],
  "quiet-tab-all": ["count"],
  "quiet-nb-none": [],
  "quiet-esc": [],
  "quiet-st-wallet": ["currency", "wallet"],
  "quiet-st-rent": ["currency", "rent", "days"],
  "quiet-st-day": ["day", "part"],
  "quiet-people": [],
  "quiet-unmet": ["count"],
  "quiet-you": [],
  "quiet-p-back": [],
  "quiet-p-tab-tips": [],
  "quiet-p-tab-history": ["count"],
  "quiet-p-tab-words": ["heard", "total"],
  "quiet-p-trust": ["trust"],
  "quiet-p-not-met": [],
  "quiet-p-no-tips": [],
  "quiet-p-no-talks": [],
  "quiet-p-when": ["day", "part"],
  "quiet-p-heard": ["count"],
  "quiet-p-not-yet": ["count"],
  "quiet-st-parcel": [],
  "quiet-st-no-parcel": [],
  "quiet-no-save": [],
};

/** Every UI message that is missing or can't be formatted with the variables the TUI passes. */
export function uiTextProblems(ftl: string, locale: string): string[] {
  const bundle = new FluentBundle(locale, { useIsolating: false });
  bundle.addResource(new FluentResource(ftl));
  const problems: string[] = [];
  for (const [id, vars] of Object.entries({ ...UI_KEYS, ...VN_UI_KEYS, ...QUIET_UI_KEYS })) {
    const msg = bundle.getMessage(id);
    if (!msg?.value) {
      problems.push(`learner text: missing "${id}"`);
      continue;
    }
    const errors: Error[] = [];
    bundle.formatPattern(msg.value, Object.fromEntries(vars.map((v) => [v, 1])), errors);
    for (const e of errors) problems.push(`learner text "${id}": ${e.message}`);
  }
  return problems;
}

/**
 * Narration for actions (action-<name>, asked-<name>) that can't be formatted with the action's
 * parameters, e.g. a misspelt variable. Both messages are optional.
 */
export function narrationProblems(ftl: string, locale: string, actions: Record<string, string[]>): string[] {
  const bundle = new FluentBundle(locale, { useIsolating: false });
  bundle.addResource(new FluentResource(ftl));
  const problems: string[] = [];
  for (const [action, params] of Object.entries(actions)) {
    for (const id of [`action-${action}`, `asked-${action}`]) {
      const msg = bundle.getMessage(id);
      if (!msg?.value) continue;
      const errors: Error[] = [];
      bundle.formatPattern(msg.value, Object.fromEntries(params.map((p) => [p, "x"])), errors);
      for (const e of errors) problems.push(`narration "${id}": ${e.message}`);
    }
  }
  return problems;
}
