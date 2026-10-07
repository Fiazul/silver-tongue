cost = Bread, milk: how much?
cost-reply = A thousand won, a thousand won.
cost-reply-intent = Tell him the prices
cost-alt1 = I don't know.
cost-alt1-intent = Say you don't know

note = This is a thousand won. One.
note-reply = One?
note-reply-intent = Repeat the number

count = One, two, three.
count-reply = One, two, three.
count-reply-intent = Count along
count-alt1 = Three, two, one.
count-alt1-intent = Count along

owed = Three! Three thousand won.
owed-reply = Three thousand won?
owed-reply-intent = Check the amount
owed-alt1 = It's a thousand won.
owed-alt1-intent = Give an amount
owed-alt2 = One, two.
owed-alt2-intent = Count

five = One, two, three, four, five!
five-reply = One, two, three, four, five!
five-reply-intent = Count to five
five-alt1 = One, two, three, four.
five-alt1-intent = Count to five

next-a = { $number ->
    [2] One…
    [3] One, two…
    [4] One, two, three…
   *[5] One, two, three, four…
}
next-a-reply = { -number(form: "cap") }!
next-a-reply-intent = Say the next number

next-b = { $number ->
    [2] One…
    [3] One, two…
    [4] One, two, three…
   *[5] One, two, three, four…
}
next-b-reply = { -number(form: "cap") }!
next-b-reply-intent = Say the next number
