// The start flow's six words for a course: locale/intro-<language>.json (design/start/intro.json),
// read against the course. A word's meaning is the hand-written one for the reading language, else
// the course's gloss of that word; its Listen button says the course's clips for it (the text split
// greedily into course words, longest first: a phrase the course has no single word for is said
// as the words it is made of). Pure: no DOM.
import type { Course, Word } from "@silver-tongue/core";
import { INTROS, type IntroData } from "../../locale";

function byText(course: Course): Map<string, Word> {
  const m = new Map<string, Word>();
  for (const w of Object.values(course.words)) if (w.w && !m.has(w.w)) m.set(w.w, w);
  return m;
}

/** The course words `text` is made of, longest match first; characters no word covers are skipped. */
export function wordsIn(course: Course, text: string): Word[] {
  const words = byText(course);
  const longest = Math.max(1, ...[...words.keys()].map((k) => [...k].length));
  const chars = [...text];
  const out: Word[] = [];
  for (let i = 0; i < chars.length; ) {
    let hit: Word | undefined;
    let len = 0;
    for (let n = Math.min(longest, chars.length - i); n > 0 && !hit; n--) {
      hit = words.get(chars.slice(i, i + n).join(""));
      if (hit) len = n;
    }
    if (hit) {
      out.push(hit);
      i += len;
    } else i++;
  }
  return out;
}

/** The clips that say `text` (every course word in it, in order). */
export function clipsFor(course: Course, text: string): string[] {
  return wordsIn(course, text).flatMap((w) => w.audio ?? []);
}

/** The intro for this course in its reading language; null when there are no words for its language. */
export function courseIntro(course: Course): IntroData | null {
  const src = INTROS[course.language.code];
  if (!src?.words.length) return null;
  return {
    language: src.language,
    words: src.words.map((w) => {
      const own = w.meaning?.[course.learner];
      const found = wordsIn(course, w.text);
      const gloss = found.length === 1 ? found[0].gloss : found.map((x) => x.gloss.split(";")[0].trim()).join(" + ");
      const meaning = own ?? gloss;
      return { ...w, ...(meaning ? { meaning: { [course.learner]: meaning } } : { meaning: {} }) };
    }),
  };
}
