// Forked from packages/vn-web/src/vn.ts so the two pages can evolve apart. Differences: beats are not
// tapped through (everything said lands in the transcript at once), money is not narrated line by
// line (a reply's cost rides on the reply; food is silent; wages ride on the one line a finished scene
// folds into), trust is silent, the scene being played is exposed for the review tell, and any line can
// be revealed.
import { describeRun, normalizeTyped, typedMatches, wordState, type Core, type Course, type GameEvent, type GameState, type Input, type RenderedLine, type WordId } from "@silver-tongue/core";
import {
  extra, bookOn, deskOn, deskReady, deskPapers, emptyProgress, freshMarks, heardCount, lettersFollowDesk, metLetters, onboarding, paperSyllables, placeName,
  actionNarration, bedHint, bedPlace, introLines, isBedtime, likelyOrder, npcLabel, primaryItem, joinTilesForDisplay, makeText, placeMenu, sentenceCard, tileEcho, typePrompt, waitingForMoney, wordCard,
  type AudioOut, type DeskPaper, type DeskProgress, type MenuItem, type SentenceCard, type Speech, type Text, type WordCard,
} from "@silver-tongue/view";

import { doorExperimentOn, type OpeningStore } from "./scribe";
import { emptyOpeningChoices, openingArrival, openingEffects, openingProfile, openingInput, openingOption, openingRound, openingSlips, parseOpeningChoices, type OpeningChoices, type OpeningOption } from "./door-choices";

export interface Beat {
  id: number;
  /** an NPC id, "player" for the player's own reply, absent for narration */
  speaker?: string;
  /** a line in the language being learned */
  line?: RenderedLine;
  /** narration or a mentor note, in the reading language */
  text?: string;
  /** a mentor note's title */
  title?: string;
  /** react: an NPC's reaction to a miss, and narration of what was asked instead. narr: stage direction
   * (the opening story, a scene's framing, what the player did, where a resumed game is, a new day).
   * good / warn / plain: outcomes (wages, money). done: a finished conversation, folded to one line. */
  tone?: "plain" | "warn" | "good" | "react" | "narr" | "done";
  /** Lab choice response: keep it visible beside the next exchange’s context. */
  openingReaction?: boolean;
  /** words new to the player when this line was said: heard for the first time, or never heard at all
   * (a reaction line is not counted as hearing), and not glossed yet in this transcript. The only words
   * that gloss themselves; each word glosses once per game session. None on a course with the Book (see freshMarks). */
  fresh?: WordId[];
  /** what the player's reply cost (a negative wallet change), shown on the reply; mixup when a miss cost it */
  cost?: { amount: number; reason: "mixup" | "shopping" };
  /** said again after two misses: shown with its reading and meaning */
  rephrase?: boolean;
  /** a rephrase that is the same line said slower */
  slow?: boolean;
  /** a reaction to a miss: the request, said again on the same line (no second clip). After a second
   * miss it is the rephrase (or the line said slower), shown with its reading and meaning. */
  restate?: Restate;
  /** a new day starts here */
  day?: number;
  /** an NPC's line: the scene run it was said in (the run's first beat id), for speakerNamed */
  run?: number;
  /** an NPC's line said in the onboarding window (see onboarding): its reading and meaning show under it */
  onboard?: boolean;
}
export interface Restate {
  line: RenderedLine;
  /** words new in a rephrase; none for the request said again (they were glossed when first said) */
  fresh?: WordId[];
  rephrase?: "rephrase" | "slower";
}
export type Phase =
  | { kind: "name" }
  /** confused: "..." is offered after the replies, until the line has been said again */
  | { kind: "pick"; options: RenderedLine[]; confused: boolean }
  | { kind: "tiles"; tiles: string[]; placed: number[]; answer: string }
  /** the reply is typed, in the language or its romanization; no hints here */
  | { kind: "type"; prompt: string; confused: boolean }
  /** primary: with the Book, the one item drawn bright (Enter does it); the rest are quiet */
  | { kind: "explore"; menu: MenuItem[]; waiting: string[]; primary?: number };
export interface Toast { id: number; text: string; tone: "good" | "bad" | "info" }
export interface QuietView {
  /** the scene being played, for the review tell */
  scene?: string;
  phase: Phase;
  /** the NPC line replies answer: what `?` reveals when no line is named */
  lastLine?: RenderedLine;
  backlog: Beat[];
  toasts: Toast[];
  /** a new game on a course with the Book, before the player is named: the opening story, shown as the
   * crawl before the name screen instead of in the transcript */
  opening?: string[];
  /** a book course with papers, named but before any scene: the papers on the desk, read before the transcript */
  desk?: DeskPaper[];
  /** a book course's player is still in the onboarding window (see onboarding): replies come with their meaning */
  onboard: boolean;
  /** the NPC line the one-time look-up hint sits under (a book course, until the first look-up or the scene ends) */
  lookupHint?: number;
  /** the first beat of the scene being played (a book course): where the stage starts (see stageView) */
  stageFrom?: number;
}
/** Where the desk's read papers are kept (the browser's storage on the page). */
export interface PaperStore {
  load(): string[];
  save(ids: string[]): void;
  /** syllables read per paper, and the letters met */
  loadProgress?(): DeskProgress;
  saveProgress?(p: DeskProgress): void;
  /** whether the look-up hint is finished with: a word was looked up, or the first scene ended */
  loadLookupDone?(): boolean;
  saveLookupDone?(): void;
}
export interface QuietOptions {
  course: Course;
  core: Core;
  now: () => number;
  /** saves after each accepted input; false if it couldn't. Leave out to play without saving. */
  save?: (state: GameState) => boolean;
  audio?: AudioOut;
  /** a message id shown once at start, e.g. "notice-bad-save" */
  notice?: string;
  /** the desk's read papers; left out, they are forgotten on reload */
  papers?: PaperStore;
  /** Page's labMode flag; defaults to the page metadata where available. */
  lab?: boolean;
  openingChoice?: OpeningStore;
}
export interface Quiet {
  readonly t: Text;
  readonly course: Course;
  readonly core: Core;
  view(): QuietView;
  subscribe(fn: () => void): () => void;
  choose(n: number): void;
  placeTile(i: number): void;
  undoTile(): void;
  sendTiles(): void;
  /** a typed reply; only dots ("...") looks confused */
  sendText(text: string): void;
  /** `surface`: the word as written in the line, when it is another form of the word */
  lookUp(word: WordId, surface?: string): WordCard;
  /** a line's reading and meaning; not logged as help. Defaults to the line replies answer. */
  sentence(line?: RenderedLine): SentenceCard | undefined;
  replay(slow?: boolean): void;
  play(clips: string[]): void;
  setName(name: string): boolean;
  /** the desk's papers read so far */
  readPapers(): ReadonlySet<string>;
  /** Actual lab decisions; main-site games have no experiment record. */
  openingChoices(): OpeningChoices | undefined;
  /** Desk documents plus earned decodable papers, never an unearned reward. */
  bookPapers(): DeskPaper[];
  /** a paper on the desk has been read out, every line */
  readPaper(id: string): void;
  readPaperLine(paper: string, line: string): void;
  /** syllables of a paper read so far (all of them once it is read) */
  deskAt(id: string): number;
  setDeskAt(id: string, n: number): void;
  /** the letters met so far (`letterKey`s); undefined when the Book shows its whole chart */
  deskMet(): ReadonlySet<string> | undefined;
  /** the letters of the syllable now on the desk are met */
  meet(keys: string[]): void;
  /** every paper read: the desk goes and the transcript starts; the door is answered when someone is there to answer it, else it opens on the place */
  leaveDesk(): void;
  /** a place's name as the quiet page shows it (the room gets its owner's name once the ID card is read) */
  placeLabel(place?: string): string;
  /** whether an option's intent is shown under it */
  intentShown(options: RenderedLine[], o: RenderedLine): boolean;
  toggleSound(): void;
  dismissToast(id: number): void;
}

/** The newest line an NPC said: what `?` reveals. */
export function latestNpcLine(backlog: Beat[]): Beat | undefined {
  for (let i = backlog.length - 1; i >= 0; i--) {
    const b = backlog[i];
    if (b.line && b.speaker && b.speaker !== "player") return b;
  }
  return undefined;
}

export const BACKLOG_LIMIT = 300;
/** A menu or reply shown less than this long ago ignores taps: the second half of a double tap lands on the new screen. */
export const SETTLE_MS = 350;
const TOAST_LIMIT = 4;
/** What the player says when looking confused. */
export const CONFUSED = "...";

/**
 * The quiet terminal's side of play: turns core events into transcript lines and keys into inputs.
 * It keeps only what is on screen; the game itself is core.state.
 */
export function createQuiet(opts: QuietOptions): Quiet {
  const { course, core } = opts;
  const experiment = doorExperimentOn(course, opts.lab);
  const profile = openingProfile(course);
  const reward = profile?.reward;
  const effects = openingEffects(course);
  const t = makeText(course.learnerFtl, course.learner);
  const npcName = (npc: string) => npcLabel(course, core.state, t, npc);
  const money = (delta: number, reason: string) =>
    t("wallet-change", { sign: delta > 0 ? "+" : "-", amount: Math.abs(delta), currency: course.world.currency, reason: t(`reason-${reason}`) });

  let scene: string | undefined;
  let queue: Beat[] = [];
  let speeches: Speech[] = [];
  let reply: { mode: "pick"; options: RenderedLine[] } | { mode: "tiles"; tiles: string[] } | { mode: "type" } | undefined;
  let placed: number[] = [];
  let lastLine: RenderedLine | undefined;
  let lastSpeech: Speech | undefined;
  let backlog: Beat[] = [];
  let toasts: Toast[] = [];
  let naming = course.needsName && !core.state.player;
  // A new game starts with the desk unread (the list is kept per course; it is saved again once named).
  let choices = experiment && !naming ? parseOpeningChoices(opts.openingChoice?.load(), course) : emptyOpeningChoices();
  if (experiment && naming) opts.openingChoice?.save(choices);
  const saveChoices = () => { if (experiment) opts.openingChoice?.save(choices); };
  let pendingChoice: { key: string; option: OpeningOption } | undefined;
  let inputTies: RenderedLine[] | undefined;
  const bookPapers = () => [...deskPapers(course), ...(experiment && reward && choices.options[reward.choice] === reward.option ? (extra(course).papers ?? []).filter((p) => p.id === reward.paper) : [])];
  const read = new Set(naming ? [] : (opts.papers?.load() ?? []));
  // The reward belongs to this game, even though legacy desk progress is stored per course.
  if (reward) read.delete(reward.paper);
  if (experiment && reward && choices.cardRead) read.add(reward.paper);
  let progress = naming ? emptyProgress() : (opts.papers?.loadProgress?.() ?? emptyProgress());
  const saveProgress = () => opts.papers?.saveProgress?.(progress);
  /** the desk is up (after the name screen): a new book course with papers, not all of them read */
  let atDesk = deskOn(course, core.state, read);
  /** the look-up hint is finished with (kept per course, so it is never shown twice) */
  let lookupDone = opts.papers?.loadLookupDone?.() ?? false;
  const finishLookup = () => {
    if (lookupDone) return;
    lookupDone = true;
    opts.papers?.saveLookupDone?.();
  };
  const placeLabel = (place = core.state.place) => experiment && reward && place === reward.place && choices.cardRead ? t(`place-${place}-known`) : placeName(course, core.state, read, t, place);
  let resuming = false;
  let nextId = 1;
  /** news that arrived mid-scene, held until the scene is over so it never lands between a line and its replies */
  let held: Omit<Toast, "id">[] = [];
  /** the first beat of the scene being played */
  let sceneFrom = 0;
  /** the conversation just finished: its beats, and the one line they fold into as it ends */
  let finished: { from: number; to: number; text: string } | undefined;
  /** the closing narration under a folded conversation: read once, gone when the player moves on */
  let closing: { from: number; to: number } | undefined;
  /** beats before this are the opening story (or where a picked-up game is): gone with the first fold */
  let preludeTo = 0;
  /** words already glossed in this transcript: a word is boxed and glossed once, then rendered as usual */
  const glossed = new Set<WordId>();
  let save = opts.save;
  const listeners = new Set<() => void>();

  const changed = () => listeners.forEach((f) => f());
  const soundOn = () => !!opts.audio?.available && core.state.sound !== false;
  const say = (lines: Speech[]) => {
    if (lines.length && soundOn()) opts.audio!.play(lines);
  };
  const speech = (clips: string[] | undefined, slow = false): Speech | undefined =>
    clips?.length ? (slow ? { clips, slow } : { clips }) : undefined;
  // News already on screen, or already held, is not said twice: it would push other news out.
  const toast = (text: string, tone: Toast["tone"]) => {
    if (toasts.some((x) => x.text === text)) return;
    toasts = [...toasts, { id: nextId++, text, tone }].slice(-TOAST_LIMIT);
  };
  const news = (text: string, tone: Toast["tone"]) => {
    if (!scene) toast(text, tone);
    else if (!held.some((h) => h.text === text)) held.push({ text, tone });
  };
  /** whether the lines being applied were said in the onboarding window (see onboarding) */
  let onboard = false;
  const book = bookOn(course);
  const push = (b: Omit<Beat, "id">, s?: Speech): Beat => {
    const npc = book && b.speaker && b.speaker !== "player";
    const beat: Beat = { id: nextId++, ...b, ...(npc && scene ? { run: sceneFrom } : {}), ...(npc && onboard ? { onboard } : {}) };
    queue.push(beat);
    if (s) speeches.push(s);
    return beat;
  };

  /** Folds the conversation just finished into one line: what was said is history once it ends. */
  function fold() {
    if (!finished) return;
    const { from, to, text } = finished;
    finished = undefined;
    const i = backlog.findIndex((b) => b.id >= from);
    if (i < 0) return;
    backlog = [...backlog.slice(0, i), { id: from, text, tone: "done" }, ...backlog.slice(i).filter((b) => b.id >= to)];
    // The opening story has been read and acted on by now.
    if (preludeTo) backlog = backlog.filter((b) => b.id >= preludeTo);
    preludeTo = 0;
  }

  /** Drops the closing narration under the last folded conversation: the player has moved on. */
  function moveOn() {
    if (!closing) return;
    const { from, to } = closing;
    closing = undefined;
    backlog = backlog.filter((b) => b.id < from || b.id >= to);
  }

  /** Moves everything said into the transcript and says it aloud, in order. */
  let shownAt = -Infinity;
  const settled = () => opts.now() - shownAt >= SETTLE_MS;
  /** `settle`: the screen changed (new replies or menu), so taps start counting again only after SETTLE_MS. */
  function flush(settle: boolean) {
    if (queue.length) backlog = [...backlog, ...queue].slice(-BACKLOG_LIMIT);
    queue = [];
    fold();
    say(speeches);
    speeches = [];
    if (!scene && held.length) {
      for (const h of held) toast(h.text, h.tone);
      held = [];
    }
    if (settle) shownAt = opts.now();
  }

  function apply(events: GameEvent[]) {
    const fresh = new Set(events.flatMap((e) => (e.type === "wordStateChanged" && e.from === "unseen" ? [e.word] : [])));
    const now = opts.now();
    // Counted before this batch's own new words: a line that brings the tenth word still comes with its meaning.
    onboard = onboarding(course, heardCount(core.state.words, now) - events.filter((e) => e.type === "wordStateChanged" && e.from === "unseen").length);
    const freshIn = (l: RenderedLine) => {
      if (!freshMarks(course)) return [];
      const out = [...new Set(l.tokens.map((tk) => tk.word).filter((w) => !glossed.has(w) && (fresh.has(w) || wordState(core.state.words[w], now) === "unseen")))];
      for (const w of out) glossed.add(w);
      return out;
    };
    // One hint however many notes became ready at once, and none while older ones still wait unheard.
    let hinted = core.state.notes.ready.length > events.filter((e) => e.type === "noteReady").length;
    /** places revealed by these events: one piece of news for all of them */
    const revealed: string[] = [];
    /** reactions that restate the request; only kept when the replies come back after them */
    const reacted: Beat[] = [];
    let choiceFrom: number | undefined;
    // With the Book the night's food is said with the day's end (and only when it cost something).
    const food = events.reduce((sum, e) => sum + (e.type === "walletChanged" && e.reason === "food" ? e.delta : 0), 0);
    for (const e of events) {
      switch (e.type) {
        case "sceneStarted":
          scene = e.scene;
          reply = undefined;
          sceneFrom = nextId;
          {
            const start = `scene-${e.scene}-start`;
            if (!resuming && !(experiment && e.scene === profile?.arrival?.scene) && t.has(start)) push({ text: t(start), tone: "narr" });
          }
          if (experiment && !resuming && e.scene === profile?.arrival?.scene) {
            const arrival = openingArrival(course, choices)!;
            push({ text: t(choices.cardRead && arrival.decodedText ? arrival.decodedText : arrival.text), tone: "narr" }, speech(arrival.audio));
          }
          // An opening choice that a later scene remembers: said as that scene opens, before anyone speaks.
          if (experiment && !resuming) for (const [key, option] of Object.entries(choices.options)) {
            const effect = effects[key]?.[option];
            if (effect?.consequence && effect.at === e.scene) push({ text: t(effect.consequence), tone: "narr" });
          }
          break;
        case "lineSpoken":
          if (!resuming && profile && scene) {
            const ex = course.scenes.find((s) => s.id === scene)?.exchanges.find((ex) => Object.values(ex.variants).some((v) => v.npc.text === e.line.text));
            const direction = ex && profile.directions[`${scene}:${ex.id}`];
            if (direction) push({ text: t(direction), tone: "narr" });
          }
          lastLine = e.line;
          lastSpeech = speech(e.line.audio);
          push({ speaker: e.npc, line: e.line, fresh: freshIn(e.line) }, lastSpeech);
          break;
        case "lineRephrased": {
          lastLine = e.line;
          lastSpeech = speech(e.line.audio, e.slow);
          // Merged into the reaction just said: one NPC line, never the request twice.
          const r = reacted.at(-1);
          if (r && r.speaker === e.npc && queue.includes(r)) {
            r.restate = { line: e.line, fresh: e.slow ? [] : freshIn(e.line), rephrase: e.slow ? "slower" : "rephrase" };
            if (lastSpeech) speeches.push(lastSpeech);
          } else push({ speaker: e.npc, line: e.line, fresh: freshIn(e.line), rephrase: true, ...(e.slow ? { slow: true } : {}) }, lastSpeech);
          break;
        }
        case "replyOptions":
          reply = e.mode === "pick" ? { mode: "pick", options: e.options } : e.mode === "tiles" ? { mode: "tiles", tiles: e.tiles } : { mode: "type" };
          placed = [];
          break;
        case "actionPerformed": {
          if (pendingChoice) {
            const { key, option } = pendingChoice;
            const effect = effects[key][option]!;
            choiceFrom = nextId;
            push({ text: t(effect.reaction), tone: "narr", openingReaction: true });
            const heard = speech(effect.audio);
            if (heard) speeches.push(heard);
            break;
          }
          const said = actionNarration(course, t, e, scene && npcName(course.scenes.find((s) => s.id === scene)?.npc ?? ""));
          // A miss is one narration line: what the player did and what was asked, together.
          if (!e.matched && said.length) push({ text: said.map((n) => n.text).join(" "), tone: "react" });
          else for (const n of said) push({ text: n.text, tone: n.tone === "warn" ? "react" : "narr" });
          break;
        }
        case "npcReacted": {
          // The reaction carries the request said again, so the next reply answers it, not the reaction.
          // Only its own clip plays; word help keeps offering the request the player got wrong.
          const r = push({ speaker: e.npc, line: e.line, fresh: freshIn(e.line), tone: "react" }, speech(course.reactionAudio?.[e.reaction]?.[e.npc] ?? e.line.audio));
          if (lastLine) {
            r.restate = { line: lastLine };
            reacted.push(r);
          }
          break;
        }
        case "walletChanged": {
          // Food is expected every night (with the Book it rides on the day's end, see dayEnded) and wages ride
          // on the finished scene's line: neither is news of its own.
          if (e.reason === "food" || e.reason === "wages") break;
          const reason = e.reason === "mixup" || e.reason === "shopping" ? e.reason : undefined;
          const echo = e.delta < 0 && reason ? [...queue].reverse().find((b) => b.speaker === "player") : undefined;
          if (echo && reason) echo.cost = { amount: (echo.cost?.amount ?? 0) + e.delta, reason: echo.cost?.reason === "mixup" ? "mixup" : reason };
          else push({ text: money(e.delta, e.reason), tone: e.delta < 0 ? "warn" : "good" });
          break;
        }
        case "sceneEnded":
          finishLookup();
          scene = undefined;
          reply = undefined;
          lastLine = undefined;
          lastSpeech = undefined;
          {
            const title = t(`scene-${e.scene}`);
            const who = npcName(course.scenes.find((s) => s.id === e.scene)?.npc ?? "");
            // "Meet Old Wang" already says who. The line carries the wages too.
            const what = title.includes(who) ? title : t("quiet-scene-with", { scene: title, npc: who });
            finished = { from: sceneFrom, to: choiceFrom ?? nextId, text: t("quiet-scene-done", { scene: what, currency: course.world.currency, earned: e.earned }) };
          }
          {
            const end = `scene-${e.scene}-end`;
            if (t.has(end)) push({ text: t(end), tone: "narr" });
          }
          closing = { from: finished.to, to: nextId };
          break;
        // With the Book the story's own lines say where to go next and the one bright control goes there:
        // news of a scene or place would name what the player hasn't met yet.
        case "unlocked":
          if (!book) news(t("unlocked", { scene: t(`scene-${e.scene}`) }), "good");
          break;
        case "placeRevealed":
          if (!book) revealed.push(placeLabel(e.place));
          break;
        case "errandStarted":
          news(t("errand-started"), "info");
          break;
        case "errandEnded":
          news(t("errand-ended"), "info");
          break;
        case "rankChanged":
          news(t("rank-up", { rank: t(`rank-${e.rank}`) }), "good");
          break;
        case "dayEnded":
          // core.state already holds the new day when events are applied
          if (book && food < 0) {
            const vars = { day: e.day, currency: course.world.currency, amount: -food };
            push({ text: t(e.rough ? "day-ended-rough-food" : "day-ended-food", vars), tone: "narr", day: core.state.day });
          } else push({ text: t(e.rough ? "day-ended-rough" : "day-ended", { day: e.day }), tone: "narr", day: core.state.day });
          break;
        case "inputRejected":
          toast(t(`reject-${e.reason}`), "bad");
          break;
        case "noteReady":
          if (course.world.mentor && !hinted && !book) news(t("note-hint", { npc: npcName(course.world.mentor.npc) }), "info");
          hinted = true;
          break;
        case "mentorVisited":
          if (!e.notes.length) push({ speaker: e.npc, text: t("mentor-nothing", { npc: npcName(e.npc) }) });
          for (const id of e.notes) push({ speaker: e.npc, title: t(`note-${id}-title`), text: t(`note-${id}`) });
          break;
        case "placeEntered":
          // With the Book, a place is described the first time the player stands in it (no scene there yet).
          if (book && t.has(`place-${e.place}-desc`) && !course.scenes.some((x) => x.place === e.place && core.state.scenesDone[x.id])) {
            push({ text: t(`place-${e.place}-desc`), tone: "narr" });
          }
          break;
        case "trustChanged":
        case "wordStateChanged":
        case "playerNamed":
        case "soundSet":
          break;
      }
    }
    if (revealed.length) news(t("place-revealed", { count: revealed.length, places: revealed.join(", ") }), "good");
    // No replies after the reaction (the scene ended): nothing to answer, so the request isn't said again.
    if (!events.some((e) => e.type === "replyOptions")) for (const r of reacted) if (!r.restate?.rephrase) delete r.restate;
    // With the Book the request comes back on the stage as said again, slower: so it is, after the reaction.
    if (book) for (const r of reacted) if (r.restate && !r.restate.rephrase) {
      const s = speech(r.restate.line.audio, true);
      if (s) speeches.push(s);
    }
    // Onboarding: the reaction's own row already says what was asked (its meaning is open under it), so the
    // narration of the same request just before it would say it twice.
    if (onboard) queue = queue.filter((b, i) => !(b.tone === "react" && !b.speaker && (queue[i + 1]?.restate || queue[i + 1]?.rephrase)));
  }

  /** Whether an option's intent is shown under it: only while the options' intents differ (one shared by
   * several tells nothing) or it is the only option, and the option holds a word not known yet. Once its
   * words are known the intent would only translate it, so it goes. */
  function intentShown(options: RenderedLine[], o: RenderedLine): boolean {
    if (!o.intent || (options.length > 1 && options.every((x) => x.intent === options[0].intent))) return false;
    const at = opts.now();
    return o.tokens.some((tk) => wordState(core.state.words[tk.word], at) !== "known");
  }

  function persist() {
    if (save && !save(core.state)) {
      save = undefined; // stop trying; say so once
      toast(t("notice-read-only"), "bad");
    }
  }

  /** Sends an input; the player's own line (echo) is shown first, and only if the input was taken. */
  function send(input: Input, echo?: Omit<Beat, "id">, echoSpeech?: Speech, settle = true): boolean {
    const round = experiment && openingRound(course, core.state);
    const typed = input.type === "replyText" ? input.text : undefined;
    const typedSlips = round && typed ? openingSlips(course, core.state)?.filter((line) => typedMatches(course, line, core.state.player ?? "?", normalizeTyped(typed))) : undefined;
    if (!echo?.line && typedSlips && typedSlips.length > 1) {
      inputTies = typedSlips;
      push({ text: t("quiet-scribe-choose"), tone: "narr" });
      flush(false);
      changed();
      return false;
    }
    const selectedLine = echo?.line ?? typedSlips?.[0];
    const choosing = round && (input.type === "confused" || !!selectedLine);
    const selection = choosing ? { key: round.key, option: openingOption(course, core.state, selectedLine) } : undefined;
    if (selection) input = openingInput(course, core.state, selection.option);
    const events = core.send(input);
    const taken = !events.some((e) => e.type === "inputRejected");
    if (taken) moveOn();
    if (echo && taken) push(echo, echoSpeech);
    if (selection && taken) {
      inputTies = undefined;
      choices = { ...choices, options: { ...choices.options, [selection.key]: selection.option } };
      saveChoices();
      pendingChoice = selection;
    }
    apply(events);
    pendingChoice = undefined;
    if (taken) persist();
    flush(settle);
    changed();
    return taken;
  }

  function phase(): Phase {
    if (naming) return { kind: "name" };
    const slips = experiment && (inputTies ?? openingSlips(course, core.state));
    if (slips) return { kind: "pick", options: slips, confused: true };
    if (reply?.mode === "pick") return { kind: "pick", options: reply.options, confused: !!core.state.run && core.state.run.misses < 2 };
    if (reply?.mode === "tiles") return { kind: "tiles", tiles: reply.tiles, placed, answer: joinTilesForDisplay(course, placed.map((i) => (reply as { tiles: string[] }).tiles[i])) };
    if (reply?.mode === "type") return { kind: "type", prompt: typePrompt(t), confused: !!core.state.run && core.state.run.misses < 2 };
    const menu = placeMenu(course, core.state, t, placeLabel).map((m) =>
      experiment && m.kind === "talk" && m.scene === profile?.arrival?.scene ? { ...m, label: t(openingArrival(course, choices)!.menu) } : m);
    if (!book) return { kind: "explore", menu, waiting: [...waitingForMoney(course, core.state, t), ...bedHint(course, core.state, t)] };
    // With the Book: what can't be done now is not offered, and the way to bed says why it's the way.
    const open = menu.filter((m) => !("disabled" in m && m.disabled));
    const primary = primaryItem(course, core.state, open) ?? (open.length === 1 ? 0 : undefined);
    const bed = primary !== undefined && open[primary].kind === "go" && isBedtime(course, core.state);
    // Nothing bright: every control is a "do", the likeliest first (and the number keys follow that order).
    const shown =
      primary === undefined ? likelyOrder(course, core.state, open)
      : bed ? open.map((m, i) => (i === primary ? { ...m, label: t("menu-go-sleep", { place: placeLabel(bedPlace(course, core.state)) }) } : m))
      : open;
    return { kind: "explore", menu: shown, waiting: waitingForMoney(course, core.state, t), primary };
  }

  if (opts.notice) toast(t(opts.notice), "bad");
  const intro = introLines(course, core.state, t);
  // A course with the Book opens on the crawl and the name screen: the story is read there, not repeated here.
  const opening = book && naming && intro.length ? intro : undefined;
  // What was shown on a screen of its own before the transcript (the crawl, the desk, the knock) is never
  // said again in it: with the Book the story is the crawl's, even in a game picked up later.
  const told = book ? [] : intro;
  for (const text of told) push({ text, tone: "narr" });
  resuming = true;
  apply(describeRun(course, core.state)); // a save made mid-scene resumes in the scene: its line, then its replies
  resuming = false;
  // A game picked up between scenes: say where the player is, so the screen is never blank.
  if (!told.length && !opening && !scene && !atDesk) push({ text: t("quiet-resume", { place: placeLabel() }), tone: "narr" });
  if (!scene) preludeTo = nextId;
  flush(true);

  /** The first NPC line of the scene being played: where the look-up hint goes. */
  function hintAt(): { lookupHint?: number } {
    const first = backlog.find((b) => b.id >= sceneFrom && b.line && b.speaker && b.speaker !== "player");
    return first ? { lookupHint: first.id } : {};
  }

  return {
    t,
    course,
    core,
    view: () => ({
      scene, phase: phase(), lastLine, backlog, toasts,
      onboard: onboarding(course, heardCount(core.state.words, opts.now())),
      ...(book && !lookupDone && scene ? hintAt() : {}),
      ...(book && scene ? { stageFrom: sceneFrom } : {}),
      ...(opening && naming ? { opening } : {}),
      ...(atDesk && !naming ? { desk: deskPapers(course) } : {}),
    }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    choose(n) {
      if (!settled()) return;
      const p = phase();
      if (p.kind === "explore") {
        const item = p.menu[n];
        if (item) send(item.input);
      } else if (p.kind === "pick") {
        const o = p.options[n];
        if (o) send({ type: "reply", choice: n }, { speaker: "player", line: o }, speech(o.audio));
        else if (n === p.options.length && p.confused) send({ type: "confused" }, { speaker: "player", text: CONFUSED });
      }
    },
    placeTile(i) {
      if (reply?.mode !== "tiles" || i < 0 || i >= reply.tiles.length || placed.includes(i)) return;
      placed = [...placed, i];
      changed();
    },
    undoTile() {
      if (reply?.mode !== "tiles" || !placed.length) return;
      placed = placed.slice(0, -1);
      changed();
    },
    sendTiles() {
      if (reply?.mode !== "tiles" || !placed.length) return;
      const said = tileEcho(course, core.state, reply.tiles, placed);
      send({ type: "replyTiles", tiles: placed }, { speaker: "player", line: said.line }, said.right ? speech(said.clips) : undefined);
    },
    sendText(text) {
      if (reply?.mode !== "type" || !text.trim()) return;
      if (!normalizeTyped(text)) {
        if ((core.state.run?.misses ?? 2) < 2) send({ type: "confused" }, { speaker: "player", text: CONFUSED });
        return;
      }
      send({ type: "replyText", text }, { speaker: "player", text: text.trim() });
    },
    lookUp(word, surface) {
      finishLookup();
      const card = wordCard(course, word, surface);
      const s = speech(card.clips);
      if (s) say([s]);
      send({ type: "helpWord", word }, undefined, undefined, false); // the replies on screen stay as they are
      return card;
    },
    sentence(line) {
      // Reading the whole line is not logged as help: the words still have to be recognised.
      const l = line ?? lastLine;
      const card = l ? sentenceCard(course, l) : undefined;
      const s = speech(card?.clips);
      if (s) say([s]);
      return card;
    },
    replay(slow = false) {
      if (lastSpeech) say([slow || lastSpeech.slow ? { ...lastSpeech, slow: true } : lastSpeech]);
    },
    play(clips) {
      const s = speech(clips);
      if (s) say([s]);
    },
    intentShown,
    setName(name) {
      if (!naming) return true;
      const events = core.send({ type: "setName", name });
      if (events.some((e) => e.type === "inputRejected")) {
        toast(t("reject-bad-name"), "bad");
        changed();
        return false;
      }
      persist();
      naming = false;
      if (atDesk) {
        opts.papers?.save([...read]);
        opts.papers?.saveProgress?.(progress);
      }
      // After the crawl the transcript opens on where the player is, not on the story just read; with the desk
      // up, once the desk is left.
      if (opening && !scene && !atDesk) {
        push({ text: t("quiet-resume", { place: placeLabel() }), tone: "narr" });
        preludeTo = nextId;
        flush(true);
      }
      changed();
      return true;
    },
    readPapers: () => read,
    openingChoices: () => experiment ? parseOpeningChoices(choices, course) : undefined,
    bookPapers,
    deskAt(id) {
      const p = bookPapers().find((x) => x.id === id);
      const all = p ? paperSyllables(p).length : 0;
      return read.has(id) ? all : Math.min(id === reward?.paper && experiment ? choices.cardAt : progress.at[id] ?? 0, all);
    },
    setDeskAt(id, n) {
      if (id === reward?.paper) {
        if (!experiment || !bookPapers().some((p) => p.id === id)) return;
        if (choices.cardAt === n) return;
        choices = { ...choices, cardAt: n };
        saveChoices();
        return;
      }
      if (progress.at[id] === n) return;
      progress = { ...progress, at: { ...progress.at, [id]: n } };
      saveProgress();
    },
    deskMet: () => (lettersFollowDesk(course) ? metLetters(course, progress, read) : undefined),
    meet(keys) {
      const fresh = keys.filter((k) => !progress.met.includes(k));
      if (!fresh.length) return;
      progress = { ...progress, met: [...progress.met, ...fresh] };
      saveProgress();
      changed();
    },
    readPaperLine(paper, line) {
      if (!bookPapers().find((p) => p.id === paper)?.lines.some((l) => l.id === line)) return;
      read.add(`${paper}.${line}`);
      opts.papers?.save([...read]);
      changed();
    },
    readPaper(id) {
      if (read.has(id) || !bookPapers().some((p) => p.id === id)) return;
      if (experiment && id === reward?.paper) {
        choices = { ...choices, cardRead: true, cardAt: paperSyllables(bookPapers().find((p) => p.id === id)!).length };
        saveChoices();
        if (reward && core.state.place === reward.place) {
          push({ text: t(reward.decoded), tone: "narr" });
          flush(false);
        }
      }
      read.add(id);
      opts.papers?.save([...read]);
      changed();
    },
    leaveDesk() {
      if (!atDesk || naming || !deskReady(deskPapers(course), read)) return;
      atDesk = false;
      if (!scene) {
        // The knock screen said someone is at the door: the transcript opens on the scene it starts, not on a
        // menu that offers the door among other things.
        const door = placeMenu(course, core.state, t).find((m) => m.kind === "talk" && !m.disabled);
        preludeTo = nextId;
        if (door) send(door.input);
        else {
          // desk-done was the knock screen's own line.
          push({ text: t("quiet-resume", { place: placeLabel() }), tone: "narr" });
          preludeTo = nextId;
          flush(true);
        }
      }
      changed();
    },
    placeLabel,
    toggleSound() {
      if (!opts.audio?.available) return;
      const on = core.state.sound === false;
      if (!on) opts.audio.stop();
      send({ type: "setSound", on }, undefined, undefined, false);
    },
    dismissToast(id) {
      toasts = toasts.filter((x) => x.id !== id);
      changed();
    },
  };
}
