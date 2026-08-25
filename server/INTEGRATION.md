# Plugging SIM FARM into another game

The farm is a self-contained mini-game with one rule: **the server decides
everything.** The browser sends intents and draws whatever comes back. It cannot
give itself money, skip a day, or invent a harvest, and the suites in this repo
exist to keep that true.

This document is what a host system has to know to embed it.

---

## The shape of it

    game/src/core/rules.js     the rules, pure, no I/O, no clock, no randomness
                               of its own — the RNG is passed in
    server/                    an HTTP shell around those rules, holding farms
                               in memory
    game/src/                  the browser, which owns no rules when online

The rules file is the whole game. The server and the browser both import it, so
they cannot drift: a change to how a crop grows changes both at once. A host that
wants its own transport can import `rules.js` directly and skip `server/`
entirely — that is the intended path for anything with real infrastructure.

---

## The protocol

Every route is POST unless noted, JSON in and out, session in `x-session`.

| Route      | What it is                                                     |
|------------|----------------------------------------------------------------|
| `GET /health` | The intents this build accepts and the save format it speaks |
| `/session` | Start a farm, or resume one from a signed save                 |
| `GET /state` | The farm as the server holds it                              |
| `/intent`  | Do one thing. `{ type, ...args, expectedRevision, requestId }`  |
| `/ack`     | Confirm milestone events have been dealt with                  |
| `/save`    | A signed envelope the client may keep                          |
| `/end`     | Finish the session and hand back a final envelope               |

A resumed save is reconciled against the rule book this server enforces before
a session is handed out. The signature proves the save was ours and the schema
version proves its shape; neither says anything about which crops exist, and a
farm growing one that has since been removed cannot be played at all. Set
`SIMFARM_DATA` to run a build against a different rule book.

An intent is applied to a copy of the farm and the copy is kept only if the
whole of it succeeded. A night does a great deal of work — every tile, every
animal, everything curing, the spoilage and the week — and a fault halfway
through would otherwise leave the farm half-advanced at the revision it started
on, so the client would retry from that revision and get half a second night on
top of half a first. The random source is counted rather than stored, so it is
rewound too: without that a retried night would draw different weather from the
same revision.

The server repeats back only the refusals it decided to make — `body too large`,
`bad json`, `too many sessions`. Anything else is a fault, answered with a
generic 500 and logged here rather than described to whoever asked.

Three things make `/intent` safe to retry and impossible to race:

- **`expectedRevision`** — every accepted change bumps a counter. A client that
  is behind is refused with `409` and told where the farm really is, along with
  the farm itself.
- **`requestId`** — a repeat of a request already handled returns exactly what
  it returned the first time. A dropped response cannot sell the same crop
  twice.
- **One live session per farm.** Resuming a save takes the farm over and the
  previous session stops working, including any request already in flight.

---

## Refusing to start on a configuration nobody chose

Every setting below has a default that is right on a laptop and wrong in front
of a player. Warnings do not fix that — a warning printed during a deploy is a
warning nobody reads — so set `SIMFARM_STRICT=1` and the server refuses to start
until each choice has actually been made.

| Variable | Without it |
|---|---|
| `SIMFARM_SECRET` | saves are signed with a key made at boot and stop verifying on restart. Under 32 bytes is refused outright: every save it signs is an offline guess at it |
| `SIMFARM_LEDGER_FILE` | replay protection lives in this process only, and a restart makes every save it ever issued spendable again |
| `SIMFARM_ORIGIN` | the API answers any origin. `*` is refused as the same thing said differently |
| `SIMFARM_HOST_KEY` | a browser may settle its own reward events |
| `SIMFARM_TEST_HOOKS` | (must be unset) `/test/grant` puts crops and debt into any farm on request |

Numeric settings all go through the same check, because `Number('lots')` is
`NaN` and `NaN` loses every comparison it is in — so a mistyped ceiling would
otherwise become no ceiling at all:

| Variable | Default | What a bad value would have meant |
|---|---|---|
| `SIMFARM_SAVE_TTL_MS` | 30 days | a save that never expires: a bearer credential with no end |
| `SIMFARM_ENDDAY_MS` | 1000 | no cooldown between days (0 is a real answer and allowed) |
| `SIMFARM_RATE_MAX` | 300 / 10s | no per-player pacing |
| `SIMFARM_EDGE_RATE_MAX` | 3000 / 10s | no bound on anonymous work |
| `SIMFARM_SESSION_RATE_MAX` | 120 / min | no bound on farms started from one address |
| `SIMFARM_MAX_SESSIONS` | 5000 | no ceiling on memory |
| `SIMFARM_SESSION_TTL_MS` | 6 hours | sessions that never expire |

---

## What a host MUST do

**1. Bind `farmId` to your own identity.** This is the important one.

A signed save is the credential here. Anyone holding a current one can resume
that farm — that is bearer-capability, not ownership, and it is all a game with
no login can offer. The `playerId` field on `/session` is a label the caller
chooses; it is neither signed nor checked and confers nothing.

If you have accounts, look up the farm for the authenticated user and refuse a
`farmId` that is not theirs, at `/session` in `server/index.mjs`. Everything else
is already keyed off `farmId` and will follow.

**2. Set `SIMFARM_SECRET`.** It signs every save. Left unset the server generates
one at boot and says so in the log — safe, but every save it ever issued stops
verifying when the process restarts.

**3. Set `SIMFARM_ORIGIN`** to the game's origin. Unset, the API answers any
origin, which is convenient in development and wrong anywhere else.

**4. Never set `SIMFARM_TEST_HOOKS=1`.** It opens `/test/grant`, which puts crops
and debt into any farm on request. It exists so the end-to-end suite can reach
states that would otherwise take a week of play. The server warns loudly when it
is on, and `server/test.mjs` asserts it is `404` when it is not.

**5. Give it a durable ledger.** `server/ledger.mjs` is an interface with two
implementations: `memoryLedger` (correct while the process lives, gone when it
stops) and `fileLedger` (a reference, single-machine, rewrites the whole file).
Neither is right for a real deployment. Implement `highWater`, `noteRevision`,
`isSettled`, `noteSettled` and `sweep` against your database and pass it to
`createStore`.

What it holds is the only thing standing between an old signed envelope and a
replay: the highest revision a farm has reached, and which reward events have
been settled. `npm run durable` runs two server processes over one ledger and
proves both survive a restart — and, deliberately, that they do not without one.

Three properties yours must have, because they are the whole point of it:

- **Errors propagate.** An unreadable ledger is not an empty one — treating it as
  empty throws away every replay it was refusing, silently, at the moment
  somebody most needs it. `fileLedger` distinguishes *not there yet* (a farm
  nobody has played; start empty) from *there and unreadable* (refuse to start).
- **Nothing unexpired is ever forgotten.** Size it for every farm whose save has
  not passed `SIMFARM_SAVE_TTL_MS`. Making room by dropping the oldest entry
  drops exactly the thing that refuses a replay, and an entry can be a minute old
  while the save it governs is good for another month. A full ledger refuses a
  new farm — a `503` — rather than quietly unprotecting an old one.
- **A write that returns has happened.** `fileLedger` writes beside, flushes the
  file and its directory, then renames; a database should be doing the equivalent
  inside a transaction.

**6. Handle rate limiting at your edge if you can see real client addresses.**
The budget here is per session, deliberately: counting by address collapses
behind a proxy, where every player arrives from the same one. Before a session
exists there is nothing else to key on, so `/session` keeps a loose per-address
budget you can size with `SIMFARM_SESSION_RATE_MAX`, and a much looser pre-auth
budget bounds the work an anonymous caller can cause.

---

## Rewards, and how not to pay them twice

The farm awards milestones — first harvest, first animal, and whatever else the
data file names. They are how a host gives a player something outside the farm.

Delivery is **at least once**, and the host must make it exactly once:

1. The farm awards a milestone. The server puts it in an outbox with its own
   `eventId`.
2. Every response carries the outbox until it is acknowledged. A response lost to
   a dropped connection therefore loses nothing.
3. The host does whatever the reward is, durably.
4. Only then does it `POST /ack { eventIds }`.

Acknowledging is permanent and belongs to the farm, not the session: a save taken
before an acknowledgement still carries the event, and resuming it will not offer
the event again. Acknowledging before the reward has actually been given would
lose it to a crash, so do not.

**Only the host may acknowledge.** Set `SIMFARM_HOST_KEY` and `/ack` requires it
in an `x-host-key` header; the browser is told at `/session` that acknowledging
is not its job and stops trying. This matters because a session is a player, and
a player saying "that reward was paid" is not the host saying it. Left unset, the
farm is a single-player game with nothing outside itself to give away and the
browser settling its own events costs nothing.

The same reasoning applies to the reward itself: **never grant host currency or
items in the browser.** The browser may show that a milestone happened. Awarding
it, deduplicating on `eventId`, and settling it belong in one transaction on your
side.

**Deduplicate on `eventId` anyway.** It is stable across retries and resumes, and
it is the only thing that makes a reward exactly-once end to end.

**The game shows them too.** A milestone raises a banner in the browser naming
what was achieved — that is presentation, and entirely separate from the host
paying anything for it. Milestones past the listed ones are generated by a rule
(`progression.milestoneEvery`), so their ids are `level-30`, `level-40` and so on
and a host does not need to be told about each one in advance.

**Saves expire.** Every envelope carries `issuedAt` and is refused after
`SIMFARM_SAVE_TTL_MS` (30 days by default). Without an expiry the ledger could
never forget anything, because a save from any year might arrive tomorrow; with
one, retention only has to outlast validity, and forgetting becomes safe rather
than a quiet hole.

---

## What the browser is allowed to be

Nothing. Online it is a mirror: it holds whatever the server last agreed to and
its own copy is replaced by the next answer. Editing it in a console changes what
is on screen until the next request and nothing else, which is what
`tools/online.mjs` asserts by doing exactly that.

Two consequences worth knowing:

- **Save online is the server's envelope**, not the browser's view of the farm. It
  is opaque and signed, and the browser keeps it up to date automatically because
  the server refuses an envelope older than the farm's newest revision.
- **Refusals are shown.** A rate limit, a lost connection, a farm taken over
  somewhere else — all of them reach the player as a message rather than a click
  that does nothing.

---

## When the game breaks

A scene whose `create()` throws is left half-built, and the game carries on
drawing whatever did get made. What the player sees is a screen that looks
entirely normal except that nothing on it works.

The game guards its own lifecycle and its own bootstrap — deliberately not
`window`, because a host's unrelated failure must never put a notice on screen
blaming the farm. Set this before the script loads to take it over:

    window.SIMFARM = {
      onFatal({ error, phase, reload }) {
        // phase is e.g. 'FarmScene.create' or 'loading the game'
        myTelemetry.report(error, phase)
        return true          // true or 'handled' suppresses the built-in notice
      },
      fatalUI: false,        // or just turn the notice off without replacing it
    }

Called once per session, whatever breaks and however often. The built-in notice
says something generic and localised and offers a reload; it never renders the
error's own text, which carries internal paths and helps nobody. A handler that
itself throws is ignored rather than being allowed to become the failure.

For real isolation from a host page, run the game in an iframe.

`npm run fatal` covers all of that.

## Content

`game/public/data/game.json` is the game. Crops, animals, feeds, recipes, tools,
milestones, market rules, level curve, audio cues — adding one is a JSON edit.
Nothing in the code holds a list of them, which is what `npm run e2e` checks when
it asserts every tool has a sound and every cue has a file.

`game/public/data/strings.json` holds both languages. A missing key falls back to
English and then to its own name, which is quiet — so `npm run reach` asserts
that both languages say everything the other says, that every line the code asks
for exists, and that every line that exists is reachable from the code.

---

## Checking a change did not break it

    cd game
    npm test             # 412  the rules
    npm run e2e          # 233  the game in a browser, offline
    npm run online       #  70  the game in a browser, against a real server
    npm run facade       #  63  what the browser does with every answer a server can give
    npm run test:server  # 189  the server refusing what it should
    npm run play         #  16  a real game, played for weeks, by clicking only
    npm run soak         #  13  ninety days played through the server over HTTP
    npm run reach        #  29  every crop, animal, recipe and reward is reachable
    npm run pace         #      how many days before each thing becomes available
    npm run durable      #   9  two processes over one ledger, across a restart
    npm run fatal        #  17  what the game does when it breaks, and does not do
    npm run mobile       #   4  both orientations
    npm run regions      #      every screen has the hotspots it needs
    npm run sim          #      the crop balance table

`pace` is not a pass/fail suite but the instrument behind the level curve. It
plays well for four months and reports the day each crop and animal first becomes
available. Run it after changing `progression` or any `unlockLevel`: reachable at
a high enough level is not the same as reachable, and a quadratic curve is very
easy to write in a way that quietly puts half the game behind a year of play.

`play` is the one that would notice the game being no fun: it is the only suite
that never touches the farm's state. It opens the page, presses NEW GAME, and
then plays by clicking — buying, sowing, watering, spraying, picking, feeding,
selling, crafting, ending the day — and asks at the end whether a farm that was
played actually grew.

`soak` is the one that finds interactions nobody designed: it plays greedily and
without judgement for months and asserts the invariants every single day. `reach`
is the one to run after editing the data file: it walks the content rather than
the code and asks how a player actually arrives at each thing in it, because
content nobody can reach is content nobody will report as broken.
