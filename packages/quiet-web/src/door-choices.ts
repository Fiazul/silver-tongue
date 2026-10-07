// Content-driven lab opening mechanics. Reactions are immediate; a consequence is said when its later scene opens.
import { comboKey, personalize, tilePieces, type Course, type GameState, type Input, type RenderedLine } from "@silver-tongue/core";
import { deskPapers, extra, type OpeningOption } from "@silver-tongue/view";
import { labMode } from "@silver-tongue/web-common";

/** One boundary for the door experiment’s runtime, course configuration and persistence. */
export const doorExperimentOn = (course: Course, lab = typeof document !== "undefined" && labMode()): boolean =>
  lab && deskPapers(course).length > 0 && !!extra(course).labOpening;

export type { OpeningOption } from "@silver-tongue/view";
export interface OpeningChoices {
  options: Record<string, OpeningOption>;
  cardRead: boolean;
  cardAt: number;
}
export const emptyOpeningChoices = (): OpeningChoices => ({ options: {}, cardRead: false, cardAt: 0 });
export const openingEffects = (course: Course) => extra(course).labOpening?.choices ?? {};
export const openingProfile = (course: Course) => extra(course).labOpening;
export function openingArrival(course: Course, choices: OpeningChoices) {
  const profile = openingProfile(course);
  if (!profile?.arrival) return;
  return profile.arrival.branches[choices.options[profile.arrival.choice]] ?? profile.arrival.fallback;
}

/** A card's label as this game has it: a sentence heard, then understood once the choice that explains it is made. */
export function cardLabel(course: Course, choices: OpeningChoices | undefined, id: string): string | undefined {
  const card = openingProfile(course)?.cards?.[id];
  if (!card) return;
  return card.learned && choices?.options[card.learned.choice] === card.learned.option ? card.learned.label : card.label;
}

/** Native accepted alt outcomes are configured only in the lab's course, never in the shared source. */
export function prepareDoorCourse(course: Course, lab: boolean): Course {
  if (!doorExperimentOn(course, lab)) return course;
  return { ...course, scenes: course.scenes.map((scene) => ({ ...scene, exchanges: scene.exchanges.map((ex) => {
    if (!openingEffects(course)[`${scene.id}:${ex.id}`]) return ex;
    return { ...ex, variants: Object.fromEntries(Object.entries(ex.variants).map(([key, v]) => [key, {
      ...v, altOutcomes: Object.fromEntries((v.alts ?? []).map((_, i) => [i, { ...v.altOutcomes?.[i], accept: true, pay: 0, loss: 0 }])),
    }])) };
  }) })) };
}

export function openingRound(course: Course, state: GameState) {
  const run = state.run;
  const scene = run && course.scenes.find((s) => s.id === run.scene);
  const ex = scene?.exchanges[run!.exchange];
  const key = scene && ex ? `${scene.id}:${ex.id}` : undefined;
  return run && ex && key && openingEffects(course)[key] ? { key, run, variant: ex.variants[comboKey(run.combo)] } : undefined;
}

/** All authored options stay available even when core would change the exercise to tiles or typing. */
export function openingSlips(course: Course, state: GameState): RenderedLine[] | undefined {
  const round = openingRound(course, state);
  if (!round) return;
  return [round.variant.reply, ...(round.variant.alts ?? [])].map((l) => personalize(l, state.player ?? "?"));
}

export function openingOption(course: Course, state: GameState, line?: RenderedLine): OpeningOption {
  if (!line) return "silence";
  const slips = openingSlips(course, state)!;
  const i = slips.findIndex((l) => l.text === line.text && (line.intent === undefined || l.intent === line.intent));
  if (i < 0) throw new Error("Unknown opening reply");
  return i === 0 ? "reply" : `alt${i}` as OpeningOption;
}

/** Silence has no advancing core input. Complete the exchange while keeping its actual choice in our record.
 * Native accepted alts are used in pick/type mode; tiles cannot express an alt, so use the completion input.
 * The fallback also keeps a directly supplied unprepared course playable (tests and lab jumps).
 */
export function openingInput(course: Course, state: GameState, option: OpeningOption): Input {
  const { run, variant } = openingRound(course, state)!;
  const alt = option.startsWith("alt") ? Number(option.slice(3)) - 1 : undefined;
  const native = alt !== undefined && variant.altOutcomes?.[alt]?.accept;
  if (run.mode === "pick") return { type: "reply", choice: run.options.indexOf(native ? `alt:${alt}` : comboKey(run.combo)) };
  if (run.mode === "type") return { type: "replyText", text: personalize(native ? variant.alts![alt!] : variant.reply, state.player ?? "?").text };
  const used = new Set<number>();
  return { type: "replyTiles", tiles: tilePieces(variant.reply).map((p) => {
    const i = run.tiles.findIndex((t, j) => t === p && !used.has(j));
    if (i < 0) throw new Error("Missing opening completion tile");
    used.add(i);
    return i;
  }) };
}

/** Ignore legacy booleans and invalid/drifting option IDs; this record is versioned independently of core saves. */
export function parseOpeningChoices(value: unknown, course: Course): OpeningChoices {
  const result = emptyOpeningChoices();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const v = value as { options?: unknown; cardRead?: unknown; cardAt?: unknown };
  if (v.options && typeof v.options === "object" && !Array.isArray(v.options)) for (const [key, option] of Object.entries(v.options)) {
    if (typeof option === "string" && openingEffects(course)[key]?.[option as OpeningOption]) result.options[key] = option as OpeningOption;
  }
  const reward = openingProfile(course)?.reward;
  const earned = reward && result.options[reward.choice] === reward.option;
  result.cardRead = v.cardRead === true && !!earned;
  if (earned && typeof v.cardAt === "number" && Number.isInteger(v.cardAt) && v.cardAt >= 0) result.cardAt = v.cardAt;
  return result;
}
