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
import { parseGlb, writeGlb } from "./glb.mjs";

export { parseGlb, writeGlb };

const EXT = "EXT_meshopt_compression";
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const align4 = (n) => (n + 3) & ~3;

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

/** Width and height of a PNG (IHDR), or null when it isn't one. */
export function pngSize(data) {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

/**
 * Width and height of a baseline / progressive JPEG, or null when its segment structure doesn't
 * hold: SOI, a chain of well-formed marker segments with a SOF before the first SOS, then entropy
 * data ending in EOI. (A structural decode: node has no image decoder; the sync's Pillow pass,
 * scripts/textures.mjs, fully decodes every JPEG it writes.)
 */
export function jpegSize(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return null;
  let i = 2;
  let size = null;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = data.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > data.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) size = [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
    if (marker === 0xda) return size && size[0] > 0 && size[1] > 0 ? size : null;
    i += 2 + len;
  }
  return null;
}

/**
 * What a GLB's surfaces need besides geometry: its images (each one's type, size and bytes),
 * textures, and which primitives carry TEXCOORD_0. compressGlb copies image views as they are and
 * compresses UVs like any float attribute; scripts/textures.mjs re-encodes base colour / ORM PNGs
 * as JPEG. checkSurfaces holds both to that for every textured asset.
 */
export function surfaces(buf) {
  const { json, bin } = parseGlb(buf);
  const images = (json.images ?? []).map((im) => {
    if (im.bufferView === undefined) return { mime: im.mimeType ?? "", uri: im.uri ?? "", size: null, data: null };
    const bv = json.bufferViews[im.bufferView];
    const data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    return { mime: im.mimeType, size: im.mimeType === "image/png" ? pngSize(data) : im.mimeType === "image/jpeg" ? jpegSize(data) : null, data };
  });
  const uvs = (json.meshes ?? []).flatMap((m) => (m.primitives ?? []).map((p) => p.attributes?.TEXCOORD_0 !== undefined));
  return { images, textures: (json.textures ?? []).length, uvs };
}

/**
 * Throws unless `out` keeps every texture and TEXCOORD_0 of `src` (`name`: for the message), and
 * every image: a PNG still a PNG byte for byte, or re-encoded as a JPEG of the same size that parses
 * (scripts/textures.mjs: base colour and ORM only).
 */
export function checkSurfaces(src, out, name) {
  const a = surfaces(src);
  const b = surfaces(out);
  const fail = (why) => {
    throw new Error(`meshopt: ${name} lost its textures or UVs: ${why} (${a.images.length} images / ${a.textures} textures -> ${b.images.length} / ${b.textures})`);
  };
  if (a.textures !== b.textures || a.images.length !== b.images.length) fail("counts differ");
  if (a.uvs.join() !== b.uvs.join()) fail("TEXCOORD_0 differs");
  a.images.forEach((x, i) => {
    const y = b.images[i];
    if (!x.data) return void (y.uri !== x.uri && fail(`image ${i} uri`));
    if (!y.data || !y.size) return fail(`image ${i} missing or unreadable`);
    if (x.mime === y.mime) return void (Buffer.compare(x.data, y.data) !== 0 && fail(`image ${i} bytes changed`));
    if (x.mime !== "image/png" || y.mime !== "image/jpeg") fail(`image ${i} ${x.mime} -> ${y.mime}`);
    if (!x.size || x.size.join() !== y.size.join()) fail(`image ${i} size ${x.size} -> ${y.size}`);
  });
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
    if (out) checkSurfaces(buf, out, f);
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
