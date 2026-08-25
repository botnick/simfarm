// The deployed game, played through its public URL.
//
// Every other suite builds its own server and points a local page at it. This
// one takes the address a player would actually be given and checks that what is
// behind it is a working game — the build that is really there, the server that
// is really there, and the network between them.
//
//   node tools/deployed.mjs https://the-url/ shot.png
import puppeteer from 'puppeteer-core'
const URL = process.argv[2], OUT = process.argv[3]
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1200,840'] })
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 840 })
p.setDefaultNavigationTimeout(90000)
const errs = []
p.on('pageerror', e => errs.push(String(e.message)))
p.on('console', m => { if (m.type()==='error' && !m.text().includes('favicon')) errs.push(m.text()) })
const wait = ms => new Promise(r => setTimeout(r, ms))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: 'domcontentloaded' })
await wait(4000)
const click = async (gx, gy, s=900) => {
  const r = await p.$eval('canvas', c => { const b=c.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })
  await p.mouse.click(r.x + gx/600*r.w, r.y + gy/420*r.h); await wait(s)
}
const farm = (e) => p.evaluate(new Function(`const f=window.__game.registry.get('farm'); const s=f?.state; return (${e})`))
const scene = () => p.evaluate(() => window.__game.scene.scenes.filter(x=>x.scene.isActive()).map(x=>x.scene.key).join('+'))

const out = []
const ok = (n, c, d='') => { out.push(`${c?'ok   ':'FAIL '} ${n}${c?'':' — '+d}`); return c }
ok('the deployed page boots to the menu', await scene() === 'Menu', await scene())
await click(208, 284, 2500)
ok('NEW GAME reaches the farm', await scene() === 'Farm', await scene())
ok('and the farm is served by the server', await farm('f.online') === true)
const money0 = await farm('s.money')
ok('with money the server gave it', typeof money0 === 'number' && money0 > 0, String(money0))
await click(420, 300, 1600)
ok('the village opens', await scene() === 'Shop', await scene())
await click(1032*600/1200, 289*420/840, 1600)
ok('buying a seed costs money', await farm('s.money') < money0, `${money0} -> ${await farm('s.money')}`)
await click(92, 396, 1600)
ok('the market board opens', await scene() === 'Market', await scene())
await click(76, 396, 1400); await click(524, 396, 1600)
ok('and the way home works', await scene() === 'Farm', await scene())
const day0 = await farm('s.day')
await click(522, 358, 2200)               // SAVE
const sealed = await p.evaluate(() => JSON.parse(localStorage.getItem('simfarm')||'null'))
ok('saving stores the server\'s sealed envelope', !!sealed?.sealed?.signature)
await p.reload({ waitUntil: 'domcontentloaded' }); await wait(4000)
await click(392, 284, 3000)               // LOAD GAME
ok('loading resumes the same farm', await scene() === 'Farm' && await farm('s.day') === day0, `${await scene()} day ${await farm('s.day')}`)
ok('no console errors on the deployed build', errs.length === 0, [...new Set(errs)].join(' | ').slice(0,200))
await p.screenshot({ path: OUT })
console.log(out.join('\n'))
await b.close()
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
