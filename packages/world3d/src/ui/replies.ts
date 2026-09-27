// Reply panel: a bark's one "…" (continue mode); 2-4 options in pick mode, each with a ▶ that says it (without picking it). Word help mode ("?")
// turns taps on words into look-ups instead of picks, like the TUI's [w]. Tiles mode: tap the
// tiles in order (the TUI's tile numbers), Undo (backspace), Say it (enter), or give up. Each option's
// native meaning is hidden under a hint chip (start/hint-chip.ts); tiles play tile_place / tile_undo.
import { joinTiles, type Course, type WordId } from "@silver-tongue/core";
import type { ReplyPanel } from "../game";
import type { Strings } from "../strings";
import type { Text } from "@silver-tongue/tui";
import { createHintChip } from "../start/hint-chip";
import { el } from "./dom";
import { lineNodes } from "./line";

export interface ReplyHooks {
  onPick(index: number): void;
  onTiles(tiles: number[]): void;
  onWord(word: WordId, at: HTMLElement): void;
  onGiveUp(): void;
  /** an option's ▶ */
  onHear(clips: string[] | undefined): void;
  sfx?(id: string): void;
  /** the UI language (the chips' labels) */
  lang?: string;
}

export class RepliesView {
  readonly node = el("div", { className: "replies hidden" });
  private helpMode = false;
  private shown: ReplyPanel | null = null;
  private chosen: number[] = [];

  constructor(
    private course: Course,
    private t: Text,
    private s: Strings,
    private hooks: ReplyHooks,
  ) {}

  render(r: ReplyPanel | null) {
    this.node.classList.toggle("hidden", !r);
    if (r === this.shown) return;
    this.shown = r;
    this.chosen = [];
    if (!r) {
      this.helpMode = false;
      return this.node.replaceChildren();
    }
    this.draw(r);
  }

  private draw(r: ReplyPanel) {
    if (r.mode === "tiles") {
      const answer = el("div", { className: "tile-answer", textContent: joinTiles(this.course, this.chosen.map((i) => r.tiles[i])) || "…" });
      const tiles = r.tiles.map((x, i) => {
        const b = el("button", { className: "tile", textContent: x, disabled: this.chosen.includes(i) });
        b.dataset.sfx = "tile_place";
        b.addEventListener("click", () => this.addTile(i));
        return b;
      });
      const undo = el("button", { className: "secondary", textContent: this.s("tiles-undo"), disabled: !this.chosen.length });
      undo.dataset.sfx = "tile_undo";
      undo.addEventListener("click", () => this.undoTile());
      const say = el("button", { className: "say", textContent: this.s("tiles-say"), disabled: !this.chosen.length });
      say.addEventListener("click", () => this.sayTiles());
      const give = el("button", { className: "secondary", textContent: this.s("tiles-give-up") });
      give.addEventListener("click", () => this.hooks.onGiveUp());
      this.node.replaceChildren(
        el("div", { className: "replies-title" }, el("span", { textContent: this.t("tiles-title") }), ...this.price(r)),
        answer,
        el("div", { className: "tiles" }, ...tiles),
        el("div", { className: "tile-tools" }, undo, say, give),
      );
      return;
    }
    if (r.mode === "continue") {
      // A bark: one reply, "…", that closes it (as does a tap anywhere, E, Enter, Space or 1).
      const go = el("button", { className: "option continue", textContent: r.label, title: this.s("bark-continue") });
      go.addEventListener("click", () => this.hooks.onPick(0));
      this.node.replaceChildren(go);
      return;
    }
    const help = el("button", { className: `icon help${this.helpMode ? " on" : ""}`, title: this.s("word-help"), textContent: "?" });
    help.addEventListener("click", () => {
      this.helpMode = !this.helpMode;
      this.draw(r);
    });
    const title = el(
      "div",
      { className: "replies-title" },
      el("span", { textContent: this.helpMode ? this.s("word-help-on") : this.t("reply-title") }),
      ...this.price(r),
      help,
    );
    const rows = r.options.map((o, i) => {
      const row = el("div", { className: "option", tabIndex: 0 });
      row.setAttribute("role", "button");
      const replay = el("button", { className: "icon", title: this.s("play"), textContent: "▶", disabled: !o.audio?.length });
      replay.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.onHear(o.audio);
      });
      const text = el("span", { className: "option-text" }, ...lineNodes(o, this.course, { onWord: this.helpMode ? this.hooks.onWord : undefined }));
      if (o.meaning) {
        const chip = createHintChip(o.meaning, { inline: true, lang: this.hooks.lang, sfx: this.hooks.sfx });
        chip.dataset.sfx = "none";
        text.append(chip);
      }
      row.append(el("span", { className: "key", textContent: String(i + 1) }), text, replay);
      row.addEventListener("click", () => {
        if (!this.helpMode) this.hooks.onPick(i);
      });
      return row;
    });
    this.node.replaceChildren(title, ...rows);
  }

  /** The guide's "reply" step: the sheet glows (twice), once. */
  glow() {
    this.node.classList.remove("guide-glow");
    void this.node.offsetWidth;
    this.node.classList.add("guide-glow");
  }

  /** The price of the right reply (shopping), as a tag in the panel's title. */
  private price(r: ReplyPanel): HTMLElement[] {
    return r.cost ? [el("span", { className: "reply-cost", textContent: this.s("reply-cost", { currency: this.course.world.currency, cost: r.cost }) })] : [];
  }

  private addTile(i: number) {
    if (this.shown?.mode !== "tiles" || this.chosen.includes(i)) return;
    this.chosen = [...this.chosen, i];
    this.draw(this.shown);
  }

  private undoTile() {
    if (this.shown?.mode !== "tiles") return;
    this.chosen = this.chosen.slice(0, -1);
    this.draw(this.shown);
  }

  private sayTiles() {
    if (this.shown?.mode !== "tiles" || !this.chosen.length) return;
    this.hooks.onTiles(this.chosen);
  }

  /** Number keys pick (or add a tile), Backspace undoes a tile, Enter says the tiles. */
  key(k: string): boolean {
    const r = this.shown;
    if (r?.mode === "tiles") {
      const n = Number(k) - 1;
      if (Number.isInteger(n) && n >= 0 && n < r.tiles.length) this.addTile(n);
      else if (k === "Backspace") this.undoTile();
      else if (k === "Enter") this.sayTiles();
      else return false;
      return true;
    }
    if (r?.mode === "continue") {
      if (k === "1" || k === "Enter" || k === " " || k.toLowerCase() === "e" || k === "Escape") this.hooks.onPick(0);
      else return false;
      return true;
    }
    if (r?.mode !== "pick") return false;
    const n = Number(k) - 1;
    if (Number.isInteger(n) && n >= 0 && n < r.options.length) {
      this.hooks.onPick(n);
      return true;
    }
    return false;
  }
}
