// Shared by the world3d tests: the real course, the asset index (when the library is there) and
// a scene player that always picks the right reply.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { comboKey, createCore, tilePieces, type Core, type Course, type GameState, type Input } from "@silver-tongue/core";
import { buildCourse } from "../../../tools/src/build-course";
import type { AudioOut, Speech } from "@silver-tongue/tui";
import { createGame, type Game } from "../src/game";
import type { AssetIndex } from "../src/layout";

const CONTENT = fileURLToPath(new URL("../../../content", import.meta.url));
/** The asset library the tests read: the vendored packages/world3d/assets unless WORLD3D_ASSETS says otherwise (as build.mjs). */
export const ASSETS = process.env.WORLD3D_ASSETS ?? fileURLToPath(new URL("../assets", import.meta.url));
export const course = buildCourse(CONTENT, "zh-china").course as Course;
const indexPath = `${ASSETS}/index.json`;
export const assetIndex: AssetIndex | undefined = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;

/**
 * A GLB's bytes from disk (AssetCache's `read`: the tests load the real GLBs without a server).
 * Node can't decode the embedded PNGs of the textured assets (GLTFLoader's image path wants a
 * browser: self, Image / ImageBitmap), so their images, textures and samplers are dropped here and
 * the materials load as plain factors; geometry, UVs and everything else are the file's own.
 * test/textures.test.ts checks the images themselves and the texture conversion.
 */
export function readGlb(path: string): ArrayBuffer {
  const buf = withoutTextures(readFileSync(path));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** The GLB with no images / textures / samplers and no material references to them (unchanged when it has none). */
export function withoutTextures(buf: Buffer): Buffer {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  if (!json.images?.length && !json.textures?.length) return buf;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const chunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + chunk.length + rest.length, 8);
  head.writeUInt32LE(chunk.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, chunk, rest]);
}

/** A core that counts the inputs sent to it, by type. */
export function countingCore(core: Core): Core & { sent: Input[] } {
  const sent: Input[] = [];
  return {
    sent,
    get state() {
      return core.state;
    },
    send(input: Input) {
      sent.push(input);
      return core.send(input);
    },
  };
}

export function makeGame(state: GameState, t0 = 1_000_000, audio?: AudioOut) {
  let t = t0;
  const now = () => (t += 1000);
  const core = countingCore(createCore(course, state, { now, rng: () => 0.42 }));
  const game = createGame({ course, core, now, audio });
  return { game, core };
}

/** A fake AudioOut: records each play() (the lines, in order) and each stop(). */
export function fakeAudio(available = true) {
  const plays: Speech[][] = [];
  let stops = 0;
  return {
    plays,
    get stops() {
      return stops;
    },
    available,
    play(lines: Speech[]) {
      plays.push(structuredClone(lines));
    },
    stop() {
      stops++;
    },
  };
}

/** The pick-mode option index core expects: the option whose key is the run's combo. */
export function rightOption(game: Game): number {
  const run = game.core.state.run!;
  expect(run.mode).toBe("pick");
  return run.options.indexOf(comboKey(run.combo));
}

/** Tiles mode: the tile indices that build the right reply, in order. */
export function rightTiles(game: Game): number[] {
  const run = game.core.state.run!;
  expect(run.mode).toBe("tiles");
  const ex = course.scenes.find((x) => x.id === run.scene)!.exchanges[run.exchange];
  const used = new Set<number>();
  return tilePieces(ex.variants[comboKey(run.combo)].reply).map((p) => {
    const i = run.tiles.findIndex((x, j) => x === p && !used.has(j));
    used.add(i);
    return i;
  });
}

/** Plays the scene in progress with right replies: picks, or tiles once the words are known. */
export function playScene(game: Game) {
  for (let guard = 0; game.core.state.run && guard < 20; guard++) {
    const mode = game.model.reply?.mode;
    if (mode === "tiles") game.replyTiles(rightTiles(game));
    else {
      expect(mode).toBe("pick");
      game.reply(rightOption(game));
    }
  }
  expect(game.core.state.run).toBeNull();
}
