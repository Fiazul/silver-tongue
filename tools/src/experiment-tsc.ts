// Typechecks a lab package (market-web, journey) against the compiled private merchant core:
// MERCHANT_CORE_DIST when set, otherwise the sibling st-merchant-core checkout its tsconfig names.
// tsc cannot read the environment, so a configured core goes through a temporary tsconfig that
// extends the package's own and points `@silver-tongue/core/market` at that core's types.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = resolve(process.argv[2] ?? ".");
const own = join(project, "tsconfig.json");
if (!existsSync(own)) throw new Error(`no tsconfig.json in ${project}`);
const require = createRequire(import.meta.url);
const core = process.env.MERCHANT_CORE_DIST;
const temp = core ? mkdtempSync(join(tmpdir(), "st-experiment-tsc-")) : undefined;
let config = own;
if (temp) {
  config = join(temp, "tsconfig.json");
  const types = join(resolve(core!), "types", "market.d.ts");
  // Type roots resolve from the config's folder; keep them the checkout's own.
  const typeRoots = [dirname(dirname(require.resolve("@types/node/package.json")))];
  writeFileSync(config, JSON.stringify({ extends: own, compilerOptions: { typeRoots, paths: { "@silver-tongue/core/market": [types] } } }));
}
const tsc = require.resolve("typescript/bin/tsc");
const run = spawnSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
if (temp) rmSync(temp, { recursive: true, force: true });
process.exit(run.status ?? 1);
