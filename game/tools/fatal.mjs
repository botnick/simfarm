// What the game does when it breaks, and what it does not do.
//
// This is meant to be embedded in somebody else's page, so the interesting
// assertions here are the restraints: it must not blame the host for the host's
// own failures, it must not put the error's own text on screen, and a host that
// says it has dealt with something must be believed.
import puppeteer from 'puppeteer-core'

const URL = process.env.URL || 'http://localhost:5180/'

let pass = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})

/** A fresh page, with whatever the host would have set before the script ran. */
async function open(hostSetup = null) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 840 })
  if (hostSetup) await page.evaluateOnNewDocument(hostSetup)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  return page
}

const noticeText = (page) => page.evaluate(() => {
  const el = document.querySelector('[role="alert"]')
  return el ? el.textContent : null
})

console.log('\nwhen the game breaks\n')

/* ------------------------------------------------- with nobody else listening */
{
  const page = await open()
  eq('a healthy game shows no notice', await noticeText(page), null)

  const SECRET = 'https://internal.example/private/path?token=abcdef'
  await page.evaluate((detail) => {
    window.__simfarmFatal.report(new Error(detail), 'FarmScene.create')
  }, SECRET)

  const said = await noticeText(page)
  ok('a broken game says so', !!said, String(said))
  ok('and offers the one thing that helps', /Reload/i.test(said ?? ''), String(said))
  ok('but never repeats what went wrong', !(said ?? '').includes(SECRET), String(said))
  ok('nor the word Error', !/Error:/.test(said ?? ''), String(said))

  // Once. A game failing every frame must not stack a notice per frame.
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.__simfarmFatal.report(new Error('again'), 'update')
  })
  eq('and says it once, however often it breaks',
    await page.evaluate(() => document.querySelectorAll('[role="alert"]').length), 1)
  await page.close()
}

/* ------------------------------------------------------ with a host listening */
{
  const page = await open(() => {
    window.__fatalCalls = []
    window.SIMFARM = {
      onFatal: (info) => {
        window.__fatalCalls.push({
          message: info.error?.message, phase: info.phase, canReload: typeof info.reload === 'function',
        })
        return true                       // the host says it has this
      },
    }
  })

  await page.evaluate(() => window.__simfarmFatal.report(new Error('the barn fell over'), 'ShopScene.create'))
  const calls = await page.evaluate(() => window.__fatalCalls)
  eq('the host is told exactly once', calls.length, 1)
  eq('and told what happened', calls[0]?.message, 'the barn fell over')
  eq('and where', calls[0]?.phase, 'ShopScene.create')
  ok('and given a way to start again', calls[0]?.canReload === true)
  eq('and a host that says it has this gets no notice from us', await noticeText(page), null)
  await page.close()
}

/* --------------------------------------- with a host listening but not handling */
{
  const page = await open(() => {
    window.__fatalCalls = []
    window.SIMFARM = { onFatal: (info) => { window.__fatalCalls.push(info.phase) } }   // returns nothing
  })
  await page.evaluate(() => window.__simfarmFatal.report(new Error('x'), 'CoopScene.create'))
  eq('a host that only wants to know still gets told', await page.evaluate(() => window.__fatalCalls), ['CoopScene.create'])
  ok('and the player is told too', !!(await noticeText(page)))
  await page.close()
}

/* ------------------------------------------- with a host whose handler is broken */
{
  const page = await open(() => {
    window.SIMFARM = { onFatal: () => { throw new Error('the host handler is itself broken') } }
  })
  await page.evaluate(() => window.__simfarmFatal.report(new Error('y'), 'PlotScene.create'))
  ok('a broken handler does not become the error', !!(await noticeText(page)),
    'the player was left with nothing')
  await page.close()
}

/* ------------------------------------------------- with a host that wants no UI */
{
  const page = await open(() => { window.SIMFARM = { fatalUI: false } })
  await page.evaluate(() => window.__simfarmFatal.report(new Error('z'), 'MarketScene.create'))
  eq('a host can turn the notice off without replacing it', await noticeText(page), null)
  await page.close()
}

/* ------------------------------- and it does not answer for the page around it */
{
  const page = await open()
  // Exactly what a host's own unrelated bug looks like.
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'the host had a problem of its own' }))
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject(new Error('also not ours')).catch(() => {}),
      reason: new Error('also not ours'),
    }))
  })
  await new Promise(r => setTimeout(r, 300))
  eq('a failure in the host page is not blamed on the farm', await noticeText(page), null)
  await page.close()
}

/* --------------------------------------------- and every scene is really guarded */
{
  const page = await open()
  const guarded = await page.evaluate(() =>
    window.__game.scene.scenes.map(s => ({
      key: s.scene.key,
      // The guard renames the function it wraps.
      create: s.create?.name,
    })))
  ok('every scene has its lifecycle guarded',
    guarded.length > 0 && guarded.every(s => !s.create || s.create === 'guarded'),
    JSON.stringify(guarded))
  await page.close()
}

await browser.close()
console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
