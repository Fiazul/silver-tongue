// Developer "jump to screen N" for the lab page (labMode() only). Screens of the Korean flow, in order:
// 1 the opening crawl, 2 the name screen, 3..2+P the desk's papers the player is walked through (optional ones are
// not a step), 3+P the knock, then one screen per
// conversation exchange in story order (3+P+k = exchange k of the game). Pure apart from driving a Quiet.
import { comboKey, tilePieces, type Course, type GameState } from "@silver-tongue/core";
import { deskPapers, firstUnread, letterChart, paperSyllables, textLetterKeys } from "@silver-tongue/view";
import type { Quiet } from "./quiet";

/** The one saved game every jump creates, replaced by the next jump. */
export const DEV_GAME = "dev-jump";

/** A clock the lab page can push forward: a jump drives replies faster than the taps' settle time. */
export const devClock = { skew: 0, now: (): number => Date.now() + devClock.skew };

/** The next Opening mounts on the name screen (screen 2) instead of the crawl; the Opening takes it once. */
let skipCrawl = false;
export const setSkipCrawl = (on: boolean): void => void (skipCrawl = on);
export function takeSkipCrawl(): boolean {
  const was = skipCrawl;
  skipCrawl = false;
  return was;
}

/** The desk's papers the player is walked through, in order: an optional paper ([] required) is not a step. */
export const deskSteps = (course: Course) => deskPapers(course).filter((p) => p.required?.length !== 0);

/** Exchanges played before the scene now running: every exchange of every scene done. */
function exchangesBefore(course: Course, state: GameState): number {
  return course.scenes.reduce((n, s) => n + ((state.scenesDone[s.id] ?? 0) > 0 && s.id !== state.run?.scene ? s.exchanges.length : 0), 0);
}

/**
 * The screen the page is on. `nameScreen`: the opening is past its crawl (the crawl is the Opening
 * component's own state, so the caller reads it off the page). Between scenes it is the last exchange played.
 */
export function screenOf(q: Pick<Quiet, "view" | "course" | "core" | "readPapers">, nameScreen = false): number {
  const view = q.view();
  const course = q.course;
  if (view.opening) return nameScreen ? 2 : 1;
  if (view.phase.kind === "name") return 2;
  const papers = deskSteps(course);
  if (view.desk) {
    const next = firstUnread(papers, q.readPapers());
    return 3 + (next ? papers.findIndex((p) => p.id === next) : papers.length);
  }
  const state = q.core.state;
  const base = 3 + papers.length + exchangesBefore(course, state);
  return state.run ? base + state.run.exchange + 1 : base;
}

/** How many screens the flow has up to and including `exchanges` conversation exchanges. */
export const lastScreen = (course: Course, exchanges: number): number => 3 + deskSteps(course).length + exchanges;

/** The furthest screen a jump goes to: bounds the driver's loop. */
export const maxScreen = (course: Course): number => 3 + deskSteps(course).length + 60;

const MAX_STEPS = 600;
const DEV_NAME = "Dev";

/**
 * Brings a fresh Quiet (nothing done yet) to screen `n`, through its own API: the name, the papers (read
 * in full, their letters met), the door, then replies and the primary menu item until exchange n-3-P is
 * on screen, unanswered. No hold timers: the page is rendered after the jump, so nothing is held.
 * `advance` moves the clock past the taps' settle time. Returns the screen reached (n unless the story
 * stopped short, e.g. a typed reply, which this driver does not answer).
 */
export function driveTo(q: Quiet, n: number, advance: () => void = () => {}, nameScreen = false): number {
  if (n <= 2) return screenOf(q, n === 2);
  const course = q.course;
  const papers = deskSteps(course);
  if (!q.setName(DEV_NAME)) return screenOf(q, nameScreen);
  const chart = letterChart(course);
  for (const p of papers.slice(0, n - 3)) {
    q.readPaper(p.id);
    q.setDeskAt(p.id, paperSyllables(p).length);
    q.meet(p.lines.flatMap((l) => textLetterKeys(chart, l.text)));
  }
  if (n <= 3 + papers.length) return screenOf(q);
  q.leaveDesk();
  const want = n - 3 - papers.length;
  const sig = () => {
    const s = q.core.state;
    return JSON.stringify([s.day, s.place, s.run?.scene, s.run?.exchange, s.run?.misses, Object.keys(s.scenesDone).length]);
  };
  let last = "";
  let still = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const s = q.core.state;
    if (s.run && screenOf(q) - 3 - papers.length === want && ["pick", "tiles", "type"].includes(q.view().phase.kind)) break;
    const p = q.view().phase;
    advance();
    if (p.kind === "pick" && s.run) q.choose(s.run.options.indexOf(comboKey(s.run.combo)));
    else if (p.kind === "tiles" && s.run) {
      // The reply's own pieces, each the first unused tile that spells it.
      const reply = course.scenes.find((x) => x.id === s.run!.scene)!.exchanges[s.run.exchange].variants[comboKey(s.run.combo)].reply;
      const used = new Set<number>();
      for (const piece of tilePieces(reply)) {
        const i = s.run.tiles.findIndex((t, j) => t === piece && !used.has(j));
        if (i < 0) break;
        used.add(i);
        q.placeTile(i);
      }
      q.sendTiles();
    } else if (p.kind === "explore") q.choose(p.primary ?? 0);
    else break; // type: not answered here
    const now = sig();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3) break;
  }
  advance();
  return screenOf(q);
}
