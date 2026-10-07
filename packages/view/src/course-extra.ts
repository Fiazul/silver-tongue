import type { Course, Exchange, LanguageProfile, Scene, Word, WordId } from "@silver-tongue/core";
import type { DeskPaper } from "./desk";

/*
 * Fields the build adds to a course that core doesn't know about. Core keeps extra JSON fields as
 * they are (like `reactionAudio`), so their types live here, next to the code that reads them.
 */

/** One letter of the script's chart: the letter, its name, how it sounds, and its clip. */
export interface Letter {
  ch: string;
  name?: string;
  /** how it sounds, in the learner's letters ("g/k") */
  reading?: string;
  /** what text-to-speech reads for it; the build falls back to `name`, then `ch` */
  say?: string;
  /** its clip ids, in the words voice */
  audio?: string[];
}
export interface LetterGroup {
  id: string;
  letters: Letter[];
}
/** One step of the "how to read" guide: its wording is the learner's message `letters-guide-<id>`. */
export interface GuideStep {
  id: string;
  /** words to read as examples of the step (from the desk's papers) */
  examples?: string[];
  /** each example's clip ids, in the words voice (added by the build) */
  audio?: string[][];
}
/** content/languages/<lang>/letters.json, as the course carries it. */
export interface LetterChart {
  guide?: GuideStep[];
  groups: LetterGroup[];
}

/**
 * `attach`: a particle or ending written glued to the word before it. An attaching word also keeps
 * its other spellings (`alt`), so a reply tile spelled that way is found.
 */
export type WordExtra = Word & { attach?: boolean; alt?: string[] };
/**
 * `tileGap`: what goes between two reply tiles of a language whose tiles aren't `spaced`; "" when unset.
 * `book`: the course uses the Book (readings under words, the Letters and Papers tabs); unset, the
 * notebook stays as it was.
 */
export type LanguageExtra = LanguageProfile & { tileGap?: string; book?: boolean; liaison?: Liaison };
/**
 * `liaison`: how readings run together inside one written word (see joinReadings): when the next reading
 * starts with one of `before`, a reading ending in a key of `finals` ends in its value instead.
 */
export interface Liaison {
  before: string;
  finals: Record<string, string>;
}
/** `pin`: the NPC's line is a paper (a notice, a form) kept in the Book once the scene is done. */
export type ExchangeExtra = Exchange & { pin?: boolean };
/** `rent`: the scene where rent is first raised; a course with the Book keeps rent off the anchor row until it is done. */
export type SceneExtra = Omit<Scene, "exchanges"> & { exchanges: ExchangeExtra[]; rent?: boolean };

export type OpeningOption = "reply" | "alt1" | "alt2" | "silence";
export interface OpeningEffect {
  reaction: string;
  /** Optional later line, said as scene `at` opens: only where the choice changes something the player meets later. */
  consequence?: string;
  at?: string;
  /** Resolved from content-declared word references by the builder. */
  audio?: string[];
}
export interface OpeningArrival {
  text: string;
  decodedText?: string;
  menu: string;
  audio?: string[];
}
export interface OpeningSceneStyle { glosses?: boolean; select?: boolean; prompt?: string }
/**
 * A clue or a memory that floats up when the player tries to work out a line. `learned`: the label it takes once
 * the player has made that choice (a sentence heard but not understood, understood later).
 */
export interface OpeningCard { label: string; learned?: { choice: string; option: OpeningOption; label: string } }
/** Working out a line: the cards that float up, the one that explains it, and the thought it gives. */
export interface OpeningDeduction { cards: string[]; right: string; thought: string }
/** Optional experiment data: settings supply story references; learner content supplies acceptance rules. */
export interface OpeningProfile {
  scenes: Record<string, OpeningSceneStyle>;
  choices: Record<string, Partial<Record<OpeningOption, OpeningEffect>>>;
  /** A paper earned by one choice, read later at a place. */
  reward?: { choice: string; option: OpeningOption; paper: string; place: string; decoded: string };
  /** A scene whose arrival line and menu label depend on one choice. */
  arrival?: { scene: string; choice: string; branches: Partial<Record<OpeningOption, OpeningArrival>>; fallback: OpeningArrival };
  directions: Record<string, string>;
  cards?: Record<string, OpeningCard>;
  /** Keyed `scene:exchange`, like `choices`: every line of an opening scene is worked out this way when present. */
  deduce?: Record<string, OpeningDeduction>;
}
export type ScribeAccepts = Record<string, { meaning: string; fragments: string[] }>;

export type CourseExtra = Omit<Course, "words" | "language" | "scenes"> & {
  /** Early encounters may precede a person giving their name. */
  world: Course["world"] & { npcs: Record<string, Course["world"]["npcs"][string] & { introducedAfter?: string }> };
  words: Record<WordId, WordExtra>;
  language: LanguageExtra;
  scenes: SceneExtra[];
  letters?: LetterChart;
  labOpening?: OpeningProfile;
  scribeAccepts?: ScribeAccepts;
  /** content/settings/<setting>/papers.json: the papers on the desk when the story opens (book courses) */
  papers?: DeskPaper[];
};

/** A course seen with the fields the build adds. */
export const extra = (course: Course): CourseExtra => course as CourseExtra;

/** Whether the course uses the Book (its pack sets `book`): readings under words, Letters and Papers. */
export const bookOn = (course: Course): boolean => extra(course).language.book === true;

/**
 * Whether a word met for the first time is marked as new: underlined or boxed, and on the quiet page
 * glossed on a row of its own. A course with the Book marks none: readings under the words (rubyRow)
 * are the one help shown, and a word's meaning is a tap away and in the Book.
 */
export const freshMarks = (course: Course): boolean => !bookOn(course);
