# SIM FARM

The Flash game *The Farmer* rebuilt for the web in Phaser 4 — not wrapped in an
emulator, but taken apart and reassembled: the rules recovered from the original
SWF, the art extracted from it, and the whole thing rewritten so a server owns
the farm and the browser only draws it.

It plays for ever. There is no last day: crops and animals arrive between day 6
and day 61, and after that the farm itself keeps growing with the level.

    cd game
    npm install
    npm run dev          # plays offline, rules run in the browser

To play against a server, see `server/INTEGRATION.md`.

## What is in here

    game/src/core/rules.js    the game. Pure, no I/O, no clock, no randomness of
                              its own — the dice are passed in
    game/src/                 the browser, which owns no rules when online
    server/                   an HTTP shell around those rules
    game/public/data/         the content: crops, animals, recipes, market,
                              level curve, both languages, audio cues

`rules.js` is imported by both the browser and the server, so they cannot
disagree about what a crop costs or how a night works. A host that wants its own
transport can import it directly and leave `server/` alone.

Adding a crop, an animal, a recipe or a milestone is an edit to
`game/public/data/game.json`. Nothing in the code holds a list of them.

A farm saved before such an edit outlives it, so both halves of the game
reconcile a save against the rule book they are about to play it under. Anything
that no longer exists is dropped, and a field growing a crop that was removed is
emptied rather than lost. Adding is the commoner edit and was the worse bug: a
save written before a crop, animal or supply existed had no counter for it, so
buying one did `undefined + 1` and left NaN spreading through every total it was
part of — everything the rule book has now gets a counter, whether the save had
heard of it or not. Land already owned is never taken away. Without that the night looked the crop up to age it,
found nothing, and threw — so the day could never be ended again and the farm was
finished, offline and online alike. The offline game says so with a banner; the
server logs what it dropped.

## Checking a change

    npm test             # 412  the rules
    npm run e2e          # 233  the game in a browser, offline
    npm run online       #  70  the game in a browser, against a real server
    npm run test:server  # 189  the server refusing what it should
    npm run facade       #  63  what the browser does with every answer a server can give
    npm run reach        #  46  every crop, animal, recipe and reward is reachable,
                         #      and both languages say everything
    npm run play         #  16  a real game, played for weeks, by clicking only
    npm run soak         #  13  ninety days played through the server over HTTP
    npm run durable      #   9  two processes over one ledger, across a restart
    npm run pace         #   9  how long before each thing becomes available
    npm run fuzz         #   5  a farm played at random for years, still a farm
    npm run production   #  21  the built game, a strict server, across origins
    npm run fatal        #  17  what the game does when it breaks, and does not do
    npm run mobile       #   4  both orientations
    npm run regions      #      every screen has the hotspots it needs
    npm run sim          #      the crop balance table

Three of these exist because the others had blind spots, and each earned its
place by finding something:

- **`play`** would notice the game being no fun. It never touches the farm's
  state — it presses buttons for three weeks and asks whether the farm grew. It
  found that an online player who went broke was stranded for ever, because the
  rule that refuses an empty day and the rule that lends a bankrupt farm a seed
  contradicted each other exactly where the rescue was needed.
- **`play`** also prints where the farm stood each morning under `TRACE=1`, and
  that is how the worst bug in the game was found. A field cannot be sown while
  a single dead plant stands in it, and a crop that gives more than one picking
  leaves *every* tile dead once it is spent — so the ordinary end of a radish
  field was a quarter of the farm that would not sow, with nothing on screen
  saying why and no way back but twelve separate clicks. The trace showed
  fourteen tiles dying on day seven and still dead on day twenty-four. Forty
  days used to end at \$30; they now end several thousand ahead. The economy was
  never the problem — the game was eating its own farmland.
- **`facade`** holds the two halves of the online game to the same list of
  names. An intent the browser sends and the server has never heard of fails as
  a refusal nobody can explain: the button does nothing and nothing is logged.
- **`pace`** answers a question `reach` does not: not *can* this be reached, but
  how many days of playing until it is. It found six of sixteen things
  unreachable inside four months.
- **`test`** carries a differential contract between the day-end gate and the
  night: if the gate says nothing would change, running the night must change
  nothing. It found four rules that could never fire.
- **`reach`** also holds the string table to account: both languages must say
  everything the other says, every line the code asks for must exist, and every
  line that exists must be reachable. That last one found forty-two orphans —
  and three lines that were not orphans at all, but things the rules worked out
  every night and the farm screen never read, including crops rotting in an
  overfull barn.

- **`fuzz`** plays at random, far further in than a person would, and after
  every single call asks whether the farm is still something the game can
  describe: no NaN, nothing negative that counts things, energy inside the
  farm's own limit, no herd fed more than it has, and — the one that matters —
  that a cornered player always has something left to try. Eighty farms, twelve
  hundred days each. Every bug worth finding here so far has been one of those
  two shapes, found by hand, one at a time, by playing far enough in.

The rule book also has to hang together with itself. What an animal eats and
produces, what a recipe takes and makes, what a tool consumes, which seed the
rescue loan hands back — each is an id pointing at another id, and nothing checks
them while a farm is being played. `reach` checks them, and the server refuses to
start on a book that does not, because the alternative is a game that starts
perfectly well and breaks later, in somebody's night, with no way back.

Run `pace` after touching `progression` or any `unlockLevel`. Content nobody can
reach may as well not exist, and a quadratic curve is very easy to write in a way
that quietly puts half the game behind a year of play.

## Deploying

    npm run build                      # dist/, served from the root of a domain
    VITE_BASE=/simfarm/ npm run build  # or from a path under one

The address of the server is baked in from `VITE_SERVER_URL`, but the browser's
own `simfarm.server` slot is asked first — so a built game can be pointed
somewhere else, or at nothing, without building it again. That matters more than
it sounds: a tunnel gets a new address every time it restarts, and without it the
deployed game would simply stop working with no way to reach it. Setting the slot
to an empty string plays offline.

Served under a path, the address needs its trailing slash: everything the game
asks for at runtime — the rule book, the artwork, the sounds — is relative to the
page, so `/simfarm` without the slash looks for them one directory too high and
finds nothing. Redirect `/simfarm` to `/simfarm/`.

Run the suites against the built bundle, not only the source — and against a
build served under a path, if that is where it is going:

    npm run build && npx vite preview --port 4173
    URL=http://localhost:4173/ npm run e2e
    URL=http://localhost:4173/ npm run online
    URL=http://localhost:4173/ npm run mobile

The fonts are the part that only breaks under a path. `public/` is copied
verbatim, so a root-absolute `url()` inside `assets/fonts/fonts.css` would ask
for the files at the root of the domain wherever the game actually is — and the
only sign of it is that the display face quietly does not arrive.

## Before it goes anywhere

    npm run build && npm run production

That runs the built game against a server configured the way one is meant to be:
strict, with a real secret, a ledger on disk, one named origin and a host key. It
is the only suite that does — every other one runs the server the way a laptop
runs it, which is the opposite of all four. So the arrangement a player would
actually meet had never been started, let alone played.

Two things only exist there. Cross-origin is the shape of a real deployment — the
game is served from one place and the server lives in another, so every request
is a preflight away from working — and the origin is a rule with teeth: point it
at a different address and no farm opens at all. And a host key means the browser
is no longer allowed to settle its own rewards, which is a path nothing else
takes: the reward stays in the outbox, the browser is refused when it tries to
clear it, and only the key clears it.

## Credit

After the Flash game by w_w. The rules were recovered from the original SWF,
which is kept in `original/` for reference. Sound effects are CC0; their
provenance is in `game/public/assets/sfx/AUDIO-SOURCES.md`.
