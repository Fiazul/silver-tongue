import { PLAYER_MARK, type Course } from "@silver-tongue/core";
import { extra, type OpeningArrival, type OpeningEffect, type OpeningProfile, type ScribeAccepts } from "@silver-tongue/view";

type SoundSource = { audioWords?: string[] };
export type OpeningSource = Omit<OpeningProfile, "choices" | "arrival"> & {
  choices: Record<string, Record<string, OpeningEffect & SoundSource>>;
  arrival: Omit<OpeningProfile["arrival"], "branches" | "fallback"> & {
    branches: Record<string, OpeningArrival & SoundSource>;
    fallback: OpeningArrival & SoundSource;
  };
};
const sounds = (source: OpeningSource): SoundSource[] => [
  ...Object.values(source.choices ?? {}).flatMap((options) => Object.values(options)),
  ...Object.values(source.arrival?.branches ?? {}), ...(source.arrival?.fallback ? [source.arrival.fallback] : []),
];
/** Include declared sound words in the course's clip manifest even if no ordinary exercise uses them. */
export const openingWordIds = (source: OpeningSource): string[] => sounds(source).flatMap((sound) => Array.isArray(sound.audioWords) ? sound.audioWords.filter((id) => typeof id === "string") : []);

/** Validate story references and compile sound references to clips; frontend code never needs word IDs. */
export function compileOpening(source: OpeningSource, course: Course, messages: Set<string>): { profile: OpeningProfile; errors: string[] } {
  const profile = structuredClone(source);
  const errors: string[] = [];
  const scene = (id: string) => course.scenes.find((scene) => scene.id === id);
  const exchange = (key: string) => {
    const [id, line, ...rest] = key.split(":");
    return rest.length ? undefined : scene(id)?.exchanges.find((ex) => ex.id === line);
  };
  /** Whether scene `id` can only be played after scene `before`. */
  const follows = (id: string, before: string): boolean => {
    const seen = new Set<string>();
    const walk = (at: string): boolean => (scene(at)?.after ?? []).some((prev) => prev === before || (!seen.has(prev) && (seen.add(prev), walk(prev))));
    return walk(id);
  };
  const message = (id: string) => { if (!messages.has(id)) errors.push(`opening.json: missing message "${id}"`); };
  for (const [id, style] of Object.entries(profile.scenes)) {
    if (!scene(id)) errors.push(`opening.json: unknown scene "${id}"`);
    if (style.prompt) message(style.prompt);
  }
  for (const [key, options] of Object.entries(profile.choices)) {
    const ex = exchange(key);
    if (!ex) errors.push(`opening.json: unknown exchange "${key}"`);
    for (const [option, effect] of Object.entries(options)) {
      const alt = /^alt([1-3])$/.exec(option);
      if (option !== "reply" && option !== "silence" && (!alt || !ex || Object.values(ex.variants).some((v) => !v.alts?.[Number(alt[1]) - 1]))) errors.push(`opening.json: unknown option "${key}/${option}"`);
      message(effect.reaction);
      if (effect.consequence !== undefined) {
        message(effect.consequence);
        if (!effect.at || !scene(effect.at)) errors.push(`opening.json: unknown consequence scene "${effect.at}"`);
        // It is said as that scene opens, so the scene must come after the choice.
        else if (!follows(effect.at, key.split(":")[0])) errors.push(`opening.json: consequence of "${key}/${option}" is said in "${effect.at}", which does not come after it`);
      }
    }
  }
  // Every option the player can take in an opening scene needs its reaction: reply, each written wrong reply, silence.
  for (const id of Object.keys(profile.scenes)) for (const ex of scene(id)?.exchanges ?? []) {
    const alts = Math.max(0, ...Object.values(ex.variants).map((v) => v.alts?.length ?? 0));
    for (const option of ["reply", ...Array.from({ length: alts }, (_, i) => `alt${i + 1}`), "silence"]) {
      if (!profile.choices[`${id}:${ex.id}`]?.[option as keyof (typeof profile.choices)[string]]) errors.push(`opening.json: no reaction for "${id}:${ex.id}/${option}"`);
    }
  }
  const reward = profile.reward;
  if (!profile.choices[reward.choice]?.[reward.option]) errors.push(`opening.json: unknown reward choice "${reward.choice}/${reward.option}"`);
  if (!extra(course).papers?.some((paper) => paper.id === reward.paper && paper.reward)) errors.push(`opening.json: unknown reward paper "${reward.paper}"`);
  if (!course.world.places[reward.place]) errors.push(`opening.json: unknown reward place "${reward.place}"`);
  message(reward.decoded);
  if (!scene(profile.arrival.scene)) errors.push(`opening.json: unknown arrival scene "${profile.arrival.scene}"`);
  if (!profile.choices[profile.arrival.choice]) errors.push(`opening.json: unknown arrival choice "${profile.arrival.choice}"`);
  for (const option of Object.keys(profile.arrival.branches)) if (!profile.choices[profile.arrival.choice]?.[option as keyof (typeof profile.choices)[string]]) errors.push(`opening.json: arrival branch "${option}" is not an option of "${profile.arrival.choice}"`);
  for (const branch of [...Object.values(profile.arrival.branches), profile.arrival.fallback]) {
    message(branch.text); message(branch.menu);
    if (branch.decodedText) message(branch.decodedText);
  }
  for (const [key, id] of Object.entries(profile.directions)) {
    if (!exchange(key)) errors.push(`opening.json: unknown direction exchange "${key}"`);
    message(id);
  }
  for (const sound of sounds(profile)) {
    const target = sound as SoundSource & { audio?: string[] };
    if (target.audioWords !== undefined) {
      if (!Array.isArray(target.audioWords)) errors.push("opening.json: audioWords must be a list");
      else {
        target.audio = target.audioWords.flatMap((id) => {
          const word = course.words[id];
          if (!word?.audio?.length) errors.push(`opening.json: unknown or silent audio word "${id}"`);
          return word?.audio ?? [];
        });
      }
      delete target.audioWords;
    }
  }
  return { profile: profile as OpeningProfile, errors };
}

/** Acceptance data belongs to the reading language. Catch removed source lines and changed meanings at build time. */
export function scribeProblems(rules: ScribeAccepts, course: Course): string[] {
  const lines = new Map<string, string[]>();
  for (const scene of course.scenes) for (const ex of scene.exchanges) for (const key of Object.keys(ex.variants)) {
    const v = ex.variants[key];
    const current = [[ex.id, v.npc], [`${ex.id}-reply`, v.reply], ...(v.alts ?? []).map((line, i) => [`${ex.id}-alt${i + 1}`, line] as const), ...Object.entries(v.altOutcomes ?? {}).flatMap(([i, outcome]) => outcome.reaction ? [[`${ex.id}-alt${Number(i) + 1}-answer`, outcome.reaction] as const] : [])] as const;
    for (const [id, line] of current) lines.set(`${scene.id}:${id}`, [...(lines.get(`${scene.id}:${id}`) ?? []), line.meaning ?? ""]);
  }
  return Object.entries(rules).flatMap(([key, rule]) => {
    if (!lines.has(key)) return [`scribe accepts: unknown line "${key}"`];
    if (!Array.isArray(rule.fragments) || !rule.fragments.length || rule.fragments.some((s) => typeof s !== "string" || !s.trim())) return [`scribe accepts: "${key}" needs nonempty fragments`];
    if (!lines.get(key)!.includes(rule.meaning.replace(/\{\s*\$player\s*\}/g, PLAYER_MARK))) return [`scribe accepts: stale meaning for "${key}"`];
    return [];
  });
}
