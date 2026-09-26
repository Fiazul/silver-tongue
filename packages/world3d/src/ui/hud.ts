// HUD: day, wallet, slots left today, rank, where you are, the parcel you carry, the sound chip
// (tap: on / off, as the TUI's [m]); under it the objective line.
import type { Hud } from "../game";
import type { Objective } from "../objective";
import type { Strings } from "../strings";
import { el } from "./dom";

export class HudView {
  readonly node = el("div", { className: "hud" });
  private chips = el("div", { className: "chips" });
  private objective = el("div", { className: "objective" });
  private wallet: HTMLElement | null = null;
  private last = "";
  private lastObjective = "";

  constructor(
    private s: Strings,
    private t: (id: string) => string,
    private onSound: (on: boolean) => void,
  ) {
    this.node.append(this.chips, this.objective);
  }

  render(h: Hud, o?: Objective) {
    const key = JSON.stringify(h);
    if (key !== this.last) {
      const bump = this.last && JSON.parse(this.last).wallet !== h.wallet;
      this.last = key;
      this.wallet = el("span", { className: `chip wallet${bump ? " bump" : ""}${h.rentLate ? " late" : ""}`, textContent: `${h.currency}${h.wallet}` });
      // Long and short wording in each chip: page.css shows the short one on a portrait phone (one row).
      const both = (long: string, short: string) => [el("span", { className: "long", textContent: long }), el("span", { className: "short", textContent: short })];
      this.chips.replaceChildren(
        el("span", { className: "chip place", textContent: h.placeName }),
        el("span", { className: "chip day" }, ...both(this.s("day", { n: h.day }), this.s("day-short", { n: h.day }))),
        this.wallet,
        el("span", { className: `chip slots${h.slotsLeft === 0 ? " out" : ""}` }, ...both(this.s("slots-left", { n: h.slotsLeft }), this.s("slots-short", { n: h.slotsLeft }))),
        el("span", { className: "chip rank", textContent: h.rankName }),
        // The TUI status line's parcel marker, naming where it goes.
        ...(h.errand
          ? [el("span", { className: "chip errand" }, ...both(this.s("errand-chip", { place: h.errand.placeName }), this.s("errand-chip-short", { place: h.errand.placeName })))]
          : []),
        this.soundChip(h.sound),
      );
    }
    const okey = JSON.stringify(o ?? null);
    if (okey !== this.lastObjective) {
      this.lastObjective = okey;
      this.objective.classList.toggle("hidden", !o?.text);
      this.objective.replaceChildren(
        ...(o?.text ? [el("div", { className: "obj-text", textContent: o.text })] : []),
        ...(o?.sub ? [el("div", { className: "obj-sub", textContent: o.sub })] : []),
      );
      this.objective.classList.remove("new");
      void this.objective.offsetWidth;
      this.objective.classList.add("new");
    }
  }

  /** ♪ / ♪ off: a button (the HUD is otherwise untappable); "no audio" is only a label. */
  private soundChip(sound: Hud["sound"]): HTMLElement {
    const text = this.t(`sound-${sound}`);
    if (sound === "none") return el("span", { className: "chip sound none", textContent: text });
    const b = el("button", { className: `chip sound ${sound}`, textContent: text, title: this.s("sound-toggle") });
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
