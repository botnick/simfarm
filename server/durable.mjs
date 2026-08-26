// Does a restart keep its promises?
//
// Everything that refuses a replay lives outside the farm: the highest revision
// a farm reached, and which rewards have been settled. Held in a process, both
// die with it — and because a signed save keeps verifying, every old envelope
// the server ever issued becomes spendable again the moment it comes back up.
//
// So this suite runs two server processes over one durable ledger and asks the
// second to refuse what the first had already seen.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killWith } from './lib-cleanup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(HERE, '../game/public/data/game.json'), 'utf8')))

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const freePort = () => new Promise((r) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => r(port)) })
})

const dir = mkdtempSync(join(tmpdir(), 'simfarm-ledger-'))
const LEDGER = join(dir, 'ledger.json')
const SECRET = 'a-secret-that-outlives-the-process'

/** Start a server that shares the ledger file and the signing secret. */
async function boot(ledgerFile) {
  const port = await freePort()
  const child = killWith(spawn(process.execPath, [join(HERE, 'index.mjs')], {
    env: {
      ...process.env, PORT: String(port), SIMFARM_SECRET: SECRET,
      SIMFARM_ENDDAY_MS: '0', SIMFARM_SESSION_RATE_MAX: '10000',
      ...(ledgerFile ? { SIMFARM_LEDGER_FILE: ledgerFile } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  child.stderr.resume()
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => String(d).includes('farm server') && resolve())
    setTimeout(() => reject(new Error('server did not start')), 8000)
  })
  const base = `http://127.0.0.1:${port}`
  return {
    child,
    post: (path, body, session) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { 'x-session': session } : {}) },
      body: JSON.stringify(body ?? {}),
    }).then(async r => ({ status: r.status, body: await r.json() })),
    get: (path, session) => fetch(base + path, { headers: session ? { 'x-session': session } : {} })
      .then(async r => ({ status: r.status, body: await r.json() })),
    stop: () => child.kill(),
  }
}

/** Play until the first crop is picked, and return the reward it raised. */
async function playToFirstReward(srv) {
  const started = await srv.post('/session', {})
  const S = started.body.session
  const crop = DATA.crops[0].id
  let st = await srv.get('/state', S)
  await srv.post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: st.body.revision }, S)
  st = await srv.get('/state', S)
  await srv.post('/intent', { type: 'plant', plot: 0, cropId: crop, expectedRevision: st.body.revision }, S)
  for (let d = 0; d < 20; d++) {
    st = await srv.get('/state', S)
    if (st.body.state.plots[0].tiles.some(t => t.stage === DATA.rules.stage.ripe)) break
    await srv.post('/intent', { type: 'waterPlot', plot: 0, expectedRevision: st.body.revision }, S)
    st = await srv.get('/state', S)
    await srv.post('/intent', { type: 'endDay', expectedRevision: st.body.revision }, S)
  }
  st = await srv.get('/state', S)
  const picked = await srv.post('/intent', { type: 'harvestPlot', plot: 0, expectedRevision: st.body.revision }, S)
  return { S, crop, event: picked.body.milestones?.[0] }
}

console.log('\ndurable ledger: two processes, one ledger\n')

/* ------------------------------------ an old save does not come back to life */
{
  const a = await boot(LEDGER)
  const { S, crop } = await playToFirstReward(a)

  // Take an envelope, then play on so the farm moves past it.
  const early = await a.post('/save', {}, S)
  let st = await a.get('/state', S)
  await a.post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: st.body.revision }, S)
  const later = await a.post('/save', {}, S)
  ok('the farm moved on', later.body.save.revision > early.body.save.revision,
    `${early.body.save.revision} -> ${later.body.save.revision}`)
  a.stop()

  // A different process, same ledger, same secret.
  const b = await boot(LEDGER)
  const replay = await b.post('/session', { save: early.body.save, signature: early.body.signature })
  eq('an old envelope is refused after a restart', replay.status, 409)
  eq('and says why', replay.body.error, 'save is out of date')
  const current = await b.post('/session', { save: later.body.save, signature: later.body.signature })
  eq('while the newest one still resumes', current.status, 200)
  b.stop()
}

/* --------------------------- and neither does a reward that was already paid */
{
  const a = await boot(LEDGER)
  const { S, event } = await playToFirstReward(a)
  ok('a reward was raised', !!event?.eventId)

  const envelope = await a.post('/save', {}, S)      // taken before settling
  const settled = await a.post('/ack', { eventIds: [event.eventId] }, S)
  eq('and settled', settled.body.settled, 1)
  a.stop()

  const b = await boot(LEDGER)
  const back = await b.post('/session', { save: envelope.body.save, signature: envelope.body.signature })
  eq('the envelope still resumes', back.status, 200)
  const after = await b.post('/intent', { type: 'buySeed', cropId: DATA.crops[0].id, expectedRevision: back.body.revision }, back.body.session)
  eq('but the reward is not offered a second time after a restart',
    (after.body.milestones ?? []).filter(m => m.eventId === event.eventId).length, 0)
  b.stop()
}

/* ------------------------- without a durable ledger, a restart forgets — loudly */
{
  // This is the failure the interface exists to make visible: the same sequence
  // against a process that keeps its ledger in memory lets the old save back in.
  // It is asserted so that nobody can mistake the default for a safe one.
  const a = await boot(null)
  const { S, crop } = await playToFirstReward(a)
  const early = await a.post('/save', {}, S)
  const st = await a.get('/state', S)
  await a.post('/intent', { type: 'buySeed', cropId: crop, expectedRevision: st.body.revision }, S)
  a.stop()

  const b = await boot(null)
  const replay = await b.post('/session', { save: early.body.save, signature: early.body.signature })
  eq('an in-memory ledger does not survive a restart, and the old save is taken', replay.status, 200)
  b.stop()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
