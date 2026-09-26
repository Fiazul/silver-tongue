// Which course the page plays, picked as the browser TUI picks it (packages/tui-web/src/main.ts
// boot / fetchCourse), with the same shared helpers (@silver-tongue/tui chooseStart, learnerFor,
// courseLabels) and the same storage (tui-web's loadWebSettings / saveWebSettings /
// migrateWebAliases): the catalog courses/index.json, then the remembered course (or the only one)
// in its reading language, else the player chooses from the list. Fetching a course file moves games
// saved under its old ids (a course's aliases) to its own, so an old save plays on. DOM-free: fetch
// and the chooser come in as deps, so tests use fakes.
import type { CatalogEntry, Course } from "@silver-tongue/core";
import { chooseStart, courseLabels, learnerFor, makeText } from "@silver-tongue/tui";
import { loadWebSettings, migrateWebAliases, saveWebSettings, type KeyValue } from "@silver-tongue/tui-web/src/web-storage";

export type FetchJson = <T>(path: string) => Promise<T>;

/** The catalog, relative to the page (build.mjs copies the repo's dist/courses/ into this dist/). */
export const CATALOG_PATH = "courses/index.json";

/** A course file: one per course and reading language. */
export function coursePath(entry: CatalogEntry, learner: string): string {
  return `courses/${entry.id}/${learner}.json`;
}

/** Fetches a course file and moves its old games (as tui-web's fetchCourse); nothing is remembered yet. */
export async function fetchCourse(fetchJson: FetchJson, kv: KeyValue, entry: CatalogEntry, learner: string): Promise<Course> {
  const course = await fetchJson<Course>(coursePath(entry, learner));
  migrateWebAliases(kv, course);
  return course;
}

/** The list the player chooses a course from, in the first course's reading language. */
export interface CourseChoice {
  title: string;
  /** one per catalog entry, each by the name of its language */
  labels: string[];
  /** shown after a course file failed to load, so the player can try again or choose another */
  error?: string;
}

export interface PickDeps {
  fetchJson: FetchJson;
  kv: KeyValue;
  /** shows the list (again, with an error, after a failed load); resolves with the chosen index */
  choose: (choice: CourseChoice) => Promise<number>;
}

export interface Picked {
  catalog: CatalogEntry[];
  entry: CatalogEntry;
  course: Course;
}

/**
 * The course to play: the remembered one (or the only one) straight away, else the player's choice.
 * The course played is remembered for next time (the same settings key as the browser TUI); a list
 * shown but not yet chosen from remembers nothing. Throws when the catalog or the first course file
 * can't be had (no reading language to say so in).
 */
export async function pickCourse({ fetchJson, kv, choose }: PickDeps): Promise<Picked> {
  const settings = loadWebSettings(kv);
  const catalog = await fetchJson<CatalogEntry[]>(CATALOG_PATH);
  const start = chooseStart(catalog, settings);
  if ("error" in start) throw new Error(start.error);
  const remember = (entry: CatalogEntry, course: Course): Picked => {
    saveWebSettings(kv, { course: course.id, learner: course.learner });
    return { catalog, entry, course };
  };
  if (!start.ask) return remember(start.course, await fetchCourse(fetchJson, kv, start.course, start.learner));
  // Several courses and none chosen yet: the list is named in the first course's reading language.
  const firstLearner = learnerFor(catalog[0], settings.learner);
  const first = await fetchCourse(fetchJson, kv, catalog[0], firstLearner);
  const t = makeText(first.learnerFtl, first.learner);
  const labels = courseLabels(catalog, t).map((l) => l.replace(/^\d+\) /, ""));
  let error: string | undefined;
  for (;;) {
    const i = await choose({ title: t("start-title"), labels, ...(error ? { error } : {}) });
    const entry = catalog[i];
    if (!entry) continue;
    const learner = learnerFor(entry, settings.learner);
    if (entry === catalog[0] && learner === firstLearner) return remember(entry, first);
    try {
      return remember(entry, await fetchCourse(fetchJson, kv, entry, learner));
    } catch {
      error = t("web-load-failed");
    }
  }
}
