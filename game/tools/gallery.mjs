// Captures every screen in a realistic mid-game state, for reviewing the look.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
mkdirSync('shots/gallery', { recursive: true })

const lang = process.argv[2] || 'en'
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
await p.setViewport({ width: 1200, height: 840, deviceScaleFactor: 2 })
await p.evaluateOnNewDocument((l) => localStorage.setItem('simfarm.lang', l), lang)
await p.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2500))

const box = await p.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const click = async (sx, sy, wait = 500) => {
  await p.mouse.click(box.x + box.w * (sx / 600), box.y + box.h * (sy / 420))
  await new Promise(r => setTimeout(r, wait))
}
const shot = (n) => p.screenshot({ path: `shots/gallery/${lang}-${n}.png` })

await shot('1-menu')
await click(208, 284, 700)

await p.evaluate(() => {
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data')
  s.money = 24800; s.energy = 62; s.day = 143
  d.crops.forEach(c => s.seeds[c.id] = 2)
  s.supplies.fertilizer = 34; s.supplies.pesticide = 11; s.supplies.feed = 8
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
await click(547, 364, 300)          // bounce out and back so the farm redraws
await click(158, 263, 600)
await shot('2-plot')
await click(45, 378, 450); await shot('3-seeds'); await click(300, 128, 500)
await click(547, 364, 600); await shot('4-farm')
await click(141, 74, 700); await shot('5-workshop')
await click(82, 396, 500)
await click(420, 300, 700); await shot('6-shop')
await click(514, 94, 450); await shot('7-sell')
await click(524, 396, 600)
await click(337, 31, 700); await shot('8-coop')
await p.evaluate(() => { window.__game.registry.get('state').day = 364 })
await click(547, 364, 400); await click(522, 394, 900); await shot('9-end')

await b.close()
console.log(`shots/gallery/${lang}-*.png`)
