# The story. intro-1, intro-2, … open a new game ($currency, $wallet, $rent are available).
intro-1 = You fell asleep over a textbook. You wake on a bed that isn't yours, in a room you have never seen, and the noise from the street is nothing like home.
intro-2 = On the desk: someone's ID card, a newspaper, a note about money. The textbook is still in your hand. It isn't yours.
intro-3 = Voices pass under the window. You can't understand a word.

# After the last paper on the desk is read (the quiet page's desk).
desk-done = Someone is knocking.
# What each paper lets the player tell once it is read (the quiet page's desk): `paper-<id>-learned`.
paper-book-learned = Interesting… a book for learning English: Korean phrases, the English beside them. And a name inside the cover: 김민준.
# A line's own meaning, shown beside it once read (a phrasebook): `paper-<paper>-<line>`.
paper-book-title = English
paper-book-yes = yes
paper-book-no = no
paper-book-bye-stay = goodbye (I'm off)
paper-book-bye-go = goodbye (you go)
paper-idcard-learned = The same name as inside the book: 김민준, and in English letters, KIM MIN-JUN. Not yours.
paper-newspaper-learned = A newspaper from Seoul. The date on it: the year 2000.
paper-bill-learned = A note: 방세, 50,000 won. Someone owes it.

# Where and when, on the top bar.
setting-where = Seoul, 2000

place-room = The Room
# The room's name once the ID card on the desk has been read (the quiet page's desk).
place-room-known = Min-jun's Room
# place-<id>-desc: what the player sees on first standing there (the quiet page: before any scene there).
# place-<id>-go: the way there, worded from what the player has seen ("Go to <place>" without it).
place-room-desc = A narrow rented room: a mattress, a desk of heavy books, and bills nobody has opened.
place-room-go = Go back up to the room
place-street = The Alley
place-street-desc = A steep alley of little shops and hanging wires, and the old man on his bench.
place-street-go = Go outside
place-stall = Snack Stall
place-stall-desc = A tent over a steaming pan of something red, and a few plastic stools.
place-stall-go = Go down the alley to the stall
place-shop = Corner Shop
place-shop-desc = Shelves to the ceiling and a humming fridge.
place-shop-go = Go into the shop
place-campus = University Gate
place-campus-desc = Stone gate posts, a noticeboard thick with flyers, and students hurrying past with armfuls of books.
place-copyshop = Copy Shop
place-copyshop-desc = Two copiers roaring side by side, stacks of warm paper, and a man in a cardigan who never stops moving.

# npc-<id>-unmet: what the player calls someone until a conversation with them is done.
npc-landlady = The landlady
npc-oldman = Grandpa Park
npc-oldman-unmet = The old man
npc-jiwoo = Ji-woo
npc-jiwoo-unmet = The young woman
npc-clerk = The clerk
npc-labmate = Su-jin
npc-copyman = The copy-shop man
npc-creditor = A man in a suit

# Scene names for the menu; scene-<id>-start and scene-<id>-end are optional narration.
scene-room-wake = Answer the door
scene-room-wake-start = A knock. An old woman in slippers, glasses pushed up on her head, peers up at you.
scene-room-wake-end = She shuffles off downstairs. Her words go round and round in your head: 방세 내세요.

scene-street-again = Catch what he said
scene-street-again-start = Grandpa Park says something to you, too fast to catch.
scene-street-again-end = He laughs, and nods at the textbook in your hand.
scene-street-what = Show him your textbook
scene-street-what-start = Grandpa Park taps the book's cover.
scene-street-what-end = He folds his newspaper and nods across the alley at the shop.
scene-street-hungry = Find something to eat
scene-street-hungry-start = Your stomach growls. You haven't eaten since you woke up in Min-jun's room. Grandpa Park hears it and laughs.
scene-street-hungry-end = He points across the alley at the shop, then down it, at the food stall's steaming tent.

scene-shop-prices = Buy some bread
scene-shop-prices-start = A bell over the door. A young clerk looks up from a comic book. Bread and milk sit by the till.
scene-shop-prices-end = He took your five-thousand-won note and dropped one note back in your palm. He's already reading again.
scene-street-numbers = Show Grandpa Park your change
scene-street-numbers-start = Grandpa Park saw your shopping through the shop window. He holds out his hand for your change.
scene-street-numbers-end = He holds up your one note, then three fingers, and glares across the alley at the shop.
scene-shop-count = Ask for the rest of your change
scene-shop-count-start = The same clerk, the same comic. You hold up the one note he gave you.
scene-shop-count-end = He doesn't look up again as you leave. Down the alley, steam rises from a tent, and the air smells of something spicy.
scene-shop-buy = Buy something to eat
scene-shop-buy-start = The clerk waves you in without looking up.
scene-shop-buy-end = He bags it without looking up.

scene-stall-intro = Sit down at the stall
scene-stall-intro-start = A young woman in an apron runs the stall alone. Three customers on plastic stools are all calling to her at once.
scene-stall-intro-end = Ji-woo waves your money away, nods at the customers still waiting, and hands you an apron.
scene-stall-shift = Work a shift
scene-stall-shift-start = Customers call their orders over the hiss of the pan.
scene-stall-shift-end = The last customer leaves. Ji-woo counts out your pay from a tin.
scene-stall-family = Take a break with Ji-woo
scene-stall-family-start = Between customers, Ji-woo takes a photo out of her apron pocket.
scene-stall-family-end = She puts the photo away and doesn't take it out again. The face in it looked familiar.

scene-room-rent = The landlady is back
scene-room-rent-start = The landlady is back, as she said she would be, with a ledger.
scene-room-rent-end = The landlady writes 50,000 on a slip of paper and tapes it to your door.

scene-room-letter = Take the letter
scene-room-letter-start = The landlady is at the door again, an envelope held out between two fingers.
scene-room-letter-end = The envelope has a university crest on it, and Min-jun's name. Inside: a single typed page you can't read yet.
scene-campus-labmate = Talk to the student at the gate
scene-campus-labmate-start = A young woman with a stack of folders is watching the gate. She looks twice at you, then walks over.
scene-campus-labmate-end = Su-jin goes back through the gate without looking round.
scene-room-creditor = Answer the knock
scene-room-creditor-start = Three hard knocks. A man in a suit fills the doorway, looking past you into the room.
scene-room-creditor-end = He writes something in a little notebook and goes down the stairs slowly, as if he has all the time in the world.
scene-copy-intro = Look in at the copy shop
scene-copy-intro-start = The man at the copiers is buried in orders. He waves you in over the noise.
scene-copy-intro-end = He hands you a stack of paper still warm from the machine. You start tomorrow.
scene-copy-shift = Work at the copy shop
scene-copy-shift-start = Students come in with books, letters and photos: copy what they ask for, as many as they ask.
scene-copy-shift-end = The copiers go quiet. The copy-shop man counts out your pay.

# What a reply does (action-<name>), and on a mix-up what was asked (asked-<name>).
# Concept values arrive as learner names: $item = "gimbap", $count = "three".
action-fetch = You bring { $item }.
asked-fetch = Ji-woo wanted { $item }.
action-serve = You set down { $count } { $item }.
asked-serve = Ji-woo wanted { $count } { $item }.
action-buy = You buy the { $item }.
asked-buy = The clerk asked about { $item }.

# Conversations: what was asked, shown after a wrong reply. These are shared by every scene that
# uses the action, so they say "they" unless only one person ever uses it.
asked-call = The landlady called for Min-jun.
asked-friend = { $npc } asked if you're Min-jun's friend.
asked-missing = The landlady asked where Min-jun is.
asked-who = { $npc } asked who you are.
asked-rent = The landlady wanted the rent.
asked-mistaken = The landlady took you for Min-jun.
asked-name = The landlady didn't catch your name.
asked-bye = { $npc } said goodbye.
asked-hello = { $npc } said hello.
asked-park = Grandpa Park told you his name.
asked-ask = Grandpa Park asked your name.
asked-sit = Grandpa Park offered you a seat.
asked-understand = Grandpa Park asked if you know Korean.
asked-where = Grandpa Park asked where you're going.
asked-book = Grandpa Park asked what you're holding.
asked-good = Grandpa Park said "good".
asked-newspaper = Grandpa Park told you what he's holding.
asked-that = Grandpa Park told you what that is, over there.
asked-hungry = { $npc } asked if you're hungry.
asked-food = Grandpa Park asked if you have any bread.
asked-money = Grandpa Park asked if you have money.
asked-shop = Grandpa Park told you there's bread at the shop.
asked-stall = Grandpa Park pointed out the shop and the snack stall.
asked-go = Grandpa Park sent you on your way.
asked-welcome = { $npc } welcomed you in.
asked-bread = The clerk said there's bread.
asked-milk = The clerk said there's milk too.
asked-total = The clerk put the bread and milk on the counter.
asked-price = The clerk told you the prices.
asked-again = The clerk said the prices again, louder.
asked-slowly = The clerk said the prices slowly.
asked-change = The clerk gave you your change.
asked-claim = The clerk asked what you want.
asked-refund = The clerk counted two notes into your hand.
asked-sorry = The clerk said sorry.
asked-cost = Grandpa Park asked what the bread and milk cost.
asked-note = Grandpa Park held up your change: one note.
asked-numbers = Grandpa Park asked you to count along.
asked-owed = Grandpa Park said: three thousand won.
asked-next = Grandpa Park wanted the next number: { $number }.
asked-count = The clerk counted out your change.
asked-dish = Ji-woo told you what's in the pan.
asked-fed = Ji-woo set a plate in front of you.
asked-jiwoo = Ji-woo told you her name and asked yours.
asked-eat = Ji-woo told you to eat.
asked-tasty = Ji-woo asked if it's good.
asked-gimbap = Ji-woo offered you gimbap.
asked-work = Ji-woo asked if you'll work with her.
asked-photo = Ji-woo showed you something.
asked-brother = Ji-woo told you about her brother.
asked-paid = The landlady asked if you've paid the rent.
asked-amount = The landlady told you the rent.
asked-week = The landlady told you how often it's due.
asked-march = The landlady told you how far Min-jun had paid.
asked-greet = A customer came in.
asked-thanks = The customer thanked you on the way out.
asked-chat = { $npc } said: "{ $topic }"
action-chat = You answered: "{ $topic }"
action-copy = You hand over { $count } copies of the { $item }.
asked-copy = The student wanted { $count } copies of the { $item }.
asked-look = { $npc } wanted you to look at something.
asked-whose = The landlady said whose letter it is.
asked-from = The landlady said where the letter came from.
asked-student = The landlady said Min-jun is a university student.
asked-uni = The landlady told you where the university is.
asked-sujin = Su-jin told you who she is.
asked-whereis = Su-jin asked where Min-jun is.
asked-since = Su-jin told you since when Min-jun hasn't come.
asked-took = Su-jin told you what Min-jun took.
asked-comeback = { $npc } asked you to come again.
asked-knock = The man asked if Min-jun is in.
asked-borrowed = The man said what Min-jun did.
asked-debt = The man said how much it is.
asked-when = The man asked when Min-jun is coming.
asked-nextweek = The man said when he'll be back.
asked-areyou = The copy-shop man asked if you're a student.
asked-copyshop = The copy-shop man told you what the shop is.
asked-job = The copy-shop man offered you work.
asked-copy-it = The copy-shop man asked you to copy something.
asked-sheets = The copy-shop man asked for two copies.

# Notebook topics: a word in one of these slot groups is filed under the topic, not the place.
notebook-topic-food = Food
notebook-topic-numbers_2_5 = Numbers
notebook-topic-counts = Numbers
notebook-topic-goods = Things
notebook-topic-papers = Things

# Min-jun opening (lab). Script: docs/superpowers/specs/2026-10-07-minjun-opening-script.md
npc-minjun = Min-jun
npc-minjun-unmet = A young man
scene-room-minjun = Keys in the door
scene-room-minjun-start = Keys in the door. A young man with a shopping bag stops dead in the doorway. He has the face from the ID.
scene-room-minjun-end = He grabs his keys, and the two of you head down the stairs.
scene-street-introductions = Meet Grandpa Park
scene-street-introductions-start = Min-jun walks you down to the old man on the bench.
scene-street-introductions-end = Min-jun checks his phone. "Class," he says in English, and points at you: "See you at home." Then he's gone up the alley. Grandpa Park pats the bench beside him: from now on, he's your teacher.

# Min-jun's English, said before his Korean line.
door-room-minjun-who-direction = He says something, sharp and quick. You don't understand a word of it. You point at yourself.
door-room-minjun-minjun-direction = "Min-jun," he says in English, tapping his chest.
door-room-minjun-english-direction = He sees his book in your hand. "My book," he says. In English! He speaks English.
door-room-minjun-why-direction = He waits for you to explain. The landlady's words are still going round in your head.
door-room-minjun-together-direction = He taps the book, then you. "You teach English," he says, in English. "I teach Korean."
door-room-minjun-leave-direction = "Grandpa Park," he says in English, pointing down at the street. "He helps."

asked-message = The landlady gave you a message for Min-jun.
asked-minjun = Min-jun told you his name.
asked-english = Min-jun asked if you know English.
asked-why = Min-jun asked what's going on.
asked-together = Min-jun offered you a deal.
asked-leave = Min-jun wants you to come with him.

# Each option's reaction, shown at once.
door-room-wake-call-reply-reaction = She pulls her glasses down and looks properly. Not him.
door-room-wake-call-silence-reaction = She pulls her glasses down, looks properly, and laughs at herself.
door-room-wake-message-reply-reaction = She nods, satisfied. You've promised something.
door-room-wake-message-alt1-reaction = She says it again, slower, and taps your chest. You're telling him whether you like it or not.
door-room-wake-message-silence-reaction = She says it once more, slowly. You catch yourself repeating it.
door-room-wake-bye-reply-reaction = She smiles at the right goodbye.
door-room-wake-bye-alt1-reaction = She laughs and goes anyway.
door-room-wake-bye-silence-reaction = She doesn't wait for an answer.
door-room-minjun-who-reply-reaction = He repeats your name, more confused than before.
door-room-minjun-who-alt1-reaction = He blinks. Whatever he asked, that wasn't the answer.
door-room-minjun-who-silence-reaction = He looks at you, at the open door, and back at you.
door-room-minjun-minjun-reply-reaction = He shakes your hand, still baffled.
door-room-minjun-minjun-alt1-reaction = He laughs. You've only just met.
door-room-minjun-minjun-silence-reaction = He points at himself again, "Min-jun", and waits.
door-room-minjun-english-reply-reaction = His face lights up: a real English speaker.
door-room-minjun-english-alt1-reaction = He taps the English in the margins and grins. You were reading it. You're English.
door-room-minjun-english-silence-reaction = He points at the book, then at your mouth: English? You nod.
door-room-minjun-why-reply-reaction = He bursts out laughing: you sound exactly like her, finger and all. Then it lands. "방세," he groans, and rubs his fingers together: money, for the room. "Rent." So that's what she said. Pay the rent!
door-room-minjun-why-alt1-reaction = He blinks. You're sending him out of his own room? He laughs.
door-room-minjun-why-silence-reaction = He spots the note on the desk and groans: 방세. Whatever she said, he knows what it was about.
door-room-minjun-together-reply-reaction = You shake on it.
door-room-minjun-together-alt1-reaction = "You need me," he says in English, and points at the note on the desk. He's right, and you both know it.
door-room-minjun-together-silence-reaction = He takes your hand and shakes it for you.
door-room-minjun-leave-reply-reaction = He grins and holds the door open for you.
door-room-minjun-leave-alt1-reaction = He pulls you up anyway. You're not staying in his room alone.
door-room-minjun-leave-silence-reaction = He takes that as a yes.
door-street-introductions-park-reply-reaction = He beams at hearing his name. Min-jun gives you a thumbs-up.
door-street-introductions-park-alt1-reaction = He nods and taps his chest: Park.
door-street-introductions-park-silence-reaction = Min-jun nudges you. Park laughs and taps his chest: Park.
door-street-introductions-friend-reply-reaction = Min-jun grins. "Friend," he says, in English.
door-street-introductions-friend-alt1-reaction = Min-jun clutches his heart. Park laughs at both of you.
door-street-introductions-friend-silence-reaction = Min-jun answers for you: "네!"
door-street-introductions-sit-reply-reaction = You sit.
door-street-introductions-sit-alt1-reaction = He shrugs. The seat stays free.
door-street-introductions-sit-silence-reaction = He pats the bench until you sit.
door-street-introductions-understand-reply-reaction = He nods. An honest answer.
door-street-introductions-understand-alt1-reaction = He tries a fast sentence. You catch none of it. Min-jun snorts.
door-street-introductions-understand-silence-reaction = He points at the book in your hand and nods.

# Clues and memories: what floats up when you try to work out a line.
card-id = The ID card: 김민준
card-bill = The note on the desk: 방세 50,000원
card-book = The book's cover: 영어
card-glasses = Her glasses, pushed up on her head
card-phrase-bye = The book's page: 안녕히 계세요, goodbye (I'm off)
card-message = Her words: 방세 내세요
card-message-learned = Her words: 방세 내세요. Pay the rent!

# What you work out when the right one fits.
thought-room-wake-call = 민준… 김민준, the name on the ID. She's asking if I'm him.
thought-room-wake-message = 방세: the word on the note. Something about the note, for Min-jun.
thought-room-wake-bye = 안녕히 계세요: it's on the book's page. Goodbye. She's the one leaving.

# What room-rent remembers of Min-jun's first question: how the landlady has your name.
door-room-minjun-who-named-later = Your name is in her ledger now. Min-jun must have told her.
door-room-minjun-who-unnamed-later = Your name is in her ledger now. You never told Min-jun. Ji-woo must have.
