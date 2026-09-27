// The hint chip (design/start HintChip): a tiny "?" that opens into a paper slip with the native
// meaning. Hidden by default everywhere it is used (the intro cards, every dialogue line in the
// bubble, every reply option): the learner looks only when they need to. A second tap closes it, and
// it closes by itself after 6 s. Opening plays `ui_reveal` (sfx hook) and calls `onReveal`.
// The visible chip is 30 px (24 px inline), its hit area 48 px (start.css).
import * as S from "./strings";

export const HINT_COLLAPSE_MS = 6000;

export interface HintChipOptions {
  /** the UI language (its aria labels) */
  lang?: string;
  sfx?: (id: string) => void;
  /** smaller, sits inside a dialogue line */
  inline?: boolean;
  onReveal?: (text: string) => void;
}

export interface HintChipControl {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export type HintChipElement = HTMLButtonElement & { hintChip: HintChipControl };

function safe(fn: ((...a: never[]) => void) | undefined, ...args: unknown[]) {
  if (typeof fn !== "function") return;
  try {
    (fn as (...a: unknown[]) => void)(...args);
  } catch (e) {
    console.warn("hint chip hook failed:", e);
  }
}

/** Wires a `.hint-chip` button (its `data-hint` is the text). */
export function wireHintChip(b: HTMLButtonElement, opts: HintChipOptions = {}): HintChipElement {
  const lang = opts.lang ?? document.documentElement.lang;
  const text = b.getAttribute("data-hint") ?? "";
  b.setAttribute("data-wired", "");
  b.type = "button";
  const q = document.createElement("span");
  q.className = "hint-q";
  q.setAttribute("aria-hidden", "true");
  q.textContent = "?";
  const slip = document.createElement("span");
  slip.className = "hint-slip";
  slip.textContent = text;
  b.replaceChildren(q, slip);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = false;
  const set = (on: boolean) => {
    clearTimeout(timer);
    open = on;
    b.setAttribute("aria-expanded", String(on));
    b.setAttribute("aria-label", on ? `${S.t(lang, "hint.hide")}: ${text}` : S.t(lang, "hint.show"));
    if (on) timer = setTimeout(() => set(false), HINT_COLLAPSE_MS);
  };
  set(false);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !open;
    set(next);
    if (next) {
      safe(opts.sfx, "ui_reveal");
      safe(opts.onReveal, text);
    }
  });
  const chip = b as HintChipElement;
  chip.hintChip = {
    open: () => set(true),
    close: () => set(false),
    get isOpen() {
      return open;
    },
  };
  return chip;
}

/** A new chip holding `text`, closed. */
export function createHintChip(text: string, opts: HintChipOptions = {}): HintChipElement {
  const b = document.createElement("button");
  b.className = "hint-chip" + (opts.inline ? " inline" : "");
  b.setAttribute("data-hint", text);
  return wireHintChip(b, opts);
}

/** Upgrades every un-wired `.hint-chip[data-hint]` under `root` (static markup). */
export function enhanceHintChips(root: ParentNode, opts: HintChipOptions = {}) {
  for (const b of root.querySelectorAll<HTMLButtonElement>(".hint-chip[data-hint]:not([data-wired])")) wireHintChip(b, opts);
}
