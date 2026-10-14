# Merchant town experiment implementation plan

> For agentic workers: use superpowers:executing-plans for inline execution. The user authorized implementation as a new experiment on 2026-10-14.

**Goal:** Deliver an isolated playable Korean first-town experiment from waking through a changing merchant competition and departure invitation.

**Architecture:** Put new pure experiment rules in the actual private `silver-tongue-core` checkout at sibling `st-merchant-core`, exported as a separate market entry. Build a separate Preact experiment at `/merchant/` with its own versioned saves, content and stylesheet. Existing quiet/lab pages continue to use their existing compiled core and course files. Local build consumes the private core's compiled market entry; no private source is copied into this repo and no package is published.

**Tech stack:** TypeScript, Preact, esbuild, Vitest, local JSON content, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-14-first-town-conversation-flow.md`.

## Global constraints

- Merchant visits weekly in game time and stays one four-slot day. Two preparation actions target approximately 10 minutes; one market day targets approximately 30 minutes. No wall-clock expiration while reading or typing.
- Goods or needs materially change on each completed subsequent merchant encounter; turns within an encounter remain stable. Refresh never rerolls it.
- Target-language communication with optional phrase assistance; neither translation grading nor unbounded-chat claims.
- Offline/scripted, pure injected state transitions; no generated conversation service.
- Content supplies all Korean, learner copy and scenario/NPC IDs. Core and UI are language-neutral.
- New namespace and route; preserve older sessions and source content. No push, deploy or package publication in this task.
- Experiment wording receives automated structure/behavior checks; native Korean review remains a documented limitation.

## Review focus

1. Unsupported or ambiguous typing, negation, quantities and prices must not accidentally commit a deal.
2. Re-entering a merchant encounter cannot farm stock or invalidate confirmed contracts.
3. Departure finishes an active offer and offers retry; assisted success still completes the town.
4. Reload, changed content, invalid saves and storage failure preserve a recoverable playable state and never touch old namespaces.
5. Mobile composition, keyboard focus and manual story advancement must preserve text and prevent accidental sends.

## Tasks

### Task 1: Pure experimental game core and authored town

Files: private core `src/market.ts`, `test/market.test.ts`, `build.mjs`, `package.json`; public repo `content/experiments/merchant-town/ko.json`.

Interfaces: `createMarketGame(content, saved?) -> { state, send(input) }`; JSON-serializable versioned `MarketState`; input discriminated union for naming, story choice/continue, preparation, merchant start/text/leave/confirm, wait, fulfill and ending. Rendering reads state and content; rules own calendar, rivals, offers and victory.

- [ ] Write failing behavior tests for full town reachability, alternative feasible offers, changed returning demand, stable in-conversation state, confirmation, loss/retry and save parsing.
- [ ] Run them and verify failures represent missing behavior.
- [ ] Implement the pure core and content-driven story/intent grammar; compile the market entry separately.
- [ ] Verify merchant tests, private core suite/typecheck/build and package content privacy.

### Task 2: Separate playable browser experiment

Files: `packages/market-web/{package.json,tsconfig.json,build.mjs,src/*,test/*}`; `tools/src/site.ts`, `tools/test/site.test.ts`, root package scripts.

Interfaces: consumes private compiled `market` entry and `ko.json`; build emits self-contained HTML and content; site option `--merchant` writes `/merchant/`. Storage key is `silver-tongue-lab-merchant:v1`; existing production/door keys are never read/written.

- [ ] Write failing site isolation and save/draft recovery tests.
- [ ] Implement route build, storage wrapper and Preact game UI with story, objective/calendar, prep, merchant terms, typed composer, phrase help, durable journal and town finale.
- [ ] Use explicit manual advances, short skippable visual changes, readable text and generous controls. Test IME-safe send behavior and preserve drafts on unclear input/overlays/reload.
- [ ] Verify focused tests/typecheck/build and production/lab route preservation.

### Task 3: End-to-end verification and handoff

Files: experiment README/runbook and validation record; source changes only when verification exposes a defect.

- [ ] Run public suite, private suite, typechecks, content build and experiment site build; inspect each result.
- [ ] Play fresh browser route from opening to town completion, returning changed opportunity, lost visit/retry and saved draft. Check phone width and keyboard/help.
- [ ] Request independent whole-change review, fix important findings with targeted tests and reverify.
- [ ] Leave a documented local launch command and link to playable experiment; report remaining native-language/actual device limits honestly.

## Rulings

- This is a self-contained lab capsule with its own pure game state/API in the private core, not a change to released core 0.19's public `GameState` or main course. Migrating proven mechanics into the main game will require a later core release.
- The new experiment uses a compact, authored opening and town arc rather than entering the old 106-exchange route and inheriting its contradictions. It retains Min-jun's friendship and the same world premise.
- A local private-core checkout is available; compiled-entry integration avoids publishing or committing private source into the public game repository.
