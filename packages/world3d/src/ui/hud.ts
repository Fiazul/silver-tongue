// HUD: day, wallet, slots left today, rank, where you are, the parcel you carry, the ♪ chip
// (with the page's mixer, `music`: the music only, off / back to its volume, prefs.ts musicTap;
// voices, effects and ambience have their own switches in Settings; without it: core's sound on /
// off, as the TUI's [m]); under it the objective card: step n/N of today, the objective
// line, or the first-steps guide's step while there is one (guide.ts), tagged "Guide"; the next
// step greyed; "Take me there" (wayfind.ts, main.ts).
import type { Hud } from "../game";
import type { GuideStep } from "../guide";
import type { Objective } from "../objective";
import type { Strings } from "../strings";
import { versionTag } from "../version";
import { el } from "./dom";
import { icon } from "./icons";

/** The phone HUD's guide line folds to its "Step n/N" pill this long after its step changes (ms). */
export const GUIDE_FOLD_MS = 6000;

/** Wayfinding's part of the objective card (main.ts, from wayfind.ts). */
export interface WayCard {
  /** step n of N today */
  step: { n: number; total: number };
  /** the step after this one, if any */
  next?: string;
  /** there is a target to take the player to */
  take: boolean;
}

export class HudView {
  readonly node = el("div", { className: "hud" });
  private chips = el("div", { className: "chips" });
  private objective = el("div", { className: "objective" });
  private wallet: HTMLElement | null = null;
  private last = "";
  private lastObjective = "";
  private lastText = "";
  private lastWallet: number | null = null;
  private args: Parameters<HudView["render"]> | null = null;

  constructor(
    private s: Strings,
    private t: (id: string) => string,
    private onSound: (on: boolean) => void,
    private onTake: () => void = () => {},
    /** the music is on (the ♪ chip is the music's); none: the chip is core's sound */
    private music?: () => boolean,
  ) {
    this.node.append(this.chips, this.objective, versionTag());
    // The phone HUD's guide line (page.css "Phone HUD"): a tap folds it to its step pill, or opens
    // it again; it folds by itself GUIDE_FOLD_MS after a new step. Elsewhere the class is unused.
    this.objective.addEventListener("click", () => this.fold(!this.objective.classList.contains("folded")));
  }

  private foldTimer: ReturnType<typeof setTimeout> | undefined;

  /** Folds the guide line to its pill (or opens it, folding again GUIDE_FOLD_MS later). */
  fold(on: boolean) {
    clearTimeout(this.foldTimer);
    this.objective.classList.toggle("folded", on);
    this.objective.setAttribute("aria-expanded", String(!on));
    if (!on) {
      this.foldTimer = setTimeout(() => this.fold(true), GUIDE_FOLD_MS);
      (this.foldTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Draws the last render again (the ♪ chip after the music changed outside the model). */
  refresh() {
    if (!this.args) return;
    this.last = "";
    this.render(...this.args);
  }

  render(h: Hud, o?: Objective, guide?: GuideStep | null, way?: WayCard | null) {
    this.args = [h, o, guide, way];
    const key = JSON.stringify([h, this.music?.() ?? null]);
    if (key !== this.last) {
      const bump = this.lastWallet !== null && this.lastWallet !== h.wallet;
      this.lastWallet = h.wallet;
      this.last = key;
      this.wallet = el("span", { className: `chip wallet${bump ? " bump" : ""}${h.rentLate ? " late" : ""}`, textContent: `${h.currency}${h.wallet}` });
      // Long and short wording in each chip: page.css shows the short one on a portrait phone (one row).
      const both = (long: string, short: string) => [el("span", { className: "long", textContent: long }), el("span", { className: "short", textContent: short })];
      this.chips.replaceChildren(
        el("span", { className: "chip place", textContent: h.placeName, title: h.placeName }),
        el("span", { className: "chip day" }, ...both(this.s("day", { n: h.day }), this.s("day-short", { n: h.day }))),
        this.wallet,
        el(
          "span",
          { className: `chip slots${h.slotsLeft === 0 ? " out" : ""}`, title: this.s("slots-left", { n: h.slotsLeft }) },
          ...both(this.s("slots-left", { n: h.slotsLeft }), this.s("slots-short", { n: h.slotsLeft })),
          // the phone strip's "◐ 4"
          el("span", { className: "tiny", textContent: this.s("hud-slots-tiny", { n: h.slotsLeft }) }),
        ),
        el("span", { className: "chip rank", textContent: h.rankName }),
        // The TUI status line's parcel marker, naming where it goes.
        ...(h.errand
          ? [el("span", { className: "chip errand" }, ...both(this.s("errand-chip", { place: h.errand.placeName }), this.s("errand-chip-short", { place: h.errand.placeName })))]
          : []),
        this.soundChip(h.sound),
      );
    }
    const okey = JSON.stringify([o ?? null, guide?.text ?? null, way ?? null]);
    if (okey !== this.lastObjective) {
      const textChanged = JSON.stringify([o?.text, guide?.text]) !== this.lastText;
      this.lastText = JSON.stringify([o?.text, guide?.text]);
      this.lastObjective = okey;
      this.objective.classList.toggle("hidden", !o?.text && !guide);
      this.objective.classList.toggle("guide", !!guide);
      const tags = [
        ...(way ? [el("span", { className: "obj-step", textContent: this.s("way-step", way.step) })] : []),
        ...(guide ? [el("span", { className: "obj-tag", textContent: this.s("guide-label") })] : []),
      ];
      const line = guide?.text ?? o?.text;
      const text = line ? el("div", { className: "obj-text" }, ...tags, line) : null;
      // the phone line's fold chevron (the whole line is the button; this only shows which way it goes)
      const chevron = icon("chevron");
      chevron.classList.add("obj-fold");
      const next = way?.next ? [el("div", { className: "obj-next", textContent: this.s("way-next", { text: way.next }) })] : [];
      const take = way?.take ? [this.takeButton()] : [];
      this.objective.title = this.s("hud-guide-fold");
      this.objective.replaceChildren(chevron, ...(way ? [el("span", { className: "obj-pill", textContent: this.s("way-step", way.step) })] : []), ...(text ? [text] : []), ...next, ...(o?.sub ? [el("div", { className: "obj-sub", textContent: o.sub })] : []), ...take);
      if (textChanged) {
        this.fold(false);
        this.objective.classList.remove("new");
        void this.objective.offsetWidth;
        this.objective.classList.add("new");
      }
    }
  }

  /** "Take me there": a button (the card is otherwise untappable). */
  private takeButton(): HTMLElement {
    const b = el("button", { className: "obj-go" }, icon("route"), el("span", { className: "obj-go-text", textContent: this.s("way-take") }));
    b.setAttribute("aria-label", this.s("way-take"));
    b.title = this.s("way-take");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onTake();
    });
    return b;
  }

  /** ♪ / ♪ off: a button (the HUD is otherwise untappable); "no audio" is only a label. */
  private soundChip(sound: Hud["sound"]): HTMLElement {
    if (this.music) {
      const on = this.music();
      const b = el("button", { className: `chip sound music ${on ? "on" : "off"}`, title: this.s("music-toggle") }, icon("music"), el("span", { className: "snd-text", textContent: this.t(on ? "sound-on" : "sound-off") }));
      b.setAttribute("aria-label", this.s("music-toggle"));
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onSound(!on);
      });
      return b;
    }
    const text = this.t(`sound-${sound}`);
    if (sound === "none") return el("span", { className: "chip sound none", textContent: text });
    const b = el("button", { className: `chip sound ${sound}`, title: this.s("sound-toggle") }, icon("music"), el("span", { className: "snd-text", textContent: text }));
    b.setAttribute("aria-label", this.s("sound-toggle"));
    b.setAttribute("aria-pressed", String(sound === "on"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onSound(sound !== "on");
    });
    return b;
  }

  walletRect(): DOMRect | null {
    return this.wallet?.getBoundingClientRect() ?? null;
  }
}
