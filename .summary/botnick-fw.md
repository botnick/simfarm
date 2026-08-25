# botnick/fw — SIM FARM remake (session 1, 2026-08-24)

## What this room is doing
Rebuilding the Flash game **SIM FARM** (Armor Games / DailyFreeGames, by `w_w`; the user
called it "The Farmer" / เกมปลูกผักหรรษา) as a **Phaser 4.2.1** web game.
Everything ships in `game/`. The original `the_farmer.swf` is in `original/`.

## The conversation, in order
1. User asked to remake it in Phaser, not Ruffle.
2. I wrote a Python SWF parser + AVM1 disassembler (no ffdec on the box at first).
   Found the game is AS2, vector-only art, variable names in **Indonesian**.
3. `botnick/test-codex` installed ffdec → 610 decompiled `.as` files → exact rules.
4. Recovered the whole economy and rule set from bytecode (see below).
5. User: **fix the balance** → I proved the original was broken with a simulator and retuned.
6. User: **no hardcode, no over-engineering, must be extensible** → one `game.json`.
7. User: **add crafting / making fertilizer / feed / animals** → barn + workshop + recipes.
8. User: **drop the preset switcher, ship only our version** → removed.
9. User: **make it look as close to the original as possible** → codex extracted the real
   scene plates, and the game was rebuilt at the original 600x420 on that artwork.
10. User: **remove the "the FARMER" logo** → stripped from every plate in the asset pipeline.
11. User: **the day/money numbers are misaligned** (they sent a screenshot of the raw SWF
    render) → that was a static export artefact; the game draws those numbers live into the
    exact boxes recovered from the SWF.
12. User: **add a Thai/English system** → done, `strings.json` + bilingual data entries.
13. User: **upscale everything** → renders at 2x (`RENDER_SCALE`), text and art both.

## Rules recovered from the SWF (these are facts, not guesses)
- 4 fields x 12 tiles. **One seed sows a whole field.**
- Tile stages: 1 seed, 2-4 growing, **5 ripe, 6 dead, 12 empty**. Sprite frame number == stage.
- Per day per tile: watered -> +1 growth tick; fertilised 1-2x -> another tick;
  **fertilised >2x kills it**; bug present -> 1/3 chance of death; at stage 4 -> 1/10 chance a bug appears.
- Rain 1/50 per day waters all 48 tiles. Energy resets to 100 each morning. Village trip costs 5.
- Chickens: unfed -> 1/10 chance one dies; fed N with N birds -> N eggs. Max 5.
- Year ends on **day 365**. Start: 400 money, 100 energy.
- Original seed prices 100/200/300/500/600/800/1200/900, sell 50/60/75/150/160/200/350/500,
  days-per-stage 1/1/2/3/4/4/6/5, harvests 1/1/1/4/5/4/6/1.
- Crops are TURNIP CARROT POTATO TOMATO CORN STRAWBERRY GRAPE WATERMELON.

## Balance work
`npm run sim` plays each crop 3650 days x 5 seeds and reports profit per plot-day.
- **Original: 66 -> 434, a 6.6x spread.** Potato (66) was worse than free Turnip (105);
  Watermelon (241) lost to the cheaper Tomato; Grape (434) dominated everything.
- **Shipped: 105 -> 332, 3.2x, and monotonic with seed price.** Verified, not derived on paper.
- Added crops: Radish, Sunflower, Chili (pest-prone), Pumpkin (pest-resistant).

## Architecture decisions worth keeping
- `game/public/data/game.json` is the entire game. No content in code.
- `src/core/rules.js` is pure: no Phaser, no DOM, `rng` injected so days replay.
- Stage is **600x420** (the SWF's own space) so every recovered coordinate is used directly;
  `RENDER_SCALE = 2` gives a 1200x840 canvas with a camera zoom, and `label()`/`art()` in
  `src/ui/kit.js` compensate so text and textures rasterise at double density.
- `tools/prep-assets.mjs` is the only thing that writes `public/assets`. Re-runnable.

## Gotchas hit (do not rediscover these)
- **Phaser 4 does not apply container transforms to child hit areas.** Buttons must be
  scene-level; `button()` returns a handle, not a Container.
- Phaser's loader **stalls forever** if a file is queued in `create()` after a first pass —
  fetch data before `new Phaser.Game` and load in a single `preload`.
- The SWF's 11 kHz MP3s make Chrome throw `EncodingError`; the pipeline re-encodes with ffmpeg.
- `Phaser.Geom.Point` is not a constructor on the global here — use `{x, y}`.
- The isometric tile AABBs overlap heavily; hit-test the **diamond**, not the rectangle.
- The farm's road-to-village hotspot is huge; UI buttons over it need a higher depth.

## Art pass (after the user said it wasn't pretty)
The flat cream panels and capsule buttons fought the cartoon plates. Fixed by:
- Using the SWF's **own display face**: `112_Fat.ttf` is the only extracted font with a
  complete alphabet (`tools/fonttest.mjs` renders all nine to compare). It has **no space
  glyph**, so `label()` swaps ' ' for U+2005 to force a per-glyph fallback.
- Rewriting `src/ui/kit.js` around the artwork's idiom: heavy near-black rim, lit face,
  gloss band, real press offset. `panel/button/chip/title/toast` all share it.
- The webfont must be resident before the first scene paints — `main.js` awaits
  `document.fonts.load` or the title screen bakes in a fallback face.
- Menu and End use `frames-bg` plates (no HUD chrome). **Frame 80 is the original's
  instructions screen, not its ending** — do not use it for the end screen.

## Fonts (user said the type wasn't pretty and asked for Thai + English both good)
- The SWF's `Fat` face has **no Thai and no space glyph** — dropped from the build.
- Shipping **Mitr 400/600** (Latin + digits + Thai in one design) with Noto Sans Thai as
  fallback. `tools/fetch-fonts.mjs` self-hosts the per-script woff2 subsets and regenerates
  `public/assets/fonts/fonts.css` with the right `unicode-range` rules — nothing is fetched
  at runtime. `npm run fonts` re-runs it.
- Gotchas: Google serves **EOT** to an old UA (useless); ask for woff2 and keep the
  unicode-ranges. `fetch-fonts.mjs` rewrites the whole CSS each run, so pass every family
  in one invocation.

## Testing (user asked "e2e หมดยัง" — it wasn't)
`npm run smoke` only walked the screens and checked for console errors; a broken buy button
would have passed. `npm run e2e` now makes **50 click -> observe assertions** (exact price
charged, purchase refused when broke, energy per tile, overnight growth, sale proceeds,
craft consume/cure/deliver, feeding -> eggs, language switch, save/reload keeps money,
end-of-year totals). Runs against any origin via `URL=... npm run e2e`; passed 50/50 both
locally and through the Cloudflare tunnel.

## Sharing
`npx vite preview --port 4173 --host` + `cloudflared tunnel --url http://localhost:4173`.
Vite needs `allowedHosts: true` in `vite.config.js` for both `server` and `preview` or it
rejects the tunnel hostname. trycloudflare URLs are ephemeral.

## Later rounds of user feedback (all from screenshots they sent)
- **Thai tone marks vanished** (`น้ำ` -> `นำ`). Not the data and not the font: **Phaser
  clips text to the font line box**, slicing marks that sit above it. Fixed with vertical
  `padding` in `label()`. The same fix centred button captions, which had looked high
  because a Thai-capable face reserves space above/below the Latin letters.
- **Button captions overflowed the pill** (`$ 1,512`, `BACK TO FARM`). Labels now shrink to
  fit; Thai is longer than English and prices gain digits, so this had to be structural.
- **Hover felt wrong on the farm**: the SWF's field hit rectangles are far bigger than the
  patches and overlap, so pointing at grass named a field across the path. Fields are now
  shrunk to 62% around their centres; coop/house/road keep full reach.
- Icons repeated (three recipes showed the same sack) -> recipes are shown by their main
  ingredient crop, and the three supplies got distinct SWF sprites (119/124/134).
- Chips and panels now size to their text, since Thai runs longer than English.

## Generated art
`tools/prep-generated.py` (venv at `tools/.venv`, gitignored) runs rembg over
`generated/*.png`, trims to the ink, and centres each on a 256px transparent square in
`game/public/assets/goods/`. A good with `image` in game.json uses it; the rest fall back
to the drawn jar. snapgen.ai contract (codex worked it out): POST `/uapi/v1/generate_image`
with header `x-api-key`, multipart `model=nano-banana-pro`, then poll `/uapi/v1/history/<uuid>`
until `status=2` and read `generated_image[0].file_download_url`. Key lives in `.env.local`.

## Two more real bugs, both the same shape
1. **Thai rendered in a fallback face.** A unicode-range-split webfont only fetches the
   subsets the sample text needs, and `document.fonts.load('600 16px Mitr')` samples Latin,
   so Mitr's Thai subset was never loaded. Canvas text bakes at draw time, so every Thai
   string got the system font. Fix: `document.fonts.load(font, 'น้ำ')` for each weight
   before the game boots. Check with `document.fonts.check(font, 'น้ำ')` — it was `false`.
2. Related earlier bug: Phaser clipping tone marks. Both are "canvas bakes once, so
   anything not ready at draw time is lost forever".

## Portrait, done properly (the earlier retreat was wrong)
`src/core/viewport.js` rotates the board and rewrites `game.input.transformPointer`.
Scale mode is `NONE`; the canvas is sized/placed there. Mapping for a clockwise turn:
`stageX = (pageY - r.top)/r.height * STAGE_W`, `stageY = (1 - (pageX - r.left)/r.width) * STAGE_H`,
where `r` is the rotated element's bounding rect (already the visual box).
**The mapping was right the first time; the mobile test was tapping as if unrotated.**
Verify page->stage empirically (move the mouse, read `input.activePointer`) before assuming
the game is wrong. Coverage went 32%->66% (phone), 49%->99% (tablet).
`WIDTH/HEIGHT/RENDER_SCALE` had to move to `src/core/size.js`: viewport.js importing them
from main.js while main.js imports viewport.js is a TDZ cycle.

## Button chrome bugs (found only by zooming to 3x — do that sooner)
- The gloss highlight used the *pill's* corner radius, which exceeded the highlight's own
  height, so it wrapped the caps and read as a white ring around the whole button. Same
  flaw was in `panel()` and `chip()`. Radius must be <= half the highlight's height.
- Auto-fitting a caption on width alone is not enough: Thai stacks marks above and below,
  so the same caption is taller than its English twin and crowded the rim. Fit both axes.
- Portrait is a choice, not a rule: `↻` toggles turned/upright and persists it.

## It became a side mini-game (endless), then server-authoritative
The user changed the brief: no 365-day ending, plugs into their main game. codex led the
design (their brief is worth re-reading in the transcript). Implemented:
- `rules.endDay: null` = endless; a host can still cap a season.
- `src/core/market.js` — weekly saturation tiers (1.0/0.8/0.6 at 24/48) and three weekly
  orders at 1.5x. Processed goods exempt. This is what keeps crop choice a decision.
- `src/core/progression.js` — XP (never spent), levels at 25*L*(L-1), crop/animal unlocks.
- Barn soft cap 48/crop, only the overflow spoils (25%, ceil).
- Milestones with stable ids for the host; rescue seed is a **loan** (debt repaid off the
  top of the next sale) so it cannot be farmed.
- Four animals (duck/chicken/sheep/cow), feeding costs 1 energy a head.
- `server/` runs the same pure rules; client sends intents only. HMAC-keyed rng (no stored
  seed), signed saves, rollback refused by revision, idempotent requests, milestone outbox
  with host ACK.

## Bugs found the hard way — read this before touching the same areas
- **P0 money printer (codex found it):** `sellCrop` accepted a fractional count. `quote`
  prices whole units in a loop while `takeCrop` subtracted 0.1, so one carrot worth 67 paid
  1010. NaN poisoned the barn. Fixed with `countOf`/`indexOf` at the rules boundary, not in
  callers. 13 hostile values are now regression-tested.
- **Fields 2-4 were completely dead** and nobody noticed for hours: their tile coordinates
  live in `interaction-map-ui.json` while field 1's were also in `interaction-map.json`,
  and only the latter was read. `regions()` returned `[]` **silently**. The fix is a union
  **by role** (a whole-file preference then dropped the farmhouse and broke the workshop).
  `npm run regions` now fails loudly if any screen is missing what it needs.
- **A timer is not a security rule.** "End the day after 3s" let an abandoned farm reach a
  fresh market board every 21 seconds. Replaced with `willAdvanceSimulation()`.
- **My own test caught a design bug:** requiring "a productive action" to end the day
  blocks a legitimate rainy day, when nothing needs watering.
- `pkill -f "server/index.mjs"` **kills the shell running it**, because that shell's own
  command line contains the pattern. Cost an hour of phantom exit-144s.

## State
All green: 277 rule tests, 68 e2e, 51 server, 4 mobile, regions check — `npm run smoke` walks every scene with zero console errors,
`npm run build` clean. **Not committed** — the user has not asked yet.

## Peer
`botnick/test-codex` did all the SWF asset extraction (scene plates, interaction maps,
per-frame HUD boxes). Files it produced live in `extracted/`:
`frames-ui/`, `frames-bg/`, `interaction-map-ui.json`, `scene-ui-map.json`, `scene-display-lists.json`.
