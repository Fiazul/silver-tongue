// The start flow (start/flow.ts) on a small fake DOM (test/fake-dom.ts): mounted, walked through
// title → speak → learn → name → intro, its result remembered through courses.ts (the settings key
// the browser TUI shares), the chrome following the reading language, the coming-soon cards, the
// core name rules; a returning player skipping it; the six intro words read against the course; the
// hint chip hidden by default in the intro card and in every bubble line; the locale tables naming
// only keys the English has.
import { beforeEach, describe, expect, it } from "vitest";
import { createCore, newGame, serialize, type CatalogEntry, type Course } from "@silver-tongue/core";
import { loadWebSettings, saveWebSettings, SETTINGS_KEY, type KeyValue } from "@silver-tongue/tui-web/src/web-storage";
import { UI_LOCALES } from "../locale";
import { applyStart, coursePath, rememberedStart, resumePick, type FetchJson } from "../src/courses";
import { mountStartFlow, nameProblem, type StartResult } from "../src/start/flow";
import { clipsFor, courseIntro, wordsIn } from "../src/start/intro";
import { CHROME_KEYS, makeStrings } from "../src/strings";
import { BubbleView } from "../src/ui/bubble";
import { fakeDocument, fire, installFakeDom, type FakeElement, type as typeInto } from "./fake-dom";
import { course } from "./helpers";

class FakeStorage implements KeyValue {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  keys() {
    return [...this.data.keys()];
  }
}

const entry: CatalogEntry = { id: course.id, language: course.language.code, setting: "china-city", learners: [course.learner], learnerNames: { [course.learner]: "English" } };

function server(files: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchJson: FetchJson = async <T>(path: string) => {
    asked.push(path);
    if (!(path in files)) throw new Error(`${path}: 404`);
    return structuredClone(files[path]) as T;
  };
  return { fetchJson, asked };
}

let root: FakeElement;
const $ = (sel: string) => root.querySelector(sel);
const $$ = (sel: string) => root.querySelectorAll(sel);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  const doc = installFakeDom();
  root = doc.createElement("div");
  doc.body.append(root);
});

describe("the start flow", () => {
  it("title → speak → learn → name → intro (skipped): the result, remembered as the browser TUI remembers a course", async () => {
    const kv = new FakeStorage();
    const { fetchJson } = server({ [coursePath(entry, course.learner)]: course });
    const sfx: string[] = [];
    const music: string[] = [];
    const said: string[] = [];
    const flow = mountStartFlow(root as unknown as HTMLElement, {
      catalog: [entry],
      comingSoon: ["ja", "ko", "es"],
      intro: async (pick) => courseIntro((await applyStart({ fetchJson, kv }, [entry], pick)).course),
      hooks: { sfx: (id) => sfx.push(id), music: (id) => music.push(id), say: (id) => said.push(id) },
    });
    expect(root.dataset.screen).toBe("title");
    expect($(".st-backdrop img")).not.toBeNull();
    // Tap to start: the music starts on this first gesture, once.
    $(".st-title")!.click();
    expect(music).toEqual(["title_theme"]);
    expect(root.dataset.screen).toBe("speak");
    // One reading language: its card is already chosen.
    const speak = $$(".st-card");
    expect(speak).toHaveLength(1);
    expect(speak[0].getAttribute("aria-checked")).toBe("true");
    $(".st-next")!.click();
    expect(root.dataset.screen).toBe("learn");
    // The course, chosen (the only one for that reader), and three greyed coming-soon cards.
    const cards = $$(".st-card");
    expect(cards.map((c) => c.dataset.value)).toEqual([entry.id, "soon:ja", "soon:ko", "soon:es"]);
    expect(cards[0].getAttribute("aria-checked")).toBe("true");
    expect($$(".st-card.soon")).toHaveLength(3);
    $$(".st-card.soon")[0].click(); // can't be picked
    expect(cards[0].getAttribute("aria-checked")).toBe("true");
    $(".st-next")!.click();
    expect(root.dataset.screen).toBe("name");
    // Empty: an error after Continue; too long: an error as typed (core's 20 code points).
    $(".st-next")!.click();
    expect($("#st-name-msg")!.textContent).toBe("Type a name first.");
    typeInto($("#st-name")!, "x".repeat(21));
    expect($("#st-name-msg")!.textContent).toBe("Keep it to 20 characters.");
    expect(($(".st-next") as unknown as HTMLButtonElement).disabled).toBe(true);
    typeInto($("#st-name")!, "  Mina  ");
    $(".st-next")!.click();
    await flush();
    await flush();
    expect(root.dataset.screen).toBe("intro");
    // The meaning hides under the chip until tapped.
    const chip = $(".st-word .hint-chip")!;
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    chip.click();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.querySelector(".hint-slip")!.textContent).toBe("hello");
    $(".st-say")!.click();
    expect(said).toEqual(["ni-hao"]);
    $(".st-skip")!.click();
    const r: StartResult = await flow.result;
    expect(r).toEqual({ learner: course.learner, course: entry.id, name: "Mina", skippedIntro: true });
    expect(sfx).toContain("ui_confirm");
    expect(sfx).toContain("ui_reveal");
    expect(loadWebSettings(kv)).toEqual({ course: course.id, learner: course.learner });
    flow.destroy();
    expect(root.childNodes).toHaveLength(0);
  });

  it("the chrome follows the reading language picked on I speak…; Escape goes back", () => {
    const two: CatalogEntry = { ...entry, learners: [course.learner, "bn"], learnerNames: { [course.learner]: "English", bn: "বাংলা" } };
    const flow = mountStartFlow(root as unknown as HTMLElement, { catalog: [two] });
    fire(fakeDocument, "keydown", { key: "Enter" }); // any key starts
    expect(root.dataset.screen).toBe("speak");
    // Two readers, neither remembered: the browser's language is preselected (English here).
    expect($$(".st-card")[0].getAttribute("aria-checked")).toBe(String(navigator.language.startsWith(course.learner)));
    $$(".st-card")[1].click();
    expect(root.getAttribute("lang")).toBe("bn");
    expect($(".st-h")!.textContent).toBe(UI_LOCALES.bn.start["speak.title"]);
    fire(fakeDocument, "keydown", { key: "Escape" });
    expect(root.dataset.screen).toBe("title");
    flow.destroy();
  });

  it("a remembered learner, course and name are preselected; replaying the intro alone resolves on Begin", async () => {
    const intro = courseIntro(course)!;
    const flow = mountStartFlow(root as unknown as HTMLElement, { catalog: [entry], intro, startAt: "intro", remembered: { learner: course.learner, course: entry.id, name: "Rafi" } });
    expect(root.dataset.screen).toBe("intro");
    for (let i = 1; i < intro.words.length; i++) $(".st-next")!.click();
    expect($(".st-next")!.textContent).toBe("Begin");
    $(".st-next")!.click();
    expect(await flow.result).toEqual({ learner: course.learner, course: entry.id, name: "Rafi", skippedIntro: false });
  });

  it("names follow core's cleanName", () => {
    expect(nameProblem("")).toBe("name.errEmpty");
    expect(nameProblem("   ")).toBe("name.errEmpty");
    expect(nameProblem("a".repeat(20))).toBeNull();
    expect(nameProblem("a".repeat(21))).toBe("name.errLong");
    expect(nameProblem("a​b")).toBe("name.errChars");
    expect(nameProblem("")).toBe("name.errChars");
  });
});

describe("the start flow's courses", () => {
  it("a returning player (a saved game for the remembered course) goes straight in; no save: the flow", async () => {
    const kv = new FakeStorage();
    const { fetchJson } = server({ [coursePath(entry, course.learner)]: course });
    const deps = { fetchJson, kv, now: () => 1_000 };
    expect(await resumePick(deps, [entry])).toBeNull();
    const st = newGame(course);
    createCore(course, st, { now: () => 1, rng: () => 0.5 }).send({ type: "setName", name: "Mina" });
    kv.setItem(`silver-tongue:${course.id}:session:s1`, serialize(st));
    const picked = await resumePick(deps, [entry]);
    expect(picked?.course.id).toBe(course.id);
    expect(JSON.parse(kv.getItem(SETTINGS_KEY)!)).toEqual({ course: course.id, learner: course.learner });
  });

  it("remembers what the flow preselects; a course that doesn't load is not remembered", async () => {
    const kv = new FakeStorage();
    saveWebSettings(kv, { course: entry.id, learner: course.learner });
    expect(rememberedStart(kv)).toEqual({ course: entry.id, learner: course.learner });
    const other: CatalogEntry = { ...entry, id: "xx-test" };
    const { fetchJson } = server({});
    await expect(applyStart({ fetchJson, kv }, [entry, other], { course: "xx-test", learner: course.learner })).rejects.toThrow();
    expect(loadWebSettings(kv).course).toBe(entry.id);
  });

  it("the six words are read against the course: meanings in the reading language, clips from its words", () => {
    const intro = courseIntro(course as Course)!;
    expect(intro.words).toHaveLength(6);
    for (const w of intro.words) {
      expect(w.meaning?.[course.learner], w.id).toBeTruthy();
      expect(clipsFor(course, w.text).length, w.id).toBeGreaterThan(0);
    }
    expect(wordsIn(course, "多少钱").map((w) => w.w)).toEqual(["多少", "钱"]);
  });
});

describe("the hint chip in the bubble", () => {
  it("every line's meaning is there, hidden, until tapped; it plays ui_reveal; the bubble plays open / close", () => {
    const sfx: string[] = [];
    const s = makeStrings(Object.assign((id: string) => id, { has: () => false }) as never);
    const view = new BubbleView(course, s, { onWord: () => {}, onSentence: () => {}, onReplay: () => {}, sfx: (id) => sfx.push(id) });
    const line = Object.values(course.scenes[0].exchanges[0].variants)[0].npc;
    expect(line.meaning).toBeTruthy();
    view.render({ seq: 1, npc: "wang", npcName: "Old Wang", line, kind: "line", slow: false, fresh: [], audio: [] });
    const node = view.node as unknown as FakeElement;
    const chip = node.querySelector(".bubble-line .hint-chip")!;
    expect(chip).not.toBeNull();
    expect(chip.classList.contains("inline")).toBe(true);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.querySelector(".hint-slip")!.textContent).toBe(line.meaning);
    chip.click();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    chip.click();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    view.render(null);
    expect(sfx).toEqual(["bubble_open", "ui_reveal", "bubble_close"]);
  });
});

describe("locale tables", () => {
  it("bn and zh name only keys English has (start flow and chrome), with the same {slots}", () => {
    const slots = (v: unknown) => (typeof v === "string" ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort() : []);
    const en = UI_LOCALES.en.start;
    const chrome = makeStrings(Object.assign((id: string) => id, { has: () => false }) as never);
    for (const lang of ["bn", "zh"]) {
      const L = UI_LOCALES[lang];
      for (const [k, v] of Object.entries(L.start)) {
        expect(en, `${lang} start ${k}`).toHaveProperty([k]);
        expect(slots(v), `${lang} start ${k}`).toEqual(slots(en[k]));
      }
      for (const [k, v] of Object.entries(L.game ?? {})) {
        expect(CHROME_KEYS, `${lang} game ${k}`).toContain(k);
        expect(slots(v), `${lang} game ${k}`).toEqual(slots(chrome(k)));
      }
      // the guide and settings are covered in full
      for (const k of CHROME_KEYS.filter((x) => x.startsWith("guide-") || x.startsWith("settings"))) expect(L.game, `${lang} ${k}`).toHaveProperty([k]);
    }
    // a key bn lacks falls back to English
    const bn = makeStrings(Object.assign((id: string) => id, { has: () => false }) as never, "bn");
    expect(bn("obj-name")).toBe("Tell them your name");
    expect(bn("guide-reply")).toBe(UI_LOCALES.bn.game!["guide-reply"]);
  });
});
