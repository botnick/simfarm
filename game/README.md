# SIM FARM

A playable web remake of the Flash farming game *SIM FARM* (by w_w, DailyFreeGames.com),
rebuilt on **Phaser 4** from rules recovered out of the original `.swf`.

The artwork, the isometric fields, the tool bar and the HUD panels are the original's own,
lifted from the SWF as SVG. The rules were read back out of its ActionScript 2 bytecode
rather than guessed at.

```bash
npm install
npm run dev       # play at http://localhost:5180
npm run server    # the authoritative game server (see below)
npm test          # 433 rule tests (pure logic, no browser)
npm run e2e       # 247 end-to-end assertions in a real browser, played offline
npm run online    # 76 assertions against the real server, where the two can disagree
npm run layout    # every screen, both languages: is anything off the board?
npm run mobile    # phone/tablet, both orientations, taps really land
npm run sim       # balance report: profit per plot per day, per crop
npm run build     # production build into dist/
npm run fonts     # re-fetch and self-host the UI typefaces
npm run gen-prep  # cut out generated product art and size it for the game
npm run regions   # check every screen has the click regions it needs
npm run test:server  # 217 adversarial tests against the game server
```

## The server decides, the browser draws

`server/` holds the authoritative game. `src/core/rules.js` is pure and takes its
randomness as an argument, so the server runs the same rules the browser does — no second
implementation to drift. A client sends *intents* ("plant turnip in field 2") and never a
number; the server checks each one against its own copy of the farm and returns the result.

`npm run test:server` is written from the attacker's side. It posts itself money, buys
crops above its level, sells stock it does not have, plants in field 99, edits a save,
replays an old one, retries a sale, and tries to spin the calendar looking for a market
board it likes. Every one is refused.

Two things worth knowing:

- **The random source is a keyed hash, not a stored seed.** A save carries only a counter,
  so nobody can read a save and work out when it will rain.
- **A day may only end if it would change something** — a watered crop, a fed animal, a
  curing recipe. A timer was tried first and is not a rule: waiting is free, so an
  abandoned farm could have spun the calendar until a market board it liked came round.

The browser build still runs the rules locally; wiring it to the server is the next step.

## Everything lives in `public/data/game.json`

There is no game content in the code. Crops, prices, growth times, harvest counts,
pest behaviour, supplies, animals, recipes, goods and both languages all come from
that one file. Add a crop and it appears in the shop, the field and the seed picker;
add a recipe and the workshop lists it. `public/data/strings.json` holds the UI text
in English and Thai — a third language is another key in that file.

```jsonc
{ "id": "chili", "name": { "en": "Chili", "th": "พริก" }, "art": "tomato", "tint": "#ff3b1f",
  "seedPrice": 700, "sellPrice": 77, "daysPerStage": 2, "harvests": 5,
  "pest": { "spawnChance": 0.2 } }        // per-crop overrides fall back to rules.pest
```

## How the farm works

One seed sows a whole twelve-tile field. Each tile tracks a growth stage, days at that
stage, whether it was watered, how much fertiliser it took, and whether a bug found it.
Ending the day grows everything that was watered, lets fertiliser buy a second growth
tick, kills anything fertilised more than twice, rolls for bugs, settles the animals,
finishes curing recipes, then decides tomorrow's weather. Rain waters the whole farm
for free. The year runs 365 days.

Harvested crops go to the barn, where they can be sold raw or taken to the workshop and
turned into something worth more — compost, feed, spray, oil, sauce, jam, pie, juice.

## Testing

Two layers, and they check different things.

`npm test` exercises `src/core/rules.js` directly — growth timing, the fertiliser
overdose, pest rolls, harvest counts, rain, animals, crafting, selling, the end of the
year. Fast, and it pins the behaviour recovered from the SWF.

`npm run e2e` drives a real browser and asserts that **clicking actually changes the
game**: buying a seed costs exactly its price, a seed you cannot afford is refused,
water-all spends one energy per tile, a watered crop is one stage further the next
morning, selling pays the listed price per unit, a recipe consumes its ingredients and
delivers after curing, feeding empties the sack, saving and reloading keeps your money,
and switching language changes what is on screen. It fails on any console error too.
Point it at another origin with `URL=https://… npm run e2e`.

## Balance

The original's balance was broken: profit per plot-day ran from 66 (Potato) to 434
(Grape), a 6.6x spread, with Potato and Watermelon strictly worse than cheaper crops.
`npm run sim` plays every crop for 3,650 days across five seeds and reports the real
numbers.

A game that never ends needs more than tidy prices, or the best crop is simply the best
crop forever. So the market saturates — selling the same crop over and over in one week
drops its price in tiers — and each week asks for three specific crops at a premium.
Processed goods are exempt, which is what makes the workshop the way out of a glut.
`npm run sim` measures the result: a mixed farm earns **+9%** over the best monoculture,
which is the point.

Animals are a side income, not a shortcut: a full herd of seventeen returns about 62% of
what four well-run fields do, costs 17 of the day's 100 energy to feed, and its produce is
the one thing the market never saturates — which is why the prices are set where they are.

## Phones, and which way up

The board is one painted landscape scene and cannot reflow into a tall column, so on an
upright phone `src/core/viewport.js` turns it a quarter turn and gives it the whole
display — 66% of a phone screen and 99% of a tablet's, against 32% and 49% letterboxed.

Phaser cannot do this alone. It measures the parent element, which a CSS rotation reports
back swapped, and it maps pointers assuming the canvas is square to the page. So the scale
mode is `NONE`, the canvas is sized and placed by that module, and `game.input.transformPointer`
is replaced with one that knows about the turn. `npm run mobile` taps a real button through
the rotation and asserts the scene changed, because a rotation that looks right and eats
every tap is worse than none.

The turn is clockwise (`rotate(90deg)` plus the matching branch in `transformPointer`);
flipping both to `-90deg` reverses which way the player tilts the phone. None of this
applies when auto-rotate is on — the browser simply reports landscape and nothing rotates.

Turning it is not forced. A `↻` button next to fullscreen switches between the turned view
(bigger) and holding the phone upright (smaller, but the right way up), and the choice is
remembered. Both paths have their own pointer mapping, so `npm run mobile` tests both.

Touch is treated as its own input, not a mouse without hover. Anything the desktop reveals
on pointer-over — the field status plaques — is simply left visible on a touch screen,
because otherwise a phone player would never see it. Tap targets get extra padding.
`npm run mobile` checks all of this by tapping for real and asserting the scene changed.

## Fonts

The UI is set in **Mitr**, which draws Latin, digits and Thai in one design, so switching
language does not change the game's voice. Noto Sans Thai backs it up. Both are
self-hosted — `npm run fonts` re-downloads the per-script `woff2` subsets and regenerates
`public/assets/fonts/fonts.css` with the matching `unicode-range` rules, so the game
fetches nothing at runtime and looks the same on every machine.

The SWF's own display face (`Fat`) is still in `extracted/fonts/` but is not shipped: it
has no Thai glyphs, and no space glyph either.

Thai needs one more thing: Phaser sizes a text texture to the font's line box and clips
whatever falls outside, which silently slices the tone marks off — `น้ำ` renders as `นำ`.
`label()` in `src/ui/kit.js` adds vertical padding to prevent that. The same padding is
what makes button captions sit centred, since a Thai-capable font reserves room above and
below the Latin letters.

## Where the art came from

`tools/prep-assets.mjs` is the whole pipeline: it reads `tools/art-map.json`, pulls the
scene plates and sprites out of `../extracted/`, strips the caterpillar out of the
growing-stage frame so the game can draw pests itself, drops the original game's logo,
re-encodes the 11 kHz audio into something browsers will decode, and copies the
placement maps the game reads at runtime. Re-run it with `npm run assets`; nothing under
`public/assets` is hand-edited.

Coordinates — the twelve isometric tiles, the tool-bar icons, the money and day panels,
the energy heart — are the original's, read out of the SWF's display lists.
