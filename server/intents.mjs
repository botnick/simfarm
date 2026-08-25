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

const snapshot = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

/**
 * Apply one intent, all of it or none of it.
 *
 * The rules work on the farm in place, and a night does a great deal of work:
 * it grows every tile, feeds every animal, finishes what is curing, spoils the
 * surplus and turns the week over. An unexpected fault halfway through that
 * used to leave the farm half-advanced at the revision it started on — the
 * client would be told the request failed, ask again from the same revision,
 * and the night would run a second time over a farm that had already had half
 * of one. Nothing is known to throw there any more, which is exactly when a
 * half-applied change is hardest to notice.
 *
 * So the farm is copied first and the copy is what gets worked on; it is put
 * back only if the whole thing succeeded. The random source is counted rather
 * than stored, so rewinding it is a matter of putting the counter back — and it
 * has to be rewound, or a retried night would draw different weather from the
 * same revision.
 *
 * Measured at about 28µs for a farm with every field full and a stocked barn,
 * against an HTTP round trip and an HMAC. The copy is not the expensive part of
 * answering a request.
 *
 * `endDay` is handled separately because it is the only one that consumes
 * randomness and returns a report.
 */
export function applyIntent(session, data, intent) {
  const handler = intent?.type === 'endDay' ? null : HANDLERS[intent?.type]
  if (intent?.type !== 'endDay' && !handler) return { ok: false, error: 'unknown intent' }

  const working = snapshot(session.state)
  const rngAt = session.rng.counter()
  let result
  try {
    if (intent.type === 'endDay') {
      result = { ok: true, report: rules.endDay(working, data, session.rng) }
    } else {
      const changed = handler(working, data, intent)
      result = { ok: !!changed, error: changed ? undefined : 'refused' }
    }
  } catch (err) {
    // The farm was never touched: everything above happened to the copy. Only
    // the random counter lives outside it, so that is the one thing to rewind.
    session.rng.restore(rngAt)
    throw err
  }
  // A refusal is not a change either. Handlers are written to test before they
  // touch anything, but keeping the copy on a refusal costs nothing and means a
  // handler that gives up halfway cannot leave a mark.
  if (!result.ok) {
    session.rng.restore(rngAt)
    return result
  }
  // Handed back rather than installed. Accepting an intent is not only a matter
  // of the farm changing: the revision has to be written where a restart can
  // still see it, and that write can fail. Committing here left the caller with
  // a farm already advanced and no way to take it back, so the farm, the
  // revision and the marks left by the night are all installed together, by the
  // caller, once the part that can fail has not.
  // A number, not a closure. The accepted response is copied into the retry
  // cache, and a copy is made with `structuredClone` — which cannot clone a
  // function and throws rather than skipping it, so a rewind handed back this
  // way turned every accepted intent into a fault.
  return { ...result, state: working, rngAt }
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
