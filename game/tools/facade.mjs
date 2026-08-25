// What the browser's farm does with each shape of answer a server can give.
//
// These are the answers a real server produces rarely and at awkward moments —
// a stale revision, a rate limit, a dropped connection — so they are produced on
// demand here against a stub. The rule the whole online mode rests on is that
// the browser believes only the server, and never leaves a refusal unspoken.
import { readFileSync } from 'node:fs'
import { createFarm } from '../src/core/farm.js'
import { newGame } from '../src/core/rules.js'
import { INTENTS } from '../../server/intents.mjs'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))

// The save slot is a browser thing and this runs in node, so it gets the one
// piece of the browser it actually uses.
const slot = new Map()
globalThis.localStorage = {
  getItem: (k) => (slot.has(k) ? slot.get(k) : null),
  setItem: (k, v) => slot.set(k, String(v)),
  removeItem: (k) => slot.delete(k),
}

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/** A server that answers however the test needs it to. */
const stub = (answer) => ({
  intent: async () => (typeof answer === 'function' ? answer() : answer),
  state: async () => (typeof answer === 'function' ? answer() : answer),
})

/**
 * Let reward delivery finish.
 *
 * Delivery deliberately does not hold up the action that produced it: a host's
 * milestone handler is somebody else's code and a slow one must not stall the
 * next click. So it lands a moment later, and a test has to wait for it.
 */
const delivered = () => new Promise(r => setTimeout(r, 60))

const build = (answer) => {
  const refusals = []
  const farm = createFarm({
    data, state: newGame(data), server: stub(answer),
    onRefused: (reason, status) => refusals.push({ reason, status }),
  })
  return { farm, refusals }
}

console.log('\nfarm facade\n')

/* ------------------------------------------------------- a stale revision */
{
  // The server answers 409 with the farm attached: the browser had missed
  // something, and here is where things really stand. Taking the state and
  // saying nothing was the bug — this is the most common refusal there is, and
  // it was the one nobody was told about.
  const moved = { ...newGame(data), money: 4242, day: 9 }
  const { farm, refusals } = build({ status: 409, error: 'out of date', revision: 7, state: moved })
  await farm.buySeed({ cropId: 'turnip' })
  eq('a stale answer still updates the farm', farm.state.money, 4242)
  eq('and moves the revision to where the server says', farm.revision, 7)
  eq('and the player is told it was refused', refusals.length, 1)
  eq('with the reason', refusals[0].reason, 'out of date')
}

/* ---------------------------------------------------------- a rate limit */
{
  const { farm, refusals } = build({ status: 429, error: 'slow down' })
  const before = farm.state.money
  await farm.buySeed({ cropId: 'turnip' })
  eq('a rate limit leaves the farm alone', farm.state.money, before)
  eq('and is reported', refusals[0]?.reason, 'slow down')
  eq('with its status', refusals[0]?.status, 429)
}

/* --------------------------------------------------- a dropped connection */
{
  const refusals = []
  const farm = createFarm({
    data, state: newGame(data),
    server: { intent: async () => { throw new Error('network down') }, state: async () => { throw new Error('network down') } },
    onRefused: (reason) => refusals.push(reason),
  })
  const before = farm.state.money
  const result = await farm.buySeed({ cropId: 'turnip' })
  eq('a dropped connection does not throw at the screen', result, false)
  eq('and leaves the farm alone', farm.state.money, before)
  eq('and is reported as offline', refusals[0], 'offline')

  await farm.sync()
  eq('syncing reports it too', refusals.filter(r => r === 'offline').length, 2)

  const report = await farm.endDay()
  eq('and ending the day refuses rather than crashing', report.refused, 'offline')
}

/* ----------------------------------------------------- a session taken over */
{
  const { farm, refusals } = build({ status: 401, error: 'session expired' })
  await farm.harvestPlot({ plot: 0 })
  eq('a farm played elsewhere says so', refusals[0]?.reason, 'session expired')
}

/* ------------------------------------------------------- a plain acceptance */
{
  const moved = { ...newGame(data), money: 999 }
  const { farm, refusals } = build({ ok: true, revision: 3, state: moved })
  await farm.buySeed({ cropId: 'turnip' })
  eq('an accepted intent takes the server\'s farm', farm.state.money, 999)
  eq('and says nothing was refused', refusals.length, 0)
}

/* ------------------------------------ the browser is never its own authority */
{
  // Offline the rules run here, and that is the only time the browser decides
  // anything. Online it must not, whatever it is told.
  const moved = { ...newGame(data), money: 5 }
  const { farm } = build({ ok: true, revision: 1, state: moved })
  farm.state.money = 1_000_000
  await farm.buySeed({ cropId: 'turnip' })
  eq('an edited farm is overwritten by the next answer', farm.state.money, 5)
}

/* --------------------------------------------- an answer that arrives too late */
{
  // A screen syncs when it opens and does not block input while it waits, so a
  // slow answer to that sync can land after an action the player has already
  // taken. Taking it would roll the farm backwards and lose a sale the server
  // definitely accepted.
  let releaseSync
  const slowSync = new Promise((r) => { releaseSync = r })
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      state: () => slowSync,
      intent: async () => ({ ok: true, revision: 2, state: { ...newGame(data), money: 200 } }),
    },
    onRefused: () => {},
  })

  const syncing = farm.sync()                       // in flight, deliberately not awaited
  await farm.buySeed({ cropId: 'turnip' })          // the player acts meanwhile
  eq('the action is the farm the player sees', farm.state.money, 200)
  eq('at the revision the server gave it', farm.revision, 2)

  releaseSync({ revision: 1, state: { ...newGame(data), money: 100 } })
  await syncing
  eq('a stale answer arriving late is ignored', farm.state.money, 200)
  eq('and the revision does not go backwards', farm.revision, 2)
}

/* --------------------------------------- rewards are settled, but only once */
{
  // The server offers a milestone on every response until it is acknowledged.
  // Nothing was acknowledging them, so the outbox grew for ever and the same
  // reward arrived again and again.
  const acked = []
  const handled = []
  const milestone = { eventId: 'e1', milestoneId: 'first-harvest', day: 1 }
  let calls = 0
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => ({ ok: true, revision: ++calls, state: newGame(data), milestones: [milestone] }),
      state: async () => ({ revision: calls, state: newGame(data) }),
      ack: async (ids) => { acked.push(...ids); return { ok: true } },
    },
    onMilestones: (list) => { handled.push(...list) },
    onRefused: () => {},
  })

  await farm.buySeed({ cropId: 'turnip' })
  await delivered()
  eq('a reward reaches the game', handled.length, 1)
  eq('and is acknowledged to the server', acked, ['e1'])

  await farm.buySeed({ cropId: 'turnip' })
  await delivered()
  eq('an already-settled reward is not handled twice', handled.length, 1)
  eq('nor acknowledged twice', acked.length, 1)
}

/* ------------------------------------ a reward is not settled before it lands */
{
  // Acknowledging before the handler has finished would lose a reward to a
  // crash, so the order is: hand it over, wait, then settle.
  const order = []
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => ({ ok: true, revision: 1, state: newGame(data), milestones: [{ eventId: 'e9', milestoneId: 'm' }] }),
      state: async () => ({ revision: 1, state: newGame(data) }),
      ack: async () => { order.push('ack'); return { ok: true } },
    },
    onMilestones: async () => {
      await new Promise(r => setTimeout(r, 10))
      order.push('handled')
    },
    onRefused: () => {},
  })
  await farm.buySeed({ cropId: 'turnip' })
  await delivered()
  eq('the reward is handled before it is settled', order, ['handled', 'ack'])
}

/* ------------------------------ two answers carrying the same reward at once */
{
  // Both responses can be in flight together, and a check that only looks at
  // what has FINISHED lets both through: the reward is handed over twice.
  const handled = []
  const acked = []
  const milestone = { eventId: 'twice', milestoneId: 'm' }
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => ({ ok: true, revision: 1, state: newGame(data), milestones: [milestone] }),
      state: async () => ({ revision: 1, state: newGame(data) }),
      ack: async (ids) => { acked.push(...ids); return { ok: true } },
    },
    onMilestones: async (list) => { await new Promise(r => setTimeout(r, 20)); handled.push(...list) },
    onRefused: () => {},
  })
  await Promise.all([farm.buySeed({ cropId: 'turnip' }), farm.buySeed({ cropId: 'turnip' })])
  await delivered()
  eq('a reward in two answers at once is handled once', handled.length, 1)
  eq('and acknowledged once', acked, ['twice'])
}

/* ---------------------------------------- an acknowledgement the server refused */
{
  // A refused ack is not an ack. Marking it settled locally while the server
  // still holds it loses the reward from both ends: never confirmed, never
  // offered again.
  const handled = []
  let ackCalls = 0
  let allow = false
  const milestone = { eventId: 'e5', milestoneId: 'm' }
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => ({ ok: true, revision: 1, state: newGame(data), milestones: [milestone] }),
      state: async () => ({ revision: 1, state: newGame(data) }),
      ack: async () => { ackCalls++; return allow ? { ok: true } : { status: 429, error: 'slow down' } },
    },
    onMilestones: (list) => { handled.push(...list) },
    onRefused: () => {},
  })

  await farm.buySeed({ cropId: 'turnip' })
  await delivered()
  eq('the reward was handled', handled.length, 1)
  eq('and an acknowledgement was attempted', ackCalls, 1)

  allow = true
  await farm.buySeed({ cropId: 'turnip' })
  await delivered()
  eq('a refused acknowledgement is tried again', ackCalls, 2)
  eq('without handing the reward over twice', handled.length, 1)
}

/* ------------------------------ a reward handler that fails is not a failed day */
{
  // The server has accepted the day. Whatever goes wrong while collecting a
  // reward, the morning happened.
  const refusals = []
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => ({
        ok: true, revision: 4, report: { rain: false, produced: {}, crafted: [], lost: {} },
        state: { ...newGame(data), day: 2 }, milestones: [{ eventId: 'boom', milestoneId: 'm' }],
      }),
      state: async () => ({ revision: 4, state: newGame(data) }),
      ack: async () => ({ ok: true }),
    },
    onMilestones: async () => { throw new Error('the host fell over') },
    onRefused: (reason) => refusals.push(reason),
  })

  const report = await farm.endDay()
  await delivered()
  eq('the day the server accepted is the day the farm is on', farm.state.day, 2)
  ok('and the morning is not reported as refused', !report.refused, JSON.stringify(report))
  eq('the reward failure is reported as its own thing', refusals, ['reward'])
}

/* ------------------------------ an old envelope must not land on a newer one */
{
  // More than one thing seals the same farm: a manual save and the automatic
  // one behind it, or two tabs sharing one slot. Answers do not come back in
  // the order they were asked for, and the slot is a single key — a late answer
  // describing an older farm would overwrite a newer envelope, and the next
  // load would be refused as a rollback.
  const { saveSealed, loadSealed, clear } = await import('../src/core/save.js')
  clear()
  const envelope = (revision, farmId = 'farm-a') => ({ save: { farmId, revision, state: {} }, signature: 'sig' })

  eq('the first envelope is kept', saveSealed(envelope(1)), true)
  eq('a newer one replaces it', saveSealed(envelope(2)), true)
  eq('and the slot holds the newer one', loadSealed().save.revision, 2)
  // A late answer describing an older farm must not overwrite the newer one.
  // It is still not a failure to report: the slot holds this farm further on
  // than the answer describes, so the farm is saved — and saying otherwise put
  // a red save-failed toast in front of a player who resumed a farm and pressed
  // SAVE before touching anything, which asks the slot to hold what it already
  // holds. What matters is what the slot ends up with, not whether a write ran.
  eq('a late answer describing an older farm still counts as saved', saveSealed(envelope(1)), true)
  eq('but the slot keeps the newer one', loadSealed().save.revision, 2)
  eq('and the same revision twice is saved, not failed', saveSealed(envelope(2)), true)
  eq('with the slot unchanged', loadSealed().save.revision, 2)
  eq('a different farm is a different history', saveSealed(envelope(1, 'farm-b')), true)
  eq('and takes the slot', loadSealed().save.farmId, 'farm-b')
  eq('an envelope with no revision is not a save', saveSealed({ save: { farmId: 'x' }, signature: 's' }), false)

  // A slot holding something that is not a save at all must not be allowed to
  // win the comparison. A blob with a farm id and a very high revision but no
  // signature would refuse every real envelope offered to it, and be refused by
  // the server on load — a slot that can neither be written to nor opened, and
  // nothing would ever heal it.
  clear()
  localStorage.setItem('simfarm', JSON.stringify({ v: 2, sealed: { save: { farmId: 'farm-a', revision: 999, state: {} } } }))
  eq('a slot holding an unsigned blob is written over', saveSealed(envelope(1)), true)
  eq('and holds a real save afterwards', loadSealed().save.revision, 1)
  eq('and one with a signature that is not a string', (() => {
    localStorage.setItem('simfarm', JSON.stringify({ v: 2, sealed: { save: { farmId: 'farm-a', revision: 999 }, signature: 42 } }))
    return saveSealed(envelope(2))
  })(), true)
  eq('is written over too', loadSealed().save.revision, 2)
  clear()
}

/* ------------------------------- offline, a reward nobody caught is not lost */
{
  // There is no server holding an outbox here, so the facade's own queue is the
  // only record that a reward is owed. Emptying it before the handler had
  // finished lost the reward and left an unhandled rejection behind.
  const refusals = []
  let failing = true
  const seen = []
  const state = newGame(data)
  const farm = createFarm({
    data, state,
    onMilestones: async (list) => {
      if (failing) throw new Error('the host fell over')
      seen.push(...list)
    },
    onRefused: (r) => refusals.push(r),
  })

  // Reach a milestone the offline rules award: buying an animal.
  farm.state.money = 100000
  farm.state.xp = data.progression.thresholdFactor * 40 * 39
  await farm.buyAnimal({ animalId: data.animals[0].id })
  eq('a handler that fails is reported', refusals, ['reward'])
  eq('and nothing was handed over', seen.length, 0)

  failing = false
  await farm.buySeed({ cropId: 'turnip' })
  ok('the reward comes back on the next action', seen.length > 0, JSON.stringify(seen))
}

/* ------------------------------ two clicks in the same breath do not collide */
{
  // Each intent carries the revision the browser believes the farm is on, and
  // the server refuses one that has fallen behind. Fired together, both would
  // carry the same revision: the server takes one and refuses the other, and the
  // player is told their click failed when it merely arrived second.
  const sent = []
  let revision = 0
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async (body) => {
        sent.push(body.expectedRevision)
        await new Promise(r => setTimeout(r, 20))
        // The real server: refuse anything not on the current revision.
        if (body.expectedRevision !== revision) {
          return { status: 409, error: 'out of date', revision, state: newGame(data) }
        }
        revision++
        return { ok: true, revision, state: { ...newGame(data), money: 100 + revision } }
      },
      state: async () => ({ revision, state: newGame(data) }),
      ack: async () => ({ ok: true }),
    },
    onRefused: (r) => sent.push(`refused:${r}`),
  })

  await Promise.all([
    farm.buySeed({ cropId: 'turnip' }),
    farm.buySeed({ cropId: 'turnip' }),
    farm.buySeed({ cropId: 'turnip' }),
  ])
  eq('three clicks at once are all accepted', sent.filter(v => typeof v === 'string').length, 0)
  eq('because each carried the revision the last one produced', sent, [0, 1, 2])
  eq('and the farm is where the server left it', farm.revision, 3)
}

/* ------------------------- a host that never answers must not stop the game */
{
  // onMilestones is whoever embedded this game. If delivering a reward held the
  // same lane as the intents, a handler that waits for ever — or waits on
  // something that needs another intent — would freeze every later click.
  let secondArrived = false
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async (body) => {
        if (body.type === 'buySupply') secondArrived = true
        return {
          ok: true, revision: 1, state: newGame(data),
          milestones: body.type === 'buySeed' ? [{ eventId: 'stuck', milestoneId: 'm' }] : [],
        }
      },
      state: async () => ({ revision: 1, state: newGame(data) }),
      ack: async () => ({ ok: true }),
    },
    onMilestones: () => new Promise(() => {}),        // never resolves, ever
    onRefused: () => {},
  })

  // Raced against a clock, because the failure this guards against is a hang,
  // and a hanging test tells you nothing except that the suite stopped.
  const within = (promise, ms) => Promise.race([
    promise.then(() => 'done'),
    new Promise(r => setTimeout(() => r('hung'), ms)),
  ])

  eq('the click that raises the reward returns',
    await within(farm.buySeed({ cropId: 'turnip' }), 400), 'done')
  eq('and so does the one after it',
    await within(farm.buySupply({ supplyId: data.supplies[0].id }), 400), 'done')
  ok('which really did reach the server', secondArrived)
}

/* ------------------------------ a save waits for the clicks already made */
{
  // seal() asks the server to bottle the farm up. Three clicks fired in the same
  // tick are three intents outstanding before any has begun, and a save that
  // only looked at what had started would bottle up the farm as it was before
  // them — and the envelope would be refused on load as older than the farm.
  let revision = 0
  const seen = []
  const farm = createFarm({
    data, state: newGame(data),
    server: {
      intent: async () => {
        await new Promise(r => setTimeout(r, 25))
        revision++
        return { ok: true, revision, state: { ...newGame(data), money: revision } }
      },
      state: async () => ({ revision, state: newGame(data) }),
      save: async () => {
        seen.push(revision)
        return { save: { farmId: 'f', revision, state: {} }, signature: 'sig' }
      },
      ack: async () => ({ ok: true }),
    },
    onRefused: () => {},
  })

  farm.buySeed({ cropId: 'turnip' })
  farm.buySeed({ cropId: 'turnip' })
  farm.buySeed({ cropId: 'turnip' })
  ok('the farm knows it is busy before anything has started', farm.busy)
  await farm.seal()
  eq('and the save waited for all three', seen, [3])
  eq('so the envelope describes the farm as it now is', farm.revision, 3)
}

{
  // The two halves of the online game are written in different files and only
  // meet over HTTP, where a name that exists on one side and not the other
  // fails as a refusal the player cannot explain: the button does nothing and
  // nothing is logged. So the names are checked against each other here, on
  // every run, rather than the first time somebody plays online.
  const source = readFileSync(new URL('../src/core/farm.js', import.meta.url), 'utf8')
  const asked = [...new Set([...source.matchAll(/remote\(\s*'([a-zA-Z]+)'/g)].map(m => m[1]))].sort()
  ok('the browser asks the server for something', asked.length > 5)
  const missing = asked.filter(name => !INTENTS.includes(name))
  eq('every intent the browser sends is one the server answers', missing, [])
  // The other direction is a weaker claim — the server may answer things no
  // screen asks for yet — but an intent nothing can reach is dead code that
  // still widens what a tampered client may try, so it is worth knowing about.
  const unreachable = INTENTS.filter(name => !asked.includes(name))
  eq('and every intent the server answers is one some screen can send', unreachable, [])
}

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
