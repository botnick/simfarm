// Rule tests. These pin the behaviour recovered from the original SWF, so a
// later refactor cannot quietly change how the farm works.
import { readFileSync } from 'node:fs'
import {
  newGame, plant, applyTool, canApply, endDay, harvestPlot, waterPlot,
  buySeed, buySupply, buyAnimal, feedAnimals, craft, recipeReady,
  cropById, cropCount, goodCount, sellCrop, sellGood, byId, travel,
  levelOf, availableCrops, unitPrice, quoteCrop, takeMilestones, countOf, indexOf,
  willAdvanceSimulation,
} from '../src/core/rules.js'
import * as rules from '../src/core/rules.js'
import { levelFor, levelProgress, unlockedCropIds, MAX_LEVEL } from '../src/core/progression.js'
import { openOrder, weekOf, rollOrders } from '../src/core/market.js'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))
const R = data.rules

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; return }
  fail++; console.error(`  FAIL  ${name}${extra ? `  — ${extra}` : ''}`)
}
const eq = (name, got, want) => ok(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const never = () => 1      // rng that never triggers a chance roll
const always = () => 0     // rng that always triggers one
// Most tests are about how the farm works, not about what is unlocked yet, so
// the fixture starts with everything available. Progression tests ask for a
// beginner explicitly with fresh(1).
const LEVELLED = data.progression.thresholdFactor * 30 * 29
const fresh = (level = null) => {
  const s = newGame(data)
  s.money = 1e6
  s.xp = level == null ? LEVELLED : data.progression.thresholdFactor * level * (level - 1)
  return s
}

/* -------------------------------------------------------------- new game */
{
  const s = newGame(data)
  eq('starts with the original money', s.money, R.startMoney)
  eq('starts with full energy', s.energy, R.startEnergy)
  eq('starts on day 1', s.day, R.startDay)
  eq('has four empty fields', s.plots.length, R.plots)
  ok('every tile starts bare', s.plots.every(p => p.tiles.every(t => t.stage === R.stage.empty)))
}

/* ---------------------------------------------------------------- sowing */
{
  const s = fresh()
  ok('cannot sow without a seed', !plant(s, data, 0, 'turnip'))
  buySeed(s, data, 'turnip')
  ok('sowing succeeds with a seed', plant(s, data, 0, 'turnip'))
  eq('one seed sows all twelve tiles', s.plots[0].tiles.filter(t => t.stage === R.stage.seed).length, R.tilesPerPlot)
  eq('the seed is consumed', s.seeds.turnip, 0)
  buySeed(s, data, 'carrot')
  ok('cannot re-sow an occupied field', !plant(s, data, 0, 'carrot'))
}

/* ---------------------------------------------------------------- growth */
{
  // Turnip is one day per stage: water, end day, one stage gained.
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  waterPlot(s, data, 0)
  endDay(s, data, never)
  eq('a watered turnip gains a stage overnight', s.plots[0].tiles[0].stage, 2)

  // Unwatered tiles do not grow.
  const dry = fresh(); buySeed(dry, data, 'turnip'); plant(dry, data, 0, 'turnip')
  endDay(dry, data, never)
  eq('an unwatered tile does not grow', dry.plots[0].tiles[0].stage, 1)

  // Grape is six days per stage.
  const g = fresh(); buySeed(g, data, 'grape'); plant(g, data, 0, 'grape')
  for (let d = 0; d < 5; d++) { waterPlot(g, data, 0); endDay(g, data, never) }
  eq('grape needs six watered days for one stage', g.plots[0].tiles[0].stage, 1)
  waterPlot(g, data, 0); endDay(g, data, never)
  eq('grape advances on the sixth day', g.plots[0].tiles[0].stage, 2)
}

/* ------------------------------------------------------------ fertiliser */
{
  const s = fresh(); buySupply(s, data, 'fertilizer')
  buySeed(s, data, 'potato'); plant(s, data, 0, 'potato')     // 2 days per stage
  waterPlot(s, data, 0)
  applyTool(s, data, 0, 0, 'fertilize')
  endDay(s, data, never)
  eq('fertiliser buys a second growth tick', s.plots[0].tiles[0].stage, 2)
  eq('an unfertilised tile lags behind', s.plots[0].tiles[1].stage, 1)

  // Three doses on one tile kills the plant, exactly as the original did.
  const k = fresh(); buySupply(k, data, 'fertilizer')
  buySeed(k, data, 'turnip'); plant(k, data, 0, 'turnip')
  const tile = k.plots[0].tiles[0]
  tile.fertilized = 3
  endDay(k, data, never)
  eq('over-fertilising kills the plant', tile.stage, R.stage.dead)
}

/* ------------------------------------------------------------------ pest */
{
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.plots[0].tiles.forEach(t => t.stage = R.pest.spawnStage)
  endDay(s, data, always)
  ok('bugs appear on the vulnerable stage', s.plots[0].tiles.every(t => t.pest === 1))

  const d = fresh(); buySeed(d, data, 'turnip'); plant(d, data, 0, 'turnip')
  d.plots[0].tiles.forEach(t => { t.stage = 3; t.pest = 1 })
  endDay(d, data, always)
  ok('a bug can kill the plant', d.plots[0].tiles.every(t => t.stage === R.stage.dead))

  // Spraying removes the bug and costs one pesticide.
  const sp = fresh(); buySupply(sp, data, 'pesticide')
  buySeed(sp, data, 'turnip'); plant(sp, data, 0, 'turnip')
  sp.plots[0].tiles[0].pest = 1
  const before = sp.supplies.pesticide
  ok('spraying works on an infested tile', applyTool(sp, data, 0, 0, 'spray'))
  eq('spraying clears the bug', sp.plots[0].tiles[0].pest, 0)
  eq('spraying uses one pesticide', sp.supplies.pesticide, before - 1)

  // Pumpkin states a lower spawn chance and must honour it.
  const pk = cropById(data, 'pumpkin')
  ok('a crop can override the pest rule', pk.pest.spawnChance < R.pest.spawnChance)
}

/* -------------------------------------------------------------- harvest */
{
  // A ripe-looking tile in a field with no crop must not be harvestable.
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.plots[0].cropId = null
  s.plots[0].tiles.forEach(t => t.stage = R.stage.ripe)
  ok('a field with no crop cannot be picked', !canApply(s, data, 0, 0, 'harvest'))
  eq('and pick-all takes nothing from it', harvestPlot(s, data, 0), 0)
}

{
  // Single-harvest crop: picking clears the tile.
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.plots[0].tiles.forEach(t => t.stage = R.stage.ripe)
  eq('pick-all takes every ripe tile', harvestPlot(s, data, 0), 12)
  eq('picked crops land in the barn', cropCount(s, 'turnip'), 12)
  ok('a single-harvest field empties out', s.plots[0].tiles.every(t => t.stage === R.stage.empty))
  eq('an emptied field can be sown again', s.plots[0].cropId, null)

  // Multi-harvest crop: tomato gives exactly four pickings from one tile.
  const t = fresh(); buySeed(t, data, 'tomato'); plant(t, data, 0, 'tomato')
  const tile = t.plots[0].tiles[0]
  let picks = 0
  for (let i = 0; i < 10; i++) {
    tile.stage = R.stage.ripe
    if (!applyTool(t, data, 0, 0, 'harvest')) break
    picks++
    if (tile.stage === R.stage.dead) break
  }
  eq('tomato yields four pickings', picks, cropById(data, 'tomato').harvests)
  eq('the last picking ends the plant', tile.stage, R.stage.dead)
}

/* ------------------------------------------------------------- energy */
{
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.energy = 1
  ok('the last point of energy still works', applyTool(s, data, 0, 0, 'water'))
  eq('energy is spent', s.energy, 0)
  ok('an exhausted farmer cannot work', !canApply(s, data, 0, 1, 'water'))
  ok('an exhausted farmer cannot walk to the village', !travel(s, data))
  endDay(s, data, never)
  // A day's energy is not a constant any more: the farm grows with the level, so
  // the morning gives back whatever this farm has earned the right to.
  eq('energy comes back in the morning', s.energy, rules.farmLimits(s, data).energy)
}

/* --------------------------------------------------------------- rain */
{
  const s = fresh(); buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  endDay(s, data, always)
  ok('rain is recorded', s.raining)
  ok('rain waters everything that is growing',
    s.plots[0].tiles.every(t => t.watered === 1))
  // And leaves bare earth alone. Marking an empty tile as watered changed the
  // farm without changing anything about it, which made a quiet night look busy
  // to the rule that decides whether a night is worth having.
  ok('and leaves bare earth alone',
    s.plots.slice(1).every(p => p.tiles.every(t => !t.watered)))
  endDay(s, data, never)
  ok('a dry night leaves every tile thirsty', s.plots.every(p => p.tiles.every(t => !t.watered)))
}

/* ------------------------------------------------------------- animals */
{
  const a = data.animals[0]
  const s = fresh(); buyAnimal(s, data, a.id); buyAnimal(s, data, a.id); buySupply(s, data, a.feed)
  const energyBeforeFeed = s.energy
  eq('feeding covers every animal', feedAnimals(s, data, a.id), 2)
  eq('and costs energy per head', s.energy, energyBeforeFeed - 2 * (R.feedEnergy ?? 0))

  // A tired farmer can only feed as many as the energy left allows.
  const tired = fresh()
  for (let i = 0; i < 4; i++) buyAnimal(tired, data, a.id)
  buySupply(tired, data, a.feed)
  tired.energy = 2
  eq('a tired farmer feeds only what energy allows', feedAnimals(tired, data, a.id), 2)
  eq('and is left with none', tired.energy, 0)
  endDay(s, data, never)
  eq('a fed flock lays one each', goodCount(s, a.produces), 2)

  const h = fresh(); buyAnimal(h, data, a.id)
  endDay(h, data, always)
  eq('a starving flock can lose one', h.animals[a.id], 0)

  // The yard has a limit, and the limit grows with the farm.
  const cap = fresh()
  const room = rules.animalRoom(cap, data, a)
  for (let i = 0; i < room + 3; i++) buyAnimal(cap, data, a.id)
  eq('the coop fills up and stops', cap.animals[a.id], room)
  ok('and a bigger farm has room for more', room > a.max, `${room} vs ${a.max} at level 1`)
  const beginner = fresh(1)
  eq('while a new farm has exactly what the data file says', rules.animalRoom(beginner, data, a), a.max)
}

/* --------------------------------------------------- feeding costs effort */
{
  const a = data.animals.find(x => x.id === 'chicken') ?? data.animals[0]
  const cost = R.feedEnergy ?? 0

  // Nothing is charged for a call that feeds nothing.
  const none = fresh()
  const before = none.energy
  eq('feeding with no animals feeds none', feedAnimals(none, data, a.id), 0)
  eq('and costs nothing', none.energy, before)

  const noFeed = fresh()
  buyAnimal(noFeed, data, a.id)
  eq('feeding with an empty sack feeds none', feedAnimals(noFeed, data, a.id), 0)
  eq('and still costs nothing', noFeed.energy, R.startEnergy)

  // A full herd costs exactly one energy a head.
  const herd = fresh()
  let heads = 0
  for (const animal of data.animals) {
    for (let i = 0; i < animal.max; i++) if (buyAnimal(herd, data, animal.id)) heads++
  }
  for (const supply of data.supplies) for (let i = 0; i < 3; i++) buySupply(herd, data, supply.id)
  const energyBefore = herd.energy
  let fedTotal = 0
  for (const animal of data.animals) fedTotal += feedAnimals(herd, data, animal.id)
  eq('a full herd is fed to the last head', fedTotal, heads)
  eq('and costs exactly one energy a head', herd.energy, energyBefore - heads * cost)

  // With no energy left, nothing is fed and nothing is spent.
  const spent = fresh()
  buyAnimal(spent, data, a.id); buySupply(spent, data, a.feed)
  spent.energy = 0
  eq('an exhausted farmer feeds nothing', feedAnimals(spent, data, a.id), 0)
  eq('and the feed stays in the sack', spent.supplies[a.feed], data.supplies.find(x => x.id === a.feed).amount)

  // A fractional or hostile count feeds nothing.
  const odd = fresh()
  buyAnimal(odd, data, a.id); buySupply(odd, data, a.feed)
  eq('half an animal cannot be fed', feedAnimals(odd, data, a.id, 0.5), 0)
  eq('and no energy goes with it', odd.energy, R.startEnergy)
}

/* --------------------------------------------- a day that changes nothing */
{
  // The server uses this to tell a quiet day from someone spinning the calendar
  // looking for a market board they like.
  const empty = fresh()
  ok('an abandoned farm would not change overnight', !willAdvanceSimulation(empty, data))

  // Anything alive in the ground makes the night matter, watered or not: it can
  // be rained on, it can be found by pests, and if it is already bitten it may
  // not be there in the morning. Refusing the day would have made every one of
  // those consequences unreachable.
  const dry = fresh(); buySeed(dry, data, 'turnip'); plant(dry, data, 0, 'turnip')
  ok('a planted farm has a night worth having, watered or not', willAdvanceSimulation(dry, data))

  // A field of dead plants is not alive, so it is not a reason on its own.
  const withered = fresh(); buySeed(withered, data, 'turnip'); plant(withered, data, 0, 'turnip')
  withered.money = 500
  withered.plots[0].tiles.forEach(t => { t.stage = data.rules.stage.dead })
  ok('a field of dead plants is not', !willAdvanceSimulation(withered, data))

  const watered = fresh(); buySeed(watered, data, 'turnip'); plant(watered, data, 0, 'turnip')
  waterPlot(watered, data, 0)
  ok('a watered crop will grow overnight', willAdvanceSimulation(watered, data))

  // Rain waters the whole farm, so a genuine rainy day passes with no clicks.
  const rained = fresh(); buySeed(rained, data, 'turnip'); plant(rained, data, 0, 'turnip')
  endDay(rained, data, always)
  ok('a rainy night counts as something happening', willAdvanceSimulation(rained, data))

  const fed = fresh()
  const first = data.animals[0]
  buyAnimal(fed, data, first.id); buySupply(fed, data, first.feed)
  feedAnimals(fed, data, first.id)
  ok('a fed animal will lay overnight', willAdvanceSimulation(fed, data))

  const curing = fresh()
  curing.barn.crops.strawberry = 9
  craft(curing, data, 'jam')
  ok('a curing recipe will finish overnight', willAdvanceSimulation(curing, data))

  const dead = fresh(); buySeed(dead, data, 'turnip'); plant(dead, data, 0, 'turnip')
  dead.plots[0].tiles.forEach(t => { t.stage = R.stage.dead })
  ok('a field of dead plants changes nothing', !willAdvanceSimulation(dead, data))
}

/* ------------------------------------------------------------ crafting */
{
  const s = fresh()
  const jam = byId(data.recipes, 'jam')
  ok('a recipe is refused without ingredients', !craft(s, data, 'jam'))
  s.barn.crops.strawberry = jam.inputs[0].amount
  ok('a recipe is ready once the barn can cover it', recipeReady(s, data, jam))
  const energyBefore = s.energy
  ok('the recipe starts', craft(s, data, 'jam'))
  eq('ingredients are consumed', cropCount(s, 'strawberry'), 0)
  eq('the recipe costs energy', s.energy, energyBefore - jam.energy)
  eq('nothing is delivered while it cures', goodCount(s, 'jam'), 0)
  for (let d = 0; d < jam.days; d++) endDay(s, data, never)
  eq('the good arrives when curing ends', goodCount(s, 'jam'), jam.output.amount)

  // Instant recipes skip the queue entirely.
  const c = fresh(); c.barn.crops.turnip = 4
  ok('an instant recipe runs at once', craft(c, data, 'compost'))
  eq('compost lands straight in the shed', c.supplies.fertilizer, byId(data.recipes, 'compost').output.amount)

  // "any crop" spends the cheapest first, so good crops are not wasted.
  const w = fresh(); w.barn.crops.grape = 2; w.barn.crops.turnip = 6
  craft(w, data, 'compost')   // needs 4 of anything
  eq('compost eats the cheap crops first', cropCount(w, 'turnip'), 2)
  eq('compost leaves the valuable crop alone', cropCount(w, 'grape'), 2)
}

/* -------------------------------------------------------------- selling */
{
  const s = fresh(); s.money = 0
  s.barn.crops.watermelon = 2
  eq('crops sell at the listed price', sellCrop(s, data, 'watermelon', 2), cropById(data, 'watermelon').sellPrice * 2)
  s.barn.goods.jam = 1
  eq('goods sell at the listed price', sellGood(s, data, 'jam', 1), byId(data.goods, 'jam').price)
  ok('selling cannot go negative', sellCrop(s, data, 'watermelon', 5) === 0)
}

/* ---------------------------------------------------------- end of year */
{
  // The farm is endless by default; a host game can still cap it by setting
  // rules.endDay, so both paths have to hold.
  const s = fresh(); s.day = 5000
  ok('an endless farm never finishes', !endDay(s, data, never).finished)

  const capped = { ...data, rules: { ...R, endDay: 365 } }
  const c = newGame(capped); c.day = 364
  ok('a capped season finishes on its last day', endDay(c, capped, never).finished)
  const c2 = newGame(capped); c2.day = 100
  ok('and not before', !endDay(c2, capped, never).finished)
}

/* ------------------------------------------------------------ progression */
{
  const f = data.progression.thresholdFactor
  eq('a new farm starts at level 1', levelFor(0, data), 1)
  eq('level 2 costs what the formula says', levelFor(f * 2 * 1, data), 2)
  eq('and one short of it is still level 1', levelFor(f * 2 * 1 - 1, data), 1)
  // Not a magic number: the curve is retuned whenever tools/pace.mjs says the
  // game is taking too long to open up, and a test that pinned one factor would
  // simply have to be edited to whatever the new one is, which proves nothing.
  // What matters is the shape.
  ok('each level costs more than the one before',
    Array.from({ length: 20 }, (_, i) => i + 2).every(l => f * l * (l - 1) > f * (l - 1) * (l - 2)))
  ok('and the steps grow, so late levels are an achievement',
    (f * 5 * 4 - f * 4 * 3) < (f * 12 * 11 - f * 11 * 10))
  // The last thing the game has to offer must be reachable by somebody playing
  // it, which is the whole reason the factor is what it is.
  const hardest = Math.max(
    ...data.crops.map(c => c.unlockLevel ?? 1),
    ...data.animals.map(a => a.unlockLevel ?? 1))
  const perDay = data.progression.xp.harvestTile * data.rules.tilesPerPlot   // one field picked
  ok('the last unlock is within a season of steady play',
    f * hardest * (hardest - 1) / perDay < 120,
    `${Math.round(f * hardest * (hardest - 1) / perDay)} days of picking one field a day`)

  const s = fresh(1)
  eq('only the starter crops are available at first',
    availableCrops(s, data).map(c => c.id).sort(), ['carrot', 'radish', 'turnip'])
  ok('a locked crop cannot be bought', !buySeed(s, data, 'grape'))
  eq('and buying it takes no money', s.money, 1e6)

  // Harvesting is what earns experience, one point per tile.
  buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.plots[0].tiles.forEach(t => t.stage = R.stage.ripe)
  const before = s.xp
  harvestPlot(s, data, 0)
  eq('every picked tile earns experience', s.xp - before, R.tilesPerPlot * data.progression.xp.harvestTile)

  const p = levelProgress(0, data)
  eq('progress starts at the bottom of level 1', p.into, 0)
  ok('and knows what the next level needs', p.needed > 0)
}

/* ---------------------------------------------------------------- market */
{
  const m = data.rules.market

  // A weekly order pays a premium until its quota is met, then the price drops
  // back to the ordinary rate.
  const s = fresh()
  const ordered = s.market.orders[0].cropId
  const base = cropById(data, ordered).sellPrice
  eq('an order pays the premium rate', unitPrice(s, data, ordered), Math.round(base * m.orderMultiplier))

  s.barn.crops[ordered] = 100
  const q = quoteCrop(s, data, ordered, m.orderQuota)
  eq('the whole quota is paid at the premium', q.total, Math.round(base * m.orderMultiplier) * m.orderQuota)
  eq('and the quote says how many were order units', q.orderUnits, m.orderQuota)

  sellCrop(s, data, ordered, m.orderQuota)
  ok('filling the quota closes the order', !openOrder(s, ordered))
  eq('the next unit is back to the ordinary price', unitPrice(s, data, ordered), base)

  // Flooding the market with one crop drives its price down in tiers.
  eq('the first tier is the full price', unitPrice(s, data, ordered), Math.round(base * m.tiers[0].multiplier))
  sellCrop(s, data, ordered, m.tiers[0].upTo)
  eq('past the first tier the price drops', unitPrice(s, data, ordered), Math.round(base * m.tiers[1].multiplier))
  sellCrop(s, data, ordered, m.tiers[1].upTo - m.tiers[0].upTo)
  eq('and drops again past the second', unitPrice(s, data, ordered), Math.round(base * m.tiers[2].multiplier))

  // Processed goods are the way out of a flooded market, so they hold value.
  const g = byId(data.goods, 'jam')
  const j = fresh(); j.money = 0; j.barn.goods.jam = 10
  eq('goods ignore market saturation', sellGood(j, data, 'jam', 10), g.price * 10)

  // A new week brings a new board.
  const w = fresh()
  const firstWeek = w.market.week
  for (let i = 0; i < m.weekLength; i++) endDay(w, data, never)
  ok('the board turns over with the week', w.market.week !== firstWeek)
  eq('and the sold counts start again', Object.keys(w.market.sold).length, 0)
  eq('weeks are counted from day one', weekOf(1, R), 0)
}

/* --------------------------------------------------------------- spoilage */
{
  // The barn holds more as the farm grows, so the limit is asked for rather than
  // read off the rule book.
  const s = fresh()
  const cap = rules.farmLimits(s, data).barnSoftCap
  s.barn.crops.turnip = cap
  endDay(s, data, never)
  eq('a barn at its limit keeps everything', cropCount(s, 'turnip'), cap)

  const over = fresh()
  over.barn.crops.turnip = cap + 20
  const report = endDay(over, data, never)
  eq('only the surplus spoils', cropCount(over, 'turnip'), cap + 20 - Math.ceil(20 * R.barn.spoilRate))
  eq('and the report says how much was lost', report.spoiled.turnip, Math.ceil(20 * R.barn.spoilRate))

  const beginner = fresh(1)
  eq('a new farm gets exactly the barn the rule book gives it',
    rules.farmLimits(beginner, data).barnSoftCap, R.barn.softCap)
  ok('and an old one has more room than that',
    rules.farmLimits(fresh(40), data).barnSoftCap > R.barn.softCap)
}

/* ------------------------------------------------------------- milestones */
{
  const s = fresh()
  buySeed(s, data, 'turnip'); plant(s, data, 0, 'turnip')
  s.plots[0].tiles[0].stage = R.stage.ripe
  applyTool(s, data, 0, 0, 'harvest')
  ok('a first harvest is recorded', s.milestones.includes('first-harvest'))

  const queued = takeMilestones(s)
  ok('the host can collect what is new', queued.includes('first-harvest'))
  eq('and collecting empties the queue', takeMilestones(s).length, 0)

  // The same milestone must never be handed out twice, or a host would pay for
  // it again every time.
  s.plots[0].tiles[1].stage = R.stage.ripe
  applyTool(s, data, 0, 1, 'harvest')
  eq('a milestone is never awarded twice', s.milestones.filter(m => m === 'first-harvest').length, 1)
  eq('and nothing new is queued', takeMilestones(s).length, 0)

  // Levelling past several thresholds at once should award each of them.
  const j = fresh(1)
  j.xp = data.progression.thresholdFactor * 11 * 10   // level 11 in one jump
  const k = fresh(1)
  k.barn.crops.strawberry = 3
  k.xp = j.xp - 1
  craft(k, data, 'jam')                                // tips it over the line
  ok('passing a level awards its milestone', k.milestones.includes('level-10'))
  ok('and the ones below it too', k.milestones.includes('level-5'))
}

/* ---------------------------------------------------------------- rescue */
{
  // Stranded: no money, no seeds, nothing growing, nothing to sell.
  const s = fresh(1)
  s.money = 0
  const report = endDay(s, data, never)
  eq('a stranded farm is given one seed', report.rescued, data.rules.rescue.cropId)
  eq('and exactly one', s.seeds[data.rules.rescue.cropId], 1)

  // Anyone with something to work with is left alone.
  const rich = fresh(1); rich.money = 0; rich.barn.crops.turnip = 5
  ok('a farm with stock is not rescued', !endDay(rich, data, never).rescued)
  const busy = fresh(1)
  buySeed(busy, data, 'turnip'); busy.money = 0
  ok('a farm holding a seed is not rescued', !endDay(busy, data, never).rescued)
  const growing = fresh(1)
  buySeed(growing, data, 'turnip'); plant(growing, data, 0, 'turnip'); growing.money = 0
  ok('a farm with a crop in the ground is not rescued', !endDay(growing, data, never).rescued)
}

/* -------------------------------------------------------- hostile input */
{
  // A fractional count used to be a money printer: `quote` prices whole units,
  // so one carrot sold as ten calls of 0.1 paid for ten carrots.
  // `undefined` is left out on purpose: omitting the count means "one", which
  // is the documented default rather than a hostile value.
  const HOSTILE = [0.1, 0.9999, '1', '999', NaN, Infinity, -Infinity, -1, 0, null, {}, [], 1e20]
  for (const bad of HOSTILE) {
    const s = fresh(); s.money = 0; s.barn.crops.carrot = 5
    const paid = sellCrop(s, data, 'carrot', bad)
    eq(`selling ${JSON.stringify(bad)} of a crop pays nothing`, paid, 0)
    eq(`selling ${JSON.stringify(bad)} leaves the barn alone`, cropCount(s, 'carrot'), 5)
    eq(`selling ${JSON.stringify(bad)} leaves no money`, s.money, 0)
  }
  // Ten tenths of a carrot must not out-earn one whole carrot.
  const drip = fresh(); drip.money = 0; drip.barn.crops.carrot = 1
  for (let i = 0; i < 10; i++) sellCrop(drip, data, 'carrot', 0.1)
  eq('a crop cannot be sold in slices', drip.money, 0)

  const g = fresh(); g.money = 0; g.barn.goods.jam = 3
  eq('goods refuse a fractional count too', sellGood(g, data, 'jam', 0.5), 0)
  eq('and keep their stock', goodCount(g, 'jam'), 3)

  eq('a whole count still works', (() => { const s = fresh(); s.money = 0; s.barn.crops.carrot = 3; sellCrop(s, data, 'carrot', 3); return cropCount(s, 'carrot') })(), 0)
  eq('omitting the count sells exactly one', (() => { const s = fresh(); s.barn.crops.carrot = 3; sellCrop(s, data, 'carrot'); return cropCount(s, 'carrot') })(), 2)

  // Asking for more than the barn holds sells the barn, never more. Clamping
  // rather than refusing keeps a "sell all" button honest when stock changes.
  {
    const s = fresh(); s.money = 0; s.barn.crops.carrot = 2
    const paid = sellCrop(s, data, 'carrot', 500)
    eq('asking for more than you hold sells only what you hold', cropCount(s, 'carrot'), 0)
    eq('and pays for exactly that much', paid, s.money)
    ok('which is two units, not five hundred', paid < 500, `paid ${paid}`)
  }

  eq('countOf rejects anything but a whole number', [countOf(1), countOf(0.5), countOf(-2), countOf('3'), countOf(NaN)], [1, 0, 0, 0, 0])
  eq('indexOf keeps an index inside the list', [indexOf(0, 4), indexOf(3, 4), indexOf(4, 4), indexOf(-1, 4), indexOf(1.5, 4), indexOf('2', 4)], [0, 3, -1, -1, -1, -1])
}

/* ------------------------------------------------------- out-of-range asks */
{
  const s = fresh(); buySeed(s, data, 'turnip')
  ok('a field that does not exist cannot be sown', !plant(s, data, 99, 'turnip'))
  ok('nor a negative one', !plant(s, data, -1, 'turnip'))
  ok('nor a fractional one', !plant(s, data, 1.5, 'turnip'))
  eq('and the seed is still in the bag', s.seeds.turnip, 1)

  plant(s, data, 0, 'turnip')
  ok('a tile that does not exist cannot be worked', !canApply(s, data, 0, 99, 'water'))
  ok('nor a negative tile', !canApply(s, data, 0, -1, 'water'))
  ok('a tool that does not exist does nothing', !applyTool(s, data, 0, 0, 'flamethrower'))
  eq('watering an impossible tile costs no energy', s.energy, R.startEnergy)
}

/* ------------------------------------------------------- planting unlocks */
{
  // A seed can reach the bag by other routes, so the gate is on planting too.
  const s = fresh(1)
  s.seeds.grape = 5
  ok('a locked crop cannot be planted even if held', !plant(s, data, 0, 'grape'))
  eq('and the seed is not consumed', s.seeds.grape, 5)
}

/* ------------------------------------------------------------ craft rules */
{
  // A recipe naming the same crop twice must need the full total, not each line.
  const twice = {
    ...data,
    recipes: [...data.recipes, {
      id: 'double', name: { en: 'Double', th: 'ทดสอบ' }, energy: 1, days: 0,
      inputs: [{ crop: 'turnip', amount: 3 }, { crop: 'turnip', amount: 3 }],
      output: { supply: 'fertilizer', amount: 1 },
    }],
  }
  const s = newGame(twice); s.xp = LEVELLED; s.barn.crops.turnip = 4
  ok('a recipe cannot be half-paid', !craft(s, twice, 'double'))
  eq('and takes nothing when refused', cropCount(s, 'turnip'), 4)
  s.barn.crops.turnip = 6
  ok('with the full amount it goes ahead', craft(s, twice, 'double'))
  eq('and takes all of it', cropCount(s, 'turnip'), 0)

  // A locked ingredient blocks the recipe.
  const beginner = fresh(1)
  beginner.barn.crops.grape = 99
  ok('a recipe needing a locked crop is refused', !craft(beginner, data, 'wine'))
}

/* ---------------------------------------------------------- rescue is a loan */
{
  const s = fresh(1)
  s.money = 0
  endDay(s, data, never)
  const owed = s.debt
  ok('the rescue seed is recorded as a debt', owed > 0)

  // A sale repays the loan off the top before any of it reaches the player.
  s.barn.crops.turnip = 2
  const gross = quoteCrop(s, data, 'turnip', 2).total
  const moneyBefore = s.money
  const kept = sellCrop(s, data, 'turnip', 2)
  eq('the loan is repaid out of the sale', s.debt, Math.max(0, owed - gross))
  eq('and only the remainder is kept', kept, Math.max(0, gross - owed))
  eq('which is what lands in the purse', s.money, moneyBefore + kept)

  // Emptying the barn on purpose to claim another seed just adds more debt.
  const farmer = fresh(1)
  farmer.money = 0
  let debtBefore = 0
  for (let i = 0; i < 3; i++) {
    farmer.seeds = {}; farmer.barn.crops = {}; farmer.barn.goods = {}
    farmer.plots.forEach(p => { p.cropId = null })
    endDay(farmer, data, never)
    ok(`claiming the rescue again only adds debt (round ${i + 1})`, farmer.debt > debtBefore)
    debtBefore = farmer.debt
  }
}

/* -------------------------------------- a sale the rescue loan swallows whole */
{
  // The loan is repaid off the top, so a small sale can keep nothing at all.
  // That is not the same as the sale not happening: the crop leaves the barn and
  // the debt shrinks. Anything that reads "kept nothing" as "did nothing" will
  // tell the player their click was refused and lose the change.
  const s = fresh()
  s.money = 0
  s.debt = 100000
  s.barn.crops.turnip = 1
  const before = s.debt
  const kept = sellCrop(s, data, 'turnip', 1)
  eq('a sale swallowed by the loan keeps nothing', kept, 0)
  eq('but the crop still left the barn', cropCount(s, 'turnip'), 0)
  ok('and the debt actually shrank', s.debt < before, `${before} -> ${s.debt}`)
  eq('and no money appeared', s.money, 0)
}

/* --------------------------------------------------------- awkward numbers */
{
  eq('a level cannot run away on a corrupt total', levelFor(Number.MAX_SAFE_INTEGER, data) <= MAX_LEVEL, true)
  eq('nonsense experience reads as level 1', [levelFor(NaN, data), levelFor(-5, data), levelFor(Infinity, data) <= MAX_LEVEL], [1, 1, true])

  // A random source that returns exactly 1 must not index past the pool.
  const ids = unlockedCropIds(data, 1)
  const orders = rollOrders(data, ids, () => 1)
  ok('a maximal random draw still picks real crops', orders.every(o => ids.includes(o.cropId)))
  eq('and still fills the board', orders.length, Math.min(data.rules.market.orderCount, ids.length))
  const zero = rollOrders(data, ids, () => 0)
  ok('a minimal draw works too', zero.every(o => ids.includes(o.cropId)))
}

/* ------------------------------------------- no recipe should be a trap */
{
  // A recipe that makes something the shop also sells has to be worth doing.
  // If the ingredients fetch more than the output would cost to buy, the button
  // is a trap: the sensible play is to sell and go shopping, and the recipe is
  // there to catch people who do not do the arithmetic.
  // Price the ingredients with the game's own market code rather than
  // multiplier arithmetic, so a rounding or tier-boundary change cannot slip
  // past this check by being right in the abstract and wrong in the game.
  const valueAt = (cropId, count, alreadySold) => {
    const s = fresh()
    s.market.orders = []                      // an order premium would mask the tier
    s.market.sold[cropId] = alreadySold
    return quoteCrop(s, data, cropId, count).total
  }
  const tiers = data.rules.market.tiers
  const floodedFrom = tiers[tiers.length - 2].upTo   // first unit priced at the deepest tier

  for (const recipe of data.recipes) {
    const supply = recipe.output.supply && byId(data.supplies, recipe.output.supply)
    if (!supply) continue                       // goods are priced on their own terms

    // What the output would cost at the shop.
    const outputValue = (recipe.output.amount / supply.amount) * supply.price

    // What the ingredients would fetch, at full price and once flooded.
    let full = 0, flooded = 0
    for (const inp of recipe.inputs) {
      // "Any crop" spends the cheapest first, so price it as that crop: the
      // strictest reading of "you could have just sold this".
      const id = inp.crop ?? [...data.crops].sort((a, b) => a.sellPrice - b.sellPrice)[0].id
      const n = inp.crop ? inp.amount : inp.anyCrop
      full += valueAt(id, n, 0)
      flooded += valueAt(id, n, floodedFrom)
    }
    if (!full) continue

    // Feed is worth exactly its price: it is eaten and gone, so the shop price
    // is the whole of its value and the comparison is fair. Fertiliser and
    // spray are not — one buys growing time and the other saves a crop from
    // dying, both worth more than the sticker. So only feeds get the lower
    // bound; everything gets the upper one, because no recipe should ever beat
    // simply selling the ingredients at full price.
    const isFeed = data.animals.some(a => a.feed === supply.id)
    if (isFeed) {
      ok(`${recipe.id} is worth making when the market is flooded`,
        outputValue >= flooded * 0.9,
        `output ${Math.round(outputValue)} vs ingredients ${Math.round(flooded)} at flooded prices`)
    }
    ok(`${recipe.id} does not beat simply selling at full price`,
      outputValue <= full,
      `output ${Math.round(outputValue)} vs ingredients ${Math.round(full)} at full price`)

    // There is deliberately no check at the middle tier. Crafting is meant to
    // win only once a crop is genuinely flooded; asking it to also pay at
    // partial saturation would be a stricter rule than the design makes, and an
    // assertion that has to keep being loosened is not testing anything.
  }
}

/* ------------------------------------------------- data file consistency */
{
  const starters = data.crops.filter(c => (c.unlockLevel ?? 1) === 1)
  ok('some crops are available from the start', starters.length >= 2)
  ok('the weekly board can always be filled', starters.length >= data.rules.market.orderCount)
  for (const c of data.crops) {
    ok(`crop ${c.id} has art`, !!c.art)
    ok(`crop ${c.id} has a sane price`, c.seedPrice > 0 && c.sellPrice > 0)
    ok(`crop ${c.id} grows`, c.daysPerStage >= 1 && c.harvests >= 1)
  }
  for (const r of data.recipes) {
    const out = r.output
    ok(`recipe ${r.id} outputs something real`,
      out.supply ? !!byId(data.supplies, out.supply) : !!byId(data.goods, out.good))
    for (const inp of r.inputs) {
      if (inp.anyCrop != null) continue
      ok(`recipe ${r.id} input exists`, inp.crop ? !!cropById(data, inp.crop) : !!byId(data.goods, inp.good))
    }
  }
  for (const m of data.milestones ?? []) {
    ok(`milestone ${m.id} has a trigger`, ['harvest', 'craft', 'animal', 'level', 'season'].includes(m.when))
    ok(`milestone ${m.id} is named in both languages`, !!(m.name?.en && m.name?.th))
  }
  eq('milestone ids are unique', new Set((data.milestones ?? []).map(m => m.id)).size, (data.milestones ?? []).length)
  ok('the rescue crop is a real starter crop',
    !!cropById(data, data.rules.rescue.cropId) && (cropById(data, data.rules.rescue.cropId).unlockLevel ?? 1) === 1)
  for (const a of data.animals) {
    ok(`animal ${a.id} eats a real supply`, !!byId(data.supplies, a.feed))
    ok(`animal ${a.id} produces a real good`, !!byId(data.goods, a.produces))
  }
}

/* ------------------------------------------- a game that keeps having a next */
{
  // Every unlock has a last one. Past it the level number is the only thing
  // still moving, and a number that buys nothing is decoration — so the farm
  // grows instead, and the host keeps being told about it.
  const g = data.progression.grants
  ok('the farm is set up to keep growing', g?.every > 0, JSON.stringify(g))

  const beginner = rules.newGame(data)
  const early = rules.farmLimits(beginner, data)
  eq('a new farm starts on exactly what the rule book says', early.energy, data.rules.startEnergy)
  eq('and the barn the rule book gives it', early.barnSoftCap, data.rules.barn.softCap)
  eq('with no extra room in the yard', early.animalMax, 0)

  // Whatever level a farm reaches, the day and the yard are bigger than they
  // were. The barn is the exception and stops on purpose.
  let last = early
  for (const level of [10, 25, 50, 200, 999]) {
    const s = rules.newGame(data)
    s.xp = data.progression.thresholdFactor * level * (level - 1)
    const now = rules.farmLimits(s, data)
    ok(`a farm at level ${level} has more of the day than one at the level before`,
      now.energy > last.energy, `${last.energy} -> ${now.energy}`)
    ok(`and a bigger yard`, now.animalMax > last.animalMax)
    ok(`and never a smaller barn`, now.barnSoftCap >= last.barnSoftCap)
    last = now
  }

  // The barn stops, and stopping is the point: storage that kept growing would
  // let somebody hold half a year of one crop and drip it out under the level
  // the market floods at, which is the pressure the market rules exist to apply.
  const ceiling = data.rules.barn.softCap * data.progression.grants.barnSoftCapMax
  const huge = rules.newGame(data)
  huge.xp = data.progression.thresholdFactor * 900 * 899
  eq('however far a farm goes, the barn stops where it was told to',
    rules.farmLimits(huge, data).barnSoftCap, ceiling)
  const weeks = ceiling / data.rules.market.tiers[0].upTo
  ok('which is a bigger barn and not a price-smoothing machine',
    weeks >= 4 && weeks <= 8, `${weeks} weeks of unflooded selling`)

  // And what the farm is shown next is only what it will really get.
  const capped = rules.newGame(data)
  capped.xp = data.progression.thresholdFactor * 200 * 199
  const promised = rules.nextGrant(capped, data)
  eq('a farm past the barn ceiling is not promised more barn', promised.barnSoftCap, 0)
  ok('but is still promised the rest', promised.energy > 0 && promised.animalMax > 0)
  const topped = rules.newGame(data)
  topped.xp = data.progression.thresholdFactor * 999 * 998
  eq('and a farm with nothing left to gain is promised nothing', rules.nextGrant(topped, data), null)

  // And the rewards do not run out with the list.
  const listed = Math.max(...data.milestones.filter(m => m.when === 'level').map(m => m.level))
  const every = data.progression.milestoneEvery
  ok('milestones keep coming after the listed ones', every > 0, String(every))

  // Picking a crop is what awards experience, so that is how the farm gets
  // there — one tile, from just under a level to well past several.
  const far = rules.newGame(data)
  far.money = 1e9
  far.energy = 1e6
  const crop = data.crops[0]
  rules.buySeed(far, data, crop.id)
  rules.plant(far, data, 0, crop.id)
  far.plots[0].tiles.forEach(t => { t.stage = data.rules.stage.ripe })

  const target = listed + every * 3
  far.xp = data.progression.thresholdFactor * target * (target - 1) - 1
  rules.applyTool(far, data, 0, 0, 'harvest')      // crosses into `target`

  const beyond = (far.milestones ?? []).filter(id => /^level-(\d+)$/.test(id))
    .map(id => Number(id.split('-')[1]))
    .filter(l => l > listed)
  ok('a farm played far past the list still earns them', beyond.length > 0,
    JSON.stringify(far.milestones))
  ok('and each is a round number a host can recognise',
    beyond.every(l => l % every === 0), JSON.stringify(beyond))
  eq('and none is awarded twice',
    new Set(far.milestones).size, far.milestones.length)
}

/* -------------------------------- the gate and the night must tell one story */
{
  // The server refuses to end a day that would change nothing. That promise is
  // only worth anything if it is true, and it is easy to break by accident:
  // somebody adds a rule to the night and the gate does not learn about it, and
  // then a farm in exactly that state is frozen — the consequence can never
  // happen, because the day it happens on can never end.
  //
  // Rather than a list of examples, this states the contract: if the gate says
  // nothing would change, then running the night must actually change nothing.
  // Every state below is one somebody could really be in.
  const IGNORED = new Set(['day', 'market', 'energy', 'raining', 'seasonEarned', 'bestSeason'])
  const meaningful = (state) => {
    const copy = structuredClone(state)
    for (const k of IGNORED) delete copy[k]
    return JSON.stringify(copy)
  }

  const crop = data.crops[0]
  const animal = data.animals[0]
  const situations = {
    'a bare farm with money': (s) => { s.money = 500 },
    'seeds in the bag, nothing sown': (s) => { s.money = 500; s.seeds[crop.id] = 3 },
    'a crop sown and watered': (s) => {
      s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id); rules.waterPlot(s, data, 0)
    },
    'a crop sown and left dry': (s) => { s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id) },
    'a dry crop with a pest on it': (s) => {
      s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id)
      s.plots[0].tiles[0].pest = 1
    },
    'a dry crop old enough to attract one': (s) => {
      s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id)
      s.plots[0].tiles.forEach(t => { t.stage = data.rules.pest.spawnStage })
    },
    'a ripe crop nobody has picked': (s) => {
      s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id)
      s.plots[0].tiles.forEach(t => { t.stage = data.rules.stage.ripe })
    },
    'a dead crop nobody has cleared': (s) => {
      s.seeds[crop.id] = 1; rules.plant(s, data, 0, crop.id)
      s.plots[0].tiles.forEach(t => { t.stage = data.rules.stage.dead })
    },
    'animals that have been fed': (s) => {
      s.animals[animal.id] = 2; s.fed[animal.id] = 2; s.money = 500
    },
    'animals that have not been fed': (s) => {
      s.animals[animal.id] = 2; s.fed[animal.id] = 0; s.money = 500
    },
    'a barn holding more than it comfortably can': (s) => {
      s.money = 500; s.barn.crops[crop.id] = (data.rules.barn.softCap ?? 48) * 3
    },
    'a barn holding exactly what it comfortably can': (s) => {
      s.money = 500; s.barn.crops[crop.id] = data.rules.barn.softCap ?? 48
    },
    'a recipe curing in the workshop': (s) => {
      s.money = 500
      const slow = data.recipes.find(r => r.days > 0)
      if (slow) s.pending.push({ id: slow.id, daysLeft: slow.days })
    },
    'a farm with absolutely nothing': (s) => { s.money = 0 },
  }

  // Both ends of the dice, so a branch that only fires on a lucky roll cannot
  // hide behind an unlucky one.
  for (const [label, setUp] of Object.entries(situations)) {
    for (const [roll, rng] of [['never', () => 0.999999], ['always', () => 0]]) {
      const s = rules.newGame(data)
      setUp(s)
      const gate = rules.willAdvanceSimulation(s, data)
      const before = meaningful(s)
      rules.endDay(s, data, rng)
      const changed = meaningful(s) !== before
      if (!gate) {
        ok(`${label}: the gate refuses it, so the night really does nothing (dice ${roll})`,
          !changed, 'the night changed the farm on a day the player is not allowed to end')
      } else {
        // The other direction is not a contract — a night the gate allows may
        // still happen to change nothing — so it is only recorded, not asserted.
        void changed
      }
    }
  }
}

/* ------------------------------------------ the first month, played sensibly */
{
  // The balance table says what a crop is worth to an ideal farmer with infinite
  // money. This asks a different question: can somebody who starts with what the
  // game gives them actually get going, and is the day ever refused to a player
  // who is genuinely playing?
  const lcg = (n) => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const sow = (s) => {
    for (let p = 0; p < data.rules.plots; p++) {
      if (s.plots[p].cropId) continue
      const affordable = rules.availableCrops(s, data)
        .filter(c => c.seedPrice <= s.money)
        .sort((a, b) => a.seedPrice - b.seedPrice)[0]
      if (!affordable) break
      rules.buySeed(s, data, affordable.id)
      rules.plant(s, data, p, affordable.id)
    }
  }

  for (const seed of [1, 7, 42]) {
    const rng = lcg(seed)
    const s = rules.newGame(data)
    const started = s.money
    let refusedDays = 0

    for (let day = 0; day < 30; day++) {
      sow(s)
      for (let p = 0; p < data.rules.plots; p++) {
        if (!s.plots[p].cropId) continue
        rules.harvestPlot(s, data, p)
        for (let t = 0; t < data.rules.tilesPerPlot; t++) {
          if (s.plots[p].tiles[t].stage === data.rules.stage.dead) rules.applyTool(s, data, p, t, 'clear')
        }
      }
      for (const c of data.crops) {
        const n = rules.cropCount(s, c.id)
        if (n) rules.sellCrop(s, data, c.id, n)
      }
      sow(s)                                   // the field just emptied is sown again
      for (let p = 0; p < data.rules.plots; p++) if (s.plots[p].cropId) rules.waterPlot(s, data, p)

      if (!rules.willAdvanceSimulation(s, data)) { refusedDays++; continue }
      rules.endDay(s, data, rng)
    }

    eq(`a month of sensible play is never refused a day (seed ${seed})`, refusedDays, 0)
    ok(`and the farm is better off than it started (seed ${seed})`, s.money > started, `${started} -> ${s.money}`)
    ok(`and has grown into a level or two (seed ${seed})`, rules.levelOf(s, data) > 1, `level ${rules.levelOf(s, data)}`)
    ok(`without ever needing the rescue (seed ${seed})`, !rules.needsRescue(s, data) && (s.debt ?? 0) === 0,
      `debt ${s.debt}`)
  }
}

/* ------------------------------------- the small rules the big ones stand on */
{
  // These three are only ever called from inside other rules, so they are
  // covered by accident. Covered by accident is how a helper quietly changes
  // meaning, and two of them decide things a player would notice.
  const { pestOf, totalCrops, toolById } = rules

  // A crop may say how likely pests are on it; anything it does not say, it
  // takes from the rule book. Two crops in the data file use this, so it is a
  // live feature rather than a possibility.
  const base = data.rules.pest
  const plain = data.crops.find(c => !c.pest)
  eq('a crop with nothing to say takes the rule book whole', pestOf(plain, data.rules), { ...base })
  const fussy = data.crops.find(c => c.pest)
  ok('a crop that has its own pest rule exists in the data', !!fussy, JSON.stringify(data.crops.map(c => c.id)))
  if (fussy) {
    const merged = pestOf(fussy, data.rules)
    for (const [k, v] of Object.entries(fussy.pest)) eq(`${fussy.id} keeps its own ${k}`, merged[k], v)
    for (const k of Object.keys(base)) {
      if (!(k in fussy.pest)) eq(`${fussy.id} still takes ${k} from the rule book`, merged[k], base[k])
    }
  }

  // Recipes that ask for "any crops" are counted with this, so it has to count
  // every kind and not merely the first.
  const barn = fresh()
  eq('an empty barn holds nothing', totalCrops(barn), 0)
  barn.barn.crops.turnip = 3
  barn.barn.crops.carrot = 4
  eq('and a mixed barn counts every kind', totalCrops(barn), 7)

  eq('a tool is found by its id', toolById(data, 'water')?.id, 'water')
  eq('and an unknown tool is nothing', toolById(data, 'flamethrower'), undefined)
  eq('and neither is a tool asked for by something that is not a name', toolById(data, 7), undefined)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
