// Checks the game on a phone-sized viewport in both orientations, and that the
// board really does fill the screen rather than sitting in letterbox bars.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { beginShots } from './lib/shots.mjs'
const shots = beginShots('shots/mobile')

const URL = process.env.URL || 'http://localhost:5180/'
const DEVICES = [
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'tablet-portrait', width: 820, height: 1180 },
  // The tablet was only ever checked stood up. Turned, it is the widest board
  // the game is asked to fill, and the one where the stage has the most room
  // left over at the sides.
  { name: 'tablet-landscape', width: 1180, height: 820 },
  // The player can refuse the turn and hold the phone as it is; that path has
  // its own pointer mapping, so it needs its own check.
  { name: 'phone-upright', width: 390, height: 844, upright: true },
]

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
let bad = 0
for (const d of DEVICES) {
  // A context of its own. Pages of one browser share localStorage, so a device
  // that answered the greeting dismissed it for every device after it — and
  // those then reported the panel "not on screen", which reads exactly like a
  // bug on those shapes. The negative result was about the harness.
  const ctx = await b.createBrowserContext()
  const p = await ctx.newPage()
  await p.setViewport({ width: d.width, height: d.height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await p.evaluateOnNewDocument((up) => {
    localStorage.setItem('simfarm.upright', up ? '1' : '0')
    // This suite asks whether the game is playable on a phone, not whether a
    // server is reachable. A built bundle carries the address it was built with,
    // so without this the tap that should open a farm goes to whatever that
    // address is — and every device reads as a problem for a reason that has
    // nothing to do with the phone.
    localStorage.setItem('simfarm.server', ''); localStorage.setItem('simfarm.greeted', '1')
  }, !!d.upright)
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2600))

  const m = await p.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect()
    return {
      portrait: document.body.classList.contains('portrait'),
      fullscreenBtn: getComputedStyle(document.getElementById('full')).display !== 'none',
      touch: (navigator.maxTouchPoints || 0) > 0 && matchMedia('(pointer: coarse)').matches,
      canvas: { w: Math.round(c.width), h: Math.round(c.height) },
      // getBoundingClientRect already reports the turned box, so this is what
      // the player actually sees.
      fits: c.width <= innerWidth + 1 && c.height <= innerHeight + 1,
      coverage: +((c.width * c.height) / (innerWidth * innerHeight)).toFixed(2),
    }
  })

  // Playability, not pixel count: tap NEW GAME and see the farm open. When the
  // board is turned, a stage point maps to the page through the same quarter
  // turn the game applies — tapping as if it were upright would miss.
  const box = await p.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const toPage = (sx, sy) => m.portrait
    ? [box.x + box.w * (1 - sy / 420), box.y + box.h * (sx / 600)]
    : [box.x + box.w * (sx / 600), box.y + box.h * (sy / 420)]
  await p.touchscreen.tap(...toPage(208, 284))
  await new Promise(r => setTimeout(r, 900))
  const scene = await p.evaluate(() => window.__game.scene.scenes.filter(s => s.scene.isActive()).map(s => s.scene.key).join('+'))

  // Upright is deliberately letterboxed, so it is judged on playability alone.
  const ok = m.fits && m.touch && scene === 'Farm' && (d.upright || m.coverage >= 0.6)
  if (!ok) bad++
  console.log(`  ${d.name.padEnd(17)} ${d.width}x${d.height}  turned=${m.portrait}  fullscreen-btn=${m.fullscreenBtn}`
    + `  shown=${m.canvas.w}x${m.canvas.h}  screen used=${Math.round(m.coverage * 100)}%  tap->${scene}  ${ok ? 'ok' : 'PROBLEM'}`)
  await p.screenshot({ path: shots.path(`${d.name}.png`) })
  await p.close()
  await ctx.close()
}
await b.close()
// The run reached the end, so the pictures it took describe this run and are
// safe to publish. A run that died before here leaves none, rather than a set
// that looks current and is not.
shots.finish({ outcome: bad ? 'fail' : 'pass', failed: bad })
process.exit(bad ? 1 : 0)
