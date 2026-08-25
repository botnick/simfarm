// What a client is allowed to ask for.
//
// The client sends an intent — "plant crop X in field 2" — and never a number.
// Every intent is checked against the server's own copy of the farm by the same
// pure rules the game was always built on, so a tampered client can ask for
// things but cannot make them true.
import * as rules from '../game/src/core/rules.js'

const int = (v) => (Number.isInteger(v) ? v : null)

/** Each handler returns true if the farm changed, or false if the ask was refused. */
const HANDLERS = {
  plant: (s, d, a) => {
    const plot = int(a.plot)
    return plot != null && typeof a.cropId === 'string' && rules.plant(s, d, plot, a.cropId)
  },
  tool: (s, d, a) => {
    const plot = int(a.plot), tile = int(a.tile)
    return plot != null && tile != null && typeof a.toolId === 'string'
      && rules.applyTool(s, d, plot, tile, a.toolId)
  },
  waterPlot: (s, d, a) => int(a.plot) != null && rules.waterPlot(s, d, a.plot) > 0,
  harvestPlot: (s, d, a) => int(a.plot) != null && rules.harvestPlot(s, d, a.plot) > 0,
  clearPlot: (s, d, a) => int(a.plot) != null && rules.clearPlot(s, d, a.plot) > 0,
  buySeed: (s, d, a) => typeof a.cropId === 'string' && rules.buySeed(s, d, a.cropId),
  buySupply: (s, d, a) => typeof a.supplyId === 'string' && rules.buySupply(s, d, a.supplyId),
  buyAnimal: (s, d, a) => typeof a.animalId === 'string' && rules.buyAnimal(s, d, a.animalId),
  // Amounts are clamped to what the barn actually holds, so a client asking to
  // sell a thousand turnips sells only the turnips it has.
  // A sale can legitimately keep no money — the rescue loan is repaid off the
  // top of the next sale — while the sale itself certainly happened: the crop
  // left the barn, the debt shrank, an order advanced, XP was granted. Reading
  // "kept nothing" as "did nothing" hid a real mutation from the revision
  // counter and told the player their click was refused.
  sellCrop: (s, d, a) => {
    const held = rules.cropCount(s, a.cropId)
    const n = Math.min(Math.max(int(a.count) ?? 0, 0), held)
    if (n < 1 || !rules.cropById(d, a.cropId)) return false
    rules.sellCrop(s, d, a.cropId, n)
    return true
  },
  sellGood: (s, d, a) => {
    const held = rules.goodCount(s, a.goodId)
    const n = Math.min(Math.max(int(a.count) ?? 0, 0), held)
    if (n < 1 || !rules.byId(d.goods, a.goodId)) return false
    rules.sellGood(s, d, a.goodId, n)
    return true
  },
  craft: (s, d, a) => typeof a.recipeId === 'string' && rules.craft(s, d, a.recipeId),
  feed: (s, d, a) => typeof a.animalId === 'string' && rules.feedAnimals(s, d, a.animalId) > 0,
  travel: (s, d) => rules.travel(s, d),
}

export const INTENTS = Object.keys(HANDLERS)

/**
 * Apply one intent. `endDay` is handled separately because it is the only one
 * that consumes randomness and returns a report.
 */
export function applyIntent(session, data, intent) {
  if (intent?.type === 'endDay') {
    const report = rules.endDay(session.state, data, session.rng)
    return { ok: true, report }
  }
  const handler = HANDLERS[intent?.type]
  if (!handler) return { ok: false, error: 'unknown intent' }
  const changed = handler(session.state, data, intent)
  return { ok: !!changed, error: changed ? undefined : 'refused' }
}

/**
 * What the client is allowed to see. It is the whole farm — hiding it would not
 * add security, since the client has to draw it — but it is built here so the
 * server decides, and so nothing internal (the rng state, the seed) leaks.
 */
export function view(session, data) {
  const s = session.state
  return {
    day: s.day, money: s.money, energy: s.energy, raining: s.raining,
    xp: s.xp, level: rules.levelOf(s, data),
    name: s.name, seeds: s.seeds, supplies: s.supplies, barn: s.barn,
    animals: s.animals, fed: s.fed, pending: s.pending, plots: s.plots,
    market: s.market, milestones: s.milestones,
    seasonEarned: s.seasonEarned, bestSeason: s.bestSeason, earned: s.earned,
    // What the rescue loan still takes off the top of the next sale. Without
    // this the browser cannot explain why a sale paid nothing.
    debt: s.debt ?? 0,
  }
}
