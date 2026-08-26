// Pure game rules. No Phaser, no DOM, and no randomness of its own: every roll
// goes through the injected `rng`, so a day can be replayed and tested.
// Every number lives in public/data/game.json — nothing about crops, prices,
// animals or recipes is written here.

import { newMarket, quote, recordSale, refreshMarket, nextUnitPrice } from './market.js'
import { levelFor, unlockedCropIds, MAX_LEVEL } from './progression.js'

/**
 * Every number that crosses into the rules has to be a real, whole, sane count.
 *
 * This is not defensive decoration. A fractional count used to be catastrophic:
 * `quote` prices whole units in a loop, so selling one carrot as ten calls of
 * 0.1 charged the barn a tenth each time but paid for a whole unit every time —
 * turning a 67 crop into 1010. NaN quietly poisoned the barn with NaN. Counts
 * are therefore clamped here, at the boundary, rather than in any one caller.
 */
const MAX_COUNT = 10000

/**
 * The shape of a farm this build can actually show.
 *
 * The number of fields and the tiles in one are read from the rule book
 * everywhere in the rules, which makes them look adjustable, and they are not:
 * there are four field screens, four sets of art, four ways in from the farm,
 * and twelve tile positions marked out on each. A rule book asking for a fifth
 * field would be obeyed by every rule and shown by nothing — land the night
 * keeps advancing that the player cannot reach. So the number lives here, is
 * checked against the rule book by `checkData`, and is checked against the
 * screens themselves by the suite.
 */
export const BUILT_FOR = { plots: 4, tilesPerPlot: 12 }
export function countOf(value, limit = MAX_COUNT) {
  const n = typeof value === 'number' ? value : NaN
  if (!Number.isSafeInteger(n) || n < 1) return 0
  return Math.min(n, limit)
}

/** An index into a fixed-length list: whole, in range, or nothing. */
export function indexOf(value, length) {
  const n = typeof value === 'number' ? value : NaN
  return Number.isSafeInteger(n) && n >= 0 && n < length ? n : -1
}

export const byId = (list, id) => (typeof id === 'string' ? list.find(x => x.id === id) : undefined)
export const cropById = (data, id) => byId(data.crops, id)

/** Per-crop pest settings fall back to the global rule, so a crop states only what it changes. */
export const pestOf = (crop, rules) => ({ ...rules.pest, ...(crop.pest || {}) })

const emptyTile = () => ({ stage: 0, age: 0, watered: 0, fertilized: 0, pest: 0, picked: 0 })

export function newGame(data, { name = '', rng = Math.random } = {}) {
  const r = data.rules
  const state = {
    name,
    day: r.startDay,
    money: r.startMoney,
    energy: r.startEnergy,
    // A day may only be ended if something was done in it. A farm on its very
    // first morning has done nothing yet and must still be allowed to sleep, so
    // it starts having "worked" — the same thing the server does when it opens
    // a session. Kept on the farm so it survives a save.
    workedSinceEndDay: true,
    raining: false,
    seeds: {},                                        // cropId -> count
    supplies: Object.fromEntries(data.supplies.map(s => [s.id, 0])),
    barn: { crops: {}, goods: {} },                   // what the farm has produced
    animals: Object.fromEntries(data.animals.map(a => [a.id, 0])),
    fed: Object.fromEntries(data.animals.map(a => [a.id, 0])),   // fed since sunrise
    pending: [],                                      // recipes curing: { id, daysLeft }
    earned: 0,
    xp: 0,
    milestones: [],                                   // one-time, for the host game
    seasonEarned: 0,
    bestSeason: 0,
    debt: 0,
    plots: Array.from({ length: r.plots }, () => ({
      cropId: null,
      tiles: Array.from({ length: r.tilesPerPlot }, () => ({ ...emptyTile(), stage: r.stage.empty })),
    })),
  }
  // The opening board is a roll like any other, so it takes a generator like
  // any other. It defaulted to the global one, which meant a farm could not be
  // reproduced from its seed even in principle — and a fuzzer that cannot
  // replay the run it just failed on is not much of a fuzzer.
  state.market = newMarket(data, unlockedCropIds(data, 1), state.day, rng)
  return state
}

/** The farm's level, derived from experience rather than stored twice. */
export const levelOf = (state, data) => levelFor(state.xp ?? 0, data)

/** Crops the player has reached; the shop and the market board use this. */
export const availableCrops = (state, data) => data.crops.filter(c => (c.unlockLevel ?? 1) <= levelOf(state, data))

/**
 * How big the farm has grown.
 *
 * Every unlock has a last one. Without something that keeps arriving, the game
 * runs out of things to say around the level the final crop appears and the
 * number stops meaning anything — so the farm itself grows instead, for ever.
 *
 * These are all things that already exist: more of the day, more room to store a
 * glut, a bigger yard.
 *
 * Energy and the yard grow without a ceiling because they are one system rather
 * than two: each step adds four energy and room for one more of each of the four
 * kinds, and feeding four more animals costs very close to the four energy it
 * just gave. So the day never gets easier, it gets larger — and since feeding
 * pays experience once for the whole flock, a bigger herd does not make levels
 * come faster either.
 *
 * The barn is different and does have a ceiling. Storage that keeps growing
 * eventually lets a player hold half a year of one crop and drip it out below
 * the flooding threshold for ever, which is exactly the pressure the market
 * rules exist to apply. Three times the original is six weeks of unflooded
 * selling — plainly a bigger barn, and not a price-smoothing machine.
 *
 * Computed from the level rather than stored, so it can never disagree with it.
 */
export function farmLimits(state, data) {
  const r = data.rules
  const g = data.progression?.grants
  const base = {
    energy: r.startEnergy,
    barnSoftCap: r.barn?.softCap ?? Infinity,
    animalMax: 0,                      // an offset; each animal has its own base
    steps: 0,
  }
  if (!g?.every) return base
  const steps = Math.floor((levelOf(state, data) - 1) / g.every)
  if (steps <= 0) return base
  const barnCeiling = (r.barn?.softCap ?? Infinity) * (g.barnSoftCapMax ?? Infinity)
  return {
    energy: base.energy + steps * (g.energy ?? 0),
    barnSoftCap: Math.min(barnCeiling, base.barnSoftCap + steps * (g.barnSoftCap ?? 0)),
    animalMax: steps * (g.animalMax ?? 0),
    steps,
  }
}

/** How many of this animal the yard can hold, now. */
export const animalRoom = (state, data, animal) => animal.max + farmLimits(state, data).animalMax

/**
 * The level the farm grows at next, and what it will get.
 *
 * A reward the player cannot see coming is not a goal, and past the last unlock
 * this is the only thing left to aim at.
 */
export function nextGrant(state, data) {
  const g = data.progression?.grants
  if (!g?.every) return null
  const level = levelOf(state, data)
  const at = (Math.floor((level - 1) / g.every) + 1) * g.every + 1

  // Only what will actually change. The barn stops growing at its ceiling, and
  // promising space it will not get is worse than saying nothing.
  const now = farmLimits(state, data)
  const then = farmLimits({ ...state, xp: data.progression.thresholdFactor * at * (at - 1) }, data)
  const grant = {
    level: at,
    energy: then.energy - now.energy,
    barnSoftCap: then.barnSoftCap - now.barnSoftCap,
    animalMax: then.animalMax - now.animalMax,
  }
  // At the very top of the curve there is nothing further to give, and a farm
  // should not be shown a goal that is three zeroes.
  const gives = grant.energy + grant.barnSoftCap + grant.animalMax
  return gives > 0 ? grant : null
}

/** Award experience and note any level gained, so the UI can celebrate it. */
function gainXp(state, data, amount) {
  if (!amount) return null
  const before = levelOf(state, data)
  state.xp = (state.xp ?? 0) + amount
  const after = levelOf(state, data)
  if (after > before) {
    for (const m of data.milestones ?? []) {
      if (m.when === 'level' && m.level <= after) award(state, m.id)
    }
    // The listed ones run out — the last is level twenty — and a host with
    // nothing left to reward has nothing left to say about a farm somebody is
    // still playing. So past the list they keep coming, on a rule rather than a
    // list, with ids a host can recognise without being told each one.
    const every = data.progression?.milestoneEvery
    if (every > 0) {
      const listed = Math.max(0, ...(data.milestones ?? []).filter(m => m.when === 'level').map(m => m.level))
      for (let level = Math.ceil((listed + 1) / every) * every; level <= after; level += every) {
        if (level > listed) award(state, `level-${level}`)
      }
    }
    return after
  }
  return null
}

/**
 * One-time achievements, kept as a plain list of ids. A host game reads these
 * to hand out its own rewards, and the stable id is what stops it rewarding
 * the same thing twice.
 */
function award(state, id) {
  state.milestones ??= []
  if (state.milestones.includes(id)) return false
  state.milestones.push(id)
  ;(state.pendingMilestones ??= []).push(id)
  return true
}

/** Milestones reached since the host last looked. Reading them clears the queue. */
export function takeMilestones(state) {
  const out = state.pendingMilestones ?? []
  state.pendingMilestones = []
  return out
}

const milestoneFor = (data, when) => (data.milestones ?? []).filter(m => m.when === when)

/* ------------------------------------------------------------------ barn */

export const cropCount = (state, id) => state.barn.crops[id] || 0
export const goodCount = (state, id) => state.barn.goods[id] || 0
export const totalCrops = (state) => Object.values(state.barn.crops).reduce((a, b) => a + b, 0)

const addCrop = (state, id, n = 1) => { state.barn.crops[id] = cropCount(state, id) + n }
const addGood = (state, id, n = 1) => { state.barn.goods[id] = goodCount(state, id) + n }

function takeCrop(state, id, n) {
  if (cropCount(state, id) < n) return false
  state.barn.crops[id] -= n
  return true
}
function takeGood(state, id, n) {
  if (goodCount(state, id) < n) return false
  state.barn.goods[id] -= n
  return true
}
/** Spend `n` crops of no particular kind, cheapest first — what "any crop" recipes want. */
function takeAnyCrop(state, data, n) {
  const held = Object.entries(state.barn.crops).filter(([, c]) => c > 0)
  if (held.reduce((a, [, c]) => a + c, 0) < n) return false
  held.sort((a, b) => (cropById(data, a[0])?.sellPrice ?? 0) - (cropById(data, b[0])?.sellPrice ?? 0))
  let left = n
  for (const [id, have] of held) {
    const take = Math.min(have, left)
    state.barn.crops[id] -= take
    left -= take
    if (!left) break
  }
  return true
}

/** What one more unit of this crop fetches today, after saturation and orders. */
export const unitPrice = (state, data, id) => nextUnitPrice(state, data, id)

/** What selling everything you hold of this crop would fetch, priced unit by unit. */
export const quoteCrop = (state, data, id, n) => quote(state, data, id, n)

export function sellCrop(state, data, id, count = 1) {
  const crop = cropById(data, id)
  const n = countOf(count, cropCount(state, id))
  if (!crop || n < 1 || !takeCrop(state, id, n)) return 0
  const { total } = quote(state, data, id, n)
  const ordersDone = recordSale(state, data, id, n)
  const { kept } = settleDebt(state, total)
  state.money += kept
  state.earned += kept
  state.seasonEarned = (state.seasonEarned ?? 0) + kept
  if (ordersDone) gainXp(state, data, data.progression.xp.order * ordersDone)
  return kept
}

export function sellGood(state, data, id, count = 1) {
  const good = byId(data.goods, id)
  const n = countOf(count, goodCount(state, id))
  if (!good || n < 1 || !takeGood(state, id, n)) return 0
  const gross = good.price * n
  const { kept } = settleDebt(state, gross)
  state.money += kept; state.earned += kept
  state.seasonEarned = (state.seasonEarned ?? 0) + kept
  return kept
}

/* -------------------------------------------------------------- shopping */

export function buySeed(state, data, cropId) {
  const crop = cropById(data, cropId)
  if (!crop || state.money < crop.seedPrice) return false
  if ((crop.unlockLevel ?? 1) > levelOf(state, data)) return false
  state.money -= crop.seedPrice
  state.seeds[cropId] = (state.seeds[cropId] || 0) + 1
  return true
}

export function buySupply(state, data, id) {
  const item = byId(data.supplies, id)
  if (!item || state.money < item.price) return false
  state.money -= item.price
  state.supplies[id] += item.amount
  return true
}

export function buyAnimal(state, data, id) {
  const a = byId(data.animals, id)
  if (!a || state.money < a.price || state.animals[id] >= animalRoom(state, data, a)) return false
  if ((a.unlockLevel ?? 1) > levelOf(state, data)) return false
  state.money -= a.price
  state.animals[id]++
  milestoneFor(data, 'animal').forEach(m => award(state, m.id))
  return true
}

/* ------------------------------------------------------------------ field */

/** One seed sows a whole plot — the original's rule, and why plots feel like decisions. */
export function plant(state, data, plotIndex, cropId) {
  const r = data.rules
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  const crop = cropById(data, cropId)
  if (!plot || !crop || plot.cropId || !(state.seeds[cropId] > 0)) return false
  // A seed can reach the bag by routes other than the shop, so the level gate
  // is enforced where the crop actually goes into the ground.
  if ((crop.unlockLevel ?? 1) > levelOf(state, data)) return false
  if (!plot.tiles.every(t => t.stage === r.stage.empty)) return false
  state.seeds[cropId]--
  plot.cropId = cropId
  plot.tiles = plot.tiles.map(() => ({ ...emptyTile(), stage: r.stage.seed }))
  return true
}

/**
 * Bring a saved farm back into agreement with the data it is about to be played
 * against.
 *
 * The README says adding a crop, an animal or a recipe is an edit to one JSON
 * file, and it is — but a farm saved before that edit outlives it. Offline the
 * browser hands whatever is in the slot straight to the rules, and a plot
 * growing a crop the game no longer has is not a cosmetic problem: the night
 * looks the crop up to age it, finds nothing, and throws. The day cannot be
 * ended, so the throw repeats for ever and the farm is finished. Withered
 * ground at least had twelve clicks as a way out.
 *
 * Everything unknown is dropped rather than guessed at. A crop that no longer
 * exists cannot be priced, grown or sold, so pretending otherwise only moves
 * the failure somewhere harder to read. Land is the exception worth keeping: a
 * field growing a vanished crop is emptied, not lost.
 *
 * Returns what it had to drop, so a caller can say so rather than leaving the
 * player to notice their tomatoes are gone.
 */
export function reconcile(state, data) {
  const r = data.rules
  const dropped = { crops: [], animals: [], goods: [], supplies: [], recipes: [], plots: 0, orders: 0, hiddenPlots: 0 }
  const known = (list, id) => byId(list, id) != null
  // A counter that survived an edit is still only trustworthy as a number. NaN
  // spreads through every sum it touches and prints as "NaN" on the wallet.
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)

  const sift = (bag, list, into) => {
    if (!bag) return
    for (const id of Object.keys(bag)) {
      if (known(list, id)) { bag[id] = count(bag[id]); continue }
      if (bag[id]) into.push(id)
      delete bag[id]
    }
  }
  sift(state.seeds, data.crops, dropped.crops)
  sift(state.barn?.crops, data.crops, [])
  sift(state.market?.sold, data.crops, [])
  sift(state.barn?.goods, data.goods, dropped.goods)

  // Removing something is only half of it, and the quieter half. Adding a crop,
  // an animal or a supply is the edit people actually make, and a save written
  // before that edit has no counter for the new thing at all — so buying one
  // did `undefined + 1` and left NaN in the farm, which then spread through
  // every total it was part of. Anything the rule book has now gets a counter,
  // whether or not the save had ever heard of it.
  state.supplies ??= {}
  for (const id of Object.keys(state.supplies)) {
    if (known(data.supplies, id)) continue
    if (state.supplies[id]) dropped.supplies.push(id)
    delete state.supplies[id]
  }
  for (const item of data.supplies ?? []) state.supplies[item.id] = count(state.supplies[item.id])

  // Animals come in pairs of counters and both have to agree, or feeding walks
  // a herd that is not there.
  state.animals ??= {}
  state.fed ??= {}
  for (const id of Object.keys(state.animals)) {
    if (known(data.animals, id)) continue
    if (state.animals[id]) dropped.animals.push(id)
    delete state.animals[id]
    delete state.fed[id]
  }
  for (const id of Object.keys(state.fed)) if (!known(data.animals, id)) delete state.fed[id]
  for (const a of data.animals ?? []) {
    state.animals[a.id] = count(state.animals[a.id])
    // More fed than owned is a herd being fed twice; it can only ever have come
    // from a save that disagrees with itself.
    state.fed[a.id] = Math.min(count(state.fed[a.id]), state.animals[a.id])
  }

  // A batch curing towards a recipe that no longer exists never finishes.
  state.pending = (state.pending ?? []).filter(job => {
    if (known(data.recipes, job.id)) return true
    dropped.recipes.push(job.id)
    return false
  })

  // The week's orders are reissued anyway; an order for a crop nobody can grow
  // is only a card that can never be filled.
  if (state.market?.orders) {
    const before = state.market.orders.length
    state.market.orders = state.market.orders.filter(o => known(data.crops, o.cropId))
    dropped.orders = before - state.market.orders.length
  }

  // The farm's shape is data too. A rule book that gives out more fields than
  // this save was written with leaves the rules reaching past the end of an
  // array; land the player already owns is never taken away, because a farm
  // that shrinks is a farm somebody paid for and lost.
  state.plots ??= []
  const bare = () => ({ cropId: null, tiles: Array.from({ length: r.tilesPerPlot }, () => ({ ...emptyTile(), stage: r.stage.empty })) })
  while (state.plots.length < r.plots) state.plots.push(bare())
  // And no more than that. A field beyond the ones the game can show is not a
  // bonus: the night goes on advancing it, crops in it ripen and rot, and the
  // player has no way to reach any of it. Better gone than secretly farmed.
  if (state.plots.length > r.plots) {
    dropped.hiddenPlots = state.plots.length - r.plots
    state.plots.length = r.plots
  }
  for (const plot of state.plots) {
    plot.tiles ??= []
    while (plot.tiles.length < r.tilesPerPlot) plot.tiles.push({ ...emptyTile(), stage: r.stage.empty })
    if (plot.cropId == null) continue
    if (known(data.crops, plot.cropId)) {
      // The other way a plot can strand: it holds a crop while every tile is
      // already bare, so nothing can be sown and nothing can be cleared.
      releaseIfBare(plot, r)
      continue
    }
    dropped.plots++
    plot.cropId = null
    plot.tiles = plot.tiles.map(() => ({ ...emptyTile(), stage: r.stage.empty }))
  }

  // A save written before the day gate existed carries no marker. The server
  // gives a resumed session the benefit of the doubt for the same reason, so
  // the two go on agreeing about which days may be ended.
  if (typeof state.workedSinceEndDay !== 'boolean') state.workedSinceEndDay = true

  // Energy is one day's worth and the rule book decides how much that is, so a
  // save carrying more than the farm can now hold is simply a full day. The
  // barn is deliberately not clamped: it is allowed to overflow, and spoilage
  // at the end of the day is the rule that deals with it.
  state.energy = Math.min(count(state.energy), farmLimits(state, data).energy)

  dropped.crops = [...new Set(dropped.crops)]
  dropped.animals = [...new Set(dropped.animals)]
  dropped.goods = [...new Set(dropped.goods)]
  dropped.supplies = [...new Set(dropped.supplies)]
  return dropped
}

/** A plot goes back on the market once every tile has been cleared. */
const releaseIfBare = (plot, r) => {
  if (plot.cropId && plot.tiles.every(t => t.stage === r.stage.empty)) plot.cropId = null
}

export const toolById = (data, id) => byId(data.tools, id)

/** Can this tool do anything to this tile right now? Drives both the click and the cursor. */
export function canApply(state, data, plotIndex, tileIndex, toolId) {
  const r = data.rules
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  const tool = toolById(data, toolId)
  if (!plot || !tool) return false
  const tile = plot.tiles[indexOf(tileIndex, plot.tiles.length)]
  if (!tile) return false
  if (state.energy < tool.energy) return false
  if (tool.consumes && !(state.supplies[tool.consumes] > 0)) return false
  switch (toolId) {
    case 'water':     return plot.cropId != null && tile.stage < r.stage.dead && !tile.watered
    case 'fertilize': return plot.cropId != null && tile.stage < r.stage.dead && !tile.fertilized
    case 'spray':     return tile.pest > 0
    case 'clear':     return tile.stage !== r.stage.empty
    case 'harvest':   return plot.cropId != null && tile.stage === r.stage.ripe
    default:          return false
  }
}

/** Apply a tool to one tile. Every successful action costs energy; picking fills the barn. */
export function applyTool(state, data, plotIndex, tileIndex, toolId) {
  if (!canApply(state, data, plotIndex, tileIndex, toolId)) return false
  const r = data.rules
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  const tile = plot.tiles[indexOf(tileIndex, plot.tiles.length)]
  const tool = toolById(data, toolId)
  const crop = plot.cropId ? cropById(data, plot.cropId) : null

  switch (toolId) {
    case 'water':     tile.watered = 1; break
    case 'fertilize': tile.fertilized++; state.supplies.fertilizer--; break
    case 'spray':     tile.pest = 0; state.supplies.pesticide--; break
    case 'clear':     Object.assign(tile, emptyTile(), { stage: r.stage.empty }); break
    case 'harvest':
      addCrop(state, plot.cropId)
      gainXp(state, data, data.progression.xp.harvestTile)
      milestoneFor(data, 'harvest').forEach(m => award(state, m.id))
      tile.picked++
      // Multi-harvest crops drop back a stage and ripen again; the last picking ends the plant.
      if (tile.picked >= crop.harvests) tile.stage = crop.harvests > 1 ? r.stage.dead : r.stage.empty
      else { tile.stage = r.stage.ripe - 1; tile.age = 0 }
      break
  }
  state.energy = Math.max(0, state.energy - tool.energy)
  releaseIfBare(plot, r)
  return true
}

/** Harvest every ripe tile in a plot that energy allows — the field is 48 clicks otherwise. */
export function harvestPlot(state, data, plotIndex) {
  let n = 0
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  if (!plot) return 0
  for (let i = 0; i < plot.tiles.length; i++) {
    while (canApply(state, data, plotIndex, i, 'harvest') && applyTool(state, data, plotIndex, i, 'harvest')) n++
  }
  return n
}

/**
 * Clear every withered tile in a plot that energy allows.
 *
 * Only the dead ones. `clear` on its own will happily turn a ripe crop back
 * into bare earth, which is fine as a deliberate one-tile choice and a disaster
 * as a button, so the whole-field version refuses to touch anything still
 * living. Without it a field killed by frost or pests can only be recovered
 * twelve clicks at a time, and until it is recovered it cannot be sown at all —
 * so the farm quietly loses a quarter of its land to one bad night.
 */
export function clearPlot(state, data, plotIndex) {
  let n = 0
  const r = data.rules
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  if (!plot) return 0
  for (let i = 0; i < plot.tiles.length; i++) {
    if (plot.tiles[i].stage !== r.stage.dead) continue
    if (canApply(state, data, plotIndex, i, 'clear') && applyTool(state, data, plotIndex, i, 'clear')) n++
  }
  return n
}

/** Water every dry tile in a plot that energy allows. */
export function waterPlot(state, data, plotIndex) {
  let n = 0
  const plot = state.plots[indexOf(plotIndex, state.plots.length)]
  if (!plot) return 0
  for (let i = 0; i < plot.tiles.length; i++) {
    if (canApply(state, data, plotIndex, i, 'water') && applyTool(state, data, plotIndex, i, 'water')) n++
  }
  return n
}

/* --------------------------------------------------------------- animals */

/**
 * Feed some of a herd. Each head costs feed and a point of energy, so a barn
 * full of animals competes with the fields for the day rather than being income
 * that arrives for free.
 */
export function feedAnimals(state, data, id, n = null) {
  const a = byId(data.animals, id)
  if (!a) return 0
  const cost = data.rules.feedEnergy ?? 0
  const room = state.animals[id] - state.fed[id]
  const asked = n == null ? room : countOf(n, room)
  const affordable = cost > 0 ? Math.floor(state.energy / cost) : Infinity
  const give = Math.min(asked, room, state.supplies[a.feed], affordable)
  if (give <= 0) return 0
  state.supplies[a.feed] -= give
  state.fed[id] += give
  state.energy = Math.max(0, state.energy - give * cost)
  return give
}

/* -------------------------------------------------------------- crafting */

/** What a recipe needs, and whether the barn can cover it right now. */
export function recipeReady(state, data, recipe) {
  if (state.energy < recipe.energy) return false
  return recipe.inputs.every(inp =>
    inp.anyCrop != null ? totalCrops(state) >= inp.anyCrop
    : inp.crop ? cropCount(state, inp.crop) >= inp.amount
    : goodCount(state, inp.good) >= inp.amount)
}

/**
 * Start a recipe. Instant ones land straight in the barn; the rest cure over days.
 *
 * Ingredients are totalled before anything is taken. Checking each line on its
 * own would let a recipe that names the same crop twice — or one specific crop
 * plus "any crop" — pass the check and then only half-pay for itself.
 */
export function craft(state, data, recipeId) {
  const recipe = byId(data.recipes, recipeId)
  if (!recipe || !recipeReady(state, data, recipe)) return false
  // Every ingredient must itself be something the player has reached.
  const level = levelOf(state, data)
  const reachable = recipe.inputs.every(i =>
    i.anyCrop != null || !i.crop || (cropById(data, i.crop)?.unlockLevel ?? 1) <= level)
  if (!reachable) return false

  // Total the demands, then confirm the barn covers all of them at once.
  const wantCrop = {}, wantGood = {}
  let wantAny = 0
  for (const inp of recipe.inputs) {
    if (inp.anyCrop != null) wantAny += inp.anyCrop
    else if (inp.crop) wantCrop[inp.crop] = (wantCrop[inp.crop] ?? 0) + inp.amount
    else wantGood[inp.good] = (wantGood[inp.good] ?? 0) + inp.amount
  }
  for (const [id, need] of Object.entries(wantCrop)) if (cropCount(state, id) < need) return false
  for (const [id, need] of Object.entries(wantGood)) if (goodCount(state, id) < need) return false
  // "Any crop" draws on whatever the named lines have not already claimed.
  const namedTotal = Object.values(wantCrop).reduce((a, b) => a + b, 0)
  if (totalCrops(state) - namedTotal < wantAny) return false

  for (const [id, need] of Object.entries(wantCrop)) takeCrop(state, id, need)
  for (const [id, need] of Object.entries(wantGood)) takeGood(state, id, need)
  if (wantAny) takeAnyCrop(state, data, wantAny)
  state.energy -= recipe.energy
  gainXp(state, data, data.progression.xp.craft)
  milestoneFor(data, 'craft').forEach(m => award(state, m.id))
  if (recipe.days > 0) state.pending.push({ id: recipe.id, daysLeft: recipe.days })
  else deliver(state, data, recipe)
  return true
}

function deliver(state, data, recipe) {
  const out = recipe.output
  if (out.supply) state.supplies[out.supply] += out.amount
  else addGood(state, out.good, out.amount)
}

/* -------------------------------------------------------------- day tick */

/**
 * Advance one day: grow every planted tile, settle the animals, finish curing
 * recipes, then roll tomorrow's weather. Returns a report for the UI.
 */
export function endDay(state, data, rng = Math.random) {
  const r = data.rules
  const report = { grown: 0, died: 0, pests: 0, produced: {}, lost: {}, crafted: [], spoiled: {},
                   rain: false, finished: false, levelUp: null, newWeek: false, seasonEnded: null }

  for (const plot of state.plots) {
    if (!plot.cropId) continue
    const crop = cropById(data, plot.cropId)
    // A crop the rule book no longer has cannot be grown. `reconcile` empties
    // such a field before it is ever played, and this is the belt to that
    // brace: a farm that reaches the night in that state stops growing, which
    // the player can see and recover from, rather than throwing, which used to
    // end the game for good.
    if (!crop) continue
    const pest = pestOf(crop, r)

    for (const tile of plot.tiles) {
      if (tile.stage <= 0 || tile.stage >= r.stage.dead) continue

      // A tick of growth: water first, then fertiliser can buy a second one.
      const tick = () => {
        tile.age++
        if (tile.age >= crop.daysPerStage) { tile.age = 0; tile.stage++; report.grown++ }
      }
      if (tile.watered) { tile.watered = 0; tick() }
      if (tile.fertilized >= 1 && tile.fertilized <= r.fertilizer.maxSafe) {
        tile.fertilized = 0
        for (let i = 0; i < r.fertilizer.growthTicks; i++) tick()
      } else if (tile.fertilized > r.fertilizer.maxSafe) {
        tile.fertilized = 0; tile.stage = r.stage.dead; report.died++; continue
      }
      if (tile.stage > r.stage.ripe) tile.stage = r.stage.ripe

      if (tile.pest > 0 && rng() < pest.deathChance) { tile.pest = 0; tile.stage = r.stage.dead; report.died++; continue }
      if (tile.stage === pest.spawnStage && rng() < pest.spawnChance) { tile.pest = 1; report.pests++ }
    }
    releaseIfBare(plot, r)
  }

  // Looking after the whole flock is worth something, once a day — once for the
  // flock, not once per kind of animal. Paying per species made keeping one of
  // everything an experience multiplier rather than a choice about farming, and
  // a full yard out-earned the fields it was supposed to sit beside.
  const kept = data.animals.filter(a => state.animals[a.id] > 0)
  const allFed = kept.length > 0 && kept.every(a => state.fed[a.id] >= state.animals[a.id])
  if (allFed) report.levelUp = gainXp(state, data, data.progression.xp.feedAll) ?? report.levelUp

  for (const a of data.animals) {
    const have = state.animals[a.id]
    if (!have) continue
    if (state.fed[a.id] < 1) {
      if (rng() < a.starveChance) { state.animals[a.id]--; report.lost[a.id] = (report.lost[a.id] || 0) + 1 }
    } else {
      const made = Math.min(state.fed[a.id], have)
      addGood(state, a.produces, made)
      report.produced[a.produces] = made
    }
    state.fed[a.id] = 0
  }

  state.pending = state.pending.filter(job => {
    if (--job.daysLeft > 0) return true
    const recipe = byId(data.recipes, job.id)
    if (recipe) { deliver(state, data, recipe); report.crafted.push(recipe.name) }
    return false
  })

  // A barn holds so much comfortably; only what spills over that goes bad, so a
  // full store is safe and hoarding for one perfect week is not.
  const cap = farmLimits(state, data).barnSoftCap
  if (Number.isFinite(cap)) {
    for (const [id, held] of Object.entries(state.barn.crops)) {
      if (held <= cap) continue
      const lost = Math.ceil((held - cap) * r.barn.spoilRate)
      state.barn.crops[id] = held - lost
      report.spoiled[id] = lost
    }
  }

  state.day++

  // A new week brings a new board of orders. The farm is never reset.
  if (refreshMarket(state, data, unlockedCropIds(data, levelOf(state, data)), rng)) report.newWeek = true

  // Seasons are a scoreboard, not an ending: the farm carries straight on.
  const seasonLength = r.market?.seasonLength
  if (seasonLength && (state.day - 1) % seasonLength === 0) {
    // `best` is the mark to beat, so it is read before this season updates it.
    report.seasonEnded = { earned: state.seasonEarned ?? 0, best: state.bestSeason ?? 0 }
    for (const m of milestoneFor(data, 'season')) {
      if ((state.seasonEarned ?? 0) >= m.earned) award(state, m.id)
    }
    state.bestSeason = Math.max(state.bestSeason ?? 0, state.seasonEarned ?? 0)
    state.seasonEarned = 0
  }

  // A side game must never strand the player with nothing to do.
  rescueIfStuck(state, data, report)

  // `endDay: null` means the farm just keeps going — the mini-game is meant to
  // be dropped into a bigger game and played indefinitely.
  if (r.endDay && state.day >= r.endDay) { report.finished = true; return report }

  state.energy = farmLimits(state, data).energy
  state.raining = rng() < r.rain.chance
  report.rain = state.raining
  // Rain waters the whole farm for free — the only way to skip a day of hauling
  // water. Only what is actually growing, though: marking bare earth and dead
  // plants as watered changed the farm without changing anything about it, which
  // made a quiet night look busy to anything asking whether the night mattered.
  for (const plot of state.plots) {
    for (const tile of plot.tiles) {
      const alive = tile.stage > 0 && tile.stage < r.stage.dead
      tile.watered = alive && state.raining ? 1 : 0
    }
  }
  return report
}

/**
 * If the farm has no money, no seeds, nothing growing and nothing to sell, hand
 * back a single cheap seed. Only ever in that exact corner — it is a floor, not
 * an allowance.
 */
export function needsRescue(state, data) {
  const rule = data.rules.rescue
  if (!rule) return false
  const cheapest = Math.min(...availableCrops(state, data).map(c => c.seedPrice))
  const holdsSeeds = Object.values(state.seeds).some(n => n > 0)
  const growing = state.plots.some(p => p.cropId)
  const hasStock = totalCrops(state) > 0 || Object.values(state.barn.goods).some(n => n > 0)
  return !(state.money >= cheapest || holdsSeeds || growing || hasStock)
}

function rescueIfStuck(state, data, report) {
  const rule = data.rules.rescue
  if (!needsRescue(state, data)) return
  // The seed is a loan, not a gift. Emptying the barn on purpose to claim it
  // just moves the cost to the next sale, so there is nothing to farm.
  //
  // The rule book names which seed to give back, and a rule book can be edited.
  // Of everything that could break when somebody removes a crop, the promise
  // that the game never becomes unplayable is the last one that should — so a
  // missing name falls back to the cheapest seed the farm could actually plant,
  // and a rule book with no crops in it at all simply has nothing to give.
  const named = cropById(data, rule?.cropId)
  const seed = named ?? availableCrops(state, data).reduce(
    (best, c) => (best == null || c.seedPrice < best.seedPrice ? c : best), null)
  if (!seed) return
  state.seeds[seed.id] = (state.seeds[seed.id] ?? 0) + 1
  state.debt = (state.debt ?? 0) + seed.seedPrice
  report.rescued = seed.id
}

/** Take repayment off the top of any sale, before the money is the player's. */
function settleDebt(state, amount) {
  const owed = state.debt ?? 0
  if (owed <= 0) return { paid: 0, kept: amount }
  const paid = Math.min(owed, amount)
  state.debt = owed - paid
  return { paid, kept: amount - paid }
}

/**
 * Will ending the day actually move the farm on, other than turning the market
 * over?
 *
 * A server needs this to tell a real quiet day from someone spinning the
 * calendar to shop for a market board they like. A timer cannot: waiting is
 * free, so a cooldown is friction rather than a rule. Rain pre-waters the
 * fields, so a genuine rainy day passes here with no clicks at all, while an
 * abandoned farm does not.
 */
export function willAdvanceSimulation(state, data) {
  const r = data.rules

  // A run with an ending is a run where the calendar itself is the resource.
  // Refusing a quiet day there could stop a player reaching the ending they were
  // promised, and spinning it only costs them their own remaining days.
  if (r.endDay) return true

  for (const plot of state.plots) {
    if (!plot.cropId) continue
    for (const tile of plot.tiles) {
      // Anything alive in the ground makes the night matter. It may be watered
      // and grow, it may be rained on for nothing, it may be found by pests, and
      // if it is already bitten it may not be there in the morning. Asking only
      // about water left every one of those consequences unreachable, because
      // the day they happen on could not be ended.
      if (tile.stage > 0 && tile.stage < r.stage.dead) return true
    }
  }

  // An animal that has not eaten may not be there in the morning. If the night
  // can take one, the night is not nothing — and refusing it would make
  // starvation a rule that could never actually happen.
  const hungry = data.animals.some(a => (state.animals?.[a.id] ?? 0) > 0 && !(state.fed?.[a.id] > 0))
  if (hungry) return true
  if (Object.values(state.fed ?? {}).some(n => n > 0)) return true

  if ((state.pending ?? []).length > 0) return true

  // Surplus above what the barn holds comfortably goes bad overnight, a quarter
  // at a time. While there is surplus, every night takes some.
  const cap = farmLimits(state, data).barnSoftCap
  if (Number.isFinite(cap) && Object.values(state.barn?.crops ?? {}).some(n => n > cap)) return true

  // A farm with no money, no seeds, nothing growing and nothing in the barn is
  // owed a seed on loan — and that IS something the night changes. Without this
  // the gate and the rescue contradict each other: the player cannot end the day
  // because nothing would happen, and the thing that would happen is the rescue.
  // Offline it never showed, because only the server asks this question.
  if (needsRescue(state, data)) return true

  return false
}

/** Travel between the farm and the village; the only place the original charged energy up front. */
export function travel(state, data) {
  const cost = data.rules.travelEnergy
  if (state.energy <= cost) return false
  state.energy -= cost
  return true
}

/**
 * Is this rule book internally consistent?
 *
 * Every id in `game.json` that points at another id is a reference nobody
 * checks at runtime. An animal is fed a supply, produces a good; a recipe eats
 * crops and goods and yields a supply or a good; a tool consumes a supply; the
 * rescue loan hands back a named crop. Rename or remove one end of any of those
 * and the game keeps starting — the break only arrives later, in the night, on
 * somebody's farm, as a crash with no way back.
 *
 * `reconcile` cannot help here: that is for a save disagreeing with the rule
 * book, and this is the rule book disagreeing with itself. So it is checked
 * where it can still be cheap — by the suite, and by the server before it
 * agrees to serve anything.
 *
 * Returns a list of plain sentences, empty when the book hangs together.
 */
/**
 * What a rule book actually contains, for the screens to ask before they offer
 * it.
 *
 * The game grew three systems the original did not have — a workshop, a market
 * board, and levels to unlock things at — and all three are data. Take the data
 * away and the code would still show the door: a house that opens an empty
 * workshop, a MARKET button onto a board with nothing on it, a plaque counting
 * towards a level that grants nothing. So the screens ask here instead of
 * assuming, and a rule book with none of it is simply a game without it rather
 * than a game with three dead ends.
 *
 * Everything is derived rather than declared. A flag saying "no workshop" could
 * disagree with a list of recipes; a list of recipes cannot disagree with
 * itself.
 */
export function has(data) {
  const prog = data.progression ?? {}
  const animals = (data.animals ?? []).length > 0

  // Every way a level can matter, and all of them need experience to be
  // gainable at all — a farm that can never earn a point has a level, it just
  // has the same one for ever.
  const canEarn = Object.entries(prog.xp ?? {})
    .some(([key, value]) => !key.startsWith('_') && value > 0)
  // Something waiting on a level to arrive.
  const gated = [...(data.crops ?? []), ...(data.animals ?? [])].some(x => (x.unlockLevel ?? 1) > 1)
  // A reward listed against one. `when` matters: a first-harvest milestone is
  // not a reason to show a level, and counting every milestone put a plaque on
  // screen for a farm that had nothing to level towards.
  const rewarded = (data.milestones ?? []).some(m => m?.when === 'level')
    || (prog.milestoneEvery ?? 0) > 0
  // A farm that grows with it. `every` is how often, not what for, and
  // `barnSoftCapMax` is a ceiling on one of the others — neither is a thing the
  // player gets, so a rule book granting nothing but those grants nothing.
  //
  // The spelling is `grants`, which is what the rule book and `farmLimits` both
  // use. Reading `grant` here meant this never saw the real ones: a rule book
  // could be reported as having no levels while the farm quietly went on
  // growing every four of them.
  const BOOKKEEPING = new Set(['every', 'barnSoftCapMax'])
  const grows = Object.entries(prog.grants ?? {}).some(([key, value]) => {
    if (key.startsWith('_') || BOOKKEEPING.has(key)) return false
    if (key === 'animalMax' && !animals) return false     // room for a herd that cannot exist
    return Number.isFinite(value) && value !== 0
  }) && (prog.grants?.every ?? 0) > 0

  return {
    workshop: (data.recipes ?? []).length > 0,
    market: (data.rules?.market?.orderCount ?? 0) > 0,
    // A rule book with nothing to keep is a farm that only grows things — which
    // is a game somebody might well want, and was leaving a door onto an empty
    // coop, a tab selling nothing, and a line counting a herd that cannot exist.
    animals,
    levels: canEarn && (gated || rewarded || grows),
  }
}

/**
 * The moments a milestone can wait for.
 *
 * Four of them are handed to `milestoneFor` when they happen; `level` is
 * decided in `gainXp` instead, because it is the only one that is a threshold
 * rather than an event. Nothing else awards anything, so nothing else is a
 * milestone anybody could earn.
 */
export const MILESTONE_EVENTS = ['harvest', 'craft', 'animal', 'season', 'level']

export function checkData(data) {
  const problems = []

  // Shapes first, because everything below walks these. Checking afterwards
  // meant a rule book with `crops: {}` threw on the way to the check that would
  // have reported it — so the server fell over instead of refusing the book and
  // saying which part of it was wrong.
  for (const list of ['crops', 'goods', 'supplies', 'animals', 'tools', 'recipes', 'milestones']) {
    if (data[list] != null && !Array.isArray(data[list])) {
      problems.push(`${list} is not a list`)
      data = { ...data, [list]: [] }
    }
  }
  if (data.rules == null || typeof data.rules !== 'object') {
    problems.push('the rule book has no rules in it')
    return problems
  }
  const has = (list, id) => byId(data[list] ?? [], id) != null
  const ONE = { crops: 'crop', goods: 'good', supplies: 'supply', animals: 'animal', recipes: 'recipe', tools: 'tool' }
  const ref = (where, list, id) => {
    if (id == null) return
    if (!has(list, id)) problems.push(`${where} refers to ${ONE[list]} "${id}", which does not exist`)
  }

  for (const a of data.animals ?? []) {
    ref(`animal "${a.id}" feed`, 'supplies', a.feed)
    ref(`animal "${a.id}" produces`, 'goods', a.produces)
  }
  for (const tool of data.tools ?? []) ref(`tool "${tool.id}" consumes`, 'supplies', tool.consumes)
  for (const r of data.recipes ?? []) {
    for (const i of r.inputs ?? []) {
      ref(`recipe "${r.id}" input`, 'crops', i.crop)
      ref(`recipe "${r.id}" input`, 'goods', i.good)
    }
    ref(`recipe "${r.id}" output`, 'supplies', r.output?.supply)
    ref(`recipe "${r.id}" output`, 'goods', r.output?.good)
    if (r.output?.supply == null && r.output?.good == null) problems.push(`recipe "${r.id}" makes nothing`)
  }
  ref('the rescue loan', 'crops', data.rules?.rescue?.cropId)

  // The farm's shape has to be a shape. A rule book with no fields, no tiles or
  // no crops is not a harder game, it is one nobody can play.
  const r = data.rules ?? {}
  if (r.plots !== BUILT_FOR.plots) {
    problems.push(`the rule book gives out ${r.plots} fields, and this build has screens for ${BUILT_FOR.plots}`)
  }
  if (r.tilesPerPlot !== BUILT_FOR.tilesPerPlot) {
    problems.push(`a field here holds ${r.tilesPerPlot} tiles, and this build has places to draw ${BUILT_FOR.tilesPerPlot}`)
  }
  if (!(data.crops ?? []).length) problems.push('there is nothing to grow')

  // Ids are how everything here refers to everything else, so two things
  // sharing one means every reference to it is a coin toss, and a blank one
  // cannot be referred to at all.
  for (const list of ['crops', 'goods', 'supplies', 'animals', 'tools', 'recipes', 'milestones']) {
    const seen = new Set()
    for (const item of data[list] ?? []) {
      const id = item?.id
      if (typeof id !== 'string' || !id.trim()) { problems.push(`something in ${list} has no id`); continue }
      if (seen.has(id)) problems.push(`${list} has two things called "${id}"`)
      seen.add(id)
    }
  }

  // Everything the player is shown has to have something to show. A missing
  // name reaches the screen as "undefined" in whichever language they chose.
  for (const list of ['crops', 'goods', 'supplies', 'animals', 'tools', 'recipes']) {
    for (const item of data[list] ?? []) {
      for (const lang of ['en', 'th']) {
        if (!String(item?.name?.[lang] ?? '').trim()) {
          problems.push(`${list.replace(/s$/, '')} "${item?.id}" has no ${lang} name`)
        }
      }
    }
  }
  for (const c of data.crops ?? []) if (!c.art) problems.push(`crop "${c.id}" has no art`)
  for (const a of data.animals ?? []) if (!a.art && !a.image) problems.push(`animal "${a.id}" has nothing to draw`)

  // The field screen is built around these five and nothing else: the tool
  // switch, the whole-field buttons, the toolbar art and the number keys all
  // name them. A rule book without one of them leaves a gap nothing fills.
  for (const id of ['harvest', 'water', 'fertilize', 'spray', 'clear']) {
    if (!has('tools', id)) problems.push(`there is no "${id}" tool, and the field screen is built around one`)
  }

  for (const key of ['title', 'shopName']) {
    if (!String(data.meta?.[key] ?? '').trim()) problems.push(`the game has no ${key}`)
  }

  // The numbers the night reads on every tile, every animal and every barn. A
  // rule book without them starts a server perfectly well and then fails every
  // single night — each one now failing cleanly and changing nothing, which
  // means a farm that simply cannot be played rather than one that breaks
  // loudly. Better to refuse the book.
  const NEEDED = {
    stage: ['seed', 'ripe', 'dead', 'empty'],
    pest: ['spawnStage', 'spawnChance', 'deathChance'],
    fertilizer: ['maxSafe', 'growthTicks'],
    rain: ['chance'],
    market: ['weekLength', 'seasonLength', 'orderCount', 'orderQuota', 'orderMultiplier'],
    barn: ['softCap', 'spoilRate'],
  }
  for (const [group, keys] of Object.entries(NEEDED)) {
    if (r[group] == null || typeof r[group] !== 'object') {
      problems.push(`the rule book has no ${group} rules, and every night reads them`)
      continue
    }
    for (const key of keys) {
      if (!Number.isFinite(r[group][key])) problems.push(`rules.${group}.${key} is ${r[group][key]}, which is not a number`)
    }
  }
  // A week is divided by and taken a modulo of, every time the board is asked
  // what week it is. At zero that is Infinity and then NaN, and the farm stops
  // being describable; below zero the calendar runs backwards. Being a number
  // is not enough for this one.
  //
  // seasonLength is deliberately not here: the night reads it as `if
  // (seasonLength && ...)`, so zero turns seasons off, which is a rule book
  // making a choice rather than a rule book that cannot work.
  if (Number.isFinite(r.market?.weekLength) && !(Number.isSafeInteger(r.market.weekLength) && r.market.weekLength > 0)) {
    problems.push(`a market week is ${r.market.weekLength} days long, and the board divides by it`)
  }
  if (!Array.isArray(r.market?.tiers) || !r.market.tiers.length) {
    problems.push('the market has no price tiers, so nothing can be quoted')
  } else {
    // Every sale walks these. A tier without a multiplier hands back NaN, and
    // NaN money spreads through the wallet, the barn and the save while every
    // other check here stays green.
    let last = 0
    r.market.tiers.forEach((tier, i) => {
      if (!Number.isFinite(tier?.multiplier) || tier.multiplier < 0) {
        problems.push(`market tier ${i + 1} pays ${tier?.multiplier}, which is not a price`)
      }
      if (tier?.upTo == null) return
      if (!Number.isSafeInteger(tier.upTo) || tier.upTo <= last) {
        problems.push(`market tier ${i + 1} runs up to ${tier.upTo}, which is not past the tier before it`)
      }
      last = tier.upTo
    })
    if (r.market.tiers.at(-1)?.upTo != null) problems.push('the last market tier has to be the one with no ceiling')
  }

  // The numbers on the things themselves. Presence is not enough: a price that
  // is a string, a chance above one or a count with a fraction in it all reach
  // the player as something that looks like a bug in the game rather than in
  // the file somebody edited.
  const whole = (v) => Number.isSafeInteger(v) && v >= 0
  const chance = (v) => Number.isFinite(v) && v >= 0 && v <= 1
  const check = (list, id, field, value, test, what) => {
    if (!test(value)) problems.push(`${list} "${id}" has ${field} ${value}, which is not ${what}`)
  }
  for (const c of data.crops ?? []) {
    check('crop', c.id, 'a seed price', c.seedPrice, whole, 'a price')
    check('crop', c.id, 'a sale price', c.sellPrice, whole, 'a price')
    check('crop', c.id, 'days per stage', c.daysPerStage, (v) => whole(v) && v > 0, 'a number of days')
    check('crop', c.id, 'harvests', c.harvests, (v) => whole(v) && v > 0, 'a number of pickings')
    if (c.unlockLevel != null) check('crop', c.id, 'an unlock level', c.unlockLevel, (v) => whole(v) && v > 0, 'a level')
    if (c.unlockLevel > MAX_LEVEL) problems.push(`crop "${c.id}" unlocks at level ${c.unlockLevel}, and the farm stops at ${MAX_LEVEL}`)
    if (c.pest?.spawnChance != null) check('crop', c.id, 'a pest chance', c.pest.spawnChance, chance, 'a chance between none and certain')
  }
  for (const g of data.goods ?? []) check('good', g.id, 'a price', g.price, (v) => whole(v) && v > 0, 'a price worth selling for')
  for (const it of data.supplies ?? []) {
    check('supply', it.id, 'a price', it.price, whole, 'a price')
    check('supply', it.id, 'an amount', it.amount, (v) => whole(v) && v > 0, 'an amount')
  }
  for (const a of data.animals ?? []) {
    check('animal', a.id, 'a price', a.price, whole, 'a price')
    check('animal', a.id, 'a maximum', a.max, (v) => whole(v) && v > 0, 'a number to keep')
    check('animal', a.id, 'a starving chance', a.starveChance, chance, 'a chance between none and certain')
    if (a.unlockLevel != null) check('animal', a.id, 'an unlock level', a.unlockLevel, (v) => whole(v) && v > 0, 'a level')
    if (a.unlockLevel > MAX_LEVEL) problems.push(`animal "${a.id}" unlocks at level ${a.unlockLevel}, and the farm stops at ${MAX_LEVEL}`)
  }
  for (const tool of data.tools ?? []) check('tool', tool.id, 'an energy cost', tool.energy, whole, 'a cost')
  for (const rec of data.recipes ?? []) {
    check('recipe', rec.id, 'an energy cost', rec.energy, whole, 'a cost')
    check('recipe', rec.id, 'a curing time', rec.days, whole, 'a number of days')
    check('recipe', rec.id, 'an output amount', rec.output?.amount, (v) => whole(v) && v > 0, 'an amount')
    for (const i of rec.inputs ?? []) {
      const n = i.amount ?? i.anyCrop
      if (!(whole(n) && n > 0)) problems.push(`recipe "${rec.id}" asks for ${n} of something, which is not an amount`)
    }
  }
  if (!chance(r.pest?.spawnChance) || !chance(r.pest?.deathChance) || !chance(r.rain?.chance)) {
    problems.push('a chance in the rule book is not between none and certain')
  }
  if (!chance(r.barn?.spoilRate)) problems.push('the spoil rate is not a share of the surplus')

  // Sound is a set of keyed protocols, and every one of them is a place a typo
  // goes unheard rather than unhandled. A tool cue for a tool that does not
  // exist is simply never played; a cue naming a sound that is not loaded is
  // silence where a sound should be; and music for a place nobody visits is a
  // file downloaded for nothing. `toolCue.hoe` sat here long after the tool was
  // renamed to `clear`, doing nothing, and nothing said so.
  // Content nothing can ever hand over.
  //
  // Audited from the emitting side rather than guessed at: a good reaches the
  // barn in exactly two places — a recipe's output and an animal's produce —
  // and a supply in exactly two — the shop and a recipe's output. A thing named
  // by neither of its two is a thing the rule book describes, prices, draws and
  // can never give anybody. That is not a game being hard; it is a book that
  // cannot do what it says.
  const madeByRecipe = new Set((data.recipes ?? []).map(r => r.output?.good).filter(Boolean))
  const laidByAnimal = new Set((data.animals ?? []).map(a => a.produces).filter(Boolean))
  for (const g of data.goods ?? []) {
    if (g?.id && !madeByRecipe.has(g.id) && !laidByAnimal.has(g.id)) {
      problems.push(`nothing produces "${g.id}", so no farm could ever hold one`)
    }
  }
  // Supplies need no equivalent: every one of them must carry a price, which is
  // checked below, so every supply is buyable and none can be stranded.

  const audio = data.audio ?? {}
  const sounds = new Set(audio.sfx ?? [])
  for (const [toolId, cue] of Object.entries(audio.toolCue ?? {})) {
    if (!has('tools', toolId)) problems.push(`there is a sound for using "${toolId}", and no such tool`)
    if (!sounds.has(cue)) problems.push(`using "${toolId}" plays "${cue}", which is not one of the sounds`)
  }
  // Every animal makes its own noise when it is fed, and the scene builds that
  // cue's name from the animal's id rather than writing it out — so nothing
  // that reads the source can see it. A book that renames an animal, or adds
  // one, loses its sound with no error and no warning anywhere. This is the
  // only place that can tell.
  for (const a of data.animals ?? []) {
    if (!a?.id) continue
    if (!sounds.has(`animal-${a.id}`)) {
      problems.push(`feeding "${a.id}" plays "animal-${a.id}", which is not one of the sounds`)
    }
  }
  // Music is loaded alongside the effects rather than listed among them, so the
  // only thing to check here is that a place names something at all — whether
  // the file is there is a question about the folder, and `reach` asks it.
  for (const [place, name] of Object.entries(audio.music ?? {})) {
    if (typeof name !== 'string' || !name.trim()) problems.push(`the music for ${place} names nothing`)
  }
  for (const [key, value] of Object.entries(audio.volume ?? {})) {
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
      problems.push(`the ${key} volume is ${value}, which is not a level between silent and full`)
    }
  }

  // A recipe input is one of three things and an output one of two, and saying
  // two of them or none of them is a recipe that quietly takes or makes the
  // wrong thing rather than one that fails.
  for (const r of data.recipes ?? []) {
    for (const i of r.inputs ?? []) {
      const named = ['crop', 'good', 'anyCrop'].filter(k => i?.[k] != null)
      if (named.length !== 1) {
        problems.push(`recipe "${r.id}" has an ingredient naming ${named.length === 0 ? 'nothing' : named.join(' and ')}`)
      }
    }
    const makes = ['supply', 'good'].filter(k => r.output?.[k] != null)
    if (makes.length !== 1) {
      problems.push(`recipe "${r.id}" makes ${makes.length === 0 ? 'nothing' : makes.join(' and ')}`)
    }
  }

  // How a farm grows. Reached on every level-up and every screen that says what
  // the next one brings, and never checked until now.
  const prog = data.progression ?? {}
  if (!Number.isFinite(prog.thresholdFactor) || prog.thresholdFactor <= 0) {
    problems.push(`experience is scaled by ${prog.thresholdFactor}, which is not a number to multiply by`)
  }
  // Zero is how a rule book says it does not want them, and the rule that hands
  // them out already reads it that way. Refusing it here meant a book that had
  // switched them off was refused for switching them off.
  if (prog.milestoneEvery != null && !(Number.isSafeInteger(prog.milestoneEvery) && prog.milestoneEvery >= 0)) {
    problems.push(`a milestone every ${prog.milestoneEvery} levels is not a number of levels`)
  }
  // A key beginning with an underscore is a note to whoever edits the file, the
  // convention this whole rule book uses to explain itself. Not a setting.
  // One spelling. Accepting both is what hid the split: the rule book says
  // `grants`, `farmLimits` reads `grants`, and a check that quietly took either
  // meant the one place spelling it `grant` was never contradicted by anything.
  for (const [key, value] of Object.entries(prog.grants ?? {})) {
    if (key.startsWith('_')) continue
    if (!Number.isFinite(value)) problems.push(`levelling grants ${value} of ${key}, which is not a number`)
  }
  for (const m of data.milestones ?? []) {
    if (m?.when === 'level' && !(Number.isSafeInteger(m.level) && m.level > 0)) {
      problems.push(`milestone "${m?.id}" waits for level ${m?.level}, which is not a level`)
    }
    // A milestone waits for one of the five things the game announces, and a
    // book naming a sixth gets a reward nothing can ever hand over: it is not
    // refused, it is not shown, it simply never happens. Every other dangling
    // reference in here is caught — a crop that is not a crop, a supply that is
    // not a supply — and this one was not.
    if (m != null && !MILESTONE_EVENTS.includes(m.when)) {
      problems.push(`milestone "${m?.id}" waits for "${m?.when}", which is not something that happens`)
    }
  }
  for (const key of ['startMoney', 'startEnergy', 'startDay', 'travelEnergy', 'feedEnergy']) {
    if (!Number.isFinite(r[key])) problems.push(`rules.${key} is ${r[key]}, which is not a number`)
  }
  // Stages are read as an order, not just as numbers: a seed grows towards ripe,
  // dying stops it, and bare earth is past the end of all of it.
  if (Number.isFinite(r.stage?.seed) && Number.isFinite(r.stage?.ripe) && Number.isFinite(r.stage?.dead)
    && Number.isFinite(r.stage?.empty)) {
    if (!(r.stage.seed < r.stage.ripe && r.stage.ripe < r.stage.dead && r.stage.dead < r.stage.empty)) {
      problems.push('the stages are out of order: a seed must come before ripe, ripe before dead, and bare earth after all of it')
    }
  }
  // Something has to be plantable on the first day, or a new farm is stuck the
  // moment it starts.
  if ((data.crops ?? []).length && !(data.crops ?? []).some(c => (c.unlockLevel ?? 1) <= 1)) {
    problems.push('no crop can be grown at level one, so a new farm can never start')
  }
  return problems
}
