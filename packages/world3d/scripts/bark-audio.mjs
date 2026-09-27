// Makes the barks' clips: one per line of barks/<language>.json, into barks/audio/<language>/
// <clip>.ogg and <clip>.m4a (the build ships them as assets/audio/barks/<language>/; the page picks
// the format by canPlayType), and writes each line's `clip` back into the JSON. Same voices and trim
// as the course audio (tools/src/audio.ts, voices.ts): edge-tts, the voice of the role (else the
// story NPC's in content/languages/<language>/voices.json, else the file's), clip id
// sha1("<voice>|<text>") first 16 hex, silence trimmed both ends, mono 24 kHz.
//
//   npm run bark-audio -w @silver-tongue/world3d          make the missing clips, drop unused ones
//   npm run bark-audio -w @silver-tongue/world3d -- --redo  make every clip again
//
// Needs edge-tts (pipx install edge-tts; EDGE_TTS=<path> to point at one) and ffmpeg. A line whose
// clip can't be made (offline) keeps no `clip`: the game says it silently.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(here, "..", "..");
const redo = process.argv.includes("--redo");

/** tools/src/audio.ts TRIM: edge-tts pads each clip with silence; keep a short lead-in and tail. */
const TRIM = [
  "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB",
  "areverse",
  "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB",
  "areverse",
].join(",");
/** tools/src/voices.ts clipId */
const clipId = (voice, text) => createHash("sha1").update(`${voice}|${text}`).digest("hex").slice(0, 16);

function edgeTts() {
  for (const c of [process.env.EDGE_TTS, "edge-tts", join(homedir(), ".local", "bin", "edge-tts")].filter(Boolean)) {
    if (!spawnSync(c, ["--help"], { stdio: "ignore" }).error) return c;
  }
  return null;
}

/** One clip: edge-tts to a temporary mp3, then trimmed into .ogg and .m4a (written as .part first). */
function make(tts, voice, text, base) {
  const mp3 = `${base}.tts.part`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(tts, ["--voice", voice, `--text=${text}`, "--write-media", mp3], { stdio: ["ignore", "ignore", "pipe"] });
    if (r.status === 0 && existsSync(mp3)) break;
    rmSync(mp3, { force: true });
  }
  if (!existsSync(mp3)) return false;
  const enc = [
    ["ogg", ["-c:a", "libvorbis", "-q:a", "3", "-f", "ogg"]],
    ["m4a", ["-c:a", "aac", "-b:a", "48k", "-f", "mp4"]],
  ];
  let ok = true;
  for (const [ext, args] of enc) {
    const part = `${base}.${ext}.part`;
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-af", TRIM, "-ac", "1", "-ar", "24000", ...args, part], { stdio: "ignore" });
    if (r.status === 0 && existsSync(part)) renameSync(part, `${base}.${ext}`);
    else {
      rmSync(part, { force: true });
      ok = false;
    }
  }
  rmSync(mp3, { force: true });
  return ok;
}

/** The bark file as written by hand: one line object per line. */
function text(book) {
  const j = (v) => JSON.stringify(v);
  const roles = Object.entries(book.roles).map(([role, r]) => {
    const head = r.voice ? `      "voice": ${j(r.voice)},\n` : "";
    const obj = (o) => `{ ${Object.entries(o).map(([k, v]) => `${j(k)}: ${v && typeof v === "object" ? obj(v) : j(v)}`).join(", ")} }`;
    const lines = r.lines.map((l) => `        ${obj(l)}`);
    return `    ${j(role)}: {\n${head}      "lines": [\n${lines.join(",\n")}\n      ]\n    }`;
  });
  const top = Object.entries(book)
    .filter(([k]) => k !== "roles")
    .map(([k, v]) => `  ${j(k)}: ${j(v)}`);
  return `{\n${top.join(",\n")},\n  "roles": {\n${roles.join(",\n")}\n  }\n}\n`;
}

const tts = edgeTts();
const ffmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
if (!tts) console.error("edge-tts not found (pipx install edge-tts, or EDGE_TTS=<path>): no new clips.");
if (!ffmpeg) console.error("ffmpeg not found: no new clips.");

let failed = 0;
for (const f of readdirSync(join(here, "barks")).filter((x) => /^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(x))) {
  const path = join(here, "barks", f);
  const book = JSON.parse(readFileSync(path, "utf8"));
  const voicesPath = join(repo, "content", "languages", book.language, "voices.json");
  const voices = existsSync(voicesPath) ? JSON.parse(readFileSync(voicesPath, "utf8")) : { npcs: {} };
  const dir = join(here, "barks", "audio", book.language);
  mkdirSync(dir, { recursive: true });
  const used = new Set();
  let made = 0;
  let lines = 0;
  for (const [role, r] of Object.entries(book.roles)) {
    const voice = r.voice ?? voices.npcs?.[role] ?? book.voice;
    for (const line of r.lines) {
      lines++;
      const id = clipId(voice, line.text);
      const base = join(dir, id);
      const have = () => existsSync(`${base}.ogg`) && existsSync(`${base}.m4a`);
      if ((redo || !have()) && tts && ffmpeg) {
        if (make(tts, voice, line.text, base)) made++;
        else {
          failed++;
          console.error(`✗ ${book.language} ${role} (${voice}): ${line.text}`);
        }
      }
      if (have()) {
        line.clip = id;
        used.add(id);
      } else delete line.clip;
    }
  }
  let dropped = 0;
  for (const x of readdirSync(dir)) {
    if (!used.has(x.replace(/\.(ogg|m4a)$/, "")) || x.endsWith(".part")) {
      rmSync(join(dir, x));
      dropped++;
    }
  }
  writeFileSync(path, text(book));
  console.log(`barks ${book.language}: ${lines} lines, ${used.size} clips (${made} made, ${dropped} files dropped)${failed ? `, ${failed} failed` : ""}`);
}
if (failed) process.exitCode = 1;
