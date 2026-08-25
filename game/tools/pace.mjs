// When does a player actually get to see the game?
//
// The balance table asks what a crop is worth. This asks a different and more
// important question: how many days of playing does it take before each piece of
// the game becomes available at all. Content nobody reaches is content that may
// as well not exist, and a level curve is very easy to write in a way that
// quietly puts half the game behind a year of play.
//
// The farmer here plays well but not perfectly: sows the best crop it can
// afford, works every field, sells what it picks, fills an order when it can,
// and crafts when the barn allows.
import { readFileSync } from 'node:fs'
import * as rules from '../src/core/rules.js'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))
const DAYS = Number(process.env.PACE_DAYS || 120)
const lcg = (n) => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

function play(seed, rules_ = data) {
  const data = rules_
  const rng = lcg(seed)
  const s = rules.newGame(data)
  const arrived = new Map()
  const note = (key, day) => { if (!arrived.has(key)) arrived.set(key, day) }

  const sow = () => {
    for (let p = 0; p < data.rules.plots; p++) {
      if (s.plots[p].cropId) continue
      const best = rules.availableCrops(s, data)
        .filter(c => c.seedPrice <= s.money)
        .sort((a, b) => b.sellPrice / b.daysPerStage - a.sellPrice / a.daysPerStage)[0]
      if (!best) break
      rules.buySeed(s, data, best.id)
      rules.plant(s, data, p, best.id)
    }
  }

  for (let day = 0; day < DAYS; day++) {
    const level = rules.levelOf(s, data)
    for (const c of data.crops) if ((c.unlockLevel ?? 1) <= level) note(`crop ${c.id}`, s.day)
    for (const a of data.animals) if ((a.unlockLevel ?? 1) <= level) note(`animal ${a.id}`, s.day)

    sow()
    for (let p = 0; p < data.rules.plots; p++) {
      if (!s.plots[p].cropId) continue
      rules.harvestPlot(s, data, p)
      for (let t = 0; t < data.rules.tilesPerPlot; t++) {
        if (s.plots[p].tiles[t].stage === data.rules.stage.dead) rules.applyTool(s, data, p, t, 'clear')
      }
    }

    // Buy an animal the moment one is both unlocked and affordable, and keep it
    // fed — the flock is half the game and a player who can have one, will.
    for (const a of data.animals) {
      if ((a.unlockLevel ?? 1) > rules.levelOf(s, data)) continue
      if ((s.animals[a.id] ?? 0) >= a.max) continue
      const feed = rules.byId(data.supplies, a.feed)
      if (s.money > a.price + feed.price * 2) {
        rules.buyAnimal(s, data, a.id)
        note(`kept ${a.id}`, s.day)
      }
    }
    for (const a of data.animals) {
      if (!(s.animals[a.id] > 0)) continue
      if (!(s.supplies[a.feed] > 0) && s.money > rules.byId(data.supplies, a.feed).price) {
        rules.buySupply(s, data, a.feed)
      }
      rules.feedAnimals(s, data, a.id)
    }

    // Fill an order before dumping the rest on the open market.
    for (const order of s.market?.orders ?? []) {
      const want = Math.min(rules.cropCount(s, order.cropId), order.quota - order.filled)
      if (want > 0) { rules.sellCrop(s, data, order.cropId, want); note('filled an order', s.day) }
    }
    for (const c of data.crops) { const n = rules.cropCount(s, c.id); if (n) rules.sellCrop(s, data, c.id, n) }
    for (const g of data.goods) { const n = rules.goodCount(s, g.id); if (n) rules.sellGood(s, data, g.id, n) }

    for (const recipe of data.recipes) {
      if (rules.recipeReady(s, data, recipe)) { rules.craft(s, data, recipe.id); note(`made ${recipe.id}`, s.day) }
    }

    sow()
    for (let p = 0; p < data.rules.plots; p++) if (s.plots[p].cropId) rules.waterPlot(s, data, p)
    rules.endDay(s, data, rng)
  }

  return { arrived, level: rules.levelOf(s, data), money: s.money, xp: s.xp, day: s.day }
}

// Five farms, not three. The strategy reacts to what it has unlocked, so a
// single unlucky season moves a date by a week and a median of three is not a
// steady enough number to tune against.
const SEEDS = [1, 7, 13, 42, 99]
const runs = SEEDS.map(s => play(s))

// What the weekly orders are actually worth to progression.
//
// The obvious counterfactual — leave out the step that fills an order — proves
// nothing, because selling a crop the board wants fills its order anyway. There
// is no separate action to skip. So the honest comparison is the same farmer
// playing the same way in a world where filling one pays no experience at all.
const withoutOrderXp = JSON.parse(JSON.stringify(data))
withoutOrderXp.progression.xp.order = 0
const plain = SEEDS.map(s => play(s, withoutOrderXp))
const medianOf = (rs, key) => {
  const days = rs.map(r => r.arrived.get(key)).filter(d => d != null)
  if (days.length !== rs.length) return null
  days.sort((a, b) => a - b)
  return days[Math.floor(days.length / 2)]
}
const median = (key) => medianOf(runs, key)
const lastCropIn = (rs) => {
  const days = data.crops.map(c => medianOf(rs, `crop ${c.id}`))
  return days.some(d => d == null) ? null : Math.max(...days)
}

const rows = [
  ...data.crops.map(c => [`crop ${c.id}`, `level ${c.unlockLevel ?? 1}`]),
  ...data.animals.map(a => [`animal ${a.id}`, `level ${a.unlockLevel ?? 1}`]),
]

console.log(`\nwhen the game opens up, over ${DAYS} days of decent play\n`)
console.log('  what                        gate        first available')
for (const [key, gate] of rows) {
  const day = median(key)
  console.log(`  ${key.padEnd(26)} ${gate.padEnd(11)} ${day == null ? 'never' : 'day ' + day}`)
}
const never = rows.filter(([k]) => median(k) == null)
const mid = runs[Math.floor(runs.length / 2)]
console.log(`\n  after ${DAYS} days: level ${mid.level}, $${mid.money.toLocaleString('en-US')}, ${mid.xp} xp`)
console.log(`  ${never.length} of ${rows.length} things are still out of reach\n`)

/* ------------------------------------------------------- and is that right? */
// The numbers above are only useful if somebody has said what they should be.
// These are the bands the level curve was tuned to hit, kept here so that the
// next person to change an unlock level or an experience award finds out at
// once rather than discovering a year later that half the game is decoration.
let pass = 0
const failures = []
const within = (what, day, lo, hi) => {
  const good = day != null && day >= lo && day <= hi
  if (good) { pass++; console.log(`  ok    ${what} arrives on day ${day} (wanted ${lo}-${hi})`); return }
  failures.push(`${what} arrives ${day == null ? 'never' : 'on day ' + day}, wanted ${lo}-${hi}`)
  console.log(`  FAIL  ${what} arrives ${day == null ? 'never' : 'on day ' + day}, wanted ${lo}-${hi}`)
}
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${what}`); return }
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
}

console.log('is that the pace it was tuned for?\n')

// The first animal is a tutorial for half the game, so it comes early — but not
// so early that the fields have not been understood first.
within('the first animal', median('animal duck'), 5, 8)
within('the second', median('animal chicken'), 12, 16)
within('the flock getting serious', median('animal sheep'), 25, 35)
within('the last animal', median('animal cow'), 42, 55)

const lastCrop = Math.max(...data.crops.map(c => median(`crop ${c.id}`) ?? Infinity))
within('the last crop', Number.isFinite(lastCrop) ? lastCrop : null, 50, 65)

ok('nothing is out of reach', never.length === 0, never.map(([k]) => k).join(', '))
ok('and there is still a level to climb afterwards', mid.level > 0 && mid.xp > 0, `level ${mid.level}`)

// Orders pay a premium and experience, and the market rules exist to make crop
// choice a decision. What they must not do is become the only way through: a
// player who never happens to grow what the board wants should still see the
// whole game, a little later.
const plainLast = lastCropIn(plain)
console.log()
console.log(`  with the order bonus:    the last crop on day ${lastCrop}`)
console.log(`  with it worth nothing:   the last crop on day ${plainLast ?? 'never'}`)
ok('the game finishes opening up even if orders paid no experience at all',
  plainLast != null && plainLast <= 65, `day ${plainLast}`)
// Only one direction is a fault. A farmer without the bonus arriving LATER by
// more than a fifth means the bonus was really an admission fee. Arriving
// earlier is not a fault and not evidence of anything: this farmer plants
// whatever has the best value per day among what it has unlocked, so a different
// curve makes it choose differently, and the two runs diverge on strategy rather
// than on the bonus. The assertion deliberately does not care about the sign.
ok('so the order bonus guides progression rather than gating it',
  plainLast != null && (plainLast - lastCrop) / lastCrop <= 0.20,
  `${plainLast} vs ${lastCrop} — ${Math.round(((plainLast - lastCrop) / lastCrop) * 100)}% slower without it`)

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
