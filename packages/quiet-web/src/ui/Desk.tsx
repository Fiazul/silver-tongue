import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { canOpenPaper, deskReady, firstUnread, paperDone, letterChart, lineRead, paperSyllables, readsSyllable, romanize, sumTiles, type DeskPaper, type SumTile } from "@silver-tongue/view";
import { doorExperimentOn } from "../door-choices";
import type { Quiet } from "../quiet";
import { DeskArt } from "./desk-art";

const matches = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
/** Enter right after the last syllable (held down, say) does not leave the finished paper at once. */
const DONE_GUARD_MS = 300;
/** The desk fading out once every paper is read. */
const FADE_MS = 900;
/** A wrong reading shakes the field this long. */
const SHAKE_MS = 400;
/** The syllable taken out of the card moves to its big copy this long. */
const TAKE_MS = 300;
/** Wrong tries on one syllable before the help button gets bright. */
const HELP_AFTER = 3;

/** After the name screen on a book course with papers: the papers on the desk, all in the language, no meanings.
 * Each is read out one syllable at a time, typing its reading in Latin letters; once all are read, someone knocks
 * and the game starts. */
/** `covered`: the Book or Settings is open over the desk. */
export function Desk({ q, papers, covered, onBook, onSettings }: { q: Quiet; papers: DeskPaper[]; covered: boolean; onBook: () => void; onSettings: () => void }) {
  const t = q.t;
  const read = q.readPapers();
  const [paper, setPaper] = useState<string | null>(null);
  // The lab opening: a paper is seen, not typed. Its words, sounds and meaning show at once, and the thought it gives.
  const glance = doorExperimentOn(q.course);
  const openPaper = (id: string) => (glance && q.glancePaper(id), setPaper(id));
  const [leaving, setLeaving] = useState<"fade" | "knock" | null>(null);
  const allRead = deskReady(papers, read);
  const still = matches("(prefers-reduced-motion: reduce)");
  const touch = matches("(pointer: coarse)");

  // Back on the desk with every paper read: the desk fades, then the one line.
  useEffect(() => {
    if (paper || !allRead || leaving) return;
    setLeaving("fade");
    const id = setTimeout(() => setLeaving("knock"), still ? 0 : FADE_MS);
    return () => clearTimeout(id);
  }, [paper, allRead]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || covered) return;
      if (leaving === "knock" && e.key === "Enter") return void (e.preventDefault(), q.leaveDesk());
      if (e.key === "Escape" && paper) return void (e.preventDefault(), setPaper(null));
      // On the desk, Enter reads the bright card, unless a focused button takes it.
      const next = firstUnread(papers, read);
      if (!paper && !leaving && next && e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement))
        return void (e.preventDefault(), openPaper(next));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (leaving === "knock") {
    return (
      <div class="desk-screen desk-knock">
        <p class="knock">{t("desk-done")}</p>
        <p class="go"><button type="button" class="next-btn pulse" onClick={() => q.leaveDesk()}>{touch ? "" : "↵ "}{t("quiet-open-door")}</button></p>
      </div>
    );
  }
  const open = paper ? papers.find((p) => p.id === paper) : undefined;
  if (open) return <PaperView opening q={q} paper={open} done={read.has(open.id)} covered={covered} onBook={onBook} onBack={() => setPaper(null)} />;
  // One card is bright: the next to read, labelled. The rest are dimmed; a read one says so and stays tappable; later ones wait their turn.
  const next = firstUnread(papers, read);
  return (
    <div class={leaving === "fade" ? "desk-screen leaving" : "desk-screen"}>
      <p class="desk-title">{t("quiet-desk-why")}</p>
      <div class="desk">
        {papers.map((p) => {
          // "Read" only when it was: an optional paper is no step of the desk, but nobody has read it yet.
          const done = read.has(p.id) || (!!p.required?.length && paperDone(p, read));
          const cls = `desk-card ${done ? "read" : p.id === next ? "next" : "later"}`;
          const art = (
            <>
              <DeskArt kind={p.kind} title={p.lines[0]?.text ?? ""} lang={q.course.language.code} />
              <span class="desk-card-state">{done ? t("quiet-desk-done") : p.id === next ? t("quiet-desk-read") : " "}</span>
            </>
          );
          return canOpenPaper(papers, read, p.id) ? (
            <button key={p.id} type="button" class={cls} aria-label={p.lines[0]?.text} onClick={() => openPaper(p.id)}>{art}</button>
          ) : (
            <div key={p.id} class={cls} role="img" aria-label={p.lines[0]?.text} aria-disabled="true">{art}</div>
          );
        })}
      </div>
      <footer class="bar">
        <button type="button" class="dim" onClick={onBook}>{t("quiet-book").toLowerCase()}</button>
        <button type="button" class="dim" onClick={onSettings}>{t("vn-settings").toLowerCase()}</button>
      </footer>
    </div>
  );
}

/** One tile of the sum: the letter and, under it, its sound; a letter met in an earlier block shows "?" until asked for. Tap to hear it. */
function Tile({ q, tile, shown, onShow }: { q: Quiet; tile: SumTile; shown: boolean; onShow: () => void }) {
  const l = tile.letter;
  const hidden = !tile.fresh && !shown;
  const sound = `${tile.sound}${tile.final ? ` (${q.t("quiet-letter-end")})` : ""}`;
  return (
    <button type="button" class={`tile${hidden ? " unknown" : ""}`} aria-label={hidden ? l.ch : `${l.ch} ${sound}`} onClick={() => (hidden && onShow(), q.play(l.audio ?? []))}>
      <span class="tl-ch" lang={q.course.language.code}>{l.ch}</span>
      <span class="tl-rd">{hidden ? "?" : sound}</span>
    </button>
  );
}

/** One paper, laid out like the document, read one syllable at a time: the syllable being read is taken out of the card
 * and shown large, over the letters it is made of; its reading is typed under it. */
export function PaperView({ q, paper, done, covered, onBook, onBack, opening = false }: { q: Quiet; paper: DeskPaper; done: boolean; covered: boolean; onBook: () => void; onBack: () => void; opening?: boolean }) {
  const t = q.t;
  const chart = useMemo(() => letterChart(q.course), [q.course]);
  const syls = useMemo(() => paperSyllables(paper), [paper]);
  const [at, setAtState] = useState(() => (done ? syls.length : q.deskAt(paper.id)));
  const [typed, setTyped] = useState("");
  const [shake, setShake] = useState(false);
  // Per block: wrong tries; the "?" tiles asked for; whether the reading was asked for.
  const [wrong, setWrong] = useState(0);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [geo, setGeo] = useState<string>("");
  const input = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLDivElement>(null);
  const requiredRead = !!paper.required?.length && paper.required.every((id) => lineRead(syls, paper.lines.findIndex((l) => l.id === id), at));
  const finished = at >= syls.length || (opening && requiredRead);
  const cur = finished ? undefined : syls[at];
  const key = `${paper.id}:${at}`;
  // The letters met before this syllable, taken once as it comes up (it then meets its own).
  const snap = useRef<{ key: string; before: ReadonlySet<string> }>();
  if (snap.current?.key !== key) snap.current = { key, before: new Set(q.deskMet() ?? []) };
  const before = snap.current.before;
  const tiles = cur ? sumTiles(chart, cur.ch, before) : [];
  const first = before.size === 0;
  const hidden = tiles.filter((x) => !x.fresh && !shown.has(x.key));

  const setAt = (n: number) => {
    setAtState(n);
    q.setDeskAt(paper.id, n);
  };
  useEffect(() => {
    if (cur) q.meet(tiles.map((r) => r.key));
  }, [key]);
  useEffect(() => input.current?.focus(), [key, covered]);

  // Where the syllable sits in the card, and the line down to its big copy; the copy slides out of the card.
  const measure = () => {
    const s = stage.current, c = card.current, b = big.current;
    const from = c?.querySelector(".sy.cur .sy-ch");
    if (!s || !c || !b || !from) return void setGeo("");
    const sr = s.getBoundingClientRect(), fr = from.getBoundingClientRect(), br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const sx = fr.left + fr.width / 2 - sr.left, sy = fr.bottom - sr.top;
    const bx = br.left + br.width / 2 - sr.left, by = br.top - sr.top;
    const mid = Math.min(by - 4, cr.bottom - sr.top + 6);
    setGeo(`M${sx} ${sy} V${mid} H${bx} V${by}`);
    return { fx: fr.left + fr.width / 2 - (br.left + br.width / 2), fy: fr.top + fr.height / 2 - (br.top + br.height / 2) };
  };
  useLayoutEffect(() => {
    const m = measure();
    const b = big.current;
    if (m && b && typeof b.animate === "function" && !matches("(prefers-reduced-motion: reduce)")) {
      b.animate([{ transform: `translate(${m.fx}px, ${m.fy}px) scale(0.35)`, opacity: 0.2 }, { transform: "none", opacity: 1 }], { duration: TAKE_MS, easing: "ease-out" });
    }
  }, [key]);
  useEffect(() => {
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [key]);

  // The last syllable read: the paper is read; it stays up, with what it tells, until the player goes back (Enter).
  const doneAt = useRef(0);
  useEffect(() => {
    if (!finished) return;
    doneAt.current = Date.now();
    if (at >= syls.length && !done) q.readPaper(paper.id);
    else if (requiredRead) for (const id of paper.required ?? []) q.readPaperLine(paper.id, id);
  }, [finished]);
  useEffect(() => {
    if (!finished || covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey || Date.now() - doneAt.current < DONE_GUARD_MS) return;
      e.preventDefault();
      onBack();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [finished, covered]);

  // First press: the "?" tiles of this block; then (or at once when none are) what the block reads.
  const askHelp = () => {
    if (hidden.length) setShown(new Set([...shown, ...hidden.map((x) => x.key)]));
    else setReading(true);
    input.current?.focus();
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const v = typed.trim();
    if (!cur || !v) return input.current?.focus();
    if (v.toLowerCase() === "book") return (setTyped(""), onBook());
    if (readsSyllable(v, cur.ch)) {
      setTyped("");
      setWrong(0);
      setShown(new Set());
      setReading(false);
      if (lineRead(syls, cur.line, at + 1)) q.play(paper.lines[cur.line].audio ?? []);
      setAt(at + 1);
    } else {
      setWrong(wrong + 1);
      setShake(true);
      setTimeout(() => setShake(false), SHAKE_MS);
      input.current?.focus();
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.shiftKey) return void (e.preventDefault(), onBook());
    if (e.key === "?") return void (e.preventDefault(), askHelp());
  };
  const onInput = (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    // `?` is never part of a reading: from a phone keyboard it asks for help too.
    if (v.includes("?")) askHelp();
    setTyped(v.replace(/\?/g, ""));
  };

  const at2 = new Map(syls.map((s, i) => [`${s.line}:${s.index}`, i] as const));
  const touch = matches("(pointer: coarse)");
  const learned = `paper-${paper.id}-learned`;
  return (
    <div class="desk-screen reading">
      <div class="stage" ref={stage}>
        {cur && q.readPapers().size === 0 && <p class="intro">{t("quiet-read-intro")}</p>}
        <div class={`paper paper-${paper.kind} compact`} lang={q.course.language.code} ref={card}>
          {paper.lines.map((l, li) => {
            const lineDone = lineRead(syls, li, at);
            const chars = [...l.text].map((ch, ci) => {
              const g = at2.get(`${li}:${ci}`);
              if (g === undefined) return <span key={ci} class="sy pass"><span class="sy-ch">{ch}</span></span>;
              const state = g < at ? "read" : g === at ? "cur" : "next";
              return (
                <span key={ci} class={`sy ${state}`}>
                  <span class="sy-ch">{ch}</span>
                  <span class="sy-rr" lang={`${q.course.language.code}-Latn`}>{g < at && !lineDone ? romanize(ch) : " "}</span>
                </span>
              );
            });
            const hasSyls = syls.some((s) => s.line === li);
            return (
              <div key={l.id} class={`pl pl-${l.id}${lineDone ? " said" : ""}`}>
                {lineDone ? <button type="button" class="pl-text" onClick={() => q.play(l.audio ?? [])}>{chars}</button> : <div class="pl-text">{chars}</div>}
                {hasSyls && <span class="pl-rr" lang={`${q.course.language.code}-Latn`}>{lineDone ? romanize(l.text) : " "}</span>}
                {/* A phrasebook line gives its meaning once read. */}
                {lineDone && t.has(`paper-${paper.id}-${l.id}`) && <span class="pl-gloss">{t(`paper-${paper.id}-${l.id}`)}</span>}
              </div>
            );
          })}
        </div>
        {finished && (
          <>
            {t.has(learned) && <p class="learned">{t(learned)}</p>}
            <button type="button" class="go next-btn" onClick={onBack}>{touch ? t("vn-continue") : `↵ ${t("quiet-enter")}`}</button>
          </>
        )}
        {cur && geo && (
          <svg class="link" aria-hidden="true"><path d={geo} /></svg>
        )}
        {cur && (
          <div class="take">
            <div class="big" ref={big} lang={q.course.language.code}>{cur.ch}</div>
            <form class={shake ? "sum shake" : "sum"} onSubmit={submit} lang={q.course.learner}>
              {tiles.map((tl, i) => (
                <Fragment key={tl.key}>
                  {i > 0 && <span class="op">+</span>}
                  <Tile q={q} tile={tl} shown={shown.has(tl.key)} onShow={() => setShown(new Set([...shown, tl.key]))} />
                </Fragment>
              ))}
              <span class="op">=</span>
              <input ref={input} value={typed} placeholder={t("quiet-read-placeholder")} aria-label={t("quiet-read-placeholder")} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellcheck={false}
                enterkeyhint="go" onInput={onInput} onKeyDown={onKeyDown} />
              <button type="submit" class="go" aria-label={t("quiet-enter")}>↵</button>
            </form>
            {first && <p class="example">{t("quiet-read-example", { parts: tiles.map((x) => x.sound).join(" + "), reading: romanize(cur.ch) })}</p>}
            {reading && <p class="rh-full">{t("quiet-read-help-full", { reading: romanize(cur.ch) })}</p>}
            <div class="read-tools">
              <button type="button" class={wrong >= HELP_AFTER ? "help hot" : "help"} onClick={askHelp}>{touch ? t("quiet-read-help") : `? ${t("quiet-read-help")}`}</button>
              {!touch && <span class="dim">{t("quiet-read-tab-book")}</span>}
            </div>
          </div>
        )}
      </div>
      <footer class="bar">
        <button type="button" class="dim" onClick={onBack}>{touch ? t("web-close").toLowerCase() : t("quiet-esc")}</button>
        <button type="button" class="dim" onClick={onBook}>{t("quiet-book").toLowerCase()}</button>
      </footer>
    </div>
  );
}
