// Precomputes the interior camera's frames (src/interior-camera.ts solveFrame: seconds per room and
// aspect) into src/interior-frames.json, per room camera volume and aspect bucket (FRAME_ASPECTS).
// Re-run after changing a room's shell / size / entry or the solver (test/interior-camera.test.ts
// fails while the table is stale):
//
//   npx tsx packages/world3d/scripts/interior-frames.ts        (WORLD3D_ASSETS=... for another library)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAME_ASPECTS, frameKey, solveFrame } from "../src/interior-camera";
import { LAYOUT, LayoutIndex } from "../src/layout";

const ASSETS = process.env.WORLD3D_ASSETS ?? join(import.meta.dirname, "..", "assets");
const L = new LayoutIndex(LAYOUT, JSON.parse(readFileSync(join(ASSETS, "index.json"), "utf8")));
const table: Record<string, { aspect: number; pitch: number; fov: number; height: number }[]> = {};
for (const id of Object.keys(LAYOUT.interiors)) {
  const view = L.space(id).view;
  if (!view || table[frameKey(view)]) continue;
  const t0 = Date.now();
  table[frameKey(view)] = FRAME_ASPECTS.map((aspect) => {
    const f = solveFrame(view, aspect);
    return { aspect, pitch: f.pitch, fov: f.fov, height: Math.round(f.height * 1000) / 1000 };
  });
  console.log(`${id}: ${FRAME_ASPECTS.length} aspects in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
writeFileSync(join(import.meta.dirname, "..", "src", "interior-frames.json"), JSON.stringify(table, null, 1) + "\n");
