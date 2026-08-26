// Play the farm at random, for a long time, and insist it stays a farm.
//
// Every bug worth finding in this game so far has been the same shape: a state
// the rules could reach and nothing could get out of, or a number that stopped
// being a number. Withered ground that could not be cleared. A counter that had
// never been created, so buying one left NaN spreading through every total it
// touched. Each was found by hand, one at a time, by playing far enough in.
//
// So this plays much further in than a person would, choosing among whatever is
// legal at the time, and after every single call asks whether the farm is still
// a thing the game can describe: no NaN anywhere, nothing negative that counts
// things, nothing fractional, energy inside the farm's own limit, no herd fed
// more than it has, every field the right shape, and — the one that matters
// most — the day can always be ended and there is always something to do.
//
// A failure prints the seed and the exact call that broke it, so it can be
// replayed. The generator is deterministic for a given seed.
import { readFileSync } from 'node:fs'
import * as rules from '../src/core/rules.js'
import { weekOf } from '../src/core/market.js'
import { MAX_LEVEL } from '../src/core/progression.js'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))
const R = data.rules

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

/** A small deterministic generator, so a failing run can be replayed exactly. */
const makeRng = (seed) => {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * Everything that must be true of a farm, at every moment, forever.
 *
 * Returns the first thing that is not, as a sentence, or null.
 */
function wrong(state) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  const counter = (v) => Number.isSafeInteger(v) && v >= 0

  for (const key of ['day', 'money', 'energy', 'xp', 'earned', 'debt', 'seasonEarned', 'bestSeason']) {
    if (!num(state[key])) return `${key} is ${state[key]}`
  }
  if (state.day < 1) return `the calendar went back to day ${state.day}`
  if (state.energy < 0) return `energy went to ${state.energy}`
  if (state.debt < 0) return `debt went to ${state.debt}`
  if (state.xp < 0) return `xp went to ${state.xp}`
  // The one this list was missing. Nothing in the rules is supposed to be able
  // to spend money the farm does not have — every purchase tests the price
  // first — but that is exactly the kind of claim a fuzzer is for.
  if (state.money < 0) return `money went to ${state.money}`
  if (state.earned < 0) return `total earned went to ${state.earned}`
  if (state.seasonEarned < 0) return `this season's takings went to ${state.seasonEarned}`
  if (state.bestSeason < 0) return `the best season went to ${state.bestSeason}`
  // Money and energy are counted in whole units everywhere they are shown, so a
  // fraction is a rounding bug that would print as 3.0000000000000004.
  if (!Number.isInteger(state.money)) return `money is ${state.money}`
  if (!Number.isInteger(state.energy)) return `energy is ${state.energy}`
  if (!Number.isInteger(state.debt)) return `debt is ${state.debt}`

  const bags = { seeds: state.seeds, 'barn.crops': state.barn.crops, 'barn.goods': state.barn.goods, supplies: state.supplies, animals: state.animals, fed: state.fed }
  for (const [name, bag] of Object.entries(bags)) {
    for (const [id, n] of Object.entries(bag ?? {})) {
      if (!counter(n)) return `${name}.${id} is ${n}`
    }
  }
  for (const [id, n] of Object.entries(state.animals ?? {})) {
    if ((state.fed[id] ?? 0) > n) return `${id}: ${state.fed[id]} fed of ${n} owned`
  }
  if (state.energy > rules.farmLimits(state, data).energy) {
    return `energy ${state.energy} above the farm's limit of ${rules.farmLimits(state, data).energy}`
  }
  if (state.plots.length !== R.plots) return `the farm has ${state.plots.length} fields`
  if (typeof state.raining !== 'boolean') return `the weather is ${state.raining}`
  if (!counter(state.market?.week)) return `the market is on week ${state.market?.week}`
  for (const [i, plot] of state.plots.entries()) {
    if (plot.tiles.length < R.tilesPerPlot) return `field ${i} has ${plot.tiles.length} tiles`
    if (plot.cropId != null && !rules.cropById(data, plot.cropId)) return `field ${i} grows "${plot.cropId}", which does not exist`
    if (plot.tiles.length !== R.tilesPerPlot) return `field ${i} has ${plot.tiles.length} tiles`
    for (const t of plot.tiles) {
      if (!counter(t.stage) || !counter(t.age) || !counter(t.picked)) return `field ${i} has a tile at stage ${t.stage}, age ${t.age}, picked ${t.picked}`
      // Every flag on a tile is a count too, and NaN in any of them spreads the
      // same way as it does anywhere else.
      if (!counter(t.watered) || !counter(t.fertilized) || !counter(t.pest)) {
        return `field ${i} has a tile watered ${t.watered}, fertilized ${t.fertilized}, pest ${t.pest}`
      }
      if (t.stage > R.stage.empty) return `field ${i} has a tile at stage ${t.stage}, past the end of the list`
    }
    // A field with nothing growing in it must not still be claimed by a crop,
    // and a field claimed by nothing must not have anything alive in it — the
    // second leaves orphan plants occupying land nobody can sow.
    if (plot.cropId == null && plot.tiles.some(t => t.stage > 0 && t.stage < R.stage.empty)) {
      return `field ${i} belongs to nobody and has something growing in it`
    }
    // A field holding a crop with nothing in it can be neither sown nor cleared.
    if (plot.cropId != null && plot.tiles.every(t => t.stage === R.stage.empty)) {
      return `field ${i} is held by "${plot.cropId}" with every tile bare`
    }
  }
  for (const job of state.pending ?? []) {
    if (!rules.byId(data.recipes, job.id)) return `a batch of "${job.id}" is curing, and there is no such recipe`
    if (!Number.isSafeInteger(job.daysLeft)) return `a batch has ${job.daysLeft} days left`
  }
  for (const o of state.market?.orders ?? []) {
    if (!rules.cropById(data, o.cropId)) return `the market wants "${o.cropId}", which does not exist`
    if (o.filled > o.quota) return `an order is filled ${o.filled} of ${o.quota}`
    if (!counter(o.filled) || !counter(o.quota)) return `an order reads ${o.filled} of ${o.quota}`
  }
  for (const [id, n] of Object.entries(state.market?.sold ?? {})) {
    if (!counter(n)) return `the market has sold ${n} of ${id}`
    if (!rules.cropById(data, id)) return `the market has sold ${n} of "${id}", which does not exist`
  }

  // Shape is not the same as sense. Everything above asks whether the farm can
  // still be described; these ask whether what it describes is a game. A number
  // that is a perfectly good number can still be an unfair one, and none of the
  // checks above would notice.
  if (state.market) {
    const should = weekOf(state.day, data.rules)
    if (state.market.week !== should) return `it is day ${state.day}, week ${should}, and the board says week ${state.market.week}`
    const orders = state.market.orders ?? []
    if (orders.length > data.rules.market.orderCount) {
      return `the board is showing ${orders.length} orders and holds ${data.rules.market.orderCount}`
    }
    const ids = orders.map(o => o.cropId)
    if (new Set(ids).size !== ids.length) return `the board wants the same crop twice: ${ids.join(', ')}`
  }
  for (const job of state.pending ?? []) {
    // A batch with no days left is one the night will never finish and nothing
    // will ever deliver: it sits in the pot for the rest of the game.
    if (job.daysLeft < 1) return `a batch of "${job.id}" has ${job.daysLeft} days left and will never be done`
  }
  for (const [i, plot] of state.plots.entries()) {
    const crop = plot.cropId != null ? rules.cropById(data, plot.cropId) : null
    for (const t of plot.tiles) {
      // Flags, not counts. Watered twice is not wetter, and it is the kind of
      // thing a bulk action can do that a single one cannot.
      if (t.watered !== 0 && t.watered !== 1) return `field ${i} has a tile watered ${t.watered} times`
      if (t.pest !== 0 && t.pest !== 1) return `field ${i} has a tile with ${t.pest} pests on it`
      if (crop && t.picked > (crop.harvests ?? 1)) {
        return `field ${i} has a tile picked ${t.picked} times from a crop that gives ${crop.harvests ?? 1}`
      }
    }
  }
  const level = rules.levelOf(state, data)
  if (!Number.isSafeInteger(level) || level < 1 || level > MAX_LEVEL) return `the farm is level ${level}`
  const earned = state.milestones ?? []
  if (new Set(earned).size !== earned.length) return `the same milestone was earned twice: ${earned.join(', ')}`
  return null
}

/** Everything the farm could legally be asked to do right now. */
function moves(state, rng) {
  const out = []
  const level = rules.levelOf ? rules.levelOf(state, data) : null
  for (const c of data.crops) {
    out.push(['buySeed', () => rules.buySeed(state, data, c.id)])
    // The run's own generator, not the global one. This printed a seed it could
    // not actually replay: a failing run said "seed 12" and seed 12 then took a
    // different path, which is the one thing a fuzzer must never do.
    out.push(['sellCrop', () => rules.sellCrop(state, data, c.id, 1 + Math.floor(rng() * 3))])
    for (let p = 0; p < state.plots.length; p++) out.push([`plant ${c.id}`, () => rules.plant(state, data, p, c.id)])
  }
  for (const g of data.goods) out.push(['sellGood', () => rules.sellGood(state, data, g.id, 2)])
  for (const s of data.supplies) out.push(['buySupply', () => rules.buySupply(state, data, s.id)])
  for (const a of data.animals) {
    out.push(['buyAnimal', () => rules.buyAnimal(state, data, a.id)])
    out.push(['feed', () => rules.feedAnimals(state, data, a.id)])
  }
  for (const r of data.recipes) out.push([`craft ${r.id}`, () => rules.craft(state, data, r.id)])
  for (let p = 0; p < state.plots.length; p++) {
    out.push([`waterPlot ${p}`, () => rules.waterPlot(state, data, p)])
    out.push([`harvestPlot ${p}`, () => rules.harvestPlot(state, data, p)])
    out.push([`clearPlot ${p}`, () => rules.clearPlot(state, data, p)])
    for (const tool of data.tools) {
      for (let t = 0; t < R.tilesPerPlot; t++) {
        out.push([`${tool.id} ${p}:${t}`, () => rules.applyTool(state, data, p, t, tool.id)])
      }
    }
  }
  out.push(['travel', () => rules.travel(state, data)])
  void level
  return out
}

// The two rules that answer with an amount rather than with yes or no.
const KEEPS_NOTHING = /^sell(Crop|Good)/

const SEEDS = Number(process.env.FUZZ_SEEDS || 12)
const DAYS = Number(process.env.FUZZ_DAYS || 400)
const PER_DAY = Number(process.env.FUZZ_MOVES || 25)

console.log(`\nfuzz: ${SEEDS} farms, ${DAYS} days each, ${PER_DAY} things tried a day\n`)

let broke = null
let deepest = 0
let stuck = null
for (let seed = 1; seed <= SEEDS && !broke; seed++) {
  const rng = makeRng(seed * 7919)
  const state = rules.newGame(data, { rng })
  // Every third farm starts as one that has been through a rule-book change and
  // been put back together. Playing only from `newGame` can never reach the
  // states `reconcile` produces, and those are where the last two rounds of
  // bugs actually lived.
  if (seed % 3 === 0) {
    delete state.animals[data.animals[0].id]
    delete state.supplies[data.supplies[0].id]
    state.seeds['crop-that-was-removed'] = 4
    state.barn.crops['crop-that-was-removed'] = 3
    state.plots[0].cropId = 'crop-that-was-removed'
    state.plots[0].tiles.forEach(t => { t.stage = R.stage.seed })
    state.plots[1].cropId = data.crops[0].id
    state.plots[1].tiles.forEach(t => { t.stage = R.stage.empty })
    state.pending.push({ id: 'recipe-that-was-removed', daysLeft: 3 })
    state.energy = 99999
    state.fed[data.animals[1].id] = 40
    rules.reconcile(state, data)
    const bad = wrong(state)
    if (bad) { broke = `seed ${seed}: a farm put back together is not a farm — ${bad}`; break }
  }
  const pick = (list) => list[Math.floor(rng() * list.length)]

  for (let day = 0; day < DAYS && !broke; day++) {
    const legal = moves(state, rng)
    for (let i = 0; i < PER_DAY; i++) {
      const [what, run] = pick(legal)
      // Kept as text rather than a clone: this runs millions of times, and the
      // comparison it is for is an equality one.
      const before = JSON.stringify(state)
      const was = { day: state.day, xp: state.xp, earned: state.earned, bestSeason: state.bestSeason }
      let answer
      try { answer = run() } catch (err) {
        broke = `seed ${seed}, day ${day}: ${what} threw ${err.message}`
        break
      }

      // A refusal has to be nothing happening. A rule that says no after it has
      // already taken the money, or spent the energy, or emptied half a field,
      // leaves a farm that is still perfectly describable — so everything below
      // would pass it, and online the server's transaction would hide it. Only
      // an offline farm keeps the damage, and only this notices.
      // Selling answers with the money kept, not with whether it happened, and
      // a sale whose whole value went to paying off the rescue loan keeps
      // nothing while certainly having happened. So zero is only a refusal for
      // the rules where zero means nothing was done.
      const refused = answer === false || (answer === 0 && !KEEPS_NOTHING.test(what))
      if (refused && JSON.stringify(state) !== before) {
        broke = `seed ${seed}, day ${day}: ${what} was refused and changed the farm anyway`
        break
      }

      // Nothing a player does during a day moves the calendar; only the night
      // does. And the three records of what a farm has ever done only ever go
      // up — a total that can fall is a total that can be farmed.
      if (state.day !== was.day) { broke = `seed ${seed}, day ${day}: ${what} moved the calendar to day ${state.day}`; break }
      for (const k of ['xp', 'earned', 'bestSeason']) {
        if (state[k] < was[k]) { broke = `seed ${seed}, day ${day}: ${what} took ${k} from ${was[k]} down to ${state[k]}`; break }
      }
      if (broke) break

      const bad = wrong(state)
      if (bad) { broke = `seed ${seed}, day ${day}, after ${what}: ${bad}`; break }
    }
    if (broke) break

    // The promise the game makes about never being over. A day in which nothing
    // would change is deliberately refused — an empty day is not a day — so the
    // question is not whether the day can be ended right now, but whether the
    // player has anything left they could do about it.
    //
    // Asked on a copy. The first version of this asked by running every legal
    // move on the farm itself, which both destroyed the evidence and answered
    // the wrong question: a farm is not stuck because somebody spent its last
    // coins on pesticide. What a cornered player actually does is clear the
    // dead ground, sell what is in the barn, and put the cheapest seed they can
    // afford into the ground — so that is what is tried, in that order.
    if (!rules.willAdvanceSimulation(state, data)) {
      const escape = structuredClone(state)
      for (let p = 0; p < escape.plots.length; p++) rules.clearPlot(escape, data, p)
      // A count, not a null: `countOf` reads anything that is not a whole
      // number as nothing at all, so asking to sell `null` sold nothing and made
      // this look like a farm with a barn it could not empty.
      for (const [id, n] of Object.entries(escape.barn.crops)) if (n > 0) rules.sellCrop(escape, data, id, n)
      for (const [id, n] of Object.entries(escape.barn.goods)) if (n > 0) rules.sellGood(escape, data, id, n)
      const affordable = data.crops
        .filter(c => (c.unlockLevel ?? 1) <= rules.levelOf(escape, data))
        .sort((a, b) => a.seedPrice - b.seedPrice)
      for (const c of affordable) {
        if (rules.willAdvanceSimulation(escape, data)) break
        if (!(escape.seeds[c.id] > 0) && !rules.buySeed(escape, data, c.id)) continue
        for (let p = 0; p < escape.plots.length; p++) if (rules.plant(escape, data, p, c.id)) break
      }
      if (!rules.willAdvanceSimulation(escape, data)) {
        stuck = `seed ${seed}, day ${day}: a cornered player has nothing left to try`
        if (process.env.FUZZ_DUMP) {
          const show = (f) => JSON.stringify({
            money: f.money, energy: f.energy, debt: f.debt, day: f.day, level: rules.levelOf(f, data),
            seeds: f.seeds, supplies: f.supplies, animals: f.animals, fed: f.fed,
            barnCrops: f.barn.crops, barnGoods: f.barn.goods, pending: f.pending,
            plots: f.plots.map(p => ({ crop: p.cropId, stages: p.tiles.map(t => t.stage).join(',') })),
            needsRescue: rules.needsRescue(f, data),
          }, null, 1)
          console.log(`\n  the farm as it stood:\n${show(state)}`)
          console.log(`\n  and after clearing, selling and sowing whatever it could:\n${show(escape)}`)
          const why = (f) => {
            const avail = data.crops.filter(c => (c.unlockLevel ?? 1) <= rules.levelOf(f, data))
            const cheapest = Math.min(...avail.map(c => c.seedPrice))
            return {
              cheapest, canAfford: f.money >= cheapest,
              holdsSeeds: Object.values(f.seeds).some(n => n > 0),
              fieldHoldsACrop: f.plots.some(p => p.cropId),
              stock: Object.entries(f.barn.crops).filter(([, n]) => n > 0),
              goods: Object.entries(f.barn.goods).filter(([, n]) => n > 0),
            }
          }
          console.log(`\n  why no rescue, as it stood: ${JSON.stringify(why(state))}`)
          console.log(`  why no rescue, after trying:  ${JSON.stringify(why(escape))}`)
        }
        break
      }
    }

    const dayBefore = state.day
    try { rules.endDay(state, data, rng) } catch (err) {
      broke = `seed ${seed}, day ${day}: the night threw ${err.message}`
      break
    }
    // One night, one day. A night that moved the calendar twice, or not at all,
    // would go unnoticed by every other check here.
    if (state.day !== dayBefore + 1) {
      broke = `seed ${seed}, day ${day}: the night moved the calendar from ${dayBefore} to ${state.day}`
      break
    }
    const bad = wrong(state)
    if (bad) { broke = `seed ${seed}, day ${day}, after the night: ${bad}`; break }
    deepest = Math.max(deepest, state.day)
  }
}

// A fuzzer that prints a seed it cannot replay is worse than no fuzzer: it
// reports a failure and then cannot show it to you again. This one used to
// reach for the global generator when deciding how much to sell.
const replay = (seed, days) => {
  const rng = makeRng(seed * 7919)
  const state = rules.newGame(data, { rng })
  const pick = (list) => list[Math.floor(rng() * list.length)]
  for (let day = 0; day < days; day++) {
    const legal = moves(state, rng)
    for (let i = 0; i < 15; i++) { const [, run] = pick(legal); try { run() } catch { /* not a move */ } }
    if (!rules.willAdvanceSimulation(state, data)) break
    rules.endDay(state, data, rng)
  }
  return JSON.stringify(state)
}
ok('the same seed plays the same game twice', replay(5, 30) === replay(5, 30))
ok('and a different seed plays a different one', replay(5, 30) !== replay(6, 30))

ok('a farm played at random stays a farm it is possible to describe', broke === null, broke ?? '')
ok('and never reaches a day it cannot end', stuck === null, stuck ?? '')
ok('and was played a long way in', deepest > 300, `${deepest} days deep`)

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
