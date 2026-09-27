// Language data for the game chrome, kept outside src/ (as icons/ is): upstream's
// tools/test/language-free.test.ts keeps every packages/*/src free of any particular language
// (no Han / kana / Hangul, no quoted language codes), so the UI strings in Bengali and Chinese, the
// language names in their own scripts, the "coming soon" list and the start flow's six intro words
// live here and come in through this one module.
//
// - <ui>.json `start`: the start flow's strings (design/start/strings.js, vendored as is).
// - <ui>.json `game`: the game chrome over src/strings.ts FALLBACK (English there; partial here,
//   a missing key falls back to English).
// - intro-<language>.json: the start flow's six words for a course in that language
//   (design/start/intro.json); `meaning` per reading language.
import bn from "./bn.json";
import en from "./en.json";
import zh from "./zh.json";
import introZh from "./intro-zh.json";
import native from "./native-names.json";

export type StringTable = Record<string, string | string[]>;
export interface UiLocale {
  start: StringTable;
  game?: Record<string, string>;
}

/** The UI languages the chrome has, English first (the fallback). */
export const UI_LOCALES: Record<string, UiLocale> = { en, bn, zh };
export const FALLBACK_UI = "en";

/** A language's name in its own script, for cards when the catalog lacks one. */
export const NATIVE_NAMES: Record<string, string> = native;

/** Languages shown greyed on "I want to learn…" until a course exists for them. */
export const COMING_SOON: string[] = ["ja", "ko", "es"];

export interface IntroWord {
  id: string;
  text: string;
  reading?: string;
  meaning?: Record<string, string>;
}
export interface IntroData {
  language: string;
  words: IntroWord[];
}

/** The six intro words by course language. */
export const INTROS: Record<string, IntroData> = Object.fromEntries([introZh].map((i) => [i.language, i]));
