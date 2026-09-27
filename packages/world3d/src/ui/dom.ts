/** A DOM element with properties and children (same helper as tui-web's main.ts). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Controls nested inside something tappable (a hint chip, a ▶ or a word inside a reply option,
// the bubble's line and tools): a tap on the inner control must never also count as a tap on
// the row round it, by any path: the click, a press that starts on the control and lifts (or is
// retargeted, on a touch screen) onto the row, the pointer / touch lift, Enter / Space on the
// focused control. One guard for every such site: `nested()` marks and fences the inner
// control, `tappable()` wires the row so it ignores anything that began or landed on one.
// ---------------------------------------------------------------------------------------------

/** the attribute nested controls carry */
export const NESTED_ATTR = "data-nested";

/** Whether an event's target is (inside) a nested control, other than `row` itself. */
export function isNestedControl(ev: Event, row?: Element): boolean {
  const t = ev.target as Element | null;
  const hit = t?.closest?.(`[${NESTED_ATTR}]`);
  return !!hit && hit !== row && (!row || row.contains(hit));
}

/**
 * Marks `node` as a control nested in something tappable and stops its click, pointer / touch
 * lift and Enter / Space from reaching whatever is round it (pointerdown still bubbles: a tap
 * anywhere closes the word popover, and the row reads it to know the press began here).
 */
export function nested<T extends HTMLElement>(node: T): T {
  node.setAttribute(NESTED_ATTR, "");
  const stop = (e: Event) => e.stopPropagation();
  for (const type of ["click", "pointerup", "touchend", "mouseup"]) node.addEventListener(type, stop);
  node.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") e.stopPropagation();
  });
  return node;
}

/**
 * Wires a tappable row / tile: `activate` on its click, and on Enter / Space while it has the
 * focus, but never for a press that began on a nested control inside it, nor for a click that
 * lands on one.
 */
export function tappable(row: HTMLElement, activate: () => void) {
  let pressedNested = false;
  const down = (e: Event) => {
    pressedNested = isNestedControl(e, row);
  };
  row.addEventListener("pointerdown", down);
  row.addEventListener("touchstart", down);
  row.addEventListener("mousedown", down);
  row.addEventListener("click", (e) => {
    const skip = pressedNested || isNestedControl(e, row);
    pressedNested = false;
    if (!skip) activate();
  });
  row.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if ((k !== "Enter" && k !== " ") || e.target !== row) return;
    e.preventDefault();
    pressedNested = false;
    activate();
  });
}
