// The desk: the papers on the desk when a book course's story opens (content/settings/<setting>/papers.json),
// read aloud by typing their romanization. Front-end only: core has no notion of documents.
import type { Course, GameState, RenderedLine } from "@silver-tongue/core";
import { bookOn, extra } from "./course-extra";
import type { Text } from "./text";

export type DeskPaperKind = "card" | "masthead" | "bill";
export interface DeskPaperLine {
  id: string;
  /** Hangul, digits and punctuation only */
  text: string;
  /** what text-to-speech reads instead of `text` (a number read digit by digit, a Latin name in Hangul) */
  say?: string;
  /** a name printed in Latin letters beside the Hangul, as on an ID card: shown, never sounded out */
  latin?: boolean;
  /** its clip ids, in the words voice (added by the build) */
  audio?: string[];
}
export interface DeskPaper {
  id: string;
  kind: DeskPaperKind;
  /** a place whose name becomes `place-<place>-known` once this paper is read */
  names?: string;
  /** Lab reward source; omitted papers are on the opening desk. */
  reward?: string;
  /** Lines required before the knock; omitted means the whole paper, [] means optional. */
  required?: string[];
  lines: DeskPaperLine[];
}

export const deskPapers = (course: Course): DeskPaper[] => (bookOn(course) ? (extra(course).papers ?? []).filter((p) => !p.reward) : []);

/** Whether the desk comes up for this game: a book course with papers, no scene done yet, some paper unread. */
export function deskOn(course: Course, state: GameState, read: ReadonlySet<string>): boolean {
  const ps = deskPapers(course);
  if (!ps.length) return false;
  if (Object.values(state.scenesDone).some((n) => n > 0)) return false;
  return !deskReady(ps, read);
}

/**
 * A paper is done when it is read in full, or when the lines it requires are read ([] requires none: an optional
 * paper is done from the start). One rule for the knock and for the order papers are read in, so a paper whose
 * required lines are read never holds up the next one.
 */
export const paperDone = (p: DeskPaper, read: ReadonlySet<string>): boolean =>
  read.has(p.id) || (p.required !== undefined && p.required.every((id) => read.has(`${p.id}.${id}`)));

/** Required discovery is complete; optional documents remain available in the Book. */
export const deskReady = (papers: DeskPaper[], read: ReadonlySet<string>): boolean => papers.every((p) => paperDone(p, read));

/** The paper to read next on the desk: the first one not done yet. */
export const firstUnread = (papers: DeskPaper[], read: ReadonlySet<string>): string | undefined => papers.find((p) => !paperDone(p, read))?.id;

/** A paper can be opened when it is done (or optional) or is the next one; later papers wait their turn. */
export const canOpenPaper = (papers: DeskPaper[], read: ReadonlySet<string>, id: string): boolean => {
  const p = papers.find((x) => x.id === id);
  return (!!p && paperDone(p, read)) || firstUnread(papers, read) === id;
};

/** Where the read set is kept in the browser. */
export const papersKey = (course: string): string => `silver-tongue:papers:${course}`;

/** Where the page remembers that the player has looked a word up (the look-up hint is then gone for good). */
export const lookupHintKey = (course: string): string => `silver-tongue:lookup-hint:${course}`;

/** Shortest word that counts as recognised: one syllable turns up inside other words by chance. */
const SOUNDED_MIN = 2;

/**
 * The words of a line the player has already sounded out on the desk: those whose written text appears
 * inside a line of a paper they have read (the name on the ID card). Indexes into `line.tokens`.
 */
export function soundedTokens(course: Course, read: ReadonlySet<string>, line: RenderedLine): Set<number> {
  const seen = deskPapers(course).flatMap((p) => p.lines.filter((l) => read.has(p.id) || read.has(`${p.id}.${l.id}`)).map((l) => l.text));
  const out = new Set<number>();
  line.tokens.forEach((tk, i) => {
    const text = line.text.slice(tk.start, tk.end);
    if ([...text].length >= SOUNDED_MIN && seen.some((s) => s.includes(text))) out.add(i);
  });
  return out;
}

/** A place's name for the quiet page: once a paper that names it is read, `place-<id>-known`. */
export function placeName(course: Course, state: GameState | { place: string }, read: ReadonlySet<string>, t: Text, place = state.place): string {
  const known = deskPapers(course).some((p) => p.names === place && (read.has(p.id) || p.required?.some((id) => read.has(`${p.id}.${id}`))));
  return t(known ? `place-${place}-known` : `place-${place}`);
}

// Hangul → Revised Romanization. Syllables are decomposed with Unicode maths:
// code = 0xAC00 + (initial * 21 + medial) * 28 + final.
const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const MEDIALS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
/** a final as said at the end of a word or before a consonant */
const FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
/** a final carried over to a following vowel (the next syllable starts with the silent initial ieung) */
const LINKED = ["", "g", "kk", "gs", "n", "nj", "n", "d", "r", "lg", "lm", "lb", "ls", "lt", "lp", "r", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", ""];
// Final indexes of the simple consonants the assimilations below look at.
const F = { N: 4, L: 8 } as const;
// Initial indexes.
const I = { N: 2, R: 5, M: 6, SILENT: 11 } as const;

interface Syllable { i: number; m: number; f: number }
const syllable = (ch: string): Syllable | undefined => {
  const c = ch.codePointAt(0)! - 0xac00;
  if (c < 0 || c > 11171) return undefined;
  return { i: Math.floor(c / 588), m: Math.floor((c % 588) / 28), f: c % 28 };
};

/**
 * Revised Romanization of Korean text, lowercase. Handles the common sound changes between two syllables
 * of one word: a final carried over to a following vowel (hanguk-eo → hangugeo); final k/t/p before n/m said
 * ng/n/m (hapnida → hamnida); k+r said ngn (deungrok → deungnok); n+r and l+n said ll (sinra → silla); m/ng+r
 * said n (jongro → jongno). `plain`: no sound changes, each syllable spelled on its own (deungrok).
 * The syllables' layout is Unicode's (the Hangul Syllables block), so this knows one script by design.
 * Anything that isn't Hangul (digits, spaces, punctuation) is kept as it is.
 */
export function romanize(text: string, plain = false): string {
  return romanizeParts(text, plain).join("");
}

/** `romanize`, one piece per character (a syllable's reading with the sound changes its neighbours give it). */
function romanizeParts(text: string, plain: boolean): string[] {
  const chars = [...text];
  const syls = chars.map(syllable);
  const out: string[] = [];
  for (let k = 0; k < chars.length; k++) {
    const s = syls[k];
    if (!s) {
      out.push(chars[k]);
      continue;
    }
    const prev = plain ? undefined : syls[k - 1];
    const next = plain ? undefined : syls[k + 1];
    // The initial, as changed by the syllable before.
    let initial = INITIALS[s.i];
    if (prev) {
      if (s.i === I.SILENT && prev.f) initial = ""; // carried over by the previous syllable
      else if (s.i === I.R && (prev.f === F.N || prev.f === F.L)) initial = "l";
      else if (s.i === I.N && prev.f === F.L) initial = "l"; // l+n: ll
      else if (s.i === I.R && prev.f) initial = "n"; // k+r, m+r, ng+r, p+r…: r said n
    }
    // The final, as changed by the syllable after.
    let final = FINALS[s.f];
    if (next && s.f) {
      if (next.i === I.SILENT) final = LINKED[s.f];
      else if (next.i === I.R && s.f === F.N) final = "l";
      else if (next.i === I.R && s.f === F.L) final = "l";
      else if ((next.i === I.N || next.i === I.M || next.i === I.R) && final === "k") final = "ng";
      else if ((next.i === I.N || next.i === I.M || next.i === I.R) && final === "t") final = "n";
      else if ((next.i === I.N || next.i === I.M || next.i === I.R) && final === "p") final = "m";
    }
    out.push(initial + MEDIALS[s.m] + final);
  }
  return out;
}

/** A romanization folded so the spellings a learner might use meet: McCune–Reischauer, Yale-ish, doubled letters. */
export function foldRomanization(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/sh/g, "s")
    .replace(/ch/g, "j")
    .replace(/oe/g, "we")
    .replace(/eo/g, "o")
    .replace(/eu/g, "u")
    .replace(/ae/g, "e")
    .replace(/k/g, "g")
    .replace(/t/g, "d")
    .replace(/p/g, "b")
    .replace(/l/g, "r")
    .replace(/([^aeiouwy0-9])\1+/g, "$1");
}

/** Whether what the player typed reads as the Korean text: its romanization, with or without the sound changes. */
export function readsAs(typed: string, text: string): boolean {
  const got = foldRomanization(typed);
  if (!got) return false;
  return got === foldRomanization(romanize(text)) || got === foldRomanization(romanize(text, true));
}
