// Barks, pure: who in a space can be talked to outside the course (walkers, dressing characters:
// people standing about, pets, pigeons), the role each one has, and the line they say. The lines
// live in barks/<language>.json (outside src/, see barks/index.ts). No core state: a bark spends no
// slot and logs nothing.
//
// A figure's role: its `role` (walkers and dressing entries, scripts/port-town.mjs and
// src/layout.json), else its asset name (cat, dog, pigeon), else FALLBACK_ROLE. A story NPC's role
// is its npc id (said when it has no scene for you right now, game.ts talkTo).
import type { Course, Token } from "@silver-tongue/core";
import type { BarkBook, BarkLine } from "../barks";
import type { LayoutIndex, Vec3 } from "./layout";

export type { BarkBook, BarkLine } from "../barks";

/** Anyone whose role the book lacks says this role's lines. */
export const FALLBACK_ROLE = "passerby";
/** Clip ids of barks carry this prefix, so game.ts says them on the bark player (assets/audio/barks/), not the course's. */
export const BARK_CLIP = "bark:";
export const isBarkClip = (clip: string) => clip.startsWith(BARK_CLIP);

/** Asset kinds (index.json) that are characters (world.ts CHARACTER_KINDS: they get an actor). */
const CHARACTER_KINDS = new Set(["human", "recolour", "pet"]);

export type FigureKind = "walker" | "extra" | "scatter";

/** Someone in a space who barks. `slot`: their index in SceneSpace's walkers / extras / scatterers (world.ts builds them in layout order). */
export interface Figure {
  /** stable id: `bark:walker:0`, `bark:extra:1`, `bark:scatter:2` (the bubble's speaker) */
  id: string;
  kind: FigureKind;
  slot: number;
  asset: string;
  role: string;
  /** the role came from the figure (its `role` or its asset), not the fallback */
  mapped: boolean;
  /** where it starts (walkers: the path's first point; y 0 then) */
  home: Vec3;
}

/** The role a figure has in `book`: its own, else its asset's, else the fallback. */
export function roleOf(book: BarkBook, entry: { role?: string; asset: string }): { role: string; mapped: boolean } {
  if (entry.role && book.roles[entry.role]) return { role: entry.role, mapped: true };
  if (!entry.role && book.roles[entry.asset]) return { role: entry.asset, mapped: true };
  return { role: FALLBACK_ROLE, mapped: false };
}

/** A story NPC's role: its npc id when the book has lines for it, else the fallback. */
export function npcRole(book: BarkBook, npc: string): { role: string; mapped: boolean } {
  return book.roles[npc] ? { role: npc, mapped: true } : { role: FALLBACK_ROLE, mapped: false };
}

/** Everyone in a space who barks, in the order SceneSpace builds them (walkers; dressing characters: scatterers apart). */
export function spaceFigures(L: LayoutIndex, space: string, book: BarkBook): Figure[] {
  const s = L.space(space);
  const out: Figure[] = [];
  s.walkers.forEach((w, i) => {
    out.push({ id: `bark:walker:${i}`, kind: "walker", slot: i, asset: w.character, ...roleOf(book, { role: w.role, asset: w.character }), home: [w.path[0][0], 0, w.path[0][1]] });
  });
  let extra = 0;
  let scatter = 0;
  for (const d of s.dressing) {
    const e = L.asset(d.asset);
    if (e.set !== "characters" || !CHARACTER_KINDS.has(e.kind ?? "")) continue;
    const kind: FigureKind = d.behaviour === "scatter" ? "scatter" : "extra";
    const slot = kind === "scatter" ? scatter++ : extra++;
    out.push({ id: `bark:${kind}:${slot}`, kind, slot, asset: d.asset, ...roleOf(book, d), home: [...d.pos] });
  }
  return out;
}

/**
 * Picks a role's line at random, never the one it said last (a role with one line repeats it). A
 * role the book lacks says the fallback's.
 */
export class BarkPicker {
  private last = new Map<string, number>();

  constructor(
    readonly book: BarkBook,
    private rng: () => number = Math.random,
  ) {}

  pick(role: string): { role: string; line: BarkLine; index: number } {
    const r = this.book.roles[role]?.lines.length ? role : FALLBACK_ROLE;
    const lines = this.book.roles[r]?.lines ?? [];
    if (!lines.length) return { role: r, line: { text: "…", gloss: {} }, index: -1 };
    const prev = this.last.get(r);
    let i = Math.min(lines.length - 1, Math.floor(this.rng() * lines.length));
    if (lines.length > 1 && i === prev) {
      // one of the others, still at random
      i = (prev + 1 + Math.min(lines.length - 2, Math.floor(this.rng() * (lines.length - 1)))) % lines.length;
    }
    this.last.set(r, i);
    return { role: r, line: lines[i], index: i };
  }
}

/**
 * The course's words in a bark (greedy, longest written form first), so its words are tappable as
 * a story line's are. Spaced languages match whole words only. Text no word covers stays plain.
 */
export function barkTokens(course: Pick<Course, "words" | "language">, text: string, forms = wordForms(course)): Token[] {
  const out: Token[] = [];
  const spaced = course.language.spaced;
  const isLetter = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
  let i = 0;
  while (i < text.length) {
    let hit: { len: number; word: string } | null = null;
    if (!spaced || !isLetter(text[i - 1])) {
      for (let len = Math.min(forms.max, text.length - i); len > 0; len--) {
        const w = forms.byForm.get(text.slice(i, i + len));
        if (w && (!spaced || !isLetter(text[i + len]))) {
          hit = { len, word: w };
          break;
        }
      }
    }
    if (hit) {
      out.push({ start: i, end: i + hit.len, word: hit.word });
      i += hit.len;
    } else i++;
  }
  return out;
}

/** written form -> word id (the first word with that form), and the longest form's length */
export function wordForms(course: Pick<Course, "words">): { byForm: Map<string, string>; max: number } {
  const byForm = new Map<string, string>();
  let max = 0;
  for (const [id, w] of Object.entries(course.words)) {
    if (!w.w || byForm.has(w.w)) continue;
    byForm.set(w.w, id);
    max = Math.max(max, w.w.length);
  }
  return { byForm, max };
}

/** A line's meaning for a native language: that one, else English's, else any. */
export function barkGloss(line: BarkLine, native: string, fallback: string): string | undefined {
  return line.gloss[native] ?? line.gloss[fallback] ?? Object.values(line.gloss)[0];
}
