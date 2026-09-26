// Notebook: packages/tui's notebookLines (stage progress, words grouped by the place first heard,
// mentor notes) rendered as HTML instead of terminal lines.
import type { StyledLine } from "@silver-tongue/tui";
import { el } from "./dom";

export function notebookNodes(lines: StyledLine[]): Node[] {
  return lines.map((line) => {
    if (!line.length) return el("div", { className: "nb-gap" });
    const row = el("div", { className: "nb-line" });
    for (const span of line) {
      const s = el("span", { textContent: span.text });
      if (span.bold) s.classList.add("b");
      if (span.dim) s.classList.add("dim");
      if (span.color) s.classList.add(`c-${span.color}`);
      row.append(s);
    }
    return row;
  });
}
