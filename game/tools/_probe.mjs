import puppeteer from 'puppeteer-core'
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu'] })
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 840 })
p.on('pageerror', e => console.log('PAGEERROR', e.message))
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text()) })
const wait = ms => new Promise(r => setTimeout(r, ms))
await p.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' })
await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'domcontentloaded' }); await wait(2500)
const click = async (gx, gy, s=500) => { const r = await p.$eval('canvas', c => { const b=c.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} }); await p.mouse.click(r.x+gx/600*r.w, r.y+gy/420*r.h); await wait(s) }
await click(208, 284, 900)
// Earn a milestone first — that is the state the failure needs.
await p.evaluate(() => {
  const g = window.__game
  g.registry.set('milestones', [{ eventId: 'x', milestoneId: 'first-animal' }])
  const s = g.registry.get('farm').state; s.money = 99999; s.seeds.turnip = 9
})
await click(547, 364, 700)
await click(158, 263, 900)
console.log('scene now:', await p.evaluate(() => window.__game.scene.scenes.filter(x=>x.scene.isActive()).map(x=>x.scene.key).join('+')))
console.log('plot tiles:', await p.evaluate(() => { const sc = window.__game.scene.getScene('Plot'); return sc ? (sc.tiles ? sc.tiles.length : 'tiles undefined') : 'no scene' }))
await b.close()
