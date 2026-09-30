// The phone HUD's icons (page.css "Phone HUD"): inline SVG, stroked in currentColor on a 24 px
// grid; no icon font, nothing fetched. `icon(name)` gives a span holding one (aria-hidden: the
// button round it carries the aria-label).
import { el } from "./dom";

const P: Record<string, string> = {
  // an open book
  notebook: '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z"/><path d="M12 6.5v13"/>',
  // a map pin
  travel: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  // a crescent moon
  sleep: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
  // three lines
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  // a mortarboard: the mentor's lesson
  mentor: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5v4c1.5 1.5 3.5 2.2 5.5 2.2s4-.7 5.5-2.2v-4"/><path d="M21.5 9.5v5"/>',
  // a compass needle in a ring: take me there
  route: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>',
  // a quaver: the music
  music: '<path d="M9 17.5V5.5l10-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  // a chevron (points up: fold; the folded pill turns it)
  chevron: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
};

export type IconName = keyof typeof P;

export const ICON_NAMES = Object.keys(P);

export function iconSvg(name: string): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" focusable="false">${P[name] ?? ""}</svg>`;
}

export function icon(name: string): HTMLElement {
  const s = el("span", { className: `ico ico-${name}` });
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = iconSvg(name);
  return s;
}
