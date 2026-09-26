// Speech bubble over the speaking NPC's head. The line as written; tap a word for its readings + gloss, tap
// "…" for the whole sentence (and hear it), ▶ to hear the line again. The line is said as it
// appears (game.ts queues it). The world projects the head_top anchor to the screen each frame.
import type { Course, RenderedLine, WordId } from "@silver-tongue/core";
import type { Bubble } from "../game";
import type { Strings } from "../strings";
import { el } from "./dom";
import { lineNodes } from "./line";
import { placeBubble, type Rect } from "./viewport";

export interface BubbleHooks {
  onWord(word: WordId, at: HTMLElement): void;
  onSentence(line: RenderedLine, at: HTMLElement): void;
  /** ▶: say the bubble again */
  onReplay(): void;
}

export class BubbleView {
  readonly node = el("div", { className: "bubble hidden" });
  private seq = -1;
  npc: string | null = null;

  constructor(
    private course: Course,
    private s: Strings,
    private hooks: BubbleHooks,
  ) {}

  render(b: Bubble | null) {
    this.npc = b?.npc ?? null;
    this.node.classList.toggle("hidden", !b);
    if (!b || b.seq === this.seq) return;
    this.seq = b.seq;
    const text = el("div", { className: `bubble-line${b.slow ? " slow" : ""}` }, ...lineNodes(b.line, this.course, { onWord: this.hooks.onWord, ruby: b.slow, fresh: b.fresh }));
    const tools = el("div", { className: "bubble-tools" });
    if (b.line.meaning) {
      const m = el("button", { className: "icon", title: this.s("sentence"), textContent: "…" });
      m.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.onSentence(b.line, m);
      });
      tools.append(m);
    }
    const replay = el("button", { className: "icon", title: this.s("replay"), textContent: "▶", disabled: !b.audio.length });
    replay.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hooks.onReplay();
    });
    tools.append(replay);
    this.node.replaceChildren(el("div", { className: `bubble-name ${b.kind}`, textContent: b.npcName }), text, tools);
    this.node.classList.remove("pop");
    void this.node.offsetWidth; // restart the pop animation
    this.node.classList.add("pop");
  }

  /**
   * Screen position of the head (CSS px): the bubble sits above it, clamped inside `area` (the
   * layout's bubble rect: never off-screen, never under the HUD or reply panel); an off-screen head
   * pins it top-centre (viewport.ts placeBubble).
   */
  position(x: number, y: number, visible: boolean, area: Rect) {
    const p = placeBubble(x, y, visible, this.node.offsetWidth, this.node.offsetHeight, area);
    this.node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    this.node.classList.toggle("offscreen", p.pinned);
  }
}
