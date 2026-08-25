// The authoritative farm server.
//
// The browser draws; this decides. A client sends intents and receives the farm
// as the server sees it. Nothing the client says about money, energy, levels or
// the weather is believed — those live here, and so does the random source.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import * as rules from '../game/src/core/rules.js'
import { fingerprint } from '../game/src/core/data-version.js'
import { AtCapacity } from './errors.mjs'
import { createStore, sign, verify, SECRET_IS_EPHEMERAL } from './sessions.mjs'
import { memoryLedger, fileLedger, DEFAULT_SAVE_TTL_MS } from './ledger.mjs'
import { review, enforce, positive } from './config.mjs'
import { applyIntent, view, INTENTS } from './intents.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// The rule book this server enforces. SIMFARM_DATA points at a different one,
// which is how an operator runs a build against edited data — and how the
// suite proves a farm saved under one rule book still opens under the next.
const DATA_FILE = process.env.SIMFARM_DATA || join(HERE, '../game/public/data/game.json')
const DATA = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
// A fingerprint of the rule book this server enforces.
//
// The browser loads its own copy to draw from, and the two can drift — a host
// deploys a new data file to one and not the other, and the game then shows
// prices and unlocks the server does not agree with. Nothing is exploitable,
// because the server decides regardless, but a player is told one thing and
// given another, which is worse than an error.
//
// Taken with the same function the browser uses, from the same file, so the two
// agree by construction rather than by both being kept in step by hand.
const DATA_VERSION = fingerprint(DATA)
const PORT = Number(process.env.PORT || 8787)

// A mistyped ceiling must not become no ceiling: Number('lots') is NaN, and NaN
// loses every comparison it appears in.
const DAY = 1000 * 60 * 60 * 24
const numeric = [
  // How long a signed save stays usable, and how often a day may be ended.
  // Security settings, both of them: a save that never expires is a bearer
  // credential with no end, and a cooldown of NaN is no cooldown at all.
  ['saveTtl', 'SIMFARM_SAVE_TTL_MS', DEFAULT_SAVE_TTL_MS, DAY * 365],
  ['endDayCooldown', 'SIMFARM_ENDDAY_MS', 1000, 1000 * 60 * 60, 0],
  ['rate', 'SIMFARM_RATE_MAX', 300, 1e6],
  ['edgeRate', 'SIMFARM_EDGE_RATE_MAX', 3000, 1e7],
  ['newSessionRate', 'SIMFARM_SESSION_RATE_MAX', 120, 1e6],
  ['maxSessions', 'SIMFARM_MAX_SESSIONS', 5000, 1e7],
  ['sessionTtl', 'SIMFARM_SESSION_TTL_MS', 1000 * 60 * 60 * 6, 1000 * 60 * 60 * 24 * 30],
]
const numbers = {}
const numberProblems = []
for (const [key, name, fallback, max, min] of numeric) {
  const { value, problem } = positive(name, fallback, { max, min })
  numbers[key] = value
  if (problem) numberProblems.push(problem)
}
const SCHEMA_VERSION = 1

// What stops an old save being replayed has to outlive the process, or a
// restart makes every envelope this server ever issued spendable again. In
// memory unless a file is named; a host with a database implements the same
// interface against it and passes it in.
const LEDGER_FILE = process.env.SIMFARM_LEDGER_FILE
const SAVE_TTL_MS = numbers.saveTtl

// A configured ledger that exists and cannot be read is not an empty ledger. It
// is every replay this server ever refused, and starting without it would let
// all of them back in — so it stops here, with a sentence rather than a stack.
let ledger = null
const ledgerProblems = []
try {
  ledger = LEDGER_FILE ? fileLedger(LEDGER_FILE, { saveTtlMs: SAVE_TTL_MS }) : memoryLedger({ saveTtlMs: SAVE_TTL_MS })
} catch (err) {
  ledgerProblems.push(err.message)
  ledgerProblems.push('  Refusing to start without it would be safer than starting without its history.')
}

const store = createStore({
  // A host running this for real sizes these to its own traffic.
  maxSessions: numbers.maxSessions,
  ttlMs: numbers.sessionTtl,
  ledger,
})

// Budgets. Farming is a handful of clicks a second at most, so anything above
// this is a script and can wait.
//
// The budget belongs to a session where there is one, and only falls back to
// the address for the routes that come before a session exists. Counting purely
// by address collapses behind a reverse proxy — every player arrives from the
// proxy's address, so one busy player would rate-limit everybody. A host putting
// this behind anything is the normal case, not the exception.
const RATE = { windowMs: 10_000, max: numbers.rate }
// The pre-authentication budget. Every player behind a proxy shares it, so it is
// deliberately far above what one player could need; it exists to bound the work
// an anonymous caller can cause, and a host that can see real client addresses
// should do this properly at its edge.
const EDGE_RATE = { windowMs: 10_000, max: numbers.edgeRate }
// Starting a farm is the one thing a stranger can do, so it keeps a budget of
// its own, by address. It is deliberately loose: a school, an office or a phone
// network is one address to this server, and a limit tight enough to stop abuse
// from one machine is also tight enough to lock a hundred honest players out.
// A host that can see real client addresses should do this at its edge instead.
const NEW_SESSION_RATE = { windowMs: 60_000, max: numbers.newSessionRate }
const END_DAY_COOLDOWN_MS = numbers.endDayCooldown
// A hook for the end-to-end suite to put something in a farm's barn without
// playing eight days to get it. It is a hole by definition, so it exists only
// when it is asked for by name, and says so loudly when it does.
const TEST_HOOKS = process.env.SIMFARM_TEST_HOOKS === '1'

/**
 * The key a host settles rewards with.
 *
 * Milestones are how the farm tells a host to give the player something outside
 * the farm, and a browser must never be the thing that says a reward has been
 * given — a session holder could settle an event the host never paid, and any
 * reward granted in a browser is forgeable anyway.
 *
 * Set this and only a caller holding it may acknowledge; the browser is told it
 * may not, and stops trying. Left unset the farm is a single-player game with no
 * host and nothing outside itself to give away, so the browser settling its own
 * events costs nothing.
 */
const HOST_KEY = process.env.SIMFARM_HOST_KEY || null
// Bounded by construction. Scanning for expired entries only when the map got
// large is a scan an attacker can pay for: every request that adds a key also
// pays for a walk of everything still fresh. A plain insertion-ordered cap drops
// the oldest key in constant time instead, and the worst an eviction can do is
// give somebody a fresh budget — which is what they would have had anyway.
const HITS_MAX = 20_000
const hits = new Map()

/**
 * A clock that only ever goes forwards.
 *
 * The wall clock does not: NTP corrections, a host waking from sleep and a
 * daylight-saving change can all put it back. A rate window measured on it then
 * has a start in the future, every comparison says the window is still open,
 * and the caller stays rate-limited until real time catches up — which could be
 * hours. Nothing here needs to survive a restart, so nothing here needs the
 * wall clock.
 */
const monotonic = () => performance.now()

function rateLimited(key, rate = RATE) {
  const now = monotonic()
  const entry = hits.get(key)
  if (entry && now - entry.start <= rate.windowMs) {
    entry.count++
    return entry.count > rate.max
  }
  if (!entry) {
    while (hits.size >= HITS_MAX) {
      const oldest = hits.keys().next().value
      if (oldest === undefined) break
      hits.delete(oldest)
    }
  }
  hits.set(key, { start: now, count: 1 })
  return 1 > rate.max
}

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.SIMFARM_ORIGIN || '*',
    'access-control-allow-headers': 'content-type, x-session',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

// An intent is a handful of fields. A resumed save is a whole farm, and it grows
// with the data file — more crops, more plots, more tiles — so it gets room to
// grow into rather than a cap a host would discover by a player being unable to
// load. Measured: a well-played farm with every field in grapes is about 5 KB.
const BODY_LIMIT = { intent: 8 * 1024, save: 256 * 1024 }

// The refusals the server means to make, and therefore the only messages it
// repeats back. Anything else that reaches the catch-all is a fault, not an
// answer.
const SPOKEN = new Set(['body too large', 'bad json', 'too many sessions'])

const readBody = (req, limit = BODY_LIMIT.intent) => new Promise((resolve, reject) => {
  // A body that announces itself as too large is refused before a byte of it is
  // read.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) { reject(new Error('body too large')); return }

  let size = 0
  let over = false
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > limit) {
      // Stop keeping it, but let the request finish so the refusal can be sent
      // as an answer. Dropping the connection instead told the caller nothing
      // and looked like the server had fallen over.
      over = true
      chunks.length = 0
      // Unless it simply keeps coming, at which point it is not a client making
      // a mistake and there is nothing to explain to it.
      if (size > limit * 4) req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (over) { reject(new Error('body too large')); return }
    let body
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {} }
    catch { reject(new Error('bad json')); return }
    // Valid JSON is not the same as a body. `null`, `7` and `[]` all parse, and
    // every handler here then reads fields off them — `null` threw, and left as
    // an unexpected fault rather than the plain mistake it is.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      reject(new Error('bad json'))
      return
    }
    resolve(body)
  })
  req.on('error', reject)
})

/**
 * A save the client may hold: opaque to it, and signed so edits are detected.
 *
 * It carries more than the farm. Anything the server was holding only in the
 * session is lost the moment a save is resumed, and two of those were load
 * bearing: the marker that says whether today has been played, without which
 * save-and-resume spins the calendar for free; and the milestone outbox, which
 * promises at-least-once delivery and cannot keep that promise if a resume
 * throws away everything the host has not acknowledged yet.
 */
function exportSave(session) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    // When this envelope was made. A credential with no expiry means the ledger
    // that refuses replays can never forget anything, because a save from any
    // year could arrive tomorrow; with one, retention only has to outlast
    // validity.
    issuedAt: Date.now(),
    farmId: session.farmId,
    revision: session.revision,
    rngCounter: session.rng.counter(),
    state: session.state,
    lastEndDay: session.lastEndDay,
    workedSinceEndDay: session.workedSinceEndDay,
    outbox: session.outbox,
  }
  return { save: payload, signature: sign(payload) }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const url = new URL(req.url, 'http://localhost')
  const ip = req.socket.remoteAddress ?? 'unknown'
  // A budget before anything is known about the caller, keyed on the one thing
  // they cannot choose. It has to be loose, because behind a proxy this is every
  // player at once; its job is to bound the work done for an unauthenticated
  // request, not to pace a player.
  if (rateLimited(`ip:${ip}`, EDGE_RATE)) return json(res, 429, { error: 'slow down' })

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      // Public, so it describes the protocol and nothing about the people using
      // it. How many farms are being played is an operational fact and belongs
      // in a host's own metrics, not on an open endpoint.
      return json(res, 200, { ok: true, intents: INTENTS, schemaVersion: SCHEMA_VERSION, dataVersion: DATA_VERSION })
    }

    // Start a farm, or resume one from a signed save.
    //
    // The signed save IS the credential. Anyone holding a current one can resume
    // the farm and, in doing so, take it from whoever is playing it — that is
    // bearer-capability, not account ownership, and it is what a game with no
    // login can offer. `playerId` below is a label the caller chooses; it is
    // neither signed nor checked and confers nothing. A host that has real
    // accounts should bind farmId to its own identity here before trusting the
    // save alone.
    if (req.method === 'POST' && url.pathname === '/session') {
      // Anyone can ask for a farm, so this one is budgeted by address as well.
      if (rateLimited(`new:${ip}`, NEW_SESSION_RATE)) return json(res, 429, { error: 'slow down' })
      const body = await readBody(req, BODY_LIMIT.save)
      let state, opts = {}
      if (body.save) {
        if (!verify(body.save, body.signature)) return json(res, 400, { error: 'save rejected' })
        if (body.save.schemaVersion !== SCHEMA_VERSION) return json(res, 409, { error: 'save is from another version' })
        // A save older than the ledger is prepared to remember cannot be checked
        // for replay any more, so it is refused rather than trusted.
        // A save from the future never expires: age comes out negative and
        // every comparison against the limit passes. Only this server stamps
        // that field, so a long way ahead means a clock that was wrong when it
        // signed, and the save should be treated as unreadable rather than
        // immortal. A few minutes of drift is ordinary and allowed.
        const CLOCK_SLACK_MS = 5 * 60 * 1000
        const age = Date.now() - Number(body.save.issuedAt ?? 0)
        if (!Number.isFinite(age) || age > SAVE_TTL_MS || age < -CLOCK_SLACK_MS) {
          return json(res, 409, { error: 'save has expired' })
        }
        // A signature proves the save was ours; it does not prove it is the
        // newest. Refusing older revisions is what stops a rollback replay.
        if (store.isRollback(body.save.farmId, body.save.revision)) {
          return json(res, 409, { error: 'save is out of date' })
        }
        state = body.save.state
        opts = {
          farmId: body.save.farmId,
          rngCounter: body.save.rngCounter,
          revision: body.save.revision,
          // Signed, therefore trustworthy, therefore restored rather than reset.
          // Trustworthy is not the same as sensible, though: this is a wall
          // clock reading from another moment and possibly another machine, and
          // it can come back describing the future. A farm whose last night is
          // stamped ahead of now would refuse every day until real time caught
          // up, so time it cannot have waited yet is time it has not waited.
          lastEndDay: Math.min(Number(body.save.lastEndDay) || 0, Date.now()),
          workedSinceEndDay: body.save.workedSinceEndDay,
          outbox: body.save.outbox,
        }
      } else {
        state = rules.newGame(DATA, { name: String(body.name ?? '').slice(0, 24) })
      }

      // A signature proves this save was ours. It does not prove the rule book
      // has not been edited since — the save carries a schema version, which is
      // the shape of the file, and nothing about which crops exist. Adding or
      // removing one is documented as an edit to a single JSON file, and a farm
      // growing a crop that edit removed cannot be played at all: the night
      // looks it up to age it, finds nothing, and throws. Every attempt to end
      // the day then fails in the same place, so the farm is finished and the
      // player cannot even be told why.
      //
      // So a resumed farm is brought into agreement with the rule book this
      // server actually enforces, before anybody is handed a session for it.
      const dropped = rules.reconcile(state, DATA)
      if (Object.values(dropped).some(v => (Array.isArray(v) ? v.length : v))) {
        console.log('resumed a farm from an older rule book:', JSON.stringify(dropped))
      }
      let id, session
      try {
        id = store.create(state, { ...opts, playerId: body.playerId ?? null })
        session = store.get(id)
        store.noteRevision(session.farmId, session.revision)
      } catch (err) {
        if (id) store.drop(id)
        // Either too many farms are being played at once, or the ledger that
        // refuses replays is full of farms whose saves have not expired yet.
        // Both are capacity, and both are the host's to size for — the important
        // thing is that neither is quietly resolved by forgetting a farm.
        //
        // A ledger that cannot be written to is none of those. It used to leave
        // here as a full server with the write error attached, which told a host
        // to buy capacity for a broken disk and told whoever asked where the
        // file lives.
        if (err instanceof AtCapacity) return json(res, 503, { error: 'the server is full' })
        throw err
      }
      return json(res, 200, {
        session: id, revision: session.revision, state: view(session, DATA), data: DATA, dataVersion: DATA_VERSION,
        // Whether this client is allowed to settle its own reward events. It is
        // not, wherever a host is the one actually paying them.
        clientMayAck: !HOST_KEY,
      })
    }

    // Header only. A token in a query string ends up in proxy logs, browser
    // history, analytics and referrers, and this one is a bearer credential.
    const sessionId = req.headers['x-session']
    const session = sessionId ? store.get(String(sessionId)) : null
    if (!session) return json(res, 401, { error: 'no session' })

    // Now that the caller is known, pace them individually. Keyed on the id the
    // store holds rather than the text they sent: keying on an unvalidated
    // header let a caller mint a fresh budget per request simply by changing it,
    // and grow the limiter's map with every one.
    if (rateLimited(`s:${session.id}`)) return json(res, 429, { error: 'slow down' })

    /**
     * Is this still the session it was a moment ago?
     *
     * Reading a request body is an await, and during it another request can
     * resume the farm's signed save and take the farm over. Without this check
     * the older request would come back and finish its work on a farm somebody
     * else is now playing — quietly mutating it and, worse, emitting milestone
     * rewards from a branch that no longer exists. Call it after every await and
     * before touching the session.
     */
    const stillOurs = () => !session.evicted && store.get(String(sessionId)) === session

    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, { revision: session.revision, state: view(session, DATA) })
    }

    if (req.method === 'POST' && url.pathname === '/intent') {
      const body = await readBody(req)
      if (!stillOurs()) return json(res, 401, { error: 'session expired' })

      // A retry of a request already handled returns exactly what it returned
      // the first time, so a dropped response cannot sell the same crop twice.
      if (body.requestId && session.results.has(body.requestId)) {
        return json(res, 200, session.results.get(body.requestId))
      }
      // A client that thinks it is on an older revision has missed something.
      if (body.expectedRevision != null && body.expectedRevision !== session.revision) {
        return json(res, 409, { error: 'out of date', revision: session.revision, state: view(session, DATA) })
      }

      if (body.type === 'endDay') {
        const now = Date.now()
        // Resuming already clamps this; the clock can also move while a session
        // is open, and the same reasoning applies to that.
        if (session.lastEndDay > now) session.lastEndDay = now
        if (now - session.lastEndDay < END_DAY_COOLDOWN_MS) {
          return json(res, 429, { error: 'too soon' })
        }
        // A day may only end if it will actually move the farm on: something
        // was done today, or the night itself will change something — a watered
        // crop, a fed animal, a recipe curing. Waiting is free, so a timer here
        // would be friction rather than a rule: without this an abandoned farm
        // could spin the calendar until a market board it liked came round.
        if (!session.workedSinceEndDay && !rules.willAdvanceSimulation(session.state, DATA)) {
          return json(res, 409, { error: 'nothing would change overnight' })
        }
        session.lastEndDay = now
        session.workedSinceEndDay = false
      }

      const result = applyIntent(session, DATA, body)
      if (result.ok) {
        session.revision++
        store.noteRevision(session.farmId, session.revision)
        if (body.type !== 'endDay') session.workedSinceEndDay = true
      }

      // Milestones go into an outbox with their own id and stay there until the
      // host acknowledges them, so a lost response never loses a reward.
      for (const id of rules.takeMilestones(session.state)) {
        session.outbox.push({ eventId: randomUUID(), milestoneId: id, day: session.state.day })
      }

      const response = {
        ...result,
        revision: session.revision,
        milestones: session.outbox,
        state: view(session, DATA),
      }
      store.remember(session, body.requestId, response)
      return json(res, 200, response)
    }

    // The host confirms it has handled some milestones; only then are they gone.
    if (req.method === 'POST' && url.pathname === '/ack') {
      const body = await readBody(req)
      if (!stillOurs()) return json(res, 401, { error: 'session expired' })
      // Settling is the host's word that a reward has actually been given. A
      // player's session is not that word.
      if (HOST_KEY) {
        const offered = req.headers['x-host-key']
        const given = Buffer.from(String(offered ?? ''))
        const wanted = Buffer.from(HOST_KEY)
        const matches = given.length === wanted.length && timingSafeEqual(given, wanted)
        if (!matches) return json(res, 403, { error: 'rewards are settled by the host' })
      }
      // Only events this farm was actually offered can be settled. Taking the
      // caller's word meant a client could settle thousands of invented ids,
      // push the real ones out of a bounded ledger, and then resume a save taken
      // before the acknowledgement to collect the reward twice.
      const asked = new Set(Array.isArray(body.eventIds) ? body.eventIds.filter(id => typeof id === 'string') : [])
      const offered = new Set(session.outbox.map(m => m.eventId))
      const done = new Set([...asked].filter(id => offered.has(id)))
      const unknown = asked.size - done.size
      session.outbox = session.outbox.filter(m => !done.has(m.eventId))
      // Settling is permanent and belongs to the farm, not the session: a save
      // taken before this moment still carries the event, and acknowledging does
      // not move the revision, so nothing else would refuse it on resume.
      if (done.size) store.noteSettled(session.farmId, done)
      // Responses are cached so a retried request cannot apply twice, and each
      // cached response carries the outbox as it was. Left alone, replaying an
      // old request id would hand back an event the host has already settled.
      for (const [requestId, cached] of session.results) {
        if (!cached?.milestones?.length) continue
        session.results.set(requestId, { ...cached, milestones: cached.milestones.filter(m => !done.has(m.eventId)) })
      }
      return json(res, 200, { ok: true, settled: done.size, ignored: unknown, pending: session.outbox.length })
    }

    if (TEST_HOOKS && req.method === 'POST' && url.pathname === '/test/grant') {
      const body = await readBody(req)
      if (!stillOurs()) return json(res, 401, { error: 'session expired' })
      for (const [id, n] of Object.entries(body.crops ?? {})) {
        if (rules.cropById(DATA, id) && Number.isSafeInteger(n) && n > 0) session.state.barn.crops[id] = n
      }
      for (const [id, n] of Object.entries(body.goods ?? {})) {
        if (DATA.goods.some(g => g.id === id) && Number.isSafeInteger(n) && n > 0) session.state.barn.goods[id] = n
      }
      // The rescue loan is what makes a sale keep nothing, and reaching it
      // honestly takes a bankrupt farm and several days.
      if (Number.isSafeInteger(body.debt) && body.debt >= 0) session.state.debt = body.debt
      return json(res, 200, { revision: session.revision, state: view(session, DATA) })
    }

    if (req.method === 'POST' && url.pathname === '/save') {
      return json(res, 200, exportSave(session))
    }

    if (req.method === 'POST' && url.pathname === '/end') {
      const out = exportSave(session)
      store.drop(session.id)
      return json(res, 200, { ok: true, ...out })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    // What the server is willing to say out loud. A refusal it decided to make
    // is useful to whoever asked; an exception it did not expect is a
    // description of the server's insides, and handing that to a client is the
    // same mistake the browser's fatal notice exists to avoid. This one was
    // returning "Cannot read properties of undefined (reading 'pest')" to
    // anyone who asked it to end a day it could not end.
    if (SPOKEN.has(err.message)) return json(res, 400, { error: err.message })
    console.error('unexpected:', err)
    return json(res, 500, { error: 'the farm could not do that' })
  }
})

// Everything that is convenient here and wrong in front of a player is decided
// once, before anything is listening.
const settings = review()
settings.blocking.push(...numberProblems)
if (!enforce(settings)) process.exit(1)

// This one is fatal whether or not the server is strict: there is no sensible
// way to run without the ledger somebody asked for.
if (ledgerProblems.length) {
  for (const line of ledgerProblems) console.error(line.startsWith(' ') ? line : `REFUSED: ${line}`)
  process.exit(1)
}

// So is a rule book that does not hang together with itself. Every id in it
// that points at another id — what an animal eats and produces, what a recipe
// takes and makes, what a tool consumes, which seed the rescue loan hands back
// — is a reference nothing checks while a farm is being played. Break one and
// the server still starts; the break arrives later, in somebody's night, as a
// fault with no way back. SIMFARM_DATA makes that a thing an operator can do by
// accident, so it is checked here, once, before anything is listening.
const bookProblems = rules.checkData(DATA)
if (bookProblems.length) {
  console.error(`REFUSED: the rule book at ${DATA_FILE} does not hang together`)
  for (const line of bookProblems) console.error(`  ${line}`)
  process.exit(1)
}

// The port that was actually bound, not the one that was asked for: PORT=0
// means "pick one", and printing the 0 back tells nobody where the server is.
server.listen(PORT, () => console.log(`farm server on :${server.address().port}`))
