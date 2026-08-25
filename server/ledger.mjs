// What has to outlive the process.
//
// A signed save is a bearer credential that stays valid as long as its signature
// verifies. Two facts stop one being replayed for profit, and neither is in the
// save itself:
//
//   the highest revision a farm has reached — so yesterday's money cannot be
//   loaded back on top of today's goods;
//   which reward events have been settled — so a save taken before an
//   acknowledgement cannot collect the same reward twice.
//
// Hold those in a process and they die with it, and every old envelope becomes
// spendable again. So the ledger is an interface, with a memory implementation
// for a single machine and a file implementation to show what a real one owes.
// A host with a database should implement this against it and pass it in.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { dirname } from 'node:path'
import { AtCapacity } from './errors.mjs'

/**
 * How long a signed save stays valid.
 *
 * Without an expiry the ledger can never forget anything, because a save from
 * any year could arrive tomorrow. With one, retention only has to outlast
 * validity — which is what makes forgetting safe rather than a quiet hole.
 */
export const DEFAULT_SAVE_TTL_MS = 1000 * 60 * 60 * 24 * 30

const emptyEntry = () => ({ revision: -1, settled: [], touched: Date.now() })

/** The shape every ledger has, over whatever it keeps its entries in. */
function ledgerOver(load, persist, {
  maxFarms = 200_000,
  settledMax = 2000,
  saveTtlMs = DEFAULT_SAVE_TTL_MS,
} = {}) {
  // Kept for twice as long as a save can be used, so an entry is never dropped
  // while a save it governs could still be presented.
  const retainMs = saveTtlMs * 2
  const entries = load()

  const get = (farmId) => entries.get(farmId)
  /** Drop only what is genuinely past its usefulness. */
  const reclaim = () => {
    const stale = Date.now() - retainMs
    let dropped = 0
    for (const [farmId, entry] of entries) {
      if (entry.touched < stale) { entries.delete(farmId); dropped++ }
    }
    return dropped
  }

  const put = (farmId, entry) => {
    entry.touched = Date.now()
    const known = entries.has(farmId)
    if (!known && entries.size >= maxFarms) {
      // Making room by dropping the oldest would be dropping the only thing that
      // refuses a replay — and an entry can be a minute old while the save it
      // governs is good for another month. Age is the only safe reason to
      // forget, so a ledger with nothing expired in it is simply full, and a
      // full ledger refuses a new farm rather than quietly unprotecting an old
      // one. That is a capacity problem for a host to size for, not a hole.
      if (!reclaim() && entries.size >= maxFarms) {
        throw new AtCapacity('ledger is full of farms that can still be replayed')
      }
    }
    entries.set(farmId, entry)
    persist(entries)
  }

  return {
    sweep() {
      const dropped = reclaim()
      if (dropped) persist(entries)
      return dropped
    },
    highWater(farmId) {
      const e = get(farmId)
      return e ? e.revision : null
    },
    noteRevision(farmId, revision) {
      const e = get(farmId) ?? emptyEntry()
      e.revision = Math.max(e.revision, revision)
      put(farmId, e)
    },
    isSettled(farmId, eventId) {
      return get(farmId)?.settled.includes(eventId) === true
    },
    noteSettled(farmId, eventIds) {
      const e = get(farmId) ?? emptyEntry()
      for (const id of eventIds) if (!e.settled.includes(id)) e.settled.push(id)
      if (e.settled.length > settledMax) e.settled.splice(0, e.settled.length - settledMax)
      put(farmId, e)
    },
    get size() { return entries.size },
  }
}

/**
 * A ledger that lives only as long as the process.
 *
 * Correct while it runs and gone when it stops, which means every save this
 * server ever issued becomes replayable after a restart. Fine for a single
 * machine you are developing against; not fine for anything a player returns to.
 */
export const memoryLedger = (opts) => ledgerOver(() => new Map(), () => {}, opts)

/**
 * A ledger in a file, written whole on every change.
 *
 * This is a reference, not a recommendation: it is not safe across replicas and
 * it rewrites everything each time. It exists so the memory one is not the only
 * thing a host can see, and so the tests can prove a restart keeps its promises.
 */
export function fileLedger(path, opts) {
  const load = () => {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      // A ledger that is not there yet is a farm nobody has played yet, and
      // starting empty is correct. A ledger that is there and cannot be read is
      // a ledger, and treating it as empty would throw away every replay it was
      // holding — silently, at exactly the moment somebody most needs it.
      if (err.code === 'ENOENT') return new Map()
      throw new Error(`the ledger at ${path} could not be read: ${err.message}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`the ledger at ${path} is not readable JSON: ${err.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`the ledger at ${path} is not a ledger`)
    }
    return new Map(Object.entries(parsed).map(([k, v]) => [k, {
      revision: Number(v?.revision) || -1,
      settled: Array.isArray(v?.settled) ? v.settled : [],
      touched: Number(v?.touched) || Date.now(),
    }]))
  }
  const persist = (entries) => {
    mkdirSync(dirname(path), { recursive: true })
    // Written beside and renamed over, then both the file and the directory it
    // is in are flushed: the rename protects against a half-written file, and
    // the flushes are what make the rename itself survive losing power.
    const tmp = `${path}.writing`
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(Object.fromEntries(entries)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  return ledgerOver(load, persist, opts)
}
