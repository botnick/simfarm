// The game in the configuration it would actually be deployed in.
//
// Every other suite runs the server the way a laptop runs it: no secret worth
// the name, no ledger on disk, any origin answered, and a browser allowed to
// settle its own rewards. Production is the opposite of all four, and strict
// mode refuses to start without them — so the arrangement a player would meet
// had never once been started, let alone played.
//
// What that leaves untested is not small. Cross-origin is the whole shape of a
// real deployment: the game is served from one place and the server lives in
// another, so every request is a preflight away from working or not. And with a
// host key set the browser is no longer allowed to settle its own rewards,
// which is a different code path from the one every other suite takes.
//
//   npm run production
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
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

const freePort = () => new Promise(r => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => r(port)) })
})

/** Serves the built game, so this is the artifact and not the source. */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const serveBuilt = (port) => new Promise((resolve) => {
  const s = httpServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    const file = join(DIST, path === '/' ? '/index.html' : path)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404).end('not here') }
  })
  s.listen(port, () => resolve(s))
})

const SECRET = 'a-real-secret-that-is-long-enough-to-be-one'.padEnd(48, '-')
const HOST_KEY = 'only-the-host-knows-this'.padEnd(40, '-')
const dir = mkdtempSync(join(tmpdir(), 'simfarm-production-'))
const LEDGER = join(dir, 'ledger.json')

const gamePort = await freePort()
const apiPort = await freePort()
const GAME = `http://localhost:${gamePort}`
const API = `http://127.0.0.1:${apiPort}`

const site = await serveBuilt(gamePort)

// Strict, with every setting a host is meant to make. Nothing here is a default.
const server = spawn(process.execPath, [join(HERE, '../../server/index.mjs')], {
  env: {
    ...process.env,
    PORT: String(apiPort),
    SIMFARM_STRICT: '1',
    SIMFARM_SECRET: SECRET,
    SIMFARM_LEDGER_FILE: LEDGER,
    SIMFARM_ORIGIN: GAME,
    SIMFARM_HOST_KEY: HOST_KEY,
    SIMFARM_ENDDAY_MS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
server.stdout.on('data', d => { bootLog += d })
server.stderr.on('data', d => { bootLog += d })
const started = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000)
  server.stdout.on('data', d => { if (String(d).includes('farm server')) { clearTimeout(t); resolve(true) } })
})

console.log(`\nproduction: the built game at ${GAME}, a strict server at ${API}\n`)
ok('a strict server starts once every setting is made', started, bootLog.slice(0, 300))
ok('and refuses nothing on the way up', !bootLog.includes('REFUSED'), bootLog.slice(0, 300))
ok('and never prints the secret it was given', !bootLog.includes(SECRET) && !bootLog.includes(HOST_KEY))

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 840 })
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
// This suite asks the server, from the page, to do something the page is not
// allowed to do — that is the point of it — and Chrome logs every refused fetch
// as a console error. That is the browser reporting the network, not the game
// reporting a fault.
const expected = (text) => text.includes('favicon') || text.includes('403')
page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push(m.text().slice(0, 160)) })

await page.evaluateOnNewDocument((url) => {
  localStorage.setItem('simfarm.server', url)
  localStorage.setItem('simfarm.greeted', '1')
}, API)
await page.goto(GAME + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 2600))

const box = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const click = async (sx, sy, wait = 700) => {
  await page.mouse.click(box.x + box.w * (sx / W), box.y + box.h * (sy / H))
  await new Promise(r => setTimeout(r, wait))
}
const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))
// A run where no farm ever opened used to die here rather than fail: the
// state was guarded but the farm itself was not, so the first question asked
// of it threw and took the whole suite with it, reporting a stack instead of
// which assertion went wrong.
const farm = (expr) => page.evaluate(new Function(`const f = window.__game?.registry?.get('farm'); if (!f) return undefined; const s = f.state; return (${expr})`))

// The whole point: the game is at one address and the server at another, so
// every request is a preflight away from working at all.
await click(208, 284, 1600)
eq('a farm opens across origins', await scene(), 'Farm')
ok('and it is the server holding it', await farm('f.online') === true)
ok('with a session', await page.evaluate(() => !!window.__serverSession))

// Play enough to earn a reward, so the outbox path is exercised for real.
const before = await farm('s.money')
await click(420, 300, 900)                                    // to the village
eq('the shop opens', await scene(), 'Shop')
await click(1032 * W / 1200, 289 * H / 840, 800)              // buy a seed
ok('buying works across origins', await farm('s.money') < before, `${before} -> ${await farm('s.money')}`)
await click(524, 396, 800)
await click(158, 263, 800)
eq('a field opens', await scene(), 'Plot')
await click(45, 378, 600); await click(300, 128, 900)
ok('and is sown', !!await farm('s.plots[0].cropId'))
await click(352, 14, 900)                                     // WATER ALL
eq('watered through the server', await farm('s.plots[0].tiles.filter(t => t.watered).length'), 12)
await click(547, 364, 700)
await click(522, 394, 1200)                                   // END DAY
ok('the day ends', await farm('s.day') > 1)

// A host key means the browser is not allowed to settle its own rewards. Every
// other suite runs without one, so this is the only place that path is taken.
const session = await page.evaluate(() => window.__serverSession)
const settle = await page.evaluate(() => window.__game.registry.get('farm')?.canSettle)
ok('the browser is told it may not settle its own rewards', settle !== true, String(settle))

// The rewards themselves. Playing this far earns at least one, and with a host
// key the browser cannot clear it — so it must still be sitting in the outbox
// after the game has had every chance to try.
const ask = (path, init) => fetch(API + path, { ...init, headers: { 'x-session': session, ...(init?.headers ?? {}) } })
  .then(async r => ({ status: r.status, body: await r.json() }))
const send = (type, extra = {}) => ask('/intent', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, ...extra }),
})
// Far enough in to actually earn one. A reward has to be a real reward for this
// to mean anything, and the first of them is the first thing picked — which is
// several days of growing away, however the days are spent.
let earned = []
for (let day = 0; day < 12 && !earned.length; day++) {
  await send('waterPlot', { plot: 0 })
  const picked = await send('harvestPlot', { plot: 0 })
  earned = picked.body.milestones ?? []
  if (earned.length) break
  await send('endDay')
}
ok('playing far enough earns a reward', earned.length > 0, JSON.stringify(earned).slice(0, 160))

const tried = await page.evaluate(async (api, s, ids) => {
  const r = await fetch(api + '/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session': s },
    body: JSON.stringify({ eventIds: ids }),
  })
  return r.status
}, API, session, earned.map(m => m.eventId))
eq('and the browser is refused when it tries to clear it itself', tried, 403)

const stillThere = (await send('buySeed', { cropId: 'turnip' })).body.milestones ?? []
ok('so the reward is still waiting for the host',
  stillThere.some(m => m.eventId === earned[0]?.eventId), JSON.stringify(stillThere).slice(0, 120))

const cleared = await fetch(API + '/ack', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-session': session, 'x-host-key': HOST_KEY },
  body: JSON.stringify({ eventIds: earned.map(m => m.eventId) }),
}).then(r => r.status)
eq('and the host, holding the key, can clear it', cleared, 200)
const after = (await send('buySeed', { cropId: 'turnip' })).body.milestones ?? []
ok('after which it stops being offered',
  !after.some(m => m.eventId === earned[0]?.eventId), JSON.stringify(after).slice(0, 120))

// The origin is a rule, not a decoration — and proving it needs a real origin
// rather than a blank page, which the browser treats as nowhere in particular
// and would refuse for its own reasons.
const otherPort = await freePort()
const elsewhere = httpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>elsewhere</title>') })
await new Promise(r => elsewhere.listen(otherPort, r))
const stranger = await browser.newPage()
await stranger.goto(`http://localhost:${otherPort}/`, { waitUntil: 'domcontentloaded' })
const asStranger = await stranger.evaluate(async (api) => {
  try { return { reached: true, status: (await fetch(api + '/health')).status } }
  catch (err) { return { reached: false, why: String(err).slice(0, 70) } }
}, API)
ok('a page served from somewhere else cannot read the farm', !asStranger.reached, JSON.stringify(asStranger))

// And the same page, asking the same question, is answered for the game's own
// origin — so the refusal above is the origin rule and not the server being
// unreachable from a second tab.
const asTheGame = await page.evaluate(async (api) => {
  try { return { reached: true, status: (await fetch(api + '/health')).status } }
  catch (err) { return { reached: false, why: String(err).slice(0, 70) } }
}, API)
eq('while the game itself is answered', asTheGame, { reached: true, status: 200 })
await stranger.close()
elsewhere.close()

await page.screenshot({ path: 'shots/production.png' })
ok('no console errors in the whole run', errors.length === 0, [...new Set(errors)].join(' | '))

await browser.close()
server.kill()
site.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
