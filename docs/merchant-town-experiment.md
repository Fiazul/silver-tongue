# Merchant town experiment

A separate playable Korean lab: the unfamiliar room, Min-jun's mutual language exchange, food/change/work, preparation, a changing weekly merchant, local competitors, agreed deliveries and the first-town invitation.

Local URL: `http://127.0.0.1:8765/merchant/` when the server below runs. Branch: `lab-merchant-town`. Saves use `silver-tongue-lab-merchant:v1`; main/door lab sessions are not read or written. Restart preserves a backup of this experiment. `/` and `/ko/` still serve their original builds.

## Build and run

Use Node 22. The new pure rules live in the actual private core checkout at sibling `st-merchant-core`, not inside the public frontend repository. No private source or source maps are bundled into the public browser page.

```bash
# From st-merchant-core (local private branch lab-merchant-town)
npm run build

# From st-door
npm run build:experiment
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

`MERCHANT_CORE_DIST=/absolute/path/to/private/core/dist npm run build:merchant` can select another compiled core directory. The experiment's TypeScript config currently points to the sibling checkout's declarations. This is local compiled integration, not a published core release. Normal production typechecks do not require this unpublished entry; `npm run typecheck:experiment` checks it explicitly.

## Play

- Enter a name. Read/answer the compact town story; outcomes stay until you continue.
- Choose two useful preparations. Chairs/cart is a straightforward supply strategy; cart/boxes supports delivery/packing. Waiting is a voluntary game-calendar jump.
- Talk to the merchant. Ask about the need, price or deadline; type an offer using Korean script. Phrase help inserts editable text and never sends it automatically.
- A substantive completed encounter uses one action. Returning exposes materially different needs: chairs → delivery → packing → a new chair order. Questions within one encounter do not advance the day.
- A proposed agreement is checked before commitment. Leaving with an unfinished proposal pauses it; returning or reloading resumes it. Decline with `아니요.` to close it and move on.
- The rival's price and same-day capability are visible. Quantity, price, available resources and timing matter. A grammar score does not decide victory.
- Confirm a viable agreement, then fulfill it. Payment happens once, after fulfillment. Confirmed terms survive the merchant leaving or taking another order.
- Read the closing friendship/town scenes. The next-town invitation is the ending of this experiment; town two is not implemented here.

## Time and support

Four actions make one game day. Visits occur on days 7, 14, 21…; two prep activities and one visit day are the chosen calendar model. Approximately 10/30 minutes are unmeasured play-duration targets from the design, not displayed countdown promises. Reading, typing, help, tab switching and offline time do not consume actions. Lost visits can be retried by advancing to the next weekly market without a real-world wait or a rent/food grind.

Meaning, pronunciation and sound support are adjustable. Help gives the same story reward; assisted offers are recorded as assisted rather than independent retrieval. Korean clips are prerecorded local assets; there is no runtime speech service or generated conversation dependency.

## Audio regeneration

`npm run audio:merchant` uses the existing Edge TTS/ffmpeg workflow for this experiment's own directory. It does not rewrite other courses' audio. The installed global edge-tts 7.2.8 received HTTP 403; a task-local `.cache/merchant-tts` environment with edge-tts 7.3.1 generated the clips successfully. Global tools were not upgraded.

```bash
PATH="$PWD/.cache/merchant-tts/bin:$PATH" npm run audio:merchant
```

The script excludes personalized player-name utterances from speech synthesis, skips silent punctuation, expands bounded quote templates and emits `audio.json`. Generated assets are local and copied by the experiment build.

## Validation and limits

Automated coverage includes alternative successful offers, changed requests, stable active turns, pending/reserved deals, negative/ambiguous/malformed amounts, explicit numeric counts, departures/retries, draft persistence, invalid saves, route isolation and IME Enter guards. The ordinary content builder still checks the existing three courses; experiment content also runs against its compiled core in its own integration tests.

The Korean dialogue and romanization are an authored draft and have not had a native speaker review. The compact experiment is not certified TOPIK coverage or evidence of language retention. Browser width tests do not replace an actual phone keyboard/IME or screen-reader test.

Design/review: [flow plan](superpowers/specs/2026-10-14-first-town-conversation-flow.md), [UX review](silver-tongue-first-town-ux-review.md), [research](silver-tongue-merchant-ux-research.md).
