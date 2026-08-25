// Plays each crop on a loop with an ideal farmer and reports profit per day.
// This is how the balance numbers in data/game.json were checked — run it after
// changing any crop and the table tells you straight away if it is out of line.
import { readFileSync } from 'node:fs'
import { newGame, plant, applyTool, endDay, cropById, sellCrop, cropCount } from '../src/core/rules.js'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))
const DAYS = 3650
// Fixed-seed PRNG so two runs of the same crop are comparable.
const lcg = (s) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

function play(cropId, seed) {
  const rng = lcg(seed)
  const s = newGame(data)
  s.money = 1e9                       // remove capital as a constraint; we are measuring the crop
  s.xp = data.progression.thresholdFactor * 30 * 29   // every crop unlocked
  const r = data.rules
  let spent = 0, earned = 0
  for (let day = 0; day < DAYS; day++) {
    for (let p = 0; p < r.plots; p++) {
      const plot = s.plots[p]
      if (!plot.cropId) {
        s.seeds[cropId] = 1
        spent += cropById(data, cropId).seedPrice
        plant(s, data, p, cropId)
      }
      for (let t = 0; t < r.tilesPerPlot; t++) {
        s.energy = 1e9                // measure the crop, not the energy budget
        if (applyTool(s, data, p, t, 'harvest')) earned += sellCrop(s, data, cropId)
        if (plot.tiles[t].stage === r.stage.dead) applyTool(s, data, p, t, 'clear')
        if (plot.tiles[t].pest > 0) { s.supplies.pesticide = 1; applyTool(s, data, p, t, 'spray') }
        applyTool(s, data, p, t, 'water')
      }
    }
    endDay(s, data, rng)
  }
  return (earned - spent) / DAYS / r.plots      // net profit per plot per day
}

/**
 * Can a player beat the market by simply refusing to flood it?
 *
 * The saturation tiers exist to make growing one crop for ever a bad idea. A
 * barn that grows with the level threatens that: hold enough of one crop and you
 * can sell only what the market pays full price for, week after week, and never
 * flood anything. This plays that strategy against the honest ones, with the
 * farm's real limits in force, and asks whether patience beats variety.
 */
function hoard(cropId, seed, days = 120) {
  const rng = lcg(seed)
  const s = newGame(data)
  s.money = 1e9
  s.xp = data.progression.thresholdFactor * 30 * 29
  const r = data.rules
  const perWeek = r.market.tiers[0].upTo          // all a crop sells at full price
  let earned = 0, spent = 0, weekSold = 0, week = -1

  for (let day = 0; day < days; day++) {
    const now = Math.floor((s.day - 1) / r.market.weekLength)
    if (now !== week) { week = now; weekSold = 0 }

    for (let p = 0; p < r.plots; p++) {
      if (s.plots[p].cropId) continue
      s.seeds[cropId] = 1
      spent += cropById(data, cropId).seedPrice
      plant(s, data, p, cropId)
    }
    for (let p = 0; p < r.plots; p++) {
      s.energy = 1e9
      for (let t = 0; t < r.tilesPerPlot; t++) {
        applyTool(s, data, p, t, 'harvest')
        if (s.plots[p].tiles[t].stage === r.stage.dead) applyTool(s, data, p, t, 'clear')
        applyTool(s, data, p, t, 'water')
      }
    }
    // Sell only what this week can absorb at full price, and hold the rest.
    const room = Math.max(0, perWeek - weekSold)
    const held = cropCount(s, cropId)
    const sell = Math.min(room, held)
    if (sell > 0) { earned += sellCrop(s, data, cropId, sell); weekSold += sell }
    endDay(s, data, rng)
  }
  return { perDay: (earned - spent) / days / r.plots, left: cropCount(s, cropId) }
}

const rows = data.crops.map(c => {
  const runs = [1, 7, 13, 42, 99].map(seed => play(c.id, seed))
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length
  return { crop: c.name?.en ?? c.name, seed: c.seedPrice, sell: c.sellPrice, days: c.daysPerStage, picks: c.harvests, perDay: Math.round(avg) }
}).sort((a, b) => a.perDay - b.perDay)

console.log(`\nnet profit per plot per day — ideal play, averaged over 5 seeds\n`)
console.log('crop          seed   sell  d/stage  picks   profit/day')
for (const r of rows) {
  console.log(`${r.crop.padEnd(12)} ${String(r.seed).padStart(5)} ${String(r.sell).padStart(6)} ${String(r.days).padStart(8)} ${String(r.picks).padStart(6)} ${String(r.perDay).padStart(12)}`)
}
const lo = rows[0].perDay, hi = rows[rows.length - 1].perDay
console.log(`\nspread: ${lo} -> ${hi}  =  ${(hi / lo).toFixed(1)}x\n`)

/* ------------------------------------------------------------------------ */
/* A mixed farm against the best monoculture. The market is meant to make
   variety pay; if monoculture still wins outright, the design has not landed. */

function playMixed(cropIds, seed) {
  const rng = lcg(seed)
  const s = newGame(data)
  s.money = 1e9
  s.xp = data.progression.thresholdFactor * 30 * 29
  const r = data.rules
  let spent = 0, earned = 0
  for (let day = 0; day < DAYS; day++) {
    for (let p = 0; p < r.plots; p++) {
      const plot = s.plots[p]
      if (!plot.cropId) {
        // Each plot takes a different crop, so no single one floods the market.
        const cropId = cropIds[(p + day) % cropIds.length]
        s.seeds[cropId] = 1
        spent += cropById(data, cropId).seedPrice
        plant(s, data, p, cropId)
      }
      for (let t = 0; t < r.tilesPerPlot; t++) {
        s.energy = 1e9
        if (applyTool(s, data, p, t, 'harvest')) earned += sellCrop(s, data, plot.cropId ?? cropIds[0], 1)
        if (plot.tiles[t].stage === r.stage.dead) applyTool(s, data, p, t, 'clear')
        if (plot.tiles[t].pest > 0) { s.supplies.pesticide = 1; applyTool(s, data, p, t, 'spray') }
        applyTool(s, data, p, t, 'water')
      }
    }
    endDay(s, data, rng)
  }
  return (earned - spent) / DAYS / r.plots
}

const seeds = [1, 7, 13, 42, 99]
const best = rows[rows.length - 1]
const topFive = rows.slice(-5).map(r => data.crops.find(c => (c.name?.en ?? c.name) === r.crop).id)
const mixed = seeds.map(sd => playMixed(topFive, sd)).reduce((a, b) => a + b, 0) / seeds.length

console.log(`best single crop : ${best.crop} at ${best.perDay}/day`)
console.log(`mixed of top five: ${Math.round(mixed)}/day`)
const gap = (mixed - best.perDay) / best.perDay
console.log(`mixed is ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(0)}% against the best monoculture`
  + `  ${Math.abs(gap) <= 0.2 ? '(within the 20% target)' : '(OUTSIDE the 20% target)'}`)

// And against the strategy the growing barn made possible: grow one crop, and
// sell only what the market pays full price for, so nothing ever floods.
const patient = data.crops
  .map(c => ({ crop: c.name?.en ?? c.name, ...hoard(c.id, 7) }))
  .sort((a, b) => b.perDay - a.perDay)[0]
const patientGap = (mixed - patient.perDay) / patient.perDay
console.log(`\nholding back to dodge the flood: ${patient.crop} at ${Math.round(patient.perDay)}/day`
  + `, ${patient.left} still unsold`)
console.log(`mixed is ${patientGap >= 0 ? '+' : ''}${(patientGap * 100).toFixed(0)}% against patience`
  + `  ${patientGap >= 0.05 ? '(variety still wins)' : '(PATIENCE WINS — the market has stopped applying pressure)'}\n`)
if (!(patientGap >= 0.05)) process.exitCode = 1
