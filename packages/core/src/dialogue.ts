import { comboKey, parseComboKey, resolveParams, type Combo } from "./combo";
import { addTrust, changeWallet, isAvailable, payFor } from "./life";
import {
  pickPreferred,
  recordRight,
  recordSeen,
  recordWrong,
  replyModeFor,
  wordState,
} from "./learner";
import { personalize } from "./player";
import { shuffle } from "./rng";
import { PLAYER_MARK } from "./types";
import type {
  Course,
  Exchange,
  GameEvent,
  GameState,
  RejectReason,
  RenderedLine,
  Scene,
  SceneRun,
  WordId,
  WordRecord,
} from "./types";

export interface Ctx {
  course: Course;
  state: GameState;
  now: number;
  rng: () => number;
  ev: GameEvent[];
}

export function reject(ctx: Ctx, reason: RejectReason): void {
  ctx.ev.push({ type: "inputRejected", reason });
}

export function setWord(
  ctx: Ctx,
  word: WordId,
  update: (rec: WordRecord | undefined, now: number) => WordRecord,
): void {
  const from = wordState(ctx.state.words[word], ctx.now);
  ctx.state.words[word] = update(ctx.state.words[word], ctx.now);
  const to = wordState(ctx.state.words[word], ctx.now);
  if (from !== to) ctx.ev.push({ type: "wordStateChanged", word, from, to });
}

/**
 * The words of a line in reading order, as tiles. The player's name is a tile too, kept as
 * PLAYER_MARK until it is shown. Punctuation is not a tile.
 */
export function tilePieces(line: RenderedLine): string[] {
  const words = line.tokens.map((t) => ({ at: t.start, text: line.text.slice(t.start, t.end) }));
  const names = [...line.text.matchAll(new RegExp(PLAYER_MARK, "g"))].map((m) => ({ at: m.index, text: PLAYER_MARK }));
  return [...words, ...names].sort((a, b) => a.at - b.at).map((p) => p.text);
}

/** Tiles as the player reads them: with spaces between them in a spaced language. */
export function joinTiles(course: Course, pieces: string[]): string {
  return pieces.join(course.language.spaced ? " " : "");
}

function sceneById(ctx: Ctx, id: string): Scene | undefined {
  return ctx.course.scenes.find((s) => s.id === id);
}

function hingeWords(ctx: Ctx, ex: Exchange, combo: Combo): WordId[] {
  const concepts = ex.hinges.map((h) => (h.startsWith("$") ? combo[h.slice(1)] : h));
  return [...new Set(concepts.flatMap((c) => ctx.course.concepts[c] ?? []))];
}

function chooseCombo(ctx: Ctx, ex: Exchange, pick?: Record<string, string>): Combo {
  const combo: Combo = {};
  for (const slot of Object.keys(ex.slots).sort()) {
    const values = ctx.course.groups[ex.slots[slot]];
    const pinned = pick?.[slot];
    if (pinned !== undefined && values.includes(pinned)) {
      combo[slot] = pinned;
      continue;
    }
    combo[slot] = pickPreferred(values, (c) => ctx.course.concepts[c] ?? [], ctx.state.words, ctx.now, ctx.rng);
  }
  return combo;
}

/** Records a heard line: each word is seen, and remembers the first line it was heard in. */
function hear(ctx: Ctx, line: RenderedLine): void {
  for (const t of line.tokens) {
    setWord(ctx, t.word, recordSeen);
    const rec = ctx.state.words[t.word];
    if (!rec.first) rec.first = { line: line.text, place: ctx.state.place };
  }
}

/** The name lines say for the player; "?" only if a front end skipped asking. */
const nameOf = (state: GameState) => state.player ?? "?";

function speak(ctx: Ctx, npc: string, line: RenderedLine): void {
  const said = personalize(line, nameOf(ctx.state));
  ctx.ev.push({ type: "lineSpoken", npc, line: said });
  hear(ctx, said);
}

/** A written wrong reply's option key. */
const altKey = (n: number) => `alt:${n}`;
export const altIndex = (key: string): number | undefined => (/^alt:\d+$/.test(key) ? Number(key.slice(4)) : undefined);

/**
 * Right reply plus up to 3 wrong ones with distinct text: replies that differ from it in exactly
 * one slot first, then the written wrong replies.
 */
function pickOptions(ctx: Ctx, ex: Exchange, combo: Combo): string[] {
  const rightKey = comboKey(combo);
  const texts = new Set([ex.variants[rightKey].reply.text]);
  const wrong: string[] = [];
  for (const key of shuffle(Object.keys(ex.variants), ctx.rng)) {
    if (wrong.length === 3) break;
    const c = parseComboKey(key);
    const differing = Object.keys(combo).filter((s) => c[s] !== combo[s]).length;
    const text = ex.variants[key].reply.text;
    if (differing === 1 && !texts.has(text)) {
      texts.add(text);
      wrong.push(key);
    }
  }
  const alts = ex.variants[rightKey].alts ?? [];
  for (const n of shuffle(alts.map((_, i) => i), ctx.rng)) {
    if (wrong.length === 3) break;
    if (!texts.has(alts[n].text)) {
      texts.add(alts[n].text);
      wrong.push(altKey(n));
    }
  }
  return shuffle([rightKey, ...wrong], ctx.rng);
}

/** The right reply's words plus up to 2 words from other replies (other variants, then written wrong ones). */
function buildTiles(ctx: Ctx, ex: Exchange, combo: Combo): string[] {
  const rightKey = comboKey(combo);
  const pieces = tilePieces(ex.variants[rightKey].reply);
  const extra = new Set<string>();
  const others = shuffle(Object.keys(ex.variants), ctx.rng)
    .filter((k) => k !== rightKey)
    .map((k) => ex.variants[k].reply);
  for (const l of [...others, ...shuffle(ex.variants[rightKey].alts ?? [], ctx.rng)]) {
    for (const p of tilePieces(l)) if (!pieces.includes(p)) extra.add(p);
    if (extra.size >= 2) break;
  }
  return shuffle([...pieces, ...[...extra].slice(0, 2)], ctx.rng);
}

/** The line an option key stands for: a variant's reply, or one of the right variant's written wrong replies. */
function optionLine(ex: Exchange, run: SceneRun, key: string): RenderedLine {
  const n = altIndex(key);
  return n === undefined ? ex.variants[key].reply : ex.variants[comboKey(run.combo)].alts![n];
}

function optionsEvent(ex: Exchange, run: SceneRun, name: string): GameEvent {
  return run.mode === "pick"
    ? { type: "replyOptions", mode: "pick", options: run.options.map((k) => personalize(optionLine(ex, run, k), name)) }
    : { type: "replyOptions", mode: "tiles", tiles: run.tiles.map((x) => (x === PLAYER_MARK ? name : x)) };
}

function emitOptions(ctx: Ctx, ex: Exchange): void {
  ctx.ev.push(optionsEvent(ex, ctx.state.run!, nameOf(ctx.state)));
}

/**
 * The events that draw the scene in progress, for a front end that starts from a save made
 * mid-scene. Changes nothing. Empty when there is no scene, or it no longer fits the course.
 */
export function describeRun(course: Course, state: GameState): GameEvent[] {
  const run = state.run;
  const scene = run && course.scenes.find((s) => s.id === run.scene);
  const ex = scene?.exchanges[run!.exchange];
  const v = ex?.variants[comboKey(run!.combo)];
  if (!run || !scene || !ex || !v) return [];
  return [
    { type: "sceneStarted", scene: scene.id, npc: scene.npc },
    { type: "lineSpoken", npc: scene.npc, line: personalize(v.npc, nameOf(state)) },
    optionsEvent(ex, run, nameOf(state)),
  ];
}

function beginExchange(ctx: Ctx, scene: Scene, index: number, pick?: Record<string, string>): void {
  const run = ctx.state.run!;
  const ex = scene.exchanges[index];
  const combo = chooseCombo(ctx, ex, pick);
  const errandSlot = scene.startsErrand?.slice(1);
  if (errandSlot && errandSlot in combo) run.errandTo = combo[errandSlot];
  speak(ctx, scene.npc, ex.variants[comboKey(combo)].npc);
  // A word got wrong but never yet right is still new to the player: keep picking for it.
  // Tiles are for words the player has known at some point.
  const v = ex.variants[comboKey(combo)];
  const modeWords = [...new Set([...hingeWords(ctx, ex, combo), ...v.reply.tokens.map((t) => t.word)])];
  const states = modeWords.map((w) => {
    const rec = ctx.state.words[w];
    const st = wordState(rec, ctx.now);
    return st === "shaky" && rec && rec.right === 0 ? "met" : st;
  });
  const mode = replyModeFor(states, ctx.course.typing);
  run.exchange = index;
  run.combo = combo;
  run.misses = 0;
  // Typed replies arrive with the first typing-enabled pack; until then "type" plays as tiles.
  run.mode = mode === "type" ? "tiles" : mode;
  run.options = run.mode === "pick" ? pickOptions(ctx, ex, combo) : [];
  run.tiles = run.mode === "tiles" ? buildTiles(ctx, ex, combo) : [];
  emitOptions(ctx, ex);
}

function finishScene(ctx: Ctx, scene: Scene): void {
  const run = ctx.state.run!;
  ctx.state.run = null;
  ctx.state.scenesDone[scene.id] = (ctx.state.scenesDone[scene.id] ?? 0) + 1;
  ctx.ev.push({ type: "sceneEnded", scene: scene.id, earned: run.earned });
  if (scene.startsErrand && run.errandTo) {
    ctx.state.errand = { to: run.errandTo };
    ctx.ev.push({ type: "errandStarted", to: run.errandTo });
  }
  if (scene.endsErrand && ctx.state.errand) {
    const { to } = ctx.state.errand;
    delete ctx.state.errand;
    ctx.ev.push({ type: "errandEnded", to });
  }
  ctx.ev.push(...changeWallet(ctx.state, run.earned, "wages"));
  ctx.ev.push(...addTrust(ctx.state, scene.npc, scene.trustGain + (run.mixups === 0 ? 1 : 0)));
}

function resolve(
  ctx: Ctx,
  scene: Scene,
  ex: Exchange,
  chosen: Combo,
  diff: string[],
  tilesWrong = false,
  other = false,
  saidWords: string[] = [],
): void {
  const run = ctx.state.run!;
  const matched = diff.length === 0 && !tilesWrong && !other;
  ctx.ev.push({
    type: "actionPerformed",
    action: other ? { action: "other" } : resolveParams(ex.expect, chosen),
    expected: resolveParams(ex.expect, run.combo),
    matched,
    diff,
    tilesWrong,
  });
  const hinges = hingeWords(ctx, ex, run.combo);
  if (matched) {
    // The reply's own words count too: saying them right is how a player learns a set phrase.
    const reply = ex.variants[comboKey(run.combo)].reply;
    for (const w of new Set([...hinges, ...reply.tokens.map((t) => t.word)])) setWord(ctx, w, recordRight);
    for (const t of reply.tokens) {
      const rec = ctx.state.words[t.word];
      if (!rec.first) rec.first = { line: personalize(reply, nameOf(ctx.state)).text, place: ctx.state.place };
    }
    run.earned += payFor(ex.pay, run.misses);
    const cost = ex.variants[comboKey(run.combo)].cost ?? 0;
    if (cost > 0) ctx.ev.push(...changeWallet(ctx.state, -cost, "shopping"));
    if (run.exchange + 1 < scene.exchanges.length) beginExchange(ctx, scene, run.exchange + 1);
    else finishScene(ctx, scene);
    return;
  }
  // A miss weakens the hinge words and the right reply's words the chosen reply lacked
  // (the ones the player didn't recognise). `chosen` is what they said instead.
  const said = new Set(saidWords);
  const reply = ex.variants[comboKey(run.combo)].reply;
  const missed = reply.tokens.map((t) => t.word).filter((w) => !said.has(w));
  for (const w of new Set([...hinges, ...missed])) setWord(ctx, w, recordWrong);
  run.misses += 1;
  run.mixups += 1;
  ctx.ev.push(...changeWallet(ctx.state, -ex.missCost, "mixup"));
  const reaction = diff.map((d) => `wrong-${d}`).find((r) => ctx.course.reactions[r]) ?? "wrong-generic";
  ctx.ev.push({ type: "npcReacted", npc: scene.npc, reaction, line: ctx.course.reactions[reaction] });
  // Two wrong tile answers: fall back to picking, so the player is never stuck building a reply.
  if (run.mode === "tiles" && run.misses >= 2) {
    run.mode = "pick";
    run.options = pickOptions(ctx, ex, run.combo);
    run.tiles = [];
  }
  if (run.misses >= 2) {
    const v = ex.variants[comboKey(run.combo)];
    const line = personalize(v.rephrase ?? v.npc, nameOf(ctx.state));
    ctx.ev.push({ type: "lineRephrased", npc: scene.npc, line, slow: !v.rephrase });
    hear(ctx, line);
  }
  emitOptions(ctx, ex);
}

/** A written wrong reply: it doesn't do the asked action at all. */
function resolveOther(ctx: Ctx, scene: Scene, ex: Exchange, said: RenderedLine): void {
  resolve(ctx, scene, ex, ctx.state.run!.combo, [], false, true, said.tokens.map((t) => t.word));
}

export function startScene(ctx: Ctx, id: string, pick?: Record<string, string>): void {
  const scene = sceneById(ctx, id);
  if (!scene) return reject(ctx, "unknown-scene");
  if (ctx.state.run) return reject(ctx, "in-scene");
  if (ctx.course.needsName && !ctx.state.player) return reject(ctx, "no-name");
  if (scene.place !== ctx.state.place) return reject(ctx, "wrong-place");
  if (!isAvailable(scene, ctx.state)) return reject(ctx, "locked");
  if (ctx.state.slot >= ctx.course.world.slotsPerDay) return reject(ctx, "no-slots");
  ctx.state.slot += 1;
  ctx.state.run = {
    scene: id, exchange: 0, combo: {}, mode: "pick", options: [], tiles: [], misses: 0, earned: 0, mixups: 0,
  };
  ctx.ev.push({ type: "sceneStarted", scene: id, npc: scene.npc });
  beginExchange(ctx, scene, 0, pick);
}

/** The running scene and exchange, or undefined if there is none or the save no longer fits the course. */
function current(ctx: Ctx): { scene: Scene; ex: Exchange } | undefined {
  const run = ctx.state.run;
  if (!run) return undefined;
  const scene = sceneById(ctx, run.scene);
  const ex = scene?.exchanges[run.exchange];
  if (!scene || !ex || !ex.variants[comboKey(run.combo)]) return undefined;
  return { scene, ex };
}

/** Slots that change the action. A slot the action doesn't use is never a mix-up. */
function actionDiff(ex: Exchange, chosen: Combo, expected: Combo): string[] {
  const got = resolveParams(ex.expect, chosen);
  const want = resolveParams(ex.expect, expected);
  return Object.keys(want).filter((k) => got[k] !== want[k]);
}

export function reply(ctx: Ctx, choice: number): void {
  const run = ctx.state.run;
  if (run && !current(ctx)) return reject(ctx, "stale-run");
  const cur = current(ctx);
  if (!cur || !run || run.mode !== "pick") return reject(ctx, "no-pick");
  const key = run.options[choice];
  if (key === undefined) return reject(ctx, "bad-choice");
  if (altIndex(key) !== undefined) return resolveOther(ctx, cur.scene, cur.ex, optionLine(cur.ex, run, key));
  const chosen = parseComboKey(key);
  const said = cur.ex.variants[key].reply.tokens.map((t) => t.word);
  resolve(ctx, cur.scene, cur.ex, chosen, actionDiff(cur.ex, chosen, run.combo), false, false, said);
}

export function replyTiles(ctx: Ctx, tiles: number[]): void {
  const run = ctx.state.run;
  if (run && !current(ctx)) return reject(ctx, "stale-run");
  const cur = current(ctx);
  if (!cur || !run || run.mode !== "tiles") return reject(ctx, "no-tiles");
  if (tiles.some((i) => run.tiles[i] === undefined)) return reject(ctx, "bad-tile");
  const chosen = tiles.map((i) => run.tiles[i]);
  const reply = cur.ex.variants[comboKey(run.combo)].reply;
  // Judged by what the player sees: a name that looks like a word is as good as that word.
  const name = nameOf(ctx.state);
  const shown = (pieces: string[]) => joinTiles(ctx.course, pieces.map((x) => (x === PLAYER_MARK ? name : x)));
  const target = shown(tilePieces(reply));
  // Words of the reply the player placed count as said; the rest were missed.
  const said = reply.tokens.filter((t) => chosen.includes(reply.text.slice(t.start, t.end))).map((t) => t.word);
  resolve(ctx, cur.scene, cur.ex, run.combo, [], shown(chosen) !== target, false, said);
}
