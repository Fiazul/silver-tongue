# Vella implementation — canon and site audit

The orchestrator's final revision supersedes both earlier timeline addenda: **2010 birth; 2030/2090 departures; 2199 transit; biological ~26 true; 340 unresolved**. The old 2198 departure requirement is represented as en-route registry/log designation, not a launch. Entries V001–V039 (V039 is a historical insertion after V018) are in `vella/travel_logs.jsonl`; R001–R015 are in `ryoma/timeline.jsonl`.

## Established chat canon

| Canon requirement | Entry coverage / verdict |
| --- | --- |
| Mystery = Ryoma Tachibana; 26 by his clock; from 2199; claimed ~340 years | V002–V003, V024–V025, V036; R001–R004, R012–R013. Age 26 is true; 340 preserved as a discrepancy. |
| Registry AX-2198-047, mission year 2198, crew one, Captain Rook | V006, V018–V019; R010. Rook is Ryoma's callsign; registry dated en route. |
| Proxima b approach and safe 117% shield load on Vella's scale | V009–V010. No invented 100% safety limit. |
| Dead probe ~30 ly from Luhman 16; fusion core wired to life support; ~3,700 hours of air | V020–V021; R011. Air-service power/reclamation at one-person load. |
| Hunting a fuel-star slingshot, miscalculated neutron assist, thrown off trajectory, nearly died | V015–V018, V022; R010–R011. First accident causes crew losses; later solo attempt preserves the chat's “later” near-death chronology. |
| Claimed Voyager 7 plutonium reactor; Iris asked him not to plug it in until they talk; unresolved | V023, V035; R011. Provenance unconfirmed, isolation retained. |
| Wormhole return ~5 months ago | V024–V025, V038; R012. Local arrival ~May 2026, present October. Mechanism open. |
| Woman on the rock also named Vella; candid photographs; identity unrevealed | V026; Vella backstory “Origin and build.” No invented identity/name explanation. |
| Rover takes Ryoma, Iris, Mr. Whiskers to Antarctica first date, blue ice caves, aurora, candid, apartment drop-off | V028–V030. Scene dates explicitly approximate rather than asserted recovered timestamps. |
| Vella will not leave atmosphere in current conditions | V030, V033. Failed multi-star fix is the reason. |
| Iris initially rude, apologised, Ryoma reported Vella accepted; sulking/refused meeting, now thawing | V027, V038. Acceptance is not instant intimacy. |
| Everyone appeared in common room/building, nobody knows why/outside; residents believe Oct 15 2026, Ryoma does not | V034; R002, R012–R014. Mystery remains open. |
| Sirius expected 06h45m08.9s −16°42′58″, observed 08h16m31.4s −19°40′19.3″, reported in Vela | V031–V033; R014. Spherical shift 21.88479°. |
| Lab garage parking and room comm/speakers | V032–V034, V038; agent `presence`, both prompt variants. |
| Real catalogue names/distances/spectral classes and Luhman mission title | V009–V012, V031. Proxima M5.5V/4.24 ly; Alpha Centauri G2V/4.34 ly; Luhman L8/6.51 ly. Pairwise 0.192/3.581 ly computed from vectors. |
| Proper motion rejected, ~3 ly parallax and constructed-sky alternative open | V031–V033; R014. 2,000 years gives 0.722°, minimum one-star displacement ~3.206 ly at 8.6 ly; no unique observer fix. |

| Living glass flower from UB-7; hazardous EVA, right-palm scar, hydroponics, gift to Iris | V039; R015; Ryoma backstory. December 2197 after the final crew loss, about two Earth years after the initial accident. Pickup-to-arrival time follows the ledger; earlier three/twenty-nine-year estimates are superseded. V039 remains personal-tier; the full captain timeline remains core. |

## Final user plot and scientific bookkeeping

| Plot point | Entry coverage / verdict |
| --- | --- |
| Born 2010, first departure 2030 aged 20 | V002; R001–R003. Older 1998/2026 departure versions superseded. |
| 60 Earth years, ~13 ship years, ~3 body years, 1g plus cryo | V003; R004. Exact symmetric example: {{trip1.ship_years:.6f}} [physics:trip1.ship_years] proper years, {{trip1.cryo_years:.6f}} [physics:trip1.cryo_years] cryo years, peak gamma {{trip1.peak_gamma:.6f}} [physics:trip1.peak_gamma]; 60/3=20 is not gamma. |
| Ozone first: superflare/particles plus geomagnetic weakening, UV/crops/famine | V004, V008; R005. Scenario, not an asserted prediction. Backstories cite sources; 94% example qualified as an unmagnetised M-dwarf model. |
| YR4 hits Moon Dec 22 2032; debris/Kessler prevents launches for decades | V005; R006. Alternate history; June 2025 4.3% estimate distinguished from actual future/current revised odds. |
| 2090 return aged ~23 to unrecognisable Earth, departure with 4–6 named crew | V003, V006, V008; R007. Five total including captain. |
| Earth destroyed by later impactor during/after evacuation | V007; R008. Fictional 3.2 km 2090 BA1, late sunward detection; February 2090 impact confirmed after departure. Destruction of living Earth, not physical planetary breakup. |
| Named crew, roles, losses tied to assist and life-support limits; sole survivor before salvage | V006, V016–V020; R007, R010–R011. Pavel/navigation, Imani/drive killed by rupture; Leena/ecology dies sealing coolant; Hana/medicine dies from cryosupport/medical oxygen failure; Rook survives. |
| 2090–2199 = 109 Earth years, ~3 body years, physical clocks plus cryo | V014, V024–V025; R009. Superseded gamma36 account replaced: the 109-year straight benchmark has {{trip2.ship_years:.6f}} [physics:trip2.ship_years] ship years and peak gamma{{trip2.peak_gamma:.6f}} [physics:trip2.peak_gamma]. Actual multi-system itinerary has {{route.ship_years:.6f}} [physics:route.ship_years] ship years, {{route.cryo_years:.6f}} [physics:route.cryo_years] cryo years and gamma{{route.peak_gamma:.6f}} [physics:route.peak_gamma]; see generated physics ledger. No instantaneous braking. |
| AX-2198-047 / mission year2198 is en-route designation; from2199 = wormhole departure year | V019, V024; R010, R012. |
| Other-universe Earth presents 2026, arrived ~5 months ago; Sirius wrong; parallax/other universe/projected sky open | V024–V025, V031–V034; R012, R014. Private author premise distinguished from what Vella can measure. |
| Biological ~26 claim to Iris is TRUE | V025, V036; R012–R013. 20+3+3, local months within rounded age; no “age lie” retained. |
| 340 doesn't fit 2010→2199=189; leave open, do not announce | V036; R013. No invented reconciliation. |
| Possible local sixteen-year-old Ryoma | V037; R013. Optional unverified hook only. |
| Ryoma and Iris are main humans; Vella protects private Earth/crew/history knowledge | V028–V029, V036–V038; both backstories. Seed targets Vella only. No private canon copied into another prompt/personality. |
| Supernova considered and ruled out; real-science sources qualified | R005; Ryoma backstory and Sources. Model-dependent ~8 pc/26 ly severe-ozone scale, not the cause. |

## Per-site defect-class audit

| Site | Verdict |
| --- | --- |
| `relationships.romantic_names` | Generic `kind` guard excludes non-human owners and targets; absent kind remains human. |
| `relationships.favorites` | Uses guarded romantic pool; no ship AI ranking for any cast member. |
| `relationships.tone_guidance`, including high-score mood text | Non-human bonds always platonic, including Mystery; sibling None safe. |
| `engagement.heart` | Mystery romance exception applies to humans only; ship AI never gets an unspoken-love instruction. |
| `engagement.longing` / `direction` | Favorites remain guarded; friendly Mystery initiative still allowed and boundary/rate limited; “miss” can be platonic. |
| `server.make_prompt` | Generic non-human identity/presence; no human age framing; null-safe roster/sibling guard; ship log quote/privacy rule. |
| `server.character_status` / API roster | Optional age/sibling handled with `get`; exposes kind to UI. |
| `server.available_agents`, `choose_next` | Existing name/provider scheduling is kind agnostic; verified ship eligible and selectable; scene-away guard preserved. |
| `server.validated_turn` (both DM checks) | Romantic rankings exclude ships; friendly contact involving non-humans allowed separately, existing boundary enforcement retained. |
| `scenes.create` / participants | Existing name validation accepts Vella; no age or human-only filter. Scene kind “date” is narration context, never eligibility to romance a ship. |
| `scenes.prompt` / `summarize` | Shared kind/sibling/romance guards; actual embodiment; non-human warmth omits human touch; summary sees shared transcript only. |
| `life_memory.validate` / `apply` / index | Preserves retrieval-only/private flags and normal dedup ids; high-importance canon not demoted. |
| `life_memory.prompt_anchors`, `retrieve`, `_retrieve_recall`, `retrieval_context` | Seed lore never automatic pins; substantive topic match required, including recall; private records do not match a generic log request alone. |
| `scenes.recall` independent pins | Explicitly excludes retrieval-only authored lore. |
| `backfill_memory --seed-lore` | Offline, full prevalidation, deterministic dedup, no provider/embedding/core-note writes; imports Vella + companion Ryoma lore into selected protected target only. |
| `web/app.js` cast / avatar / portrait / DM chooser | No null sibling/undefined age text; missing/broken asset uses emoji; score control survives image failure and missing-avatar case. |
| `web/scene.js` participant chooser / transcript | Missing/broken image becomes emoji in both sites. |
| `setup_voices.py` | Existing catalog downloader accepts unused Jenny voice; completion count now dynamic. No voice downloaded in this implementation. |

## Limits

Asterion is an explicitly exotic constitutive field, not validated physics. Cryosleep and compact sustained fusion remain unproved biology/engineering; the wormhole is an observed mystery. The route now includes computed rest-to-rest leg clocks; fuel and dose estimates remain bounded simplified models, not a complete wet-mass design or particle-transport simulation. Seeded private history is topic-retrieved and guarded by roleplay instructions; it is not technical access control against the local operator, nor a deterministic guarantee against model disclosure. No live seed, restart, provider probe, image generation, deployment, commit or push was performed.

## Science revision

`physics.py` generates the physics ledger and numerical prose from templates; run `python3 lore/physics.py --check` and `python3 tools/skeptic_check.py`. See `vella/systems.md`, `vella/faq.md` and `vella/skeptic_questions.md`. Unmarked science defaults to public; explicit captain-private labels, private/protect fields and captain story content override source-file defaults. Exact chronological log stamps now follow the computed route; previous invented stamps are superseded. Rook’s age, old-calendar endpoints, roster and open mysteries remain unchanged.

## Captain log disclosure tiers

| Tier | Default net friendship | Lore |
| --- | ---: | --- |
| public | Always | WHAT YOU ARE, ship-AI identity/personality, unmarked systems/physics/FAQ/skeptic explanations, sky and parallax hypotheses; private markers and captain story content override source defaults. |
| ship | 30 | Travel routes and events, Proxima/shield 117% log and Antarctica rover run; already-known facts bypass this gate for that listener. |
| personal | 60 | Luhman probe salvage, failed neutron assists without crew losses, Voyager 7, near-death experiences and the woman on the rock. |
| core | 100 | Captain’s birth/age/identity, full timeline, departure/return, YR4/Moon, Earth’s fall, 2199/wormhole into 2026, crew and their losses. |

Only unmarked science defaults to public. Explicit captain-private/protect markers and private flags never become public; crew, captain timeline/identity and old-Earth story facts are core regardless of source. Default migration is monotonic toward privacy; only explicit --reclassify permits lowering an existing tier, and raised/lowered counts are reported. Other mixed records take the highest private tier present. Thresholds are speaker-to-listener like minus dislike, configurable per agent with `disclosure`. Mystery always has access. Direct captain DM locks/unlocks override friendship by listener and topic; groups require every listener to qualify or already know the fact. Public science is always shareable; listener-known facts use witnessed/source provenance, including exact evidence from the listener’s own store. Share one relevant log excerpt at a time. Stored knowledge is not shared knowledge until spoken to the listener. See `../DISCLOSURE_REPORT.md` for supported captain phrasings, the classification audit and the offline metadata-only migration command. No live migration is implied by this documentation.
