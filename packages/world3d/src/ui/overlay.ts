// The HTML/CSS overlay over the WebGL canvas: HUD + objective line, speech bubble, reply panel,
// toasts, place banner, the one floating prompt ("E · Talk to …"), scene / travel lists, notebook,
// day summary card, wallet floats, name prompt, action buttons, the touch action button (the
// prompt, for thumbs) and the menu (games, export, import, new game). Phone geometry comes from
// ui/viewport.ts (layout()). No text is drawn in WebGL. It renders the UiModel from game.ts and turns taps
// into Game calls; it keeps no game state of its own. Also: the first-steps guide's line in the HUD
// and its one-off highlights (guide.ts), wayfinding's objective card, reminder toast and Menu →
// Show path (wayfind.ts), Menu → Settings, and a tap sound for every button (the sfx hook:
// `data-sfx` on a button names another effect, "none" none).
import type { Course, RenderedLine, WordId } from "@silver-tongue/core";
import type { DayCard, FeedItem, Game, Gloss, UiModel } from "../game";
import type { GuideStep } from "../guide";
import { FPS_CHOICES, TIERS, type Tier } from "../look";
import { versionLine } from "../version";
import { BubbleView } from "./bubble";
import { el } from "./dom";
import { HudView, type WayCard } from "./hud";
import { icon } from "./icons";
import { notebookNodes } from "./notebook";
import { RepliesView } from "./replies";
import { bubbleArea, clampBox, layoutVars, NO_INSETS, phoneHud, phoneHudVars, screenLayout, usePhoneHud, type Insets, type Rect, type ScreenLayout } from "./viewport";

/** A press held this long on a phone HUD icon button shows its label instead of pressing it (ms). */
export const LONG_PRESS_MS = 450;
/** how long that label stays up (ms) */
export const TIP_MS = 1200;

export interface SavedGame {
  label: string;
  open(): void;
}

export interface OverlayHooks {
  onNewGame(): void;
  /** the saved games, most recent first */
  games(): SavedGame[];
  /** the current game as one line of text (tui's encodeSave) */
  exportLine(): Promise<string>;
  /** adds a game from a line and plays it; an error message, or null when it worked */
  importLine(line: string): Promise<string | null>;
  /** the floating prompt was tapped (or E pressed) */
  onPrompt(): void;
  /** a sound effect (audio.ts SoundMixer) */
  sfx?(id: string): void;
  /**
   * The music (main.ts, prefs.ts musicTap): the HUD's ♪ chip, M and Menu's "Music" button tap it
   * off (volume 0) and back on (the volume it had). Without it those drive core's sound (word clips).
   */
  music?: { on(): boolean; tap(): boolean };
  /** Menu → Settings */
  settings?: SettingsHooks;
  /** Menu → Hide / Show guide */
  guide?: { hidden(): boolean; active(): boolean; setHidden(on: boolean): void };
  /** wayfinding (wayfind.ts): the objective card's "Take me there", Menu → Show path */
  way?: { takeMeThere(): void; pathShown(): boolean; setPathShown(on: boolean): void };
}

export interface SettingsView {
  learners: { code: string; label: string }[];
  learner: string;
  courses: { id: string; label: string; soon?: boolean }[];
  course: string;
  name: string;
  /** the voices: word clips and barks */
  voice: boolean;
  /** the sound effects bus */
  sfx: boolean;
  /** the ambience bus (ambienceFull applies while it is on) */
  ambience: boolean;
  /** 0..1 */
  music: number;
  /** ambience plays every bed, not just the quiet default (audio.ts AMBIENT_LIGHT_CAPS) */
  ambienceFull: boolean;
  /** the graphics tier running now (look.ts LOOK.tier) */
  graphics: Tier;
  /** the real look's frame rate choice (look.ts FPS_CHOICES); null: no row (classic has no pacing) */
  fps: number | null;
}

export interface SettingsHooks {
  current(): SettingsView;
  /** another reading language / course (courses.ts applyStart, as tui-web's switchTo); an error message, or null */
  switchTo(course: string, learner: string): Promise<string | null>;
  /** an error message, or null when the name was taken */
  setName(name: string): string | null;
  setMusic(v: number): void;
  setVoice(on: boolean): void;
  setSfx(on: boolean): void;
  setAmbience(on: boolean): void;
  setAmbienceFull(on: boolean): void;
  /** Settings → Graphics: saved; true when it differs from the running tier (it applies at the next page load) */
  setGraphics(tier: Tier): boolean;
  /** Settings → Frame rate: saved and applied at once */
  setFps(fps: number): void;
  replayIntro(): void;
}

export class Overlay {
  private hud!: HudView;
  bubble!: BubbleView;
  private replies!: RepliesView;
  private toasts = el("div", { className: "toasts" });
  private choices = el("div", { className: "choices hidden" });
  private actions = el("div", { className: "actions" });
  private gloss = el("div", { className: "gloss hidden" });
  private notebook = el("dialog", { className: "notebook" });
  private nameForm = el("dialog", { className: "name" });
  private menu = el("dialog", { className: "menu" });
  private dayCardView = el("dialog", { className: "daycard" });
  private fade = el("div", { className: "fade" });
  private hint = el("div", { className: "hint" });
  private banner = el("div", { className: "banner hidden" });
  private promptBtn = el("button", { className: "prompt hidden" });
  /** touch: the prompt as a fixed thumb button, bottom-right */
  private actionBtn = el("button", { className: "action-btn hidden" });
  private floats = el("div", { className: "floats" });
  /** the speech bubble and the reply panel: on the phone HUD one bottom sheet (page.css), elsewhere `display: contents` (each placed on its own) */
  private sheet = el("div", { className: "sheet" });
  /** the phone HUD is on (html.phone-hud) */
  phone = false;
  private seenFeed = 0;
  private dayChanges = 0;
  private seenDayCard = 0;
  private seenFx = 0;
  private pulse = 0;
  private place = "";
  private bannerTimer: ReturnType<typeof setTimeout> | undefined;
  private game!: Game;
  /** the prompt's current target id (null: hidden) */
  promptId: string | null = null;
  /** where panels sit for the current viewport (layout()) */
  screen: ScreenLayout = screenLayout(1024, 768);
  /** a touch has been seen: the touch look (joystick hint, action button) */
  touch = false;

  constructor(
    private root: HTMLElement,
    private course: Course,
    private hooks: OverlayHooks,
  ) {
    root.append(this.sheet, this.toasts, this.choices, this.actions, this.gloss, this.notebook, this.nameForm, this.menu, this.dayCardView, this.fade, this.hint, this.banner, this.promptBtn, this.actionBtn, this.floats);
    // A tap anywhere else closes the gloss popover.
    document.addEventListener("pointerdown", (e) => {
      if (!this.gloss.contains(e.target as Node)) this.gloss.classList.add("hidden");
      // the phone's narration sheet: a tap anywhere else dismisses it
      if (this.phone && !this.toasts.contains(e.target as Node)) for (const c of [...this.toasts.children]) c.classList.add("out");
    });
    // a tap on a narration line opens it past its two lines (or closes it again)
    this.toasts.addEventListener("click", (e) => {
      const t = (e.target as Element | null)?.closest?.(".toast");
      if (t && this.phone) t.classList.toggle("open");
    });
    this.promptBtn.addEventListener("click", () => this.hooks.onPrompt());
    this.actionBtn.addEventListener("click", () => this.hooks.onPrompt());
    // Every button's sound: ui_tap unless it names its own (data-sfx), before its own handler runs.
    root.addEventListener(
      "click",
      (e) => {
        const b = (e.target as Element | null)?.closest?.("button, .option") as HTMLElement | null;
        if (!b || (b as HTMLButtonElement).disabled) return;
        const id = b.dataset.sfx ?? "ui_tap";
        if (id !== "none") this.hooks.sfx?.(id);
      },
      true,
    );
  }

  /** the UI language (hint chips' labels); main.ts sets it with the course */
  lang = "";
  private guideStep: GuideStep | null = null;
  private highlighted = new Set<string>();
  private way: WayCard | null = null;
  private wayKey = "null";

  /** Wayfinding's part of the objective card (main.ts, every frame; re-rendered on a change only). */
  setWay(card: WayCard | null) {
    const key = JSON.stringify(card);
    if (key === this.wayKey) return;
    this.wayKey = key;
    this.way = card;
    if (this.game) this.hud.render(this.game.model.hud, this.game.model.objective, this.guideStep, card);
  }

  /** The HUD's box on screen (the edge arrow keeps out of it; main.ts measures it twice a second, not per frame). */
  hudRect(): DOMRect | null {
    return this.hud?.node.getBoundingClientRect() ?? null;
  }

  /** A toast of our own (wayfinding's "lost?" reminder), as the feed's. */
  notify(text: string, tone = "guide") {
    this.toast(text, tone);
  }

  /** The guide's current step (main.ts, every frame): the HUD line, and its highlight the first time it can show. */
  setGuide(step: GuideStep | null) {
    const changed = (step?.text ?? null) !== (this.guideStep?.text ?? null);
    this.guideStep = step;
    if (!this.game) return;
    if (changed) this.hud.render(this.game.model.hud, this.game.model.objective, step, this.way);
    this.guideHighlight();
  }

  private guideHighlight() {
    const h = this.guideStep?.highlight;
    if (!h || this.highlighted.has(h) || this.held) return;
    const m = this.game.model;
    if (h === "replies" && m.reply) {
      this.replies.glow();
      this.highlighted.add(h);
    } else if (h === "word" && m.bubble && this.bubble.pulseWord()) this.highlighted.add(h);
  }

  /** Core's sound on / off (the word clips): the ♪ chip, M and Menu → Sound when there is no mixer (no `music` hook). */
  private toggleSound(on: boolean) {
    this.game.setSound(on);
  }

  /** The ♪ tap with the mixer: music off (a 3 s toast says how to get it back) or on again; nothing else. */
  private tapMusic(): boolean {
    const on = this.hooks.music!.tap();
    if (!on) this.toast(this.game.s("music-off-toast"), "note", 3000);
    this.hud?.refresh();
    return on;
  }

  /** A new viewport size / safe area: the phone layout's rects as CSS custom properties and classes on <html>. */
  layout(w: number, h: number, insets: Insets = NO_INSETS) {
    this.screen = screenLayout(w, h, insets);
    const doc = document.documentElement;
    for (const [k, v] of Object.entries(layoutVars(this.screen))) doc.style.setProperty(k, v);
    doc.classList.toggle("compact", this.screen.compact);
    doc.classList.toggle("portrait", this.screen.orientation === "portrait");
    doc.classList.toggle("landscape", this.screen.orientation === "landscape");
    this.phoneLayout();
  }

  /** The phone HUD (viewport.ts phoneHud): its rects as --ph-* properties, html.phone-hud, the bubble docked in the sheet. */
  private phoneLayout() {
    const doc = document.documentElement;
    const coarse = this.touch || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
    this.phone = usePhoneHud(this.screen, coarse);
    for (const [k, v] of Object.entries(phoneHudVars(phoneHud(this.screen), this.screen.viewport))) doc.style.setProperty(k, v);
    doc.classList.toggle("phone-hud", this.phone);
    if (this.bubble) this.bubble.docked = this.phone;
  }

  /**
   * Boxes the screen-edge arrow keeps out of (main.ts, twice a second): the HUD, and on the phone
   * HUD the icon column, the action button and the narration sheet.
   */
  keepOutRects(): Rect[] {
    const nodes: Element[] = [this.actions, this.actionBtn, ...(this.hud ? [this.hud.node] : []), ...[...this.toasts.children].filter((c) => !c.classList.contains("out"))];
    return nodes
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
  }

  /** The first touch: the touch look (action button instead of the floating prompt, the joystick hint). */
  setTouch() {
    if (this.touch) return;
    this.touch = true;
    document.documentElement.classList.add("touch");
    this.phoneLayout();
    if (this.game) this.hint.textContent = this.game.s("walk-hint-touch");
  }

  /**
   * Where the speech bubble may sit this frame: the layout's bubble rect under the toasts on screen
   * now and above the reply panel (viewport.ts bubbleArea: one band each, at every breakpoint).
   */
  bubbleArea(): Rect {
    const box = (e: Element): Rect => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const live = [...this.toasts.children].filter((c) => !c.classList.contains("out"));
    const toasts = live.length ? box(this.toasts) : null;
    const replies = this.replies && !this.replies.node.classList.contains("hidden") ? box(this.replies.node) : null;
    return bubbleArea(this.screen.bubble, { toasts, replies });
  }

  /** The safe area shrunk by a margin: where floating things (prompt, gloss) are kept. */
  private keepIn(margin = 8): Rect {
    const r = this.screen.safe;
    return { x: r.x + margin, y: r.y + margin, w: r.w - 2 * margin, h: r.h - 2 * margin };
  }

  /** Binds a (new) game: rebuilds the parts that hold its text. */
  setGame(game: Game) {
    this.game = game;
    const { t, s } = game;
    this.hud?.node.remove();
    this.bubble?.node.remove();
    this.replies?.node.remove();
    const music = this.hooks.music;
    this.hud = new HudView(
      s,
      t,
      (on) => (music ? void this.tapMusic() : this.toggleSound(on)),
      () => this.hooks.way?.takeMeThere(),
      music ? () => music.on() : undefined,
    );
    const sfx = (id: string) => this.hooks.sfx?.(id);
    this.bubble = new BubbleView(this.course, s, {
      onWord: (w, at) => this.lookUp(w, at),
      onSentence: (line, at) => this.sentence(line, at),
      onReplay: () => game.replay(),
      sfx,
      lang: this.lang,
    });
    this.replies = new RepliesView(this.course, t, s, {
      onPick: (i) => game.reply(i),
      onTiles: (tiles) => game.replyTiles(tiles),
      onWord: (w, at) => this.lookUp(w, at),
      onGiveUp: () => game.giveUpTiles(),
      onHear: (clips) => game.say(clips),
      sfx,
      lang: this.lang,
    });
    this.bubble.docked = this.phone;
    this.root.append(this.hud.node);
    this.sheet.append(this.bubble.node, this.replies.node);
    this.seenFeed = 0;
    this.dayChanges = game.model.dayChanges;
    this.seenDayCard = game.model.dayCard?.seq ?? 0;
    this.seenFx = game.model.walletFx.at(-1)?.seq ?? 0;
    this.pulse = game.model.notebookPulse;
    this.place = "";
    this.toasts.replaceChildren();
    this.hint.textContent = s(this.touch ? "walk-hint-touch" : "walk-hint");
    this.hint.classList.remove("gone");
    setTimeout(() => this.hint.classList.add("gone"), 9000);
    if (this.dayCardView.open) this.dayCardView.close();
    this.render(game.model);
  }

  /**
   * Held under the fly-over (cutscene.ts): the overlay is hidden and opens no dialog (a modal would
   * make the skip tap inert). Released: shown again, with the place banner, the walk hint and any
   * dialog the game is waiting on (the name).
   */
  hold(on: boolean) {
    if (this.held === on) return;
    this.held = on;
    this.root.classList.toggle("under-cutscene", on);
    if (on && this.nameForm.open) this.nameForm.close();
    if (on || !this.game) return;
    this.place = "";
    this.hint.classList.remove("gone");
    setTimeout(() => this.hint.classList.add("gone"), 9000);
    this.render(this.game.model);
  }
  private held = false;

  /** Something modal is open: the world ignores taps and keys meant for walking. */
  get blocking(): boolean {
    return this.notebook.open || this.nameForm.open || this.menu.open || this.dayCardView.open || !this.choices.classList.contains("hidden");
  }

  /** A course switched in Settings (another reading language or course): its text from here on. */
  setCourse(course: Course) {
    this.course = course;
  }

  render(m: UiModel) {
    this.hud.render(m.hud, m.objective, this.guideStep, this.way);
    // a line or a reply panel is up: the phone HUD folds its column to ≡ and hides the guide line
    document.documentElement.classList.toggle("sheet-open", !!(m.bubble || m.reply));
    this.bubble.render(m.bubble);
    this.replies.render(m.reply);
    this.renderChoices(m);
    this.renderActions(m);
    this.renderFeed(m.feed);
    this.renderWalletFx(m);
    if (m.hud.place !== this.place) {
      this.place = m.hud.place;
      this.showBanner(m.hud.place, m.hud.placeName);
    }
    // One layer per band: a line on screen takes the banner's band (it goes at once), the reply
    // sheet the walk hint's (bottom centre).
    if (m.bubble) this.banner.classList.add("out");
    if (m.reply) this.hint.classList.add("gone");
    if (m.dayChanges !== this.dayChanges) {
      this.dayChanges = m.dayChanges;
      this.fade.classList.remove("night");
      void this.fade.offsetWidth;
      this.fade.classList.add("night");
    }
    if (m.dayCard && m.dayCard.seq !== this.seenDayCard) {
      this.seenDayCard = m.dayCard.seq;
      // After the night fade has darkened the screen.
      const card = m.dayCard;
      setTimeout(() => this.openDayCard(card), 900);
    }
    if (m.mode === "name" && !this.nameForm.open && !this.held) this.openName();
    if (m.mode !== "name" && this.nameForm.open) this.nameForm.close();
    this.guideHighlight();
  }

  private showBanner(place: string, name: string) {
    const { t } = this.game;
    const desc = t.has(`place-${place}-desc`) ? t(`place-${place}-desc`) : "";
    this.banner.replaceChildren(el("div", { className: "banner-name", textContent: name }), ...(desc ? [el("div", { className: "banner-desc", textContent: desc })] : []));
    this.banner.classList.remove("hidden", "out");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.banner.classList.add("out"), 3200);
  }

  private renderChoices(m: UiModel) {
    const c = m.choices;
    this.choices.classList.toggle("hidden", !c);
    if (!c) return this.choices.replaceChildren();
    const items = c.items.map((item, i) => {
      const b = el("button", { className: item.input ? "choice" : "choice secondary", textContent: `${i + 1}. ${item.label}` });
      b.addEventListener("click", () => this.game.choose(i));
      return b;
    });
    this.choices.replaceChildren(el("h2", { textContent: c.title }), ...items);
  }

  private renderActions(m: UiModel) {
    const { s } = this.game;
    const buttons: HTMLButtonElement[] = [];
    const nb = this.actionButton("notebook", s("notebook"), "notebook-btn");
    nb.dataset.sfx = "none"; // openNotebook plays notebook_open
    nb.addEventListener("click", () => this.openNotebook());
    buttons.push(nb);
    if (m.mode === "explore") {
      const go = this.actionButton("travel", s("travel"), "travel-btn");
      go.addEventListener("click", () => this.game.travel());
      buttons.push(go);
    }
    if (m.mentor) {
      const b = this.actionButton("mentor", m.mentor.label, "mentor");
      b.addEventListener("click", () => this.game.visitMentor());
      buttons.push(b);
    }
    if (m.canSleep) {
      const b = this.actionButton("sleep", m.sleepLabel, "sleep");
      b.addEventListener("click", () => this.game.sleep());
      buttons.push(b);
    }
    const menu = this.actionButton("menu", s("menu"), "secondary menu-btn");
    menu.addEventListener("click", () => this.openMenu());
    buttons.push(menu);
    const key = buttons.map((b) => b.textContent).join("|");
    if (this.actions.dataset.key !== key) {
      this.actions.dataset.key = key;
      this.actions.replaceChildren(...buttons);
    }
    if (m.notebookPulse !== this.pulse) {
      this.pulse = m.notebookPulse;
      const b = this.actions.querySelector(".notebook-btn");
      b?.classList.remove("pulse");
      void (b as HTMLElement | null)?.offsetWidth;
      b?.classList.add("pulse");
    }
  }

  /**
   * An action-column button: its label (desktop: the button's text; the phone HUD: a round icon,
   * the label an aria-label and a tip on hover or a long press, which then doesn't press it).
   */
  private actionButton(name: string, label: string, className: string): HTMLButtonElement {
    const b = el("button", { className: `${className} act-btn`, title: label }, icon(name), el("span", { className: "act-label", textContent: label }));
    b.setAttribute("aria-label", label);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tipped = false;
    const cancel = () => clearTimeout(timer);
    b.addEventListener("pointerdown", () => {
      tipped = false;
      if (!this.phone) return;
      cancel();
      timer = setTimeout(() => {
        tipped = true;
        b.classList.add("tip");
        setTimeout(() => b.classList.remove("tip"), TIP_MS);
      }, LONG_PRESS_MS);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(type, cancel);
    // the long press showed the label: the click that follows the lift is not a press
    b.addEventListener(
      "click",
      (e) => {
        if (!tipped) return;
        tipped = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      true,
    );
    b.addEventListener("contextmenu", (e) => this.phone && e.preventDefault());
    return b;
  }

  private renderFeed(feed: FeedItem[]) {
    for (const f of feed) {
      if (f.seq <= this.seenFeed) continue;
      this.seenFeed = f.seq;
      if (f.tone === "place") continue; // the banner shows where you are
      this.toast(f.text, f.tone);
    }
  }

  private toast(text: string, tone: string, fixedMs?: number) {
    const node = el("div", { className: `toast ${tone}` });
    // "Title\nbody" (mentor notes): bold title, then the body.
    const [head, ...body] = text.split("\n");
    if (body.length) node.append(el("b", { textContent: head }), ...body.map((p) => el("div", { textContent: p })));
    else node.textContent = head;
    this.toasts.append(node);
    const ms = fixedMs ?? 2600 + text.length * (tone === "story" || tone === "note" ? 55 : 30);
    setTimeout(() => node.classList.add("out"), ms);
    setTimeout(() => node.remove(), ms + 600);
    while (this.toasts.children.length > 5) this.toasts.firstElementChild?.remove();
  }

  /** "+¥5" / "−¥2" floating up from the wallet chip; shopping and a delivery's wages say so under it. */
  private renderWalletFx(m: UiModel) {
    for (const fx of m.walletFx) {
      if (fx.seq <= this.seenFx) continue;
      this.seenFx = fx.seq;
      // the wallet chip, or where it sits when the phone HUD has stepped aside for a sheet
      const w = this.hud.walletRect();
      const r = w && w.width > 0 ? w : null;
      const node = el(
        "div",
        { className: `float ${fx.delta > 0 ? "good" : "bad"} fx-${fx.reason}` },
        el("span", { className: "fx-amount", textContent: `${fx.delta > 0 ? "+" : "−"}${m.hud.currency}${Math.abs(fx.delta)}` }),
        ...(fx.label ? [el("span", { className: "fx-label", textContent: fx.label })] : []),
      );
      node.style.left = `${r ? r.left + r.width / 2 : 80}px`;
      node.style.top = `${r ? r.bottom + 4 : 44}px`;
      this.floats.append(node);
      setTimeout(() => node.remove(), 1800);
    }
  }

  private showGloss(g: Gloss, at: HTMLElement) {
    const r = at.getBoundingClientRect();
    this.gloss.replaceChildren(
      el("div", { className: "g-word", textContent: g.text }),
      ...(g.reading ? [el("div", { className: "g-reading", textContent: g.reading })] : []),
      el("div", { className: "g-gloss", textContent: g.gloss }),
    );
    if (g.audio.length) {
      // ▶: say the word (or sentence) again, as the TUI's [p]
      const play = el("button", { className: "icon g-play", title: this.game.s("play"), textContent: "▶" });
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        this.game.say(g.audio, g.slow);
      });
      this.gloss.append(play);
    }
    this.gloss.classList.remove("hidden");
    const w = this.gloss.offsetWidth;
    const h = this.gloss.offsetHeight;
    const above = r.top - 8 - h >= this.keepIn().y;
    const p = clampBox(r.left + r.width / 2 - w / 2, above ? r.top - 8 - h : r.bottom + 8, w, h, this.keepIn());
    this.gloss.style.left = `${p.x}px`;
    this.gloss.style.top = `${p.y}px`;
    this.gloss.style.transform = "none";
  }

  /** A word's card (readings, gloss, ▶) by the prompt: the name of a shop item just taken (logged as help, as a tap on it in a bubble). */
  lookUpWord(word: WordId) {
    this.lookUp(word, this.promptBtn.classList.contains("hidden") ? this.actionBtn : this.promptBtn);
  }

  private lookUp(word: WordId, at: HTMLElement) {
    const g = this.game.helpWord(word);
    if (g) this.showGloss(g, at);
  }

  private sentence(line: RenderedLine, at: HTMLElement) {
    const g = this.game.sentence(line);
    if (g) this.showGloss(g, at);
  }

  /** The floating prompt over the nearest thing to use: label, or null to hide; screen position in CSS px. */
  setPrompt(id: string | null, label: string, x: number, y: number, visible: boolean) {
    this.promptId = id;
    const usable = !!id && !this.blocking;
    // The thumb button mirrors the prompt whenever something is in range (on screen or not).
    this.actionBtn.classList.toggle("hidden", !usable);
    if (usable && this.actionBtn.dataset.label !== label) {
      this.actionBtn.dataset.label = label;
      this.actionBtn.replaceChildren(el("span", { className: "action-key", textContent: this.game.s("prompt-key") }), el("span", { className: "action-label", textContent: label }));
      this.actionBtn.setAttribute("aria-label", label);
    }
    const show = usable && visible;
    this.promptBtn.classList.toggle("hidden", !show);
    if (!show) return;
    const text = `${this.game.s("prompt-key")} · ${label}`;
    if (this.promptBtn.textContent !== text) this.promptBtn.textContent = text;
    // Centred above the point, kept inside the safe area.
    const w = this.promptBtn.offsetWidth;
    const h = this.promptBtn.offsetHeight;
    const p = clampBox(x - w / 2, y - h, w, h, this.keepIn());
    this.promptBtn.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  /** Fades to black, calls `mid` (swap the scene), fades back. */
  fadeThrough(mid: () => void) {
    this.fade.classList.remove("night", "through");
    void this.fade.offsetWidth;
    this.fade.classList.add("through");
    setTimeout(mid, 220);
    setTimeout(() => this.fade.classList.remove("through"), 700);
  }

  openNotebook() {
    const { s } = this.game;
    const close = el("button", { className: "secondary", textContent: s("close") });
    close.dataset.sfx = "ui_back";
    close.addEventListener("click", () => this.notebook.close());
    this.notebook.replaceChildren(el("h2", { textContent: s("notebook") }), el("div", { className: "nb-body" }, ...notebookNodes(this.game.notebook())), close);
    if (!this.notebook.open) this.hooks.sfx?.("notebook_open");
    this.notebook.showModal();
  }

  private openDayCard(c: DayCard) {
    const { s } = this.game;
    const cur = this.course.world.currency;
    const money = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}${cur}${Math.abs(n)}`;
    const row = (label: string, value: string, cls = "") => el("div", { className: `dc-row ${cls}` }, el("span", { textContent: label }), el("b", { textContent: value }));
    const rows = [
      row(s("day-card-earned"), money(c.earned), "good"),
      ...(c.mixups ? [row(s("day-card-mixups"), String(c.mixups), "bad")] : []),
      row(s("day-card-food"), money(-c.food), "bad"),
      ...(c.rent ? [row(s("day-card-rent"), money(-c.rent), "bad")] : []),
      row(s("day-card-change"), money(c.change), c.change >= 0 ? "good" : "bad"),
      row(s("day-card-wallet"), `${cur}${c.wallet}`),
    ];
    const next = el("button", { textContent: s("day-card-next") });
    next.addEventListener("click", () => this.dayCardView.close());
    this.dayCardView.replaceChildren(
      el("h2", { textContent: s("day-card-title", { day: c.day }) }),
      ...rows,
      ...(c.rentLate ? [el("p", { className: "dc-late", textContent: s("day-card-rent-late") })] : []),
      next,
    );
    if (!this.dayCardView.open) this.dayCardView.showModal();
  }

  /** The menu: saved games, export / import a save line, new game, settings, music (or sound), the guide, how to play. */
  openMenu() {
    const { t, s } = this.game;
    const body = el("div", { className: "menu-body" });
    const close = el("button", { className: "secondary", textContent: s("close") });
    close.dataset.sfx = "ui_back";
    close.addEventListener("click", () => this.menu.close());
    const button = (label: string, run: () => void, cls = "") => {
      const b = el("button", { className: cls, textContent: label });
      if (cls === "secondary") b.dataset.sfx = "ui_back";
      b.addEventListener("click", run);
      return b;
    };
    const guide = this.hooks.guide;
    const home = () =>
      body.replaceChildren(
        button(t("web-games"), games),
        button(t("web-export"), () => void exportLine()),
        button(t("web-import"), importLine),
        button(t("web-new"), () => {
          this.menu.close();
          this.hooks.onNewGame();
        }),
        ...(this.hooks.settings ? [button(s("settings"), () => this.settingsView(body, home))] : []),
        sound(),
        ...(guide?.active()
          ? [
              button(s(guide.hidden() ? "guide-show" : "guide-hide"), () => {
                guide.setHidden(!guide.hidden());
                home();
              }),
            ]
          : []),
        ...(this.hooks.way ? [pathToggle()] : []),
        button(s("help"), () => body.replaceChildren(el("p", { textContent: s("walk-hint") }), button(s("cancel"), home, "secondary"))),
      );
    /** Show path: on / off (wayfinding's ground path hint); relabels itself. */
    const pathToggle = () => {
      const way = this.hooks.way!;
      const label = () => s(way.pathShown() ? "path-menu-on" : "path-menu-off");
      const b = button(label(), () => {
        way.setPathShown(!way.pathShown());
        b.textContent = label();
        b.setAttribute("aria-pressed", String(way.pathShown()));
      }, "path");
      b.setAttribute("aria-pressed", String(way.pathShown()));
      return b;
    };
    /** Music on / off as the HUD's ♪ with the mixer (main.ts), else core's sound (the word clips); relabels itself. */
    const sound = () => {
      const music = this.hooks.music;
      if (music) {
        const label = () => s(music.on() ? "music-menu-on" : "music-menu-off");
        const b = button(label(), () => {
          this.tapMusic();
          b.textContent = label();
          b.setAttribute("aria-pressed", String(music.on()));
        }, "sound");
        b.setAttribute("aria-pressed", String(music.on()));
        return b;
      }
      const state = (): "on" | "off" | "none" => this.game.model.hud.sound;
      const label = () => s(`sound-menu-${state()}`);
      const b = button(label(), () => {
        const h = state();
        if (h !== "none") this.toggleSound(h !== "on");
        b.textContent = label();
      }, "sound");
      b.disabled = state() === "none";
      return b;
    };
    const games = () => {
      const list = this.hooks.games();
      body.replaceChildren(
        el("h3", { textContent: t("resume-title") }),
        ...(list.length ? list.map((g) => button(g.label, () => (this.menu.close(), g.open()), "game")) : [el("p", { textContent: t("web-games-none") })]),
        button(s("cancel"), home, "secondary"),
      );
    };
    const exportLine = async () => {
      const line = await this.hooks.exportLine();
      const box = el("textarea", { readOnly: true, value: line, rows: 5 });
      const copy = button(t("web-copy"), async () => {
        box.select();
        try {
          await navigator.clipboard.writeText(line);
          copy.textContent = t("web-copied");
        } catch {
          copy.textContent = s("export-copy-failed");
        }
      });
      body.replaceChildren(el("h3", { textContent: t("web-export") }), el("p", { textContent: t("web-export-hint") }), box, copy, button(s("cancel"), home, "secondary"));
    };
    const importLine = () => {
      const box = el("textarea", { rows: 5, placeholder: "st1:…" });
      const result = el("p", { className: "err" });
      const go = button(t("web-import-go"), async () => {
        const err = await this.hooks.importLine(box.value);
        if (err) result.textContent = err;
        else this.menu.close();
      });
      body.replaceChildren(el("h3", { textContent: t("web-import") }), el("p", { textContent: t("web-import-hint") }), box, go, result, button(s("cancel"), home, "secondary"));
    };
    home();
    this.menu.replaceChildren(el("h2", { textContent: s("menu-title") }), body, close);
    this.menu.showModal();
  }

  /**
   * Menu → Settings: reading language, course (with the coming-soon ones greyed), name, the four
   * sound switches (music volume, voice, sound effects, ambience with Light / Full under it),
   * Graphics Full / Lite / Classic (look.ts: saved, applied at the next page load), replay
   * the six words, then the build's version in full (version.ts versionLine). Switching course goes
   * through courses.ts (main.ts).
   */
  private settingsView(body: HTMLElement, back: () => void) {
    const { s } = this.game;
    const hooks = this.hooks.settings!;
    const cur = hooks.current();
    const row = (label: string, ...kids: (Node | string)[]) => el("div", { className: "set-row" }, el("div", { className: "set-label", textContent: label }), ...kids);
    const msg = el("p", { className: "set-msg" });
    const say = (text: string, bad = false) => {
      msg.textContent = text;
      msg.classList.toggle("err", bad);
    };
    const pick = <T extends { label: string }>(items: T[], on: (x: T) => boolean, choose: (x: T) => void, soon?: (x: T) => boolean) =>
      el(
        "div",
        { className: "set-options" },
        ...items.map((x) => {
          const b = el("button", { textContent: x.label, disabled: !!soon?.(x) });
          if (soon?.(x)) {
            b.classList.add("soon");
            b.title = s("settings-soon");
          }
          b.setAttribute("aria-pressed", String(on(x)));
          b.addEventListener("click", () => choose(x));
          return b;
        }),
      );
    const switchTo = async (course: string, learner: string) => {
      if (course === cur.course && learner === cur.learner) return;
      const err = await hooks.switchTo(course, learner);
      if (err) say(err, true);
      else this.menu.close();
    };
    const name = el("input", { value: cur.name, maxLength: 40, placeholder: s("name-placeholder"), autocomplete: "off" });
    const saveName = el("button", { textContent: s("settings-name-save") });
    saveName.dataset.sfx = "ui_confirm";
    saveName.addEventListener("click", () => {
      const err = hooks.setName(name.value);
      if (err) say(err, true);
      else say(s("settings-name-saved"));
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveName.click();
    });
    const music = el("input", { type: "range", min: "0", max: "100", step: "5", value: String(Math.round(cur.music * 100)) });
    music.setAttribute("aria-label", s("settings-music"));
    music.addEventListener("input", () => {
      hooks.setMusic(Number(music.value) / 100);
      this.hud?.refresh();
    });
    const ambienceBtn = el("button", {});
    const ambienceLabel = () => {
      const on = hooks.current().ambienceFull;
      ambienceBtn.textContent = s(on ? "settings-ambience-full" : "settings-ambience-light");
      ambienceBtn.setAttribute("aria-pressed", String(on));
      // Light / Full only matters while ambience plays
      ambienceBtn.disabled = !hooks.current().ambience;
    };
    ambienceLabel();
    ambienceBtn.addEventListener("click", () => {
      hooks.setAmbienceFull(!hooks.current().ambienceFull);
      ambienceLabel();
    });
    /** An On / Off switch for one bus; relabels itself (and `after` whatever depends on it). */
    const onOff = (get: () => boolean, set: (on: boolean) => void, after: () => void = () => {}) => {
      const b = el("button", {});
      const label = () => {
        b.textContent = s(get() ? "settings-sound-on" : "settings-sound-off");
        b.setAttribute("aria-pressed", String(get()));
      };
      label();
      b.addEventListener("click", () => {
        set(!get());
        label();
        after();
      });
      return b;
    };
    const voiceBtn = onOff(() => hooks.current().voice, (on) => hooks.setVoice(on));
    const sfxBtn = onOff(() => hooks.current().sfx, (on) => hooks.setSfx(on));
    const ambienceOn = onOff(() => hooks.current().ambience, (on) => hooks.setAmbience(on), ambienceLabel);
    // Graphics: Full / Lite / Classic, saved; a change applies when the page reloads (a toast and the line below say so)
    let graphics = cur.graphics;
    const graphicsRow = el(
      "div",
      { className: "set-options set-graphics" },
      ...TIERS.map((tier) => {
        const b = el("button", { textContent: s(`settings-graphics-${tier}`) });
        b.dataset.tier = tier;
        b.setAttribute("aria-pressed", String(tier === graphics));
        b.addEventListener("click", () => {
          graphics = tier;
          for (const x of graphicsRow.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x.dataset.tier === graphics));
          if (hooks.setGraphics(tier)) {
            say(s("settings-graphics-reload"));
            this.toast(s("settings-graphics-reload"), "note", 4000);
          } else say("");
        });
        return b;
      }),
    );
    // Frame rate (the real look only): 60 / 30, saved, at once
    const fpsRow =
      cur.fps === null
        ? null
        : el(
            "div",
            { className: "set-options set-fps" },
            ...FPS_CHOICES.map((f) => {
              const b = el("button", { textContent: s(`settings-fps-${f}`) });
              b.dataset.fps = String(f);
              b.setAttribute("aria-pressed", String(f === cur.fps));
              b.addEventListener("click", () => {
                hooks.setFps(f);
                for (const x of fpsRow!.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x.dataset.fps === String(f)));
              });
              return b;
            }),
          );
    const intro = el("button", { textContent: s("settings-intro") });
    intro.addEventListener("click", () => {
      this.menu.close();
      hooks.replayIntro();
    });
    const back2 = el("button", { className: "secondary", textContent: s("cancel") });
    back2.dataset.sfx = "ui_back";
    back2.addEventListener("click", back);
    body.replaceChildren(
      el("h3", { textContent: s("settings-title") }),
      el(
        "div",
        { className: "settings-body" },
        row(s("settings-reading"), pick(cur.learners, (x) => x.code === cur.learner, (x) => void switchTo(cur.course, x.code))),
        row(s("settings-course"), pick(cur.courses, (x) => x.id === cur.course, (x) => void switchTo(x.id, cur.learner), (x) => !!x.soon)),
        row(s("settings-name"), el("div", { className: "set-name" }, name, saveName)),
        row(s("settings-music"), music),
        row(s("settings-voice"), el("div", { className: "set-options" }, voiceBtn)),
        row(s("settings-sfx"), el("div", { className: "set-options" }, sfxBtn)),
        row(s("settings-ambience"), el("div", { className: "set-options" }, ambienceOn, ambienceBtn)),
        row(s("settings-graphics"), graphicsRow),
        ...(fpsRow ? [row(s("settings-fps"), fpsRow)] : []),
        el("div", { className: "set-options" }, intro),
        msg,
        versionLine(s),
      ),
      back2,
    );
  }

  private openName() {
    const { t, s } = this.game;
    const input = el("input", { maxLength: 20, placeholder: s("name-placeholder"), autocomplete: "off" });
    const err = el("p", { className: "err" });
    const form = el("form", {}, el("p", { textContent: t("name-prompt") }), input, el("button", { type: "submit", textContent: s("name-go") }), err);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.game.setName(input.value)) err.textContent = t("reject-bad-name");
    });
    this.nameForm.replaceChildren(form);
    this.nameForm.addEventListener("cancel", (e) => e.preventDefault(), { once: true });
    this.nameForm.showModal();
    input.focus();
  }

  /** Keyboard: 1-9 pick a reply / scene / tile, N notebook, M sound, R say again, Esc closes, E uses the prompt. True if the key was used. */
  key(e: KeyboardEvent): boolean {
    if (this.nameForm.open) return false;
    if (this.menu.open) return false; // its own inputs and buttons
    if (this.dayCardView.open) {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") this.dayCardView.close();
      return true;
    }
    if (this.notebook.open) {
      if (e.key === "Escape" || e.key.toLowerCase() === "n") this.notebook.close();
      return true;
    }
    const m = this.game.model;
    if (m.choices) {
      const n = Number(e.key) - 1;
      if (Number.isInteger(n) && n >= 0 && n < m.choices.items.length) this.game.choose(n);
      else if (e.key === "Escape") this.game.closeChoices();
      return true;
    }
    if (e.key.toLowerCase() === "n") {
      this.openNotebook();
      return true;
    }
    if (e.key === "Escape") {
      this.gloss.classList.add("hidden");
      if (m.bark) this.game.endBark();
      return true;
    }
    // The TUI's sound keys: M sound on / off, R says the bubble again.
    if (e.key.toLowerCase() === "m" && (m.hud.sound !== "none" || this.hooks.music)) {
      if (this.hooks.music) this.tapMusic();
      else this.toggleSound(m.hud.sound !== "on");
      return true;
    }
    if (e.key.toLowerCase() === "r" && m.bubble) {
      this.game.replay();
      return true;
    }
    return this.replies.key(e.key);
  }
}
