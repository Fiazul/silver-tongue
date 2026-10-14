# Merchant town experiment verification

2026-10-15, local branch `lab-merchant-town` in public `st-door` and private `st-merchant-core`.

- Public full suite: **972 passed**, 66 files.
- Private core full suite: **146 passed**, 10 files, including 23 merchant behavior cases.
- Final focused session/site/audio/real-content integration run: **19 passed**, four files.
- `npm run typecheck:experiment`: passes ordinary and experiment configurations.
- Private `npm run typecheck` and `npm run build`: pass. Compiled market entry and declarations only; package dry-run contains no source.
- Ordinary course build: Japanese 15 scenes, Korean 19, Chinese 42; exits successfully. Existing learning/gloss warnings remain.
- Experiment HTML/content/audio and three-route site build: passes. Root and old Korean lab routes preserved by integration tests.
- **72** prerecorded Korean clips exist and are nonempty; built manifest/files verified. No audio service is called during play.
- Design detector on new experiment source: no findings.
- Diff whitespace checks: pass in both repositories.

Browser checks used actual Chrome at desktop and 390×844: opening through all closing scenes; furniture → delivery → packaging; prior-topic recall; tomorrow rejected for commercial reason; phrase insertion before explicit send; draft reload; paused proposal reload/resume; confirmed deals retained across new requests; fulfillment paid once and first-town completion shown.

Phone-width sampled story/completion have no horizontal overflow. Replay target is 44px high, help/footer48px. Opening a native help dialog moves focus to Close; Tab remains inside the dialog. Viewport override reset after verification. Evidence screenshots: [merchant-town](ux-evidence/merchant-town/).

Independent review found numeric/negation/pending/save issues; fixes have failing-before/passing-after regression cases. The last finding, entering a finale while another proposal is paused, is prevented in both rules and UI; its resulting save remains valid.

Limits: native Korean/romanization review, a real mobile keyboard/IME session, a screen-reader session and learning-retention playtests were not performed. The parser supports bounded authored intent/terms, not unrestricted conversation. Minute values are design targets, not measured visit durations. Town two is an invitation only.
