// The game controller: the only place the 3D front end talks to @silver-tongue/core. DOM-free and
// three-free, so it runs under vitest. It turns world actions (walked into a zone, tapped an NPC,
// picked a reply) into core inputs, and every GameEvent into a UiModel the DOM overlay and the
// 3D world render. Mirrors packages/tui/src/app.ts: same scene start sequence, same pick-mode
// replies, same word help logging, same narration ids.
import {
  availableSceneIds,
  comboKey,
  createCore,
  describeRun,
  mentorAvailable,
  moneyBlocked,
  mulberry32,
  personalize,
  PLAYER_MARK,
  rankFor,
  sceneCost,
  tilePieces,
  type Core,
  type Course,
  type GameEvent,
  type GameState,
  type Input,
  type RenderedLine,
  type WalletReason,
  type WordId,
} from "@silver-tongue/core";
import { makeText, notebookLines, type AudioOut, type Speech, type StyledLine, type Text } from "@silver-tongue/tui";
import { WebSessions, type KeyValue, type Opened } from "@silver-tongue/tui-web/src/web-storage";
import { route } from "./layout";
import { objective, type Objective } from "./objective";
import { display, makeStrings, type Strings } from "./strings";

export type Tone = "info" | "good" | "bad" | "note" | "place" | "you" | "story";

export interface FeedItem {
  seq: number;
  /** the event that produced it, or a front-end kind */
  kind: GameEvent["type"] | "intro" | "notice" | "you" | "info";
  text: string;
  tone: Tone;
}

export interface Bubble {
  seq: number;
  npc: string;
  npcName: string;
  line: RenderedLine;
  kind: "line" | "reaction" | "rephrase";
  /** a replayed line: show it slowly, with pronunciation */
  slow: boolean;
  /** words heard for the first time in this line (faint underline) */
  fresh: WordId[];
  /** the clips that say it: the line's, or for a reaction this NPC's voice (course.reactionAudio) */
  audio: string[];
}

/** `cost`: what the right reply spends (buying something, as the TUI's shop), shown with the replies. */
export type ReplyPanel =
  | { mode: "pick"; options: RenderedLine[]; cost?: number }
  /** tiles (typed replies play as tiles in core): tap them in order, then say it */
  | { mode: "tiles"; tiles: string[]; cost?: number };

/** A wallet change floating from the wallet chip: "+¥14 delivery", "−¥4 shopping". */
export interface WalletFx {
  seq: number;
  delta: number;
  reason: WalletReason;
  /** a word under the amount (shopping; the wages of a delivery) */
  label?: string;
}

/** The end-of-day summary card, from dayEnded and the walletChanged events of the day. */
export interface DayCard {
  seq: number;
  /** the day that ended */
  day: number;
  food: number;
  rent: number;
  /** rent was due and couldn't be paid */
  rentLate: boolean;
  earned: number;
  mixups: number;
  wallet: number;
  /** wallet now minus wallet when the day started (this session) */
  change: number;
}

export interface Choice {
  label: string;
  input?: Input;
}

export interface Hud {
  day: number;
  slot: number;
  slots: number;
  slotsLeft: number;
  wallet: number;
  currency: string;
  rank: number;
  rankName: string;
  rentLate: boolean;
  place: string;
  placeName: string;
  /** the parcel being carried (core state.errand): where it goes. The status line's parcel marker. */
  errand: { to: string; placeName: string } | null;
  /** the TUI's bottom-right ♪: sound on, turned off (state.sound false), or no audio here */
  sound: "on" | "off" | "none";
}

export interface UiModel {
  mode: "name" | "explore" | "scene";
  hud: Hud;
  /** the scene in progress; the world locks movement and frames player + NPC while set */
  scene: { id: string; npc: string } | null;
  bubble: Bubble | null;
  reply: ReplyPanel | null;
  /** talking to someone with several things to talk about: pick one */
  choices: { title: string; items: Choice[] } | null;
  /** narration, results and rejections, newest last (the UI shows new ones as toasts) */
  feed: FeedItem[];
  /** the mentor has notes waiting and is here */
  mentor: Choice | null;
  canSleep: boolean;
  sleepLabel: string;
  /** bumped on dayEnded, for the day transition */
  dayChanges: number;
  /** the HUD's "what now" line */
  objective: Objective;
  /** the latest end-of-day summary (the overlay shows each new seq once) */
  dayCard: DayCard | null;
  /** recent wallet changes, for the floating "+¥5" (newest last, bounded) */
  walletFx: WalletFx[];
  /** bumped when a word goes into the notebook or becomes known: the notebook button pulses */
  notebookPulse: number;
  /** bumped on every mix-up (a reply that did the wrong thing): the NPC shrugs */
  mixups: { seq: number; npc: string } | null;
  /** every event dispatched, newest last (bounded), for tests and debugging */
  events: GameEvent[];
}

export interface Gloss {
  text: string;
  pron?: string;
  gloss: string;
  /** the clips that say it (the popover's play button), and whether slowly */
  audio: string[];
  slow?: boolean;
}

export interface GameOptions {
  course: Course;
  core: Core;
  now: () => number;
  /** saves after each accepted input; false if it couldn't. Leave out to play without saving. */
  save?: (state: GameState) => boolean;
  notice?: string;
  /** called after every change of the model */
  onChange?: (model: UiModel) => void;
  /** called for every event, after the model took it in (world effects: props, gestures) */
  onEvent?: (e: GameEvent) => void;
  /** sound out (src/audio.ts); without it the game is silent and the HUD says "no audio" */
  audio?: AudioOut;
}

export interface Game {
  readonly model: UiModel;
  readonly core: Core;
  readonly t: Text;
  readonly s: Strings;
  /** the one event dispatcher: every GameEvent goes through here */
  dispatch(events: GameEvent[]): void;
  /**
   * The player walked into `place`'s zone or door (goTo, hop by hop through the world graph).
   * Idempotent (already there: nothing) and not re-entrant (a call from inside a change handler
   * while hops are being sent is dropped).
   */
  enterPlace(place: string): void;
  /** the travel list: every other place (the TUI's "Go to" items, routed) */
  travel(): void;
  /** tapped / pressed E at an NPC: start their scene, or list them if there are several */
  talkTo(npc: string): void;
  choose(index: number): void;
  closeChoices(): void;
  reply(index: number): void;
  /** tiles mode: the tiles tapped, in order */
  replyTiles(tiles: number[]): void;
  /** tiles mode escape hatch: an empty tile reply (a miss); two misses fall back to picking */
  giveUpTiles(): void;
  /** looks a word up (logged as help) and says it */
  helpWord(word: WordId): Gloss | undefined;
  /** the whole line's meaning, and says the line (the TUI's [s]) */
  sentence(line: RenderedLine): Gloss | undefined;
  /** says the bubble again, slowly if it was a slow repeat (the TUI's [r]) */
  replay(): void;
  /** says these clips (a reply option's or a gloss's play button; the TUI's [p]) */
  say(clips: string[] | undefined, slow?: boolean): void;
  /** sound on or off (the TUI's [m]); nothing when there is no audio here */
  setSound(on: boolean): void;
  sleep(): void;
  visitMentor(): void;
  setName(name: string): boolean;
  notebook(): StyledLine[];
  npcName(npc: string): string;
}

/**
 * Parity with the TUI: every core Input and the 3D affordance that sends it. Typed as a Record
 * over Input["type"], so a new Input in core fails the typecheck until it has an affordance here;
 * test/parity.test.ts also checks this list against the Input union in core's source and plays
 * each one through the Game API.
 */
export const INPUT_AFFORDANCES: Record<Input["type"], { tui: string; world3d: string; api: keyof Game }> = {
  goTo: { tui: "menu: Go to <place>", world3d: "walk into a zone, a door or an interior's open front; the Go to… list", api: "enterPlace" },
  startScene: { tui: "menu: Talk to <npc>: <scene>", world3d: "tap an NPC or E next to them (a list when there are several)", api: "talkTo" },
  reply: { tui: "number keys in a scene", world3d: "tap a reply (or 1-4)", api: "reply" },
  replyTiles: { tui: "tile numbers, backspace, enter", world3d: "tap tiles in order, Undo, Say it (or Give up: an empty reply)", api: "replyTiles" },
  helpWord: { tui: "[w] word help, number", world3d: "tap a word in the bubble, or ? then a word in a reply", api: "helpWord" },
  visitMentor: { tui: "menu: Ask <mentor> about the language", world3d: "mentor button, or talk to the mentor", api: "visitMentor" },
  setName: { tui: "name prompt", world3d: "name dialog", api: "setName" },
  sleep: { tui: "menu: Sleep", world3d: "the bed at home (prompt / tap), or the Sleep button at home", api: "sleep" },
  setSound: { tui: "[m] sound on / off", world3d: "the ♪ chip in the HUD, or Menu → Sound", api: "setSound" },
};

const EVENT_LOG = 200;
const FEED_LOG = 60;

export function createGame(opts: GameOptions): Game {
  const { course, core } = opts;
  const t = display(makeText(course.learnerFtl));
  const s = makeStrings(t);
  const wordIds = Object.keys(course.words);
  const npcName = (npc: string) => t(`npc-${npc}`);
  let seq = 0;
  let resuming = false;
  let save = opts.save;
  let entering = false;
  // Day summary bookkeeping (this session): wallet at the start of the day, wages and mix-ups since.
  let dayStartWallet = core.state.wallet;
  let today = { earned: 0, mixups: 0 };
  // Sound, as app.ts: each call queues what people say, in order; one flush plays it.
  let queue: Speech[] = [];
  let tileReply: string[] = []; // the right reply's clips, said if the tiles match
  const soundOn = () => !!opts.audio?.available && core.state.sound !== false;
  const hear = (clips: string[] | undefined, slow = false) => {
    if (clips?.length) queue.push(slow ? { clips, slow } : { clips });
  };
  /** Says everything queued, unless sound is off. */
  const flush = () => {
    if (queue.length && soundOn()) opts.audio!.play(queue);
    queue = [];
  };

  const model: UiModel = {
    mode: "explore",
    hud: hud(),
    scene: null,
    bubble: null,
    reply: null,
    choices: null,
    feed: [],
    mentor: null,
    canSleep: false,
    sleepLabel: t("menu-sleep"),
    dayChanges: 0,
    objective: { text: "" },
    dayCard: null,
    walletFx: [],
    notebookPulse: 0,
    mixups: null,
    events: [],
  };

  function hud(): Hud {
    const st = core.state;
    const rank = rankFor(st.words, wordIds, opts.now());
    return {
      day: st.day,
      slot: st.slot,
      slots: course.world.slotsPerDay,
      slotsLeft: Math.max(0, course.world.slotsPerDay - st.slot),
      wallet: st.wallet,
      currency: course.world.currency,
      rank,
      rankName: t(`rank-${rank}`),
      rentLate: st.rentLate,
      place: st.place,
      placeName: t(`place-${st.place}`),
      errand: st.errand ? { to: st.errand.to, placeName: t(`place-${st.errand.to}`) } : null,
      sound: !opts.audio?.available ? "none" : st.sound === false ? "off" : "on",
    };
  }

  /** What the right reply to the exchange in progress spends (a variant's cost), if anything. */
  function replyCost(): number | undefined {
    const run = core.state.run;
    if (!run) return undefined;
    const ex = course.scenes.find((x) => x.id === run.scene)?.exchanges[run.exchange];
    const cost = ex?.variants[comboKey(run.combo)]?.cost ?? 0;
    return cost > 0 ? cost : undefined;
  }

  const feed = (kind: FeedItem["kind"], text: string, tone: Tone) => {
    model.feed = [...model.feed, { seq: ++seq, kind, text, tone }].slice(-FEED_LOG);
  };
  /** Optional narration: shown when the learner text has it. */
  const narrate = (kind: FeedItem["kind"], id: string, args?: Record<string, string | number>) => {
    if (t.has(id)) feed(kind, t(id, args), "story");
  };
  const actionArgs = (a: Record<string, string>) =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, course.conceptNames[v] ?? v]));

  /** Things derived from state alone, refreshed after every change. */
  function refresh() {
    const st = core.state;
    model.hud = hud();
    const inScene = !!st.run;
    model.mentor =
      !inScene && mentorAvailable(course, st) && st.notes.ready.length
        ? { label: t("menu-mentor", { npc: npcName(course.world.mentor!.npc) }) + t("cost-slot"), input: { type: "visitMentor" } }
        : null;
    model.canSleep = !inScene && (!course.world.home || st.place === course.world.home);
    if (!inScene && model.mode === "scene") model.mode = "explore";
    model.objective = objective(course, st, t, s, course.needsName);
    opts.onChange?.(model);
  }

  function dispatch(events: GameEvent[]) {
    model.events = [...model.events, ...events].slice(-EVENT_LOG);
    const lastPlace = [...events].reverse().find((e) => e.type === "placeEntered");
    let hinted = false;
    let delivered = false;
    let ended: { day: number; food: number; rent: number } | null = null;
    // Words first heard in this batch, as app.ts marks them.
    const fresh = new Set(events.flatMap((e) => (e.type === "wordStateChanged" && e.from === "unseen" ? [e.word] : [])));
    const freshIn = (line: RenderedLine) => line.tokens.map((tk) => tk.word).filter((w) => fresh.has(w));
    for (const e of events) {
      switch (e.type) {
        case "placeEntered":
          // Walking through several places at once (a route): name only where the player ends up.
          if (e === lastPlace) feed(e.type, t(`place-${e.place}`), "place");
          break;
        case "sceneStarted":
          model.mode = "scene";
          model.scene = { id: e.scene, npc: e.npc };
          model.choices = null;
          if (!resuming) narrate(e.type, `scene-${e.scene}-start`);
          break;
        case "lineSpoken":
          model.bubble = { seq: ++seq, npc: e.npc, npcName: npcName(e.npc), line: e.line, kind: "line", slow: false, fresh: freshIn(e.line), audio: e.line.audio ?? [] };
          hear(e.line.audio);
          break;
        case "replyOptions": {
          const cost = replyCost();
          model.reply = e.mode === "pick" ? { mode: "pick", options: e.options, cost } : { mode: "tiles", tiles: e.tiles, cost };
          break;
        }
        case "actionPerformed":
          // Tiles that make the right reply: the player's voice says it (a picked reply was queued by reply()).
          if (model.reply?.mode === "tiles" && !e.tilesWrong) hear(tileReply);
          if (!e.tilesWrong && t.has(`action-${e.action.action}`)) feed(e.type, t(`action-${e.action.action}`, actionArgs(e.action)), "story");
          if (!e.matched) {
            if (model.scene) model.mixups = { seq: ++seq, npc: model.scene.npc };
            if (t.has(`asked-${e.expected.action}`)) feed(e.type, t(`asked-${e.expected.action}`, actionArgs(e.expected)), "bad");
            else feed(e.type, t("mismatch"), "bad");
          }
          break;
        case "npcReacted": {
          // Each NPC says a reaction in their own voice.
          const audio = course.reactionAudio?.[e.reaction]?.[e.npc] ?? [];
          model.bubble = { seq: ++seq, npc: e.npc, npcName: npcName(e.npc), line: e.line, kind: "reaction", slow: false, fresh: freshIn(e.line), audio };
          hear(audio);
          break;
        }
        case "lineRephrased":
          model.bubble = {
            seq: ++seq,
            npc: e.npc,
            npcName: `${npcName(e.npc)} ${t("rephrased")}`,
            line: e.line,
            kind: "rephrase",
            slow: e.slow,
            fresh: freshIn(e.line),
            audio: e.line.audio ?? [],
          };
          hear(e.line.audio, e.slow);
          break;
        case "walletChanged":
          feed(
            e.type,
            t("wallet-change", {
              sign: e.delta > 0 ? "+" : "-",
              amount: Math.abs(e.delta),
              currency: course.world.currency,
              reason: t(`reason-${e.reason}`),
            }),
            e.delta > 0 ? "good" : "bad",
          );
          {
            // Shopping says so under the amount; so do the wages of a delivery (they follow errandEnded).
            const label = e.reason === "shopping" ? t("reason-shopping") : e.reason === "wages" && delivered ? s("fx-delivery") : undefined;
            model.walletFx = [...model.walletFx, { seq: ++seq, delta: e.delta, reason: e.reason, ...(label ? { label } : {}) }].slice(-8);
          }
          if (e.reason === "wages") today.earned += e.delta;
          if (e.reason === "mixup") today.mixups += 1;
          if (ended && e.reason === "food") ended.food += -e.delta;
          if (ended && e.reason === "rent") ended.rent += -e.delta;
          break;
        case "trustChanged":
          feed(e.type, t("trust-up", { npc: npcName(e.npc), trust: e.trust }), "note");
          break;
        case "wordStateChanged":
          // The notebook reads word states from core.state; it pulses when a word goes in or is learned.
          if (!resuming && (e.from === "unseen" || e.to === "known")) model.notebookPulse += 1;
          break;
        case "sceneEnded":
          model.mode = "explore";
          model.scene = null;
          model.bubble = null;
          model.reply = null;
          narrate(e.type, `scene-${e.scene}-end`);
          feed(e.type, t("scene-done", { currency: course.world.currency, earned: e.earned }), "good");
          break;
        case "unlocked":
          feed(e.type, t("unlocked", { scene: t(`scene-${e.scene}`) }), "good");
          break;
        case "errandStarted":
          // The parcel: the player carries it (main.ts, from hud.errand), the HUD and the objective name where it goes.
          feed(e.type, t("errand-started"), "note");
          break;
        case "errandEnded":
          feed(e.type, t("errand-ended"), "note");
          delivered = true;
          break;
        case "rankChanged":
          feed(e.type, t("rank-up", { rank: t(`rank-${e.rank}`) }), "good");
          break;
        case "dayEnded":
          model.dayChanges += 1;
          feed(e.type, t("day-ended", { day: e.day }), "info");
          ended = { day: e.day, food: 0, rent: 0 };
          break;
        case "noteReady":
          // One hint however many notes became ready at once.
          if (course.world.mentor && !hinted) feed(e.type, t("note-hint", { npc: npcName(course.world.mentor.npc) }), "note");
          hinted = true;
          break;
        case "playerNamed":
          if (model.mode === "name") model.mode = core.state.run ? "scene" : "explore";
          break;
        case "mentorVisited":
          if (!e.notes.length) feed(e.type, t("mentor-nothing", { npc: npcName(e.npc) }), "info");
          for (const id of e.notes) feed(e.type, `${t(`note-${id}-title`)}\n${t(`note-${id}`)}`, "note");
          break;
        case "inputRejected":
          feed(e.type, t(`reject-${e.reason}`), "bad");
          break;
        case "soundSet":
          // The HUD's ♪ chip reads state.sound (refresh below); turning it off stops what is playing.
          if (!e.on) opts.audio?.stop();
          break;
        default: {
          // A new GameEvent in core must be handled here: this stops the build until it is.
          const never: never = e;
          throw new Error(`unhandled event ${(never as GameEvent).type}`);
        }
      }
      opts.onEvent?.(e);
    }
    if (ended) {
      const wallet = core.state.wallet;
      model.dayCard = {
        seq: ++seq,
        ...ended,
        rentLate: core.state.rentLate,
        earned: today.earned,
        mixups: today.mixups,
        wallet,
        change: wallet - dayStartWallet,
      };
      dayStartWallet = wallet;
      today = { earned: 0, mixups: 0 };
    }
    flush();
    refresh();
  }

  function persist() {
    if (save && !save(core.state)) {
      save = undefined; // stop trying; say so once
      feed("notice", t("notice-read-only"), "bad");
    }
  }

  /** Sends one input; returns its events (dispatched) and whether core accepted it. */
  function send(input: Input): { events: GameEvent[]; ok: boolean } {
    const events = core.send(input);
    const ok = !events.some((e) => e.type === "inputRejected");
    if (ok) persist();
    dispatch(events);
    return { events, ok };
  }

  function enterPlace(place: string) {
    if (entering || core.state.run || model.mode === "name" || place === core.state.place) return;
    entering = true;
    try {
      const hops = route(course.world, core.state.place, place);
      const all: GameEvent[] = [];
      for (const hop of hops) {
        const events = core.send({ type: "goTo", place: hop });
        all.push(...events);
        if (events.some((e) => e.type === "inputRejected")) break;
      }
      if (hops.length === 0) all.push({ type: "inputRejected", reason: "not-linked" });
      if (all.some((e) => e.type === "placeEntered")) persist();
      dispatch(all);
    } finally {
      entering = false;
    }
  }

  function travel() {
    if (core.state.run || model.mode === "name") return;
    const items: Choice[] = Object.keys(course.world.places)
      .filter((p) => p !== core.state.place && route(course.world, core.state.place, p).length)
      .map((p) => ({ label: t("menu-go", { place: t(`place-${p}`) }), input: { type: "goTo", place: p } }));
    model.choices = { title: s("travel-title"), items: [...items, { label: s("cancel") }] };
    refresh();
  }

  /**
   * app.ts's menu, narrowed to one NPC: the scenes available here with them, plus the mentor's
   * notes when they are the mentor. One item starts at once; several become a list.
   */
  function talkTo(npc: string) {
    const st = core.state;
    if (model.mode === "name") return;
    if (st.run) return dispatch([{ type: "inputRejected", reason: "in-scene" }]);
    if (course.world.npcs[npc]?.place !== st.place) return dispatch([{ type: "inputRejected", reason: "wrong-place" }]);
    const items: Choice[] = [];
    for (const id of availableSceneIds(course, st)) {
      const scene = course.scenes.find((x) => x.id === id)!;
      if (scene.place !== st.place || scene.npc !== npc) continue;
      items.push({ label: t(`scene-${id}`) + t("cost-slot"), input: { type: "startScene", scene: id } });
    }
    if (course.world.mentor?.npc === npc && model.mentor) items.push(model.mentor);
    if (!items.length) {
      // As app.ts's menu: a scene here that waits only for money says what it needs.
      const waiting = course.scenes.filter((x) => x.place === st.place && x.npc === npc && moneyBlocked(x, st));
      if (waiting.length) {
        for (const x of waiting)
          feed("info", t("menu-needs-money", { npc: npcName(npc), scene: t(`scene-${x.id}`), currency: course.world.currency, cost: sceneCost(x) }), "info");
      } else feed("info", s("nothing-to-say", { npc: npcName(npc) }), "info");
      return refresh();
    }
    if (items.length === 1) {
      send(items[0].input!);
      return;
    }
    model.choices = { title: s("talk-title", { npc: npcName(npc) }), items: [...items, { label: s("cancel") }] };
    refresh();
  }

  function choose(index: number) {
    const item = model.choices?.items[index];
    model.choices = null;
    // Travel goes hop by hop like walking there.
    if (item?.input?.type === "goTo") enterPlace(item.input.place);
    else if (item?.input) send(item.input);
    else refresh();
  }

  function reply(index: number) {
    const r = model.reply;
    if (r?.mode !== "pick" || !r.options[index]) return;
    feed("you", s("you-say", { text: r.options[index].text }), "you");
    hear(r.options[index].audio);
    send({ type: "reply", choice: index });
  }

  function replyTiles(tiles: number[]) {
    const r = model.reply;
    if (r?.mode !== "tiles" || !tiles.length) return;
    // As app.ts: tiles that make the right reply are shown as the reply itself, punctuation and all.
    const placed = tiles.map((i) => r.tiles[i] ?? "").join("");
    const right = rightReply();
    const name = core.state.player ?? "";
    const match = !!right && tilePieces(right).map((x) => (x === PLAYER_MARK ? name : x)).join("") === placed;
    feed("you", s("you-say", { text: match ? personalize(right!, name).text : placed }), "you");
    tileReply = right?.audio ?? [];
    send({ type: "replyTiles", tiles });
  }

  function giveUpTiles() {
    if (model.reply?.mode !== "tiles") return;
    tileReply = [];
    send({ type: "replyTiles", tiles: [] });
  }

  /** Looking a word up is logged as help on it, like the TUI's [w] word help. */
  function helpWord(word: WordId): Gloss | undefined {
    const w = course.words[word];
    if (!w) return undefined;
    hear(w.audio);
    send({ type: "helpWord", word });
    return { text: w.w, pron: w.pron, gloss: w.gloss, audio: w.audio ?? [] };
  }

  /** The whole line's meaning, said aloud. Not logged as help: the words still have to be recognised. */
  function sentence(line: RenderedLine): Gloss | undefined {
    if (!line.meaning) return undefined;
    const pron = line.tokens.flatMap((tk) => course.words[tk.word]?.pron ?? []).join(" ");
    // The bubble's line is said as the bubble says it (a reaction in the NPC's voice, a slow repeat slowly).
    const b = model.bubble?.line === line ? model.bubble : null;
    const audio = b ? b.audio : (line.audio ?? []);
    const slow = !!b?.slow;
    say(audio, slow);
    return { text: line.text, pron: pron || undefined, gloss: line.meaning, audio, ...(slow ? { slow } : {}) };
  }

  function say(clips: string[] | undefined, slow = false) {
    hear(clips, slow);
    flush();
  }

  function setSound(on: boolean) {
    if (!opts.audio?.available) return; // nothing to turn on or off here
    if (!on) opts.audio.stop();
    send({ type: "setSound", on });
  }

  /** The right reply for the exchange being played (its clips are said when the tiles match). */
  function rightReply(): RenderedLine | undefined {
    const run = core.state.run;
    const ex = run && course.scenes.find((x) => x.id === run.scene)?.exchanges[run.exchange];
    return run ? ex?.variants[comboKey(run.combo)]?.reply : undefined;
  }

  function setName(name: string): boolean {
    return send({ type: "setName", name }).ok;
  }

  // Start-up, as app.ts: notice, intro for a fresh game, then a save made mid-scene resumes in it.
  if (opts.notice) feed("notice", t(opts.notice), "bad");
  const st = core.state;
  const fresh =
    st.day === 1 && st.slot === 0 && !st.run && st.place === course.world.start && !Object.keys(st.scenesDone).length && !Object.keys(st.words).length;
  if (fresh) {
    const args = { currency: course.world.currency, wallet: st.wallet, rent: course.world.rentPerWeek };
    for (let i = 1; t.has(`intro-${i}`); i++) feed("intro", t(`intro-${i}`, args), "story");
  }
  feed("placeEntered", t(`place-${st.place}`), "place");
  resuming = true;
  dispatch(describeRun(course, st));
  resuming = false;
  if (course.needsName && !st.player) model.mode = "name";
  refresh();

  return {
    model,
    core,
    t,
    s,
    dispatch,
    enterPlace,
    travel,
    talkTo,
    choose,
    closeChoices: () => choose(-1),
    reply,
    replyTiles,
    giveUpTiles,
    helpWord,
    sentence,
    replay: () => say(model.bubble?.audio, model.bubble?.slow),
    say,
    setSound,
    sleep: () => void send({ type: "sleep" }),
    visitMentor: () => void send({ type: "visitMentor" }),
    setName,
    notebook: () => notebookLines(course, core.state, t, opts.now()),
    npcName,
  };
}

/**
 * Opens the last played game from storage, with the same keys as the browser TUI
 * (`silver-tongue:<course>:session:<id>` + `…:meta`, via tui-web's WebSessions), so a save
 * moves between the two front ends as is.
 */
export function openSession(
  course: Course,
  kv: KeyValue,
  opts: {
    now: () => number;
    fresh?: boolean;
    id?: string;
    onChange?: GameOptions["onChange"];
    onEvent?: GameOptions["onEvent"];
    audio?: GameOptions["audio"];
  },
): { game: Game; opened: Opened; sessions: WebSessions } {
  const sessions = new WebSessions(kv, course, opts.now);
  // A new game, a chosen one (the games list, an import), or the one played last.
  const opened = opts.fresh ? sessions.startNew() : opts.id ? sessions.open(opts.id) : sessions.continueLast();
  const core = createCore(course, opened.state, { now: opts.now, rng: mulberry32(opts.now() >>> 0) });
  const game = createGame({
    course,
    core,
    now: opts.now,
    notice: opened.notice,
    save: opened.readOnly ? undefined : (st) => sessions.save(opened.id, st),
    onChange: opts.onChange,
    onEvent: opts.onEvent,
    audio: opts.audio,
  });
  return { game, opened, sessions };
}
