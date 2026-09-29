// JPEG for the textured assets' colour-like maps (make-it-in-china docs/asset-conventions.md
// "Textures": base colour sRGB PNG, tangent-space normal PNG, ORM PNG = occlusion R / roughness G /
// metalness B). The PNGs are about a third each of a textured GLB (the noodle shop: 1.1 MB, most of
// it before the town's first frame, test/loading.test.ts); as JPEG q88 the base colour and the ORM
// shrink ~3x. The normal map stays PNG (block artefacts in a normal map read as dents). The ORM is
// encoded without chroma subsampling: its channels are three independent data maps, not a colour.
// An image any other slot also uses (normal, emissive), with real alpha, or that JPEG wouldn't
// make smaller, stays PNG. Pillow does
// the encoding and decodes every JPEG it wrote before it is kept (python3 + Pillow: already the
// sync's own dependency for the title frames). A GLB with nothing to convert is returned as is, so
// a vendored (already converted) GLB never needs Python: build.mjs runs this too via copyUsed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGlb, writeGlb } from "./glb.mjs";

export const JPEG_QUALITY = 88;

/** Which images each role reads: "color" (base colour), "orm" (metallic-roughness / occlusion), "keep" (normal, emissive). */
function imageRoles(json) {
  const roles = new Map();
  const add = (texInfo, role) => {
    if (!texInfo) return;
    const src = json.textures?.[texInfo.index]?.source;
    if (src === undefined) return;
    const r = roles.get(src) ?? new Set();
    r.add(role);
    roles.set(src, r);
  };
  for (const m of json.materials ?? []) {
    add(m.pbrMetallicRoughness?.baseColorTexture, "color");
    add(m.pbrMetallicRoughness?.metallicRoughnessTexture, "orm");
    add(m.occlusionTexture, "orm");
    add(m.normalTexture, "keep");
    add(m.emissiveTexture, "keep");
  }
  return roles;
}

const PY = `
import json, sys
from PIL import Image
out = {}
for job in json.loads(sys.argv[1]):
    im = Image.open(job["src"])
    im.load()
    if "A" in im.getbands() and im.getchannel("A").getextrema()[0] < 255:
        out[job["src"]] = "alpha"
        continue
    im.convert("RGB").save(job["dst"], "JPEG", quality=int(sys.argv[2]), optimize=True, subsampling=0 if job["role"] == "orm" else 2)
    back = Image.open(job["dst"])
    back.load()
    if back.size != im.size:
        raise SystemExit("jpeg %s: decoded %s, not %s" % (job["dst"], back.size, im.size))
    out[job["src"]] = "jpeg"
print(json.dumps(out))
`;

/**
 * The GLB with its base colour and ORM PNGs re-encoded as JPEG (`name`: for messages); the same
 * buffer when there is nothing to convert. Expects the uncompressed layout (one buffer, before
 * scripts/meshopt.mjs).
 */
export function jpegTextures(buf, name = "") {
  const { json, bin } = parseGlb(buf);
  const roles = imageRoles(json);
  const todo = (json.images ?? []).flatMap((im, i) => {
    const r = roles.get(i);
    if (im.bufferView === undefined || im.mimeType !== "image/png" || !r || r.has("keep")) return [];
    return [{ i, role: r.has("orm") ? "orm" : "color" }];
  });
  // already through the sync (meshopt-compressed): its maps were decided then (a PNG left is one JPEG didn't shrink)
  if (!todo.length || (json.extensionsUsed ?? []).includes("EXT_meshopt_compression")) return buf;
  if (!bin || (json.buffers ?? []).length !== 1) throw new Error(`textures: ${name}: expects one buffer (convert before meshopt)`);
  const dir = mkdtempSync(join(tmpdir(), "w3d-jpeg-"));
  try {
    const jobs = todo.map(({ i, role }) => {
      const bv = json.bufferViews[json.images[i].bufferView];
      const src = join(dir, `${i}.png`);
      writeFileSync(src, bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
      return { i, role, src, dst: join(dir, `${i}.jpg`) };
    });
    const py = spawnSync("python3", ["-c", PY, JSON.stringify(jobs), String(JPEG_QUALITY)], { encoding: "utf8" });
    if (py.status !== 0) throw new Error(`textures: ${name}: python3 with Pillow is needed (pip install pillow): ${py.stderr.trim()}`);
    const done = JSON.parse(py.stdout);
    const replace = new Map();
    for (const j of jobs) {
      if (done[j.src] !== "jpeg") continue;
      const data = readFileSync(j.dst);
      // a small flat-coloured map can come out bigger as JPEG: then the PNG stays
      if (data.length < readFileSync(j.src).length) replace.set(json.images[j.i].bufferView, { image: j.i, data });
    }
    if (!replace.size) return buf;
    // Rebuild the one buffer: every view's bytes in order, 4-aligned, the converted images swapped in.
    const chunks = [];
    let at = 0;
    json.bufferViews = json.bufferViews.map((bv, v) => {
      const data = replace.get(v)?.data ?? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      const offset = at;
      chunks.push(data);
      at += data.length;
      const pad = (4 - (at % 4)) % 4;
      if (pad) chunks.push(Buffer.alloc(pad));
      at += pad;
      return { ...bv, byteOffset: offset, byteLength: data.length };
    });
    for (const { image } of replace.values()) json.images[image].mimeType = "image/jpeg";
    json.buffers[0].byteLength = at;
    return writeGlb(json, Buffer.concat(chunks, at));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
