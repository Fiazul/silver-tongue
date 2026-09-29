// A GLB's JSON and BIN chunks, read and written (shared by scripts/meshopt.mjs and scripts/textures.mjs;
// no dependencies, so the texture step runs where meshoptimizer isn't installed).
const align4 = (n) => (n + 3) & ~3;

export function parseGlb(buf) {
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

export function writeGlb(json, bin) {
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
