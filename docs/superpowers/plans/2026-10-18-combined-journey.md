# Combined Journey Implementation Plan

> **Layout note:** written when the story room was a standalone app with its own `game/` copy of this repo and of the private core. In this repo the app lives in `experiments/story-room/`, the game is the repo itself (pages built to `site/ko/` and `site/merchant/`), and the merchant chapter uses the compiled private core (`MERCHANT_CORE_DIST`), never its source. See `docs/story-room-experiment.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Play the stable door opening and merchant story as one saved journey, with the private room and editable bible inside the game.

**Architecture:** Preserve the two existing game engines and their rendering through embedded builds. Typed adapters publish gameplay snapshots and actual witnessed dialogue to a same-origin Python bridge; one shell coordinates the continuation and optional room/bible/scene panel. The existing independent app contains all source and runtime files.

**Tech Stack:** Existing Python HTTP server, TypeScript, Preact, esbuild, Vitest, vanilla shell JavaScript/CSS.

**Spec:** docs/superpowers/specs/2026-10-18-combined-journey-design.md

## Global Constraints

- Keep the original app and game checkouts unchanged.
- Preserve the stable door opening and its actual choices.
- Carry name, money, and calendar once; skip the duplicate merchant opening.
- Keep faceless icons and live bible editing.
- Character prompts receive only their own witnessed gameplay dialogue.
- Build and run without a sibling source checkout.

## Review Focus

- Reload during a pending merchant offer must preserve the draft and agreement.
- Repeated continuation must not reset the merchant chapter or duplicate money.
- Two NPCs must not receive one another’s private witnessed dialogue.
- A malformed save or unavailable storage must produce recoverable feedback.
- Narrow screens and opening/closing the room must preserve current gameplay.

### Task 1: Self-contained game builds and narrative handoff

**Files:** packages/journey/src/bridge.ts, packages/journey/test/bridge.test.ts; existing quiet-web main/storage and market-web main/session/build config.
**Interfaces:** Produces typed door/merchant snapshot adapters and createContinuedMarket(content, handoff). Handoff carries session, player, wallet, day, slot. Gameplay observations identify exact owning actor, speaker, and played text.

- [ ] Export committed frontend and core sources locally; install/copy independent dependencies, build courses, and establish baseline tests.
- [ ] Write failing tests for room-minjun completion gating, preservation of name/wallet/calendar, skipping duplicate story beats, and per-NPC witness ownership. Run Vitest and confirm missing implementation failures.
- [ ] Implement adapters and embedded-only hooks. Preserve default standalone behavior and use separate combined save keys.
- [ ] Run game tests, local core tests, typechecks and builds; confirm no sibling core paths or dependency links remain.
- [ ] Commit source and handoff changes.

### Task 2: Durable server bridge and source cast

**Files (under experiments/story-room/):** journey.py, test_journey.py, server.py, story_bible.py, agents.json, characters/merchant.json, world.json, prompts/.
**Interfaces:** GET/POST /api/journey, POST /api/journey/continue; data/journey.json stores validated snapshots and deduplicated witness records. context(root, actor) returns only that actor’s records. Static routes serve generated door, courses, and merchant assets from the repo root site/.

- [ ] Write failing tests for save/reload, handoff gates and idempotence, invalid payload preservation, witness isolation, and static route traversal refusal. Run the hermetic focused tests and confirm failures for the missing bridge.
- [ ] Implement atomic persistence, bounded validation and routing under the existing same-origin guard. Add only own gameplay context to actor prompts, with no control over game economics.
- [ ] Add The Merchant from source dialogue and update world/provenance for the combined story. Existing edits to cast files remain intact.
- [ ] Run focused Python tests, then the full hermetic engine suite.
- [ ] Commit server and cast changes.

### Task 3: Integrated play surface and complete verification

**Files (under experiments/story-room/):** web/journey.html, web/journey.css, web/journey.js, web/embedded.js, story_edition.py, tools/build_game.py, launcher labels, README and validation notes.
**Interfaces:** Shell accepts only same-origin messages from its own game frame, serializes snapshot writes, and switches chapter only after successful server continuation. Room/bible/scene panel preserves the mounted game and provides close/focus behavior.

- [ ] Build the shell with explicit loading/saving/continuation feedback and responsive panel controls, following the existing visual styles.
- [ ] Test in the browser: complete door opening, continue once, verify the same name/money, play a merchant agreement and delivery, reload, and verify pending-draft persistence. Open room and bible during play, edit a profile, and verify its next prompt sees own gameplay context only.
- [ ] Check mobile overflow, keyboard focus, zero loaded portraits/images, built asset routes, and the launcher.
- [ ] Run all game tests/typechecks/builds and the Python suite, review the whole branch, resolve findings, update docs, and commit.
