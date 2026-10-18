# Make It in China · A Place in Town

The stable **landlady-door** opening, the **merchant-town** story, and the private room now run inside one independent application.

A lab experiment inside the Silver Tongue repo: the app lives in `experiments/story-room/` and serves the game pages built at the repo root (`site/ko/`, `site/merchant/`).

You need Python 3, Node 22+ and npm, a `GITHUB_PACKAGES_TOKEN` that can read the private core package (see the root `CLAUDE.md`), and the compiled private merchant core (`silver-tongue-core` built to its `dist/`; a sibling `st-merchant-core/dist` is found on its own, anywhere else is named with `MERCHANT_CORE_DIST`):

```bash
git clone --branch lab-story-room https://github.com/Bannerless-Studio/silver-tongue.git
cd silver-tongue/experiments/story-room
export GITHUB_PACKAGES_TOKEN=$(gh auth token)
export MERCHANT_CORE_DIST=/path/to/silver-tongue-core/dist   # unless it is ../st-merchant-core/dist next to the clone
python3 launch_story.py
```

The launcher builds the game on first run (when `site/ko/` or `site/merchant/` is missing) and opens your browser.

[Play](http://127.0.0.1:8876/) opens straight into the original door experiment. Read the papers, work out the landlady’s words, and meet Min-jun. After his language-exchange opening, choose **Continue into town**. Your name, wallet, and game calendar carry over; the repeated merchant opening is skipped. Meet Grandpa Park, visit the stall and shop, earn the first wage, prepare for market, negotiate an offer, and fulfill the delivery to finish the authored town story.

## Conversations inside the game

Use **Private room**, **Bible**, or **Scenes** in the game’s header. The game stays mounted while the panel is open, including an unfinished offer or draft. **Back to game** closes the panel. On a narrow screen the panel uses the available space and the game returns when you close it.

The room retains group chat, direct messages, personal memory, relationships, and separate scenes. Characters receive their own witnessed game dialogue as continuity. They do not receive another character’s exchanges or the full author bible. Chat can develop the story or practice a conversation; use the game’s offer, agreement, and delivery controls to change its money, resources, and contracts.

The cast is **The Landlady, Kim Min-jun, Grandpa Park, Ji-woo, The Corner Shop Clerk, Su-jin, The Copy Shop Man, The Man in a Suit, and The Merchant**. Each has its own sourced file in `characters/`, with a backstory, personality, goals, voice, instructions, and dialogue examples. Icons remain faceless.

## Edit the bible

Choose **Bible → a character → Edit character**. Saving updates their actual JSON file and next AI prompt. **Edit world & player** changes the setting and author reference. Private instructions reach their owner; author notes stay outside character prompts. The game’s authored language lessons and deterministic trading rules remain their source versions.

Direct pages are still available: [room](http://127.0.0.1:8876/room), [bible](http://127.0.0.1:8876/story#bible), and [scene desk](http://127.0.0.1:8876/story).

## Files

All paths below are relative to `experiments/story-room/` unless they start at the repo root.

- Repo root `site/ko/`, `site/merchant/`: the built door opening and merchant town (generated, ignored by git). The app serves them as `/game/door/` and `/game/merchant/`.
- Repo root `packages/journey/`: the bridge both game pages use when embedded (`?journey=1`) to report witnessed lines and hand the door save on to the town. `content/combined-journey.json` maps the cast and the handoff scene.
- `characters/<id>.json`, `world.json`, `prompts/`: editable canon and AI behavior.
- `data/`: this copy's room history, memory, scenes, and the gameplay-to-room bridge (runtime state, ignored by git).
- Browser storage: this copy's door saves and per-game merchant saves, including drafts and pending offers, under `silver-tongue-journey-*` keys.
- `CHARACTER_BIBLE.md`: generated author reference; download a current copy from the bible.

Installed AI provider CLIs and their authenticated accounts are machine services. The fixed game and prerecorded lessons work without AI calls; AI chat requires an available authenticated provider.

## Build and verify

```bash
python3 tools/build_game.py          # npm ci if needed, then build:course and build:experiment at the repo root
python3 tools/verify_hermetic.py     # the Python tests, in a disposable copy with live state unreadable
cd ../..
npm run typecheck:experiment
npm test
```

`tools/build_game.py` stops with a clear message when the compiled merchant core is missing. Without it the public parts still check: `npm run typecheck` and `npm test` skip the tests that need the private core. Game content comes from `lab-merchant-town` (`c2cd52a0`), whose door opening is the stable `lab-landlady-door` commit `3fd96785`; the merchant core was `silver-tongue-core` `b01ebd6` when this was put together. See `docs/story-room-experiment.md` at the repo root for what was verified.

## Working on it

- `/` is the combined game, `/room` is group/private chat, `/story` is the scene desk, and `/story#bible` is the editor.
- Canonical profiles live in `characters/<id>.json`; `agents.json` references them. `world.json` holds the setting and player; `prompts/` holds roleplay rules. Canon is Seoul, 2000, with Min-jun at home.
- Bible edits must reach the next actual prompt. Keep author notes and other characters' private knowledge out of personal prompts.
- Run the Python tests only through `python3 tools/verify_hermetic.py`; never run them against live saves in `data/`.
- Keep faceless icons throughout; no displayed photos or upload UI.
- Never copy the private core's source into this repo; the merchant chapter only ever reads its compiled `dist/`.
- `data/`, `logs/`, `output/` and `archive/` are local runtime state and stay out of git.
