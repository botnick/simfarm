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

## Checking a change

    npm test             # 361  the rules
    npm run e2e          # 195  the game in a browser, offline
    npm run online       #  55  the game in a browser, against a real server
    npm run test:server  # 145  the server refusing what it should
    npm run facade       #  54  what the browser does with every answer a server can give
    npm run reach        #  21  every crop, animal, recipe and reward is reachable
    npm run play         #  16  a real game, played for weeks, by clicking only
    npm run soak         #  13  ninety days played through the server over HTTP
    npm run durable      #   9  two processes over one ledger, across a restart
    npm run pace         #   9  how long before each thing becomes available
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
- **`pace`** answers a question `reach` does not: not *can* this be reached, but
  how many days of playing until it is. It found six of sixteen things
  unreachable inside four months.
- **`test`** carries a differential contract between the day-end gate and the
  night: if the gate says nothing would change, running the night must change
  nothing. It found four rules that could never fire.

Run `pace` after touching `progression` or any `unlockLevel`. Content nobody can
reach may as well not exist, and a quadratic curve is very easy to write in a way
that quietly puts half the game behind a year of play.

## Credit

After the Flash game by w_w. The rules were recovered from the original SWF,
which is kept in `original/` for reference. Sound effects are CC0; their
provenance is in `game/public/assets/sfx/AUDIO-SOURCES.md`.
