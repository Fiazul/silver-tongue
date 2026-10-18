import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The lab merchant experiment's compiled private core: MERCHANT_CORE_DIST, or a sibling st-merchant-core checkout.
// A public checkout has neither; the tests that need it skip.
const market = join(process.env.MERCHANT_CORE_DIST || fileURLToPath(new URL("../st-merchant-core/dist", import.meta.url)), "market.js");

export default defineConfig({
  resolve: { alias: existsSync(market) ? { "@silver-tongue/core/market": market } : {} },
  // 20s: the tools tests build whole courses, which under a full parallel run can pass 5s.
  test: { include: ["packages/*/test/**/*.test.ts", "tools/test/**/*.test.ts"], testTimeout: 20_000 },
});
