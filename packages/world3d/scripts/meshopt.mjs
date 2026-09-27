// Meshopt compression for the game's GLBs (EXT_meshopt_compression, decoded in the page by three's
// MeshoptDecoder: world.ts AssetCache). What gltfpack / gltf-transform `meshopt` do, written
// against meshoptimizer's own encoder (node_modules/meshoptimizer, the package three's types
// already pull in) since neither tool can be installed here:
//
// - index buffers (triangle lists): the TRIANGLES codec, lossless;
// - vertex attributes and animation outputs stored as floats: the EXPONENTIAL filter (15-bit
//   mantissa, one exponent per component across the buffer: a uniform step of at most
//   extent / 32768, 4 mm on the 140 m plateau, 3 cm on the mountains 600 m out, 0.06 mm on a
//   character), then the ATTRIBUTES codec;
// - animation key times, inverse bind matrices, and integer attributes (joints, weights as
//   bytes): ATTRIBUTES alone, lossless;
// - anything else (a view shared by several accessors, a stride the codec can't take): as is.
//
// The compressed views live in the GLB's own buffer; the decoded layout is a fallback buffer with
// no data (EXT_meshopt_compression `fallback`), so the extension is required. A GLB that already
// uses it is left alone, so running it twice changes nothing.
//
//   node scripts/meshopt.mjs <dir|file.glb>...     compress in place (every .glb under a dir)
//
// scripts/sync-assets.mjs runs it on the vendored assets/ after copying them from the library.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshoptEncoder } from "meshoptimizer";

const EXT = "EXT_meshopt_compression";
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const align4 = (n) => (n + 3) & ~3;

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  let bin = null;
  const off = 20 + jsonLen;
  if (off < buf.length) {
    const binLen = buf.readUInt32LE(off);
    bin = buf.subarray(off + 8, off + 8 + binLen);
  }
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.alloc(align4(jsonBuf.length) - jsonBuf.length, 0x20);
  const binPad = Buffer.alloc(align4(bin.length) - bin.length, 0);
  const jl = jsonBuf.length + jsonPad.length;
  const bl = bin.length + binPad.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jl + 8 + bl, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jl, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bl, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, jsonBuf, jsonPad, bh, bin, binPad]);
}

/** How each buffer view is used: accessors on it, index / vertex attribute / animation input / output / skin. */
function viewUses(json) {
  const uses = new Map();
  const use = (acc, role) => {
    const a = json.accessors?.[acc];
    if (!a || a.bufferView === undefined) return;
    const u = uses.get(a.bufferView) ?? { accessors: new Set(), roles: new Set() };
    u.accessors.add(acc);
    u.roles.add(role);
    uses.set(a.bufferView, u);
  };
  for (const m of json.meshes ?? [])
    for (const p of m.primitives ?? []) {
      if (p.indices !== undefined) use(p.indices, (p.mode ?? 4) === 4 ? "triangles" : "indices");
      for (const a of Object.values(p.attributes ?? {})) use(a, "vertex");
      for (const t of p.targets ?? []) for (const a of Object.values(t)) use(a, "vertex");
    }
  for (const an of json.animations ?? [])
    for (const s of an.samplers ?? []) {
      use(s.input, "time");
      use(s.output, "output");
    }
  for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) use(s.inverseBindMatrices, "matrix");
  // any accessor not reached above still pins its view (kept as is)
  (json.accessors ?? []).forEach((a, i) => {
    if (a.bufferView !== undefined && ![...(uses.get(a.bufferView)?.accessors ?? [])].includes(i)) use(i, "other");
  });
  return uses;
}

/** Resolves once the encoder (WebAssembly) is up: before compressGlb. */
export const ready = () => MeshoptEncoder.ready;

/** A compressed copy of a GLB, or null when it already is (or has nothing to compress). */
export function compressGlb(buf) {
  const { json, bin } = parseGlb(buf);
  if ((json.extensionsUsed ?? []).includes(EXT)) return null;
  if (!bin || (json.buffers ?? []).length !== 1 || json.buffers[0].uri !== undefined) return null;
  const uses = viewUses(json);
  const chunks = [];
  let binLen = 0;
  let fallbackLen = 0;
  let compressed = 0;
  const push = (data) => {
    const at = binLen;
    chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    binLen += data.byteLength;
    const pad = align4(binLen) - binLen;
    if (pad) chunks.push(Buffer.alloc(pad));
    binLen += pad;
    return at;
  };
  json.bufferViews = json.bufferViews.map((bv, i) => {
    const src = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const u = uses.get(i);
    const accs = u ? [...u.accessors].map((k) => json.accessors[k]) : [];
    const plan = (() => {
      if (!u || accs.length !== 1 || u.roles.size !== 1 || u.roles.has("other") || u.roles.has("indices")) return null;
      const a = accs[0];
      if (a.sparse || (a.byteOffset ?? 0) !== 0) return null;
      const elem = SIZE[a.componentType] * COMPS[a.type];
      const stride = bv.byteStride ?? elem;
      if (elem !== stride || elem * a.count > src.length) return null;
      if (u.roles.has("triangles")) {
        if (a.type !== "SCALAR" || (a.componentType !== 5123 && a.componentType !== 5125) || a.count % 3) return null;
        return { mode: "TRIANGLES", stride: SIZE[a.componentType], count: a.count };
      }
      if (stride % 4 || stride > 256) return null;
      const float = a.componentType === 5126 && !a.normalized;
      const filter = float && (u.roles.has("vertex") || u.roles.has("output")) && a.type !== "MAT4" ? "EXPONENTIAL" : undefined;
      return { mode: "ATTRIBUTES", stride, count: a.count, filter };
    })();
    const { byteOffset: _o, buffer: _b, ...rest } = bv;
    if (!plan) return { ...rest, buffer: 0, byteOffset: push(src) };
    const size = plan.stride * plan.count;
    let data = new Uint8Array(src.buffer, src.byteOffset, size);
    if (plan.filter === "EXPONENTIAL") {
      const f = new Float32Array(new Uint8Array(data).buffer);
      data = MeshoptEncoder.encodeFilterExp(f, plan.count, plan.stride, 15, "SharedComponent");
    }
    const enc = MeshoptEncoder.encodeGltfBuffer(data, plan.count, plan.stride, plan.mode);
    compressed++;
    const at = push(enc);
    const fb = fallbackLen;
    fallbackLen = align4(fallbackLen + size);
    const ext = { buffer: 0, byteOffset: at, byteLength: enc.byteLength, byteStride: plan.stride, count: plan.count, mode: plan.mode };
    if (plan.filter) ext.filter = plan.filter;
    return { ...rest, buffer: 1, byteOffset: fb, byteLength: size, extensions: { ...(bv.extensions ?? {}), [EXT]: ext } };
  });
  if (!compressed) return null;
  json.buffers = [{ byteLength: binLen }, { byteLength: fallbackLen, extensions: { [EXT]: { fallback: true } } }];
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXT])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXT])];
  return writeGlb(json, Buffer.concat(chunks, binLen));
}

/** Compresses every .glb under `path` (or the one file) in place; returns bytes before / after and the files changed. */
export async function compressPath(path) {
  await MeshoptEncoder.ready;
  const files = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (p.endsWith(".glb")) files.push(p);
  };
  walk(path);
  let before = 0;
  let after = 0;
  let changed = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    before += buf.length;
    const out = compressGlb(buf);
    if (out && out.length < buf.length) {
      writeFileSync(f, out);
      after += out.length;
      changed++;
    } else after += buf.length;
  }
  return { files: files.length, changed, before, after };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error("usage: node scripts/meshopt.mjs <dir|file.glb>...");
  for (const p of paths) {
    const r = await compressPath(p);
    console.log(`${p}: ${r.changed}/${r.files} GLBs compressed, ${(r.before / 1024).toFixed(0)} KB -> ${(r.after / 1024).toFixed(0)} KB`);
  }
}
