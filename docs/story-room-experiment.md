# Story room experiment (lab)

The stable Korean door opening (`lab-landlady-door` at `3fd96785`) and the merchant town (`lab-merchant-town` at `c2cd52a0`) played as one saved journey, with a local Python app around them: a private room for group and direct chat with the cast, a scene desk, and an editable character bible. Design: `docs/superpowers/specs/2026-10-18-combined-journey-design.md`; plan: `docs/superpowers/plans/2026-10-18-combined-journey.md`. How to run it: `experiments/story-room/README.md`.

## Layout

- `experiments/story-room/`: the Python app (server, room, scenes, bible, journey bridge, its tests and tools). It serves the game pages from the repo root `site/`: `/game/door/` is `site/ko/`, `/game/merchant/` is `site/merchant/`, `/game/courses/` is `site/courses/`.
- `packages/journey/`: the TypeScript bridge. `src/bridge.ts` (door side, no private imports) builds the door snapshot; `src/market.ts` continues a merchant game from the door's handoff and builds the town snapshot, using `@silver-tongue/core/market`.
- `content/combined-journey.json`: the scene that unlocks the town (`room-minjun`), the town's first story step (`welcome`), and the map from game speakers to cast members.
- Small hooks in `packages/quiet-web/src/main.tsx` and `packages/market-web/src/main.tsx`, active only with `?journey=1`: separate save keys (`silver-tongue-journey-door:`, `silver-tongue-journey-merchant:<session>`), state reported to the parent page, the door's course list limited to Korean, the door resuming its last save, and the town starting from `/api/journey`'s handoff. Without `?journey=1` both pages behave as before.
- `packages/quiet-web/src/ui/Desk.tsx`: reading the optional newspaper during the desk fade no longer cancels the fade for good (found in the combined play-through; it affects the standalone door page too).

The merchant chapter needs the compiled private merchant core. `packages/market-web/build.mjs`, `vitest.config.ts`, the town tests and the `typecheck:merchant`/`typecheck:journey` scripts (through `tools/src/experiment-tsc.ts`) find it at `MERCHANT_CORE_DIST` or a sibling `../st-merchant-core/dist`, the default that `packages/market-web/tsconfig.json` and `packages/journey/tsconfig.json` name; the core's source never enters this repo. Without it, `npm run typecheck` and `npm test` still pass: `npm run typecheck` covers the public door bridge (`packages/journey/tsconfig.bridge.json`: `bridge.ts` and its tests), and the town tests skip (`packages/market-web/test/flow.test.ts`, `packages/journey/test/market.test.ts`).

## How the handoff works

1. The app's page (`experiments/story-room/web/journey.html`) embeds `/game/door/?journey=1`. The door page posts a snapshot (player, wallet, day, slot, scenes done, the lines each cast member actually said or heard) to its parent after every change; the parent saves it with `POST /api/journey`.
2. Once `room-minjun` is done and no conversation is running, the snapshot is `ready`, and **Continue into town** calls `POST /api/journey/continue`, which records the handoff once.
3. The parent switches the frame to `/game/merchant/?journey=1`. The town page reads the handoff from `GET /api/journey`, names the player, keeps the wallet and calendar, and starts at the town's `welcome` step, skipping the town's own opening. A saved town game for the same session is restored as it was (drafts and pending offers included), never re-handed-off.
4. Each cast member's prompt in the room gets only the lines they witnessed (`journey.context`), never another character's exchanges, and chat cannot change money, goods or agreements.

## Verification

The evidence below is from the pre-restructure build (the standalone app with its own copy of this repo and of the core source, 2026-10-17/18). In this repo layout, after the review fixes (2026-10-18), with the compiled merchant core (`silver-tongue-core` `6284e4e`) next to the checkout: `npm run typecheck`, `npm run typecheck:experiment` and `npm run build:experiment` pass; the full Vitest suite passes (987 tests, 69 files; without the core 969 pass and 18 skip, the town tests in `packages/market-web/test/flow.test.ts` and `packages/journey/test/market.test.ts`); `npm run typecheck` also passes on a clean `git archive` copy with no core at all; and the hermetic Python suite passes (497 tests, zero live-state open attempts). Before the review fixes, a server started from a disposable copy answered 200 on `/`, `/game/door/`, `/game/merchant/`, `/game/courses/index.json`, `/room`, `/story` and `/api/journey`, and 404 on paths outside the built pages; that check and the browser play-through have not been repeated since.

### Automated (pre-restructure)

- Full game and core suite: 1,129 tests passed, 78 files, Node 22.23.3.
- Full Python suite: 515 tests passed, zero live-state open attempts under the hermetic guard.
- All game, merchant and journey typechecks and the course and page builds passed.
- Handoff gating, wallet/name/calendar preservation, pending offer restoration, per-NPC witness privacy, completed-delivery receipts, invalid snapshots, archived save restoration and safe static paths have regression tests.

### Played in the browser (pre-restructure)

Against a disposable server and data directory, with the same built pages; no real chat history or game progress was touched.

1. Named the player Nadia, read the desk papers, answered the landlady, and finished Min-jun's language-exchange scene through the UI.
2. Continued once into the town welcome. The handoff kept Nadia, ₩20,000, day 1, slot 2, and skipped the town's opening.
3. Played the welcome, food, shop/change, work, supply-route and practice beats. The first wage raised the wallet to ₩30,000.
4. Inspected the chairs, borrowed the cart, and proposed a ₩5,000 same-day chair agreement. An unsent Korean draft survived opening the private room, closing the page, restarting the server and reopening the game; the pending terms and resources came back.
5. Edited Min-jun's backstory in the bible with a temporary lesson label, then asked him in a private chat to recall the name given in the game and the label. His live reply: `Nadia. You said, "Nadia입니다," in my room. And our lessons? "Blue notebook." I remember! Did I get both right?` The question contained neither answer, and the reply was visible only to Min-jun and the player. The edit was then restored.
6. Confirmed and fulfilled the agreement, read the ending, and reached the first town complete at ₩33,000. The paid-delivery receipt reached the merchant's context and not Min-jun's.
7. Opened the bible editor and scenes inside the game; closing a panel restored focus and kept the game mounted.

### Regressions found in play and fixed (pre-restructure)

- Reading the optional newspaper during the desk fade could cancel its timer for good (the `Desk.tsx` change).
- Rapid story advancement could keep another NPC's old reaction in the town snapshot; the adapter now reads only dialogue shown in the current phase.
- A failed sync could lose its observations when newer progress was already queued; Retry now keeps both.
- Player-first town choices were missing from NPC continuity, and prose reactions were labelled as NPC quotations; the adapter now names the conversation's owner and keeps narration as narration.
- The embedded room puts chat before the cast roster. At 390 × 844 the composer is visible without scrolling, the cast scrolls sideways, the page does not overflow, and no portrait or image loads.

A second-party review of that build stopped at a usage limit before finishing; no completed sign-off is claimed.

### Bible and cast migration (pre-restructure, 2026-10-17)

- The cast files (`characters/<id>.json`) and `world.json` are overlaid on `agents.json` whenever configuration loads (`server.load_config()`); edits are validated, saved atomically with revision checks, and reach the next prompt. Recipient ids stay stable, so conversations and memories keep their owners.
- Hermetic suite: 506 tests passed then, zero live-state open attempts; 48 focused scene, bible and story tests after the final prompt changes.
- In the browser: Min-jun's backstory and the world notes were edited, reloaded, confirmed and restored; a private message and a group mention got in-character replies visible only to their participants; at 390 × 844 nothing overflowed and no image loaded.

## Known limits

- The town is a calendar continuation entered with **Continue into town** after Min-jun's scene; a merchant arriving mid-door has not been built.
- Contradictory older scenes (the stall family "not here now", rent "paid up to March", Su-jin "hasn't come since March", the creditor's debt) stay unresolved in `experiments/story-room/world.json`; they are not current facts.
- Building the town needs the private core's compiled `dist/`. Public CI has no private core: it typechecks and tests the door side, skips the town tests, and does not run the Python suite.
