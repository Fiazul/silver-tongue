import { doorSnapshot, reportJourney, embeddedJourney } from '../../journey/src/bridge';
// Forked from packages/vn-web/src/main.tsx: the same loading and saves, drawn as a quiet terminal.
import { DOOR_LAB_PREFIX, installPageStorage } from "./storage";
import { render } from "preact";
import { createCore, mulberry32, newGame, type CatalogEntry, type Course, type GameState } from "@silver-tongue/core";
import { courseLabels, decodeSave, DEFAULT_RUBY, DEFAULT_SPEED, encodeSave, learnerFor, deskKey, emptyProgress, lookupHintKey, makeText, papersKey, parseProgress, playbackRate, sessionLines, type RubySetting, type SpeechSpeed, type Text } from "@silver-tongue/view";
import {
  coursesBase, createWebAudio, fetchJson, fromLocalStorage, labKeyValue, labMode, loadWebSettings, metaContent, migrateWebAliases, pageStart, updateWebSettings, WebSessions,
  type KeyValue, type Opened,
} from "@silver-tongue/web-common";
import { App, type Page } from "./ui/App";
import { DevBadge } from "./ui/DevBadge";
import { DEV_GAME, devClock, driveTo, lastScreen, maxScreen, setSkipCrawl } from "./dev";
import { doorExperimentOn, openingStore, writeCount } from "./scribe";
import { Title } from "./ui/Title";
import { createQuiet, type PaperStore, type Quiet } from "./quiet";
import { prepareDoorCourse } from "./door-choices";
import { opensOnStory } from "./opening";

/** The game's version (packages/tui-node/package.json), put in by the build. */
declare const __VERSION__: string;
const root = document.getElementById("app")!;
const base = coursesBase(document);
// The other pages' addresses, set when the pages are served together (tools/src/site.ts).
const textUrl = metaContent(document, "st-text");
const vnUrl = metaContent(document, "st-vn");

// Private windows and blocked site data make localStorage throw: play on without saving.
const noStorage: KeyValue = {
  getItem: () => { throw new Error("no storage"); },
  setItem: () => { throw new Error("no storage"); },
  removeItem: () => {},
  keys: () => [],
};
let kv = noStorage;
try {
  kv = fromLocalStorage(window.localStorage);
} catch {
  // stays noStorage
}
// Lab page only: all storage under its own prefix (the page shares an origin with the real game).
const lab = labMode();
if (lab) kv = labKeyValue(kv, embeddedJourney() ? 'silver-tongue-journey-door:' : DOOR_LAB_PREFIX);
installPageStorage(kv);

interface Loaded { course: Course; t: Text; sessions: WebSessions; audio: ReturnType<typeof createWebAudio> }
let catalog: CatalogEntry[] = [];
let loaded: Loaded | undefined;
let current: { id: string; readOnly: boolean; state: () => GameState } | undefined;
/** How fast clips are said: the player's own setting, shared with the other pages. */
let speed: SpeechSpeed = DEFAULT_SPEED;
/** When readings are written under words: the player's own setting, shared with the other pages. */
let ruby: RubySetting = DEFAULT_RUBY;

/** Fetches a course file and its sound, and moves its old games. */
async function load(entry: CatalogEntry, learner: string): Promise<Loaded> {
  const course = prepareDoorCourse(await fetchJson<Course>(`${base}${entry.id}/${learner}.json`), lab);
  migrateWebAliases(kv, course);
  return {
    course,
    t: makeText(course.learnerFtl, course.learner),
    sessions: new WebSessions(kv, course, Date.now),
    audio: createWebAudio({
      base: `${base}${entry.id}/audio/`,
      audio: typeof Audio === "undefined" ? undefined : new Audio(),
      wait: (ms, cb) => {
        const h = setTimeout(cb, ms);
        return { cancel: () => clearTimeout(h) };
      },
      // Asked per clip, so a speed pressed in settings takes at once.
      rate: () => playbackRate(speed),
    }),
  };
}

function use(l: Loaded, remember: boolean) {
  loaded?.audio.stop();
  loaded = l;
  document.documentElement.lang = l.course.learner;
  if (remember) updateWebSettings(kv, { course: l.course.id, learner: l.course.learner });
}

/** The desk's read papers, one list per course; storage that throws just forgets them. */
function paperStore(kv: KeyValue, course: string): PaperStore {
  const key = papersKey(course);
  return {
    load() {
      try {
        const v: unknown = JSON.parse(kv.getItem(key) ?? "[]");
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    },
    save(ids) {
      try {
        kv.setItem(key, JSON.stringify(ids));
      } catch {
        // private window: the desk is read again next time
      }
    },
    loadProgress() {
      try {
        return parseProgress(JSON.parse(kv.getItem(deskKey(course)) ?? "{}"));
      } catch {
        return emptyProgress();
      }
    },
    loadLookupDone() {
      try {
        return kv.getItem(lookupHintKey(course)) === "1";
      } catch {
        return false;
      }
    },
    saveLookupDone() {
      try {
        kv.setItem(lookupHintKey(course), "1");
      } catch {
        // private window: the hint shows again next time
      }
    },
    saveProgress(p) {
      try {
        kv.setItem(deskKey(course), JSON.stringify(p));
      } catch {
        // private window: the reading starts over next time
      }
    },
  };
}

// Lab page only: jump to a screen of the flow (dev.ts). Off the lab page none of this runs.
let devRoot: HTMLElement | undefined;
/** Bumped by every lab jump: the page is mounted afresh, so no component state outlives the jump. */
let jumpNonce = 0;
/** `prepare` runs on the new game before it is drawn (the lab jump). */
function play(opened: Opened, prepare?: (q: Quiet) => void) {
  const l = loaded!;
  if (!prepare) setSkipCrawl(false); // a jump's one-shot never reaches a normal game
  l.audio.stop();
  const core = createCore(l.course, opened.state, { now: Date.now, rng: mulberry32(Date.now() >>> 0) });
  const store = l.sessions; // this game's own store: a course loaded later must not take its saves
  const quiet = createQuiet({
    course: l.course, core, now: lab ? devClock.now : Date.now, audio: l.audio, notice: opened.notice,
    save: opened.readOnly ? undefined : (s) => store.save(opened.id, s),
    papers: paperStore(kv, l.course.id),
    lab,
    openingChoice: doorExperimentOn(l.course, lab) ? openingStore(l.course, opened.id) : undefined,
  });
  prepare?.(quiet);
  if (embeddedJourney()) {
    quiet.subscribe(() => reportJourney(doorSnapshot(quiet, opened.id)));
    reportJourney(doorSnapshot(quiet, opened.id));
  }
  current = { id: opened.id, readOnly: opened.readOnly, state: () => core.state };
  const page: Page = {
    catalog: embeddedJourney() ? catalog.filter(entry => entry.id === l.course.id) : catalog,
    audioAvailable: l.audio.available,
    get speed() { return speed; },
    setSpeed: (s) => {
      speed = s;
      updateWebSettings(kv, { speed: s });
    },
    get ruby() { return ruby; },
    setRuby: (r) => {
      ruby = r;
      updateWebSettings(kv, { ruby: r });
    },
    switchTo: (id, learner) => void switchTo(id, learner),
    textUrl,
    vnUrl,
    games: {
      list: () => {
        const list = store.list();
        const lines = sessionLines(list, l.course, l.t, (ms) => new Date(ms).toLocaleString());
        return list.map((s, i) => ({ id: s.id, label: lines[i].replace(/^\d+\) /, "") }));
      },
      open: (id) => play(store.open(id)),
      startNew: () => play(store.startNew()),
      exportLine: () => encodeSave(core.state),
      importLine: async (line) => {
        const decoded = await decodeSave(line, l.course);
        if (!decoded.ok) return l.t("import-bad", { reason: decoded.reason });
        const id = store.add(decoded.state);
        if (!id) return l.t("notice-read-only");
        play(store.open(id));
        return null;
      },
    },
  };
  render(<App key={`${l.course.id}/${l.course.learner}/${opened.id}/${jumpNonce}`} q={quiet} page={page} />, root);
  setSkipCrawl(false); // taken (or not wanted) by now
  if (lab && !embeddedJourney()) {
    devRoot ??= document.body.appendChild(document.createElement("div"));
    render(<DevBadge key={opened.id} q={quiet} jump={jumpTo} />, devRoot);
  }
}

/** Lab page: a new game brought to screen `n` (see dev.ts); the address keeps it so a reload lands there. */
function jumpTo(requested: number) {
  const l = loaded;
  if (!l) return;
  const n = Math.min(Math.max(requested, 1), maxScreen(l.course));
  jumpNonce++;
  try {
    const url = new URL(location.href);
    url.searchParams.set("screen", String(n));
    history.replaceState(null, "", url);
  } catch {
    // an address that can't change: the jump still happens
  }
  setSkipCrawl(n === 2);
  // The scribe arc (worked example, early help) counts exchanges: landing on exchange k leaves k-1 behind it.
  writeCount(l.course.id, Math.max(0, n - lastScreen(l.course, 0) - 1));
  // One fixed game id: the next jump replaces it, so jumping never grows the game list.
  l.sessions.remove(DEV_GAME);
  play({ id: DEV_GAME, state: newGame(l.course), readOnly: false }, (q) => void driveTo(q, n, () => (devClock.skew += 1000), n === 2));
  devClock.skew += 1000; // taps on the screen it lands on count at once
}

/** Another course or reading language, chosen in settings. */
async function switchTo(id: string, learner: string) {
  const entry = catalog.find((e) => e.id === id);
  const was = current!;
  const carried: Opened = { id: was.id, state: was.state(), readOnly: was.readOnly };
  const sameCourse = id === loaded!.course.id;
  try {
    if (!entry) throw new Error(`no course ${id}`);
    use(await load(entry, learner), true);
  } catch {
    return play(carried); // the file didn't come: go on with the game being played
  }
  // Another reading language goes on with the game as played, saved or not.
  play(sameCourse ? carried : loaded!.sessions.continueLast());
}

function title(courses?: { label: string; pick: () => void }[], error?: string) {
  const l = loaded;
  // Lab page: ?screen=N lands on that screen, whatever was saved.
  const asked = lab && l && !courses && !error ? Number.parseInt(new URLSearchParams(location.search).get("screen") ?? "", 10) : NaN;
  if (asked >= 1) return jumpTo(asked);
  if (embeddedJourney() && l && !courses && !error && l.sessions.list().length > 0) return play(l.sessions.continueLast());
  // A book course's first game starts on its story as the page loads: "New game" would be the only choice.
  if (l && !courses && !error && opensOnStory(l.course, l.sessions.list().length > 0)) return play(l.sessions.startNew());
  const t = l?.t ?? Object.assign((id: string) => id, { has: () => false });
  render(
    <Title
      t={t} version={__VERSION__} courses={courses} error={error} hasSave={!!l && l.sessions.list().length > 0}
      onContinue={() => play(l!.sessions.continueLast())} onNew={() => play(l!.sessions.startNew())}
    />,
    root,
  );
}

async function boot() {
  const settings = loadWebSettings(kv);
  speed = settings.speed ?? DEFAULT_SPEED;
  ruby = settings.ruby ?? DEFAULT_RUBY;
  try {
    catalog = await fetchJson<CatalogEntry[]>(`${base}index.json`);
    // The page's course (st-course) until the player picks their own; see pageStart.
    const picked = pageStart(catalog, settings, metaContent(document, "st-course"));
    if ("error" in picked) throw new Error(picked.error);
    if (!picked.ask) {
      use(await load(picked.course, picked.learner), true);
      return title();
    }
    // Several courses and none chosen yet: list them, named in the first course's reading language.
    use(await load(catalog[0], learnerFor(catalog[0], settings.learner)), false);
  } catch {
    // No course text has loaded, so there is no reading language to say this in.
    return title(undefined, "The game could not load. Serve this page from a web server and reload.");
  }
  const labels = courseLabels(catalog, loaded!.t);
  title(
    catalog.map((entry, i) => ({
      label: labels[i].replace(/^\d+\) /, ""),
      pick: async () => {
        try {
          use(await load(entry, learnerFor(entry, settings.learner)), true);
          title();
        } catch {
          title(undefined, loaded!.t("web-load-failed"));
        }
      },
    })),
  );
}
void boot();
