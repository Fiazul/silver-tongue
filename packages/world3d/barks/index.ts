// Barks: what everyone in the town says when talked to outside the course's scenes (the walkers,
// the pets, the people standing about and inside, and a story NPC with no scene for you right now).
// Kept outside src/ as locale/ is (tools/test/language-free.test.ts keeps packages/*/src free of any
// particular language): one <language>.json per course language, keyed by `course.language.code`.
//
// - roles.<role>.lines: 1-3 lines, `text` in the language, `reading` (pinyin for zh), `gloss` per
//   native (reading) language (every UI language of locale/), `clip` written by
//   scripts/bark-audio.mjs (<clip>.ogg / .m4a under audio/<language>/, shipped as
//   assets/audio/barks/<language>/).
// - roles.<role>.voice: the edge-tts voice (default the file's `voice`; a story NPC's role is its npc
//   id and defaults to content/languages/<language>/voices.json's voice for it).
import zh from "./zh.json";

export interface BarkLine {
  text: string;
  reading?: string;
  /** native (reading) language -> meaning */
  gloss: Record<string, string>;
  /** clip id: audio/<language>/<clip>.{ogg,m4a} */
  clip?: string;
}
export interface BarkRole {
  voice?: string;
  lines: BarkLine[];
}
export interface BarkBook {
  language: string;
  voice?: string;
  roles: Record<string, BarkRole>;
}

/** Bark books by course language (course.language.code). */
export const BARKS: Record<string, BarkBook> = Object.fromEntries([zh as BarkBook].map((b) => [b.language, b]));
