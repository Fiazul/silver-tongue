export type WordId = string;

/**
 * Stands for the player's name in built lines (a private-use character, never a word). The core
 * puts the name in before a line reaches a front end.
 */
export const PLAYER_MARK = "\uE000";

export interface Word {
  id: WordId;
  w: string;
  /** how to say it, most native first; the last is the one sentence help shows */
  readings?: string[];
  lv: string;
  gloss: string;
  /** a curated 1-3 word display gloss, when the pack's own first sense isn't a good short form */
  short?: string;
  bonus?: boolean;
  /** clip ids that say the word */
  audio?: string[];
}

/** A word's position in a line. Offsets are UTF-16 indices, `end` exclusive. */
export interface Token {
  start: number;
  end: number;
  word: WordId;
}

export interface RenderedLine {
  text: string;
  tokens: Token[];
  /** clip ids, said in order with a beat between (a line with the player's name has one each side) */
  audio?: string[];
  /** what the whole line means, in the learner's language */
  meaning?: string;
}

export interface Variant {
  npc: RenderedLine;
  reply: RenderedLine;
  rephrase?: RenderedLine;
  /** written wrong replies, offered alongside the right one (pick mode: "alt:<n>"; tiles: extra words) */
  alts?: RenderedLine[];
  /** what a right reply spends (resolved from the exchange's cost for this slot combination) */
  cost?: number;
}

export interface Exchange {
  id: string;
  /** slot name -> group name */
  slots: Record<string, string>;
  /** action parameters; a value "$slot" refers to a slot */
  expect: Record<string, string>;
  /** "$slot" or a concept name */
  hinges: string[];
  pay: number;
  missCost: number;
  /** what a right reply spends: a number, or "$slot" whose value is a number concept. The build resolves it into each variant's cost. */
  cost?: number | string;
  /** keyed by comboKey(combo); "" when the exchange has no slots */
  variants: Record<string, Variant>;
}

export interface Scene {
  id: string;
  place: string;
  npc: string;
  stage: number;
  after: string[];
  requires: { trust?: Record<string, number> };
  repeatable: boolean;
  trustGain: number;
  /** "$<slot>": finishing this scene starts an errand to the place that slot named (its value is a place id). */
  startsErrand?: string;
  /** Finishing this scene delivers the errand. It is offered only while the errand is for this scene's place. */
  endsErrand?: boolean;
  exchanges: Exchange[];
}

export interface Place {
  links: string[];
}

export interface Npc {
  place: string;
}

/** The NPC who explains usage notes, once the scene `after` is done. */
export interface Mentor {
  npc: string;
  after: string;
}

export interface World {
  start: string;
  currency: string;
  slotsPerDay: number;
  startWallet: number;
  foodPerDay: number;
  rentPerWeek: number;
  places: Record<string, Place>;
  npcs: Record<string, Npc>;
  mentor?: Mentor;
  /** The place the player sleeps. Without it, sleep works anywhere. */
  home?: string;
  /**
   * The scene whose completion grants the player their home. Before it's done, sleep works
   * anywhere (a rough night); once it's done, `home` (if set) applies as usual. Without this,
   * behaviour is unchanged: `home` (if set) always applies.
   */
  homeScene?: string;
}

/** A usage note the mentor explains once its trigger is met: a word seen, or a scene done. */
export interface Note {
  id: string;
  trigger: { word: WordId } | { scene: string };
}

/** What the engine needs to know about the language being learned. */
export interface LanguageProfile {
  /** the language pack's code */
  code: string;
  /** Fluent/Intl locale for lines in this language */
  locale: string;
  /** speech locale */
  tts: string;
  /** true when words are written with spaces between them */
  spaced: boolean;
}

/** One course in dist/courses/index.json. */
export interface CatalogEntry {
  id: string;
  language: string;
  setting: string;
  /** reading languages, the default first */
  learners: string[];
  /** reading language code -> its own name, from its `learner-name` */
  learnerNames: Record<string, string>;
}

/** Built course output: everything the game loads. */
export interface Course {
  id: string;
  /** the reading language this file was built for */
  learner: string;
  language: LanguageProfile;
  /** earlier ids of this course, whose saves it still loads */
  aliases?: string[];
  typing: boolean;
  words: Record<WordId, Word>;
  /** concept -> the word ids its base form is made of */
  concepts: Record<string, WordId[]>;
  /** group -> concepts */
  groups: Record<string, string[]>;
  world: World;
  scenes: Scene[];
  reactions: Record<string, RenderedLine>;
  /** reaction id -> npc id -> clip ids: each NPC says a reaction in their own voice */
  reactionAudio?: Record<string, Record<string, string[]>>;
  /** learner-language Fluent source: UI text, narration and mentor notes */
  learnerFtl: string;
  /** concept -> its name in the learner's language, for narration ("tea") */
  conceptNames: Record<string, string>;
  /** stage -> every word id on that stage's word list, including words no scene uses yet */
  stageWords: Record<string, WordId[]>;
  /** in the order the mentor explains them */
  notes: Note[];
  /** some lines say the player's name, so a game needs one before its first scene */
  needsName: boolean;
}

export type WordState = "unseen" | "met" | "shaky" | "known";
export type ReplyMode = "pick" | "tiles" | "type";

export interface WordRecord {
  right: number;
  wrong: number;
  streak: number;
  helps: number;
  /** missed or helped since the last correct answer */
  lapsed: boolean;
  firstSeen: number;
  lastSeen: number;
  /** the line the word was first heard in, and where */
  first?: { line: string; place: string };
}

export interface SceneRun {
  scene: string;
  exchange: number;
  combo: Record<string, string>;
  mode: ReplyMode;
  /** pick mode: combo keys, or "alt:<n>" for a written wrong reply, in display order */
  options: string[];
  /** tiles mode: tile texts in display order */
  tiles: string[];
  misses: number;
  earned: number;
  mixups: number;
  /** the place a scene with startsErrand named, once its slot has been drawn */
  errandTo?: string;
}

/** One accepted input, for play-tests. */
export interface LogEntry {
  t: number;
  day: number;
  slot: number;
  input: Input;
}

export interface GameState {
  v: 1;
  course: string;
  /** the player's name, said in lines that have PLAYER_MARK */
  player?: string;
  day: number;
  slot: number;
  wallet: number;
  rentLate: boolean;
  /** the parcel being carried, and where it goes; absent when there is none */
  errand?: { to: string };
  place: string;
  trust: Record<string, number>;
  words: Record<WordId, WordRecord>;
  scenesDone: Record<string, number>;
  run: SceneRun | null;
  /** mentor notes: triggered and waiting (ready), and explained (read) */
  notes: { ready: string[]; read: string[] };
  /** the last accepted inputs, newest last */
  log: LogEntry[];
  /** false when the player turned sound off; absent means on */
  sound?: boolean;
}

/** Why the core refused an input. Front ends show a translated message for each. */
export const REJECT_REASONS = [
  "unknown-scene",
  "in-scene",
  "wrong-place",
  "locked",
  "no-slots",
  "stale-run",
  "no-pick",
  "bad-choice",
  "no-tiles",
  "bad-tile",
  "not-linked",
  "unknown-word",
  "no-mentor",
  "bad-name",
  "no-name",
  "not-home",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Why the wallet changed. */
export const WALLET_REASONS = ["wages", "mixup", "food", "rent", "shopping"] as const;
export type WalletReason = (typeof WALLET_REASONS)[number];

/** Replies arrive as `reply` (pick mode) or `replyTiles` (tiles mode); typed replies will add `replyText`. */
export type Input =
  | { type: "goTo"; place: string }
  /**
   * `pick` pins slot values of the scene's first exchange (a front end's "this one": the item taken
   * off a shelf); a slot the exchange lacks, or a value its slot's group lacks, is ignored.
   */
  | { type: "startScene"; scene: string; pick?: Record<string, string> }
  | { type: "reply"; choice: number }
  | { type: "replyTiles"; tiles: number[] }
  | { type: "helpWord"; word: WordId }
  | { type: "visitMentor" }
  | { type: "setName"; name: string }
  | { type: "sleep" }
  /** turns sound on or off; allowed anywhere, even mid-scene, and uses no slot */
  | { type: "setSound"; on: boolean };

export type GameEvent =
  | { type: "placeEntered"; place: string }
  | { type: "sceneStarted"; scene: string; npc: string }
  | { type: "lineSpoken"; npc: string; line: RenderedLine }
  | { type: "replyOptions"; mode: "pick"; options: RenderedLine[] }
  | { type: "replyOptions"; mode: "tiles"; tiles: string[] }
  /**
   * action: what the player's reply did. expected: what the NPC asked for.
   * diff: the slots the player got wrong (pick mode). tilesWrong: the tiles didn't make the reply
   * (tiles mode, where the slots are always the expected ones).
   */
  | {
      type: "actionPerformed";
      action: Record<string, string>;
      expected: Record<string, string>;
      matched: boolean;
      diff: string[];
      tilesWrong: boolean;
    }
  | { type: "npcReacted"; npc: string; reaction: string; line: RenderedLine }
  /** slow: no rephrase was written, so this replays the original line (show it slowly, with pronunciation) */
  | { type: "lineRephrased"; npc: string; line: RenderedLine; slow: boolean }
  | { type: "walletChanged"; wallet: number; delta: number; reason: WalletReason }
  | { type: "trustChanged"; npc: string; trust: number }
  | { type: "wordStateChanged"; word: WordId; from: WordState; to: WordState }
  | { type: "sceneEnded"; scene: string; earned: number }
  | { type: "unlocked"; scene: string }
  | { type: "rankChanged"; rank: number }
  /** rough: true when this sleep happened away from home, before `world.homeScene` was done */
  | { type: "dayEnded"; day: number; rough?: boolean }
  /** a mentor note's trigger was met; the mentor can now explain it */
  | { type: "noteReady"; note: string }
  | { type: "playerNamed"; name: string }
  /** notes: the notes explained on this visit, in order; empty when there was nothing new */
  | { type: "mentorVisited"; npc: string; notes: string[] }
  | { type: "errandStarted"; to: string }
  | { type: "errandEnded"; to: string }
  | { type: "inputRejected"; reason: RejectReason }
  | { type: "soundSet"; on: boolean };
