import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite, siteCatalog } from "../src/site";

describe("site catalog", () => {
  it("offers Korean, Chinese and Japanese, in that order, nothing else", () => {
    const catalog = [{ id: "ja-japan" }, { id: "xx-test" }, { id: "zh-china" }, { id: "ko-seoul" }];
    expect(siteCatalog(catalog).map((c) => c.id)).toEqual(["ko-seoul", "zh-china", "ja-japan"]);
  });

  it("fails loudly when a course is missing", () => {
    expect(() => siteCatalog([{ id: "zh-china" }])).toThrow(/ko-seoul/);
  });
});

describe("lab site", () => {
  const PAGE = '<meta name="st-courses" content="courses/" /><meta name="st-course" content="" /><meta name="st-lab" content="" />';
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    const dist = join(dir, "packages", "quiet-web", "dist");
    mkdirSync(join(dist, "courses"), { recursive: true });
    writeFileSync(join(dist, "index.html"), PAGE);
    const ids = ["ko-seoul", "zh-china", "ja-japan"];
    writeFileSync(join(dist, "courses", "index.json"), JSON.stringify(ids.map((id) => ({ id }))));
    for (const id of ids) mkdirSync(join(dist, "courses", id));
    return dir;
  }

  it("writes no ko/ without the lab flag, and leaves the main page as built", () => {
    const dir = repo();
    buildSite(dir);
    expect(existsSync(join(dir, "site", "ko"))).toBe(false);
    expect(readFileSync(join(dir, "site", "index.html"), "utf8")).toBe(PAGE);
  });

  it("with the lab flag writes ko/index.html: Korean, lab on, courses one level up", () => {
    const dir = repo();
    buildSite(dir, { lab: true });
    const ko = readFileSync(join(dir, "site", "ko", "index.html"), "utf8");
    expect(ko).toContain('<meta name="st-course" content="ko-seoul" />');
    expect(ko).toContain('<meta name="st-lab" content="on" />');
    expect(ko).toContain('<meta name="st-courses" content="../courses/" />');
    expect(readFileSync(join(dir, "site", "index.html"), "utf8")).toBe(PAGE);
  });

  it("adds a separate merchant route without replacing either original page", () => {
    const dir = repo();
    const experiment = join(dir, 'packages', 'market-web', 'dist');
    mkdirSync(experiment, { recursive: true });
    writeFileSync(join(experiment, 'index.html'), '<title>Merchant experiment</title>');
    writeFileSync(join(experiment, 'content.json'), '{"id":"merchant-town"}');
    buildSite(dir, { lab: true, merchant: true });
    expect(readFileSync(join(dir, 'site', 'index.html'), 'utf8')).toBe(PAGE);
    expect(readFileSync(join(dir, 'site', 'ko', 'index.html'), 'utf8')).toContain('st-lab" content="on');
    expect(readFileSync(join(dir, 'site', 'merchant', 'index.html'), 'utf8')).toContain('Merchant experiment');
    expect(readFileSync(join(dir, 'site', 'merchant', 'content.json'), 'utf8')).toBe('{"id":"merchant-town"}');
  });
});
