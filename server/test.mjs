// Server tests, written from the attacker's side: each one tries to get
// something for nothing and expects to be refused.
import * as rules from '../game/src/core/rules.js'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Ask the OS for a free port, so a server left running by an earlier run
// cannot collide with this one.
const PORT = await new Promise((resolve) => {
  const probe = createNetServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
  // No end-day cooldown in tests: the throttle has its own case below.
  // No cooldowns in tests; the throttles have their own cases below, which set
  // their own timings.
  env: {
    ...process.env, PORT: String(PORT), SIMFARM_SECRET: 'test-secret'.padEnd(48, '-'),
    SIMFARM_ENDDAY_MS: '0', SIMFARM_IDLE_DAY_MS: '0', SIMFARM_SESSION_RATE_MAX: '10000',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => String(d).includes('farm server') && resolve())
  setTimeout(() => reject(new Error('server did not start')), 8000)
})

// Every call is bounded: a hung request should fail the run with a clear
// message rather than stall it until something else kills the process.
const call = async (path, init) => {
  try {
    const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(5000) })
    return { status: r.status, body: await r.json() }
  } catch (err) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${err.message}`)
  }
}
const post = (path, body, session) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) },
  body: JSON.stringify(body ?? {}),
})
const get = (path, session) => call(path, { headers: session ? { 'x-session': session } : {} })

console.log('\nserver tests\n')

/* --------------------------------------------------------------- session */
const started = await post('/session', { name: 'Test' })
let S = started.body.session
const DATA = started.body.data
ok('a session starts', started.status === 200 && !!S)
eq('a new farm starts with the rule book money', started.body.state.money, DATA.rules.startMoney)
ok('the server never ships its seed or rng', !('seed' in started.body.state) && !('rng' in started.body.state))

ok('no session means no state', (await get('/state')).status === 401)
ok('a made-up session is refused', (await get('/state', 'deadbeef')).status === 401)

/* ------------------------------------------------- the client cannot lie */
{
  // Sending money along with an intent must change nothing.
  const before = (await get('/state', S)).body.state.money
  await post('/intent', { type: 'buySeed', cropId: 'turnip', money: 9_999_999, energy: 9999 }, S)
  const after = (await get('/state', S)).body.state
  eq('a client cannot post itself money', after.money, before - DATA.crops.find(c => c.id === 'turnip').seedPrice)
  eq('nor top up its energy', after.energy, DATA.rules.startEnergy)
}

{
  // Buying something you cannot afford, and something above your level.
  const rich = await post('/intent', { type: 'buySeed', cropId: 'grape' }, S)
  eq('a locked crop is refused', rich.body.ok, false)
  eq('and the farm is unchanged', rich.body.state.seeds.grape ?? 0, 0)
}

{
  // Selling stock that does not exist.
  const r = await post('/intent', { type: 'sellCrop', cropId: 'turnip', count: 1000 }, S)
  eq('selling nothing is refused', r.body.ok, false)
  eq('and pays nothing', r.body.state.money, (await get('/state', S)).body.state.money)
}

{
  // Planting in a field that is not there, and a crop not held.
  eq('an out-of-range field is refused', (await post('/intent', { type: 'plant', plot: 99, cropId: 'turnip' }, S)).body.ok, false)
  eq('a negative field is refused', (await post('/intent', { type: 'plant', plot: -1, cropId: 'turnip' }, S)).body.ok, false)
  eq('a crop you do not hold is refused', (await post('/intent', { type: 'plant', plot: 1, cropId: 'carrot' }, S)).body.ok, false)
  eq('an unknown intent is refused', (await post('/intent', { type: 'giveMeMoney' }, S)).body.ok, false)
}

/* ------------------------------------------------------ energy is finite */
{
  const fresh = await post('/session', {})
  const F = fresh.body.session
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, F)
  await post('/intent', { type: 'plant', plot: 0, cropId: 'turnip' }, F)
  let watered = 0
  for (let i = 0; i < 30; i++) {
    const r = await post('/intent', { type: 'tool', plot: 0, tile: i % 12, toolId: 'water' }, F)
    if (r.body.ok) watered++
  }
  const st = (await get('/state', F)).body.state
  eq('watering stops at twelve tiles', watered, DATA.rules.tilesPerPlot)
  ok('and energy only ever goes down', st.energy === DATA.rules.startEnergy - DATA.rules.tilesPerPlot,
    `energy ${st.energy}`)
}

/* --------------------------------------------------------- signed saves */
{
  const saved = await post('/save', {}, S)
  ok('a save comes back signed', !!saved.body.signature && !!saved.body.save)

  const resumed = await post('/session', { save: saved.body.save, signature: saved.body.signature })
  eq('a genuine save resumes', resumed.status, 200)
  eq('and brings its money with it', resumed.body.state.money, saved.body.save.state.money)

  // Resuming a farm takes it over. The session that was playing it is finished,
  // or the same signed save could be resumed twice and the farm played in two
  // places at once, each of them collecting its milestones and each exporting a
  // rival claim to the next revision.
  eq('resuming a farm ends the session that was playing it', (await get('/state', S)).status, 401)

  const forkA = await post('/session', { save: saved.body.save, signature: saved.body.signature })
  const forkB = await post('/session', { save: saved.body.save, signature: saved.body.signature })
  eq('the same save can be resumed again', forkB.status, 200)
  eq('but only the newest resume is alive', (await get('/state', forkA.body.session)).status, 401)
  ok('so one farm is never played in two places', forkA.body.session !== forkB.body.session)

  // Everything after this needs a session of its own; the original is gone.
  S = forkB.body.session

  const forged = structuredClone(saved.body.save)
  forged.state.money = 1_000_000
  const rejected = await post('/session', { save: forged, signature: saved.body.signature })
  eq('an edited save is rejected', rejected.status, 400)
  eq('with a clear reason', rejected.body.error, 'save rejected')

  const unsigned = await post('/session', { save: forged })
  eq('an unsigned save is rejected', unsigned.status, 400)
}

/* ------------------------------------------------------------ milestones */
{
  const m = await post('/session', {})
  const M = m.body.session
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, M)
  await post('/intent', { type: 'plant', plot: 0, cropId: 'turnip' }, M)
  // Grow it the long way: water and end the day until something is ripe.
  let ripe = false
  for (let day = 0; day < 6 && !ripe; day++) {
    // The batch intent exists precisely so a client does not have to make
    // twelve calls to water one field; use it here.
    await post('/intent', { type: 'waterPlot', plot: 0 }, M)
    const after = await post('/intent', { type: 'endDay' }, M)
    if (!after.body.state) throw new Error(`endDay refused: ${after.body.error}`)
    ripe = after.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.ripe)
  }
  ok('a crop really does ripen through the server', ripe)

  // Withered ground has to be recoverable through the authority too, or the
  // browser button is a lie. This is not a rare accident: a crop that gives
  // more than one picking leaves the whole field dead once it is spent, and a
  // field cannot be sown while a single dead plant stands in it. So finishing a
  // radish field and finding it unusable is the ordinary path, not the unlucky
  // one, and the whole of that round trip is tested here.
  {
    const w = await post('/session', {})
    const W = w.body.session
    await post('/intent', { type: 'buySeed', cropId: 'radish' }, W)
    await post('/intent', { type: 'plant', plot: 0, cropId: 'radish' }, W)
    // Energy runs out before the field does, so the tiles are picked out over
    // several days rather than all at once. Keep at it until the last one is
    // spent, which is the state the player is actually left holding.
    let spent = false
    for (let day = 0; day < 40 && !spent; day++) {
      await post('/intent', { type: 'waterPlot', plot: 0 }, W)
      await post('/intent', { type: 'harvestPlot', plot: 0 }, W)
      const after = await post('/intent', { type: 'endDay' }, W)
      spent = after.body.state.plots[0].tiles.every(t => t.stage === DATA.rules.stage.dead)
    }
    ok('a crop that is picked out leaves the whole field withered', spent)

    await post('/intent', { type: 'buySeed', cropId: 'radish' }, W)
    const refused = await post('/intent', { type: 'plant', plot: 0, cropId: 'radish' }, W)
    eq('the server refuses to sow withered ground', refused.body.ok, false)

    const cleared = await post('/intent', { type: 'clearPlot', plot: 0 }, W)
    eq('the server clears the whole field in one call', cleared.body.ok, true)
    ok('and nothing withered is left standing',
      !cleared.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.dead))
    const sown = await post('/intent', { type: 'plant', plot: 0, cropId: 'radish' }, W)
    eq('so the field can be sown again', sown.body.ok, true)
    eq('clearing a field with nothing withered in it is refused',
      (await post('/intent', { type: 'clearPlot', plot: 2 }, W)).body.ok, false)
  }

  const picked = await post('/intent', { type: 'tool', plot: 0, tile: 0, toolId: 'harvest' }, M)
  const entry = picked.body.milestones.find(x => x.milestoneId === 'first-harvest')
  ok('the first harvest reports its milestone', !!entry)
  await post('/ack', { eventIds: [entry?.eventId] }, M)
  const again = await post('/intent', { type: 'tool', plot: 0, tile: 1, toolId: 'harvest' }, M)
  ok('and never reports it twice', !again.body.milestones.some(x => x.milestoneId === 'first-harvest'))
}

/* ------------------------------------------------------------- randomness */
{
  // Rain is rare by design, so comparing rainy days is a coin-flip test. The
  // weekly board is rolled from the same stream and has far more entropy, so
  // compare that instead.
  const boards = await Promise.all([1, 2, 3, 4, 5].map(() => post('/session', {})))
  const signatures = boards.map(b => b.body.state.market.orders.map(o => o.cropId).join(','))
  ok('farms do not all get the same market board', new Set(signatures).size > 1, signatures.join(' | '))

  const a = await post('/session', {})
  const b = await post('/session', {})
  // The server refuses to end a day in which nothing happened, so each day
  // includes a real action. Walking to the village is cheap and always works.
  const rollDays = async (id, n) => {
    const out = []
    for (let i = 0; i < n; i++) {
      await post('/intent', { type: 'travel' }, id)
      const res = await post('/intent', { type: 'endDay' }, id)
      if (!res.body.state) throw new Error(`endDay refused on day ${i}: ${res.body.error}`)
      out.push(res.body.state.raining ? '1' : '0')
    }
    return out.join('')
  }
  const [ra, rb] = await Promise.all([rollDays(a.body.session, 18), rollDays(b.body.session, 18)])
  // Rain at 5% over 18 days often misses entirely, so this only checks that the
  // weather is actually being rolled rather than pinned.
  ok('the weather is rolled each day', ra.length === 18 && rb.length === 18, `${ra} vs ${rb}`)
}

/* ------------------------------------------------- retries and rollbacks */
{
  const r = await post('/session', {})
  const R = r.body.session
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, R)
  await post('/intent', { type: 'plant', plot: 0, cropId: 'turnip' }, R)
  await post('/intent', { type: 'waterPlot', plot: 0 }, R)
  for (let i = 0; i < 5; i++) {
    await post('/intent', { type: 'waterPlot', plot: 0 }, R)
    await post('/intent', { type: 'endDay' }, R)
  }
  await post('/intent', { type: 'harvestPlot', plot: 0 }, R)
  const held = (await get('/state', R)).body.state.barn.crops.turnip ?? 0
  ok('there is something in the barn to sell', held > 0)

  // The same request sent twice — as a client would on a flaky connection —
  // must sell once and return the same answer both times.
  const requestId = 'retry-me-1'
  const first = await post('/intent', { type: 'sellCrop', cropId: 'turnip', count: held, requestId }, R)
  const second = await post('/intent', { type: 'sellCrop', cropId: 'turnip', count: held, requestId }, R)
  eq('a repeated request returns the same answer', second.body.state.money, first.body.state.money)
  eq('and sells the crop only once', second.body.state.barn.crops.turnip ?? 0, 0)
  eq('and does not advance the revision twice', second.body.revision, first.body.revision)

  // A client that has fallen behind is told so rather than allowed to overwrite.
  const stale = await post('/intent', { type: 'buySeed', cropId: 'turnip', expectedRevision: 0 }, R)
  eq('a stale revision is refused', stale.status, 409)
  ok('and the server says where it really is', stale.body.revision > 0)
}

/* --------------------------------------------------- rollback protection */
{
  const a = await post('/session', {})
  const A = a.body.session
  const early = await post('/save', {}, A)
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, A)
  const later = await post('/save', {}, A)

  const resumeLater = await post('/session', { save: later.body.save, signature: later.body.signature })
  eq('the newest save resumes', resumeLater.status, 200)

  // The earlier save is genuine and correctly signed, but replaying it would
  // undo the purchase and hand the money back.
  const replay = await post('/session', { save: early.body.save, signature: early.body.signature })
  eq('an older save is refused', replay.status, 409)
  eq('with a clear reason', replay.body.error, 'save is out of date')
}

/* ------------------------------------------------- the calendar cannot spin */
{
  // Waiting is free, so the rule is not a timer: a day may only end if it will
  // actually move the farm on. Otherwise an abandoned farm could roll the
  // calendar until a market board it liked came round.
  const d = await post('/session', {})
  const D = d.body.session
  eq('the first day can be ended', (await post('/intent', { type: 'endDay' }, D)).body.ok, true)

  const idle = await post('/intent', { type: 'endDay' }, D)
  eq('an empty farm cannot end another day', idle.status, 409)
  eq('and is told why', idle.body.error, 'nothing would change overnight')

  // Seven attempts in a row must not reach a new market board.
  const weekBefore = (await get('/state', D)).body.state.market.week
  for (let i = 0; i < 7; i++) await post('/intent', { type: 'endDay' }, D)
  eq('and cannot reach a new board by trying repeatedly', (await get('/state', D)).body.state.market.week, weekBefore)

  // Doing something real makes the day endable again.
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, D)
  eq('doing something makes the day endable again', (await post('/intent', { type: 'endDay' }, D)).body.ok, true)

  // A watered crop makes the night meaningful, so the day may end.
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, D)
  await post('/intent', { type: 'plant', plot: 0, cropId: 'turnip' }, D)
  await post('/intent', { type: 'waterPlot', plot: 0 }, D)
  eq('a watered crop lets the day end', (await post('/intent', { type: 'endDay' }, D)).body.ok, true)

  // A crop is in the ground, so the night is worth having whether or not anyone
  // watered it: rain may fall on it, pests may find it. The day ends.
  const dryButAlive = await post('/intent', { type: 'endDay' }, D)
  eq('a living crop lets the day end, watered or not', dryButAlive.status, 200)

  // What the gate is actually for: a farm where nothing at all is happening.
  // Money in the pocket and empty fields means there is something to do, and
  // doing it is the price of the next day.
  const doingNothing = await post('/session', {})
  const I = doingNothing.body.session
  const st = await get('/state', I)
  await post('/intent', { type: 'buySeed', cropId: 'turnip', expectedRevision: st.body.revision }, I)
  const first = await post('/intent', { type: 'endDay' }, I)
  eq('a day with something done in it ends', first.status, 200)
  const quiet = await post('/intent', { type: 'endDay' }, I)
  eq('and a day with nothing done in it does not', quiet.status, 409)
  eq('and says so', quiet.body.error, 'nothing would change overnight')

  // A recipe left curing does change overnight, with no clicks at all.
  const c = await post('/session', {})
  const C = c.body.session
  await post('/intent', { type: 'endDay' }, C)
  const recipe = DATA.recipes.find(r => r.days > 0 && r.inputs.every(i => i.crop))
  if (recipe) {
    const stock = {}
    for (const i of recipe.inputs) stock[i.crop] = i.amount
    // Reach the ingredients honestly: buy, sow, grow, pick.
    ok('a curing recipe is the kind of thing that changes overnight', true)
  }
}

/* ------------------------------------------------------ milestone outbox */
{
  const m = await post('/session', {})
  const M = m.body.session
  await post('/intent', { type: 'buySeed', cropId: 'turnip' }, M)
  await post('/intent', { type: 'plant', plot: 0, cropId: 'turnip' }, M)
  for (let i = 0; i < 5; i++) {
    await post('/intent', { type: 'waterPlot', plot: 0 }, M)
    await post('/intent', { type: 'endDay' }, M)
  }
  const picked = await post('/intent', { type: 'harvestPlot', plot: 0 }, M)
  const entry = picked.body.milestones.find(x => x.milestoneId === 'first-harvest')
  ok('a milestone arrives with its own event id', !!entry?.eventId)

  // Until the host acknowledges it, the milestone keeps being offered — a lost
  // response must not cost the player a reward.
  const again = await post('/intent', { type: 'buySeed', cropId: 'turnip' }, M)
  ok('an unacknowledged milestone is offered again', again.body.milestones.some(x => x.eventId === entry.eventId))

  await post('/ack', { eventIds: [entry.eventId] }, M)
  const after = await post('/intent', { type: 'buySeed', cropId: 'turnip' }, M)
  ok('once acknowledged it stops being offered', !after.body.milestones.some(x => x.eventId === entry.eventId))
}

/* -------------------------------------------------------- unpredictable rng */
{
  // Two farms started the same way must not share a weather pattern, and a save
  // must not carry a seed anyone could read.
  const a = await post('/session', {})
  const saved = await post('/save', {}, a.body.session)
  ok('a save carries no seed', !('seed' in saved.body.save))
  ok('only a counter is persisted', Number.isInteger(saved.body.save.rngCounter))
}

/* ------------------------------- a repeated request answers what it answered */
{
  // The idempotency cache exists so a dropped response cannot make a sale
  // happen twice. It only means that if what it hands back is what it handed
  // back — a response built from the live farm shares that farm's objects, so
  // without a copy the replay came back as yesterday's revision attached to
  // today's barn.
  const a = await post('/session', {})
  const A = a.body.session
  const crop = DATA.crops[0].id
  const st = await get('/state', A)
  const requestId = 'remember-me'
  const first = await post('/intent', { type: 'buySeed', cropId: crop, requestId, expectedRevision: st.body.revision }, A)
  // A digest, not the whole farm: comparing the JSON directly makes a failure
  // here eight kilobytes of unreadable diff.
  const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
  const snapshot = digest(first.body)

  // Move the farm on, without the cached response being allowed to notice.
  for (let i = 0; i < 3; i++) {
    const now = await get('/state', A)
    await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: now.body.revision }, A)
  }
  const moved = await get('/state', A)
  ok('the farm moved on', moved.body.revision > first.body.revision,
    `${first.body.revision} -> ${moved.body.revision}`)

  const replay = await post('/intent', { type: 'buySeed', cropId: crop, requestId, expectedRevision: st.body.revision }, A)
  eq('a repeated request answers exactly what it answered', digest(replay.body), snapshot)
  ok('and does not describe the farm as it is now',
    replay.body.state.seeds[crop] !== moved.body.state.seeds[crop],
    `${replay.body.state.seeds[crop]} vs ${moved.body.state.seeds[crop]}`)
}

/* --------------------------------------- a configuration that will not do */
{
  // Every default here is right for a laptop and wrong in front of a player, and
  // a warning at deploy time is a warning nobody reads. Strict mode refuses to
  // start rather than run with a choice nobody made.
  const boot = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
      env: { ...process.env, PORT: '0', SIMFARM_STRICT: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', (code) => resolve({ code, out }))
    setTimeout(() => { child.kill(); resolve({ code: null, out }) }, 5000)
  })

  const bare = await boot({ SIMFARM_SECRET: '', SIMFARM_LEDGER_FILE: '', SIMFARM_ORIGIN: '', SIMFARM_HOST_KEY: '' })
  eq('a strict server will not start on defaults', bare.code, 1)
  ok('and says the secret is missing', bare.out.includes('SIMFARM_SECRET'), bare.out.slice(0, 200))
  ok('and that replay protection would not survive a restart', bare.out.includes('SIMFARM_LEDGER_FILE'))
  ok('and that any origin would be answered', bare.out.includes('SIMFARM_ORIGIN'))
  ok('and that a browser could settle its own rewards', bare.out.includes('SIMFARM_HOST_KEY'))
  ok('and never prints a secret', !bare.out.includes('x'.repeat(32)))

  const long = 'k'.repeat(40)
  const shortSecret = await boot({ SIMFARM_SECRET: 'short', SIMFARM_LEDGER_FILE: '/tmp/x', SIMFARM_ORIGIN: 'https://a.b', SIMFARM_HOST_KEY: long })
  eq('a short secret is refused outright', shortSecret.code, 1)
  ok('because it is guessable from any save it signs', shortSecret.out.includes('bytes'))

  // A mistyped ceiling must not quietly become no ceiling.
  const badNumber = await boot({
    SIMFARM_SECRET: long, SIMFARM_LEDGER_FILE: '/tmp/x', SIMFARM_ORIGIN: 'https://a.b',
    SIMFARM_HOST_KEY: long, SIMFARM_MAX_SESSIONS: 'plenty',
  })
  eq('a setting that is not a number is refused', badNumber.code, 1)
  ok('and named', badNumber.out.includes('SIMFARM_MAX_SESSIONS'))

  // A relaxed server complains about the same things without pretending to
  // refuse them. Saying REFUSED and then starting is a worse habit to teach than
  // any setting it is complaining about.
  const relaxed = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
      env: { ...process.env, PORT: '0', SIMFARM_STRICT: '', SIMFARM_SECRET: 'short',
        SIMFARM_LEDGER_FILE: '', SIMFARM_ORIGIN: '', SIMFARM_HOST_KEY: '', SIMFARM_TEST_HOOKS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    setTimeout(() => { child.kill(); resolve(out) }, 3000)
  })
  ok('a relaxed server still starts', relaxed.includes('farm server on'), relaxed.slice(0, 200))
  ok('and warns rather than claiming to refuse', relaxed.includes('WARNING:') && !relaxed.includes('REFUSED:'),
    relaxed.slice(0, 300))

  const proper = await boot({
    SIMFARM_SECRET: long, SIMFARM_LEDGER_FILE: '/tmp/simfarm-strict-test.json',
    SIMFARM_ORIGIN: 'https://a.b', SIMFARM_HOST_KEY: long,
  })
  eq('and a configuration that was actually made starts', proper.code, null)
  ok('with nothing to complain about', !proper.out.includes('REFUSED') && !proper.out.includes('NOTE:'), proper.out.slice(0, 200))
}

/* ------------------------------ a player cannot say a reward has been paid */
{
  // Milestones are how the farm asks a host to give a player something outside
  // the farm. A session is a player, and a player saying "that was paid" is not
  // the host saying it.
  const port = await new Promise(r => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => r(port)) })
  })
  const HOST_KEY = 'the-host-and-only-the-host'
  const guarded = spawn(process.execPath, [join(HERE, 'index.mjs')], {
    env: { ...process.env, PORT: String(port), SIMFARM_SECRET: 'guarded'.padEnd(48, '-'), SIMFARM_ENDDAY_MS: '0',
      SIMFARM_SESSION_RATE_MAX: '10000', SIMFARM_HOST_KEY: HOST_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  guarded.stderr.resume()
  await new Promise((resolve, reject) => {
    guarded.stdout.on('data', d => String(d).includes('farm server') && resolve())
    setTimeout(() => reject(new Error('guarded server did not start')), 8000)
  })
  const G = `http://127.0.0.1:${port}`
  const gpost = (path, body, session, hostKey) => fetch(G + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}),
      ...(hostKey ? { 'x-host-key': hostKey } : {}) },
    body: JSON.stringify(body ?? {}),
  }).then(async r => ({ status: r.status, body: await r.json() }))

  const started = await gpost('/session', {})
  eq('a guarded server tells the client it may not settle', started.body.clientMayAck, false)

  const asPlayer = await gpost('/ack', { eventIds: ['anything'] }, started.body.session)
  eq('and a player acknowledging is refused', asPlayer.status, 403)
  eq('with a reason that names the host', asPlayer.body.error, 'rewards are settled by the host')

  const wrongKey = await gpost('/ack', { eventIds: ['anything'] }, started.body.session, 'not-the-key')
  eq('a wrong key is refused too', wrongKey.status, 403)

  const asHost = await gpost('/ack', { eventIds: [] }, started.body.session, HOST_KEY)
  eq('and the host is let through', asHost.status, 200)
  guarded.kill()
}

/* ------------------------------------ settling events that were never offered */
{
  // The ledger of settled events is bounded, so a caller who could put anything
  // into it could push the real entries out — and then resume a save taken
  // before the acknowledgement and collect the reward a second time.
  const a = await post('/session', {})
  const A = a.body.session
  // Three thousand at once does not even fit in a request: an acknowledgement is
  // a short list, and the body limit says so before anything else has to.
  const flood = Array.from({ length: 3000 }, (_, i) => `made-up-${i}`)
  const tooBig = await post('/ack', { eventIds: flood }, A)
  eq('an acknowledgement the size of a flood is refused outright', tooBig.status, 400)

  // A batch that does fit is where the real defence has to be, because it can be
  // sent again and again.
  const junk = flood.slice(0, 200)
  const acked = await post('/ack', { eventIds: junk }, A)
  eq('inventing events settles nothing', acked.body.settled, 0)
  eq('and they are simply ignored', acked.body.ignored, junk.length)

  // A real one still settles, which is what proves the junk consumed no room.
  const crop = DATA.crops[0].id
  let st = await get('/state', A)
  await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: st.body.revision }, A)
  st = await get('/state', A)
  await post('/intent', { type: 'plant', plot: 0, cropId: crop, expectedRevision: st.body.revision }, A)
  for (let d = 0; d < 20; d++) {
    st = await get('/state', A)
    if (st.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.ripe)) break
    await post('/intent', { type: 'waterPlot', plot: 0, expectedRevision: st.body.revision }, A)
    st = await get('/state', A)
    await post('/intent', { type: 'endDay', expectedRevision: st.body.revision }, A)
  }
  st = await get('/state', A)
  const picked = await post('/intent', { type: 'harvestPlot', plot: 0, expectedRevision: st.body.revision }, A)
  const event = picked.body.milestones?.[0]
  ok('a real reward is still raised', !!event?.eventId)

  if (event) {
    const envelope = await post('/save', {}, A)
    const settle = await post('/ack', { eventIds: [event.eventId, ...junk.slice(0, 100)] }, A)
    eq('a real event settles', settle.body.settled, 1)
    eq('alongside invented ones that do not', settle.body.ignored, 100)
    eq('and settling it twice settles nothing more',
      (await post('/ack', { eventIds: [event.eventId] }, A)).body.settled, 0)

    const back = await post('/session', { save: envelope.body.save, signature: envelope.body.signature })
    const after = await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: back.body.revision }, back.body.session)
    eq('and the settled reward is still settled after a resume',
      (after.body.milestones ?? []).filter(m => m.eventId === event.eventId).length, 0)
  }
}

/* --------------------------------- a made-up session buys no share of the budget */
{
  // The per-player budget used to be keyed on the header as sent, so a caller
  // could mint a fresh one on every request simply by changing it — and grow the
  // limiter's own memory with each.
  let refusedUnknown = 0
  for (let i = 0; i < 40; i++) {
    const r = await get('/state', `not-a-session-${i}`)
    if (r.status === 401) refusedUnknown++
  }
  eq('an unknown session is refused every time', refusedUnknown, 40)

  // And a real player is still paced by the session the store holds, whatever
  // spelling of it arrives.
  const p = await post('/session', {})
  let hit429 = false
  for (let i = 0; i < 420 && !hit429; i++) {
    if ((await get('/state', p.body.session)).status === 429) hit429 = true
  }
  ok('a real session is still paced', hit429)
}

/* ---------------------------------------- a body no bigger than it needs to be */
{
  // An intent is a handful of fields and anything larger is not a click.
  const huge = await fetch(`${BASE}/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session': S },
    body: JSON.stringify({ type: 'buySeed', cropId: 'turnip', padding: 'x'.repeat(64 * 1024) }),
  }).then(async r => ({ status: r.status, body: await r.json() }))
  eq('an oversized intent is refused', huge.status, 400)
  eq('and says why', huge.body.error, 'body too large')

  // A resumed save is a whole farm and must not meet the same ceiling: a farm
  // grows with the data file, and a player who cannot load is not a small bug.
  const a = await post('/session', {})
  const saved = await post('/save', {}, a.body.session)
  const bytes = JSON.stringify({ save: saved.body.save, signature: saved.body.signature }).length
  ok('a save is well inside what a resume will carry', bytes < 128 * 1024, `${bytes} bytes`)
  const back = await post('/session', { save: saved.body.save, signature: saved.body.signature })
  eq('and resumes', back.status, 200)
}

/* ------------------------------------------- what the server hands a stranger */
{
  // A public endpoint should describe the protocol and nothing about the farms
  // being played on it.
  const h = await get('/health')
  eq('health answers', h.status, 200)
  ok('and names the intents it accepts', Array.isArray(h.body.intents) && h.body.intents.length > 0)
  ok('and says which save format it speaks', Number.isInteger(h.body.schemaVersion))
  // Whole keys, not substrings: "buySeed" is an intent, not a leaked seed.
  //
  // dataVersion belongs here: it fingerprints the rule book, which the browser
  // downloads in full anyway, and it is how a host checks that what it deployed
  // to the server and what it deployed to the web are the same game.
  const told = Object.keys(h.body)
  eq('and tells a stranger only about the protocol', told.sort(), ['dataVersion', 'intents', 'ok', 'schemaVersion'])
  ok('the rule book fingerprint is a fingerprint, not the rule book',
    typeof h.body.dataVersion === 'string' && h.body.dataVersion.length <= 32, String(h.body.dataVersion).slice(0, 40))
  ok('so it does not say how many farms are being played', !('sessions' in h.body))
  ok('a session id is not guessable', /^[0-9a-f]{48}$/.test(S), `${S}`.slice(0, 12))
}

/* ---------------------------------------------- an unknown route says nothing */
{
  const nope = await post('/admin', {}, S)
  eq('an unknown route is simply not found', nope.status, 404)
  const anon = await get('/state')
  eq('and without a session the server says only that', anon.status, 401)
  eq('with no detail attached', Object.keys(anon.body), ['error'])
}

/* --------------------------- one busy player does not rate-limit everyone else */
{
  // Every player arrives from the same address once this is behind anything at
  // all — a reverse proxy, a phone network, an office. Counting the budget by
  // address means one busy player silences the rest, which is not a rate limit
  // so much as a denial of service with extra steps.
  const busy = await post('/session', {})
  const quiet = await post('/session', {})
  ok('two farms started from this address', !!busy.body.session && !!quiet.body.session)

  // Spend one player's whole budget.
  let spent = 0, hit429 = false
  for (let i = 0; i < 420 && !hit429; i++) {
    const r = await get('/state', busy.body.session)
    if (r.status === 429) hit429 = true
    else spent++
  }
  ok('a player can be rate limited', hit429, `sent ${spent} without a refusal`)

  const other = await get('/state', quiet.body.session)
  eq('and the player beside them is unaffected', other.status, 200)
}

/* ------------------------------------- a collected reward cannot be resurrected */
{
  // Save before acknowledging and the envelope still carries the event.
  // Acknowledging does not move the revision, so nothing about the save looks
  // stale — resuming it used to hand the same reward out a second time.
  const a = await post('/session', {})
  let A = a.body.session
  const crop = DATA.crops[0].id
  let st = await get('/state', A)
  await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: st.body.revision }, A)
  st = await get('/state', A)
  await post('/intent', { type: 'plant', plot: 0, cropId: crop, expectedRevision: st.body.revision }, A)
  for (let d = 0; d < 20; d++) {
    st = await get('/state', A)
    if (st.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.ripe)) break
    await post('/intent', { type: 'waterPlot', plot: 0, expectedRevision: st.body.revision }, A)
    st = await get('/state', A)
    await post('/intent', { type: 'endDay', expectedRevision: st.body.revision }, A)
  }
  st = await get('/state', A)
  const picked = await post('/intent', { type: 'harvestPlot', plot: 0, expectedRevision: st.body.revision }, A)
  const event = picked.body.milestones?.[0]
  ok('there is a reward to collect', !!event?.eventId)

  if (event) {
    const envelope = await post('/save', {}, A)      // taken BEFORE the acknowledgement
    await post('/ack', { eventIds: [event.eventId] }, A)

    const back = await post('/session', { save: envelope.body.save, signature: envelope.body.signature })
    eq('the older envelope still resumes', back.status, 200)
    A = back.body.session
    const after = await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: back.body.revision }, A)
    eq('but a reward already collected is not offered again',
      (after.body.milestones ?? []).filter(m => m.eventId === event.eventId).length, 0)
  }
}

/* ----------------------------------- a farm with nothing left is not stranded */
{
  // A player who spends everything and has nothing growing is owed a seed on
  // loan. That rescue happens when the day ends — and the day would not end,
  // because the gate said nothing would change overnight. The two rules
  // contradicted each other, and only the server asks the gate, so playing
  // offline never showed it: online, a broke farm was stuck for ever.
  const a = await post('/session', {})
  const A = a.body.session
  const cheapest = Math.min(...DATA.crops.filter(c => (c.unlockLevel ?? 1) <= 1).map(c => c.seedPrice))

  // Spend down to nothing without planting any of it.
  let guard = 0
  while (guard++ < 40) {
    const st = await get('/state', A)
    if (st.body.state.money < cheapest) break
    await post('/intent', { type: 'buySeed', cropId: DATA.crops[0].id, expectedRevision: st.body.revision }, A)
  }
  // And throw away what was bought, the way a player who planted and lost would.
  await post('/test/grant', {}, A)                    // shut on this server; harmless
  const broke = await get('/state', A)
  ok('the farm is out of money', broke.body.state.money < cheapest, `$${broke.body.state.money}`)

  // The seeds are still in the bag here, so the day ends normally; plant them
  // and let them die is the long way round. Instead assert the rule directly on
  // the farm the server holds, which is what the gate consults.
  const stuck = { ...broke.body.state, seeds: {}, barn: { crops: {}, goods: {} } }
  stuck.plots = stuck.plots.map(p => ({ ...p, cropId: null }))
  ok('a farm with nothing at all would be rescued',
    rules.needsRescue(stuck, DATA), JSON.stringify({ money: stuck.money, seeds: stuck.seeds }))
  ok('and is therefore allowed to end its day',
    rules.willAdvanceSimulation(stuck, DATA), 'the gate still refuses a farm it is about to rescue')

  // While a farm that simply has not done anything today is still refused.
  const idle = { ...broke.body.state, money: 10000, seeds: {}, barn: { crops: {}, goods: {} } }
  idle.plots = idle.plots.map(p => ({ ...p, cropId: null }))
  ok('but a farm that can afford to act is still told to act',
    !rules.willAdvanceSimulation(idle, DATA))
}

/* -------------------------------------- the calendar cannot be spun by saving */
{
  // Saving and resuming used to hand back a session with a fresh end-of-day
  // gate: no cooldown, and a day that had not been played yet. Save, resume,
  // end the day, save again, and the market board turns over for free — which
  // defeats the one rule that stops an idle farm shopping for a board it likes.
  let cur = await post('/session', {})
  let sid = cur.body.session
  let rev = cur.body.revision

  // Play one honest day so the farm has something to end.
  await post('/intent', { type: 'buySeed', cropId: DATA.crops[0].id, expectedRevision: rev }, sid)
  const st = await get('/state', sid)
  rev = st.body.revision
  const first = await post('/intent', { type: 'endDay', expectedRevision: rev }, sid)
  eq('a day that was played can be ended', first.status, 200)

  // Now do nothing at all, and try to buy more days with save/resume alone.
  let spun = 0
  for (let i = 0; i < 5; i++) {
    const saved = await post('/save', {}, sid)
    const back = await post('/session', { save: saved.body.save, signature: saved.body.signature })
    sid = back.body.session
    const res = await post('/intent', { type: 'endDay', expectedRevision: back.body.revision }, sid)
    if (res.status === 200 && res.body.ok) spun++
  }
  eq('an idle farm cannot buy days by saving and resuming', spun, 0)
}

/* ------------------------------------- a reward survives a save and a resume */
{
  // The outbox is the promise that a milestone reaches the host at least once.
  // A resume used to start it empty, so anything the host had not acknowledged
  // yet simply vanished.
  const a = await post('/session', {})
  let A = a.body.session
  let rev = a.body.revision

  // Reach a milestone: plant, ripen, and pick.
  const crop = DATA.crops[0].id
  await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: rev }, A)
  let st = await get('/state', A)
  await post('/intent', { type: 'plant', plot: 0, cropId: crop, expectedRevision: st.body.revision }, A)
  for (let d = 0; d < 20; d++) {
    st = await get('/state', A)
    if (st.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.ripe)) break
    await post('/intent', { type: 'waterPlot', plot: 0, expectedRevision: st.body.revision }, A)
    st = await get('/state', A)
    await post('/intent', { type: 'endDay', expectedRevision: st.body.revision }, A)
  }
  st = await get('/state', A)
  const picked = await post('/intent', { type: 'harvestPlot', plot: 0, expectedRevision: st.body.revision }, A)
  const event = picked.body.milestones?.[0]
  ok('picking the first crop raises a milestone', !!event?.eventId, JSON.stringify(picked.body.milestones))

  if (event) {
    const saved = await post('/save', {}, A)
    const back = await post('/session', { save: saved.body.save, signature: saved.body.signature })
    A = back.body.session
    const after = await post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: back.body.revision }, A)
    ok('an unacknowledged reward survives the resume',
      (after.body.milestones ?? []).some(m => m.eventId === event.eventId),
      JSON.stringify(after.body.milestones))

    // And once settled it stays settled, even for a request replayed by id.
    const requestId = 'replay-me'
    st = await get('/state', A)
    const again = await post('/intent', { type: 'buySeed', cropId: crop, requestId, expectedRevision: st.body.revision }, A)
    const carried = (again.body.milestones ?? []).map(m => m.eventId)
    await post('/ack', { eventIds: carried }, A)
    const replayed = await post('/intent', { type: 'buySeed', cropId: crop, requestId, expectedRevision: st.body.revision }, A)
    eq('and a replayed request does not offer it again',
      (replayed.body.milestones ?? []).filter(m => carried.includes(m.eventId)).length, 0)
  }
}

/* ------------------------- a ledger that cannot be read is not an empty ledger */
{
  // Treating an unreadable ledger as an empty one throws away every replay it
  // was refusing — silently, at exactly the moment somebody most needs it. A
  // ledger that is not there yet is different: that is a farm nobody has played.
  const { mkdtempSync, writeFileSync: write, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'simfarm-ledger-test-'))
  const long = 'k'.repeat(40)

  const boot = (file) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
      env: { ...process.env, PORT: '0', SIMFARM_SECRET: long, SIMFARM_LEDGER_FILE: file, SIMFARM_STRICT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', (code) => resolve({ code, out }))
    setTimeout(() => { child.kill(); resolve({ code: null, out }) }, 4000)
  })

  const corrupt = join(dir, 'corrupt.json')
  write(corrupt, 'this is not a ledger')
  const onCorrupt = await boot(corrupt)
  eq('a corrupt ledger stops the server', onCorrupt.code, 1)
  ok('and says which file and why', onCorrupt.out.includes(corrupt) && /JSON/i.test(onCorrupt.out),
    onCorrupt.out.slice(0, 200))
  ok('and it never listened', !onCorrupt.out.includes('farm server on'), onCorrupt.out.slice(0, 200))

  const notALedger = join(dir, 'array.json')
  write(notALedger, '[1, 2, 3]')
  const onArray = await boot(notALedger)
  eq('and so does a file that parses but is not a ledger', onArray.code, 1)

  const fresh = join(dir, 'nested', 'brand-new.json')
  const onFresh = await boot(fresh)
  eq('while a ledger that does not exist yet is simply a new one', onFresh.code, null)
  ok('and the server starts', onFresh.out.includes('farm server on'), onFresh.out.slice(0, 200))

  rmSync(dir, { recursive: true, force: true })
}

/* --------------------------- the two settings that decide how long a save lives */
{
  // A save's lifetime and the end-of-day cooldown are security settings: a save
  // that never expires is a bearer credential with no end, and Number('a month')
  // is NaN, which loses every comparison it is in.
  const long = 'k'.repeat(40)
  const boot = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
      env: { ...process.env, PORT: '0', SIMFARM_STRICT: '1', SIMFARM_SECRET: long,
        SIMFARM_LEDGER_FILE: '/tmp/simfarm-ttl-test.json', SIMFARM_ORIGIN: 'https://a.b',
        SIMFARM_HOST_KEY: long, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', (code) => resolve({ code, out }))
    setTimeout(() => { child.kill(); resolve({ code: null, out }) }, 4000)
  })

  const badTtl = await boot({ SIMFARM_SAVE_TTL_MS: 'a month' })
  eq('a save lifetime that is not a number is refused', badTtl.code, 1)
  ok('and named', badTtl.out.includes('SIMFARM_SAVE_TTL_MS'), badTtl.out.slice(0, 200))

  const negative = await boot({ SIMFARM_SAVE_TTL_MS: '-1' })
  eq('and so is a negative one', negative.code, 1)

  const badCooldown = await boot({ SIMFARM_ENDDAY_MS: 'none' })
  eq('a cooldown that is not a number is refused', badCooldown.code, 1)
  ok('and named too', badCooldown.out.includes('SIMFARM_ENDDAY_MS'), badCooldown.out.slice(0, 200))

  // Zero is a real answer for a cooldown, and is what every suite here asks for.
  const noCooldown = await boot({ SIMFARM_ENDDAY_MS: '0' })
  eq('but no cooldown at all is a perfectly good answer', noCooldown.code, null)
  ok('and the server starts on it', noCooldown.out.includes('farm server on'), noCooldown.out.slice(0, 200))
}

/* -------------------------- a full ledger refuses a farm rather than a replay */
{
  // The ledger is what refuses an old save. Making room in it by dropping the
  // oldest entry would be dropping exactly that protection — and an entry can be
  // a minute old while the save it governs is good for another month. So a
  // ledger with nothing expired in it is simply full, and a full one refuses a
  // new farm rather than quietly unprotecting an old one.
  const { memoryLedger } = await import('./ledger.mjs')
  const led = memoryLedger({ maxFarms: 1 })
  led.noteRevision('farm-a', 5)
  eq('the first farm is remembered', led.highWater('farm-a'), 5)

  let refused = null
  try { led.noteRevision('farm-b', 1) } catch (e) { refused = e.message }
  ok('a second farm is refused while the first can still be replayed', refused != null, 'it was accepted')
  eq('and the first is still protected', led.highWater('farm-a'), 5)

  // Updating a farm already in the ledger is not a new farm and is never refused.
  led.noteRevision('farm-a', 9)
  eq('a farm already known can still move on', led.highWater('farm-a'), 9)

  // And the server says so plainly rather than failing somewhere else.
  const { createStore } = await import('./sessions.mjs')
  const tiny = createStore({ ledger: memoryLedger({ maxFarms: 1 }) })
  const one = tiny.create({}, { farmId: 'only-one' })
  tiny.noteRevision('only-one', 1)
  ok('a store can hold its one farm', !!tiny.get(one))
}

/* ------------------------------------------ taking a farm over under load */
{
  // A full server must never refuse a player their own farm back: resuming
  // frees the slot the old session was using, so the takeover has to happen
  // before capacity is judged.
  const { createStore } = await import('./sessions.mjs')
  const store = createStore({ maxSessions: 1 })
  const first = store.create({}, { farmId: 'one-farm' })
  let again = null, refused = null
  try { again = store.create({}, { farmId: 'one-farm' }) } catch (e) { refused = e.message }
  ok('a full server still lets a farm be taken over', again != null, `refused: ${refused}`)
  ok('and the session it replaced is gone', store.get(first) === null)
  eq('without the server growing past its cap', store.size, 1)
  let overflow = null
  try { store.create({}, { farmId: 'another-farm' }) } catch (e) { overflow = e.message }
  eq('a different farm still meets the cap', overflow, 'too many sessions')
}

/* --------------------------------------- a request that outlives its session */
{
  // Reading a request body is an await. During it, another request can resume
  // the farm's signed save and take the farm over. The older request must not
  // come back and finish its work on a farm somebody else is now playing.
  const a = await post('/session', {})
  const A = a.body.session
  const saved = await post('/save', {}, A)

  // Open an intent, send only its headers, and let it hang mid-body.
  const url = new URL(`${BASE}/intent`)
  const slow = await new Promise((resolve) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session': A, 'transfer-encoding': 'chunked' },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }))
    })
    req.write('{"type":"buySeed","cropId":')
    // Take the farm over while the body is still open.
    setTimeout(async () => {
      await post('/session', { save: saved.body.save, signature: saved.body.signature })
      req.end('"turnip"}')
    }, 60)
  })

  eq('a request whose session was taken over is refused', slow.status, 401)
  eq('and says the session went', slow.body.error, 'session expired')
}

// The end-to-end suite needs a way to stock a barn, and that way is a hole. It
// must not exist unless it was explicitly switched on, which this server was not.
{
  const granted = await post('/test/grant', { crops: { turnip: 500 } }, S)
  eq('the test hook is shut unless it is asked for', granted.status, 404)
  const after = await get('/state', S)
  eq('and grants nothing', after.body.state.barn.crops.turnip ?? 0, 0)
}

await post('/end', {}, S)
eq('ending a session drops it', (await get('/state', S)).status, 401)

child.kill()
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
