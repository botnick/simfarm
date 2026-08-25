// The original persisted to a Flash SharedObject named "simfarm"; the web
// equivalent is localStorage. Same idea: one named slot, overwritten on save.
//
// A save means two different things depending on how the game is being played.
// Offline the browser owns the farm, so the slot holds the farm. Online the
// server owns it and hands back a sealed envelope the browser cannot read or
// edit; the slot holds that instead, and loading gives it back. Writing the
// browser's own view of an online farm would have been worse than useless — it
// looked like a save and resumed nothing.
const KEY = 'simfarm'

export const hasSave = () => localStorage.getItem(KEY) != null

const read = () => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** An offline save: the farm itself. */
export function save(state) {
  localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: Date.now(), state }))
  return true
}

/**
 * An online save: the server's signed envelope, opaque to us.
 *
 * Written compare-and-set, because more than one thing can be sealing the same
 * farm at once — a manual save and the automatic one behind it, or two tabs
 * sharing this slot. Responses do not necessarily come back in the order they
 * were asked for, and the slot is one key: a late answer describing an older
 * farm would overwrite a newer envelope and the next load would be refused as a
 * rollback. So an envelope only replaces one it is actually newer than.
 */
export function saveSealed(envelope) {
  if (!envelope?.save || !envelope?.signature) return false
  const incoming = envelope.save
  if (typeof incoming.revision !== 'number') return false

  // Only a slot that actually holds a save counts as holding one. A blob with a
  // farmId and a revision but no signature would win every comparison here and
  // then be refused by the server on load — a slot that can never be written to
  // and can never be opened, which nothing would ever heal.
  const heldEnvelope = read()?.sealed
  const usable = heldEnvelope?.save && typeof heldEnvelope.signature === 'string' && heldEnvelope.signature
  const held = usable ? heldEnvelope.save : null
  // Only compare within one farm: a different farm is a different slot's worth
  // of history, and its revisions mean nothing here.
  //
  // Nothing to write is not a failure. Resuming a farm and pressing SAVE before
  // touching anything asks the slot to hold an envelope it already holds, and
  // answering "false" to that put a red save-failed toast in front of a player
  // whose farm was, in fact, saved. The question is whether the slot holds this
  // farm at least this far on — and it does.
  if (held && held.farmId === incoming.farmId && held.revision >= incoming.revision) return true

  localStorage.setItem(KEY, JSON.stringify({ v: 2, savedAt: Date.now(), sealed: envelope }))
  return true
}

/** The farm in the slot, if it is one this browser can play by itself. */
export function load() {
  return read()?.state ?? null
}

/** The sealed envelope in the slot, if the slot holds one. */
export function loadSealed() {
  return read()?.sealed ?? null
}

export const clear = () => localStorage.removeItem(KEY)
