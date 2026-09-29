// Bootstraps the 3D front end: the catalog, then the start flow (start/flow.ts: title, "I speak…",
// "I want to learn…", name, the six words; a returning player with a save skips it) while the town
// loads underneath, the course (courses.ts, loaded and remembered as the browser TUI does),
// storage (same keys as the browser TUI), every scene space (the canal town and the interiors),
// the player, the camera, the overlay, the fly-over of a new game (cutscene.ts), and the frame loop
// that ties walking to core (zones / doors -> goTo through SpaceNav, NPC taps / E -> the scene
// start sequence in game.ts, prompts -> talk / enter / leave / sleep / notebook). Input: keys and
// the touch joystick feed one MoveInput vector (input.ts); clicks and taps go through touch.ts.
// Sound: word clips on the AudioPlayer, music / ambience / effects on the SoundMixer (audio.ts),
// chosen every frame from the phase, the daylight, the space and the player's position. The
// first-steps guide (guide.ts) drives the objective line for the first minutes; wayfinding
// (wayfind.ts, wayview.ts) keeps the objective's target in sight all game long: the 3D marker over
// it (or the door on the way), the screen-edge arrow when it is off screen, the ground path, the
// objective card's step n/N, next step and "Take me there", and a reminder when the player strays.
import * as THREE from "three";
import { cleanName, type CatalogEntry, type Course } from "@silver-tongue/core";
import { decodeSave, encodeSave, sessionLines } from "@silver-tongue/tui";
import { fromLocalStorage, SETTINGS_KEY, type KeyValue } from "@silver-tongue/web-common";
import { COMING_SOON, FALLBACK_UI, NATIVE_NAMES, UI_LOCALES } from "../locale";
import { BARKS } from "../barks";
import { turnToward } from "./anim";
import { BarkPicker, spaceFigures, type Figure } from "./barks";
import {
  ambientFor,
  distanceToPath,
  createAudioPlayer,
  footstep,
  musicFor,
  pickFormat,
  sfxForEvent,
  SoundMixer,
  StrideClock,
  surfaceFor,
  unlockAudioOnGesture,
  waterDistance,
  type AudioPlayer,
  type SoundEntry,
  type SoundPhase,
} from "./audio";
import { JsonFetcher, LateLoad, ModuleLoadError, retrying, StartWatch, WebGLError } from "./boot";
import { CAMERA, CameraRig, outlineScale } from "./camera";
import { PlayerCarry } from "./carry";
import { applyStart, loadCatalog, rememberedStart, resumePick, type Picked } from "./courses";
import { CameraPathPlayer, DollyPath, Letterbox, OrbitPath } from "./cutscene";
import { openSession, type Game, type UiModel } from "./game";
import { GamepadControls, type GamepadHooks, type PadLayout } from "./gamepad";
import { Guide, type GuideStep } from "./guide";
import { MoveInput, toGround } from "./input";
import { deckAt, gridClass, heldProp, LAYOUT, LayoutIndex, STREET, type AssetIndex, type CameraPath, type Stand, type Vec3 } from "./layout";
import { emptyLoad, loadPlan, loadSummary, reduceLoad } from "./loading";
import { Player } from "./player";
import { pickLocale, type RetryAction } from "./preload.js";
import { loadPrefs, savePrefs } from "./prefs";
import { SoundSwitches } from "./sounds";
import { nearestPrompt, promptTargets, SpaceNav, TALK_RANGE, type Arrival, type PromptTarget } from "./spaces";
import type { IntroSource, StartConfig, StartResult } from "./start/flow";
import { clipsFor, courseIntro } from "./start/intro";
import * as startText from "./start/strings";
import { uiLanguage } from "./strings";
import { PointerControls } from "./touch";
import { LoadingScreen } from "./ui/loading";
import { Overlay } from "./ui/overlay";
import type { Insets } from "./ui/viewport";
import { BUILD } from "./version";
import { AssetCache, drawCalls, SceneSpace, setOutlineScale } from "./world";
import { SEE_THROUGH, SeeThroughControl, SeeThroughDetector } from "./seethrough";
import { GuideMarker } from "./marker";
import { daySteps, edgeArrow, findPath, LostTimer, nextSteps, resolveTarget, type PathGrid, type WayTarget } from "./wayfind";
import { EdgeArrowView, PathTrail, spaceGrid } from "./wayview";
import type { WebSessions } from "@silver-tongue/web-common";

// First thing: the page's preloader (preload.js, inlined in index.html) stops treating errors as
// its own, and the LoadingScreen below takes #loading over.
(window as { __stBooted?: boolean }).__stBooted = true;

/**
 * Where courses/<id>/audio/ is, relative to the page (build.mjs): "../" on Pages (the site's shared
 * courses/ folder at the site root), "" when the clips are bundled into this dist/.
 */
declare const __AUDIO_ROOT__: string;
const ASSETS = "./assets"; // relative: the page works under a subpath (GitHub Pages /world3d/)
/** a bark ends when the player walks this far past talk range */
const BARK_LEAVE_M = 1.5;
/** a tap on the ground this close (m) to the great tree's altar rings its bell */
const ALTAR_TAP_M = 2;

// Private windows and blocked site data make localStorage throw: play on without saving.
const noStorage: KeyValue = {
  getItem: () => {
    throw new Error("no storage");
  },
  setItem: () => {
    throw new Error("no storage");
  },
  removeItem: () => {},
  keys: () => [],
};
let kv = noStorage;
try {
  kv = fromLocalStorage(window.localStorage);
} catch {
  // stays noStorage
}

/** `?ui=bn` / `?ui=zh`: the chrome in that UI language whatever the reading language (a preview until such a course exists). */
const uiOverride = new URLSearchParams(location.search).get("ui") ?? undefined;
// The loading screen in the language the preloader picked: ?ui=, the remembered reading language, the browser's.
let settingsJson: string | null = null;
try {
  settingsJson = kv.getItem(SETTINGS_KEY);
} catch {
  // no storage
}
const loading = new LoadingScreen(
  document.querySelector<HTMLElement>("#loading")!,
  "Silver Tongue",
  UI_LOCALES[pickLocale(UI_LOCALES, location.search, settingsJson, navigator.languages ?? [navigator.language], FALLBACK_UI)].loading,
);
/** the loading screen's hold for the start (the town's first views); released at the first frame */
const startHold = loading.hold();
const uiRoot = document.querySelector<HTMLElement>("#ui")!;
const startRoot = document.querySelector<HTMLElement>("#start")!;

// Every wait on the way to the title (boot.ts): each startup step is tracked, so no progress for
// 15 s says "Slow connection", 60 s rejects the steps (aborting what is in flight) into their
// retry loops; every JSON aborts itself after 60 s without a byte; the connection coming back
// presses a failure's Retry once.
/** what a stall also stops or forgets: the GLBs in flight (once the AssetCache exists), the rooms being built */
const onStall: (() => void)[] = [];
const startWatch = new StartWatch({
  slowMs: 15_000,
  failMs: 60_000,
  onSlow: (on) => loading.slow(on),
  onStall: () => {
    json.abortAll();
    for (const f of onStall) f();
  },
});
const json = new JsonFetcher({ fetch: (url, init) => fetch(url, init), stallMs: 60_000, onBytes: () => startWatch.poke() });
window.addEventListener("online", () => loading.online());

/** A step's failure on the loading screen: the message for what went wrong, the error small under it; resolves at Retry. */
function askRetry(e: unknown, action: RetryAction): Promise<void> {
  console.error(e);
  const t = loading.text;
  const message = e instanceof WebGLError ? t.webgl : location.protocol === "file:" ? t.file : t.failed;
  return loading.fail(message, e instanceof Error ? e.message : String(e), action);
}
/**
 * `?promo=1` (README "Promo capture"): a fixed new game ("Mei"), no start flow, no six-words intro,
 * no 5 s fly-over on open (world3d.promo("flyover") plays the full one instead, on demand), the
 * loading screen still hides once the town has loaded, sound still unlocks on the first gesture as
 * always. Never reachable without the flag: normal play is untouched.
 */
const promoMode = new URLSearchParams(location.search).get("promo") === "1";
const prefs = loadPrefs(kv);

// Phones: no pinch / double-tap zoom (iOS ignores user-scalable=no), no pull-to-refresh (page.css
// touch-action / overscroll-behavior); the first gesture unlocks audio.
for (const ev of ["gesturestart", "gesturechange", "dblclick"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

/** Every JSON the page loads (boot.ts JsonFetcher: aborted after 60 s without a byte, its bytes progress for the StartWatch). */
function fetchJson<T>(path: string): Promise<T> {
  return json.get<T>(path);
}

/** The renderer, on the stage; no WebGL: a WebGLError (the loading screen says so). */
function makeRenderer(): THREE.WebGLRenderer {
  let r: THREE.WebGLRenderer;
  try {
    r = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: "high-performance" });
  } catch (e) {
    throw new WebGLError(`WebGL: ${(e as Error)?.message ?? String(e)}`);
  }
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.querySelector("#stage")!.append(r.domElement);
  return r;
}

/** The safe-area insets (notch, home bar) in CSS px, read through a probe padded by env(safe-area-inset-*). */
function safeInsets(): Insets {
  let probe = document.querySelector<HTMLElement>("#safe-probe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "safe-probe";
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

async function main() {
  // The town loads first thing, while the catalog and the start flow run (it needs no course), and
  // only what its first views show (loading.ts loadPlan): the rest streams in after the first frame.
  // A failed try runs again from where it stopped (the renderer, the index and the loaded GLBs kept).
  let load = emptyLoad;
  let madeRenderer: THREE.WebGLRenderer | null = null;
  let madeLayout: LayoutIndex | null = null;
  let madeAssets: AssetCache | null = null;
  const loadWorld = async () => {
    const renderer = (madeRenderer ??= makeRenderer()); // first: no WebGL says so at once
    const L = (madeLayout ??= new LayoutIndex(LAYOUT, await fetchJson<AssetIndex>(`${ASSETS}/index.json`)));
    if (!madeAssets) {
      const a = new AssetCache(ASSETS, L);
      a.onLoad = (e) => {
        load = reduceLoad(load, e);
        startWatch.poke();
        if (loading.visible) loading.render(loadSummary(load));
      };
      onStall.push(() => a.abort());
      madeAssets = a;
    }
    const assets = madeAssets;
    const bagSpec = LAYOUT.player.errandProp;
    const bagAsset = heldProp(bagSpec)?.asset;
    const plan = loadPlan(L, { character: LAYOUT.player.character, errandProp: bagAsset });
    await assets.preload(plan.first);
    // The town: its ground and everything that never moves now; its people stream in (SceneSpace.ready).
    const spaces = new Map<string, SceneSpace>([[STREET, await SceneSpace.create(L, assets, STREET, { stream: true })]]);
    const player = new Player(await assets.actor(LAYOUT.player.character), spaces.get(STREET)!.area);
    // The parcel of an errand, in the player's hands while core has one (state.errand).
    const carry = new PlayerCarry(player.actor, bagAsset ? await assets.instance(bagAsset) : null, bagSpec);
    return { L, renderer, assets, plan, spaces, player, carry };
  };
  /** the town, tried until it loads (never rejects: each failure waits on the loading screen's button) */
  const worldReady = retrying(() => startWatch.track(loadWorld()), askRetry);
  // Music, ambience and effects never hold the start up: their manifest comes in behind
  // (setManifest), on a fetcher of its own (a startup stall doesn't abort it), tried again when the
  // connection comes back and at each gesture until it is in.
  const soundJson = new JsonFetcher({ fetch: (url, init) => fetch(url, init), stallMs: 60_000 });
  const manifest = new LateLoad(() => soundJson.get<SoundEntry[]>(`${ASSETS}/audio/manifest.json`));
  manifest.kick();
  window.addEventListener("online", () => manifest.kick());

  // The catalog first: no reading language to say anything in before it (as tui-web).
  const catalog: CatalogEntry[] = await retrying(() => startWatch.track(loadCatalog(fetchJson)), askRetry);

  // Music, ambience and effects: one mixer for the page; it starts at the first gesture.
  const probe = typeof Audio === "undefined" ? undefined : new Audio();
  const canPlayType = probe ? (m: string) => probe.canPlayType(m) : undefined;
  const mixer = new SoundMixer({
    base: "./",
    manifest: [],
    format: pickFormat(canPlayType),
    canPlayType,
    context: () => {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return Ctx ? new Ctx() : null;
    },
    fetchBytes: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.arrayBuffer();
    },
    musicVolume: prefs.music,
    sfx: prefs.sfx,
    ambience: prefs.ambience,
  });
  manifest.use((m) => mixer.setManifest(m));
  const unlockEvents = ["pointerup", "touchend", "click", "keydown"] as const;
  const unlockMixer = () => {
    manifest.kick();
    if (!mixer.unlocked) mixer.unlock();
    if (mixer.unlocked && manifest.loaded) for (const ev of unlockEvents) window.removeEventListener(ev, unlockMixer, true);
  };
  for (const ev of unlockEvents) window.addEventListener(ev, unlockMixer, true);
  const sfx = (id: string) => mixer.sfx(id);


  // The course: a returning player (a saved game) goes straight in; anyone else runs the start flow.
  const deps = { fetchJson, kv, now: Date.now };
  /** a course the start flow's intro step already fetched and remembered */
  let pendingPick: Picked | null = null;
  /** the start flow is on screen: the world takes no input */
  let startOpen = false;
  /** the word clips for the course being played */
  let audio: AudioPlayer | null = null;
  let audioCourse = "";
  /** The word clips' player for a course (made once per course: it unlocks on the next gesture). */
  const wordAudio = (entry: CatalogEntry) => {
    if (audio && audioCourse === entry.id) return audio;
    audio?.stop();
    audioCourse = entry.id;
    const a = createAudioPlayer({
      base: `${__AUDIO_ROOT__}courses/${entry.id}/audio/`,
      audio: typeof Audio === "undefined" ? undefined : new Audio(),
      wait: (ms, cb) => {
        const h = setTimeout(cb, ms);
        return { cancel: () => clearTimeout(h) };
      },
    });
    unlockAudioOnGesture(a);
    return a;
  };

  /** The barks' clips (assets/audio/barks/<language>/, .ogg or .m4a by canPlayType), one player per course language. */
  let barkPlayer: AudioPlayer | null = null;
  let barkLanguage = "";
  const barkAudio = (language: string): AudioPlayer | null => {
    if (barkLanguage === language) return barkPlayer;
    barkPlayer?.stop();
    barkLanguage = language;
    const ext = pickFormat(canPlayType);
    barkPlayer =
      ext && BARKS[language]
        ? createAudioPlayer(
            {
              base: `${ASSETS}/audio/barks/${language}/`,
              audio: typeof Audio === "undefined" ? undefined : new Audio(),
              wait: (ms, cb) => {
                const h = setTimeout(cb, ms);
                return { cancel: () => clearTimeout(h) };
              },
            },
            { ext },
          )
        : null;
    if (barkPlayer) unlockAudioOnGesture(barkPlayer);
    return barkPlayer;
  };

  /**
   * Mounts the start flow and resolves with its result (the intro step fetches and remembers the
   * course, courses.ts applyStart). `opts.intro` replays the six words only (Settings).
   */
  async function runStartFlow(remembered: StartConfig["remembered"], opts: { introOnly?: StartConfig["intro"] } = {}): Promise<StartResult> {
    startOpen = true;
    move.clear();
    pointers?.reset();
    /** the course the six words are said from */
    let introCourse: Course | null = picked?.course ?? null;
    const intro: IntroSource =
      opts.introOnly ??
      (async (pick) => {
        pendingPick = await applyStart(deps, catalog, pick);
        // The pick's clips play the Listen buttons (the same player goes on into the game).
        audio = wordAudio(pendingPick.entry);
        introCourse = pendingPick.course;
        return courseIntro(pendingPick.course);
      });
    // its own chunk: tracked (a stall says so), and a failed import can only be mended by a reload
    const flowModule = await retrying(
      () =>
        startWatch.track(
          import("./start/flow").catch((e: unknown) => {
            throw new ModuleLoadError(`the start screens didn't load: ${(e as Error)?.message ?? String(e)}`);
          }),
        ),
      askRetry,
    );
    const flow = flowModule.mountStartFlow(startRoot, {
      catalog,
      remembered,
      comingSoon: COMING_SOON,
      intro,
      startAt: opts.introOnly ? "intro" : "title",
      assetBase: `${ASSETS}/ui/title/`,
      uiOverride,
      hooks: {
        sfx,
        music: (id) => mixer.setMusic(id),
        say: (wordId) => {
          const c = introCourse;
          const w = c && courseIntro(c)?.words.find((x) => x.id === wordId);
          if (c && w) audio?.play([{ clips: clipsFor(c, w.text) }]);
        },
      },
    });
    if (!opts.introOnly) mixer.setMusic("owner_theme");
    return flow.result.then((r) => {
      flow.destroy();
      startOpen = false;
      return r;
    });
  }

  /** The start flow until its pick loads: the course played, and the name to give the new game. */
  async function startFlowPick(remembered: StartConfig["remembered"]): Promise<{ picked: Picked; name: string }> {
    for (;;) {
      pendingPick = null;
      const r = await runStartFlow(remembered);
      try {
        const got = pendingPick as Picked | null; // set by the intro step
        const p = got && got.entry.id === r.course && got.course.learner === r.learner ? got : await applyStart(deps, catalog, r);
        return { picked: p, name: r.name };
      } catch (e) {
        console.error("start flow: the course didn't load; choose again", e);
        remembered = { ...remembered, name: r.name };
      }
    }
  }

  // a returning player's course; a failure or a stall: the start flow (choosing there loads it again)
  let picked: Picked | null = promoMode ? null : await startWatch.track(resumePick(deps, catalog)).catch(() => null);
  let startName: string | null = null;
  // move / pointers exist before the flow can reset them (declared below, used by runStartFlow)
  let pointers: PointerControls | undefined;
  const move = new MoveInput();
  // A gamepad works from the start screens on; the game's side of it is filled in once the game exists.
  let padGame: GamepadHooks | null = null;
  let padLabels: PadLayout["labels"] | null = null;
  new GamepadControls(move, {
    scope: () => (startOpen ? startRoot : (padGame?.scope() ?? null)),
    canWalk: () => !startOpen && !!padGame?.canWalk(),
    menu: () => {
      if (!startOpen) padGame?.menu();
    },
    actions: () => (startOpen ? null : (padGame?.actions() ?? null)),
    onUse: (layout) => {
      padLabels = layout.labels;
      if (padGame) padGame.onUse(layout);
      else document.documentElement.classList.add("pad");
    },
  });
  if (promoMode) {
    // ?promo=1: skip the start flow outright (the remembered course / reading language, or the
    // catalog's first), a fixed name so a promo run is the same game every time.
    const remembered = rememberedStart(kv);
    const entry0 = catalog.find((e) => e.id === remembered.course) ?? catalog[0];
    picked = await retrying(() => startWatch.track(applyStart(deps, catalog, { learner: remembered.learner ?? entry0.learners[0], course: entry0.id })), askRetry);
    startName = "Mei";
  } else if (!picked) {
    const r = await startFlowPick({ ...rememberedStart(kv) });
    picked = r.picked;
    startName = r.name;
  }
  let { course, entry } = picked;
  document.documentElement.lang = course.learner;
  audio = wordAudio(entry);

  const world = await worldReady;
  const { L, renderer, assets, plan, spaces, player, carry } = world;
  const street = spaces.get("street")!;
  const rig = new CameraRig(renderer.domElement);

  // Where a tap sent the player: a small ring on the ground.
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  // The guide's marker over its target (an NPC, a door): a floating arrow and a ring, toon style.
  const guideMarker = new GuideMarker();
  let guide = new Guide(course);
  guide.hidden = prefs.guideHidden;
  let guideStep: GuideStep | null = null;
  // Wayfinding: the objective's target here, the ground path to it, the screen-edge arrow, the reminder.
  const trail = new PathTrail();
  const edge = new EdgeArrowView();
  uiRoot.append(edge.node);
  const lost = new LostTimer();
  const grids = new Map<string, PathGrid>();
  let wayTarget: WayTarget | null = null;
  let wayBusy = true;
  let pathKey = "";
  let pathClock = 0;
  let pathDots = 0;
  let stepsKey = "";
  let steps: ReturnType<typeof nextSteps> = [];
  /** "Take me there" on a target in this town: the camera glances at it for a moment */
  let glance = 0;
  /** the HUD's box (for the edge arrow to keep out of), measured with the path, not per frame */
  let hudBox: DOMRect | null = null;
  let hudClock = 0;
  const waterAt = waterDistance(LAYOUT.town.grid);
  const stride = new StrideClock(player.actor.strideM);
  const lastFoot = new THREE.Vector2(player.position.x, player.position.z);
  let rngSeed = Date.now() >>> 0;
  const rng = () => ((rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0) / 4294967296);
  /** the great tree's altar: a tap there rings the bell */
  let altar: [number, number] | null = null;
  try {
    const a = L.point("great_tree", "altar_top");
    altar = [a[0], a[2]];
  } catch {
    altar = null;
  }
  /** where the great tree's bell and willows are heard from (its altar, else the tree), and the pier's deck (boat_creak) */
  const treeBuilding = LAYOUT.town.buildings.find((b) => b.id === "great_tree");
  const treeAt: [number, number] | null = altar ?? (treeBuilding ? [treeBuilding.pos[0], treeBuilding.pos[2]] : null);
  const pierPath = LAYOUT.town.decks.find((d) => d.kind === "pier")?.path ?? null;

  let game: Game | undefined;
  let sessions: WebSessions | undefined;
  let nav = new SpaceNav(L, course.world.start);
  let space = street;
  let sceneNpc: string | null = null;
  let pendingTalk: string | null = null;
  /** a prompt target the player was sent to use (tapped from afar) */
  let pendingUse: string | null = null;
  let arriving: Arrival | null = null;
  let transitioning = false;
  let mixupSeq = 0;
  let prompt: PromptTarget | null = null;
  // Barks (src/barks.ts): everyone outside the course says a line in the course's language.
  const barkBook = (c: Course) => {
    const book = BARKS[c.language.code];
    return book ? new BarkPicker(book, rng) : null;
  };
  let barks = barkBook(course);
  /** the figure (walker, extra, pigeon) whose bark is on screen, and the yaw an extra turns back to */
  let barking: { fig: Figure; homeYaw: number } | null = null;
  /** extras turning back to their own facing after a bark */
  const turningBack: { root: THREE.Object3D; yaw: number }[] = [];
  let figuresFor: { space: string; list: Figure[] } | null = null;
  const barkHead = new THREE.Vector3();
  const figures = (): Figure[] => {
    if (!barks) return [];
    if (figuresFor?.space !== space.id) figuresFor = { space: space.id, list: spaceFigures(L, space.id, barks.book) };
    return figuresFor.list;
  };
  /** A figure's actor in the current space (world.ts builds walkers / extras / scatterers in layout order). */
  // By figure id (world.ts figures: keyed by layout slot, whatever order the actors streamed in).
  const figureActor = (f: Figure) => space.figures.get(f.id)?.actor;
  const figureMotion = (f: Figure) => space.figures.get(f.id)?.motion;
  /** the fly-over while it plays (a new game), with its letterbox */
  let flyover: { path: CameraPathPlayer; bars: Letterbox } | null = null;
  /** the see-through (seethrough.ts): the player and whoever they talk to, never hidden */
  const see = new SeeThroughControl();
  const seeDetector = new SeeThroughDetector(renderer);
  let seeFrame = 0;
  let seeSpace: THREE.Scene | null = null;
  const lastSeePlayer = player.position.clone();
  const seeFocus: (THREE.Vector3 | null | undefined)[] = [null, null];
  /** the fly-over's state for browser checks: playing, done (played out or skipped), null (never played: a loaded save) */
  let flyoverState: "playing" | "done" | null = null;
  /** promo capture only (world3d.promo("hud")): forces every DOM chrome node off (page.css .promo-chrome-off) and the wayfinding marker/trail off (folded into wayBusy below) */
  let promoChromeOff = false;
  /** promo capture only (world3d.promo("orbit" | "dolly")): drives rig.camera in place of CameraRig.update until it reports done */
  let promoCam: OrbitPath | DollyPath | null = null;
  let resolvePromoCam: (() => void) | null = null;

  /** Each interior's build, started once: prefetched after the first frame, or when a door needs it first. */
  const building = new Map<string, Promise<SceneSpace>>();
  // a stall: the rooms on their way are forgotten (a hung one would hold every later door)
  onStall.push(() => building.clear());
  function ensureSpace(id: string): Promise<SceneSpace> {
    const have = spaces.get(id);
    if (have) return Promise.resolve(have);
    let p = building.get(id);
    if (!p) {
      p = SceneSpace.create(L, assets, id).then((s) => {
        spaces.set(id, s);
        return s;
      });
      p.catch(() => building.delete(id)); // a failed room is tried again at the next door
      building.set(id, p);
    }
    return p;
  }
  /** A space ready to go into: at once if it is built, else behind the loading screen (shown after 300 ms). */
  async function openSpace(id: string): Promise<SceneSpace> {
    if (spaces.has(id)) return spaces.get(id)!;
    // the bar counts this room's files (some may be on their way already: the prefetch)
    load = (plan.spaces.find((x) => x.id === id)?.assets ?? []).reduce(
      (st, n) => reduceLoad(reduceLoad(st, { type: "start", name: n, bytes: L.asset(n).bytes }), assets.loaded.has(n) ? { type: "done", name: n } : { type: "progress", name: n, loaded: 0 }),
      emptyLoad,
    );
    loading.render(loadSummary(load));
    const release = loading.hold(300);
    try {
      return await startWatch.track(ensureSpace(id)); // a stall: back where the player was (goInto)
    } finally {
      release();
    }
  }
  /** After the first frame, idle: the town's people are streaming in; then every interior, nearest door first. */
  function prefetch() {
    const idle = (f: () => void) => ((window as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((g: () => void) => setTimeout(g, 200)))(f);
    void (async () => {
      await street.ready.catch(() => {});
      for (const s of plan.spaces) {
        await new Promise<void>((r) => idle(r));
        await ensureSpace(s.id).catch((e: unknown) => console.error(`${s.id}: didn't load`, e));
      }
    })();
  }
  /** Goes into a space at a stand once it is built (a fade when `door`). */
  function goInto(id: string, stand: Stand, door: boolean) {
    transitioning = true;
    player.stop();
    void openSpace(id).then(
      () => {
        if (door)
          overlay.fadeThrough(() => {
            enterSpace(id, stand, true);
            transitioning = false;
          });
        else {
          enterSpace(id, stand);
          transitioning = false;
        }
      },
      (e: unknown) => {
        console.error(e);
        transitioning = false;
      },
    );
  }

  /** Puts the player (and the markers) into a built space at a stand; `door`: walked there (a door's sound). */
  function enterSpace(id: string, stand: Stand, door = false) {
    const next = spaces.get(id)!;
    // Through a door: it opens going in, and closes behind you coming out.
    if (door && next !== space && next.layout.interior !== space.layout.interior) sfx(next.layout.interior ? "door_open" : "door_close");
    releaseBark(); // the bark itself ends next frame (updateBark: its speaker isn't in this space)
    space.scene.remove(player.root, marker, guideMarker.root, trail.mesh);
    space = next;
    space.scene.add(player.root, marker, guideMarker.root, trail.mesh);
    pathKey = "";
    glance = 0;
    player.area = space.area;
    player.place(stand.pos[0], stand.pos[2], new THREE.Vector3(...stand.facing));
    lastFoot.set(stand.pos[0], stand.pos[2]);
    rig.setDistance(space.layout.camera.distance);
    rig.snap(player.position);
    marker.visible = false;
    pendingTalk = null;
    pendingUse = null;
    applyDaylight();
  }

  function applyDaylight() {
    if (!game) return;
    const h = game.model.hud;
    space.setDaylight(h.slots ? h.slot / h.slots : 0);
  }

  /** The chrome's UI language for a course: its reading language (or `?ui=`). */
  const uiFor = (c: Course) => uiLanguage(uiOverride ?? c.learner);

  /** Makes a loaded course the page's (the start flow's pick, Settings): its text, clips and guide. */
  function useCourse(p: Picked) {
    ({ course, entry } = p);
    picked = p;
    document.documentElement.lang = course.learner;
    audio = wordAudio(entry);
    overlay.setCourse(course);
    overlay.lang = uiFor(course);
    guide = new Guide(course);
    guide.hidden = prefs.guideHidden;
    barks = barkBook(course);
    figuresFor = null;
  }

  /** The four sound switches (sounds.ts), each on its own bus: music, voices (core's setSound), effects, ambience. */
  const sounds = new SoundSwitches(prefs, () => savePrefs(kv, prefs), {
    musicVolume: (v) => mixer.setMusicVolume(v),
    voice: (on) => {
      // game.ts also reads prefs.voice (GameOptions.voice): a course without clips can't follow setSound
      if (!on) {
        audio?.stop();
        barkPlayer?.stop();
      }
      if (game && game.model.hud.sound !== "none" && (game.model.hud.sound === "on") !== on) game.setSound(on);
    },
    sfx: (on) => mixer.setSfx(on),
    ambience: (on) => mixer.setAmbience(on),
  });

  /** A language's name for the Settings lists, in the chrome's language. */
  const languageName = (code: string) => {
    const ui = uiFor(course);
    return startText.has(ui, `lang.${code}`) ? startText.t(ui, `lang.${code}`) : (NATIVE_NAMES[code] ?? code);
  };

  const overlay = new Overlay(uiRoot, course, {
    // The current game stays saved (it is listed under the same keys the browser TUI uses). A new
    // game runs the start flow again (the choices so far preselected), then flies over the town.
    onNewGame: () => {
      if (!game || !window.confirm(game.s("new-game-confirm"))) return;
      void (async () => {
        const r = await startFlowPick({ learner: course.learner, course: course.id, name: game?.core.state.player ?? "" });
        if (r.picked.course !== course) useCourse(r.picked);
        boot({ fresh: true, name: r.name });
      })();
    },
    games: () => {
      if (!sessions || !game) return [];
      const list = sessions.list();
      const lines = sessionLines(list, course, game.t, (ms) => new Date(ms).toLocaleString());
      return list.map((s, i) => ({ label: lines[i].replace(/^\d+\) /, ""), open: () => boot({ id: s.id }) }));
    },
    exportLine: async () => (game ? encodeSave(game.core.state) : ""),
    importLine: async (line) => {
      if (!game || !sessions) return null;
      const decoded = await decodeSave(line, course);
      if (!decoded.ok) return game.t("import-bad", { reason: decoded.reason });
      const id = sessions.add(decoded.state);
      if (!id) return game.t("notice-read-only");
      boot({ id });
      return null;
    },
    onPrompt: () => {
      if (prompt) use(prompt);
    },
    sfx,
    music: { on: () => sounds.musicOn, tap: () => sounds.tapMusic() },
    guide: {
      hidden: () => guide.hidden,
      // Offered all game: past the first steps it still quiets wayfinding's "lost?" reminder.
      active: () => !!game,
      setHidden: (on) => {
        guide.hidden = on;
        prefs.guideHidden = on;
        savePrefs(kv, prefs);
      },
    },
    way: {
      takeMeThere: () => {
        const g = game?.model.objective.goal;
        if (!game || !g || game.model.mode !== "explore" || transitioning) return;
        // A travel-only place (warehouse, school, hospital): the Go to… list's fast travel there.
        if (g.kind === "npc" && L.travelOnly(g.place) && game.core.state.place !== g.place) return game.enterPlace(g.place);
        guideMarker.pulse();
        glance = 1.6;
      },
      pathShown: () => !prefs.pathHidden,
      setPathShown: (on) => {
        prefs.pathHidden = !on;
        savePrefs(kv, prefs);
        pathKey = "";
      },
    },
    settings: {
      current: () => ({
        learners: entry.learners.map((code) => ({ code, label: entry.learnerNames[code] ?? NATIVE_NAMES[code] ?? code })),
        learner: course.learner,
        courses: [
          ...catalog.map((e) => ({ id: e.id, label: languageName(e.language) })),
          ...COMING_SOON.filter((l) => !catalog.some((e) => e.language === l)).map((l) => ({ id: `soon:${l}`, label: languageName(l), soon: true })),
        ],
        course: course.id,
        name: game?.core.state.player ?? "",
        voice: prefs.voice,
        sfx: prefs.sfx,
        ambience: prefs.ambience,
        music: prefs.music,
        ambienceFull: prefs.ambienceFull,
      }),
      // As tui-web's switchTo: another reading language goes on with the game as played (its
      // save is the course's, whatever the reading language); another course plays its last game.
      switchTo: async (id, learner) => {
        let p: Picked;
        try {
          p = await applyStart(deps, catalog, { course: id, learner });
        } catch {
          return game?.s("settings-switch-failed") ?? "";
        }
        useCourse(p);
        boot({});
        return null;
      },
      setName: (name) => {
        if (!game) return null;
        return cleanName(name) && game.setName(name) ? null : game.s("settings-name-bad");
      },
      setMusic: (v) => sounds.setMusic(v),
      setVoice: (on) => sounds.setVoice(on),
      setSfx: (on) => sounds.setSfx(on),
      setAmbience: (on) => sounds.setAmbience(on),
      setAmbienceFull: (on) => {
        prefs.ambienceFull = on;
        savePrefs(kv, prefs);
      },
      replayIntro: () => {
        const intro = courseIntro(course);
        if (intro) void runStartFlow({ learner: course.learner, course: course.id, name: game?.core.state.player ?? "" }, { introOnly: intro });
      },
    },
  });
  overlay.lang = uiFor(course);

  /** World side of the model: the space for core's place, the scene lock and walk to the talk stand, talk / shrug clips, daylight. */
  function syncWorld(m: UiModel) {
    if (!game) return;
    // Core moved the player to a place another space shows, or to one this space shows elsewhere
    // (the Go to list): swap scenes / move them behind a fade (next frame, not inside core's dispatch).
    const arrival = nav.sync(game.core.state.place, { x: player.position.x, z: player.position.z });
    if (arrival) arriving = arrival;
    applyDaylight();
    carry.sync(m.hud.errand);
    if (m.mixups && m.mixups.seq !== mixupSeq) {
      mixupSeq = m.mixups.seq;
      space.shrug(m.mixups.npc);
    }
    // The scene's NPC talks while their line is on screen (the player stays on idle).
    // A story NPC with nothing to talk about barks: they talk too.
    space.setTalking(m.scene && m.bubble?.npc === m.scene.npc ? m.scene.npc : m.bark && space.npcs.has(m.bark.id) ? m.bark.id : null);
    if (barking && m.bark?.id !== barking.fig.id) releaseBark();
    const npc = m.scene?.npc ?? null;
    if (npc === sceneNpc) return;
    sceneNpc = npc;
    pendingTalk = null;
    player.locked = !!npc;
    if (npc && space.npcs.has(npc)) {
      const stand = L.talkStand(npc);
      const at = L.npcStand(npc).pos;
      const face = new THREE.Vector3(at[0] - stand.pos[0], 0, at[2] - stand.pos[2]);
      player.walkTo(stand.pos[0], stand.pos[2], { face, scripted: true });
      marker.visible = false;
    }
  }

  /** Opens a game (new, chosen, or the last played); `name`: the start flow's, given to a new game. */
  function boot(opts: { fresh?: boolean; id?: string; name?: string }) {
    if (!flyover) flyoverState = null;
    sceneNpc = null;
    releaseBark();
    pendingTalk = null;
    pendingUse = null;
    arriving = null;
    player.locked = false;
    audio?.stop();
    let ready = false; // the first render happens once the overlay has this game
    const opened = openSession(course, kv, {
      now: Date.now,
      fresh: opts.fresh,
      id: opts.id,
      audio: audio ?? undefined,
      ui: uiFor(course),
      barks: barks ?? undefined,
      barkAudio: (barks && barkAudio(barks.book.language)) ?? undefined,
      voice: () => prefs.voice,
      onChange: (m) => {
        if (!ready) return;
        overlay.render(m);
        syncWorld(m);
      },
      // Game events with a sound: a scene done, a mix-up, money paid or earned.
      onEvent: (e) => {
        const id = ready ? sfxForEvent(e) : null;
        if (id) sfx(id);
      },
    });
    game = opened.game;
    // The start flow's name (core cleanName rules, saved with the game as the name dialog's was).
    if (opts.name && course.needsName && !game.core.state.player) game.setName(opts.name);
    // The voice switch holds across games: a save made with the word clips off follows prefs.voice.
    if (game.model.hud.sound !== "none" && (game.model.hud.sound === "on") !== prefs.voice) game.setSound(prefs.voice);
    sessions = opened.sessions;
    mixupSeq = game.model.mixups?.seq ?? 0;
    // A save made inside the noodle shop resumes inside it.
    nav = new SpaceNav(L, game.core.state.place);
    const start = nav.jump(game.core.state.place);
    // A save inside a room whose build hasn't landed yet: it goes in as soon as it has.
    if (spaces.has(start.space)) enterSpace(start.space, start.stand);
    else goInto(start.space, start.stand, false);
    ready = true;
    // A new game opens with the fly-over over the town; a loaded save starts straight in. The
    // overlay is held first, so the name dialog waits for the end of it. Promo capture (?promo=1):
    // never (world3d.promo("flyover") plays the full one instead, on demand).
    const fly = game.fresh && start.space === STREET && !promoMode;
    if (fly) overlay.hold(true);
    overlay.setGame(game);
    syncWorld(game.model);
    if (fly) playFlyover();
    else endFlyover();
  }

  /**
   * The fly-over: the overlay waits under the letterbox; any tap, click or key skips it. Promo
   * capture (world3d.promo("flyover")) reuses this with the full canonical path and `skippable:
   * false` (bars with no hint, no tap / click / key skip: a recording tool's stray input mustn't cut
   * the trailer's fly-over short).
   */
  function playFlyover(path: CameraPath = LAYOUT.town.camera, skippable = true) {
    if (flyover) return;
    if (!path.keys.length) return overlay.hold(false);
    const touch = overlay.touch || !!window.matchMedia?.("(pointer: coarse)").matches;
    const hint = skippable ? game!.s(touch ? "cutscene-skip" : "cutscene-skip-key") : "";
    const bars = new Letterbox(
      document.body,
      hint,
      () => {
        sfx("cutscene_skip");
        flyover?.path.skip();
      },
      skippable,
    );
    flyover = { path: new CameraPathPlayer(path), bars };
    flyoverState = "playing";
    overlay.hold(true);
    move.clear();
    pointers?.reset();
  }

  /** Hands over to the game camera at the player (the path's last key is that very pose, so no jump). */
  function endFlyover() {
    if (!flyover) return;
    flyover.bars.close();
    flyover = null;
    flyoverState = "done";
    overlay.hold(false);
    rig.snap(player.position);
  }

  const flat = (a: THREE.Vector3, p: number[]) => Math.hypot(a.x - p[0], a.z - p[2]);

  /**
   * Tap on an NPC / E: talk if close, else walk to where you talk to them and talk on arrival.
   * Someone at a travel-only place's spot (Big Liu on the pier) takes you to that place first.
   */
  function requestTalk(npc: string) {
    if (!game || game.model.scene || game.model.mode !== "explore" || !space.npcs.has(npc)) return;
    const npcPos = L.npcStand(npc).pos;
    const stand = L.talkStand(npc);
    if (flat(player.position, npcPos) <= TALK_RANGE || flat(player.position, stand.pos) <= 1.2) {
      talkHere(npc);
      return;
    }
    const face = new THREE.Vector3(npcPos[0] - stand.pos[0], 0, npcPos[2] - stand.pos[2]);
    player.walkTo(stand.pos[0], stand.pos[2], { face, arrive: () => (pendingTalk = npc) });
    showMarker(stand.pos[0], stand.pos[2]);
  }

  /** Talks to an NPC the player is next to; one at a travel-only place's spot (Big Liu on the pier) takes the player to that place first. */
  function talkHere(npc: string) {
    if (!game) return;
    const home = course.world.npcs[npc]?.place;
    if (home && home !== game.core.state.place && L.travelOnly(home)) game.enterPlace(home);
    game.talkTo(npc);
  }

  /** Uses a prompt target: talk, go through a door, leave, sleep, read the notebook. */
  function use(t: PromptTarget) {
    if (!game || game.model.mode !== "explore" || transitioning) return;
    pendingUse = null;
    if (t.kind === "talk") return requestTalk(t.ref);
    if (t.kind === "bark") return startBark(t.ref);
    if (t.kind === "enter" || t.kind === "exit") return game.enterPlace(t.ref);
    if (t.kind === "sleep") return game.sleep();
    if (t.kind === "notebook") return overlay.openNotebook();
  }

  function targets(): PromptTarget[] {
    return [...promptTargets(L, nav.space, !!game?.model.canSleep), ...barkTargets()];
  }

  /** Everyone here who barks, where they are now (walkers walk, pigeons scatter); the prompt floats over their head. */
  function barkTargets(): PromptTarget[] {
    const out: PromptTarget[] = [];
    for (const f of figures()) {
      const a = figureActor(f);
      if (!a) continue;
      const p = a.root.position;
      const top = a.headTop(barkHead).y;
      out.push({ id: f.id, kind: "bark", ref: f.id, at: [p.x, top + 0.45, p.z], range: TALK_RANGE });
    }
    return out;
  }

  /**
   * Talks to a figure outside the course: it stops (a walker leaves its path, a pigeon stays put)
   * and turns to the player, who turns to it; its line, reading, meaning and clip (game.bark). The
   * first bark of all brings the guide's one-off note.
   */
  function startBark(id: string) {
    if (!game || !barks || game.model.scene || game.model.mode !== "explore") return;
    const f = figures().find((x) => x.id === id);
    const a = f && figureActor(f);
    if (!f || !a) return;
    releaseBark();
    const { line } = barks.pick(f.role);
    let hint: string | undefined;
    if (!prefs.barkHint && !guide.hidden && guide.active(game.core.state)) {
      hint = game.s("bark-hint", { native: languageName(uiFor(course)) });
      prefs.barkHint = true;
      savePrefs(kv, prefs);
    }
    barking = { fig: f, homeYaw: a.root.rotation.y };
    const m = figureMotion(f);
    if (m) m.held = true;
    a.talking = true;
    const i = turningBack.findIndex((x) => x.root === a.root);
    if (i >= 0) {
      barking.homeYaw = turningBack[i].yaw;
      turningBack.splice(i, 1);
    }
    player.faceToward(a.root.position.x, a.root.position.z);
    game.bark({ id: f.id, name: game.s(`role-${f.role}`), role: f.role }, line, hint);
  }

  /** Lets the figure of the bark go: a walker walks on, a pigeon may scatter again, an extra turns back. */
  function releaseBark() {
    if (!barking) return;
    const { fig, homeYaw } = barking;
    barking = null;
    const a = figureActor(fig);
    const m = figureMotion(fig);
    if (m) m.held = false;
    if (a) {
      a.talking = false;
      if (fig.kind === "extra") turningBack.push({ root: a.root, yaw: homeYaw });
    }
  }

  function promptLabel(t: PromptTarget): string {
    const { s } = game!;
    const placeName = (p: string) => game!.t(`place-${p}`);
    if (t.kind === "talk") return s("prompt-talk", { npc: game!.npcName(t.ref) });
    if (t.kind === "bark") return s("prompt-talk", { npc: s(`role-${figures().find((f) => f.id === t.ref)?.role ?? "passerby"}`) });
    // A door into a side street (the gate to Station Road) is a way to go, not a building to enter.
    if (t.kind === "enter") return s(L.space(L.spaceOf(t.ref)).interior ? "prompt-enter" : "prompt-go", { place: placeName(t.ref) });
    if (t.kind === "exit") return s("prompt-exit", { place: placeName(t.ref) });
    if (t.kind === "sleep") return s("prompt-sleep");
    return s("prompt-notebook");
  }

  function showMarker(x: number, z: number) {
    marker.position.set(x, space.area.heightAt(x, z) + 0.02, z);
    marker.visible = true;
  }

  /** A tap / click on the canvas (touch.ts told it from a joystick drag): talk to an NPC, use a thing, or walk there. */
  function tap(cx: number, cy: number) {
    if (!game || overlay.blocking || transitioning || startOpen) return;
    // A bark on screen: a tap anywhere closes it.
    if (game.model.bark) return game.endBark();
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const hit = space.pick(ndc, rig.camera);
    if (!hit) return;
    if ("npc" in hit) return requestTalk(hit.npc);
    if (player.locked) return;
    pendingTalk = null;
    // A walker, extra or pet: its bark, by the prompt's range rule (next to it: now; else walk up to it first).
    if ("target" in hit || "figure" in hit) {
      const t = "figure" in hit ? barkTargets().find((x) => x.ref === hit.figure) : targets().find((x) => x.id === hit.target);
      if (!t) return;
      const near = nearestPrompt(L, nav.space, [t], player.position.x, player.position.z);
      if (near) return use(near);
      pendingUse = t.id;
      player.walkTo(t.at[0], t.at[2]);
      showMarker(t.at[0], t.at[2]);
      return;
    }
    pendingUse = null;
    // The great tree's altar: its bell rings (the player walks up to it as to any spot).
    if (altar && nav.space === STREET && Math.hypot(hit.ground.x - altar[0], hit.ground.z - altar[1]) <= ALTAR_TAP_M) sfx("bell_temple");
    player.walkTo(hit.ground.x, hit.ground.z);
    showMarker(hit.ground.x, hit.ground.z);
  }

  // The one movement input (`move`, made before the start flow): keys and the touch joystick write it, the frame loop reads it.
  const canvas = renderer.domElement;
  pointers = new PointerControls(canvas, uiRoot, move, {
    onTap: tap,
    enabled: () => !!game && !overlay.blocking && !transitioning && !flyover && !startOpen,
    stickZone: () => overlay.screen.stickZone,
    onTouch: () => overlay.setTouch(),
  });
  if (window.matchMedia?.("(pointer: coarse)").matches) overlay.setTouch();
  const padFree = () => !!game && !overlay.blocking && !transitioning && !flyover;
  padGame = {
    scope: () => (flyover ? null : overlay.padScope()),
    canWalk: padFree,
    menu: () => {
      if (padFree()) overlay.openMenu();
    },
    actions: () => (padFree() ? overlay.actionBar : null),
    onUse: (layout) => overlay.setPad(layout.labels),
  };
  if (padLabels) overlay.setPad(padLabels);
  // Keys or a mouse again: their hints back.
  const offPad = () => {
    padLabels = null;
    overlay.setPad(null);
  };
  window.addEventListener("keydown", (e) => e.isTrusted && offPad(), true);
  window.addEventListener("pointerdown", (e) => e.pointerType === "mouse" && offPad(), true);

  // Keys: overlay first (replies, lists, notebook), then walking and E.
  window.addEventListener("keydown", (e) => {
    if (!game || flyover || startOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (overlay.key(e)) return e.preventDefault();
    if (overlay.blocking) return;
    if (move.press(e.key)) e.preventDefault();
    else if (e.key.toLowerCase() === "e" && prompt) use(prompt);
  });
  window.addEventListener("keyup", (e) => move.release(e.key));
  window.addEventListener("blur", () => {
    move.clear();
    pointers?.reset();
  });

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(Math.min(dpr, 2)); // cap: phones at 3x fill 2.25x the pixels for little gain
    renderer.setSize(w, h);
    overlay.layout(w, h, safeInsets());
    rig.resize(w, h, overlay.screen.compact);
    setOutlineScale(outlineScale(dpr, overlay.screen.compact));
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 120)); // some browsers report the old size first
  resize();

  // A start-flow pick plays a new game under that name (a first one, or after a "New game");
  // a returning player's last game resumes.
  boot(startName !== null ? { fresh: true, name: startName } : {});
  startHold();
  prefetch();

  const clock = new THREE.Clock();
  const dir = new THREE.Vector2();
  const focus = new THREE.Vector3();
  const head = new THREE.Vector3();
  const project = (p: THREE.Vector3) => {
    const v = p.clone().project(rig.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight, visible: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
  };
  const still = new THREE.Vector2();

  /** Music and ambience for this moment (audio.ts musicFor / ambientFor); the mixer acts on changes only. */
  function updateSound() {
    const phase: SoundPhase = startOpen ? "title" : flyover ? "cutscene" : "game";
    const h = game?.model.hud;
    const scene = {
      phase,
      daylight: h && h.slots ? h.slot / h.slots : 0,
      interior: space.layout.interior,
      place: game?.core.state.place,
      waterDistance: nav.space === STREET ? waterAt(player.position.x, player.position.z) : Infinity,
      treeDistance: nav.space === STREET && treeAt ? Math.hypot(player.position.x - treeAt[0], player.position.z - treeAt[1]) : Infinity,
      pierDistance: nav.space === STREET && pierPath ? distanceToPath(pierPath, player.position.x, player.position.z) : Infinity,
    };
    // The start flow starts owner_theme on the first tap; a replayed intro keeps that same source running.
    if (!startOpen || !game) {
      const m = musicFor(scene);
      mixer.setMusic(m.track, m.gain);
    }
    mixer.setAmbient(ambientFor(scene, prefs.ambienceFull));
  }

  /** Footsteps in step with the walk clip, by the surface underfoot. Off for now (player's request, 2026-09-27); the clips stay for a later, softer set. */
  const FOOTSTEPS = false;
  function updateFootsteps() {
    if (!FOOTSTEPS) return;
    const p = player.position;
    const moved = Math.hypot(p.x - lastFoot.x, p.z - lastFoot.y);
    lastFoot.set(p.x, p.z);
    if (moved < 1e-4 || moved > 2 || transitioning || flyover) return stride.reset();
    const n = stride.advance(moved);
    if (!n) return;
    const town = nav.space === STREET;
    const deck = town ? deckAt(LAYOUT.town.decks, p.x, p.z) : null;
    const surface = surfaceFor({ gridClass: town ? gridClass(LAYOUT.town.grid, p.x, p.z) : 0, deck: deck?.deck ?? null, interior: space.layout.interior });
    const f = footstep(surface, rng);
    mixer.sfx(f.id, { rate: f.rate, gain: 0.55 });
  }

  /** The guide's step (objective line) for the first minutes; wayfinding's target, marker, card, path and reminder all game. */
  function updateGuide(dt: number) {
    guideStep = null;
    if (game && !flyover && !startOpen) {
      const scene = course.scenes.find((x) => x.id === game!.model.objective.scene);
      const near = !!scene && space.npcs.has(scene.npc) && flat(player.position, L.npcStand(scene.npc).pos) <= TALK_RANGE + 0.5;
      guideStep = guide.step(game.core.state, { scene: scene?.id, near }, game.t, game.s);
    }
    overlay.setGuide(guideStep);
    updateWayfinding(dt);
  }

  /**
   * The objective's target in this space (wayfind.ts resolveTarget; the guide's steps point at the
   * same one): the marker over it, the card's step n/N and next step, the ground path (2x a second,
   * or at once on a new target), the "lost?" reminder. Nothing during the fly-over, a scene, a
   * dialog, a bark (src/barks.ts: standing talking is not being lost) or a space change.
   */
  function updateWayfinding(dt: number) {
    const st = game?.core.state;
    wayBusy = !game || !st || !!flyover || startOpen || transitioning || overlay.blocking || game.model.mode !== "explore" || !!st.run || !!game.model.bark || promoChromeOff;
    const o = game?.model.objective;
    wayTarget = !wayBusy && st ? resolveTarget(L, o?.goal, nav.space, st.place) : null;
    const at = wayTarget ? new THREE.Vector3(...wayTarget.at) : null;
    guideMarker.update(dt, at);
    // The card: step n/N today, the next step (recomputed when core state moves), Take me there.
    if (game && st) {
      const key = `${st.log.length}|${st.place}|${st.slot}|${st.day}|${st.run?.scene ?? ""}|${st.player ?? ""}|${game.model.objective.text}`;
      if (key !== stepsKey) {
        stepsKey = key;
        steps = nextSteps(course, st, game.t, game.s, course.needsName);
      }
      overlay.setWay({ step: daySteps(course, st), next: steps[1]?.text, take: !!o?.goal && game.model.mode === "explore" && !st.run });
    } else overlay.setWay(null);
    const dist = wayTarget ? flat(player.position, wayTarget.at) : null;
    if (game && o && lost.update(dt, dist, wayBusy) && !guide.hidden) overlay.notify(game.s("way-lost", { text: o.text }));
    if (!wayTarget) {
      trail.hide();
      edge.update(null, "");
      pathKey = "";
      return;
    }
    hudClock -= dt;
    if (hudClock <= 0) {
      hudClock = 0.5;
      hudBox = overlay.hudRect();
    }
    // The ground path: not within 3 m of where it ends (a door across the room needs none).
    const walkDist = Math.hypot(player.position.x - wayTarget.walk[0], player.position.z - wayTarget.walk[1]);
    if (prefs.pathHidden || walkDist < 3) {
      trail.hide();
      pathDots = 0;
      return;
    }
    pathClock -= dt;
    const key = `${nav.space}|${wayTarget.kind}|${wayTarget.ref}`;
    if (key === pathKey && pathClock > 0) return;
    pathKey = key;
    pathClock = 0.5;
    let grid = grids.get(space.id);
    if (!grid) grids.set(space.id, (grid = spaceGrid(space)));
    const path = findPath(grid, [player.position.x, player.position.z], wayTarget.walk);
    trail.set(path, (x, z) => space.area.heightAt(x, z));
    pathDots = trail.mesh.visible ? trail.mesh.geometry.drawRange.count / 6 : 0;
  }

  const clip = new THREE.Vector4();
  /** The screen-edge arrow at the target when it is off screen (one projection a frame; transforms only). */
  function updateEdge() {
    if (!wayTarget || wayBusy || !game) return edge.update(null, "");
    const [x, y, z] = wayTarget.at;
    clip.set(x, y + 1.2, z, 1).applyMatrix4(rig.camera.matrixWorldInverse).applyMatrix4(rig.camera.projectionMatrix);
    const view = { w: window.innerWidth, h: window.innerHeight };
    const safe = overlay.screen.safe;
    const pad = 46;
    const inset = { top: safe.y + pad, left: safe.x + pad, right: view.w - safe.x - safe.w + pad, bottom: view.h - safe.y - safe.h + pad + 18 };
    let a = edgeArrow(clip, view, inset);
    // Under the HUD card: along the same line, below it.
    if (!a.onScreen && hudBox && a.x < hudBox.right + 24 && a.y < hudBox.bottom + 24) a = edgeArrow(clip, view, { ...inset, top: Math.max(inset.top, hudBox.bottom + 30) });
    const t = wayTarget;
    const name = t.kind === "npc" ? game.npcName(t.ref) : t.kind === "bed" ? game.s("way-bed") : game.t(`place-${t.ref}`);
    edge.update(a, game.s("way-distance", { name, m: Math.round(flat(player.position, t.at)) }));
  }

  /** Per frame: an extra being talked to turns to the player (walkers and pigeons do in streetlife.ts); walking off ends the bark; extras turn back after. */
  function updateBark(dt: number) {
    const b = game?.model.bark;
    if (barking && b?.id === barking.fig.id) {
      const a = figureActor(barking.fig);
      if (a) {
        const dx = player.position.x - a.root.position.x;
        const dz = player.position.z - a.root.position.z;
        if (barking.fig.kind === "extra" && Math.hypot(dx, dz) > 1e-3) a.root.rotation.y = turnToward(a.root.rotation.y, Math.atan2(dx, dz), 5 * dt);
        if (Math.hypot(dx, dz) > TALK_RANGE + BARK_LEAVE_M) game!.endBark();
      }
    } else if (b && space.npcs.has(b.id)) {
      const n = L.npcStand(b.id).pos;
      if (flat(player.position, n) > TALK_RANGE + BARK_LEAVE_M) game!.endBark();
    } else if (b) game!.endBark(); // its speaker isn't here any more (through a door)
    for (let i = turningBack.length - 1; i >= 0; i--) {
      const t = turningBack[i];
      t.root.rotation.y = turnToward(t.root.rotation.y, t.yaw, 5 * dt);
      if (Math.abs(t.root.rotation.y - t.yaw) < 1e-3) turningBack.splice(i, 1);
    }
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    updateSound();
    if (!game) return;
    seeDetector.poll();
    updateGuide(dt);
    updateFootsteps();
    // The fly-over: the camera on its path, the town living (walkers, pets, NPCs), the player idle at the spawn.
    if (flyover) {
      const done = flyover.path.update(dt, rig.camera, rig.fov / CAMERA.fovDeg);
      player.update(dt, still);
      space.update(dt, player.position, null);
      if (done) endFlyover();
      else {
        see.update(dt, [], space.occluders, [], false); // everything opaque on the fly-over
        return renderer.render(space.scene, rig.camera);
      }
    }
    // A place change into another space: fade, swap, fade back.
    if (arriving && !transitioning) {
      const a = arriving;
      arriving = null;
      goInto(a.space, a.stand, true);
    }
    // keys / joystick: one screen-space vector onto the ground; held movement cancels a tap's errand
    const held = transitioning ? { x: 0, y: 0 } : move.vector();
    const g = toGround(held, rig.groundAxes());
    dir.set(g.x, g.y);
    if (move.active && !player.locked) {
      pendingTalk = null;
      pendingUse = null;
    }
    if (sceneNpc && space.npcs.has(sceneNpc) && !player.walking) {
      const n = L.npcStand(sceneNpc).pos;
      player.faceToward(n[0], n[2]); // in a scene the player faces the NPC, the NPC the player
    }
    player.update(dt, dir);
    space.update(dt, player.position, sceneNpc);
    if (!player.walking) marker.visible = false;
    updateBark(dt);

    // Walking into a zone / door / an interior's open front is going there (edge-triggered, see spaces.ts).
    const free = !player.locked && !transitioning && game.model.mode === "explore" && !overlay.blocking;
    if (free) {
      const go = nav.step(dt, player.position.x, player.position.z);
      if (go) game.enterPlace(go);
    }
    if (pendingTalk) {
      const npc = pendingTalk;
      pendingTalk = null;
      talkHere(npc);
    }

    // The one prompt: the nearest thing to use in range.
    prompt = free && !game.model.bark ? nearestPrompt(L, nav.space, targets(), player.position.x, player.position.z) : null;
    if (prompt && pendingUse === prompt.id) use(prompt);
    else if (pendingUse && !player.walking) pendingUse = null;
    if (prompt) {
      const p = project(new THREE.Vector3(...prompt.at));
      overlay.setPrompt(prompt.id, promptLabel(prompt), p.x, p.y, p.visible);
    } else overlay.setPrompt(null, "", 0, 0, false);

    // Camera: the player, or player + NPC during a scene.
    focus.copy(player.position);
    if (sceneNpc && space.npcs.has(sceneNpc)) {
      const n = L.npcStand(sceneNpc).pos;
      focus.set((focus.x + n[0]) / 2, (focus.y + n[1]) / 2, (focus.z + n[2]) / 2);
    }
    // "Take me there": a short glance at the target (walking takes the camera back at once).
    if (glance > 0) {
      glance = move.active || !wayTarget || sceneNpc ? 0 : glance - dt;
      if (glance > 0 && wayTarget) focus.set(...wayTarget.at);
    }
    // Promo capture (world3d.promo("orbit" | "dolly")): the camera runs on its own path in place of
    // the follow-cam until it reports done, then the rig snaps back to the player at once.
    if (promoCam) {
      if (promoCam.update(dt, rig.camera)) {
        promoCam = null;
        rig.snap(player.position);
        resolvePromoCam?.();
        resolvePromoCam = null;
      }
    } else rig.update(dt, focus, !!sceneNpc);
    updateEdge();
    // See-through: whole static objects blocking the player, NPC in a scene, or barking figure.
    seeFocus[0] = player.position;
    seeFocus[1] = sceneNpc ? space.npcs.get(sceneNpc)?.actor.root.position : barking ? figureActor(barking.fig)?.root.position : null;
    if (seeSpace !== space.scene || lastSeePlayer.distanceToSquared(player.position) > 4) {
      seeSpace = space.scene;
      see.reset();
      seeDetector.invalidate();
      seeFrame = 0;
    }
    lastSeePlayer.copy(player.position);
    if (see.on) {
      const due = seeFrame++ % 2 === 0;
      for (const [slot, p] of seeFocus.entries()) {
        if (!p) continue;
        if (due) seeDetector.sample(space.scene, rig.camera, p, slot);
        else seeDetector.skip(slot);
      }
    }
    // current(): per focus, a fresh result or the last one while unmoved, else null (no evidence:
    // a result reused while a newer pass is unresolved never extends a hold). Coverage is judged
    // per focus against that focus's own silhouette.
    const seeSamples = seeFocus.map((p, slot) => {
      if (p) return seeDetector.current(slot);
      seeDetector.invalidateSlot(slot);
      return null;
    });
    see.update(dt, seeFocus, space.occluders, seeSamples);

    // Speech bubble on the speaker's head: a scene started from the topic picker (or any NPC the
    // current space doesn't have, e.g. mid space-swap) can leave the actor lookup empty for a frame
    // or more; re-pin top-centre then instead of freezing wherever the bubble last was (placeBubble
    // also tolerates this directly: a missing area/size/position never throws).
    const npc = overlay.bubble.npc;
    if (npc) {
      const talker = barking?.fig.id === npc ? figureActor(barking.fig) : undefined;
      const found = talker ? !!talker.headTop(head) : !!space.head(npc, head);
      if (found) head.y += 0.25;
      const p = found ? project(head) : { x: 0, y: 0, visible: false };
      overlay.bubble.position(p.x, p.y, p.visible, overlay.bubbleArea());
    }
    renderer.render(space.scene, rig.camera);
  });

  // For scripted browser checks: read the model, drive the game without pixel-hunting.
  Object.assign(window, {
    world3d: {
      /** the build's full stamp (version.ts BUILD): "v0.14.0 · <git sha> · <UTC build time>", or "dev" */
      version: BUILD,
      /** the game's model plus `cutscene`: the fly-over playing / done / null (never played) */
      model: () => (game ? { ...game.model, cutscene: flyoverState } : undefined),
      state: () => game?.core.state,
      player: () => player.position.toArray(),
      space: () => nav.space,
      objective: () => game?.model.objective,
      prompt: () => (prompt ? { id: prompt.id, kind: prompt.kind, label: promptLabel(prompt) } : null),
      use: () => prompt && use(prompt),
      anim: () => ({
        player: player.actor.state,
        npcs: Object.fromEntries([...space.npcs].map(([n, v]) => [n, { state: v.actor.state, clips: v.actor.animated, clip: v.actor.playing?.getClip().name ?? null, carrying: v.actor.carrying, shrugging: v.actor.shrugging }])),
        walkers: space.walkers.map((w) => ({ state: w.actor.state, waiting: w.motion.waiting })),
      }),
      talk: (npc: string) => requestTalk(npc),
      /** everyone here who barks: id, role, where they are now, whether held (talking) */
      figures: () =>
        figures().map((f) => {
          const a = figureActor(f);
          // `screen`: its body's middle in CSS px, to click / tap (tap-to-talk checks)
          const mid = a ? a.root.position.clone().setY((a.root.position.y + a.headTop(barkHead).y) / 2) : null;
          return { id: f.id, role: f.role, kind: f.kind, at: a ? [a.root.position.x, a.root.position.z] : null, screen: mid ? project(mid) : null, talking: !!a?.talking, held: !!figureMotion(f)?.held };
        }),
      /** talk to a figure by id (as its prompt does) */
      bark: (id: string) => startBark(id),
      /** the bark on screen (null: none) */
      barkShown: () => game?.model.bark ?? null,
      walkTo: (x: number, z: number) => player.walkTo(x, z),
      // teleport(x, z): places the player, then runs the same edge-triggered zone check `nav.step`
      // does every frame of real walking, so core's place (and the space the player lands in)
      // follows the jump instead of only the raw position (a stale place broke space.npcs.has(npc)
      // lookups for talk()). teleport(place): goes there (routed, as the Go to list: a town zone,
      // a door, a travel-only spot, an interior) and stands at its spawn.
      teleport: (a: number | string, z?: number) => {
        if (typeof a === "string") {
          if (!game) return;
          if (game.core.state.place !== a) return game.enterPlace(a);
          const s = nav.jump(a);
          arriving = s;
          return;
        }
        player.place(a, z ?? 0);
        see.reset();
        seeDetector.invalidate();
        const go = nav.step(0, a, z ?? 0);
        if (go) game?.enterPlace(go);
      },
      /** the fly-over: "play" it again (in the town), "skip" it */
      cutscene: (cmd: "play" | "skip" = "play") => {
        if (cmd === "skip") return flyover?.path.skip();
        if (nav.space !== STREET) return;
        const s = L.spawn(LAYOUT.defaultPlace);
        player.place(s.pos[0], s.pos[2], new THREE.Vector3(...s.facing));
        playFlyover();
      },
      /** go to a place (routed hop by hop, like walking there): the street, or into an interior */
      enter: (place: string) => game?.enterPlace(place),
      /** leave the current interior through its open front */
      exit: () => {
        const p = nav.exitPlace();
        if (p) game?.enterPlace(p);
      },
      sleep: () => game?.sleep(),
      travel: () => game?.travel(),
      triggers: () => L.space(nav.space).triggers,
      walkers: () => space.walkers.map((w) => ({ x: w.motion.x, z: w.motion.z, waiting: w.motion.waiting })),
      pets: () => space.scatterers.map((s) => ({ x: s.motion.x, z: s.motion.z, away: s.motion.away })),
      daylight: () => (game ? game.model.hud.slot / game.model.hud.slots : 0),
      /** debug: preview any time of day (0 morning .. 1 evening) regardless of the real slot; the next real game event calls applyDaylight() again and overrides it. */
      setDaylight: (t: number) => space.setDaylight(t),
      dayCard: () => game?.model.dayCard,
      /** the parcel: where core says it goes, and whether the player has it in hand */
      errand: () => ({ to: game?.core.state.errand?.to ?? null, carrying: carry.holding, clip: player.actor.state }),
      /** accepted goTo inputs in core's log (a place-trigger thrash shows as a burst here) */
      goToCount: () => game?.core.state.log.filter((l) => l.input.type === "goTo").length ?? 0,
      /** last frame's draw calls (frustum-culled) and the space's static batching: draw calls before / after merging, unculled */
      info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, batching: { ...space.batching, now: drawCalls(space.scene) }, pixelRatio: renderer.getPixelRatio(), seeThroughPass: { sampleMs: +seeDetector.lastSampleMs.toFixed(2), readMs: +seeDetector.lastReadMs.toFixed(2), bytesPerFocus: SEE_THROUGH.sampleSize ** 2 * 4 }, cutscene: flyover ? { t: flyover.path.t, duration: flyover.path.duration } : null, cutsceneState: flyoverState }),
      /** touch input: the last joystick vector, pointers down, whether the stick is out; the layout in use */
      touch: () => ({ ...pointers!.debug(), touchUi: overlay.touch, layout: overlay.screen }),
      /** sound: unlocked, muted, music volume, the switches, the music bed and ambient gains wanted now */
      sound: () => ({ unlocked: mixer.unlocked, muted: mixer.muted, musicVolume: mixer.musicVolume, voice: prefs.voice, sfx: mixer.sfxOn, ambience: mixer.ambienceOn, ...mixer.playing }),
      /** play one sound effect by id (checks) */
      sfx: (id: string) => mixer.sfx(id),
      /** the first-steps guide's step (null: none / over / hidden) */
      guide: () => (guideStep ? { id: guideStep.id, text: guideStep.text, target: guideStep.target } : null),
      /** wayfinding: the target here (null: none / busy), the objective's kind and the next steps, today's step, the path's dots, the edge arrow shown, its draw calls */
      wayfinding: () => ({
        target: wayTarget,
        kind: game?.model.objective.kind ?? null,
        steps: steps.map((x) => x.text),
        day: game ? daySteps(course, game.core.state) : null,
        pathDots: trail.mesh.visible ? pathDots : 0,
        edge: !edge.node.classList.contains("hidden") ? edge.node.textContent : null,
        calls: drawCalls(guideMarker.root) + drawCalls(trail.mesh),
      }),
      /** the start flow is on screen */
      starting: () => startOpen,
      /**
       * The see-through: seeThrough("off") / ("on") switches whole-object fades for screenshot
       * comparisons and returns the roots currently easing below opaque (each with `coverage`, its
       * largest fraction of a focus's silhouette), plus the detector's per-focus async state
       * (slots: pending, timeouts, syncReads, syncFallback, lastSampleAgeMs, passes,
       * skipped { pending, unmoved, cadence }, silhouettePixels).
       */
      seeThrough: (cmd?: "on" | "off" | boolean) => {
        if (cmd !== undefined) see.on = cmd === true || cmd === "on";
        return { ...see.status(space.occluders), slots: seeDetector.debug() };
      },
      /**
       * Promo capture only (README "Promo capture"), console-only, never reached by normal play:
       *   promo("flyover")                             the full 22 s canonical fly-over, unskippable
       *   promo("hud", false | true)                    hide / show all DOM chrome and the wayfinding
       *                                                 marker/trail (a scene's speech bubble and reply
       *                                                 sheet stay as the game has them: the trailer
       *                                                 shows dialogue)
       *   promo("orbit", { x, z, radius, seconds })     one slow turn of the game camera round a ground
       *                                                 point (a hero shot: the great tree, the plaza)
       *   promo("dolly", { from, to, lookAt, seconds }) a straight, eased camera move
       * orbit and dolly return a promise that resolves once the move is done and the CameraRig is
       * restored; flyover and hud are synchronous (poll world3d.info().cutscene for the fly-over's time).
       */
      promo: (
        cmd: "flyover" | "hud" | "orbit" | "dolly",
        opt?: boolean | { x: number; z: number; radius: number; seconds: number } | { from: Vec3; to: Vec3; lookAt: Vec3; seconds: number },
      ): Promise<void> | undefined => {
        if (cmd === "flyover") {
          if (nav.space !== STREET || flyover) return undefined;
          const s = L.spawn(LAYOUT.defaultPlace);
          player.place(s.pos[0], s.pos[2], new THREE.Vector3(...s.facing));
          playFlyover(LAYOUT.town.cameraFull, false);
          return undefined;
        }
        if (cmd === "hud") {
          promoChromeOff = opt === false;
          uiRoot.classList.toggle("promo-chrome-off", promoChromeOff);
          return undefined;
        }
        if (flyover || promoCam) return Promise.resolve(); // one cinematic at a time
        if (cmd === "orbit") {
          const o = opt as { x: number; z: number; radius: number; seconds: number } | undefined;
          if (!o || !(o.radius > 0) || !(o.seconds > 0)) return Promise.resolve();
          return new Promise<void>((resolve) => {
            promoCam = new OrbitPath([o.x, o.z], o.radius, o.seconds);
            resolvePromoCam = resolve;
          });
        }
        const o = opt as { from: Vec3; to: Vec3; lookAt: Vec3; seconds: number } | undefined;
        if (!o || !(o.seconds > 0)) return Promise.resolve();
        return new Promise<void>((resolve) => {
          promoCam = new DollyPath(o.from, o.to, o.lookAt, o.seconds);
          resolvePromoCam = resolve;
        });
      },
    },
  });
}

// Anything else that throws on the way in: the failure screen, with Reload (main can't be run twice).
main().catch((e: unknown) => void askRetry(e, "reload"));
