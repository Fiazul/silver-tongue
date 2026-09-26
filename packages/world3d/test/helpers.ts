// Shared by the world3d tests: the real course, the asset index (when the library is there) and
// a scene player that always picks the right reply.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { comboKey, createCore, tilePieces, type Core, type Course, type GameState, type Input } from "@silver-tongue/core";
import { buildCourse } from "../../../tools/src/build-course";
import { createGame, type Game } from "../src/game";
import type { AssetIndex } from "../src/layout";

const CONTENT = fileURLToPath(new URL("../../../content", import.meta.url));
/** The asset library the tests read: the vendored packages/world3d/assets unless WORLD3D_ASSETS says otherwise (as build.mjs). */
export const ASSETS = process.env.WORLD3D_ASSETS ?? fileURLToPath(new URL("../assets", import.meta.url));
export const course = buildCourse(CONTENT, "zh-china-en").course as Course;
const indexPath = `${ASSETS}/index.json`;
export const assetIndex: AssetIndex | undefined = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;

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

export function makeGame(state: GameState, t0 = 1_000_000) {
  let t = t0;
  const now = () => (t += 1000);
  const core = countingCore(createCore(course, state, { now, rng: () => 0.42 }));
  const game = createGame({ course, core, now });
  return { game, core };
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
