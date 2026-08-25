# SIM FARM

The Flash game *The Farmer* rebuilt for the web in Phaser 4 — not wrapped in an
emulator, but taken apart and reassembled: the rules recovered from the original
SWF, the art extracted from it, and the whole thing rewritten so a server owns
the farm and the browser only draws it.

It plays for ever. There is no last day.

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

    npm test             # the rules
    npm run e2e          # the game in a browser, offline
    npm run online       # the game in a browser, against a real server
    npm run play         # a real game, played for weeks, by clicking only
    npm run test:server  # the server refusing what it should
    npm run facade       # what the browser does with every answer a server can give
    npm run soak         # ninety days played through the server over HTTP
    npm run durable      # two processes over one ledger, across a restart
    npm run reach        # every crop, animal, recipe and reward is reachable
    npm run pace         # how many days before each thing becomes available
    npm run sim          # the crop balance table
    npm run mobile       # both orientations
    npm run regions      # every screen has the hotspots it needs

`play` is the one that would notice the game being no fun: it never touches the
farm's state, it just presses buttons for three weeks and asks whether the farm
grew. `pace` is the one to run after changing anything about levels — content
nobody can reach may as well not exist.

## Credit

After the Flash game by w_w. The rules were recovered from the original SWF,
which is kept in `original/` for reference. Sound effects are CC0; their
provenance is in `game/public/assets/sfx/AUDIO-SOURCES.md`.
