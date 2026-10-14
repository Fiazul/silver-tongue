# Silver Tongue: first-town UX review

2026-10-14. Method: dual-agent, independent design assessment (`/root/ux_design_review`) and detector/browser evidence (`/root/ux_browser_evidence`), synthesized with a source audit and primary-source research. Builder review checked the proposed flow separately.

## Verdict

The game has a promising opening and a useful language-through-action foundation, but it does not yet have a coherent, completed first-town journey. The biggest work is narrative continuity, meaningful progression, typed communication and a town payoff. Visual polish alone will not make the missing merchant competition playable.

Design health: **24/40**, an acceptable foundation requiring significant journey improvements. This is a heuristic assessment, not a user-study score or a measure of learning effectiveness.

## Scope and evidence

Reviewed the current Korean experiment in `st-door`, rather than the older 3D build or October 5 Scribe description. The live desk has quick-glance book/ID/bill papers; it does not force the older syllable transcription process. English/romanization/target text appear together in those paper views. Opening, desk, landlady, Min-jun, alley/mentor, selected shopping/number scenes, sentence help and Book were inspected in fresh browser QA tabs. Source review covered all 19 Seoul scenes, their prerequisites, 106 exchanges, world economy, stage progression, relevant UI/view helpers and installed core contracts.

Desktop viewport was 1850×876; responsive samples were 390×844. These were desktop Chrome width tests, not actual phone keyboard/IME or screen-reader tests. Screenshots are retained in [ux-evidence/2026-10-14](ux-evidence/2026-10-14/).

The late lab jumper sometimes returned to screen 15 instead of requested 55/65. This bounds browser coverage; it is a developer-tool limitation, not evidence of a player-facing ending failure. Paid-work results, late-town scenes, typed composition and completion were not verified by an exhaustive live playthrough. Those findings below are source-backed.

## What works

1. **A reason to understand.** Unknown room → knocking landlady → unfamiliar name → friend who needs English gives language an immediate human purpose. Food, work and short change create everyday stakes.
2. **Recoverable imperfect play.** The new opening gives wrong choices and silence characterful reactions. The Book and contextual help support staying in the story rather than repeatedly restarting a test.
3. **A distinct presentation.** A dark, quiet stage with paper replies and faceless characters is a coherent identity. Keep that identity while improving legibility and interaction.

## Heuristic assessment

| Heuristic | Score /4 | Key observation |
| --- | ---: | --- |
| System status | 2 | Current line/day part work; relationship gates and later progression are too hidden |
| Match to the world | 3 | Food, papers and work are understandable; later Min-jun premise contradicts the opening |
| Control and freedom | 2 | Help/Escape/silence exist; no clear conversation exit, and Book focus remains behind the overlay |
| Consistency | 3 | Most speech/action styling is consistent; deduction clouds introduce a competing visual language |
| Error prevention | 2 | Empty input and thought confirmation help; typed drafts clear without checking acceptance |
| Recognition over recall | 3 | Book, help and history are useful; relevant objective and changed merchant terms need persistence |
| Flexibility and efficiency | 2 | Shortcuts and reading/audio settings exist; expressive Korean typing is not enabled |
| Minimalism and hierarchy | 2 | Central conversation stays focused; important low-emphasis text and busy clue motion weaken it |
| Error recovery | 2 | Wrong deduction retains context; generic Scribe shakes without explaining misunderstanding |
| Help and documentation | 3 | Useful learning tools; small targets and vague/symbolic labels hinder access |
| **Total** | **24/40** | **Acceptable foundation** |

## Priority findings

### P1: the first-town promise has no implemented payoff

Observed in source: stage-1 survival leads into stage-2 campus/copy-shop material and repeatable work. There is no merchant NPC/event, persistent competition, town finale or next-town route in the inspected setting. `nextGoal` has no new one-off goal after the authored story runs out; repeat work remains available.

Fix: state a town problem and an attainable end condition. The proposed arc is earning a dependable supply/trade route for the neighborhood, then fulfilling a small deal and receiving an invitation beyond town. A closing scene must show a changed relationship and a new destination, rather than merely a higher word count. Shape the flow before adding more lesson scenes.

### P1: the revised opening contradicts later Min-jun scenes

Observed live/source: Min-jun returns and makes a mutual teaching agreement. Later `campus-labmate` says he has not come since March, `stall-family` treats him as absent, and `room-creditor` concerns his borrowing. The October 7 script itself lists this debt.

Fix: keep the strongest new motivation—the present friend—and rewrite later beats as an ordinary order/supply problem. Align target lines, learner meanings, callbacks and unlock prerequisites. A continuity rewrite cannot stop at narration.

### P1: translation matching is not expressive business conversation

Observed in source: Scribe asks for learner-language meanings and selects a prepared reply. Ordinary Korean has `typing: null`. The text-box rendering and `replyText` contract do not establish a parser for negotiation intent, quantity, condition, price or delivery commitments.

Fix: a typed merchant turn must communicate an action: ask, offer, counter, clarify, accept or decline. Distinguish unsupported wording from a bad business offer. Accept meaningful variations and ask narrow clarifications. Keep ordinary practice supported; remove compulsory “prove the translation before you may speak” gates from merchant turns. Two different feasible offers must be able to win.

Source risk: `Prompt.tsx` sends and immediately clears a 60-character local draft. Preserve it after unclear/rejected input and across interruption. `ReplyLine.tsx` already protects Enter during IME composition; preserve that strength and test real composition, long input and paste.

### P1: trust, money and time can feel like hidden homework

Observed in source: four slots/day, ₩20,000 start, ₩5,000 food/day, ₩50,000 rent/week. `room-letter` requires Ji-woo trust 3, while trust changes and some Book-mode unlocks are deliberately quiet. Repeat work can become necessary without an understandable story request.

Fix: show invitations and remembered deeds rather than a relationship spreadsheet. A useful first shift should open the next story opportunity explicitly. Extra work can buy an advantage, not silently satisfy a missing quota. Before consuming a slot, indicate its cost; at night, show what changed and the next useful action. Ensure economic narrative and actual wallet changes agree where amounts are consequential.

The merchant should visit weekly in game time, with one-day availability. Existing displayed hours derive from scene slots, not a 30-minute online timer. Avoid layering a silent wall-clock deadline over this calendar. The flow plan chooses action-based days and treats 10/30 minutes as pacing targets.

### P1: Book keyboard focus is broken

Browser reproduced: opening Book leaves focus on the underlying `book` button; pressing Tab reaches underlying `status` while the Book dialog is open. `Overlays.tsx` uses a plain `role="dialog"` container without modal/focus handling.

Fix: move focus into the dialog, keep background controls inactive, restore focus on close, and provide clear keyboard navigation. Announce meaningful speaker/turn changes; inspect screen-reader behavior rather than relying on ARIA presence. These are prerequisites for making a time-pressured language encounter usable.

### P1: changing merchant topics could make preparation feel wasted

This is a new-design risk, not an existing merchant defect. The user requires goods/needs to change every interaction. If the NPC silently forgets a furniture request, the player can feel punished for preparing.

Fix: persist the previous request and market state. Explain the change and offer a useful related or new opportunity: “The clerk brought the chairs. Now I need someone to deliver them.” Every completed subsequent encounter changes goods/needs materially; questions within one active deal remain stable. Honor reserved/confirmed agreements. Explain rival events, preserve prior discoveries, and avoid guaranteeing specific stock in the arrival notice.

## Additional issues

- **P2: small mobile assistance controls.** At 390px width, sentence-help `?` was 28×28px; footer Book/status/settings were about 19.64px high. A second sample measured a similar 19.6px help/footer height. Expand frequent controls to comfortable touch targets, using at least 44px as the design target; do not count glyph dimensions as hit area.
- **P2: essential reading text lacks contrast.** CSS-derived ratios: muted `#6f7d88` on `#0f1417` about 4.38:1; paper romanization `#7a7263` on `#e8e1cf` about 3.65:1; small reading `#6e6658` on the same paper about 4.35:1. Readings and story consequences need stronger contrast. History opacity makes some content harder still.
- **P2: generic miss feedback teaches little.** A shake or “That doesn't sound right” can indicate failure but not the missing distinction. Add short contextual explanations without turning every miss into a lecture. Avoid resource penalties for the parser failing to understand an otherwise useful attempt.
- **P2: repeated waits and study organization weaken focus.** Fixed reply/intro holds recur, the Book has six peer tabs, and place menus can show up to seven actions. Prioritize the relevant help/objective; keep deliberate study available behind a clear choice.
- **P3: labels and visual emphasis.** Use specific “Explain this line” / “Send reply” accessible labels. Calm the drifting/glowing clue clouds so their motion does not compete with Korean reading. Speaker rules have a useful attribution function.

No P0 runtime blocker was demonstrated in the sampled current player flow. Missing planned features are capability gaps, not invented crash reports.

## Review from tutorial through completion

| Journey segment | Existing strength / risk | Recommended flow |
| --- | --- | --- |
| Why learn? | Mutual teaching is compelling; survival/debt alone can become obligation | A friend and neighborhood need your help; comprehension produces early agency |
| Tutorial | Papers give clues; separate deduction and speech create multiple mental gates | One short clue-reading win, then use the words; optional papers remain in Book |
| First conversations | Wrong/silent replies can be funny; repeating yes/no indefinitely becomes passive | Respond to intent, make a visible consequence, let player recall a phrase |
| Food and shopping | Short change motivates numbers; nine-exchange shopping delays payoff | Compact transaction → mistake → useful repair, with no food soft-lock |
| Work | Item/count variation exists; repeatable work can gate hidden trust | One useful shift opens a story opportunity; subsequent work changes stakes |
| Mentor and Book | Rich support; mentor visit costs a slot and needs available notes | Immediate line help, optional deeper discussion; show any time cost before taking it |
| Day/night | Named parts already exist; slots are opaque and calendar day is often hidden | Show time cost and upcoming event; keep reading/typing own-paced; night recap |
| Merchant anticipation | Only a script aspiration exists | Durable notice, destination, two useful prep activities, voluntary wait |
| Competition | No persistent local rivals yet | Known NPCs with distinct advantages; visible changes after world actions |
| Returning conversation | Authored jobs vary slots but do not remember a market sale | Merchant recalls your request, explains material goods/need change, supports adaptation |
| Loss / missed event | No merchant recovery contract | Keep progress, show reason, smaller deal/practice/next visit; no real-week waiting |
| First-town ending | No finale found | A viable trade plus fulfillment, friendship callback and next-town invitation |

## Pacing review

Current source values: opening crawl 4–6.5 seconds plus 400ms before the prompt; scene intro 1,200ms; picked reply 1,100ms; input settle guard 350ms; desk fade 900ms; syllable movement 300ms; miss shake 400ms; toast dismissal 4 seconds. The opening's source state machine ignores advance input during its crawl. Browser advancement after the prompt is not evidence that the initial animation can be skipped.

Recommended established patterns: text at the player's pace, immediate readable content, skippable visual transitions, persistent critical messages, optional replay, and no deadline burning during technical waits. Starting values are about 150–250ms for acknowledgement and 200–300ms for scene changes; meaningful reactions remain until manually advanced. These values need local playtesting and are not universal solved game timings.

The proposed merchant warning is two prep actions targeting ~10 minutes; its stay is one four-slot day targeting ~30 minutes. Show game-calendar/action units clearly. Rival competition produces time rush through limited opportunities, not a hidden penalty for a novice's reading speed. See the flow plan for exact recurrence, last-call and departure rules.

## Cognitive load and emotional journey

Three landlady clues are a manageable option count, but interpreting Korean/romanization, remembering a paper, selecting a thought, confirming it and then speaking are several operations. Keep this as a short introduction, then remove steps as the player becomes capable. A merchant screen must not simultaneously show all stock, inventory, every study panel, several timers and a strategy menu.

The opening moves from uncertainty to recognition to social safety. Food, correcting change and earning pay can turn that into agency. Repetition, hidden trust and inconsistent story currently create an emotional valley. The merchant can be a peak—anticipation, preparation, a changing situation, adaptation and a clear result—if changes have understandable causes. The end should leave the player with a new capability and belonging, not another recommended shift.

## Player walkthroughs

- **Beginner who loses focus:** needs one obvious useful action, early consequences and a short return recap. Hidden relationship gates, cumulative waits and a cluttered notebook can interrupt the intention to continue.
- **Story-first player:** needs a worthwhile relationship and fresh stakes in compulsory scenes. Assisted typed speech should permit full story progress; optional study and repeat shifts should not be prerequisites for the finale.
- **Mobile/slow-input player:** needs generous help targets, a stable composer, IME-safe send, draft recovery and visible terms. Responsive screenshots cannot establish virtual-keyboard usability.
- **Keyboard/screen-reader player:** current Book focus reproduces a real barrier. Fix focus, announcements and navigation before adding deadline consequences.

## Prior art and learning limits

[Potionomics](https://store.steampowered.com/app/1874490/Potionomics/) documents rival shopkeeping, negotiation strategies and relationship-earned tactics: useful references for commercial stakes. [Chants of Sennaar](https://store.steampowered.com/app/1931770/Chants_of_Sennaar/) connects observation, language and story progress; [Newcomer](https://store.steampowered.com/app/2063790/Newcomer__A_Language_Learning_RPG/) documents contextual conversation quests and phrase support. These are reference patterns, not proof that Silver Tongue's free typing will work.

[Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/full-list/) recommends own-pace text, adjustable timing, objective reminders and contextual help. [Xbox guideline 116](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/116) covers non-core UI timers and explicitly excludes core gameplay timers; it does not establish an optimal merchant duration. [Lee's task-based chat study](https://scholars.unh.edu/lang_facpub/155/) reports difficulty from rapid exchanges, supporting caution about hurried composition. Full source qualifications and nine references are in the [research note](silver-tongue-merchant-ux-research.md).

## What to build and validate first

Repair the Min-jun continuity and required route, then prove one short typed encounter with two feasible solutions. Add a remembered furniture → delivery change, a rival, and exact deal confirmation before generalizing to a market. Integrate calendar notice/prep/departure only after players understand that interaction. Complete the town with fulfillment and a closing story scene; then broaden scenario variety and later adventurer competition.

The formative playtest must observe an early payoff, a return after interruption, a changed merchant request, clarification, help, loss and completion. Measure waiting/confusion/fun separately from delayed language use. Five test sessions reveal design problems; they do not establish attention benefits or language retention.

Detailed story, changing encounter examples, timing rules, implementation seams and validation gates: [first-town conversation-flow plan](superpowers/specs/2026-10-14-first-town-conversation-flow.md).

## Run notes

- Stable target: `packages/quiet-web/src`; slug `packages-quiet-web-src`.
- No project critique ignore list was present.
- A and B were separate agents and did not see each other's findings. Browser evidence was synthesized after the design assessment.
- Detector exited 2 with exactly two `side-tab` warnings at `quiet.css:402` and `:425`, both `border-left: 2px solid var(--who)`. These are speaker-attribution rules, so generic decorative-stripe criticism is a contextual false-positive risk. The scan is not an accessibility or game-design validator.
- Browser screenshots and snapshots were collected; viewport reset. No live detector overlay was injected: mutable preflight failed with “Cannot set property title … which has only a getter.” No user-visible overlay or visualization server exists.
- Root's temporary local static server was stopped after review. Assessment QA tabs were closed; QA lab game data was used, not an original user game. Screenshot evidence is intentionally retained; no temporary overlay scripts were created.
- Coverage limits: no exhaustive late-town browser traversal, actual mobile IME/keyboard, screen-reader test, or learning study. No new product-code fixes or releases are claimed.
