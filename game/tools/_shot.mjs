// Ad-hoc screen grabs for eyeballing a scene in both languages.
import puppeteer from 'puppeteer-core'
const [OUT, ...steps] = process.argv.slice(2)
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1200,840'] })
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 840 })
p.on('pageerror', e => console.log('ERR', e.message))
p.on('console', m => { if (m.type()==='error' && !m.text().includes('favicon')) console.log('CONSOLE', m.text()) })
const wait = ms => new Promise(r => setTimeout(r, ms))
await p.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' })
await p.evaluate(() => localStorage.clear())
// A language is a stored setting, so a shot in Thai sets it and loads rather
// than hunting for a chip that moves from screen to screen.
const lang = steps.find(s => s.startsWith('lang:'))
if (lang) await p.evaluate((v) => localStorage.setItem('simfarm.lang', v), lang.slice(5))
await p.reload({ waitUntil: 'domcontentloaded' }); await wait(2500)
const click = async (gx, gy, s=400) => {
  const r = await p.$eval('canvas', c => { const b=c.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })
  await p.mouse.click(r.x + gx/600*r.w, r.y + gy/420*r.h); await wait(s)
}
for (const step of steps) {
  if (step.startsWith('click:')) { const [gx,gy] = step.slice(6).split(',').map(Number); await click(gx,gy,600) }
  else if (step.startsWith('key:')) { await p.keyboard.press(step.slice(4)); await wait(600) }
  else if (step.startsWith('eval:')) { await p.evaluate(new Function(`const g=window.__game, f=g.registry.get('farm'), s=f.state, d=g.registry.get('data'); ${step.slice(5)}`)); await wait(300) }
  else if (step.startsWith('wait:')) await wait(Number(step.slice(5)))
}
await p.screenshot({ path: OUT })
console.log('scene', await p.evaluate(() => window.__game.scene.scenes.filter(x=>x.scene.isActive()).map(x=>x.scene.key).join('+')))
await b.close()
