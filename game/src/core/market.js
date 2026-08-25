// The market. In a game that never ends, a fixed price per crop means the best
// crop is simply the best crop forever and choosing what to plant stops being a
// decision. Two forces fix that without punishing anyone:
//
//   saturation — selling the same crop again and again in one week floods it,
//                and the price falls in tiers;
//   orders     — each week asks for three specific crops at a premium.
//
// Processed goods are deliberately exempt: turning a glut into jam is the way
// out of a flooded market, and that only works if the jam price holds.
import { cropById } from './rules.js'

export const weekOf = (day, rules) => Math.floor((day - 1) / rules.market.weekLength)

/** A fresh board of orders for the week, never asking twice for the same crop. */
export function rollOrders(data, unlockedIds, rng = Math.random) {
  const m = data.rules.market
  const pool = [...unlockedIds]
  const orders = []
  while (orders.length < m.orderCount && pool.length) {
    // A random source that can return exactly 1 would index past the end, so
    // the draw is clamped rather than trusted.
    const roll = Math.min(Math.max(rng(), 0), 0.999999999)
    const [cropId] = pool.splice(Math.floor(roll * pool.length), 1)
    orders.push({ cropId, quota: m.orderQuota, filled: 0 })
  }
  return orders
}

export function newMarket(data, unlockedIds, day = 1, rng = Math.random) {
  return { week: weekOf(day, data.rules), sold: {}, orders: rollOrders(data, unlockedIds, rng) }
}

/** Start a new board when the week turns; the farm itself is never reset. */
export function refreshMarket(state, data, unlockedIds, rng = Math.random) {
  const week = weekOf(state.day, data.rules)
  if (state.market && state.market.week === week) return false
  state.market = { week, sold: {}, orders: rollOrders(data, unlockedIds, rng) }
  return true
}

const tierFor = (sold, tiers) => tiers.find(t => t.upTo == null || sold < t.upTo) ?? tiers[tiers.length - 1]

/** The order for a crop that still wants units, if there is one. */
export const openOrder = (state, cropId) =>
  state.market?.orders?.find(o => o.cropId === cropId && o.filled < o.quota) ?? null

/**
 * What `count` units fetch right now, unit by unit, so a sale that crosses a
 * tier boundary or finishes an order is priced honestly rather than averaged.
 * Returns the total and a breakdown the UI can explain to the player.
 */
export function quote(state, data, cropId, count) {
  const crop = cropById(data, cropId)
  if (!crop || count <= 0) return { total: 0, orderUnits: 0, unitPrices: [] }
  const m = data.rules.market
  const order = openOrder(state, cropId)
  let orderLeft = order ? order.quota - order.filled : 0
  let sold = state.market?.sold?.[cropId] ?? 0

  let total = 0, orderUnits = 0
  const unitPrices = []
  for (let i = 0; i < count; i++) {
    let price
    if (orderLeft > 0) { price = Math.round(crop.sellPrice * m.orderMultiplier); orderLeft--; orderUnits++ }
    else { price = Math.round(crop.sellPrice * tierFor(sold, m.tiers).multiplier); sold++ }
    unitPrices.push(price)
    total += price
  }
  return { total, orderUnits, unitPrices }
}

/** The price the next single unit would fetch — what the shop row shows. */
export const nextUnitPrice = (state, data, cropId) => quote(state, data, cropId, 1).total

/** Record a completed sale against the week's board. Returns orders finished. */
export function recordSale(state, data, cropId, count) {
  const m = data.rules.market
  const order = openOrder(state, cropId)
  let completed = 0
  let left = count
  if (order) {
    const toOrder = Math.min(left, order.quota - order.filled)
    order.filled += toOrder
    left -= toOrder
    if (order.filled >= order.quota) completed++
  }
  state.market.sold[cropId] = (state.market.sold[cropId] ?? 0) + left
  return completed
}

/**
 * How flooded a crop is right now, for a screen that wants to explain the
 * price rather than just quote it. `tier` is the index into `rules.market.tiers`
 * and `toNext` is how many more units this week would push it into the next one
 * (null once it is in the last tier and cannot fall further).
 */
export function saturation(state, data, cropId) {
  const tiers = data.rules.market.tiers
  const sold = state.market?.sold?.[cropId] ?? 0
  const tier = tiers.findIndex(t => t.upTo == null || sold < t.upTo)
  const at = tier < 0 ? tiers.length - 1 : tier
  const upTo = tiers[at].upTo
  return { sold, tier: at, tiers: tiers.length, multiplier: tiers[at].multiplier, toNext: upTo == null ? null : upTo - sold }
}

/** Days left before this week's board is replaced. */
export const daysLeftInWeek = (day, rules) => rules.market.weekLength - ((day - 1) % rules.market.weekLength)
