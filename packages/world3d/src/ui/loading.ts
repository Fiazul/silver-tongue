// The loading screen (#loading in index.html; page.css .ld-*): the game's title, a bar with the
// percent and bytes (loading.ts loadSummary), and the file loading now. Up at the start while the
// town's first views load; again over a door whose room hasn't landed yet, only when that takes
// longer than `delay` (a prefetched room goes in behind the fade with no screen at all).
import { progressLabel, type LoadSummary } from "../loading";

export class LoadingScreen {
  private fill: HTMLElement;
  private pct: HTMLElement;
  private bytes: HTMLElement;
  private item: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** requests holding the screen up (the start, a room being loaded) */
  private holds = 0;

  constructor(
    readonly root: HTMLElement,
    title = "Silver Tongue",
  ) {
    root.replaceChildren();
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    const card = document.createElement("div");
    card.className = "ld-card";
    const h = document.createElement("h1");
    h.className = "ld-title";
    h.textContent = title;
    const bar = document.createElement("div");
    bar.className = "ld-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    this.fill = document.createElement("div");
    this.fill.className = "ld-fill";
    bar.append(this.fill);
    const line = document.createElement("p");
    line.className = "ld-line";
    this.pct = document.createElement("b");
    this.pct.className = "ld-pct";
    this.bytes = document.createElement("span");
    this.bytes.className = "ld-bytes";
    line.append(this.pct, this.bytes);
    this.item = document.createElement("p");
    this.item.className = "ld-item";
    card.append(h, bar, line, this.item);
    root.append(card);
    this.render(null);
  }

  /** The bar for a summary (null: nothing counted yet). */
  render(p: LoadSummary | null) {
    const f = p ? p.fraction : 0;
    const pc = Math.floor(f * 100);
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    this.fill.parentElement?.setAttribute("aria-valuenow", String(pc));
    this.pct.textContent = `${pc}%`;
    this.bytes.textContent = p && p.count ? progressLabel(p) : "";
    this.item.textContent = p?.current ?? "";
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Holds the screen up, shown at once or after `delay` ms; `release()` lets it go (hidden when no hold is left). */
  hold(delay = 0): () => void {
    this.holds++;
    if (delay <= 0) this.show();
    else if (!this.visible && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.holds > 0) this.show();
      }, delay);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0) this.hide();
    };
  }

  private show() {
    this.root.classList.remove("error");
    this.root.hidden = false;
  }

  hide() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.root.hidden = true;
  }

  /** A message instead of the bar (the game couldn't load); stays up. */
  error(text: string) {
    this.holds++;
    this.root.hidden = false;
    this.root.classList.add("error");
    this.item.textContent = text;
  }
}
