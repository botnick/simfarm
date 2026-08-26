// The game played with the rule book the original shipped with.
//
// Three systems here are things the Flash game did not have — a workshop, a
// market board, and levels to unlock things at — and all three are data, so the
// screens ask the rule book what it contains before offering it. That was
// proved by testing the asking, which is not the same as proving the game is
// playable once the answer is no. A door that is correctly not drawn is only
// half of it: the farm still has to be a farm afterwards.
//
// So this builds the original's rule book out of the shipped one, serves a copy
// of the built game with that book in place of its own, and plays a year in it.
// Nothing in the repository is touched — the substitution happens in a copy.
//
//   npm run build && npm run faithful
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { readFile, writeFile, cp } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { checkData, has } from '../src/core/rules.js'
import { ensureDist } from './lib/dist.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '../dist')
ensureDist()
const W = 600, H = 420

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/** The eight crops the original's seed screen listed, in its order. */
const ORIGINAL_CROPS = ['turnip', 'carrot', 'potato', 'tomato', 'corn', 'strawberry', 'grape', 'watermelon']

/** The shipped rule book, reduced to what the Flash game actually had. */
function faithful(full) {
  const d = structuredClone(full)
  const byId = Object.fromEntries(d.crops.map(c => [c.id, c]))
  d.crops = ORIGINAL_CROPS.map(id => { const c = byId[id]; delete c.unlockLevel; return c })
  d.animals = d.animals.filter(a => a.id === 'chicken').map(a => ({ ...a, feed: 'grain', unlockLevel: undefined }))
  d.animals.forEach(a => delete a.unlockLevel)
  d.goods = d.goods.filter(g => g.id === 'egg')
  d.recipes = []
  d.supplies = d.supplies.filter(s => ['fertilizer', 'pesticide', 'grain'].includes(s.id))
  d.rules.market.orderCount = 0
  // Taking the orders away is not the same as taking the market away. Selling
  // the same crop over and over still walked the price tiers, so the price
  // still fell — with the board hidden, and with it the only screen that
  // explains why. The original had one price per crop and kept it, which is one
  // tier that never steps down.
  d.rules.market.tiers = [{ upTo: null, multiplier: 1 }]
  d.rules.endDay = 365                       // "manage your farm field in 1 year"
  d.milestones = []
  d.progression.milestoneEvery = 0
  // `grants`, plural — which is what the rule book calls it and what
  // `farmLimits` reads. Zeroing a `grant` that does not exist left the farm
  // growing four energy every four levels in a rule book that was supposed to
  // have no levels at all, and this suite reported it as having none while it
  // quietly did.
  for (const key of Object.keys(d.progression.grants ?? {})) {
    if (!key.startsWith('_')) d.progression.grants[key] = 0
  }
  return d
}

/** A farm with nothing to keep: crops only, no coop, no workshop, no board. */
function cropsOnly(full) {
  const d = faithful(full)
  d.animals = []
  d.goods = []
  d.supplies = d.supplies.filter(x => ['fertilizer', 'pesticide'].includes(x.id))
  return d
}

const full = JSON.parse(await readFile(join(HERE, '../public/data/game.json'), 'utf8'))
const book = faithful(full)

console.log('\nfaithful: the game with the rule book the original shipped with\n')

// A rule book the server would refuse is not a rule book, whatever it leaves out.
eq('the reduced rule book hangs together', checkData(book), [])
eq('and the screens know what it has', has(book), { workshop: false, market: false, animals: true, levels: false })
eq('eight crops', book.crops.length, 8)
eq('one animal', book.animals.map(a => a.id), ['chicken'])
eq('and a year to play it in', book.rules.endDay, 365)

// Serve a copy of the built game with that book in place of its own.
const dir = mkdtempSync(join(tmpdir(), 'simfarm-faithful-'))
await cp(DIST, dir, { recursive: true })
await writeFile(join(dir, 'data/game.json'), JSON.stringify(book))

const port = await new Promise(r => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => r(port)) })
})
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const site = httpServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  // The type comes off the file that is actually sent, not off the request: the
  // root has no extension at all, so asking the request gave index.html away as
  // a stream of bytes and the browser downloaded it rather than opening it.
  const file = join(dir, path === '/' ? '/index.html' : path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404).end('not here') }
})
await new Promise(r => site.listen(port, '127.0.0.1', r))

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 840 })
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text().slice(0, 160)) })
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('simfarm.server', '')
  localStorage.setItem('simfarm.greeted', '1')
})
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2600))

const box = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const click = async (sx, sy, wait = 700) => {
  await page.mouse.click(box.x + box.w * (sx / W), box.y + box.h * (sy / H))
  await new Promise(r => setTimeout(r, wait))
}
const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
const read = (expr) => page.evaluate(new Function(`
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data'); return (${expr})
`))
const poke = (body) => page.evaluate(new Function(`
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data'); ${body}
`))
const texts = () => page.evaluate(() => {
  const out = []
  for (const sc of window.__game.scene.scenes) {
    if (!sc.scene.isActive()) continue
    sc.children.list.forEach(o => { if (o.type === 'Text' && o.visible && o.text) out.push(o.text) })
  }
  return out
})

await click(208, 284, 1200)
eq('a farm opens', await scene(), 'Farm')
eq('with the eight crops and nothing else', await read('d.crops.length'), 8)

// The three doors that should not be there.
const onFarm = await texts()
ok('the farm shows no level', !onFarm.some(x => /^LEVEL$/i.test(x) || /XP/.test(x)), JSON.stringify(onFarm))
await click(141, 74, 800)                                     // where the workshop door was
eq('the house does not open a workshop', await scene(), 'Farm')
await page.keyboard.press('KeyK')
await new Promise(r => setTimeout(r, 600))
eq('and neither does the key for it', await scene(), 'Farm')

await click(420, 300, 900)
eq('the village still opens', await scene(), 'Shop')
const inShop = await texts()
ok('the shop offers no market board', !inShop.some(x => /MARKET|ตลาด/i.test(x)), JSON.stringify(inShop))
await page.keyboard.press('KeyM')
await new Promise(r => setTimeout(r, 600))
eq('nor does the key for it', await scene(), 'Shop')
await page.screenshot({ path: 'shots/faithful-shop.png' })

// And then the part that matters: it is still a farm.
// The farm does not quietly grow. `farmLimits` reads the grants, and zeroing
// them in the rule book has to mean the day stays the size it started.
const dayOne = await read('JSON.stringify(g.__rules.farmLimits(s, d))')
await poke('s.xp = 100000')
eq('a farm with nothing to level for does not grow anyway',
  await read('JSON.stringify(g.__rules.farmLimits(s, d))'), dayOne)
await poke('s.xp = 0')

// One price per crop, kept. With the board hidden, a price that fell would fall
// with nothing on any screen to explain it.
const priced = await read(`(() => {
  const id = d.crops[0].id
  const one = g.__rules.quoteCrop(s, d, id, 1).total
  const forty = g.__rules.quoteCrop(s, d, id, 40).total
  return { one, forty, flat: forty === one * 40 }
})()`)
ok('and the price does not fall however much is sold', priced.flat, JSON.stringify(priced))

const before = await read('s.money')
await click(1032 * W / 1200, 289 * H / 840, 800)
ok('a seed can be bought', await read('s.money') < before, `${before} -> ${await read('s.money')}`)
await click(524, 396, 700)
await click(158, 263, 800)
eq('a field opens', await scene(), 'Plot')
await click(45, 378, 600); await click(300, 128, 900)
ok('and is sown', !!await read('s.plots[0].cropId'))
await click(352, 14, 900)
eq('watering works', await read('s.plots[0].tiles.filter(t => t.watered).length'), 12)
await click(547, 364, 700)
await click(522, 394, 1200)
ok('the day ends', await read('s.day') > 1)

await poke('s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.ripe })')
// Read before picking, not after: the last picking of a single-harvest crop
// empties the field and hands it back, so the crop's name is gone by then.
const sown = await read('s.plots[0].cropId')
await click(158, 263, 800)
await click(456, 13, 900)                                     // PICK ALL
ok('a crop can be picked', await read(`(s.barn.crops['${sown}'] ?? 0) > 0`), `barn holds ${JSON.stringify(await read('s.barn.crops'))}`)
eq('and the field goes back on the market', await read('s.plots[0].cropId'), null)
await click(547, 364, 700)
await poke('s.energy = 100')
await click(420, 300, 900)
await click(514, 94, 600)
const held = await read('Object.values(s.barn.crops).reduce((a, b) => a + b, 0)')
ok('and sold', held > 0, `${held} in the barn`)
await page.screenshot({ path: 'shots/faithful-farm.png' })

// The original ended after a year, and said so.
await click(524, 396, 700)
await poke('s.day = d.rules.endDay - 1; s.energy = 100; s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed })')
await click(522, 394, 1400)
eq('and the year comes to an end', await scene(), 'End')
await page.screenshot({ path: 'shots/faithful-end.png' })

ok('no console errors so far', errors.length === 0, [...new Set(errors)].join(' | '))

/* ------------------------------------------ and a farm with nothing to keep */
// The reduction somebody reusing this is most likely to want next: crops only.
// The coop is data as much as the workshop is, and leaving it in place gave a
// door onto an empty room, a tab selling nothing, and a line on the farm
// counting a herd that could not exist.
{
  const only = cropsOnly(full)
  eq('a crops-only rule book hangs together', checkData(only), [])
  eq('and the screens know there is no flock', has(only).animals, false)
  await writeFile(join(dir, 'data/game.json'), JSON.stringify(only))

  const p2 = await browser.newPage()
  await p2.setViewport({ width: 1200, height: 840 })
  const said = []
  p2.on('pageerror', e => said.push(`pageerror: ${e.message}`))
  p2.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) said.push(m.text().slice(0, 160)) })
  await p2.evaluateOnNewDocument(() => {
  localStorage.setItem('simfarm.server', '')
  localStorage.setItem('simfarm.greeted', '1')
})
  await p2.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2600))
  const b2 = await p2.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const tap = async (sx, sy, wait = 700) => {
    await p2.mouse.click(b2.x + b2.w * (sx / W), b2.y + b2.h * (sy / H))
    await new Promise(r => setTimeout(r, wait))
  }
  const where = () => p2.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
  const words = () => p2.evaluate(() => {
    const out = []
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      sc.children.list.forEach(o => { if (o.type === 'Text' && o.visible && o.text) out.push(o.text) })
    }
    return out
  })

  await tap(208, 284, 1200)
  eq('a farm with no flock opens', await where(), 'Farm')
  const onIt = await words()
  ok('and says nothing about a herd', !onIt.some(x => /animals|สัตว์/i.test(x)), JSON.stringify(onIt))
  await tap(337, 31, 800)                                     // where the coop was
  eq('the coop is not there to walk into', await where(), 'Farm')
  await p2.keyboard.press('KeyC')
  await new Promise(r => setTimeout(r, 600))
  eq('nor reachable by its key', await where(), 'Farm')

  await tap(420, 300, 900)
  eq('the village opens', await where(), 'Shop')
  const shopWords = await words()
  ok('and sells no animals', !shopWords.some(x => /^ANIMALS$|^สัตว์เลี้ยง$/i.test(x)), JSON.stringify(shopWords))
  await p2.screenshot({ path: 'shots/faithful-crops-only.png' })

  // Still a farm.
  const had = await p2.evaluate(() => window.__game.registry.get('state').money)
  await tap(1032 * W / 1200, 289 * H / 840, 800)
  ok('a seed can still be bought', await p2.evaluate(() => window.__game.registry.get('state').money) < had)
  await tap(524, 396, 700)
  await tap(158, 263, 800)
  eq('and a field still opens', await where(), 'Plot')
  ok('no console errors with no flock', said.length === 0, [...new Set(said)].join(' | '))
  await p2.close()
}

await browser.close()
site.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
