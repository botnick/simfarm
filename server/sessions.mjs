// Sessions: the server's copy of every farm, which is the only copy that counts.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { makeRng } from './rng.mjs'
import { memoryLedger } from './ledger.mjs'
import { AtCapacity } from './errors.mjs'

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

// A save handed to a client comes back signed, so a hand-edited blob is refused
// rather than trusted. The secret never leaves the server.
//
// Left unset it is generated fresh, which is safe but not durable: every save
// this process ever issued stops verifying when it restarts. That is fine for a
// single machine and wrong for anything a player comes back to, so it says so
// rather than failing quietly weeks later.
export const SECRET_IS_EPHEMERAL = !process.env.SIMFARM_SECRET
const SECRET = process.env.SIMFARM_SECRET || randomBytes(32).toString('hex')

export const sign = (payload) =>
  createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex')

export function verify(payload, signature) {
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(String(signature ?? ''))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function createStore({
  ttlMs = 1000 * 60 * 60 * 6,
  maxSessions = 5000,
  idempotencyMax = 500,
  // What must survive this process for a signed save to stay safe to accept.
  // In memory by default, which is right for one machine and wrong for anything
  // a player comes back to; a host passes its own.
  ledger = memoryLedger(),
} = {}) {
  const sessions = new Map()
  const byFarm = new Map()        // farmId -> the one session currently playing it

  const sweep = () => {
    const cutoff = Date.now() - ttlMs
    for (const [id, s] of sessions) if (s.touched < cutoff) forget(id)
    // The ledger is not a session and keeps its own, much longer, schedule.
    ledger.sweep()
  }

  const forget = (id) => {
    const s = sessions.get(id)
    if (!s) return false
    // A request in flight resolved this object before it was evicted and is
    // holding it across an await. Marking it, rather than only removing it from
    // the map, is what stops that request finishing its work on a farm somebody
    // else is now playing.
    s.evicted = true
    if (byFarm.get(s.farmId) === id) byFarm.delete(s.farmId)
    return sessions.delete(id)
  }

  return {
    create(state, {
      farmId = randomUUID(), rngCounter = 0, revision = 0, playerId = null,
      // Restored from a signed save. Defaulted only for a farm that is new: a
      // brand-new farm has of course not played today and owes no events.
      lastEndDay = 0, workedSinceEndDay = true, outbox = [],
    } = {}) {
      sweep()
      // One live session per farm. The same signed save could otherwise be
      // resumed twice at the same revision and played in two places at once,
      // each collecting the farm's milestones and each exporting its own claim
      // to the next revision. The newest arrival wins, which is also what a
      // player wants after a crashed tab.
      //
      // Taking a farm over frees the slot it was using, so it happens before the
      // cap is tested: a full server must never refuse a player their own farm.
      const existing = byFarm.get(farmId)
      if (existing != null) forget(existing)

      // A cap keeps a flood of anonymous sessions from exhausting memory.
      if (sessions.size >= maxSessions) throw new AtCapacity('too many sessions')

      const id = randomBytes(24).toString('hex')
      byFarm.set(farmId, id)
      sessions.set(id, {
        id, farmId, state, playerId,
        rng: makeRng(SECRET, farmId, rngCounter),
        // Every accepted mutation bumps this. A client must say which revision
        // it believes it is on, so a retry cannot apply twice and a stale tab
        // cannot overwrite newer play.
        revision,
        results: new Map(),       // requestId -> the response it already got
        // Milestones awaiting the host's acknowledgement. Carried through a save
        // so a resume cannot quietly drop a reward nobody has settled yet.
        // Restored from the save, minus anything already collected: a save taken
        // before an acknowledgement still carries the event, and resuming it
        // must not hand the reward out a second time.
        outbox: (Array.isArray(outbox) ? outbox : [])
          .filter(m => m && typeof m.eventId === 'string' && !ledger.isSettled(farmId, m.eventId)),
        evicted: false,
        // Whether today has already been played. Resetting these on resume let a
        // farm save, resume and end the day over and over for nothing.
        lastEndDay: Number.isFinite(lastEndDay) ? lastEndDay : 0,
        workedSinceEndDay: workedSinceEndDay !== false,
        touched: Date.now(),
      })
      return id
    },
    get(id) {
      const s = sessions.get(id)
      if (!s) return null
      s.touched = Date.now()
      return s
    },
    /** Refuse a save older than the newest one this farm has produced. */
    isRollback(farmId, revision) {
      const highest = ledger.highWater(farmId)
      return highest != null && revision < highest
    },
    noteRevision(farmId, revision) { ledger.noteRevision(farmId, revision) },
    /** Remember that these events have been collected, for good. */
    noteSettled(farmId, eventIds) { ledger.noteSettled(farmId, [...eventIds]) },
    /** Has this event already been collected on this farm? */
    isSettled(farmId, eventId) { return ledger.isSettled(farmId, eventId) },
    remember(session, requestId, response, asked = null) {
      if (!requestId) return
      // A snapshot, not a reference. The response is built from the live farm,
      // so keeping it as it was means keeping a copy: otherwise replaying a
      // request id hands back yesterday's revision attached to today's barn,
      // which is neither the old answer nor the new one.
      // The ask rides along with the answer: an id reused for a different
      // intent must be told apart from a genuine retry, or it is handed a
      // success belonging to something else.
      session.results.set(requestId, { asked, response: clone(response) })
      // Keep the map from growing without bound on a long session.
      if (session.results.size > idempotencyMax) {
        const oldest = session.results.keys().next().value
        session.results.delete(oldest)
      }
    },
    drop(id) { return forget(id) },
    get size() { return sessions.size },
    get farmsRemembered() { return ledger.size },
  }
}
