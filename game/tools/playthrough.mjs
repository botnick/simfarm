// A game actually played, start to finish, with nothing but clicks.
//
// Every other suite reaches into the farm to set up the situation it wants.
// This one does not touch the state at all: it opens the page, presses NEW GAME,
// and then plays — buying seeds it can afford, sowing fields, watering, picking,
// selling, feeding, ending the day — for as long as it is told to, and asks at
// the end whether a farm that was played actually grew.
//
// It is the only test here that would notice the game being no fun.
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 600, H = 420
const DAYS = Number(process.env.PLAY_DAYS || 24)
mkdirSync('shots/play', { recursive: true })

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const port = await new Promise((r) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => r(port)) })
})
const SERVER = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [join(HERE, '../../server/index.mjs')], {
  env: { ...process.env, PORT: String(port), SIMFARM_SECRET: 'playthrough'.padEnd(48, '-'), SIMFARM_ENDDAY_MS: '0', SIMFARM_SESSION_RATE_MAX: '10000' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve, reject) => {
  server.stdout.on('data', d => String(d).includes('farm server') && resolve())
  setTimeout(() => reject(new Error('server did not start')), 8000)
})

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 840 })
const errors = []
// Chrome logs every non-2xx fetch as a console error. A 409 is the server
// correctly refusing something, which is the game working, not a fault in it.
const expected = (t) => t.includes('favicon') || t.includes('409') || t.includes('429')
page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push(m.text()) })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

await page.evaluateOnNewDocument((url) => localStorage.setItem('simfarm.server', url), SERVER)
await page.goto(process.env.URL || 'http://localhost:5180/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2400))

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const box = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const click = async (sx, sy, ms = 420) => {
  await page.mouse.click(box.x + box.w * (sx / W), box.y + box.h * (sy / H))
  await wait(ms)
}
const key = async (k, ms = 600) => { await page.keyboard.press(k); await wait(ms) }
const farm = (expr) => page.evaluate(new Function(`const f = window.__game.registry.get('farm'); const s = f?.state; const d = window.__game.registry.get('data'); return (${expr})`))
const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))

/** Click a button by the words on it, wherever the layout has put it. */
const pressText = async (pattern, ms = 600) => {
  const at = await page.evaluate((p) => {
    const re = new RegExp(p)
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const hits = sc.children.list.filter(o => o.type === 'Text' && re.test(o.text) && o.alpha > 0.5)
    if (!hits.length) return null
    const t = hits[0]
    return { x: t.x, y: t.y }
  }, pattern)
  if (!at) return false
  await click(at.x, at.y, ms)
  return true
}

const home = async () => { for (let i = 0; i < 4 && await scene() !== 'Farm'; i++) await key('Escape') }

console.log(`\na game played for ${DAYS} days, by clicking\n`)

/* ------------------------------------------------------------------ start */
ok('the game opens on the menu', await scene() === 'Menu', await scene())
await click(208, 284, 1400)
ok('NEW GAME starts a farm', await scene() === 'Farm', await scene())
ok('and the server is the one holding it', await farm('f.online') === true)

const startMoney = await farm('s.money')
const startDay = await farm('s.day')
ok('with money to begin on', startMoney > 0, String(startMoney))

let bought = 0, sown = 0, watered = 0, picked = 0, sold = 0, fed = 0, crafted = 0
const trouble = []

for (let day = 0; day < DAYS; day++) {
  await home()

  /* ------------------------------------------------------- buy what we can */
  // A player goes to the village when they need something. The journey costs
  // energy, so not every day — but certainly on a day with empty fields and an
  // empty seed bag, because there is nothing else to do.
  const emptyFields = await farm('s.plots.filter(p => !p.cropId).length')
  const inBag = await farm('Object.values(s.seeds).reduce((a, b) => a + b, 0)')
  const needsSeed = emptyFields > 0 && inBag === 0 && await farm('s.money') > 0
  if (day % 3 === 0 || needsSeed) {
    await click(420, 300, 900)
    if (await scene() === 'Shop') {
      // Sell first, then buy: a farmer with a full barn and no money is not a
      // farmer with no money.
      await pressText('SELL|ขายของ', 600)
      for (let i = 0; i < 4; i++) if (!await pressText('^\\$ ', 450)) break
      await pressText('SEEDS|เมล็ด', 600)

      // Enough seed for the empty fields, and no more.
      const before = await farm('s.money')
      const empty = await farm('s.plots.filter(p => !p.cropId).length')
      const bag = await farm('Object.values(s.seeds).reduce((a, b) => a + b, 0)')
      for (let row = 0; row < Math.max(0, empty - bag); row++) {
        const priced = await page.evaluate((n) => {
          const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
          const buttons = sc.children.list
            .filter(o => o.type === 'Text' && /^\$ [\d,]+$/.test(o.text) && o.alpha > 0.9)
            .sort((a, b) => a.y - b.y)
          const t = buttons[n]
          return t ? { x: t.x, y: t.y } : null
        }, row)
        if (!priced) break
        await click(priced.x, priced.y, 380)
      }
      if (await farm('s.money') < before) bought++

      // A pack of pesticide when it can be afforded, because pests kill crops.
      await pressText('SUPPLIES|ของใช้', 500)
      await pressText('^\\$ ', 400)

      // A bird, once there is money spare. Livestock is the other half of the
      // game and a playthrough that never buys one never sees it.
      if (await farm('Object.values(s.animals).reduce((a, b) => a + b, 0)') < 2 && await farm('s.money') > 600) {
        await pressText('ANIMALS|สัตว์', 500)
        // The first priced button on the page may belong to an animal still
        // locked, so try each in turn until the flock actually grows.
        for (let row = 0; row < 4; row++) {
          const before = await farm('Object.values(s.animals).reduce((a, b) => a + b, 0)')
          const priced = await page.evaluate((n) => {
            const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
            const buttons = sc.children.list
              .filter(o => o.type === 'Text' && /^\$ [\d,]+$/.test(o.text))
              .sort((a, b) => a.y - b.y)
            return buttons[n] ? { x: buttons[n].x, y: buttons[n].y } : null
          }, row)
          if (!priced) break
          await click(priced.x, priced.y, 450)
          if (await farm('Object.values(s.animals).reduce((a, b) => a + b, 0)') > before) break
        }
      }

      // And the feed it will want.
      if (await farm('Object.values(s.animals).reduce((a, b) => a + b, 0)') > 0) {
        await pressText('SUPPLIES|ของใช้', 500)
        const feedRow = await page.evaluate(() => {
          const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
          const buttons = sc.children.list
            .filter(o => o.type === 'Text' && /^\$ [\d,]+$/.test(o.text) && o.alpha > 0.9)
            .sort((a, b) => a.y - b.y)
          return buttons[2] ? { x: buttons[2].x, y: buttons[2].y } : null
        })
        if (feedRow) await click(feedRow.x, feedRow.y, 400)
      }
      await pressText('BACK TO FARM|กลับไร่', 900)
    }
  }

  /* ------------------------------------------------------------ every field */
  await home()
  for (let f = 1; f <= 4; f++) {
    await key(`Digit${f}`, 700)
    if (await scene() !== 'Plot') continue

    const sownAlready = await farm(`s.plots[${f - 1}].cropId`)
    if (!sownAlready) {
      // Sow whatever is in the bag.
      await click(45, 378, 700)
      const seed = await page.evaluate(() => {
        const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
        const counts = sc.children.list.filter(o => o.type === 'Text' && /^x\d+$/.test(o.text))
        return counts.length ? { x: counts[0].x - 120, y: counts[0].y } : null
      })
      if (seed) { await click(seed.x, seed.y, 700); if (await farm(`s.plots[${f - 1}].cropId`)) sown++ }
      else await pressText('CANCEL|ยกเลิก', 400)
    }

    // Pick anything ripe, spray anything bitten, then water what is left.
    const before = await farm('Object.values(s.barn.crops).reduce((a, b) => a + b, 0)')
    await click(402, 13, 700)                    // PICK ALL
    const after = await farm('Object.values(s.barn.crops).reduce((a, b) => a + b, 0)')
    if (after > before) picked++

    const bitten = await farm(`s.plots[${f - 1}].tiles.filter(t => t.pest).length`)
    if (bitten && await farm('s.supplies.pesticide') > 0) {
      await key('Digit4', 300)
      const tiles = await page.evaluate(() => {
        const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
        return sc.tiles.map((t, i) => (t ? { i, x: t.c.x, y: t.c.y } : null)).filter(Boolean)
      })
      const state = await farm(`s.plots[${f - 1}].tiles.map(t => t.pest)`)
      for (const t of tiles) if (state[t.i]) await click(t.x, t.y, 220)
      await key('Digit2', 200)
    }

    const wetBefore = await farm(`s.plots[${f - 1}].tiles.filter(t => t.watered).length`)
    await click(278, 13, 700)                    // WATER ALL
    if (await farm(`s.plots[${f - 1}].tiles.filter(t => t.watered).length`) > wetBefore) watered++
    await home()
  }

  /* ------------------------------------------------------------------ coop */
  await key('KeyC', 700)
  if (await scene() === 'Coop') {
    const before = await farm('Object.values(s.fed).reduce((a, b) => a + b, 0)')
    await key('KeyF', 700)
    if (await farm('Object.values(s.fed).reduce((a, b) => a + b, 0)') > before) fed++
    if (await farm('Object.values(s.barn.goods).reduce((a, b) => a + b, 0)') > 0) {
      const money = await farm('s.money')
      await pressText('SELL|^ขาย$', 800)
      if (await farm('s.money') > money) sold++
    }
    await home()
  }

  /* -------------------------------------------------------------- workshop */
  if (day % 4 === 2) {
    await key('KeyK', 700)
    if (await scene() === 'Workshop') {
      const before = await farm('JSON.stringify(s.barn)')
      await pressText('MAKE|^ผลิต', 800)
      if (await farm('JSON.stringify(s.barn)') !== before) crafted++
      await home()
    }
  }

  /* ------------------------------------------------------------- sell up */
  if (await farm('Object.values(s.barn.crops).reduce((a, b) => a + b, 0)') > 8) {
    await click(420, 300, 900)
    if (await scene() === 'Shop') {
      await pressText('SELL|ขายของ', 700)
      const money = await farm('s.money')
      for (let i = 0; i < 4; i++) if (!await pressText('^\\$ ', 500)) break
      if (await farm('s.money') > money) sold++
      await pressText('BACK TO FARM|กลับไร่', 900)
    }
  }

  /* -------------------------------------------------------------- new day */
  // Sow whatever was just emptied before turning in. A farmer who leaves every
  // field bare and then asks for tomorrow is asking for a day in which nothing
  // happens, and the game is right to say so.
  for (let f = 1; f <= 4; f++) {
    if (await farm(`s.plots[${f - 1}].cropId`)) continue
    if (await farm('Object.values(s.seeds).reduce((a, b) => a + b, 0)') < 1) break
    await key(`Digit${f}`, 600)
    if (await scene() !== 'Plot') continue
    await click(45, 378, 600)
    const seed = await page.evaluate(() => {
      const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
      const counts = sc.children.list.filter(o => o.type === 'Text' && /^x\d+$/.test(o.text))
      return counts.length ? { x: counts[0].x - 120, y: counts[0].y } : null
    })
    if (seed) { await click(seed.x, seed.y, 600); if (await farm(`s.plots[${f - 1}].cropId`)) sown++ }
    else await pressText('CANCEL|ยกเลิก', 300)
    // Water what was just put in, so the night is worth having.
    await click(278, 13, 500)
    await home()
  }

  await home()
  const dayBefore = await farm('s.day')
  await click(522, 394, 1000)
  const dayAfter = await farm('s.day')
  if (dayAfter === dayBefore) trouble.push(`day ${dayBefore} would not end`)

  // Invariants, every single day of the game.
  const money = await farm('s.money')
  const energy = await farm('s.energy')
  if (!(money >= 0)) trouble.push(`day ${dayAfter}: money ${money}`)
  // A day's energy is not a constant: the farm grows with the level, so the
  // ceiling is whatever this farm has grown into.
  const room = await farm('window.__game.__rules.farmLimits(s, d).energy')
  if (!(energy >= 0 && energy <= room)) trouble.push(`day ${dayAfter}: energy ${energy} of ${room}`)
  const barnOk = await farm('Object.values(s.barn.crops).every(n => Number.isSafeInteger(n) && n >= 0)')
  if (!barnOk) trouble.push(`day ${dayAfter}: barn ${await farm('JSON.stringify(s.barn.crops)')}`)
}

await page.screenshot({ path: 'shots/play/farm.png' })

/* ---------------------------------------------------------------- the report */
const endDay = await farm('s.day')
const endMoney = await farm('s.money')
const endXp = await farm('s.xp')
const endLevel = await page.evaluate(() => window.__game.scene.scenes.find(x => x.scene.isActive())?.hud?.level ?? 1)

console.log(`\n  bought on ${bought} trips · sowed ${sown} fields · watered ${watered} · picked ${picked}`)
console.log(`  sold ${sold} times · fed ${fed} days · crafted ${crafted}`)
console.log(`  day ${startDay} -> ${endDay}, $${startMoney} -> $${endMoney}, level ${endLevel}, xp ${endXp}\n`)

ok('the calendar ran the whole way', endDay >= startDay + DAYS - 2, `${startDay} -> ${endDay}`)
ok('nothing ever went wrong on the farm', trouble.length === 0, trouble.slice(0, 4).join('; '))
ok('fields were sown by clicking', sown > 0, `${sown}`)
ok('crops were watered', watered > 0, `${watered}`)
ok('crops were picked', picked > 0, `${picked}`)
ok('and sold', sold > 0, `${sold}`)
ok('animals were fed', fed > 0, `${fed}`)
ok('the farmer ended up better off than he started', endMoney > startMoney, `${startMoney} -> ${endMoney}`)
ok('and learned something along the way', endXp > 0, `xp ${endXp}`)
ok('the farm is still online at the end', await farm('f.online') === true)
ok('and the server agrees what day it is',
  (await fetch(SERVER + '/state', { headers: { 'x-session': await page.evaluate(() => window.__serverSession) } })
    .then(r => r.json())).state.day === endDay)
ok('no console errors in the whole game', errors.length === 0, [...new Set(errors)].join(' | ').slice(0, 200))

await browser.close()
server.kill()
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
