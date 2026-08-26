// Does anything fall off the board, in either language?
//
// The board is a fixed 600x420 that the page rotates to fit a phone held
// upright, so turning the device changes nothing about the layout — mobile.mjs
// already covers that it fits and that touches land. What is not covered is
// content overflowing the board itself, and that is a real risk: every label is
// laid out for English and then translated, and Thai runs longer almost
// everywhere. A button whose text pushes it past the edge is unreachable, and
// nothing about it throws.
import puppeteer from 'puppeteer-core'
import { beginShots } from './lib/shots.mjs'

const shots = beginShots('shots/layout')
const URL = process.env.URL || 'http://localhost:5180/'
const W = 600, H = 420
// A stroke and a drop shadow legitimately sit a pixel or two outside the box.
const SLACK = 3

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})

/**
 * What is wrong with where a thing sits.
 *
 * Two different faults, and they need two different rules. Text that runs off
 * the edge is simply broken to look at, so it has to be inside the board. A hit
 * area is another matter: the field and tile hotspots come from the original
 * art and are deliberately enormous — field four is 267 wide starting at 492,
 * and the isometric tile grid runs off both edges on purpose. None of that is a
 * fault. What would be a fault is a control with so little of itself on the
 * board that the player cannot press it.
 */
const TOUCH = 24
const OVERFLOWING = (w, h, slack, touch) => {
  const out = []
  for (const sc of window.__game.scene.scenes) {
    if (!sc.scene.isActive()) continue
    for (const o of sc.children.list) {
      if (!o.visible || o.alpha < 0.05) continue
      const b = o.getBounds?.()
      if (!b || b.width === 0 || b.height === 0) continue

      if (o.type === 'Text' && o.text?.trim()) {
        const over = Math.max(-b.x, -b.y, b.right - w, b.bottom - h)
        if (over > slack) out.push({ text: o.text.slice(0, 28), why: `${Math.round(over)}px off the board` })
        continue
      }
      if (o.input?.enabled) {
        const onW = Math.min(b.right, w) - Math.max(b.x, 0)
        const onH = Math.min(b.bottom, h) - Math.max(b.y, 0)
        // Judged against its own size, not against an absolute target. The
        // language and sound chips are twenty pixels tall by design and entirely
        // on the board; measuring them against a fixed minimum called them
        // unpressable on every screen in the game, which they plainly are not.
        if (onW < Math.min(touch, b.width) || onH < Math.min(touch, b.height)) {
          out.push({ text: `a ${o.type} you could not press`, why: `${Math.max(0, Math.round(onW))}x${Math.max(0, Math.round(onH))} of it is on the board` })
        }
      }
    }
  }
  return out
}

for (const lang of ['en', 'th']) {
  console.log(`\nlayout: everything on the board, in ${lang}\n`)
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 840 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  await page.evaluateOnNewDocument((l) => {
    localStorage.setItem('simfarm.lang', l)
    localStorage.setItem('simfarm.server', ''); localStorage.setItem('simfarm.greeted', '1')       // the board, not the network
  }, lang)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2600))

  const box = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const click = async (gx, gy, settle = 600) => {
    await page.mouse.click(box.x + (gx / W) * box.w, box.y + (gy / H) * box.h)
    await new Promise(r => setTimeout(r, settle))
  }
  const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(s => s.scene.isActive()).map(s => s.scene.key).join('+'))
  // Measuring whatever happens to be up is how a walk that took a wrong turn
  // reports a clean bill of health for a screen it never reached.
  const look = async (where, expect) => {
    const at = await scene()
    if (!ok(`${where} is the screen being looked at`, at === expect, `on ${at}`)) return
    const over = await page.evaluate(OVERFLOWING, W, H, SLACK, TOUCH)
    ok(`${where} keeps everything on the board`, over.length === 0,
      over.map(o => `"${o.text}": ${o.why}`).join(' · '))
  }

  await look('the title screen', 'Menu')
  await click(208, 284, 1400)
  ok('a farm opens', await scene() === 'Farm', await scene())
  await look('the farm', 'Farm')

  await click(158, 263, 900)
  ok('a field opens', await scene() === 'Plot', await scene())
  await look('a field', 'Plot')
  await click(45, 378, 700)                          // the seed picker, a modal over the field
  await look('the seed picker', 'Plot')
  // Escape leaves the field on its own. The extra click that used to follow it
  // landed on SAVE once the farm grew one, which opened a panel and swallowed
  // everything after it.
  await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 600))

  await click(141, 74, 900)                          // the house
  await look('the workshop', 'Workshop')
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, 700))

  await click(420, 300, 1200)                        // the village
  ok('the shop opens', await scene() === 'Shop', await scene())
  await look('the shop', 'Shop')
  for (const [n, x] of [['supplies', 232], ['animals', 372], ['sell', 512]]) {
    await click(x, 60, 700)
    await look(`the shop's ${n}`, 'Shop')
  }
  await click(92, 396, 900)                          // the market
  await look('the market board', 'Market')

  ok(`nothing threw anywhere in ${lang}`, errors.length === 0, [...new Set(errors)].slice(0, 3).join(' | '))
  await page.screenshot({ path: shots.path(`${lang}.png`) })
  await page.close()
}

await browser.close()
// The run reached the end, so the pictures it took describe this run and are
// safe to publish. A run that died before here leaves none, rather than a set
// that looks current and is not.
shots.finish({ passed: pass, failed: failures.length, failures })
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
