// The deployed game on a phone, in both orientations, against the real server.
//
// The stage is a fixed 600x420, so a tall screen turns the board a quarter and
// the taps have to turn with it. That is the part worth checking on the real
// thing rather than in a viewport emulator alone.
//
//   node tools/deployed-mobile.mjs https://the-url/ shot.png
import puppeteer from 'puppeteer-core'
const URL = process.argv[2], OUT = process.argv[3]
const CASES = [
  { name: 'phone-portrait', w: 390, h: 844 },
  { name: 'phone-landscape', w: 844, h: 390 },
  { name: 'tablet-portrait', w: 820, h: 1180 },
]
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu'] })
const wait = ms => new Promise(r => setTimeout(r, ms))
let bad = 0
for (const c of CASES) {
  const p = await b.newPage()
  p.setDefaultNavigationTimeout(90000)
  await p.setViewport({ width: c.w, height: c.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const errs = []
  p.on('pageerror', e => errs.push(String(e.message)))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => localStorage.clear())
  await p.reload({ waitUntil: 'domcontentloaded' })
  await wait(4500)
  const box = await p.$eval('canvas', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  // On a tall screen the board is turned a quarter, so a stage point reaches the
  // page through the same turn. Tapping as if it were upright misses entirely.
  const turned = await p.evaluate(() => document.body.classList.contains('portrait'))
  const tap = async (gx, gy, s = 2200) => {
    const [px, py] = turned
      ? [box.x + box.w * (1 - gy / 420), box.y + box.h * (gx / 600)]
      : [box.x + box.w * (gx / 600), box.y + box.h * (gy / 420)]
    await p.touchscreen.tap(px, py)
    await wait(s)
  }
  await tap(208, 284)
  const scene = await p.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
  const online = await p.evaluate(() => window.__game.registry.get('farm')?.online === true)
  const used = Math.round((box.w * box.h) / (c.w * c.h) * 100)
  const ok = scene === 'Farm' && online && errs.length === 0
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(16)} ${c.w}x${c.h}  canvas ${Math.round(box.w)}x${Math.round(box.h)}  ${used}% of screen  turned=${turned} scene=${scene} online=${online}${errs.length ? ' errors=' + errs.join('|') : ''}`)
  await p.screenshot({ path: OUT.replace('.png', `-${c.name}.png`) })
  await p.close()
}
await b.close()
process.exit(bad ? 1 : 0)
