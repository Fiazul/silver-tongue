import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The courses the site offers, in the order a first visit lists them to pick from. */
export const SITE_COURSES = ["ko-seoul", "zh-china", "ja-japan"];

/** The catalog cut down to the site's courses, in their order; throws when one is missing, so a broken site never ships. */
export function siteCatalog<T extends { id: string }>(catalog: T[]): T[] {
  return SITE_COURSES.map((id) => {
    const entry = catalog.find((c) => c.id === id);
    if (!entry) throw new Error(`catalog has no course ${id}`);
    return entry;
  });
}

/** Sets a `<meta name=… content=…>` of the page; throws when the page has no such meta, so a changed template never ships silently. */
export function setMeta(html: string, name: string, content: string): string {
  const re = new RegExp(`(<meta name="${name}" content=")[^"]*(")`);
  if (!re.test(html)) throw new Error(`index.html has no meta ${name}`);
  return html.replace(re, (_, a: string, b: string) => `${a}${content}${b}`);
}

/** site/: the quiet terminal at / (a first visit picks Korean, Chinese or Japanese) and those courses, ready for GitHub Pages.
 * `lab`: also site/ko/, the same page one directory down, starting on Korean with the lab flag on (the lab build serves it at /lab/ko/). */
export function buildSite(repo: string, opts: { lab?: boolean; merchant?: boolean } = {}): void {
  const out = join(repo, "site");
  const quietDist = join(repo, "packages", "quiet-web", "dist");
  const courses = join(quietDist, "courses");
  const catalog = siteCatalog(JSON.parse(readFileSync(join(courses, "index.json"), "utf8")) as { id: string }[]);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "courses"), { recursive: true });
  cpSync(join(quietDist, "index.html"), join(out, "index.html"));
  if (opts.lab) {
    mkdirSync(join(out, "ko"), { recursive: true });
    let page = readFileSync(join(quietDist, "index.html"), "utf8");
    page = setMeta(page, "st-course", "ko-seoul");
    page = setMeta(page, "st-lab", "on");
    page = setMeta(page, "st-courses", "../courses/");
    writeFileSync(join(out, "ko", "index.html"), page);
  }
  if (opts.merchant) cpSync(join(repo, 'packages', 'market-web', 'dist'), join(out, 'merchant'), { recursive: true });
  writeFileSync(join(out, "courses", "index.json"), JSON.stringify(catalog));
  for (const { id } of catalog) cpSync(join(courses, id), join(out, "courses", id), { recursive: true });
  console.log(`site/: the quiet terminal at /, courses ${SITE_COURSES.join(", ")} at /courses/${opts.lab ? ", lab Korean at /ko/" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildSite(resolve(fileURLToPath(new URL("../..", import.meta.url))), { lab: process.argv.includes("--lab"), merchant: process.argv.includes("--merchant") });
