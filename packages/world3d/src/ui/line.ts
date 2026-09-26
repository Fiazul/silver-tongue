import type { Course, RenderedLine, WordId } from "@silver-tongue/core";
import { el } from "./dom";

/**
 * A line as DOM: each token a tappable word span, the text between tokens (punctuation, the
 * player's name) plain. `ruby` puts each word's pinyin above it (a slowed, replayed line).
 */
export function lineNodes(line: RenderedLine, course: Course, opts: { onWord?: (word: WordId, at: HTMLElement) => void; ruby?: boolean; fresh?: WordId[] } = {}): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const tk of [...line.tokens].sort((a, b) => a.start - b.start)) {
    if (tk.start > at) out.push(document.createTextNode(line.text.slice(at, tk.start)));
    const text = line.text.slice(tk.start, tk.end);
    const pron = course.words[tk.word]?.pron;
    const span = el("span", { className: "tok" });
    span.dataset.word = tk.word;
    if (opts.fresh?.includes(tk.word)) span.classList.add("fresh");
    if (opts.ruby && pron) span.append(el("ruby", {}, text, el("rt", { textContent: pron })));
    else span.textContent = text;
    if (opts.onWord) {
      span.classList.add("tappable");
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onWord!(tk.word, span);
      });
    }
    out.push(span);
    at = Math.max(at, tk.end);
  }
  if (at < line.text.length) out.push(document.createTextNode(line.text.slice(at)));
  return out;
}
