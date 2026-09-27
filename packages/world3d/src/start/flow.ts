// The start flow (design/start/start.js ported to a TS module): title (Ken Burns over the
// fly-over's frames, "Tap to start": the first gesture, so music may play) → "I speak…" (the
// reading language; the chrome switches to it) → "I want to learn…" (courses for that reader, plus
// greyed "coming soon" ones) → name (core cleanName rules, 6 suggestions) → the six-word intro
// (skippable, each meaning hidden under a hint chip) → `start:done`. The game (main.ts) remembers
// the result (courses.ts applyStart) and takes over; `startAt: "intro"` replays the words only
// (Settings). No framework; styles in start.css (the game's one UI skin).
import { cleanName, MAX_NAME_LENGTH, PLAYER_MARK, type CatalogEntry } from "@silver-tongue/core";
import { FALLBACK_UI, type IntroData } from "../../locale";
import { createHintChip } from "./hint-chip";
import * as S from "./strings";

export interface StartHooks {
  /** ui_tap, ui_confirm, ui_back, ui_reveal, ui_page */
  sfx?: (id: string) => void;
  /** title_theme, once, at the first tap / key on the title */
  music?: (id: string) => void;
  /** an intro word's Listen button */
  say?: (wordId: string) => void;
}

export interface StartResult {
  learner: string;
  /** the catalog entry id */
  course: string;
  /** already cleaned (core cleanName) */
  name: string;
  skippedIntro: boolean;
}

export type IntroSource = IntroData | ((pick: { learner: string; course: string }) => Promise<IntroData | null | undefined>);

export interface StartConfig {
  catalog: CatalogEntry[];
  /** all optional; invalid values ignored */
  remembered?: { learner?: string; course?: string; name?: string };
  /** languages (or {language, setting}) greyed as "coming soon"; ones the catalog has are skipped */
  comingSoon?: (string | { language: string; setting?: string })[];
  /** the six words, or a loader called with the pick once the name is in */
  intro?: IntroSource;
  hooks?: StartHooks;
  /** prefix for backdrop paths */
  assetBase?: string;
  backdrop?: string[];
  /** show the "Welcome" card after start:done (the standalone demo); the game takes over at once */
  showDone?: boolean;
  /** "intro": the six words only (Settings → Replay), learner and course from `remembered` */
  startAt?: "title" | "intro";
  /** the chrome in this UI language whatever the pick (the `?ui=` preview) */
  uiOverride?: string;
}

export interface StartFlow {
  result: Promise<StartResult>;
  readonly state: { screen: string; learner: string | null; course: string | null; name: string };
  destroy(): void;
}

/** Why a name fails core's cleanName, as a strings key; null when it passes. */
export function nameProblem(name: string): string | null {
  const n = String(name).trim();
  if (!n) return "name.errEmpty";
  if ([...n].length > MAX_NAME_LENGTH) return "name.errLong";
  if (/[\p{Cc}\p{Cf}]/u.test(n) || n.includes(PLAYER_MARK)) return "name.errChars";
  return null;
}

export const DEFAULT_FRAMES = ["f002.jpg", "f004.jpg", "f005.jpg", "f006.jpg", "f009.jpg", "f010.jpg"];
const FRAME_MS = 8000;
const STEPS = ["speak", "learn", "name", "intro"] as const;

type Props = Record<string, unknown>;
/** A tiny DOM helper: className, text, html (constant SVG only), on<event>, dataset, attributes. */
function h(tag: string, props: Props | null, ...kids: unknown[]): HTMLElement {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") n.className = String(v);
      else if (k === "text") n.textContent = String(v);
      else if (k === "html") n.innerHTML = String(v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v as EventListener);
      else if (k === "dataset") Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid as Node | string);
  return n;
}

const SVG_SPEAKER =
  '<svg class="st-ico" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_BACK =
  '<svg class="st-ico" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_NEXT =
  '<svg class="st-ico" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function safeHook(fn: ((id: string) => void) | undefined, id: string) {
  if (typeof fn !== "function") return;
  try {
    fn(id);
  } catch (e) {
    console.warn("start flow hook failed:", e);
  }
}

/** The "I speak…" list: every reading language across the catalog, catalog order. */
export function learnersOf(catalog: CatalogEntry[]): string[] {
  const out: string[] = [];
  for (const e of catalog) for (const l of e.learners) if (!out.includes(l)) out.push(l);
  return out;
}

/** Mounts the flow into `root` (it takes the whole element). */
export function mountStartFlow(root: HTMLElement, config: StartConfig): StartFlow {
  const catalog = (config.catalog ?? []).filter((e) => e && e.id && Array.isArray(e.learners) && e.learners.length);
  if (!catalog.length) throw new Error("mountStartFlow: config.catalog needs at least one course");
  const hooks = config.hooks ?? {};
  const sfx = (id: string) => safeHook(hooks.sfx, id);
  const comingSoon = (config.comingSoon ?? []).map((c) => (typeof c === "string" ? { language: c } : c)).filter((c) => c && c.language);
  const frames = (config.backdrop ?? DEFAULT_FRAMES).map((p) => (/^(https?:|data:|\/)/.test(p) ? p : (config.assetBase ?? "") + p));
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const learners = learnersOf(catalog);
  const learnerNames: Record<string, string> = {};
  for (const e of catalog) for (const l of e.learners) if (!learnerNames[l] && e.learnerNames?.[l]) learnerNames[l] = e.learnerNames[l];
  const rem = config.remembered ?? {};
  const browserLang = ((typeof navigator !== "undefined" && navigator.language) || "").slice(0, 2);
  const onlyIntro = config.startAt === "intro";
  const state = {
    screen: onlyIntro ? "intro" : "title",
    learner: (rem.learner && learners.includes(rem.learner) ? rem.learner : learners.length === 1 ? learners[0] : learners.includes(browserLang) ? browserLang : null) as string | null,
    course: null as string | null,
    name: typeof rem.name === "string" ? rem.name : "",
    suggestIx: -1,
    word: 0,
    dir: 1,
    seen: new Set([0]),
    musicStarted: false,
    done: false,
    busy: false,
  };
  let intro: IntroData = typeof config.intro === "object" && config.intro ? config.intro : { language: "", words: [] };
  const coursesFor = (learner: string | null) => (learner ? catalog.filter((e) => e.learners.includes(learner)) : []);
  const pickCourse = () => {
    const list = coursesFor(state.learner);
    if (list.some((e) => e.id === state.course)) return;
    state.course = list.some((e) => e.id === rem.course) ? rem.course! : list.length === 1 ? list[0].id : null;
  };
  pickCourse();
  const uiLang = () => {
    if (config.uiOverride && S.languages.includes(config.uiOverride)) return config.uiOverride;
    const l = state.learner ?? learners[0];
    return S.languages.includes(l) ? l : FALLBACK_UI;
  };
  const t = (key: string, vars?: Record<string, string | number>) => S.t(uiLang(), key, vars);
  const entry = () => catalog.find((e) => e.id === state.course) ?? catalog.find((e) => e.id === rem.course) ?? catalog[0];
  const settingText = (setting: string, part: string) => (S.has(uiLang(), `setting.${setting}.${part}`) ? t(`setting.${setting}.${part}`) : setting);
  const langName = (code: string) => (S.has(uiLang(), `lang.${code}`) ? t(`lang.${code}`) : (S.NATIVE_NAMES[code] ?? code));
  const ownName = (code: string) => learnerNames[code] ?? S.NATIVE_NAMES[code] ?? code;

  let resolveResult!: (r: StartResult) => void;
  const result = new Promise<StartResult>((r) => (resolveResult = r));
  const cleanups: (() => void)[] = [];

  root.classList.add("st-root");
  root.replaceChildren();
  const backdrop = h("div", { className: "st-backdrop", "aria-hidden": "true" });
  const stage = h("div", { className: "st-stage" });
  root.append(backdrop, stage);

  // ---- backdrop: slow Ken Burns over the fly-over's frames ----
  const imgs = [h("img", { alt: "", decoding: "async" }), h("img", { alt: "", decoding: "async" })] as HTMLImageElement[];
  backdrop.append(...imgs);
  let frameIx = 0;
  let front = 0;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  const showFrame = () => {
    const img = imgs[front];
    const kb = frameIx % 2 ? "kb-b" : "kb-a";
    img.onload = () => {
      img.className = "on " + kb;
      imgs[1 - front].classList.remove("on");
      front = 1 - front;
    };
    img.className = "";
    img.src = frames[frameIx % frames.length];
    frameIx++;
    if (!reduced && frames.length > 1 && typeof Image !== "undefined") new Image().src = frames[frameIx % frames.length];
  };
  if (frames.length) {
    showFrame();
    if (!reduced && frames.length > 1) frameTimer = setInterval(showFrame, FRAME_MS);
  }
  cleanups.push(() => clearInterval(frameTimer));

  // ---- screens ----
  const go = (screen: string, dir = 1) => {
    state.screen = screen;
    state.dir = dir;
    render();
  };
  const back = () => {
    sfx("ui_back");
    if (onlyIntro) return finish(true);
    const i = (STEPS as readonly string[]).indexOf(state.screen);
    go(i <= 0 ? "title" : STEPS[i - 1], -1);
  };

  function bar(): HTMLElement {
    const i = (STEPS as readonly string[]).indexOf(state.screen);
    return h(
      "div",
      { className: "st-bar" },
      h("button", { type: "button", className: "st-btn ghost icon", "aria-label": t("common.back"), html: SVG_BACK, onclick: back }),
      onlyIntro ? null : h("span", { className: "st-step", text: t("common.step", { n: i + 1, total: STEPS.length }) }),
    );
  }
  function panel(screenClass: string, headingId: string, ...kids: unknown[]): HTMLElement {
    return h("section", { className: `st-screen ${screenClass}`, "aria-labelledby": headingId }, h("div", { className: "st-panel" }, ...kids));
  }

  interface CardItem {
    value: string;
    name: string;
    own?: string | null;
    ownLang?: string;
    sub?: string | null;
    soon?: boolean;
    cardLang?: string;
  }
  /** A radiogroup of cards. Arrow keys move and select. */
  function cardGroup(labelId: string, items: CardItem[], selected: string | null, onPick: (v: string, byKey?: boolean) => void): HTMLElement {
    const group = h("div", { className: "st-cards" + (items.length > 1 ? " two" : ""), role: "radiogroup", "aria-labelledby": labelId });
    const live = items.filter((it) => !it.soon);
    const buttons = items.map((it) => {
      const checked = !it.soon && it.value === selected;
      const b = h(
        "button",
        {
          type: "button",
          className: "st-card" + (it.soon ? " soon" : ""),
          role: "radio",
          "aria-checked": String(checked),
          "aria-disabled": it.soon ? "true" : null,
          dataset: { value: it.value },
          lang: it.cardLang ?? null,
        },
        h("span", { className: "st-card-name" }, it.name, it.own ? h("span", { className: "st-card-own", lang: it.ownLang ?? null, text: it.own }) : null),
        it.sub ? h("span", { className: "st-card-sub", text: it.sub }) : null,
        it.soon ? h("span", { className: "st-tag", text: t("learn.soon") }) : null,
      );
      b.tabIndex = it.soon ? -1 : checked || (!selected && it === live[0]) ? 0 : -1;
      if (!it.soon)
        b.addEventListener("click", () => {
          sfx("ui_tap");
          onPick(it.value);
        });
      return b;
    });
    group.addEventListener("keydown", (e) => {
      const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const vals = live.map((it) => it.value);
      const active = document.activeElement as HTMLElement | null;
      const cur = vals.indexOf(active?.dataset?.value ?? selected ?? "");
      const next = vals[(cur + keys[e.key] + vals.length) % vals.length];
      sfx("ui_tap");
      onPick(next, true);
    });
    group.append(...buttons);
    return group;
  }

  function titleScreen(): HTMLElement {
    const start = () => {
      if (state.screen !== "title") return;
      sfx("ui_confirm");
      if (!state.musicStarted) {
        state.musicStarted = true;
        safeHook(hooks.music, "title_theme");
      }
      go("speak");
    };
    const e = entry();
    const s = h(
      "section",
      { className: "st-screen st-title", role: "button", tabindex: "0", "aria-label": t("title.tap"), onclick: start },
      h("div", { className: "st-logo" }, h("h1", { text: t("game.title") }), h("div", { className: "st-seal", text: settingText(e.setting, "title") })),
      h("div", { className: "st-tap", "aria-hidden": "true", text: t("title.tap") }),
    );
    (s as HTMLElement & { startFlow?: () => void }).startFlow = start;
    return s;
  }

  function speakScreen(): HTMLElement {
    const items: CardItem[] = learners.map((l) => ({ value: l, name: ownName(l), cardLang: l, sub: ownName(l) !== langName(l) ? langName(l) : null }));
    const cont = h("button", {
      type: "button",
      className: "st-btn primary st-next",
      text: t("common.continue"),
      disabled: !state.learner,
      onclick: () => {
        sfx("ui_confirm");
        go("learn");
      },
    });
    return panel(
      "st-speak",
      "st-h-speak",
      bar(),
      h("h2", { className: "st-h", id: "st-h-speak", tabindex: "-1", text: t("speak.title") }),
      h("p", { className: "st-lead", text: t("speak.hint") }),
      h(
        "div",
        { className: "st-panel-body" },
        cardGroup("st-h-speak", items, state.learner, (v, byKey) => {
          state.learner = v;
          pickCourse();
          render(byKey ? "card" : "keep");
        }),
      ),
      h("div", { className: "st-foot" }, cont),
    );
  }

  function learnScreen(): HTMLElement {
    const list = coursesFor(state.learner);
    const have = new Set(list.map((e) => e.language));
    const own = (lang: string) => (S.NATIVE_NAMES[lang] && S.NATIVE_NAMES[lang] !== langName(lang) ? S.NATIVE_NAMES[lang] : null);
    const items: CardItem[] = list.map((e) => ({ value: e.id, name: langName(e.language), sub: settingText(e.setting, "place"), own: own(e.language), ownLang: e.language }));
    for (const c of comingSoon) {
      if (have.has(c.language)) continue;
      have.add(c.language);
      items.push({ value: "soon:" + c.language, soon: true, name: langName(c.language), own: own(c.language), ownLang: c.language, sub: c.setting ? settingText(c.setting, "place") : null });
    }
    const cont = h("button", {
      type: "button",
      className: "st-btn primary st-next",
      text: t("common.continue"),
      disabled: !state.course,
      onclick: () => {
        sfx("ui_confirm");
        go("name");
      },
    });
    return panel(
      "st-learn",
      "st-h-learn",
      bar(),
      h("h2", { className: "st-h", id: "st-h-learn", tabindex: "-1", text: t("learn.title") }),
      h("p", { className: "st-lead", text: t("learn.hint") }),
      h(
        "div",
        { className: "st-panel-body" },
        list.length ? null : h("p", { className: "st-empty", text: t("learn.none") }),
        cardGroup("st-h-learn", items, state.course, (v, byKey) => {
          state.course = v;
          render(byKey ? "card" : "keep");
        }),
      ),
      h("div", { className: "st-foot" }, cont),
    );
  }

  function nameScreen(): HTMLElement {
    const input = h("input", {
      className: "st-input",
      id: "st-name",
      type: "text",
      autocomplete: "nickname",
      autocapitalize: "words",
      spellcheck: "false",
      enterkeyhint: "done",
      "aria-describedby": "st-name-msg",
    }) as HTMLInputElement;
    input.value = state.name;
    const count = h("span", { "aria-hidden": "true" });
    const msg = h("span", { id: "st-name-msg", className: "st-err", "aria-live": "polite" });
    const cont = h("button", { type: "button", className: "st-btn primary st-next", text: t("common.continue") }) as HTMLButtonElement;
    let tried = false;
    const check = () => {
      state.name = input.value;
      const problem = nameProblem(input.value);
      const len = [...input.value.trim()].length;
      count.textContent = t("name.count", { n: len, max: MAX_NAME_LENGTH });
      const show = problem && (tried || problem !== "name.errEmpty");
      msg.textContent = show ? t(problem, { max: MAX_NAME_LENGTH }) : "";
      input.setAttribute("aria-invalid", String(!!show));
      cont.disabled = state.busy || (!!problem && problem !== "name.errEmpty");
      return problem;
    };
    const submit = async () => {
      tried = true;
      if (state.busy) return;
      if (check()) return input.focus();
      state.name = cleanName(input.value)!;
      input.value = state.name;
      sfx("ui_confirm");
      if (typeof config.intro === "function") {
        state.busy = true;
        check();
        try {
          intro = (await config.intro({ learner: state.learner!, course: state.course! })) ?? { language: "", words: [] };
        } catch (e) {
          console.warn("start flow: no intro words", e);
          intro = { language: "", words: [] };
        }
        state.busy = false;
        if (state.screen !== "name") return;
      }
      if (intro.words.length) go("intro");
      else finish(true);
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
    cont.addEventListener("click", () => void submit());
    const suggestions = S.list(uiLang(), "name.suggestions");
    const suggest = h("button", {
      type: "button",
      className: "st-btn",
      text: t("name.suggest"),
      onclick: () => {
        sfx("ui_tap");
        if (!suggestions.length) return;
        do state.suggestIx = (state.suggestIx + 1) % suggestions.length;
        while (suggestions.length > 1 && suggestions[state.suggestIx] === input.value);
        input.value = suggestions[state.suggestIx];
        check();
      },
    });
    check();
    return panel(
      "st-name",
      "st-h-name",
      bar(),
      h("h2", { className: "st-h", id: "st-h-name", tabindex: "-1", text: t("name.title") }),
      h("p", { className: "st-lead", text: t("name.hint") }),
      h(
        "div",
        { className: "st-panel-body" },
        h("div", { className: "st-field" }, h("label", { className: "st-label", for: "st-name", text: t("name.label") }), input, h("div", { className: "st-field-row" }, msg, count)),
        h("div", null, suggest),
      ),
      h("div", { className: "st-foot" }, cont),
    );
  }

  function introScreen(): HTMLElement {
    const words = intro.words;
    const i = Math.min(state.word, words.length - 1);
    const w = words[i];
    const learner = state.learner ?? "";
    const meaning = (w.meaning && (w.meaning[learner] ?? Object.values(w.meaning)[0])) || "";
    const last = i === words.length - 1;
    const language = intro.language || undefined;
    const page = (to: number) => {
      if (to < 0 || to >= words.length || to === state.word) return;
      sfx("ui_page");
      state.dir = to > state.word ? 1 : -1;
      state.word = to;
      state.seen.add(to);
      render("intro");
    };
    const card = h(
      "div",
      { className: "st-word" + (state.dir < 0 ? " back" : ""), role: "group", "aria-roledescription": "card", "aria-label": t("intro.progress", { n: i + 1, total: words.length }) },
      h("div", { className: "st-hanzi", lang: language ?? null, text: w.text }),
      h("div", { className: "st-reading", lang: language ? `${language}-Latn` : null, text: w.reading ?? "" }),
      h(
        "button",
        { type: "button", className: "st-btn st-say", "aria-label": `${t("intro.listen")}: ${w.reading ?? w.text}`, onclick: () => safeHook(hooks.say, w.id) },
        h("span", { html: SVG_SPEAKER }),
        h("span", { text: t("intro.listen") }),
      ),
      meaning ? createHintChip(meaning, { lang: uiLang(), sfx: hooks.sfx }) : null,
    );
    let x0: number | null = null;
    card.addEventListener("pointerdown", (e) => {
      x0 = (e as PointerEvent).clientX;
    });
    card.addEventListener("pointerup", (e) => {
      if (x0 === null) return;
      const dx = (e as PointerEvent).clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 50) page(state.word + (dx < 0 ? 1 : -1));
    });
    const dots = h(
      "div",
      { className: "st-dots", role: "group", "aria-label": t("intro.title") },
      words.map((_, j) =>
        h("button", {
          type: "button",
          className: "st-dot" + (state.seen.has(j) ? " seen" : ""),
          "aria-current": j === i ? "step" : null,
          "aria-label": t("intro.progress", { n: j + 1, total: words.length }),
          onclick: () => page(j),
        }),
      ),
    );
    const prev = h("button", { type: "button", className: "st-btn icon", "aria-label": t("intro.prev"), html: SVG_BACK, disabled: i === 0, onclick: () => page(i - 1) });
    const next = last
      ? h("button", { type: "button", className: "st-btn primary st-next", text: t("intro.begin"), onclick: () => finish(false) })
      : h("button", { type: "button", className: "st-btn primary st-next", onclick: () => page(i + 1) }, h("span", { text: t("intro.next") }), h("span", { html: SVG_NEXT }));
    const topBar = bar();
    topBar.append(h("button", { type: "button", className: "st-btn st-skip", text: t("intro.skip"), onclick: () => finish(true) }));
    const s = panel(
      "st-intro",
      "st-h-intro",
      topBar,
      h("h2", { className: "st-h", id: "st-h-intro", tabindex: "-1", text: t("intro.title") }),
      h("p", { className: "st-tip", text: t("intro.tip") }),
      card,
      dots,
      h("div", { className: "st-foot" }, prev, next),
    );
    s.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        page(state.word + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        page(state.word - 1);
      }
    });
    return s;
  }

  function doneScreen(): HTMLElement {
    const e = entry();
    return panel(
      "st-done",
      "st-h-done",
      h("h2", { className: "st-h", id: "st-h-done", tabindex: "-1", text: t("done.title", { name: state.name }) }),
      h("p", { className: "st-lead", text: t("done.sub", { place: settingText(e.setting, "place") }) }),
    );
  }

  function finish(skipped: boolean) {
    if (state.done) return;
    state.done = true;
    sfx("ui_confirm");
    const out: StartResult = { learner: state.learner ?? learners[0], course: state.course ?? entry().id, name: cleanName(state.name) ?? "", skippedIntro: !!skipped };
    document.dispatchEvent(new CustomEvent("start:done", { detail: out }));
    resolveResult(out);
    if (config.showDone) go("done");
  }

  const builders: Record<string, () => HTMLElement> = { title: titleScreen, speak: speakScreen, learn: learnScreen, name: nameScreen, intro: introScreen, done: doneScreen };
  let current: HTMLElement | null = null;
  /** Re-renders the current screen. focus: "screen" (new screen), "card" / "keep" (the checked card), "intro". */
  function render(focus: "screen" | "card" | "keep" | "intro" = "screen") {
    root.setAttribute("lang", uiLang());
    root.dataset.screen = state.screen;
    const prevActive = document.activeElement as HTMLElement | null;
    const keepValue = prevActive?.dataset?.value ?? null;
    const node = builders[state.screen]();
    if (focus !== "screen") node.style.animation = "none"; // same screen re-rendered: no enter animation
    if (current) current.replaceWith(node);
    else stage.append(node);
    current = node;
    const cards = () => [...node.querySelectorAll<HTMLElement>(".st-card")];
    let target: HTMLElement | null | undefined = null;
    if (focus === "card" || focus === "keep") target = cards().find((c) => c.getAttribute("aria-checked") === "true") ?? cards().find((c) => c.dataset.value === keepValue);
    else if (focus === "intro") target = node.querySelector<HTMLElement>(".st-next");
    else if (state.screen === "title") target = node;
    else if (state.screen === "name") target = node.querySelector<HTMLElement>("#st-name");
    else target = cards().find((c) => c.getAttribute("aria-checked") === "true") ?? node.querySelector<HTMLElement>(".st-next") ?? node.querySelector<HTMLElement>(".st-h");
    target?.focus({ preventScroll: true });
  }

  // Keys: any key starts from the title; Escape goes back.
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (state.screen === "title") {
      if (["Shift", "Control", "Alt", "Meta", "Tab"].includes(e.key)) return;
      e.preventDefault();
      (current as HTMLElement & { startFlow?: () => void }).startFlow?.();
    } else if (e.key === "Escape" && (STEPS as readonly string[]).includes(state.screen)) {
      e.preventDefault();
      back();
    }
  };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));

  if (onlyIntro && !intro.words.length) finish(true);
  else render();
  return {
    result,
    state,
    destroy() {
      for (const c of cleanups) c();
      root.replaceChildren();
      root.classList.remove("st-root");
    },
  };
}
