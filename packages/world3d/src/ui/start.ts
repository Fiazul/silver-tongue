// The start list: when the catalog has several courses and none is remembered, the player chooses
// one before the street loads (courses.ts pickCourse), as the browser TUI's start list. A plain
// dialog in the menu's style; it can't be dismissed without choosing.
import type { CourseChoice } from "../courses";
import { el } from "./dom";

/** Shows the list in `root`; resolves with the chosen index and closes. */
export function showCourseChoice(root: HTMLElement, choice: CourseChoice): Promise<number> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "menu start" });
    // Esc would close it with nothing chosen.
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    const buttons = choice.labels.map((label, i) => {
      const b = el("button", { className: "game", textContent: label });
      b.addEventListener("click", () => {
        dialog.close();
        dialog.remove();
        resolve(i);
      });
      return b;
    });
    dialog.append(
      el("h2", { textContent: choice.title }),
      el("div", { className: "menu-body" }, ...buttons, ...(choice.error ? [el("p", { className: "err", textContent: choice.error })] : [])),
    );
    root.append(dialog);
    dialog.showModal();
  });
}
