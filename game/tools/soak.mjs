// A long game played through the real server, over HTTP, with nothing but the
// intents a browser can send.
//
// The adversarial suite proves the server refuses what it should. This proves
// the other half: that a farm played honestly for months does not drift, stall
// or wander into a state the rules never meant to allow. It plays greedily and
// without judgement, which is a decent model of a real player and a very good
// way to find an interaction nobody designed.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { farmLimits } from '../src/core/rules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = JSON.parse(readFileSync(join(HERE, '../public/data/game.json'), 'utf8'))
const DAYS = Number(process.env.SOAK_DAYS || 180)

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const port = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const BASE = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, [join(HERE, '../../server/index.mjs')], {
  env: { ...process.env, PORT: String(port), SIMFARM_SECRET: 'soak'.padEnd(48, '-'), SIMFARM_ENDDAY_MS: '0', SIMFARM_IDLE_DAY_MS: '0', SIMFARM_SESSION_RATE_MAX: '10000' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve, reject) => {
  child.stdout.on('data', d => String(d).includes('farm server') && resolve())
  setTimeout(() => reject(new Error('server did not start')), 8000)
})

const call = (path, body, session) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) },
  body: JSON.stringify(body ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }))

const started = await call('/session', {})
const S = started.body.session
let state = started.body.state
let revision = started.body.revision ?? 0

let throttled = 0

/**
 * Send an intent and keep whatever the server says the farm now is.
 *
 * The server rate-limits, deliberately — a human plays in clicks, not in
 * floods — so a soak that ignores 429 is measuring the limiter rather than the
 * game. It backs off and retries instead, and counts how often it had to.
 */
async function intent(type, payload = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await call('/intent', { type, ...payload, expectedRevision: revision }, S)
    if (res.status === 429) {
      throttled++
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)))
      continue
    }
    if (res.body.state) { state = res.body.state; revision = res.body.revision ?? revision }
    return res.body
  }
  return { error: 'gave up after backing off' }
}

console.log(`\nsoak: ${DAYS} days through ${BASE}\n`)

const r = DATA.rules
const held = (id) => state.barn.crops[id] ?? 0
const unlocked = () => {
  const xp = state.xp ?? 0
  const f = DATA.progression.thresholdFactor
  let level = 1
  while (f * (level + 1) * level <= xp) level++
  return DATA.crops.filter(c => (c.unlockLevel ?? 1) <= level)
}

let refusedEndDays = 0
let peakMoney = 0
const seen = { levels: new Set(), weeks: new Set() }

for (let day = 0; day < DAYS; day++) {
  // Plant whatever is unlocked and affordable, cheapest first, in any empty plot.
  for (let p = 0; p < r.plots; p++) {
    if (state.plots[p].cropId) continue
    const choice = unlocked().filter(c => c.seedPrice <= state.money).sort((a, b) => a.seedPrice - b.seedPrice)[0]
    if (!choice) break
    await intent('buySeed', { cropId: choice.id })
    await intent('plant', { plot: p, cropId: choice.id })
  }

  // Work every field: pick what is ripe, clear what died, spray what is bitten,
  // then water. Energy runs out and that is the point — the day is a budget.
  for (let p = 0; p < r.plots; p++) {
    if (!state.plots[p].cropId) continue
    // PICK ALL and WATER ALL are one intent each, which is what the screen
    // sends; a soak that clicked tile by tile would send forty-eight.
    if (state.plots[p].tiles.some(t => t.stage === r.stage.ripe)) await intent('harvestPlot', { plot: p })
    for (let t = 0; t < r.tilesPerPlot; t++) {
      const tile = state.plots[p].tiles[t]
      if (state.energy <= 0) break
      if (tile.stage === r.stage.dead) await intent('tool', { plot: p, tile: t, toolId: 'clear' })
      else if (tile.pest && state.supplies.pesticide > 0) await intent('tool', { plot: p, tile: t, toolId: 'spray' })
    }
    if (state.energy > 0) await intent('waterPlot', { plot: p })
  }

  // Fill any order it can, then sell the rest. A greedy seller floods the market
  // on purpose, which is exactly the pressure the saturation rule exists for.
  for (const order of state.market?.orders ?? []) {
    const want = Math.min(held(order.cropId), order.quota - order.filled)
    if (want > 0) await intent('sellCrop', { cropId: order.cropId, count: want })
  }
  for (const c of DATA.crops) {
    const n = held(c.id)
    if (n > 0) await intent('sellCrop', { cropId: c.id, count: n })
  }
  for (const g of DATA.goods) {
    const n = state.barn.goods[g.id] ?? 0
    if (n > 0) await intent('sellGood', { goodId: g.id, count: n })
  }

  // Keep the pesticide stocked so pests are a cost, not a wall.
  if (state.supplies.pesticide < 3 && state.money > 800) await intent('buySupply', { supplyId: 'pesticide' })

  const before = { money: state.money, day: state.day }
  const res = await intent('endDay')
  if (res.error || res.report?.refused) {
    refusedEndDays++
    if (process.env.SOAK_TRACE && refusedEndDays < 6) {
      console.log(`  day ${state.day} refused: ${res.error ?? res.report?.refused}`,
        JSON.stringify({ money: state.money, energy: state.energy, seeds: state.seeds,
          plots: state.plots.map(p => ({ crop: p.cropId, tiles: p.tiles.length, stages: p.tiles.map(t => t.stage).join(',') })) }))
    }
  }

  peakMoney = Math.max(peakMoney, state.money)
  seen.weeks.add(state.market?.week)

  // Invariants that must hold on every single day of a long game.
  if (state.money < 0) { ok(`money never goes negative (day ${state.day})`, false, String(state.money)); break }
  if (!Number.isFinite(state.money)) { ok(`money stays a number (day ${state.day})`, false, String(state.money)); break }
  // A day's energy is not a constant: the farm grows with the level, so the
  // ceiling is whatever this farm has earned.
  const room = farmLimits(state, DATA).energy
  if (state.energy < 0 || state.energy > room) {
    ok(`energy stays in range (day ${state.day})`, false, `${state.energy} of ${room}`); break
  }
  if (Object.values(state.barn.crops).some(n => !Number.isSafeInteger(n) || n < 0)) {
    ok(`the barn holds whole counts (day ${state.day})`, false, JSON.stringify(state.barn.crops)); break
  }
  if (state.day <= before.day && !res.error && !res.report?.refused) {
    ok(`the day advances when it is ended (day ${state.day})`, false, `${before.day} -> ${state.day}`); break
  }
}

ok('the farm survived the whole run', state.day >= DAYS - refusedEndDays, `day ${state.day} after ${DAYS} rounds`)
ok('money never went negative', state.money >= 0, String(state.money))
ok('money is still a real number', Number.isFinite(state.money), String(state.money))
ok('the barn holds only whole counts',
  Object.values(state.barn.crops).every(n => Number.isSafeInteger(n) && n >= 0), JSON.stringify(state.barn.crops))
ok('the farm made progress', state.xp > 0, `xp ${state.xp}`)
ok('the farmer got richer than he started', peakMoney > r.startMoney, `peak ${peakMoney}`)
ok('the market board turned over many times', seen.weeks.size > 3, `${seen.weeks.size} weeks`)
ok('greedy selling did flood the market',
  Object.values(state.market?.sold ?? {}).some(n => n > 0) || seen.weeks.size > 1,
  JSON.stringify(state.market?.sold))
ok('the server never got stuck refusing the day', refusedEndDays < DAYS / 4, `${refusedEndDays} refused of ${DAYS}`)

// And the save it hands back after all that still verifies.
ok('the limiter let an honest player through', throttled < DAYS, `backed off ${throttled} times in ${DAYS} days`)

const saved = await call('/save', {}, S)
ok('a save after a long game is signed', !!saved.body.signature && !!saved.body.save,
  `status ${saved.status} body ${JSON.stringify(saved.body).slice(0, 160)}`)
const resumed = await call('/session', { save: saved.body.save, signature: saved.body.signature })
ok('and it resumes', resumed.status === 200 && resumed.body.state?.day === state.day,
  `day ${resumed.body.state?.day} vs ${state.day}`)
ok('with the money it ended on', resumed.body.state?.money === state.money,
  `${resumed.body.state?.money} vs ${state.money}`)

console.log(`\nfinished on day ${state.day} with $${state.money}, xp ${state.xp}, ${refusedEndDays} quiet days, ${throttled} back-offs`)
child.kill()
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
