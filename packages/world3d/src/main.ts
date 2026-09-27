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
import { fromLocalStorage, type KeyValue } from "@silver-tongue/tui-web/src/web-storage";
import { COMING_SOON, NATIVE_NAMES } from "../locale";
import {
  ambientFor,
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
import { CAMERA, CameraRig, outlineScale } from "./camera";
import { PlayerCarry } from "./carry";
import { applyStart, loadCatalog, rememberedStart, resumePick, type Picked } from "./courses";
import { CameraPathPlayer, Letterbox } from "./cutscene";
import { openSession, type Game, type UiModel } from "./game";
import { Guide, type GuideStep } from "./guide";
import { MoveInput, toGround } from "./input";
import { deckAt, gridClass, heldProp, LAYOUT, LayoutIndex, STREET, type AssetIndex, type Stand } from "./layout";
import { emptyLoad, loadPlan, loadSummary, reduceLoad } from "./loading";
import { Player } from "./player";
import { loadPrefs, savePrefs } from "./prefs";
import { nearestPrompt, promptTargets, SpaceNav, TALK_RANGE, type Arrival, type PromptTarget } from "./spaces";
import type { IntroSource, StartConfig, StartResult } from "./start/flow";
import { clipsFor, courseIntro } from "./start/intro";
import * as startText from "./start/strings";
import { uiLanguage } from "./strings";
import { PointerControls } from "./touch";
import { LoadingScreen } from "./ui/loading";
import { Overlay } from "./ui/overlay";
import type { Insets } from "./ui/viewport";
import { AssetCache, drawCalls, SceneSpace, setOutlineScale } from "./world";
import { GuideMarker } from "./marker";
import { daySteps, edgeArrow, findPath, LostTimer, nextSteps, resolveTarget, type PathGrid, type WayTarget } from "./wayfind";
import { EdgeArrowView, PathTrail, spaceGrid } from "./wayview";
import type { WebSessions } from "@silver-tongue/tui-web/src/web-storage";

/**
 * Where courses/<id>/audio/ is, relative to the page (build.mjs): "../" on Pages (the browser TUI's
 * copy at the site root), "" when the clips are bundled into this dist/.
 */
declare const __AUDIO_ROOT__: string;
const ASSETS = "./assets"; // relative: the page works under a subpath (GitHub Pages /world3d/)
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

const loading = new LoadingScreen(document.querySelector<HTMLElement>("#loading")!);
/** the loading screen's hold for the start (the town's first views); released at the first frame */
const startHold = loading.hold();
const uiRoot = document.querySelector<HTMLElement>("#ui")!;
const startRoot = document.querySelector<HTMLElement>("#start")!;
/** `?ui=bn` / `?ui=zh`: the chrome in that UI language whatever the reading language (a preview until such a course exists). */
const uiOverride = new URLSearchParams(location.search).get("ui") ?? undefined;
const prefs = loadPrefs(kv);

// Phones: no pinch / double-tap zoom (iOS ignores user-scalable=no), no pull-to-refresh (page.css
// touch-action / overscroll-behavior); the first gesture unlocks audio.
for (const ev of ["gesturestart", "gesturechange", "dblclick"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
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
  let load = emptyLoad;
  const worldReady = (async () => {
    const index = await fetchJson<AssetIndex>(`${ASSETS}/index.json`);
    const L = new LayoutIndex(LAYOUT, index);
    const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.querySelector("#stage")!.append(renderer.domElement);
    const assets = new AssetCache(ASSETS, L);
    assets.onLoad = (e) => {
      load = reduceLoad(load, e);
      if (loading.visible) loading.render(loadSummary(load));
    };
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
  })();
  worldReady.catch(() => {}); // reported where it is awaited

  // The catalog first: no reading language to say anything in before it (as tui-web).
  let catalog: CatalogEntry[];
  try {
    catalog = await loadCatalog(fetchJson);
  } catch (e) {
    loading.error("The game could not load. Serve this page from a web server and reload.");
    console.error(e);
    return;
  }

  // Music, ambience and effects: one mixer for the page; it starts at the first gesture.
  const probe = typeof Audio === "undefined" ? undefined : new Audio();
  const canPlayType = probe ? (m: string) => probe.canPlayType(m) : undefined;
  const manifest = await fetchJson<SoundEntry[]>(`${ASSETS}/audio/manifest.json`).catch(() => [] as SoundEntry[]);
  const mixer = new SoundMixer({
    base: "./",
    manifest,
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
    muted: !prefs.sound,
    musicVolume: prefs.music,
  });
  const unlockEvents = ["pointerup", "touchend", "click", "keydown"] as const;
  const unlockMixer = () => {
    mixer.unlock();
    if (mixer.unlocked) for (const ev of unlockEvents) window.removeEventListener(ev, unlockMixer, true);
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
    const flow = (await import("./start/flow")).mountStartFlow(startRoot, {
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
    if (!opts.introOnly) mixer.setMusic("title_theme");
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

  let picked: Picked | null = await resumePick(deps, catalog);
  let startName: string | null = null;
  // move / pointers exist before the flow can reset them (declared below, used by runStartFlow)
  let pointers: PointerControls | undefined;
  const move = new MoveInput();
  if (!picked) {
    const r = await startFlowPick({ ...rememberedStart(kv) });
    picked = r.picked;
    startName = r.name;
  }
  let { course, entry } = picked;
  document.documentElement.lang = course.learner;
  audio = wordAudio(entry);

  let world: Awaited<typeof worldReady>;
  try {
    world = await worldReady;
  } catch (e) {
    loading.error(`Couldn't start: ${(e as Error).message}`);
    console.error(e);
    return;
  }
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
  /** the fly-over while it plays (a new game), with its letterbox */
  let flyover: { path: CameraPathPlayer; bars: Letterbox } | null = null;
  /** the fly-over's state for browser checks: playing, done (played out or skipped), null (never played: a loaded save) */
  let flyoverState: "playing" | "done" | null = null;

  /** Each interior's build, started once: prefetched after the first frame, or when a door needs it first. */
  const building = new Map<string, Promise<SceneSpace>>();
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
      return await ensureSpace(id);
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
  }

  /** Sound on / off everywhere: music, ambience, effects (the mixer) and the word clips (core's setSound). */
  function setSound(on: boolean) {
    prefs.sound = on;
    savePrefs(kv, prefs);
    mixer.setMuted(!on);
    if (game && game.model.hud.sound !== "none" && (game.model.hud.sound === "on") !== on) game.setSound(on);
  }

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
    onSound: setSound,
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
        sound: prefs.sound,
        music: prefs.music,
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
      setMusic: (v) => {
        prefs.music = v;
        savePrefs(kv, prefs);
        mixer.setMusicVolume(v);
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
    space.setTalking(m.scene && m.bubble?.npc === m.scene.npc ? m.scene.npc : null);
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
    // The sound setting holds across games: a save made with the word clips off follows it.
    if (game.model.hud.sound !== "none" && (game.model.hud.sound === "on") !== prefs.sound) game.setSound(prefs.sound);
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
    // overlay is held first, so the name dialog waits for the end of it.
    const fly = game.fresh && start.space === STREET;
    if (fly) overlay.hold(true);
    overlay.setGame(game);
    syncWorld(game.model);
    if (fly) playFlyover();
    else endFlyover();
  }

  /** The fly-over (town.json camera_path): the overlay waits under the letterbox; any tap, click or key skips it. */
  function playFlyover() {
    if (flyover) return;
    if (!LAYOUT.town.camera.keys.length) return overlay.hold(false);
    const touch = overlay.touch || !!window.matchMedia?.("(pointer: coarse)").matches;
    const bars = new Letterbox(document.body, game!.s(touch ? "cutscene-skip" : "cutscene-skip-key"), () => {
      sfx("cutscene_skip");
      flyover?.path.skip();
    });
    flyover = { path: new CameraPathPlayer(LAYOUT.town.camera), bars };
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
    if (t.kind === "enter" || t.kind === "exit") return game.enterPlace(t.ref);
    if (t.kind === "sleep") return game.sleep();
    if (t.kind === "notebook") return overlay.openNotebook();
  }

  function targets(): PromptTarget[] {
    return promptTargets(L, nav.space, !!game?.model.canSleep);
  }

  function promptLabel(t: PromptTarget): string {
    const { s } = game!;
    const placeName = (p: string) => game!.t(`place-${p}`);
    if (t.kind === "talk") return s("prompt-talk", { npc: game!.npcName(t.ref) });
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
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const hit = space.pick(ndc, rig.camera);
    if (!hit) return;
    if ("npc" in hit) return requestTalk(hit.npc);
    if (player.locked) return;
    pendingTalk = null;
    if ("target" in hit) {
      const t = targets().find((x) => x.id === hit.target);
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
    };
    // The start flow's music is its own (title_theme from the first tap); a replayed intro keeps the town's.
    if (!startOpen || !game) {
      const m = musicFor(scene);
      mixer.setMusic(m.track, m.gain);
    }
    mixer.setAmbient(ambientFor(scene));
  }

  /** Footsteps in step with the walk clip, by the surface underfoot. */
  function updateFootsteps() {
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
   * dialog or a space change.
   */
  function updateWayfinding(dt: number) {
    const st = game?.core.state;
    wayBusy = !game || !st || !!flyover || startOpen || transitioning || overlay.blocking || game.model.mode !== "explore" || !!st.run;
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

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    updateSound();
    if (!game) return;
    updateGuide(dt);
    updateFootsteps();
    // The fly-over: the camera on its path, the town living (walkers, pets, NPCs), the player idle at the spawn.
    if (flyover) {
      const done = flyover.path.update(dt, rig.camera, rig.fov / CAMERA.fovDeg);
      player.update(dt, still);
      space.update(dt, player.position, null);
      if (done) endFlyover();
      else return renderer.render(space.scene, rig.camera);
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
    prompt = free ? nearestPrompt(L, nav.space, targets(), player.position.x, player.position.z) : null;
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
    rig.update(dt, focus, !!sceneNpc);
    updateEdge();

    // Speech bubble on the speaker's head: a scene started from the topic picker (or any NPC the
    // current space doesn't have, e.g. mid space-swap) can leave the actor lookup empty for a frame
    // or more; re-pin top-centre then instead of freezing wherever the bubble last was (placeBubble
    // also tolerates this directly: a missing area/size/position never throws).
    const npc = overlay.bubble.npc;
    if (npc) {
      const found = !!space.head(npc, head);
      if (found) head.y += 0.25;
      const p = found ? project(head) : { x: 0, y: 0, visible: false };
      overlay.bubble.position(p.x, p.y, p.visible, overlay.bubbleArea());
    }
    renderer.render(space.scene, rig.camera);
  });

  // For scripted browser checks: read the model, drive the game without pixel-hunting.
  Object.assign(window, {
    world3d: {
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
      info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, batching: { ...space.batching, now: drawCalls(space.scene) }, pixelRatio: renderer.getPixelRatio(), cutscene: flyover ? { t: flyover.path.t, duration: flyover.path.duration } : null, cutsceneState: flyoverState }),
      /** touch input: the last joystick vector, pointers down, whether the stick is out; the layout in use */
      touch: () => ({ ...pointers!.debug(), touchUi: overlay.touch, layout: overlay.screen }),
      /** sound: unlocked, muted, music volume, the music bed and ambient gains wanted now */
      sound: () => ({ unlocked: mixer.unlocked, muted: mixer.muted, musicVolume: mixer.musicVolume, ...mixer.playing }),
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
    },
  });
}

main().catch((e: unknown) => {
  loading.error(`Couldn't start: ${(e as Error).message}`);
  console.error(e);
});
