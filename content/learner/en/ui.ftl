# Text-game UI. Every id here is required by packages/tui (UI_KEYS).

# The top border (right) and the HUD row under it.
hud-top = Day { $day }
day-part-morning = morning
day-part-midday = midday
day-part-afternoon = afternoon
day-part-evening = evening
day-part-night = night
hud-goal = Next: { $goal }
hud-goal-sleep = Next: find your bed
hud-rent = { $days ->
    [0] rent due tonight
    [one] rent due tomorrow
   *[other] rent in { $days } days
}
hud-rent-late = rent late
hud-parcel = parcel
credit = by Bannerless Studio

rank-0 = Pidgin
rank-1 = Getting By
rank-2 = Conversational
rank-3 = Fluent
rank-4 = Silver Tongue

menu-title = What now?
menu-talk = { $scene } · { $npc }
menu-go = Go to { $place }
menu-needs-money = { $npc }: { $scene } · needs { $currency }{ $cost }
menu-mentor = Ask { $npc } about the language
menu-no-time = no time left
menu-cost-money = { " · " }{ $currency }{ $cost }
menu-review = Quick review · { $count ->
    [one] one fading word
   *[other] { $count } fading words
}
menu-sleep = Sleep (end the day)
sleep-go = Go to { $place } to sleep.
person-at = where: { $place }
person-at-via = where: { $place }, off { $via }
person-after = after { $scene }
person-after-with = after { $scene } with { $npc }
person-trust = trust { $trust }
person-trust-with = trust { $trust } with { $npc }
person-costs = costs { $currency }{ $cost }
person-bring-parcel = a parcel for them
person-parcel-first = deliver the parcel you're carrying first
person-gains-trust = +{ $trust } trust
sleep-go-via = Go to { $place }, off { $via }, to sleep.
menu-quit = Save and quit

keys-explore = [{ $keys }] choose · [n] notebook · [q] quit
keys-pick = [{ $keys }] reply · [w] help · [r] again · [n] notebook
keys-tiles = [{ $keys }] add · [⌫] undo · [enter] say · [w] help · [r] again · [n] notebook
keys-explore-book = [{ $keys }] choose · [b] book · [q] quit
keys-pick-book = [{ $keys }] reply · [w] help · [r] again · [b] book
keys-tiles-book = [{ $keys }] add · [⌫] undo · [enter] say · [w] help · [r] again · [b] book
keys-type = [enter] say · [tab] hint · [esc] look up a word
keys-review = [{ $keys }] choose · [esc] stop
keys-review-next = [enter] next · [p] play · [esc] stop
keys-help = [{ $keys }] look up · [p] play · [esc] back
keys-help-sentence = [{ $keys }] look up · [s] whole sentence · [p] play · [esc] back

help-title = Which word?
help-sentence = The whole sentence
help-example = e.g.
help-play = [p] ♪
help-in-replies = In the replies:
reply-title = Your reply
reply-confused = Look confused
tiles-answer = You say:
type-prompt = Type your reply:
type-send = (... to look confused)
hint-title = Hint { $level }/3
hint-level-1 = (subtle)
hint-level-2 = (stronger)
hint-level-3 = (the reply)
hint-question = a question
hint-statement = not a question
hint-words = { $count ->
    [one] one word
   *[other] { $count } words
}
hint-use = Use:
hint-more = [tab] another hint
hint-last = (no more hints)
review-title = Quick review
review-fill = Fill in the blank:
review-right = Correct!
review-wrong = Not quite: it's { $word }.
review-memory = Memory:
review-done = Review done: { $right } of { $of } right.
review-due = Some words are fading from memory: there's a quick review on the menu.
job-delivery = Delivery
job-step-pickup = Get the parcel
job-step-walk = Take it where she said
job-step-handover = Hand it over
job-time-left = { $time } left today
job-words = Useful words:
you = You

mismatch = That's not what was asked.
rephrased = (slower)
# Bottom border, right: sound playing, turned off with m, or no way to play it here.
sound-on = ♪ [m]
sound-off = ♪ off [m]
sound-none = no audio
wallet-change = { $sign }{ $currency }{ $amount } ({ $reason })
reason-wages = wages
reason-mixup = mix-up
reason-food = food
reason-rent = rent
reason-shopping = shopping
trust-up = { $npc } trusts you a little more.
scene-done = { $earned ->
    [0] Done.
   *[other] Done. You earned { $currency }{ $earned }.
}
scene-done-short = Done.
unlocked = New: { $scene }
unlocked-many = New: { $scenes }
place-revealed = { $count ->
    [one] New place: { $places }
   *[other] New places: { $places }
}
errand-started = You're carrying a parcel.
errand-ended = You hand over the parcel.
rank-up = You're now: { $rank }
day-ended = Day { $day } is over. You sleep.
day-ended-rough = Day { $day } is over. You sleep rough by the road.
reject-unknown-scene = There's nobody here for that.
reject-in-scene = Finish the conversation first.
reject-wrong-place = They're not here.
reject-locked = They're not ready to talk about that yet.
reject-no-slots = You're out of time today. Go and find your bed.
reject-stale-run = That conversation can't continue. Start it again.
reject-no-pick = Choose a reply with the number keys.
reject-bad-choice = There's no reply with that number.
reject-no-tiles = Build your reply from the tiles.
reject-bad-tile = There's no tile with that number.
reject-not-linked = You can't get there from here.
reject-not-home = You want your own bed. Head home first.
reject-unknown-word = That word isn't in the dictionary.
reject-no-type = Choose your reply instead of typing it.
reject-empty-reply = Type something to say first.
reject-no-hints = No more hints for this one.
reject-no-review = There's nothing to review right now.
reject-in-review = Finish the review first.
notice-read-only = Your progress can't be saved on this computer, so this session won't be kept.
notice-bad-save = Your save couldn't be read. It was kept as a backup and a new game started.

resume-title = Your games:
resume-item = { $name }Day { $day } · { $place } · { $currency }{ $wallet } · { $done ->
    [one] 1 scene done
   *[other] { $done } scenes done
} · last played { $date }
resume-ask = Which one? (number, or enter to cancel)
resume-none = No saved games yet, so here's a new one.
reject-no-mentor = There's nobody here to explain things.
note-hint = { $npc } seems to have something to tell you.
mentor-nothing = { $npc } has nothing new to explain today.

keys-notebook = [esc] back · [1-5] tab · [↑↓←→] move · [enter] more · [p] play
keys-notebook-scroll = [esc] back · [1-5] tab · [↑↓] scroll
notebook-title = Notebook
keys-book = [esc] back · [1-{ $tabs }] tab · [↑↓←→] move · [enter] more · [p] play
keys-book-scroll = [esc] back · [1-{ $tabs }] tab · [↑↓] scroll
book-title = Book
notebook-words = Words
notebook-recent = ★ Recent
notebook-notes-empty = No notes yet. Ask around; someone will explain things.
notebook-label-new = new
notebook-label-met = familiar
notebook-label-shaky = fading
notebook-label-known = safe
notebook-rank = Speaks: { $rank }
notebook-progress = Stage { $stage }: { $known } of { $total } words known
notebook-empty = Nothing yet. Words you hear are written down here.
notebook-elsewhere = Heard elsewhere
notebook-notes = Notes
notebook-phrases = Phrases
notebook-people = People
notebook-places = Places
notebook-phrases-empty = Nothing yet. What people say to you again and again is kept here.
notebook-people-empty = Nobody yet. The people you talk to are kept here.
notebook-trust = trust
notebook-talked = Talked about: { $scenes }
notebook-here = you are here
notebook-letters = Letters
notebook-papers = Papers
notebook-papers-empty = Nothing yet. Notices and papers you are handed are kept here.
notebook-paper-progress = { $known } of { $total } words known
notebook-paper-from = { $npc } · { $place }
letters-group-consonants = Consonants
letters-group-vowels = Vowels
letters-group-finals = Final consonants
export-none = There's no saved game to export yet.
import-bad = That line isn't a saved game for this course ({ $reason }).
import-done = Added: { $game }. Run the game to continue it.

# Browser page controls (packages/tui-web).
web-new = New game
web-games = Games
web-games-none = No saved games yet.
web-export = Export
web-export-hint = This line is your whole game. Paste it into Import on another device, or into the terminal game with: npx silver-tongue --import -
web-copy = Copy
web-copied = Copied
web-import = Import
web-import-hint = Paste a line from Export, here or from the terminal game. It is added as a new game; nothing is overwritten.
web-import-go = Add game
web-close = Close
web-tap-to-type = Tap the game to type your name.
web-saved = Your game is saved. You can close this tab, or keep playing.
web-load-failed = That course did not load. Check your connection and try again.
reject-bad-name = That name won't work. Use 1 to 20 letters.
reject-no-name = Tell us your name first.
name-prompt = Before anything else: what's your name?
keys-name = type your name · [enter] done · [⌫] delete

## Languages, by code, for the settings screen and the start list
learner-name = English
language-zh = Chinese
language-ja = Japanese
language-ko = Korean

## Settings ([o])
settings-title = Settings
settings-learning = Learning: { $language }
settings-reading = Reading: { $learner }
settings-sound = Sound: { $sound }
settings-sound-on = on
settings-sound-off = off
settings-sound-none = no audio
settings-sound-hint = (or [m])
settings-speed = Speed: { $speed }
settings-speed-slow = slow
settings-speed-normal = normal
settings-speed-fast = fast
settings-ruby = Readings under words: { $ruby }
settings-ruby-auto = new words only
settings-ruby-on = always
settings-ruby-off = never
settings-pick-course = Learn:
settings-pick-reading = Read the game in:
settings-current = (now)
keys-settings = [{ $keys }] change · [esc] back
keys-settings-pick = [{ $keys }] choose · [esc] back
keys-o = [o] settings

## Choosing a course before the game starts
start-title = What do you want to learn?
start-ask = Number (enter to quit):

# Visual novel
vn-tagline = You arrive speaking pidgin; you leave with a silver tongue.
vn-continue = Continue
vn-new-game = New game
vn-tap = Tap to continue
vn-notebook = Notebook
vn-book = Book
vn-backlog = What was said
vn-settings = Settings
vn-games = Games
vn-menu = Menu
vn-play-text = Play as text
vn-play-visual = Visual novel
vn-play-quiet = Play in the quiet terminal
vn-replay = Say it again
vn-slow = Say it slowly
vn-meaning = What does it mean?
vn-undo = Take back a tile
vn-send = Say it
vn-hint = Hint
vn-name-go = That's me
vn-sound = Sound
vn-speed = Speed: { $speed }
vn-speed-slow = slow
vn-speed-normal = normal
vn-speed-fast = fast
vn-advance = Advance: { $mode }
vn-advance-auto = by itself
vn-advance-tap = one press at a time
vn-day = Day { $day }
vn-parcel = Carrying a parcel
vn-rent-late = Rent is late
vn-turn-phone = Turn your phone sideways for a bigger view.
vn-dismiss = Got it
vn-play-word = Hear it

# NPC gesturing after two wrong replies, alongside the slow repeat.
gesture-narration = { $npc } mimes it:

# The quiet terminal page (packages/quiet-web).
quiet-anchor = { $place } · Day { $day }, { $part }
# The same before the day's number has a use (a course with the Book, until rent shows).
quiet-anchor-time = { $place } · { $part }
quiet-rent = rent { $currency }{ $rent } due { $days ->
    [0] tonight
    [1] tomorrow
   *[other] in { $days } days
} · you have { $currency }{ $wallet }
quiet-rent-late = rent late
quiet-scene-with = { $scene } · { $npc }
quiet-scene-done = ✓ { $scene }{ $earned ->
    [0] {""}
   *[other] {" · "}+{ $currency }{ $earned }
}
quiet-no-audio = 🔇 no audio
quiet-repeat = repeat shift
quiet-repeat-pays = repeat shift · pays { $currency }{ $pays }
quiet-resume = { $place }.
# The opening of a book course: the story's crawl, then the name screen.
quiet-press-enter = Press Enter
quiet-enter = Enter
quiet-name-title = What should they call you?
# The desk after the name screen (book courses with papers): read each paper out by typing it in Latin letters.
quiet-desk-why = The papers on the desk might tell you where you are.
quiet-desk-read = read
quiet-desk-done = ✓ already read
quiet-open-door = open the door
quiet-lookup-tap = Tap a word to look it up.
quiet-lookup-click = Click a word to look it up.
# The first time a reply is built from pieces (a course with the Book); gone once one is sent.
quiet-tiles-tap = Tap the pieces in order, then ✓.
quiet-tiles-click = Click the pieces in order, then ✓.
# The conversation stage (a course with the Book): the tag on a request said again after a miss
# (the same words slower, or other words), and the quiet reply that says nothing.
quiet-again-slower = again, slower
quiet-again = again, other words
quiet-say-nothing = say nothing
day-ended-food = Day { $day } is over. Food: { $currency }{ $amount }. You sleep.
day-ended-rough-food = Day { $day } is over. Food: { $currency }{ $amount }. You sleep rough by the road.
# The way to bed once the day is over (a course with the Book): $place is where the bed is.
menu-go-sleep = Go back to { $place } to sleep
quiet-read-intro = Sound it out, one block at a time.
quiet-read-example = { $parts } makes { $reading }. Type it.
quiet-read-placeholder = type the sound
quiet-read-help = help
quiet-read-tab-book = [tab] book
quiet-read-help-full = It reads: { $reading }
quiet-letter-end = end
quiet-letters-count = { $n } of { $total } letters
quiet-letters-none = Letters appear here as you meet them.
quiet-letters-guide = How to read
quiet-new = (new)
quiet-rephrase = rephrase
quiet-reveal = Show this line
quiet-notebook = Notebook
quiet-book = Book
quiet-status = Status
quiet-why-missed = { $count ->
    [1] missed
   *[other] missed ×{ $count }
}
quiet-why-helped = helped
quiet-why-decayed = decayed
quiet-tab-shaky = shaky { $count }
quiet-tab-met = met { $count }
quiet-tab-known = known { $count }
quiet-tab-all = all { $count }
quiet-nb-none = Nothing shaky. Every word you've heard is holding.
quiet-esc = esc close
quiet-st-wallet = Wallet: { $currency }{ $wallet }
quiet-st-rent = Rent: { $currency }{ $rent }, due { $days ->
    [0] tonight
    [1] tomorrow
   *[other] in { $days } days
}
quiet-st-day = Day { $day }, { $part }
quiet-people = people
quiet-unmet = { $count ->
    [one] One person you haven't met yet.
   *[other] { $count } people you haven't met yet.
}
quiet-you = You
quiet-p-back = ‹ status
quiet-p-tab-tips = tips
quiet-p-tab-history = history { $count }
quiet-p-tab-words = words { $heard }/{ $total }
quiet-p-trust = trust { $trust } of 5
quiet-p-not-met = not met yet
quiet-p-no-tips = Nothing more to do with them for now.
quiet-p-no-talks = Conversations from now on are kept here.
quiet-p-when = Day { $day } · { $part }
quiet-p-heard = heard · { $count }
quiet-p-not-yet = not yet · { $count }
quiet-st-parcel = Carrying a parcel
quiet-st-no-parcel = No parcel
quiet-no-save = no save found
# Scribe mode (lab): the first conversations, read in Latin letters and answered by typing meanings.
quiet-scribe-hear = What did they say?
quiet-scribe-hear-door = What does she mean?
quiet-scribe-say = Say it: type the meaning of the reply you want
quiet-scribe-example = “{ $line }” means “{ $meaning }”. Type what they said.
quiet-scribe-full = It means: { $meaning }

quiet-scribe-choose = Which reply do you mean? Choose one.
# Working a line out from clues and memories (lab opening).
quiet-deduce-prompt = What could it mean? Something comes back to you…
quiet-deduce-miss = Hmm… no. That doesn't sound right.
quiet-deduce-again = Think again
quiet-deduce-conclude = That's it
quiet-hint-meaning = Meaning: { $meaning }
