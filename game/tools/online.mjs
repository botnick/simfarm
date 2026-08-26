// Plays the real game in a real browser against the real server.
//
// The offline suite proves the rules; this proves the wiring — that the browser
// sends intents, draws only what comes back, and that a farm played through the
// server ends up in the state the server says it is in.
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { onScreen } from './lib/onscreen.mjs'
import { killWith } from '../../server/lib-cleanup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 600, H = 420
mkdirSync('shots/online', { recursive: true })

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const port = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const SERVER = `http://127.0.0.1:${port}`

const server = killWith(spawn(process.execPath, [join(HERE, '../../server/index.mjs')], {
  env: { ...process.env, PORT: String(port), SIMFARM_SECRET: 'online-test'.padEnd(48, '-'), SIMFARM_ENDDAY_MS: '0', SIMFARM_TEST_HOOKS: '1', SIMFARM_SESSION_RATE_MAX: '10000' },
  stdio: ['ignore', 'pipe', 'inherit'],
}))
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('farm server') && resolve())
  setTimeout(() => reject(new Error('server did not start')), 8000)
})

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 840 })
const errors = []
// The rate-limit test provokes 429s on purpose, and Chrome logs every failed
// fetch as a console error. Those are the browser reporting the network, not the
// game reporting a fault.
const expected = (text) => text.includes('favicon') || text.includes('429')
page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push(m.text()) })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

// Point the game at the server before any script runs.
await page.evaluateOnNewDocument((url) => {
  localStorage.setItem('simfarm.server', url)
  localStorage.setItem('simfarm.greeted', '1')
}, SERVER)
await page.goto(process.env.URL || 'http://localhost:5180/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2400))

const box = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const click = async (sx, sy, wait = 550) => {
  await page.mouse.click(box.x + box.w * (sx / W), box.y + box.h * (sy / H))
  await new Promise(r => setTimeout(r, wait))
}
const { find, findButton, texts } = onScreen(page)
/** Press the thing on screen that says this. Fails the run if it is not there. */
const press = async (re, wait = 700) => {
  const at = await findButton(re) ?? await find(re)
  if (!at) { ok(`something on screen says ${re}`, false, JSON.stringify(await texts())); return false }
  await click(at.x, at.y, wait)
  return true
}
const farm = (expr) => page.evaluate(new Function(`const f = window.__game.registry.get('farm'); const s = f?.state; return (${expr})`))
const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
const ask = (path, body) => fetch(SERVER + path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-session': sessionId },
  body: JSON.stringify(body ?? {}),
}).then(r => r.json())

console.log(`\nonline: browser -> ${SERVER}\n`)

await click(208, 284, 900)                                  // NEW GAME
eq('the game starts on the farm', await scene(), 'Farm')
ok('and is playing online', await farm('f.online') === true)
const sessionId = await page.evaluate(() => window.__game.registry.get('farm') && localStorage.getItem('simfarm.server') && window.__serverSession)

// The server is the authority: read it directly and compare.
const serverState = async () => (await fetch(SERVER + '/state', { headers: { 'x-session': await page.evaluate(() => window.__serverSession) } }).then(r => r.json())).state

const startMoney = await farm('s.money')
eq('the browser shows the money the server gave it', startMoney, (await serverState()).money)

/* ------------------------------------------------------------ buying */
await click(420, 300, 800)                                  // road to the village
eq('the shop opens', await scene(), 'Shop')
const beforeBuy = await farm('s.money')
await click(1032 * W / 1200, 289 * H / 840, 700)            // buy the first seed
const afterBuy = await farm('s.money')
ok('buying takes money', afterBuy < beforeBuy, `${beforeBuy} -> ${afterBuy}`)
eq('and the server agrees', afterBuy, (await serverState()).money)
await click(524, 396, 700)

/* ----------------------------------------------------------- planting */
await click(158, 263, 700)
eq('a field opens', await scene(), 'Plot')
await click(45, 378, 500)
await click(300, 128, 800)
const crop = await farm('s.plots[0].cropId')
ok('the field is sown', !!crop, String(crop))
eq('and the server has the same field', (await serverState()).plots[0].cropId, crop)

/* ------------------------------------------------------------ working */
await press(/WATER ALL|รดน้ำทั้งแปลง/, 800)
const watered = await farm('s.plots[0].tiles.filter(t => t.watered).length')
eq('every tile is watered', watered, 12)
eq('and the server counted the energy', (await serverState()).energy, await farm('s.energy'))

/* ---------------------------- the screen must not confirm what was refused */
// Whether a tool may be used is asked of the browser's own copy of the farm,
// which is only ever what it last heard. The two can disagree — two quick
// clicks, an answer still in flight — and then the check passes while the
// server still says no. The tile used to ring and the sound used to play
// regardless, which is the game reporting something that did not happen.
//
// The disagreement is arranged rather than raced for, so this either passes or
// fails rather than doing it one time in ten. Nothing about the refusal is
// faked: the field really is watered, and the server really does refuse.
{
  const before = await serverState()
  eq('the field is watered as far as the server is concerned',
    before.plots[0].tiles.filter(t => t.watered).length, 12)

  await page.evaluate(() => {
    // The browser is told the field is dry. The server knows better.
    const f = window.__game.registry.get('farm')
    f.state.plots[0].tiles.forEach(t => { t.watered = 0 })
    window.__cues = []
    const sm = window.__game.sound
    if (!sm.__counted) {
      sm.__counted = true
      const real = sm.play.bind(sm)
      sm.play = (key, opts) => { window.__cues.push(key); return real(key, opts) }
    }
  })
  await click(239.5, 368, 300)                  // the water tool
  await page.evaluate(() => { window.__cues.length = 0 })
  await click(60, 223, 900)                     // the first tile

  const after = await serverState()
  eq('the server did not water it twice', after.plots[0].tiles.filter(t => t.watered).length, 12)
  eq('and charged nothing for the refusal', after.energy, before.energy)
  const cues = await page.evaluate(() => window.__cues.slice())
  const waterCue = await page.evaluate(() => window.__game.registry.get('data').audio.toolCue.water)
  ok('the watering sound did not play for a watering that did not happen',
    !cues.includes(`sfx:${waterCue}`), JSON.stringify(cues))
  // Saying nothing at all would be its own bug: silence is how a game looks
  // broken. The refusal is announced, it is simply not announced as a success.
  ok('and the refusal was announced instead', cues.includes('sfx:refused'), JSON.stringify(cues))
  // Put the browser back on the server's version of events.
  await page.evaluate(() => window.__game.registry.get('farm').sync())
  await new Promise(r => setTimeout(r, 300))
}

await click(547, 364, 600)                                   // home
const dayBefore = await farm('s.day')
await click(522, 394, 900)                                   // END DAY
eq('the day advanced', await farm('s.day'), dayBefore + 1)
eq('and the server is on the same day', (await serverState()).day, await farm('s.day'))
await page.screenshot({ path: 'shots/online/1-farm.png' })

/* --------------------------------- an impatient player, before there is a farm */
// Opening a farm is a network round trip, and NEW GAME is one tap away from
// being two. Both taps asked the server for a session, both got one, and the
// game went to whichever answer came back last — leaving a farm alive that
// nobody was playing. Counted from the server's side, because the browser can
// only ever show one of them.
{
  const fresh = await browser.newPage()
  await fresh.setViewport({ width: 1200, height: 840 })
  await fresh.evaluateOnNewDocument((url) => {
    localStorage.setItem('simfarm.server', url)
    localStorage.setItem('simfarm.greeted', '1')
    // Count the asks at the source. The server deliberately tells a stranger
    // nothing about how many farms it is holding, and this is the question
    // anyway: did the browser ask twice?
    window.__opened = 0
    const real = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (url.endsWith('/session')) window.__opened++
      return real(input, init)
    }
  }, SERVER)
  await fresh.goto(process.env.URL || 'http://localhost:5180/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  const fbox = await fresh.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const spot = [fbox.x + fbox.w * (208 / W), fbox.y + fbox.h * (284 / H)]
  await fresh.mouse.click(...spot)
  await fresh.mouse.click(...spot)                            // no waiting in between
  await new Promise(r => setTimeout(r, 2000))
  const where = await fresh.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
  eq('a double tap still opens the farm', where, 'Farm')
  eq('and asks the server for one farm, not two', await fresh.evaluate(() => window.__opened), 1)
  const holding = await fresh.evaluate(() => !!window.__serverSession)
  ok('and the browser is holding a session', holding)
  await fresh.close()
}

/* ------------------------------------------ an impatient player, over a network */
// Two presses before the first answer arrives. Both carry the revision the
// browser believed at the time, so the second is stale and the server refuses
// it — correctly, but a refusal toast landing next to the new morning tells the
// player something went wrong when nothing did. The screen ignores the second
// press instead, and this is the only place that can prove it: offline there is
// no gap between the press and the answer to press in.
{
  const dayBefore = await farm('s.day')
  const box2 = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const at = [box2.x + box2.w * (522 / W), box2.y + box2.h * (394 / H)]
  await page.mouse.click(...at)
  await page.mouse.click(...at)                               // no waiting in between
  await new Promise(r => setTimeout(r, 1600))
  eq('two presses in a row advance one day, not two', await farm('s.day'), dayBefore + 1)
  const shouting = await texts()
  ok('and the player is not told anything went wrong',
    !shouting.some(x => /nothing to do|ยังไม่มีอะไร|offline/i.test(x)), JSON.stringify(shouting))
  eq('and the server is on that same day', (await serverState()).day, await farm('s.day'))
}

/* ------------------------------------------------ the client cannot lie */
// Rewrite the browser's copy and prove the next answer from the server wipes it.
await page.evaluate(() => { window.__game.registry.get('farm').state.money = 999999 })
eq('a tampered browser shows the lie for a moment', await farm('s.money'), 999999)
await click(158, 263, 500)
await click(547, 364, 800)
const afterSync = await farm('s.money')
ok('but the next answer from the server replaces it', afterSync !== 999999, `still ${afterSync}`)
eq('and matches the server exactly', afterSync, (await serverState()).money)
await page.screenshot({ path: 'shots/online/2-after-tamper.png' })

/* ------------------------------------------------------- the market board */
// The board reads the week's orders and the saturation counters, both of which
// live on the server. Delivering has to be an intent like anything else — the
// premium must be the server's arithmetic, not the browser's.
await click(420, 300, 800)                                   // to the village
eq('the shop opens again', await scene(), 'Shop')
await click(92, 396, 800)                                    // MARKET
eq('the market board opens', await scene(), 'Market')

const board = await farm('s.market')
const fromServer = (await serverState()).market
eq('the browser shows the server\'s week', board.week, fromServer.week)
eq('and the server\'s orders', board.orders.map(o => o.cropId), fromServer.orders.map(o => o.cropId))

const openIdx = board.orders.findIndex(o => o.filled < o.quota)
// Everything worth knowing about delivering is inside this block, so a week
// that arrived with every order already filled would have skipped the lot and
// still come out green.
ok('the week still has an order open', openIdx >= 0, JSON.stringify(board.orders))
if (openIdx >= 0) {
  const order = board.orders[openIdx]
  const need = order.quota - order.filled
  // Stock the barn on the server, not in the browser: a client that could fill
  // its own barn would make the rest of this test meaningless.
  await ask('/test/grant', { crops: { [order.cropId]: need } })
  await page.evaluate(() => window.__game.scene.getScene('Market').farm.sync().then(
    () => window.__game.scene.getScene('Market').render()))
  await new Promise(r => setTimeout(r, 500))
  eq('the barn the server filled shows on the board', await farm(`s.barn.crops['${order.cropId}']`), need)

  const before = await farm('s.money')
  // Only the card we just stocked can say DELIVER: a finished order says it is
  // delivered and an unstocked one says nothing is held. So the words alone
  // identify the right card, and no copy of the board's layout is needed here.
  const delivered = await press(/^(Deliver|ส่ง) /, 900)
  ok('the order card offers a delivery', delivered)

  const after = await farm('s.money')
  const paid = after - before
  const flat = await page.evaluate((id, k) => {
    const d = window.__game.registry.get('data')
    return d.crops.find(c => c.id === id).sellPrice * k
  }, order.cropId, need)
  ok('delivering paid the order premium', paid > flat, `paid ${paid} vs flat ${flat}`)
  eq('and the server paid exactly that', after, (await serverState()).money)
  eq('the server recorded the order as filled', (await serverState()).market.orders[openIdx].filled, order.quota)
  eq('and the barn is empty on the server', (await serverState()).barn.crops[order.cropId] ?? 0, 0)
}
await page.screenshot({ path: 'shots/online/3-market.png' })

// A browser that edits the board must not be believed either.
await page.evaluate(() => {
  const f = window.__game.registry.get('farm')
  f.state.market.orders.forEach(o => { o.filled = 0; o.quota = 1 })
})
await click(76, 396, 700)                                    // back to the shop
await click(92, 396, 800)                                    // and into the market again
const reread = await farm('s.market.orders.map(o => o.quota)')
eq('an edited board is replaced by the server\'s', reread, (await serverState()).market.orders.map(o => o.quota))

/* ----------------------------------- the price the board quotes is the real one */
// Saturation is the one rule that makes a price fall while nothing else about
// the farm has changed, which is exactly why a player reads it as a bug. The
// number on the button is drawn by the browser out of its own copy of the
// rules; the money is paid by the server out of its copy. If those two ever
// disagree the farm is quoting a price it will not honour, and no other test
// here would notice — both halves would still be internally consistent.
{
  const id = await page.evaluate(() => window.__game.registry.get('data').crops[0].id)
  const reload = async () => {
    await page.evaluate(() => {
      const m = window.__game.scene.getScene('Market')
      return m.farm.sync().then(() => m.render())
    })
    await new Promise(r => setTimeout(r, 500))
  }

  await ask('/test/grant', { crops: { [id]: 20 } })
  await reload()
  const first = await findButton(/^\$ [\d,]+$/)
  ok('the board offers a price for what the barn holds', !!first, JSON.stringify(await texts()))
  const quotedFirst = Number(first.text.replace(/\D/g, ''))
  const beforeFirst = await farm('s.money')
  await click(first.x, first.y, 900)
  eq('the server pays exactly what the board quoted', await farm('s.money') - beforeFirst, quotedFirst)
  eq('and the browser ends up on the server\'s money', await farm('s.money'), (await serverState()).money)
  eq('the crop left the barn on the server', (await serverState()).barn.crops[id] ?? 0, 0)

  // Now the same crop again, same quantity. Twenty of it have just gone to
  // market, so the second load must fetch less than the first — and the board
  // has to say so before the sale, not after it.
  await ask('/test/grant', { crops: { [id]: 20 } })
  await reload()
  const floodedBefore = (await serverState()).market.sold[id] ?? 0
  const second = await findButton(/^\$ [\d,]+$/)
  ok('the board prices the second load too', !!second, JSON.stringify(await texts()))
  const quotedSecond = Number(second.text.replace(/\D/g, ''))
  ok('flooding the market shows a lower price for the same crop',
    quotedSecond < quotedFirst, `${quotedFirst} then ${quotedSecond}`)
  const beforeSecond = await farm('s.money')
  await click(second.x, second.y, 900)
  eq('and the server pays that lower price to the coin',
    await farm('s.money') - beforeSecond, quotedSecond)
  // Units that fill an open order are bought at a premium rather than dumped on
  // the market, so they deliberately do not count as flooding it. Only what is
  // left over does — which is why this measures the change rather than the
  // total, and why an earlier version of it passed on some weeks and not others
  // depending on whether that crop happened to be on the board.
  const floodedAfter = (await serverState()).market.sold[id] ?? 0
  ok('the server counted what the market could not absorb',
    floodedAfter > floodedBefore, `${floodedBefore} -> ${floodedAfter}`)
  await page.screenshot({ path: 'shots/online/4-saturation.png' })
}

/* -------------------------------------- a sale the rescue loan swallows whole */
// The loan is repaid off the top, so a sale can keep no money and still be a
// real change to the farm. The server has to count it as one, or the browser is
// told nothing happened while the barn quietly empties behind it.
{
  const crop = await page.evaluate(() => window.__game.registry.get('data').crops[0].id)
  await ask('/test/grant', { crops: { [crop]: 1 }, debt: 100000 })
  const before = (await serverState())
  const revBefore = await page.evaluate(() => window.__game.registry.get('farm').revision)

  const res = await ask('/intent', { type: 'sellCrop', cropId: crop, count: 1, expectedRevision: revBefore })
  ok('the server accepts a sale the loan swallows', res.ok === true, JSON.stringify(res).slice(0, 160))
  eq('and moves the revision on', res.revision > revBefore, true)
  const after = await serverState()
  eq('the crop really did leave the barn', after.barn.crops[crop] ?? 0, 0)
  ok('the debt shrank', (after.debt ?? 0) < (before.debt ?? 0), `${before.debt} -> ${after.debt}`)
  eq('and no money was invented', after.money, before.money)
}

/* --------------------------------------------- saving and loading, for real */
// SAVE used to write the browser's own view of an online farm to localStorage,
// and LOAD used to start a brand-new server farm with the old name. It looked
// like persistence and was not.
{
  await click(76, 396, 500)                                  // back to the shop
  await click(524, 396, 700)                                 // and out to the farm
  eq('back on the farm', await scene(), 'Farm')

  const day = await farm('s.day')
  const money = await farm('s.money')
  await click(522, 358, 900)                                 // SAVE
  const slot = await page.evaluate(() => JSON.parse(localStorage.getItem('simfarm') || 'null'))
  ok('an online save is the server\'s sealed envelope', !!slot?.sealed?.save && !!slot?.sealed?.signature,
    JSON.stringify(slot).slice(0, 140))
  ok('and the browser cannot read a farm out of it to edit',
    slot?.state === undefined, JSON.stringify(Object.keys(slot ?? {})))

  // Keep playing after saving. The server refuses an envelope older than the
  // farm's newest revision, so a save taken once and left behind would be
  // refused on load — which is exactly what "press save then carry on" does.
  const beforeMore = await farm('s.money')
  await page.evaluate(() => window.__game.registry.get('farm').buySeed({ cropId: 'turnip' }))
  await new Promise(r => setTimeout(r, 2200))          // let the envelope catch up
  const played = await farm('s.money')
  ok('playing on after saving actually changed the farm', played !== beforeMore, `${beforeMore} -> ${played}`)
  const refreshed = await page.evaluate(() => JSON.parse(localStorage.getItem('simfarm') || 'null'))
  ok('and the saved envelope kept up with it',
    refreshed?.sealed?.save?.revision > slot.sealed.save.revision,
    `${slot.sealed.save.revision} -> ${refreshed?.sealed?.save?.revision}`)

  // Reload the page and resume from that slot alone.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  eq('the game comes back to the menu', await scene(), 'Menu')
  await click(392, 284, 1400)                                // LOAD GAME
  eq('loading opens the farm', await scene(), 'Farm')
  eq('and it is the same day', await farm('s.day'), day)
  eq('with the money it had when the page went', await farm('s.money'), played)
  ok('and it is still the server that owns it', await farm('f.online') === true)
  eq('the server agrees it is that farm', (await serverState()).day, day)

  // A resumed farm keeps saving itself. Making the player press SAVE again
  // after every reload would lose the next session to the first crash — and the
  // only way to see that is to load twice, because the first load always works.
  const resumedAt = await page.evaluate(() => JSON.parse(localStorage.getItem('simfarm')).sealed.save.revision)
  await page.evaluate(() => window.__game.registry.get('farm').buySeed({ cropId: 'turnip' }))
  await new Promise(r => setTimeout(r, 2200))
  const nowAt = await page.evaluate(() => JSON.parse(localStorage.getItem('simfarm')).sealed.save.revision)
  ok('a resumed farm goes on saving itself', nowAt > resumedAt, `${resumedAt} -> ${nowAt}`)
  const playedOn = await farm('s.money')

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  await click(392, 284, 1600)
  eq('and can be loaded a second time', await scene(), 'Farm')
  eq('with what was played after the first load', await farm('s.money'), playedOn)
}

/* ------------------------------ LOAD only offers what this session can open */
{
  // Online the server will not take an unsigned farm from a browser, so a plain
  // offline save in the slot is not something LOAD can open. Offering it anyway
  // meant the button quietly started a new game instead.
  await page.evaluate(() => {
    localStorage.setItem('simfarm', JSON.stringify({ v: 1, savedAt: Date.now(), state: { day: 99, money: 1 } }))
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  eq('back at the menu', await scene(), 'Menu')
  const offered = await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    // The disabled tone is the grey one, and the label keeps its own alpha.
    const t = sc.children.list.find(o => o.type === 'Text' && /LOAD|โหลด/.test(o.text))
    return t ? t.alpha : null
  })
  ok('an offline save is not offered to an online game', offered != null && offered < 1, String(offered))
  await click(392, 284, 1200)
  eq('and pressing it does not start a new farm', await scene(), 'Menu')
}

/* ---------------------------------------- a refusal the player can actually see */
// The server rate-limits on purpose. What it must never do is leave the browser
// silent — a click that does nothing and says nothing reads as a broken game.
{
  // The previous block left the page at the menu, so start a farm to be refused.
  await click(208, 284, 1600)
  eq('a fresh farm to be refused with', await scene(), 'Farm')
  const before = await farm('s.money')

  // Spend this player's own budget. The limiter counts per session now, so
  // hammering the address would not touch the farm at all.
  await page.evaluate(async (url) => {
    const id = window.__serverSession
    for (let i = 0; i < 360; i += 20) {
      await Promise.all(Array.from({ length: 20 }, () =>
        fetch(`${url}/state`, { headers: { 'x-session': id } }).catch(() => {})))
    }
  }, SERVER)
  await page.evaluate(() => window.__game.registry.get('farm').buySeed({ cropId: 'turnip' }))
  await new Promise(r => setTimeout(r, 300))

  const said = await page.evaluate(() => window.__game.registry.get('refusal'))
  ok('a rate-limited click is reported, not swallowed', !!said, JSON.stringify(said))
  eq('and it says why', said?.reason, 'slow down')
  ok('and the browser did not invent any money', await farm('s.money') <= before,
    `${before} -> ${await farm('s.money')}`)
}

/* ------------------------ a game and a server running different rules */
// Both sides load their own copy of game.json, and a host can deploy one without
// the other. Being shown prices the server does not agree with is a worse thing
// to hand a player than an error.
{
  await page.evaluate(() => {
    localStorage.clear()
    // Change the browser's rule book after it loads, the way a stale deploy
    // would have it differ from the server's.
    window.__forceDataDrift = true
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  await page.evaluate(() => {
    const d = window.__game.registry.get('data')
    d.crops[0].seedPrice += 7
  })
  await click(208, 284, 1800)
  eq('a game whose rules differ from the server does not start', await scene(), 'Menu')
  const said = await page.evaluate(() => window.__game.registry.get('refusal'))
  eq('and says exactly that', said?.reason, 'ruleMismatch')
}

ok('no console errors', errors.length === 0, [...new Set(errors)].join(' | '))

await browser.close()
server.kill()
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
