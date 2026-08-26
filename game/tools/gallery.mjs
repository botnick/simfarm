// Captures every screen in a realistic mid-game state, for reviewing the look.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { freshShots } from './lib/shots.mjs'

const lang = process.argv[2] || 'en'

// The polish pass has to be done by looking, and a screen that is right on a
// desktop can be wrong on a phone held either way round: the game is letterboxed
// differently, the safe area moves, and Thai sets taller than English. So the
// same walk through every screen is run on each shape rather than only the one
// the author happens to have open.
const SHAPES = {
  desktop: { width: 1200, height: 840, mobile: false },
  'phone-portrait': { width: 390, height: 844, mobile: true },
  'phone-landscape': { width: 844, height: 390, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
}
const shapeName = process.argv[3] || 'desktop'
const shape = SHAPES[shapeName] ?? SHAPES.desktop

// Only this run's own pictures: the gallery is invoked once per language and
// device shape, and each one fills a different corner of the same directory.
freshShots('shots/gallery', `${shapeName}-${lang}-`)
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
await p.setViewport({ width: shape.width, height: shape.height, deviceScaleFactor: 2, isMobile: shape.mobile, hasTouch: shape.mobile })
await p.evaluateOnNewDocument((l) => {
  localStorage.setItem('simfarm.lang', l)
  // Not a first-time player. The greeting is real and comes before anything
  // else, and this tool is here to photograph the game, not to be introduced
  // to it — it clicked NEW GAME straight into the welcome panel and then threw
  // on a farm that had never opened, leaving six-hour-old screenshots behind
  // with nothing to say they were stale.
  localStorage.setItem('simfarm.greeted', '1')
}, lang)
await p.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2500))

// Read the canvas box fresh every time: a phone held upright rotates the whole
// thing, and a box measured once is a box measured before the turn.
const click = async (sx, sy, wait = 500) => {
  const box = await p.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const turned = await p.evaluate(() => document.body.classList.contains('portrait'))
  // A turned board maps a stage point through the same quarter turn the game
  // applies; clicking as if it were upright misses everything.
  const [px, py] = turned
    ? [box.x + box.w * (1 - sy / 420), box.y + box.h * (sx / 600)]
    : [box.x + box.w * (sx / 600), box.y + box.h * (sy / 420)]
  await p.mouse.click(px, py)
  await new Promise(r => setTimeout(r, wait))
}
const shot = (n) => p.screenshot({ path: `shots/gallery/${shapeName}-${lang}-${n}.png` })

await shot('1-menu')
await click(208, 284, 700)

const started = await p.evaluate(() => !!window.__game?.registry?.get('state'))
if (!started) {
  const on = await p.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
  console.error(`no farm opened — still on ${on}. The screenshots below would have been whatever was already on disk.`)
  process.exit(1)
}

await p.evaluate(() => {
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data')
  s.money = 24800; s.energy = 62; s.day = 143
  d.crops.forEach(c => s.seeds[c.id] = 2)
  s.supplies.fertilizer = 34; s.supplies.pesticide = 11; s.supplies.grain = 8; s.supplies.hay = 6; s.supplies.fodder = 12
  s.animals.chicken = 4; s.fed.chicken = 2
  s.barn.crops.strawberry = 9; s.barn.crops.corn = 5; s.barn.crops.grape = 12
  s.barn.goods.egg = 3; s.barn.goods.jam = 2; s.barn.goods.wine = 1; s.barn.goods.pie = 1
  s.pending = [{ id: 'jam', daysLeft: 1 }]
  // A field mid-season, with something ripe, something young and a bug.
  s.plots[0].cropId = 'strawberry'
  s.plots[0].tiles.forEach((t, i) => { t.stage = i < 5 ? 5 : i < 9 ? 3 : 2; t.watered = i % 3 ? 1 : 0; if (i === 6) t.pest = 1 })
  s.plots[1].cropId = 'grape'
  s.plots[1].tiles.forEach((t, i) => { t.stage = i < 3 ? 6 : 4 })
  s.plots[2].cropId = 'turnip'
  s.plots[2].tiles.forEach(t => { t.stage = 5 })
})
// The field below rebuilds from the state poked in above, so there is nothing
// to bounce for. This click was aimed at the field's home button and landed on
// the farm's SAVE — harmless while saving only raised a toast, and not once it
// answered on a screen of its own.
await click(158, 263, 600)
await shot('2-plot')
await click(45, 378, 450); await shot('3-seeds'); await click(300, 128, 500)
await click(547, 364, 600); await shot('4-farm')
await click(141, 74, 700); await shot('5-workshop')
await click(82, 396, 500)
await click(420, 300, 700); await shot('6-shop')
await click(514, 94, 450); await shot('7-sell')
// The market board: the only screen the shop leads to, and the one that
// explains why a price fell. A walk that skipped it was reviewing eight of the
// nine screens the game has.
await click(92, 396, 700); await shot('7b-market')
await click(76, 396, 600)
await click(524, 396, 600)
await click(337, 31, 700); await shot('8-coop')
await p.evaluate(() => { window.__game.registry.get('state').day = 364 })
await click(547, 364, 400); await click(522, 394, 900); await shot('9-end')

await b.close()
console.log(`shots/gallery/${shapeName}-${lang}-*.png`)
