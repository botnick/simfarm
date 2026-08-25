// The one thing the screens talk to.
//
// The rules are pure and the server runs exactly the same ones, so the same
// game can be played two ways:
//
//   online  — every action is an intent sent to the server, which owns the farm
//             and the dice. The browser draws whatever comes back and can lie
//             about nothing.
//   offline — the rules run here. Single player, no network, and the tests stay
//             fast.
//
// Screens never see the difference: every method returns a promise and the
// state they read is always the last thing the authority agreed to.
import * as rules from './rules.js'
import { saveSealed } from './save.js'

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

export function createFarm({ data, state, server = null, onChange = () => {}, onMilestones = () => {}, onRefused = () => {} }) {
  let current = state
  let revision = 0
  let inFlight = 0
  const pendingMilestones = []

  const notify = () => onChange(current)

  /**
   * One request at a time.
   *
   * Every intent carries the revision the browser believes the farm is on, and
   * the server refuses one that has fallen behind — which is exactly right, and
   * exactly what a second click produces while the first is still in the air:
   * both carry the same revision, the server accepts one and refuses the other,
   * and the player is told their click failed when it merely arrived second.
   *
   * Serialising them means the revision is always the one the last answer gave,
   * so a fast player queues rather than collides. It costs nothing — the farm
   * could only ever apply them one at a time anyway.
   */
  let queue = Promise.resolve()
  let waiting = 0
  const inOrder = (job) => {
    // Counted at the moment it joins the queue, not when it starts. Three clicks
    // in the same tick are three intents outstanding immediately, and anything
    // asking whether the farm is busy — a save, in particular — has to see them
    // before the first has even begun.
    waiting++
    const run = queue.then(job, job).finally(() => { waiting-- })
    // Failures must not poison the queue for everything behind them.
    queue = run.then(() => {}, () => {})
    return run
  }

  /** Wait for everything already queued, without joining the queue behind it. */
  const queueDrained = () => queue

  /**
   * Keep the saved envelope current.
   *
   * The server refuses a save older than the newest one the farm has produced —
   * that is what stops someone reloading yesterday's money with today's goods.
   * The consequence is that a save taken by hand goes stale the moment the
   * player does anything else, so pressing SAVE and then playing on left a slot
   * that would be refused on load. The envelope is therefore refreshed behind
   * the player after every accepted action, on a short delay so a burst of
   * clicks writes once.
   */
  let sealTimer = null
  let autoSeal = false
  const scheduleSeal = () => {
    if (!autoSeal || !server?.save) return
    clearTimeout(sealTimer)
    sealTimer = setTimeout(() => { api.seal({ quiet: true }) }, 1200)
  }

  /**
   * Take the farm the server sent, unless it is older than what we already hold.
   *
   * Screens sync when they open and do not block input while they wait, so a
   * slow answer to that sync can land after an action the player has already
   * taken. Adopting it unconditionally rolled the mirror backwards — the farm on
   * screen would lose a sale that the server had definitely accepted, until the
   * next request happened to correct it.
   */
  const adoptIfNewer = (res) => {
    if (!res?.state) return false
    const next = res.revision ?? revision
    if (next < revision) return false
    current = res.state
    revision = next
    return true
  }

  /**
   * Hand milestones to whoever is listening, and only then tell the server they
   * are settled.
   *
   * The server keeps them in an outbox and offers them again on every response
   * until acknowledged, which is what makes delivery at-least-once. Nothing was
   * acknowledging them, so the outbox grew for ever and every response carried
   * the whole history of the farm's rewards. Acknowledging BEFORE the handler
   * returned would be worse: a reward lost in a crash would never come back.
   */
  const settled = new Set()      // handed over and acknowledged: finished with
  const claimed = new Set()       // handed over, still being dealt with
  const unacked = new Set()       // handled, but the server has not agreed yet

  /** Did the server actually accept this? An error object is not a yes. */
  const accepted = (res) => !!res && !res.error && (res.status == null || (res.status >= 200 && res.status < 300))

  /** Tell the server what has been dealt with, and keep trying until it agrees. */
  async function flushAcks() {
    if (!unacked.size || !server?.ack) return
    // Where a host pays the rewards, settling them is the host's word and not
    // this browser's. The events are still shown; they are simply not ours to
    // mark as done, and the server keeps offering them until the host says so.
    if (server.mayAck === false) { unacked.clear(); return }
    const ids = [...unacked]
    try {
      const res = await server.ack(ids)
      // A refused acknowledgement is not an acknowledgement. Leaving the ids in
      // the settled set while the server still holds them meant the reward was
      // suppressed locally and never confirmed anywhere — lost from both ends.
      if (!accepted(res)) return
      ids.forEach(id => { unacked.delete(id); settled.add(id) })
    } catch { /* keep them; the next response will try again */ }
  }

  async function deliver(list) {
    if (!list?.length) return
    // Claim before awaiting the handler, not after. Two responses carrying the
    // same event can both pass a check that only looks at what has finished, and
    // then the reward is handed over twice.
    const fresh = list.filter(m => m.eventId && !settled.has(m.eventId) && !claimed.has(m.eventId) && !unacked.has(m.eventId))
    if (fresh.length) {
      const ids = fresh.map(m => m.eventId)
      ids.forEach(id => claimed.add(id))
      try {
        await onMilestones(fresh)
        ids.forEach(id => { claimed.delete(id); unacked.add(id) })
      } catch (err) {
        // The reward was not dealt with, so it stays owed and will be offered
        // again by the server on the next response.
        ids.forEach(id => claimed.delete(id))
        throw err
      }
    }
    await flushAcks()
  }

  /**
   * Deliver rewards without letting a failure there be mistaken for the action
   * failing. The event stays owed and the server will offer it again.
   */
  async function deliverSafely(list) {
    try { await deliver(list) } catch { onRefused('reward') }
  }

  /** Offline: run the rule and hand back the farm as it now stands. */
  const local = (fn) => async (...args) => {
    const result = fn(current, data, ...args)
    collectLocalMilestones()
    notify()
    await flushLocal()
    return result
  }

  /** Take what the rules just awarded into the queue that owes it onward. */
  function collectLocalMilestones() {
    for (const id of rules.takeMilestones(current)) pendingMilestones.push({ milestoneId: id })
  }

  /**
   * Offline there is no server holding an outbox, so this queue is the only
   * record that a reward is owed. Emptying it before the handler had finished —
   * and never catching a handler that threw — meant a reward could be dropped on
   * the floor with an unhandled rejection to show for it.
   */
  async function flushLocal() {
    if (!pendingMilestones.length) return
    const batch = pendingMilestones.slice()
    try {
      await onMilestones(batch)
      pendingMilestones.splice(0, batch.length)
    } catch {
      // Left where they are; the next action will offer them again.
      onRefused('reward')
    }
  }

  /**
   * Online: ask the server, and believe only what it says.
   *
   * A refusal that comes back without a farm attached — rate limited, session
   * gone, a stale revision — used to be swallowed here, so the player clicked
   * and nothing happened at all. Silence is the worst answer a game can give,
   * so the reason is handed up to be shown.
   */
  const remote = (type, payload = {}) => () => inOrder(async () => {
    inFlight++
    try {
      const res = await server.intent({ type, ...payload, expectedRevision: revision })
      // A stale revision comes back as a refusal WITH the farm attached, so
      // these are two questions, not one: take whatever the server sent, and
      // separately say so if it refused. Reading them as an either/or meant the
      // most common refusal of all was the one nobody was told about.
      adoptIfNewer(res)
      if (res.error) onRefused(res.error, res.status)
      // The farm the server sent is the farm, whatever the reward handler does
      // with its milestones. Notifying first is what stops a throwing handler
      // from looking like a refused action.
      notify()
      if (res.ok) scheduleSeal()
      // Deliberately not awaited inside the queue. onMilestones belongs to
      // whoever embedded this, and a handler that never returns would otherwise
      // hold up every click after it. Delivery has its own protection against
      // handing the same reward over twice.
      void deliverSafely(res.milestones)
      return res.ok
    } catch (err) {
      // A dropped connection is a refusal the player can see, not a crash.
      onRefused('offline')
      return false
    } finally {
      inFlight--
    }
  })

  const api = {
    get state() { return current },
    get data() { return data },
    get online() { return !!server },
    // Busy means there is an intent outstanding, whether it has started or is
    // still waiting its turn.
    get busy() { return inFlight > 0 || waiting > 0 },
    get revision() { return revision },

    /** Replace the mirror wholesale, e.g. after connecting or loading. */
    adopt(next, rev = 0) { current = next; revision = rev; notify() },

    /**
     * Ask the authority what is actually true and redraw from that.
     *
     * Screens call this when they open. Without it the browser keeps showing
     * whatever it last believed until the next action — which is merely stale
     * after a dropped request, but is also exactly what someone editing the
     * page in a console would see, and neither should survive changing screen.
     */
    async sync() {
      if (!server) return current
      try {
        const res = await server.state()
        if (adoptIfNewer(res)) notify()
        if (res.error) onRefused(res.error, res.status)
      } catch { onRefused('offline') }
      return current
    },

    // Each of these takes a plain object so the online and offline paths can
    // share one call site.
    plant: ({ plot, cropId }) => (server
      ? remote('plant', { plot, cropId })()
      : local(rules.plant)(plot, cropId)),
    tool: ({ plot, tile, toolId }) => (server
      ? remote('tool', { plot, tile, toolId })()
      : local(rules.applyTool)(plot, tile, toolId)),
    waterPlot: ({ plot }) => (server
      ? remote('waterPlot', { plot })()
      : local(rules.waterPlot)(plot)),
    harvestPlot: ({ plot }) => (server
      ? remote('harvestPlot', { plot })()
      : local(rules.harvestPlot)(plot)),
    buySeed: ({ cropId }) => (server
      ? remote('buySeed', { cropId })()
      : local(rules.buySeed)(cropId)),
    buySupply: ({ supplyId }) => (server
      ? remote('buySupply', { supplyId })()
      : local(rules.buySupply)(supplyId)),
    buyAnimal: ({ animalId }) => (server
      ? remote('buyAnimal', { animalId })()
      : local(rules.buyAnimal)(animalId)),
    sellCrop: ({ cropId, count }) => (server
      ? remote('sellCrop', { cropId, count })()
      : local(rules.sellCrop)(cropId, count)),
    sellGood: ({ goodId, count }) => (server
      ? remote('sellGood', { goodId, count })()
      : local(rules.sellGood)(goodId, count)),
    craft: ({ recipeId }) => (server
      ? remote('craft', { recipeId })()
      : local(rules.craft)(recipeId)),
    feed: ({ animalId }) => (server
      ? remote('feed', { animalId })()
      : local(rules.feedAnimals)(animalId)),
    travel: () => (server ? remote('travel')() : local(rules.travel)()),

    /** Ending the day is the only action that returns a report worth showing. */
    async endDay() {
      if (server) {
        return inOrder(async () => {
        inFlight++
        try {
          const res = await server.intent({ type: 'endDay', expectedRevision: revision })
          adoptIfNewer(res)
          if (res.error) onRefused(res.error, res.status)
          notify()
          if (!res.error) scheduleSeal()
          // The day has already happened as far as the server is concerned, so
          // a reward handler that throws must not turn the morning into a
          // refusal, and one that hangs must not hold up tomorrow.
          void deliverSafely(res.milestones)
          return res.report ?? { refused: res.error }
        } catch (err) {
          onRefused('offline')
          return { refused: 'offline' }
        } finally { inFlight-- }
        })
      }
      const report = rules.endDay(current, data, Math.random)
      collectLocalMilestones()
      notify()
      await flushLocal()
      return report
    },

    /**
     * From here on, keep the saved envelope up to date by itself. Called once
     * the game has a slot worth keeping — pressing SAVE — so a player who never
     * saves is never quietly given one.
     */
    keepSaved({ seal = true } = {}) {
      autoSeal = true
      // A farm resumed from an envelope is already saved at the revision it
      // resumed at, so there is nothing to write yet — only something to keep
      // writing from here on.
      return seal ? api.seal() : Promise.resolve(true)
    },

    /** A copy for saving locally; the server has its own signed version. */
    snapshot() { return clone(current) },

    /**
     * Ask the server to seal the farm, and keep the envelope.
     *
     * Only the server can produce one, and only the server can open it again —
     * which is the point: an online save the browser could write would be an
     * online save the browser could edit.
     */
    async seal({ quiet = false } = {}) {
      if (!server?.save) return false
      // Sealing mid-action would capture a farm the server is about to move on
      // from, and the envelope would be stale the moment it was written. So it
      // waits for everything already queued — including what has not started —
      // but does not take a place in the queue itself, because it is a read and
      // holding the lane for a network round trip would stall the game.
      await queueDrained()
      try {
        const res = await server.save()
        if (!res?.save || !res?.signature) {
          if (!quiet) onRefused(res?.error ?? 'offline')
          return false
        }
        return saveSealed(res)
      } catch {
        if (!quiet) onRefused('offline')
        return false
      }
    },
  }

  return api
}
