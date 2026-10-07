import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGES = join(REPO, "packages");
const FIXTURES = [join(PACKAGES, "core", "src", "testing"), join(PACKAGES, "view", "src", "testing.ts")];

/** Every file under packages/<name>/src, test fixtures left out. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (FIXTURES.includes(p)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    try {
      walk(src);
    } catch {
      // a package without src/
    }
  }
  return out;
}

// Script, not Script_Extensions: the middle dot "·" has Han among its extensions.
const SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Language codes: every language and reading language in content/, and common ones besides.
const CODES = [
  ...readdirSync(join(REPO, "content", "languages")),
  ...readdirSync(join(REPO, "content", "learner")),
  "zh", "ja", "ko", "en", "es", "fr", "de", "ar", "ru", "pt", "it", "hi",
];
const CODE = new RegExp(`(["'\`])(${[...new Set(CODES)].join("|")})(-[A-Za-z]+)?\\1`);

describe("engine and front ends are free of any particular language", () => {
  const files = sources();

  it("reads the sources", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no Han, kana or Hangul characters", () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((l, i) => (SCRIPT.test(l) ? [`${relative(REPO, f)}:${i + 1}: ${l.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it("embeds no opening setting’s scene, paper or NPC ids", () => {
    const dir = join(REPO, "content", "settings", "seoul-city");
    const ids = [
      ...readdirSync(join(dir, "scenes")).map((f) => JSON.parse(readFileSync(join(dir, "scenes", f), "utf8")).id as string),
      ...[JSON.parse(readFileSync(join(dir, "opening.json"), "utf8")).reward?.paper].filter((id): id is string => !!id),
      ...Object.keys(JSON.parse(readFileSync(join(dir, "world.json"), "utf8")).npcs),
    ];
    const literal = new RegExp(`(["'\`])(${ids.join("|")})(?:[:][^"'\`]+)?\\1`);
    const hits = files.flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => literal.test(line) ? [`${relative(REPO, f)}:${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });

  it("names no language code", () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((l, i) => (CODE.test(l) ? [`${relative(REPO, f)}:${i + 1}: ${l.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
