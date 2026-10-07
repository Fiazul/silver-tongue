import { useEffect, useRef, useState } from "preact/hooks";
import type { RenderedLine, WordId } from "@silver-tongue/core";
import { displayGloss, freshOnReply, freshOnTheirLine, lineMeaning, meaningMatches, romanLine, romanSegments, scribeAccepts, scribeScene, scribeReplyId, soundedTokens, scribeHelpAfter, scribeShowsExample } from "@silver-tongue/view";
import { Line } from "./Line";
import type { Quiet, QuietView } from "../quiet";
import { replyOrder, type Exchange } from "../stage";
import { resolveScribeReply, freshOnce, scribeRound, subscribeRounds, updateRound, type Round } from "../scribe";
import { cardLabel, openingProfile } from "../door-choices";

/*
 * Scribe mode (lab only, the first conversations): their line in Latin letters with a field for what it means, your
 * replies as Korean slips, with direct selection at the door and a meaning field afterwards. Wrong tries shake the field; its help
 * button lights after a few and then gives the words, then the meaning. Rules and wording: view/src/scribe.ts.
 */

const SHAKE_MS = 400;

/** The round of an exchange, redrawn when it changes. */
export function useRound(q: Quiet, ex: Exchange | undefined): Round | undefined {
  const [, tick] = useState(0);
  useEffect(() => subscribeRounds(() => tick((n) => n + 1)), []);
  return ex ? scribeRound(q, q.course.id, ex.line.id) : undefined;
}

/** A field that takes a typed meaning; a wrong try shakes it. `?` typed asks for help, as on the desk. */
function Field({ placeholder, onTry, onHelp, hot, helpLabel, children }: {
  placeholder: string; onTry: (typed: string) => boolean; onHelp: () => void; hot: boolean; helpLabel: string; children?: preact.ComponentChildren;
}) {
  const [typed, setTyped] = useState("");
  const [shake, setShake] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = (e: Event) => {
    e.preventDefault();
    const v = typed.trim();
    if (!v) return input.current?.focus();
    if (onTry(v)) return setTyped("");
    setShake(true);
    setTimeout(() => setShake(false), SHAKE_MS);
    input.current?.focus();
  };
  const onInput = (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    if (v.includes("?")) onHelp();
    setTyped(v.replace(/\?/g, ""));
  };
  return (
    <div class="scribe-field">
      <form class={shake ? "scribe-form shake" : "scribe-form"} onSubmit={submit}>
        <input ref={input} value={typed} placeholder={placeholder} aria-label={placeholder} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellcheck={false} enterkeyhint="go" onInput={onInput} />
        <button type="submit" class="go" aria-label="↵">↵</button>
      </form>
      {children}
      <div class="read-tools">
        <button type="button" class={hot ? "help hot" : "help"} onClick={() => (onHelp(), input.current?.focus())}>? {helpLabel}</button>
      </div>
    </div>
  );
}

/** The deduction for the exchange on stage, if the course works this line out from cards. */
export function deductionFor(q: Quiet) {
  const run = q.core.state.run;
  if (!run) return;
  const ex = q.course.scenes.find((s) => s.id === run.scene)?.exchanges[run.exchange];
  return ex && openingProfile(q.course)?.deduce?.[`${run.scene}:${ex.id}`];
}

const lineKey = (q: Quiet): string | undefined => {
  const run = q.core.state.run;
  const ex = run && q.course.scenes.find((s) => s.id === run.scene)?.exchanges[run.exchange];
  return ex ? `${run!.scene}:${ex.id}` : undefined;
};
/** Whether the line on stage is understood outright (said in English too): its meaning shows, nothing to work out. */
export const understoodNow = (q: Quiet): boolean => !!openingProfile(q.course)?.understood?.includes(lineKey(q) ?? "");
/** Whether the line on stage is one the player can't understand yet: no cards, no meaning, just answer. */
export const confusedNow = (q: Quiet): boolean => !!openingProfile(q.course)?.confused?.includes(lineKey(q) ?? "");

/**
 * Working out their line, the way a detective does: clues and memories float up, and the one that fits gives a thought.
 * A card that doesn't fit shakes and dims; nothing is lost. Help gives the line's meaning, never what to answer.
 */
function Thoughts({ q, exKey, round, set, meaning }: { q: Quiet; exKey: string; round: Round; set: (c: Partial<Round>) => void; meaning: string }) {
  const { t } = q;
  const d = openingProfile(q.course)!.deduce![exKey];
  const [tried, setTried] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string>();
  const [shake, setShake] = useState(false);
  const label = (id: string) => t(cardLabel(q.course, q.openingChoices(), id)!);
  // The right card is never always first: a fixed turn per line, so the order is the same each time it is played.
  const turn = [...exKey].reduce((n, ch) => n + ch.charCodeAt(0), 0) % d.cards.length;
  const order = [...d.cards.slice(turn), ...d.cards.slice(0, turn)];
  // As in a detective's thinking: tap a thought to hold it, then conclude, or let it go and think again.
  const conclude = () => {
    if (!chosen) return;
    if (chosen === d.right) return set({ solved: true });
    setTried((x) => (x.includes(chosen) ? x : [...x, chosen]));
    setChosen(undefined);
    setShake(true);
    setTimeout(() => setShake(false), SHAKE_MS);
    set({ misses: round.misses + 1 });
  };
  const thought = (id: string, i: number) => (
    <button key={id} type="button" style={`--i:${i}`} aria-pressed={chosen === id} disabled={tried.includes(id)}
      class={`thought${chosen === id ? " chosen" : ""}${tried.includes(id) ? " tried" : ""}`} onClick={() => setChosen(chosen === id ? undefined : id)}>{label(id)}</button>
  );
  return (
    <div class={`thoughts${shake ? " shake" : ""}`}>
      <p class="thoughts-ask">{t("quiet-deduce-prompt")}</p>
      <div class="thought-field" role="group" aria-label={t("quiet-deduce-prompt")}>
        <div class="thought-side left">{order.map((id, i) => (i % 2 === 0 ? thought(id, i) : null))}</div>
        <div class="thought-mind" aria-hidden="true">💭</div>
        <div class="thought-side right">{order.map((id, i) => (i % 2 === 1 ? thought(id, i) : null))}</div>
      </div>
      {/* Said to yourself after a thought that doesn't fit; it goes once you take up another thought. */}
      {tried.length > 0 && !chosen && <p class="thoughts-miss" key={tried.length} aria-live="polite">{t("quiet-deduce-miss")}</p>}
      <div class="thought-actions">
        <button type="button" class="thought-act" disabled={!chosen} onClick={() => setChosen(undefined)}>{t("quiet-deduce-again")}</button>
        <button type="button" class="thought-act go" disabled={!chosen} onClick={conclude}>{t("quiet-deduce-conclude")}</button>
      </div>
      <div class="read-tools">
        <button type="button" class={round.misses >= 1 ? "help hot" : "help"} onClick={() => set({ help: 2 })}>? {t("quiet-read-help")}</button>
      </div>
      {round.help >= 2 && <p class="rh-full">{t("quiet-hint-meaning", { meaning })}</p>}
    </div>
  );
}

/**
 * Their Korean line and its romanisation, with tappable words and a field for its meaning; once typed
 * right the meaning stays under the line. The shared Line preserves recognised-name highlighting.
 */
export function ScribeTheir({ q, ex, held, onWord, children }: {
  q: Quiet; ex: Exchange; held: boolean; onWord: (w: WordId, surface: string, el: HTMLElement) => void; children?: preact.ComponentChildren;
}) {
  const { t, course } = q;
  const round = useRound(q, ex)!;
  const line = ex.shown;
  const meaning = lineMeaning(line);
  const understood = understoodNow(q);
  const confused = confusedNow(q);
  const solved = round.solved || !meaning || understood || confused;
  const segs = romanSegments(line);
  const run = q.core.state.run!;
  const source = course.scenes.find((s) => s.id === run.scene)!.exchanges[run.exchange].id;
  const accepts = scribeAccepts(course, run.scene, source, q.core.state.player);
  const sounded = soundedTokens(course, q.readPapers(), line);
  const deduce = deductionFor(q);
  // Working a line out from cards: no word is glossed until it is understood, or the cards would be pointless.
  const glosses = scribeScene(q.course, run.scene)?.glosses || (!solved && round.help >= 1) || (!!deduce && solved) || understood;
  // Help first, hands off later: a word never met shows its gloss, a met one only when help asks.
  const fresh = freshOnce(q, `${course.id}:${ex.line.id}:line`, () => freshOnTheirLine(ex.shown, q.core.state.words, ex.line.line ?? ex.shown));
  const set = (change: Partial<Round>) => updateRound(q, course.id, ex.line.id, change);
  const onTry = (typed: string) => {
    if (meaningMatches(typed, meaning, accepts)) return set({ solved: true }), true;
    set({ misses: round.misses + 1 });
    return false;
  };
  const latin = `${course.language.code}-Latn`;
  return (
    <>
      <div class={`say scribe-say${ex.again ? " again" : " enter"}`} key={`${ex.line.id}:${ex.again}`}>
        <p class="say-text" lang={course.language.locale}><Line line={line} now={Date.now()} book sounded={sounded} onWord={onWord} /></p>
        <span class="say-text roman" lang={latin}>
          {segs.map((s, i) =>
            s.word === undefined ? (
              <span key={i}>{s.text}</span>
            ) : (
              <span key={i} class="sw">
                <button type="button" class={`w${s.token !== undefined && sounded.has(s.token) ? " sounded" : ""}`} onClick={(e) => (e.stopPropagation(), onWord(s.word!, s.surface ?? s.text, e.currentTarget))}>{s.text}</button>
                {(glosses || (!deduce && !confused && fresh.has(s.word))) && <span class="sw-g">{displayGloss(course.words[s.word])}</span>}
              </span>
            ),
          )}
        </span>
      </div>
      {deduce ? (
        solved ? (
          <>
            <p class="say-thought">{t(deduce.thought)}</p>
            {round.help >= 2 && meaning && <p class="say-mean">{meaning}</p>}
          </>
        ) : (
          !held && <Thoughts key={`${run.scene}:${source}`} q={q} exKey={`${run.scene}:${source}`} round={round} set={set} meaning={meaning} />
        )
      ) : confused ? (
        // Not understood, and not meant to be: the meaning only if asked for.
        round.help >= 2 ? <p class="say-mean">{t("quiet-hint-meaning", { meaning })}</p> : (
          <div class="read-tools"><button type="button" class="help" onClick={() => set({ help: 2 })}>? {t("quiet-read-help")}</button></div>
        )
      ) : solved ? (
        meaning && <p class="say-mean">{meaning}</p>
      ) : (
        !held && (
          <Field placeholder={t(scribeScene(q.course, run.scene)?.prompt ?? "quiet-scribe-hear")} onTry={onTry} hot={round.misses >= scribeHelpAfter(round.index)} helpLabel={t("quiet-read-help")}
            onHelp={() => set({ help: Math.min(2, round.help + 1) as Round["help"] })}>
            {scribeShowsExample(round.index) && <p class="example">{t("quiet-scribe-example", { line: romanLine(line), meaning })}</p>}
            {round.help >= 2 && <p class="rh-full">{t("quiet-scribe-full", { meaning })}</p>}
          </Field>
        )
      )}
      {children}
    </>
  );
}

/** While a scribe exchange is on stage the number keys never say a reply: typing is the one way to say. */
export function ScribeKeys({ held = false }: { held?: boolean }) {
  useEffect(() => {
    const guard = (e: KeyboardEvent) => {
      // A held moment moves on with any key (App's skip), and an open overlay keeps its own keys.
      if (held || document.querySelector('[role="dialog"]')) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!/^[1-9]$/.test(e.key.normalize("NFKC"))) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      document.querySelector<HTMLInputElement>(".scribe-field input")?.focus();
    };
    addEventListener("keydown", guard, true);
    return () => removeEventListener("keydown", guard, true);
  }, [held]);
  return null;
}

/** The meaning of each option, for matching and for the help: its own meaning, never its intent. */
const meaningOf = (o: RenderedLine): string => lineMeaning(o);

/**
 * Korean reply slips with romanisation. Select a slip at the door; later type its meaning or choose tied slips.
 * Shown once their line has been understood.
 */
export function ScribeSlips({ q, view, ex }: { q: Quiet; view: QuietView; ex?: Exchange }) {
  const { t } = q;
  const round = useRound(q, ex);
  const p = view.phase;
  if (p.kind !== "pick" || !ex || !round) return null;
  if (!round.solved && lineMeaning(ex.shown) && !understoodNow(q) && !confusedNow(q)) return null;
  const run = q.core.state.run!;
  const source = q.course.scenes.find((s) => s.id === run.scene)!.exchanges[run.exchange].id;
  const accepts = (o: RenderedLine) => scribeAccepts(q.course, run.scene, scribeReplyId(q.course, run.scene, source, o, q.core.state.player), q.core.state.player);
  const ties = round.ties;
  const setTies = (ties: number[]) => updateRound(q, q.course.id, ex.line.id, { ties });
  const order = replyOrder(p.options, ex.missed);
  const set = (change: Partial<Round>) => updateRound(q, q.course.id, ex.line.id, change);
  const onTry = (typed: string) => {
    const match = resolveScribeReply(typed, order.map((i) => ({ meaning: meaningOf(p.options[i]), accepts: accepts(p.options[i]) })));
    if (match.kind === "miss") return setTies([]), set({ rMisses: round.rMisses + 1 }), false;
    if (match.kind === "choose") return setTies(match.indices.map((i) => order[i])), true;
    setTies([]);
    q.choose(order[match.index]);
    return true;
  };
  const tried = new Set(ex.missed.map((m) => m.line?.text));
  const fresh = freshOnce(q, `${q.course.id}:${ex.line.id}:reply`, () => new Set(p.options.flatMap((o) => [...freshOnReply(o, q.core.state.words)])));
  return (
    <div class="slips scribe-slips">
      <div class="scribe-list" role="list">
        {order.map((i) => {
          const o = p.options[i];
          const content = <>
            <span class="slip-text" lang={q.course.language.locale}>{o.text}</span>
            <span class="slip-text" lang={`${q.course.language.code}-Latn`}>
              {romanSegments(o).map((sg, k) =>
                sg.word !== undefined && (scribeScene(q.course, run.scene)?.glosses || fresh.has(sg.word)) ? (
                  <span key={k} class="sw"><span>{sg.text}</span><span class="sw-g">{displayGloss(q.course.words[sg.word])}</span></span>
                ) : (
                  <span key={k}>{sg.text}</span>
                ),
              )}
            </span>
            {(round.rHelp || scribeScene(q.course, run.scene)?.glosses) && <span class="slip-mean">{meaningOf(o)}</span>}
          </>;
          const cls = `slip scribe-slip${tried.has(o.text) ? " tried" : ""}`;
          return scribeScene(q.course, run.scene)?.select ? (
            <div key={i} role="listitem"><button type="button" class={`${cls} selectable`} onClick={() => q.choose(i)}>{content}</button></div>
          ) : (
            <div key={i} role="listitem" tabIndex={0} class={cls}>{content}</div>
          );
        })}
      </div>
      {scribeScene(q.course, run.scene)?.select && !round.rHelp && (
        <div class="read-tools">
          <button type="button" class="help" onClick={() => set({ rHelp: true })}>? {t("quiet-read-help")}</button>
        </div>
      )}
      {!scribeScene(q.course, run.scene)?.select && (ties.length ? (
        <div role="group" aria-label={t("quiet-scribe-choose")}>
          <p>{t("quiet-scribe-choose")}</p>
          {ties.map((i) => <button type="button" class="slip" onClick={() => { setTies([]); q.choose(i); }}>{p.options[i].text} · {p.options[i].intent ?? meaningOf(p.options[i])}</button>)}
        </div>
      ) : <Field placeholder={t("quiet-scribe-say")} onTry={onTry} hot={round.rMisses >= scribeHelpAfter(round.index)} helpLabel={t("quiet-read-help")} onHelp={() => set({ rHelp: true })} />)}
      {p.confused && (
        <button type="button" class="say-nothing" onClick={() => q.choose(p.options.length)}>… {t("quiet-say-nothing")}</button>
      )}
    </div>
  );
}
