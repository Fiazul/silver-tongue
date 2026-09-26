// Bootstraps the 3D front end: the course (courses.ts, picked and loaded as the browser TUI does),
// storage (same keys as the browser TUI), every scene space (the
// street and the interiors), the player, the camera, the overlay, and the frame loop that ties
// walking to core (zones / doors -> goTo through SpaceNav, NPC taps / E -> the scene start sequence
// in game.ts, prompts -> talk / enter / leave / sleep / notebook). Input: keys and the touch
// joystick feed one MoveInput vector (input.ts); clicks and taps go through touch.ts.
import * as THREE from "three";
import { decodeSave, encodeSave, sessionLines } from "@silver-tongue/tui";
import { fromLocalStorage, type KeyValue } from "@silver-tongue/tui-web/src/web-storage";
import { createAudioPlayer, unlockAudioOnGesture } from "./audio";
import { CameraRig, outlineScale } from "./camera";
import { PlayerCarry } from "./carry";
import { pickCourse } from "./courses";
import { openSession, type Game, type UiModel } from "./game";
import { MoveInput, toGround } from "./input";
import { LAYOUT, LayoutIndex, type AssetIndex, type Stand } from "./layout";
import { Player } from "./player";
import { nearestPrompt, promptTargets, SpaceNav, TALK_RANGE, type Arrival, type PromptTarget } from "./spaces";
import { PointerControls } from "./touch";
import { Overlay } from "./ui/overlay";
import { showCourseChoice } from "./ui/start";
import type { Insets } from "./ui/viewport";
import { AssetCache, drawCalls, SceneSpace, setOutlineScale } from "./world";
import type { WebSessions } from "@silver-tongue/tui-web/src/web-storage";

/**
 * Where courses/<id>/audio/ is, relative to the page (build.mjs): "../" on Pages (the browser TUI's
 * copy at the site root), "" when the clips are bundled into this dist/.
 */
declare const __AUDIO_ROOT__: string;
const ASSETS = "./assets"; // relative: the page works under a subpath (GitHub Pages /world3d/)

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

const loading = document.querySelector<HTMLElement>("#loading")!;
const uiRoot = document.querySelector<HTMLElement>("#ui")!;

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
  // The course first (the start list, when there are several and none is remembered), then the street.
  let picked: Awaited<ReturnType<typeof pickCourse>>;
  try {
    picked = await pickCourse({ fetchJson, kv, choose: (choice) => showCourseChoice(document.body, choice) });
  } catch (e) {
    // No course text has loaded, so there is no reading language to say this in (as tui-web).
    loading.textContent = "The game could not load. Serve this page from a web server and reload.";
    console.error(e);
    return;
  }
  const { course, entry } = picked;
  document.documentElement.lang = course.learner;
  // One audio player for the page (every game shares it), loading clips by URL as they are said.
  const audio = createAudioPlayer({
    base: `${__AUDIO_ROOT__}courses/${entry.id}/audio/`,
    audio: typeof Audio === "undefined" ? undefined : new Audio(),
    wait: (ms, cb) => {
      const h = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(h) };
    },
  });
  unlockAudioOnGesture(audio);

  const index = (await (await fetch(`${ASSETS}/index.json`)).json()) as AssetIndex;
  const L = new LayoutIndex(LAYOUT, index);

  const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.querySelector("#stage")!.append(renderer.domElement);

  const assets = new AssetCache(ASSETS, L);
  await assets.preload((done, total) => {
    loading.textContent = `Loading ${done}/${total}`;
  });
  // Every space is built up front (a few MB of shared templates): walking through a door is instant.
  const spaces = new Map<string, SceneSpace>();
  for (const id of L.spaceIds()) spaces.set(id, await SceneSpace.create(L, assets, id));
  const street = spaces.get("street")!;

  const player = new Player(await assets.actor(LAYOUT.player.character), street.area);
  // The parcel of an errand, in the player's hands while core has one (state.errand).
  const bagSpec = LAYOUT.player.errandProp;
  const bagAsset = typeof bagSpec === "string" ? bagSpec : bagSpec?.asset;
  const carry = new PlayerCarry(player.actor, bagAsset ? await assets.instance(bagAsset) : null, bagSpec);
  const rig = new CameraRig(renderer.domElement);

  // Where a tap sent the player: a small ring on the ground.
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;

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

  /** Puts the player (and the marker) into a space at a stand. */
  function enterSpace(id: string, stand: Stand) {
    const next = spaces.get(id)!;
    space.scene.remove(player.root, marker);
    space = next;
    space.scene.add(player.root, marker);
    player.area = space.area;
    player.place(stand.pos[0], stand.pos[2], new THREE.Vector3(...stand.facing));
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

  const overlay = new Overlay(uiRoot, course, {
    // The current game stays saved (it is listed under the same keys the browser TUI uses).
    onNewGame: () => {
      if (game && window.confirm(game.s("new-game-confirm"))) boot({ fresh: true });
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
  });

  /** World side of the model: the space for core's place, the scene lock and walk to the talk stand, talk / shrug clips, daylight. */
  function syncWorld(m: UiModel) {
    if (!game) return;
    // Core moved the player to a place another space shows: swap scenes behind a fade (next frame, not inside core's dispatch).
    const arrival = nav.sync(game.core.state.place);
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

  function boot(opts: { fresh?: boolean; id?: string }) {
    sceneNpc = null;
    pendingTalk = null;
    pendingUse = null;
    arriving = null;
    player.locked = false;
    audio.stop();
    let ready = false; // the first render happens once the overlay has this game
    const opened = openSession(course, kv, {
      now: Date.now,
      fresh: opts.fresh,
      id: opts.id,
      audio,
      onChange: (m) => {
        if (!ready) return;
        overlay.render(m);
        syncWorld(m);
      },
    });
    game = opened.game;
    sessions = opened.sessions;
    mixupSeq = game.model.mixups?.seq ?? 0;
    // A save made inside the noodle shop resumes inside it.
    nav = new SpaceNav(L, game.core.state.place);
    const start = nav.jump(game.core.state.place);
    enterSpace(start.space, start.stand);
    ready = true;
    overlay.setGame(game);
    syncWorld(game.model);
  }

  const flat = (a: THREE.Vector3, p: number[]) => Math.hypot(a.x - p[0], a.z - p[2]);

  /** Tap on an NPC / E: talk if close, else walk to where you talk to them and talk on arrival. */
  function requestTalk(npc: string) {
    if (!game || game.model.scene || game.model.mode !== "explore" || !space.npcs.has(npc)) return;
    const npcPos = L.npcStand(npc).pos;
    const stand = L.talkStand(npc);
    if (flat(player.position, npcPos) <= TALK_RANGE || flat(player.position, stand.pos) <= 1.2) {
      game.talkTo(npc);
      return;
    }
    const face = new THREE.Vector3(npcPos[0] - stand.pos[0], 0, npcPos[2] - stand.pos[2]);
    player.walkTo(stand.pos[0], stand.pos[2], { face, arrive: () => (pendingTalk = npc) });
    showMarker(stand.pos[0], stand.pos[2]);
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
    if (!game || overlay.blocking || transitioning) return;
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
    player.walkTo(hit.ground.x, hit.ground.z);
    showMarker(hit.ground.x, hit.ground.z);
  }

  // The one movement input: keys and the touch joystick write it, the frame loop reads it.
  const move = new MoveInput();
  const canvas = renderer.domElement;
  const pointers = new PointerControls(canvas, uiRoot, move, {
    onTap: tap,
    enabled: () => !!game && !overlay.blocking && !transitioning,
    stickZone: () => overlay.screen.stickZone,
    onTouch: () => overlay.setTouch(),
  });
  if (window.matchMedia?.("(pointer: coarse)").matches) overlay.setTouch();

  // Keys: overlay first (replies, lists, notebook), then walking and E.
  window.addEventListener("keydown", (e) => {
    if (!game || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (overlay.key(e)) return e.preventDefault();
    if (overlay.blocking) return;
    if (move.press(e.key)) e.preventDefault();
    else if (e.key.toLowerCase() === "e" && prompt) use(prompt);
  });
  window.addEventListener("keyup", (e) => move.release(e.key));
  window.addEventListener("blur", () => {
    move.clear();
    pointers.reset();
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

  boot({});
  loading.remove();

  const clock = new THREE.Clock();
  const dir = new THREE.Vector2();
  const focus = new THREE.Vector3();
  const head = new THREE.Vector3();
  const project = (p: THREE.Vector3) => {
    const v = p.clone().project(rig.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight, visible: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
  };
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    if (!game) return;
    // A place change into another space: fade, swap, fade back.
    if (arriving && !transitioning) {
      const a = arriving;
      arriving = null;
      transitioning = true;
      player.stop();
      overlay.fadeThrough(() => {
        enterSpace(a.space, a.stand);
        transitioning = false;
      });
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
      game.talkTo(npc);
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
    rig.update(dt, focus, !!sceneNpc);

    // Speech bubble on the speaker's head: a scene started from the topic picker (or any NPC the
    // current space doesn't have, e.g. mid space-swap) can leave the actor lookup empty for a frame
    // or more; re-pin top-centre then instead of freezing wherever the bubble last was (placeBubble
    // also tolerates this directly: a missing area/size/position never throws).
    const npc = overlay.bubble.npc;
    if (npc) {
      const found = !!space.head(npc, head);
      if (found) head.y += 0.25;
      const p = found ? project(head) : { x: 0, y: 0, visible: false };
      overlay.bubble.position(p.x, p.y, p.visible, overlay.screen.bubble);
    }
    renderer.render(space.scene, rig.camera);
  });

  // For scripted browser checks: read the model, drive the game without pixel-hunting.
  Object.assign(window, {
    world3d: {
      model: () => game?.model,
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
      // Places the player, then runs the same edge-triggered zone check `nav.step` does every frame
      // of real walking, so core's place (and the space the player lands in) follows the jump
      // instead of only the raw position (a stale place broke space.npcs.has(npc) lookups for talk()).
      teleport: (x: number, z: number) => {
        player.place(x, z);
        const go = nav.step(0, x, z);
        if (go) game?.enterPlace(go);
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
      info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, batching: { ...space.batching, now: drawCalls(space.scene) }, pixelRatio: renderer.getPixelRatio() }),
      /** touch input: the last joystick vector, pointers down, whether the stick is out; the layout in use */
      touch: () => ({ ...pointers.debug(), touchUi: overlay.touch, layout: overlay.screen }),
    },
  });
}

main().catch((e: unknown) => {
  loading.textContent = `Couldn't start: ${(e as Error).message}`;
  console.error(e);
});
