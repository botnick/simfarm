// Pure game rules. No Phaser, no DOM, and no randomness of its own: every roll
// goes through the injected `rng`, so a day can be replayed and tested.
// Every number lives in public/data/game.json — nothing about crops, prices,
// animals or recipes is written here.

import { newMarket, quote, recordSale, refreshMarket, nextUnitPrice } from './market.js'
import { levelFor, unlockedCropIds } from './progression.js'

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

export function newGame(data, { name = '' } = {}) {
  const r = data.rules
  const state = {
    name,
    day: r.startDay,
    money: r.startMoney,
    energy: r.startEnergy,
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
  state.market = newMarket(data, unlockedCropIds(data, 1), state.day)
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
  const seed = cropById(data, rule.cropId)
  state.seeds[rule.cropId] = (state.seeds[rule.cropId] ?? 0) + 1
  state.debt = (state.debt ?? 0) + seed.seedPrice
  report.rescued = rule.cropId
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
