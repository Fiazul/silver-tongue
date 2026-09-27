// The start flow's strings (design/start/strings.js as a module): locale/<ui>.json `start`, keyed
// by UI language (the reading language picked on "I speak…" from then on). A missing key falls
// back to English; {name}-style slots are filled from `vars`.
import { FALLBACK_UI, NATIVE_NAMES, UI_LOCALES } from "../../locale";

const table = (lang: string) => (UI_LOCALES[lang] ?? UI_LOCALES[FALLBACK_UI]).start;
const english = () => UI_LOCALES[FALLBACK_UI].start;

/** Looks `key` up in `lang`, then English, then returns the key; fills {slots} from `vars`. */
export function t(lang: string, key: string, vars?: Record<string, string | number>): string {
  const own = table(lang);
  const v = key in own ? own[key] : key in english() ? english()[key] : key;
  const s = Array.isArray(v) ? v.join("\n") : v;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** A list-valued string (the name suggestions). */
export function list(lang: string, key: string): string[] {
  const own = table(lang);
  const v = key in own ? own[key] : english()[key];
  return Array.isArray(v) ? v : [];
}

/** True when `key` exists for `lang` or English. */
export function has(lang: string, key: string): boolean {
  return key in table(lang) || key in english();
}

/** The UI languages the start flow has. */
export const languages = Object.keys(UI_LOCALES);
export { NATIVE_NAMES };
