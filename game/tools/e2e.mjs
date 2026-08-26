// End-to-end: drives the real game in a real browser and asserts that each
// click actually changed the game, not merely that nothing crashed.
// Every check is click -> observe, so a broken button fails here even when the
// rules engine is perfectly fine.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.URL || 'http://localhost:5180/'
const SHOTS = 'shots/e2e'
const W = 600, H = 420
mkdirSync(SHOTS, { recursive: true })

let pass = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// A tunnelled origin is slower than localhost; give navigation room.
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1200,840'],
})
const page = await browser.newPage()
page.setDefaultNavigationTimeout(60000)
await page.setViewport({ width: 1200, height: 840 })

const errors = []
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

/**
 * Stop the moment the game throws.
 *
 * A scene whose create() throws is left half-built: Phaser has made some of it
 * and none of the rest, and nothing on screen says so. Every assertion after
 * that point is measuring rubble, so the run used to end in a cascade of
 * failures with the actual cause reported last, if at all. Checking after each
 * click turns that into one line naming the throw and where it happened.
 */
let faultsSeen = 0
const stopIfBroken = (where) => {
  const faults = errors.filter(e => e.startsWith('pageerror:'))
  if (faults.length === faultsSeen) return
  const fresh = faults.slice(faultsSeen)
  faultsSeen = faults.length
  console.error(`\n  FAIL  the game threw ${where ? `after ${where}` : ''}`)
  for (const f of fresh) console.error(`        ${f}`)
  console.error('        Everything after this would be measuring a half-built scene, so the run stops here.\n')
  failures.push(`the game threw${where ? ` after ${where}` : ''}: ${fresh[0]}`)
  console.log(`\n${pass} passed, ${failures.length} failed\n`)
  failures.forEach(f => console.error(`  ${f}`))
  process.exit(1)
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` })

// The canvas is letterboxed to fit, so click in stage coordinates.
const click = async (gx, gy, settle = 300) => {
  const b = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await page.mouse.click(b.x + (gx / W) * b.w, b.y + (gy / H) * b.h)
  await wait(settle)
  stopIfBroken(`clicking ${gx},${gy}`)
}
/** Press a button by what it says, wherever the panel put it. */
const press = async (re, settle = 500) => {
  const at = await page.evaluate((src) => {
    const rx = new RegExp(src)
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      for (const o of sc.children.list) {
        if (o.type === 'Text' && o.visible && rx.test(o.text)) return { x: o.x, y: o.y }
      }
    }
    return null
  }, re.source)
  if (!at) return false
  await click(at.x, at.y, settle)
  return true
}

const moveOnStage = async (gx, gy) => {
  const b = await page.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await page.mouse.move(b.x + (gx / W) * b.w, b.y + (gy / H) * b.h)
  await wait(140)
}
const read = (expr) => page.evaluate(new Function(`
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data');
  const quoteCropForTest = (id, n) => g.__rules.quoteCrop(s, d, id, n).total;
  return (${expr})
`))
const poke = (body) => page.evaluate(new Function(`
  const g = window.__game, s = g.registry.get('state'), d = g.registry.get('data'); ${body}
`))
const scene = () => page.evaluate(() => window.__game.scene.scenes.filter(x => x.scene.isActive()).map(x => x.scene.key).join('+'))

/**
 * Wait for something to appear on screen.
 *
 * Banners queue rather than stack, so a congratulation can be several seconds
 * behind the thing that caused it. Checking once is checking whether it happened
 * to be that one's turn.
 */
const appears = async (re, ms = 6000) => {
  const until = Date.now() + ms
  let last = []
  while (Date.now() < until) {
    last = await texts()
    if (last.some(t => re.test(t))) return { found: true, texts: last }
    await wait(200)
  }
  return { found: false, texts: last }
}
/**
 * Wait until nothing is left to say.
 *
 * Banners queue and each one holds the screen for several seconds, so "has it
 * stopped being shown" cannot be answered by waiting a fixed moment — one extra
 * congratulation earlier in the run pushes everything after it later.
 */
const settled = async (ms = 30000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!(await page.evaluate(() => (window.__game.registry.get('pendingBanners') ?? []).length))) return true
    await wait(250)
  }
  return false
}

// Every visible string in the running scene, for checking what the player reads.
const texts = () => page.evaluate(() => {
  const g = window.__game
  const out = []
  for (const sc of g.scene.scenes) {
    if (!sc.scene.isActive()) continue
    sc.children.list.forEach(o => { if (o.type === 'Text' && o.text) out.push(o.text) })
  }
  return out
})

console.log(`\ne2e against ${URL}\n`)
// This is the offline suite, so it says so rather than relying on there being
// no server configured. A built bundle carries the address it was built with,
// and running these against one would quietly test something else entirely —
// which is how the artifact came to be the one thing never tested here.
// Re-applied on every navigation, so it survives the reloads below.
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('simfarm.server', '')
  localStorage.setItem('simfarm.greeted', '1')
})
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
await wait(2200)

/* ------------------------------------------------------------- boot + menu */
check('the game boots to the menu', await scene() === 'Menu')
// The concept changed from a fixed year to an endless farm, and the menu is
// where a stale promise would sit unnoticed — it had a blank where the day
// count used to be.
{
  const shown = await texts()
  const capped = await page.evaluate(() => window.__game.registry.get('data').rules.endDay)
  check('the menu does not promise a deadline it does not have',
    capped ? shown.some(t => t.includes(String(capped))) : !shown.some(t => /\bdays? to make\b/.test(t)),
    JSON.stringify(shown))
  check('and says what the farm actually offers',
    shown.some(t => /crops · .* recipes · .* fields/.test(t)), JSON.stringify(shown))
  check('no line on the menu is left with a hole in it',
    !shown.some(t => /(^|\s)(undefined|null|NaN)(\s|$)/.test(t) || /\n\s*days/.test(t)), JSON.stringify(shown))
}
check('the display font actually loaded', await page.evaluate(() => document.fonts.check('600 16px Mitr')))
await shot('01-menu')

/* --------------------------------------------------------------- new game */
await click(208, 284, 600)
check('NEW GAME opens the farm', await scene() === 'Farm')
const rules = await read('d.rules')
eq('starting money matches the rules', await read('s.money'), rules.startMoney)
eq('starting energy matches the rules', await read('s.energy'), rules.startEnergy)
eq('starting day matches the rules', await read('s.day'), rules.startDay)

/* ------------------------------------------------------- shop: buying */
await poke('s.energy = 100')
await click(420, 300, 700)                                  // road to the village
check('the road reaches the shop', await scene() === 'Shop')
eq('walking to the village costs energy', await read('s.energy'), 100 - rules.travelEnergy)

const firstCrop = await read('d.crops[0]')
const moneyBeforeBuy = await read('s.money')
await click(1032 * W / 1200, 289 * H / 840, 450)            // first row's buy button
eq('buying a seed puts one in the bag', await read(`s.seeds['${firstCrop.id}'] || 0`), 1)
eq('buying a seed costs exactly its price', await read('s.money'), moneyBeforeBuy - firstCrop.seedPrice)
await shot('02-bought-seed')

// Buying what you cannot afford must not go through.
await poke('s.money = 0')
await click(1032 * W / 1200, 289 * H / 840, 400)
eq('a seed you cannot afford is refused', await read(`s.seeds['${firstCrop.id}']`), 1)
eq('and it does not take money you do not have', await read('s.money'), 0)
await poke(`s.money = 60000`)

/* ----------------------------------------------------------- shop: tabs */
await click(372, 94, 400)
check('the animals tab lists animals', (await texts()).some(t => t.includes('Chicken')))
const animal = await read('d.animals[0]')

// Animals are unlocked by level, so a new farm must be refused and the same
// click must work once the farm has grown into it.
await click(1032 * W / 1200, 289 * H / 840, 400)
eq('an animal above your level is refused', await read(`s.animals['${animal.id}']`), 0)

await poke(`s.xp = d.progression.thresholdFactor * 30 * 29`)   // everything unlocked
await click(230, 94, 300); await click(372, 94, 400)           // leave and re-enter the tab
const moneyBeforeChicken = await read('s.money')
await click(1032 * W / 1200, 289 * H / 840, 450)
eq('buying an animal adds one to the flock', await read(`s.animals['${animal.id}']`), 1)
eq('buying an animal costs its price', await read('s.money'), moneyBeforeChicken - animal.price)

await click(230, 94, 400)                                   // supplies
const moneyBeforeSupply = await read('s.money')
const supply = await read('d.supplies[0]')
await click(1032 * W / 1200, 289 * H / 840, 450)
eq('buying a supply adds a full pack', await read(`s.supplies['${supply.id}']`), supply.amount)
eq('buying a supply costs its price', await read('s.money'), moneyBeforeSupply - supply.price)
await shot('03-shop-supplies')
await click(524, 394, 600)
check('BACK TO FARM returns to the farm', await scene() === 'Farm')

/* -------------------------------------------------------------- planting */
await click(158, 263, 600)
check('a field patch opens its own screen', await scene() === 'Plot')
await click(45, 378, 450)                                   // the sow button
check('the seed picker opens', (await texts()).some(t => t.includes('SELECT') || t.includes('เลือก')))
await shot('04-seed-picker')
await click(300, 128, 500)                                  // first seed row
eq('sowing plants the chosen crop', await read('s.plots[0].cropId'), firstCrop.id)
eq('one seed sows every tile', await read(`s.plots[0].tiles.filter(t => t.stage === ${rules.stage.seed}).length`), rules.tilesPerPlot)
eq('the seed leaves the bag', await read(`s.seeds['${firstCrop.id}']`), 0)

/* ------------------------------------------------------------ every field */
// Fields two to four once had no tiles at all: their coordinates live in a
// different file from field one's, and only one file was being read. Sowable,
// but nothing drawn and nothing clickable. Check all four, every run.
{
  const FIELDS = [[158, 263], [307, 375], [438, 123], [560, 227]]
  await click(547, 364, 400)                          // back to the farm
  await poke(`s.money = 99999; s.seeds.turnip = 9; s.plots.forEach(p => { p.cropId = null; p.tiles.forEach(t => { t.stage = d.rules.stage.empty }) })`)
  for (let i = 0; i < FIELDS.length; i++) {
    await click(...FIELDS[i], 500)
    const opened = await read(`g.scene.getScene('Plot').plotIndex`)
    eq(`field ${i + 1} opens its own screen`, opened, i)
    eq(`field ${i + 1} has all twelve tiles`, await read(`g.scene.getScene('Plot').tiles.filter(Boolean).length`), 12)
    await click(45, 378, 350)
    await click(300, 128, 450)
    eq(`field ${i + 1} can be sown`, await read(`s.plots[${i}].cropId`), 'turnip')
    eq(`field ${i + 1} draws what was sown`, await read(`g.scene.getScene('Plot').tiles.filter(t => t && t.crop.visible).length`), 12)
    await click(547, 364, 400)
  }
  // Hand the run back exactly what it had before: fields two to four bare, and
  // field one freshly sown with the crop the planting section chose.
  await poke(`
    s.plots.forEach((p, i) => {
      p.cropId = i === 0 ? '${firstCrop.id}' : null
      p.tiles.forEach(t => {
        t.stage = i === 0 ? d.rules.stage.seed : d.rules.stage.empty
        t.age = 0; t.watered = 0; t.fertilized = 0; t.pest = 0; t.picked = 0
      })
    })
    s.energy = d.rules.startEnergy
  `)
  await click(158, 263, 450)
}

/* -------------------------------------------------------------- watering */
const energyBeforeWater = await read('s.energy')
await click(352, 13, 500)                                   // WATER ALL
const watered = await read('s.plots[0].tiles.filter(t => t.watered).length')
eq('water-all waters every tile', watered, rules.tilesPerPlot)
eq('watering costs one energy per tile', await read('s.energy'), energyBeforeWater - rules.tilesPerPlot)
await shot('05-watered')

/* ------------------------------------------- the pointer is the tool */
// The original changed the mouse pointer to whatever you were about to do, and
// it is most of what makes a field feel like a field: you are holding a
// watering can, not choosing a radio button. A browser silently refuses a
// cursor image over 128 pixels and shows an arrow instead, so this asserts the
// pointer the page is actually wearing rather than that a file exists.
{
  const pointer = () => page.evaluate(() =>
    document.querySelector('canvas').style.cursor
    || getComputedStyle(document.querySelector('canvas')).cursor)

  const tools = await read('d.tools.map(t => t.id)')
  const seen = []
  for (let i = 0; i < tools.length; i++) {
    await click(169.75 + i * 69.75, 368, 260)
    // Read it over bare ground. Anything the player can press carries its own
    // hand cursor while the mouse is on it — which is correct, and is not the
    // question here. The top-left corner is scenery on every field.
    await moveOnStage(20, 60)
    seen.push(await pointer())
  }
  const wearing = tools.map((id, i) => seen[i].includes(`cursors/${id}.png`))
  eq('every tool puts itself on the pointer', wearing, tools.map(() => true),
    JSON.stringify(seen.map(c => c.slice(0, 40))))

  await click(547, 364, 700)                    // home
  eq('and the field hands the arrow back on the way out', await scene(), 'Farm')
  const home = await pointer()
  check('the watering can did not follow the player out', !home.includes('cursors/'), home)
  await click(158, 263, 700)                    // back into the field
  check('the field opens again for what follows', await scene() === 'Plot', await scene())
}

/* --------------------------- an answer arriving after the screen was left */
// The batch test further down covers the guard between one send and the next.
// This is the other one: a single action whose answer comes back after the
// player has already gone. Phaser does not object to drawing on a scene it has
// shut down — it simply does it — so nothing throws, and the only evidence is a
// redraw of a screen nobody is looking at. Count the redraw.
{
  const energyWas = await read('s.energy')
  // WATER ALL disables itself when nothing is dry, and everything is wet by the
  // time this runs — so without this the press lands on a dead button and every
  // assertion below passes having tested nothing.
  await poke('s.plots[0].tiles.forEach(t => { t.watered = 0 })')
  await page.evaluate(() => {
    const farm = window.__game.registry.get('farm')
    const plot = window.__game.scene.getScene('Plot')
    plot.refresh()                                 // let the button notice it is wanted
    window.__redraws = 0
    window.__release2 = null
    window.__realWater = farm.waterPlot.bind(farm)
    window.__realRefresh = plot.refresh.bind(plot)
    farm.waterPlot = (args) => new Promise(r => { window.__release2 = () => r(window.__realWater(args)) })
    plot.refresh = (...a) => { window.__redraws++; return window.__realRefresh(...a) }
  })

  await click(352, 13, 400)                        // WATER ALL, its answer held open
  check('the watering is actually in flight', await page.evaluate(() => !!window.__release2))
  await page.evaluate(() => { window.__redraws = 0 })   // baseline, taken after the press
  await click(547, 364, 500)                       // and the player goes home
  eq('the player left the field', await scene(), 'Farm')

  await page.evaluate(() => window.__release2 && window.__release2())
  await wait(700)
  eq('the field it had left was not redrawn behind its back',
    await page.evaluate(() => window.__redraws), 0)

  await page.evaluate(() => {
    const farm = window.__game.registry.get('farm')
    const plot = window.__game.scene.getScene('Plot')
    farm.waterPlot = window.__realWater
    plot.refresh = window.__realRefresh
  })
  // Hand the run back the field it had: watered, at the energy it started with.
  await poke(`s.plots[0].tiles.forEach(t => { t.watered = 1 }); s.energy = ${energyWas}`)
  await click(158, 263, 600)                       // back into the field
  check('the field opens again', await scene() === 'Plot', await scene())
}

/* ----------------------------------------------------------------- tools */
// Water and pick are reached through the whole-field buttons above. The other
// three are only ever one tile at a time, and each spends something a player has
// to have gone and bought.
{
  // Tiles are diamonds recovered from the original art, so a click lands where
  // the game itself says the tile is rather than where a screenshot suggested.
  const tileAt = (i) => page.evaluate((n) => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const t = sc.tiles?.[n]
    return t ? { x: t.c.x, y: t.c.y } : null
  }, i)

  const at = await tileAt(0)
  check('a tile knows where it is', !!at, JSON.stringify(at))

  // Fertiliser: costs a pack from the shed and marks the tile.
  await poke('s.supplies.fertilizer = 3; s.energy = 100')
  await page.keyboard.press('Digit3')                        // the fertiliser tool
  await click(at.x, at.y, 500)
  eq('fertilising marks the tile', await read('s.plots[0].tiles[0].fertilized'), 1)
  eq('and takes a pack from the shed', await read('s.supplies.fertilizer'), 2)
  await click(at.x, at.y, 400)
  eq('and the same tile cannot be fed twice in a day', await read('s.plots[0].tiles[0].fertilized'), 1)
  eq('so nothing more is spent', await read('s.supplies.fertilizer'), 2)

  // Pesticide: only does anything where there is actually a pest.
  await poke('s.supplies.pesticide = 3; s.energy = 100; s.plots[0].tiles[1].pest = 0')
  const at1 = await tileAt(1)
  await page.keyboard.press('Digit4')                        // the spray
  await click(at1.x, at1.y, 400)
  eq('spraying a tile with no pest does nothing', await read('s.supplies.pesticide'), 3)
  check('and says why', (await texts()).some(t => /bug|แมลง/i.test(t)), JSON.stringify(await texts()))

  await poke('s.plots[0].tiles[1].pest = 1')
  await click(at1.x, at1.y, 500)
  eq('spraying a bitten tile clears the pest', await read('s.plots[0].tiles[1].pest'), 0)
  eq('and uses a bottle', await read('s.supplies.pesticide'), 2)

  // Clearing: what you do with a plant that died.
  await poke(`s.plots[0].tiles[2].stage = d.rules.stage.dead; s.energy = 100`)
  const at2 = await tileAt(2)
  await page.keyboard.press('Digit5')                        // the scythe
  await click(at2.x, at2.y, 500)
  eq('clearing empties a dead tile', await read('s.plots[0].tiles[2].stage'), rules.stage.empty)

  // And a tool with nothing left to spend refuses, out loud.
  await poke('s.supplies.fertilizer = 0; s.energy = 100')
  await page.keyboard.press('Digit3')
  const at3 = await tileAt(3)
  await click(at3.x, at3.y, 400)
  eq('a tool with nothing left spends nothing', await read('s.supplies.fertilizer'), 0)
  check('and says what is missing',
    (await texts()).some(t => /no |ไม่มี|หมด/i.test(t)), JSON.stringify(await texts()))

  // Energy is the day's real budget, so a tired farmer is refused too.
  await poke('s.supplies.fertilizer = 5; s.energy = 0')
  await click(at3.x, at3.y, 400)
  eq('a tired farmer cannot work', await read('s.plots[0].tiles[3].fertilized'), 0)
  check('and is told so', (await texts()).some(t => /tired|energy|เหนื่อย|พลังงาน/i.test(t)))
  await poke('s.energy = 100')
  await page.keyboard.press('Digit2')                        // back to the watering can
}

/* --------------------------------------------------- a field already sown */
{
  // One crop to a field. Sowing over the top would quietly destroy what is
  // growing, so it is refused where the player can see it.
  const before = await read('s.plots[0].cropId')
  await poke(`s.seeds['${firstCrop.id}'] = 2`)
  await click(45, 378, 500)                                  // the seed bag
  eq('a sown field cannot be sown again', await read('s.plots[0].cropId'), before)
  check('and says it is already planted',
    (await texts()).some(t => /already|planted|ปลูก/i.test(t)), JSON.stringify(await texts()))
}

/* ------------------------------------------------------------- a new day */
await click(547, 364, 500)                                  // home
const dayBefore = await read('s.day')
await click(522, 394, 800)                                  // END DAY
eq('ending the day advances the calendar', await read('s.day'), dayBefore + 1)
// Tile 4 was left alone above; tile 0 was fertilised. Watering alone moves a
// plant on one stage a night, and that is what a plain tile should show.
eq('a watered crop grew overnight', await read('s.plots[0].tiles[4].stage'), rules.stage.seed + 1)
// And the pack of fertiliser bought a day, which is the only reason to buy one.
check('a fertilised tile grew faster than a plain one',
  await read('s.plots[0].tiles[0].stage') > await read('s.plots[0].tiles[4].stage'),
  `fertilised ${await read('s.plots[0].tiles[0].stage')} vs plain ${await read('s.plots[0].tiles[4].stage')}`)
eq('and fertiliser does not carry over to the next day', await read('s.plots[0].tiles[0].fertilized'), 0)
// The farm grows with the level, so a morning gives back what this farm has
// earned rather than a number out of the rule book.
eq('energy is restored in the morning', await read('s.energy'),
  await read('g.__rules.farmLimits(s, d).energy'))
check('and a grown farm gets back more than a new one would',
  await read('g.__rules.farmLimits(s, d).energy') >= rules.startEnergy,
  `${await read('s.energy')} vs ${rules.startEnergy}`)

/* -------------------------------------------------------------- harvest */
await poke(`s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.ripe })`)
await click(158, 263, 500)                                  // back into the field
const barnBefore = await read(`(s.barn.crops['${firstCrop.id}'] || 0)`)
await click(456, 13, 600)                                   // PICK ALL
eq('pick-all fills the barn', await read(`s.barn.crops['${firstCrop.id}']`), barnBefore + rules.tilesPerPlot)
await shot('06-picked')

/* --------------------------------------------------------- withered ground */
// The state that used to take a field out of the game for good. A crop that
// gives more than one picking leaves every tile dead once it is spent, and a
// field cannot be sown while a single dead plant stands in it — so the ordinary
// end of a radish field was a quarter of the farm that would not sow, with
// nothing on screen saying why and no way back but twelve separate clicks.
{
  await poke(`
    s.energy = 100
    s.plots[0].cropId = '${firstCrop.id}'
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.dead; t.pest = 0 })
  `)
  await click(547, 364, 400)                                  // out to the farm
  await click(158, 263, 600)                                  // and back in, to redraw
  eq('the withered field opens', await scene(), 'Plot')
  const sowable = await read(`g.__rules.plant(JSON.parse(JSON.stringify(s)), d, 0, '${firstCrop.id}')`)
  check('withered ground cannot be sown', sowable === false, String(sowable))
  check('and the screen says so rather than leaving it a mystery',
    (await texts()).some(x => /withered|ตาย/i.test(x)), JSON.stringify(await texts()))
  await shot('06b-withered')

  // A field with dead patches and a crop still growing in it is a different
  // answer: clearing the dead ground is allowed but does not make the field
  // sowable, because the survivors have to finish first. Saying "clear before
  // sowing" here would be telling the player something the field cannot do.
  await poke(`s.plots[0].tiles.forEach((t, i) => { t.stage = i < 3 ? d.rules.stage.dead : d.rules.stage.seed })`)
  await click(547, 364, 400)
  await click(158, 263, 600)
  const mixed = await texts()
  check('a half-dead field does not promise that clearing is enough',
    mixed.some(x => /must finish first|รอที่เหลือ/i.test(x)) &&
    !mixed.some(x => /clear before sowing|ต้องถางก่อน/i.test(x)), JSON.stringify(mixed))
  await click(248, 13, 900)                                   // CLEAR DEAD
  eq('clearing takes the withered patches', await read('s.plots[0].tiles.filter(t => t.stage === d.rules.stage.dead).length'), 0)
  eq('and leaves the crop that is still growing', await read(`s.plots[0].tiles.filter(t => t.stage === d.rules.stage.seed).length`), 9)
  eq('so the field is still spoken for', await read('s.plots[0].cropId'), firstCrop.id)
  const stillSown = await read(`g.__rules.plant(JSON.parse(JSON.stringify(s)), d, 0, '${firstCrop.id}')`)
  check('and cannot be sown over', stillSown === false, String(stillSown))

  // Now finish the job the way the player would have to.
  await poke(`s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.dead })`)
  await click(547, 364, 400)
  await click(158, 263, 600)
  await click(248, 13, 900)                                   // CLEAR DEAD
  eq('clearing takes every withered tile',
    await read('s.plots[0].tiles.filter(t => t.stage === d.rules.stage.dead).length'), 0)
  eq('and the field goes back on the market', await read('s.plots[0].cropId'), null)
  await shot('06c-cleared')
}

/* ---------------------------------------------------------------- selling */
await click(547, 364, 400)
await poke('s.energy = 100')
await click(420, 300, 700)                                  // to the shop
await click(514, 94, 450)                                   // SELL tab
const held = await read(`s.barn.crops['${firstCrop.id}']`)
const moneyBeforeSell = await read('s.money')
// The market prices unit by unit — weekly orders pay a premium and flooding it
// pays less — so the sale must match the game's own quote, not a flat rate.
const expected = await read(`quoteCropForTest('${firstCrop.id}', ${held})`)
await click(1032 * W / 1200, 289 * H / 840, 500)
eq('selling empties that crop from the barn', await read(`s.barn.crops['${firstCrop.id}'] || 0`), 0)
eq('selling pays exactly what the market quoted', await read('s.money'), moneyBeforeSell + expected)
check('the market quote is not a flat multiple of the base price',
  expected !== firstCrop.sellPrice * held, `quote ${expected} vs flat ${firstCrop.sellPrice * held}`)
await shot('07-sold')

/* -------------------------------------- a sale the loan swallows whole */
// The rescue loan is repaid off the top, so a sale worth less than the debt
// empties the barn, pays the loan down and leaves the money exactly where it
// was. The shop decided whether a sale had worked by watching the money, so it
// showed the refusal toast and played the refusal sound — telling the player
// the sale had failed while their crops went anyway.
{
  await poke(`
    s.barn.crops['${firstCrop.id}'] = 2
    s.debt = 100000
    s.energy = 100
  `)
  // Already in the shop on the SELL tab, and pressing the tab you are already
  // on does not redraw anything — so go away and come back.
  await click(126, 94, 400)                                   // SEEDS
  await click(514, 94, 600)                                   // and back to SELL
  const heldBefore = await read(`s.barn.crops['${firstCrop.id}'] || 0`)
  const moneyBefore = await read('s.money')
  const debtBefore = await read('s.debt')
  // Caught early: the toast rises as it fades, so a late look finds it half
  // gone and sitting over the tab bar.
  await click(1032 * W / 1200, 289 * H / 840, 260)
  const told = await texts()
  await shot('07b-loan-took-it')
  eq('the crops really did leave the barn', await read(`s.barn.crops['${firstCrop.id}'] || 0`), 0)
  eq('and the money did not move, because the loan took it', await read('s.money'), moneyBefore)
  check('the loan shrank by what the sale was worth',
    await read('s.debt') < debtBefore, `${debtBefore} -> ${await read('s.debt')}`)
  check('the shop does not call a sale that worked a failure',
    !told.some(x => /can't|cannot|ไม่ได้|ทำไม่ได้/i.test(x)), JSON.stringify(told))
  check('and says where the money went instead',
    told.some(x => /the loan took|หนี้หักไป/i.test(x)), JSON.stringify(told))
  check('the barn is emptier than it was', heldBefore > 0)
  await poke('s.debt = 0')
}

/* ----------------------------------------------------------- the market */
// The board is where the two rules that drive the endless economy are visible:
// weekly orders and saturation. Both are invisible everywhere else, so a
// falling price used to look like a bug.
{
  // The sale just made may already have filled an order, so deliver against one
  // that is still open rather than assuming the first card is.
  const idx = await read('s.market.orders.findIndex(o => o.filled < o.quota)')
  check('the week still has an order open', idx >= 0, `orders ${JSON.stringify(await read('s.market.orders'))}`)
  if (idx >= 0) {
    const order = await read(`s.market.orders[${idx}]`)
    const want = order.quota - order.filled
    await poke(`s.barn.crops['${order.cropId}'] = ${want}`)
    await click(92, 396, 600)
    check('the shop opens the market board', await scene() === 'Market')

    const shown = await texts()
    const orderNames = await read("s.market.orders.map(o => d.crops.find(c => c.id === o.cropId).name.en)")
    check('the week put orders on the board at all', orderNames.length > 0, `${orderNames.length}`)
    check('the board lists this week\'s orders', orderNames.every(n => shown.some(t => t === n)),
      `orders ${JSON.stringify(orderNames)} shown ${JSON.stringify(shown)}`)
    check('the board says which week it is and when it turns',
      shown.some(t => /^Week \d+ · new board/.test(t)), JSON.stringify(shown.filter(t => t.includes('Week'))))
    check('the board explains the saturation',
      shown.some(t => /^(fresh|falling|flooded)\b/.test(t)), JSON.stringify(shown.filter(t => t.includes('·'))))
    await shot('13-market')

    // Delivering against an order must pay the premium and advance that order,
    // not merely dump the crop at the going rate.
    const before = await read('s.money')
    const quoted = await read(`quoteCropForTest('${order.cropId}', ${want})`)
    const flat = await read(`d.crops.find(c => c.id === '${order.cropId}').sellPrice * ${want}`)
    check('an order quotes above the flat price', quoted > flat, `quoted ${quoted} vs flat ${flat}`)

    // Cards are laid out centred, so the button follows the same arithmetic the
    // scene uses rather than a pixel guessed off a screenshot.
    const n = await read('s.market.orders.length')
    const CARD_W = 180, GAP = 8
    const startX = (600 - (n * CARD_W + (n - 1) * GAP)) / 2
    await click(startX + idx * (CARD_W + GAP) + CARD_W / 2, 168, 600)

    eq('delivering empties that crop from the barn', await read(`s.barn.crops['${order.cropId}'] || 0`), 0)
    eq('delivering pays the quoted premium', await read('s.money'), before + quoted)
    eq('the order is recorded as filled', await read(`s.market.orders[${idx}].filled`), order.quota)
    check('a filled order stops asking', (await texts()).includes('Filled'))
    await shot('14-market-filled')
  }
  await click(76, 396, 500)
  check('the market goes back to the shop', await scene() === 'Shop')
}

await click(524, 394, 500)

/* ------------------------------------------------------------------ sound */
// Every cue is named in the data file and nowhere else, so the only thing that
// can go wrong is a name with no file behind it — which is silence, and silence
// is exactly what nobody notices until a player does.
{
  const missing = await page.evaluate(() => {
    const g = window.__game, d = g.registry.get('data')
    const names = [...(d.audio.sfx ?? []), ...Object.values(d.audio.music ?? {})]
    const sc = g.scene.scenes.find(x => x.scene.isActive())
    return names.filter(n => !sc.cache.audio.exists(`sfx:${n}`))
  })
  eq('every cue in the data file actually loaded', missing, [])

  const uncued = await page.evaluate(() => {
    const d = window.__game.registry.get('data')
    return d.tools.map(t => t.id).filter(id => !d.audio.toolCue[id])
  })
  eq('every tool has a sound', uncued, [])

  // Mute is a setting, not a session: a player who turned it off meant it.
  await page.evaluate(() => localStorage.setItem('simfarm.muted', '0'))
  const chipY = await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const t = sc.children.list.find(o => o.type === 'Text' && (o.text === 'SOUND' || o.text === 'MUTED'))
    // The chip is right-aligned, so its text origin is its left edge.
    return t ? { x: t.x + t.displayWidth / 2, y: t.y, text: t.text } : null
  })
  check('the sound toggle is on screen', !!chipY, JSON.stringify(chipY))
  if (chipY) {
    await click(chipY.x, chipY.y, 400)
    eq('clicking it mutes', await page.evaluate(() => localStorage.getItem('simfarm.muted')), '1')
    const now = await page.evaluate(() => {
      const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
      return sc.children.list.some(o => o.type === 'Text' && o.text === 'MUTED')
    })
    check('and the chip says so', now)
    await click(chipY.x, chipY.y, 400)
    eq('clicking again unmutes', await page.evaluate(() => localStorage.getItem('simfarm.muted')), '0')

    // Muting stops the music bed; unmuting starts a fresh one. The stopped one
    // was left in the sound manager, which never forgets a sound, so a player
    // who fiddled with the toggle accumulated a dead bed per press for the rest
    // of the session. Count them rather than trusting that it sounds right.
    const beds = () => page.evaluate(() => {
      const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
      return sc.sound.sounds.filter(s => s.key.startsWith('sfx:') && s.loop).length
    })
    const settled = await beds()
    for (let i = 0; i < 4; i++) { await click(chipY.x, chipY.y, 260) }
    eq('the toggle left the sound off where it found it',
      await page.evaluate(() => localStorage.getItem('simfarm.muted')), '0')
    const after = await beds()
    // 'no more than before' passes on its own when there were none to begin with,
    // which is the same vacuous green this suite has been finding elsewhere. Say
    // that a bed is playing, and that the count is the one it started at.
    check('a music bed is actually playing to count', settled >= 1, `${settled} beds`)
    eq('and toggling the sound left exactly as many', after, settled)
  }
}

/* -------------------------------------------------------------- crafting */
const recipe = await read('d.recipes.find(r => r.days > 0 && r.inputs.every(i => i.crop))')
// Say so when there is nothing to cure. Six checks live in here, and a rule
// book without a curing recipe would have skipped all of them and still
// reported a clean run.
check('the rule book has a recipe that cures from crops', !!recipe,
  `recipes ${JSON.stringify(await read('d.recipes.map(r => r.id)'))}`)
if (recipe) {
  // Recipes are gated by their ingredients' unlock level, so grow into them first.
  await poke(`s.xp = d.progression.thresholdFactor * 30 * 29`)
  await poke(`${JSON.stringify(recipe.inputs)}.forEach(i => s.barn.crops[i.crop] = i.amount)`)
  await click(141, 74, 600)                                 // the house is the workshop
  check('the house opens the workshop', await scene() === 'Workshop')
  // The workshop paginates, so page across to wherever this recipe lives rather
  // than only testing whatever happens to be on the first page.
  const idx = await read(`d.recipes.findIndex(r => r.id === '${recipe.id}')`)
  const PER_PAGE = 4
  for (let page = 0; page < Math.floor(idx / PER_PAGE); page++) await click(348, 368, 350)
  {
    const energyBeforeCraft = await read('s.energy')
    await click(518, 134 + (idx % PER_PAGE) * 58, 600)
    eq(`starting ${recipe.id} consumes its ingredients`, await read(`s.barn.crops['${recipe.inputs[0].crop}'] || 0`), 0)
    eq(`starting ${recipe.id} costs energy`, await read('s.energy'), energyBeforeCraft - recipe.energy)
    eq(`${recipe.id} goes on to cure`, await read('s.pending.length'), 1)
    await shot('08-crafting')
    await click(80, 394, 500)
    const suppliesBeforeCure = recipe.output.supply ? await read(`s.supplies['${recipe.output.supply}']`) : 0
    for (let i = 0; i < recipe.days; i++) await click(522, 394, 700)
    // A recipe yields either a shed supply or a barn good; check whichever it is.
    const out = recipe.output
    const delivered = out.supply
      ? await read(`s.supplies['${out.supply}']`) - suppliesBeforeCure
      : await read(`s.barn.goods['${out.good}'] || 0`)
    eq(`${recipe.id} is delivered when curing ends`, delivered, out.amount)
    eq('and it leaves the curing queue', await read('s.pending.length'), 0)
  }
}

/* ------------------------------------------------------------------ coop */
// Set the preconditions explicitly: the days spent curing above can starve the
// flock, which would make this section pass or fail on a dice roll.
await poke(`s.animals['${animal.id}'] = ${animal.max}; s.supplies['${animal.feed}'] = 20; s.fed['${animal.id}'] = 0`)
await click(337, 31, 700)
check('the coop opens', await scene() === 'Coop')
const feedBefore = await read(`s.supplies['${animal.feed}']`)
// Find the button rather than remember where it sat: rows get re-laid-out, and
// a coordinate baked into a test turns a tidy-up into a failure.
const feedAt = await page.evaluate((name) => {
  const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
  const rows = sc.children.list.filter(o => o.type === 'Text')
  const label = rows.find(o => o.text === name)
  if (!label) return null
  // The row's own FEED button is the one nearest it vertically.
  const feeds = rows.filter(o => /FEED|ให้อาหาร/.test(o.text))
  const mine = feeds.sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0]
  return mine ? { x: mine.x, y: mine.y } : null
}, animal.name.en)
check('the flock has a feed button', !!feedAt, JSON.stringify(feedAt))
await click(feedAt.x, feedAt.y, 500)
const fed = await read(`s.fed['${animal.id}']`)
check('feeding feeds the whole flock', fed === await read(`s.animals['${animal.id}']`), `fed ${fed}`)
eq('feeding consumes feed', await read(`s.supplies['${animal.feed}']`), feedBefore - fed)
await shot('09-coop-fed')

/* ------------------------------- leaving a screen stops what was not yet sent */
// Feeding the flock is one press that sends one intent per species. The player
// can leave while it is partway through, and the rest of it used to go anyway —
// spending their energy on a screen they are no longer looking at, then drawing
// the result on a scene that had already shut down.
//
// The guards that stop this are written out by hand in thirteen places, which
// is exactly the kind of thing that gets dropped in a tidy-up, so it is worth a
// test. No server needed: the first call is held open here, which is the same
// shape as a slow answer.
{
  const animals = await read('d.animals.length')
  check('there is more than one thing to feed, or this proves nothing', animals > 1, `${animals}`)

  await page.evaluate(() => {
    const farm = window.__game.registry.get('farm')
    window.__feeds = 0
    window.__release = null
    window.__realFeed = farm.feed.bind(farm)
    farm.feed = (args) => {
      window.__feeds++
      // Hold the first one open. The rest, if they come, resolve at once — so a
      // count above one means the batch carried on after the screen was left.
      if (window.__feeds === 1) return new Promise(r => { window.__release = () => r(window.__realFeed(args)) })
      return window.__realFeed(args)
    }
  })

  await page.keyboard.press('KeyF')                  // feed the whole flock
  await wait(250)
  eq('the first of the batch went out', await page.evaluate(() => window.__feeds), 1)

  await page.keyboard.press('Escape')                // and the player leaves
  await wait(400)
  eq('the player is back on the farm', await scene(), 'Farm')

  await page.evaluate(() => window.__release && window.__release())
  await wait(700)
  eq('the rest of the batch was not sent', await page.evaluate(() => window.__feeds), 1)

  await page.evaluate(() => {
    const farm = window.__game.registry.get('farm')
    farm.feed = window.__realFeed
  })
  await click(337, 31, 700)                          // back into the coop for what follows
  check('the coop opens again', await scene() === 'Coop', await scene())
}
await click(547, 364, 500)
const eggsBefore = await read(`s.barn.goods['${animal.produces}'] || 0`)
await click(522, 394, 800)                                  // END DAY
eq('a fed flock lays overnight', await read(`s.barn.goods['${animal.produces}'] || 0`), eggsBefore + fed)

/* ------------------------------------------ the shop, past its first page */
{
  await click(420, 300, 900)                                  // to the village
  check('the shop opens', await scene() === 'Shop', await scene())

  // Twelve crops do not fit on one page, so the pager is the only way to reach
  // most of them.
  await click(88, 94, 500)                                    // SEEDS
  const firstPage = await texts()
  await click(348, 358, 600)                                  // next page
  const secondPage = await texts()
  check('the shop pages through its stock',
    JSON.stringify(firstPage) !== JSON.stringify(secondPage), 'both pages read the same')
  check('and says where you are', secondPage.some(t => /^\d+ \/ \d+$/.test(t)), JSON.stringify(secondPage))
  await click(252, 358, 600)                                  // back a page
  check('and back again', JSON.stringify(await texts()) === JSON.stringify(firstPage))

  // A crop above your level is shown, not hidden, with what it takes to get it.
  await poke('s.xp = 0')
  await click(514, 94, 300); await click(88, 94, 600)          // leave and re-enter SEEDS
  const shown = await texts()
  check('a locked crop is still shown',
    shown.some(t => /Level \d+|เลเวล \d+/.test(t)), JSON.stringify(shown))
  check('with what it takes to reach it',
    shown.some(t => /reach level|ถึงเลเวล/i.test(t)), JSON.stringify(shown))

  // Goods sell as well as crops, and at a price the market does not flood.
  await poke(`s.xp = d.progression.thresholdFactor * 12 * 11; s.debt = 0`)
  const good = await read('d.goods.find(g => g.from === "coop")')
  await poke(`s.barn.goods['${good.id}'] = 3`)
  await click(514, 94, 700)                                   // SELL
  const before = await read('s.money')
  const goodRow = await page.evaluate((name) => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const label = sc.children.list.find(o => o.type === 'Text' && o.text === name)
    if (!label) return null
    const buttons = sc.children.list.filter(o => o.type === 'Text' && /^\$ /.test(o.text))
    const mine = buttons.sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0]
    return mine ? { x: mine.x, y: mine.y } : null
  }, good.name.en)
  check('the barn lists the good it holds', !!goodRow, JSON.stringify(await texts()))
  if (goodRow) {
    await click(goodRow.x, goodRow.y, 700)
    eq('selling a good empties it from the barn', await read(`s.barn.goods['${good.id}'] || 0`), 0)
    eq('and pays its listed price', await read('s.money'), before + good.price * 3)
  }
}

/* ------------------------------------------ the market, once it is flooded */
{
  await click(92, 396, 900)                                   // MARKET
  check('the market board opens', await scene() === 'Market', await scene())

  // Selling the same crop over and over is what floods it, and the board is the
  // only place that says so before the price falls.
  const crop = await read('s.market.orders.find(o => o.filled >= o.quota)?.cropId ?? d.crops[0].id')
  const tiers = await read('d.rules.market.tiers')
  await poke(`s.market.sold['${crop}'] = ${tiers[0].upTo + 1}`)
  await poke(`s.market.orders = s.market.orders.filter(o => o.cropId !== '${crop}')`)
  await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    sc.shown_ = null
    sc.render()
  })
  await wait(400)
  const board = await texts()
  check('a flooded crop is named as falling',
    board.some(t => /falling|flooded|ราคาตก|ล้นตลาด/.test(t)), JSON.stringify(board))
  const now = await read(`g.__rules.unitPrice(s, d, '${crop}')`)
  const base = await read(`d.crops.find(c => c.id === '${crop}').sellPrice`)
  check('and it really does pay less', now < base, `${now} vs ${base}`)

  // The board also sells, and for exactly what it says.
  await poke(`s.barn.crops['${crop}'] = 4; s.debt = 0`)
  await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    sc.shown_ = null
    sc.render()
  })
  await wait(400)
  const quoted = await read(`quoteCropForTest('${crop}', 4)`)
  const moneyBefore = await read('s.money')
  const sellBtn = await page.evaluate((want) => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const t = sc.children.list.find(o => o.type === 'Text' && o.text === want)
    return t ? { x: t.x, y: t.y } : null
  }, `$ ${quoted.toLocaleString('en-US')}`)
  check('the board offers what the sale is worth', !!sellBtn, `looking for $ ${quoted}`)
  if (sellBtn) {
    await click(sellBtn.x, sellBtn.y, 800)
    eq('selling from the board empties the barn', await read(`s.barn.crops['${crop}'] || 0`), 0)
    eq('and pays what it offered', await read('s.money'), moneyBefore + quoted)
  }
  await click(76, 396, 700)                                   // back to the shop
  await click(524, 396, 800)                                  // and out to the farm
}

/* ------------------------------------------------- the coop, and its produce */
{
  await page.keyboard.press('KeyC')
  await wait(800)
  check('the coop opens from the farm', await scene() === 'Coop', await scene())

  const animal2 = await read('d.animals[0]')
  await poke(`
    s.animals['${animal2.id}'] = 2
    s.barn.goods['${animal2.produces}'] = 5
    s.debt = 0
  `)
  await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    sc.render()
  })
  await wait(400)
  const worth = await read(`d.goods.find(g => g.id === '${animal2.produces}').price * 5`)
  const before2 = await read('s.money')
  await click(504, 396, 900)                                  // SELL
  eq('the coop sells what the flock produced', await read(`s.barn.goods['${animal2.produces}'] || 0`), 0)
  eq('and pays for it', await read('s.money'), before2 + worth)

  // An animal with nothing to eat cannot be fed, and the row says so.
  await poke(`s.supplies['${animal2.feed}'] = 0; s.fed['${animal2.id}'] = 0`)
  await page.evaluate(() => window.__game.scene.scenes.find(x => x.scene.isActive()).render())
  await wait(300)
  await page.keyboard.press('KeyF')                           // feed everything
  await wait(500)
  eq('a flock with no feed goes unfed', await read(`s.fed['${animal2.id}']`), 0)
  check('and the coop says there is nothing to feed them',
    (await texts()).some(t => /nothing|ไม่มี/i.test(t)), JSON.stringify(await texts()))
  await page.keyboard.press('Escape')
  await wait(700)
}

/* --------------------------------------------- the workshop, made to order */
{
  await page.keyboard.press('KeyK')
  await wait(800)
  check('the workshop opens from the farm', await scene() === 'Workshop', await scene())

  // A recipe with nothing behind it is refused, out loud.
  const instant = await read('d.recipes.find(r => !r.days)')
  check('there is a recipe that finishes at once', !!instant, JSON.stringify(instant))
  await poke('s.barn.crops = {}; s.barn.goods = {}; s.energy = 100')
  await page.evaluate(() => window.__game.scene.scenes.find(x => x.scene.isActive()).render())
  await wait(300)
  const madeNothing = await page.evaluate((id) => {
    const g = window.__game, s = g.registry.get('farm').state
    return JSON.stringify(s.barn)
  }, instant.id)
  await page.evaluate((id) => window.__game.registry.get('farm').craft({ recipeId: id }), instant.id)
  await wait(500)
  eq('a recipe with no ingredients makes nothing',
    await page.evaluate(() => JSON.stringify(window.__game.registry.get('farm').state.barn)), madeNothing)

  // And with the ingredients, it is done the same day.
  // Stock exactly what this recipe asks for, whichever kind of thing that is —
  // a named crop, a named good, a supply, or simply "any crops".
  await poke(`
    const recipe = d.recipes.find(r => r.id === '${instant.id}')
    for (const i of recipe.inputs) {
      if (i.crop) s.barn.crops[i.crop] = i.amount
      if (i.good) s.barn.goods[i.good] = i.amount
      if (i.supply) s.supplies[i.supply] = i.amount
      if (i.anyCrop) s.barn.crops[d.crops[0].id] = (s.barn.crops[d.crops[0].id] || 0) + i.anyCrop
    }
    s.energy = 100
  `)
  const out = instant.output
  const heldBefore = out.supply
    ? await read(`s.supplies['${out.supply}']`)
    : await read(`s.barn.goods['${out.good}'] || 0`)
  await page.evaluate((id) => window.__game.registry.get('farm').craft({ recipeId: id }), instant.id)
  await wait(500)
  const heldAfter = out.supply
    ? await read(`s.supplies['${out.supply}']`)
    : await read(`s.barn.goods['${out.good}'] || 0`)
  eq('a recipe that needs no curing is done at once', heldAfter, heldBefore + out.amount)
  eq('and nothing is left curing', await read('s.pending.length'), 0)
  await page.keyboard.press('Escape')
  await wait(700)
}

/* ------------------------------------------------- what the night can bring */
// Rain, pests and levelling all happen between one day and the next, so a player
// only ever sees the result. Each is forced here and then checked on the farm.
{
  await click(524, 394, 700)                                 // out to the farm
  if (await scene() !== 'Farm') { await page.keyboard.press('Escape'); await wait(600) }
  check('back on the farm', await scene() === 'Farm', await scene())

  // Rain waters everything, which is the whole point of it.
  await poke(`
    s.energy = 100
    s.plots[0].cropId = '${firstCrop.id}'
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed; t.watered = 0; t.pest = 0 })
    d.rules.rain.chance = 1
  `)
  await click(522, 394, 900)                                 // END DAY
  eq('rain waters every tile of a field', await read('s.plots[0].tiles.filter(t => t.watered).length'), rules.tilesPerPlot)
  check('and the farm says it rained',
    (await texts()).some(t => /rain|ฝน/i.test(t)), JSON.stringify(await texts()))
  check('and the rain is drawn', await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    return sc.rainLayer?.visible === true && sc.rainLayer.length > 0
  }))

  // And a dry night is a dry night.
  await poke('d.rules.rain.chance = 0; s.energy = 100')
  await poke(`s.plots[0].tiles.forEach(t => { t.watered = 0 })`)
  await click(522, 394, 900)
  eq('a dry night waters nothing', await read('s.plots[0].tiles.filter(t => t.watered).length'), 0)

  // Pests: a bitten tile stops growing until it is sprayed, so the farm has to
  // say where they are.
  // Pests only trouble a plant that is far enough along to be worth eating, so
  // the tiles are grown to that stage before the night is forced.
  // A pest arrives on a plant that has reached the stage worth eating, and the
  // check happens after the night's growth — so the tiles are left unwatered to
  // sit exactly there rather than growing past it.
  await poke(`
    s.energy = 100
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.pest.spawnStage; t.age = 0; t.watered = 0; t.fertilized = 0; t.pest = 0 })
    d.rules.pest.spawnChance = 1
    d.rules.pest.deathChance = 0
  `)
  await click(522, 394, 900)
  const bitten = await read('s.plots[0].tiles.filter(t => t.pest).length')
  check('pests appear overnight', bitten > 0, `${bitten} tiles`)
  // The status panel always names the bug spray, so look for the field's own
  // marker rather than any mention of the word.
  check('and the field itself says so',
    (await texts()).some(t => /\b\d+ bug|แมลง \d+/i.test(t)), JSON.stringify(await texts()))

  // What a pest actually costs you: a bitten plant can be dead in the morning.
  // That is why the spray is worth buying, and it is the only thing in the game
  // that destroys a crop outright.
  await poke(`
    s.energy = 100
    d.rules.pest.spawnChance = 0
    d.rules.pest.deathChance = 1
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.pest.spawnStage; t.pest = 1; t.watered = 0 })
  `)
  await click(522, 394, 900)
  const died = await read(`s.plots[0].tiles.filter(t => t.stage === d.rules.stage.dead).length`)
  check('a bitten plant can be dead by morning', died > 0, `${died} of ${rules.tilesPerPlot}`)
  check('and the night reports what was lost',
    (await texts()).some(t => /wither|died|เหี่ยว|ตาย/i.test(t)), JSON.stringify(await texts()))

  // Spraying is what stops that happening, so a sprayed field survives a night
  // that would otherwise have killed it.
  await poke(`
    s.energy = 100
    s.plots[0].cropId = '${firstCrop.id}'
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.pest.spawnStage; t.pest = 0; t.watered = 0 })
  `)
  await click(522, 394, 900)
  const survived = await read(`s.plots[0].tiles.filter(t => t.stage !== d.rules.stage.dead).length`)
  eq('a field with no pests on it survives the same night', survived, rules.tilesPerPlot)

  await poke('d.rules.pest.deathChance = 0.3333; s.plots[0].tiles.forEach(t => { t.pest = 0 })')

  // Levelling: the plaque, the bar, and the banner that says it happened.
  const before = await read('s.xp')
  await poke(`s.xp = d.progression.thresholdFactor * 2 - 1`)   // one point short of level 2
  await poke('s.energy = 100')
  await click(522, 394, 300)                                  // redraw the hud
  const levelBefore = await page.evaluate(() => window.__game.scene.scenes.find(x => x.scene.isActive())?.hud?.level)
  await poke(`s.xp = d.progression.thresholdFactor * 12 * 11`)
  await poke('s.energy = 100')
  await click(522, 394, 900)
  const levelAfter = await page.evaluate(() => window.__game.scene.scenes.find(x => x.scene.isActive())?.hud?.level)
  check('the farm levels up', levelAfter > levelBefore, `${levelBefore} -> ${levelAfter}`)
  check('and says so on screen',
    (await texts()).some(t => /LEVEL \d+!|เลเวล \d+!/.test(t)), JSON.stringify(await texts()))
  check('and the plaque shows the new level',
    (await texts()).includes(String(levelAfter)), JSON.stringify(await texts()))

  /* --------------------------------------- levelling away from the farm */
  // Picking a crop, starting a batch and filling an order all pay experience,
  // so a level can be reached in a field, the workshop, the shop or the market.
  // The only congratulation used to be the farm's end-of-day comparison, which
  // meant levelling anywhere else went by with nothing but a number quietly
  // changing on a plaque that most screens do not even have.
  {
    const target = await read(`(() => {
      const listed = (d.milestones ?? []).filter(m => m.when === 'level').map(m => m.level)
      const every = d.progression.milestoneEvery ?? 0
      const top = Math.max(0, ...listed)
      const now = g.__progression.levelProgress(s.xp, d).level
      for (let l = now + 1; l < now + 60; l++)
        if (!listed.includes(l) && !(every > 0 && l > top && l % every === 0)) return l
      return null
    })()`)
    check('some level arrives with no milestone to announce it', target != null, `level ${target}`)
    await poke(`
      s.xp = 0
      while (g.__progression.levelProgress(s.xp, d).level < ${target}) s.xp += 1
      s.xp -= 1
      s.energy = 100
      s.plots[0].cropId = '${firstCrop.id}'
      s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.ripe; t.pest = 0 })
    `)
    await click(158, 263, 500)
    eq('a field is open, and the farm screen is not', await scene(), 'Plot')
    await click(456, 13, 700)                                 // PICK ALL — the experience lands here
    eq('picking the field is what levels the farm up',
      await read(`g.__progression.levelProgress(s.xp, d).level`), target)
    const said = await appears(/LEVEL \d+!|เลเวล \d+!/)
    check('and the field is where it is announced', said.found, JSON.stringify(said.texts))
    await click(547, 364, 400)                                // back out to the farm
    eq('and the farm is where we came back to', await scene(), 'Farm')
  }

  // A level unlocks crops, and the shop is where that shows.
  const unlocked = await read('d.crops.filter(c => (c.unlockLevel ?? 1) <= 12).length')
  check('levelling unlocks more crops than the farm started with', unlocked > 3, `${unlocked} crops`)
}

/* --------------------------------------- being told what you just achieved */
{
  // The game awards milestones and closes seasons, and until now it did both
  // silently: they existed for a host to read and the player was never told.
  // Get back to the farm however far in we are.
  for (let i = 0; i < 4 && await scene() !== 'Farm'; i++) { await page.keyboard.press('Escape'); await wait(500) }
  check('on the farm', await scene() === 'Farm', await scene())

  // A milestone earned anywhere must be announced wherever the player is. Pick
  // one this run has not already earned, since the game deliberately refuses to
  // congratulate anybody twice for the same thing.
  const unseen = await page.evaluate(() => {
    const g = window.__game
    const done = g.registry.get('announcedMilestones') ?? new Set()
    const m = g.registry.get('data').milestones.find(x => !done.has(x.id))
    return m ? { id: m.id, name: m.name.en } : null
  })
  check('there is a milestone this farm has not earned yet', !!unseen, 'all of them are already announced')
  await page.evaluate((id) => {
    window.__game.registry.set('milestones', [{ eventId: 'e', milestoneId: id }])
  }, unseen.id)
  const shown = await appears(/WELL DONE|ยินดีด้วย/)
  check('a milestone is announced', shown.found, JSON.stringify(shown.texts))
  const named = await appears(new RegExp(`^${unseen.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  check('and says which one', named.found, `looking for ${unseen.name} in ${JSON.stringify(named.texts)}`)

  // And only once, however many screens the player walks through.
  check('the congratulation finishes on its own', await settled(), 'a banner is stuck on screen')
  await page.keyboard.press('KeyC'); await wait(800)
  await page.keyboard.press('Escape'); await wait(800)
  const again = await texts()
  check('and is not announced again on the next screen',
    !again.some(t => /WELL DONE|ยินดีด้วย/.test(t)), JSON.stringify(again))

  // A milestone the rules generate rather than list still gets a name.
  await page.evaluate(() => {
    window.__game.registry.set('milestones', [{ eventId: 'f', milestoneId: 'level-40' }])
  })
  const generated = await appears(/^Level 40$|^เลเวล 40$/)
  check('a generated milestone is named, not printed as an id',
    generated.found && !generated.texts.includes('level-40'), JSON.stringify(generated.texts))
  // Let the queue empty before asking about the next thing.
  await appears(/nothing at all will ever match this/, 2500)

  // A season closing is the only scoreboard an endless game has.
  await poke(`
    s.day = d.rules.market.seasonLength
    s.seasonEarned = 12345
    s.bestSeason = 0
    s.energy = 100
    s.plots[0].cropId = '${firstCrop.id}'
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed; t.watered = 1 })
  `)
  await click(522, 394, 600)
  const closed = await appears(/SEASON OVER|จบฤดูกาล/)
  check('the end of a season is announced', closed.found, JSON.stringify(closed.texts))
  check('with what it earned', closed.texts.some(t => /12,345/.test(t)), JSON.stringify(closed.texts))
  const best = await appears(/best season yet|ดีที่สุด/)
  check('and that it was a personal best', best.found, JSON.stringify(best.texts))
  await appears(/nothing at all will ever match this/, 2500)
}

/* ------------------------------ a new farm is congratulated for its own work */
{
  // What the player has been told lives on the registry so it survives changing
  // screen — which also means it survives starting a new game, and a second farm
  // would then be silently refused every congratulation the first one had.
  const beforeNewGame = await page.evaluate(() =>
    [...(window.__game.registry.get('announcedMilestones') ?? [])].length)
  check('this farm has been congratulated for things', beforeNewGame > 0, String(beforeNewGame))

  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2400))
  await click(208, 284, 900)
  eq('a new game starts', await scene(), 'Farm')

  const afterNewGame = await page.evaluate(() => ({
    done: [...(window.__game.registry.get('announcedMilestones') ?? [])],
    owed: [...(window.__game.registry.get('owedMilestones') ?? [])],
    queued: (window.__game.registry.get('pendingBanners') ?? []).length,
  }))
  eq('and remembers nothing of the last one', afterNewGame.done.length, 0)
  eq('nor anything it still owed', afterNewGame.owed.length, 0)
  eq('nor anything it had waiting', afterNewGame.queued, 0)

  // So the same milestone is celebrated again, on this farm.
  const first = await read('d.milestones[0]')
  await page.evaluate((id) => {
    window.__game.registry.set('milestones', [{ eventId: 'again', milestoneId: id }])
  }, first.id)
  const told = await appears(new RegExp(`^${first.name.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  check('and the new farm is told about it too', told.found,
    `looking for ${first.name.en} in ${JSON.stringify(told.texts)}`)
  await appears(/nothing at all will ever match this/, 2500)
}

/* --------------------------- a congratulation survives walking away from it */
{
  // The banner is drawn into whichever screen is open, but the fact that the
  // game owes the player one is not that screen's business. Earn something and
  // leave immediately: it has to be waiting on the next screen rather than lost,
  // and it must not have been quietly marked as already told.
  for (let i = 0; i < 4 && await scene() !== 'Farm'; i++) { await page.keyboard.press('Escape'); await wait(500) }

  const nextUnseen = await page.evaluate(() => {
    const g = window.__game
    const done = g.registry.get('announcedMilestones') ?? new Set()
    const owed = g.registry.get('owedMilestones') ?? new Set()
    const m = g.registry.get('data').milestones.find(x => !done.has(x.id) && !owed.has(x.id))
    return m ? { id: m.id, name: m.name.en } : null
  })
  check('there is another milestone to earn', !!nextUnseen, 'all of them are already announced')

  if (nextUnseen) {
    await page.evaluate((id) => {
      window.__game.registry.set('milestones', [{ eventId: 'walk', milestoneId: id }])
    }, nextUnseen.id)
    // Leave at once, before it can have finished.
    await page.keyboard.press('KeyC')
    await wait(900)
    eq('and the player walks off to another screen', await scene(), 'Coop')

    const waiting = await appears(new RegExp(`^${nextUnseen.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    check('the congratulation is waiting there instead of being lost',
      waiting.found, `looking for ${nextUnseen.name} in ${JSON.stringify(waiting.texts)}`)

    await appears(/nothing at all will ever match this/, 2500)
    const settled = await page.evaluate(() => ({
      done: [...(window.__game.registry.get('announcedMilestones') ?? [])],
      owed: [...(window.__game.registry.get('owedMilestones') ?? [])],
      queued: (window.__game.registry.get('pendingBanners') ?? []).length,
    }))
    check('and once seen it is settled', settled.done.includes(nextUnseen.id), JSON.stringify(settled))
    eq('with nothing left owed', settled.owed.length, 0)
    eq('and nothing left in the queue', settled.queued, 0)

    await page.keyboard.press('Escape')
    await wait(600)
  }
}

/* ------------------------------- the night says what it actually did */
{
  // The rules report thirteen things about a night and the farm used to read
  // eight of them. Crops rotting in an overfull barn is a real loss and it was
  // taken without a word.
  for (let i = 0; i < 4 && await scene() !== 'Farm'; i++) { await page.keyboard.press('Escape'); await wait(500) }

  const cap = await read('g.__rules.farmLimits(s, d).barnSoftCap')
  await poke(`
    s.energy = 100
    s.barn.crops['${firstCrop.id}'] = ${cap} + 40
    s.plots[0].cropId = '${firstCrop.id}'
    s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed; t.watered = 1 })
  `)
  const before = await read(`s.barn.crops['${firstCrop.id}']`)
  await click(522, 394, 900)
  const after = await read(`s.barn.crops['${firstCrop.id}']`)
  check('an overfull barn really does lose some', after < before, `${before} -> ${after}`)
  const told = await appears(/spoil|เน่า/i, 3000)
  check('and the night says so', told.found, JSON.stringify(told.texts))

  // A new board arriving is what an endless game turns on, so it is news too.
  const weekLength = rules.market.weekLength
  let sawBoard = false
  for (let d = 0; d < weekLength + 1 && !sawBoard; d++) {
    await poke(`
      s.energy = 100
      s.plots[0].cropId = '${firstCrop.id}'
      s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed; t.watered = 1 })
    `)
    await click(522, 394, 700)
    sawBoard = (await texts()).some(t => /new market board|ออเดอร์ชุดใหม่/i.test(t))
  }
  check('a new board is announced when the week turns', sawBoard, 'a week passed in silence')
}

/* ------------------------------------------------ a farm with nothing left */
{
  // A player who spends everything and has nothing growing would be stuck for
  // ever. The rescue is a seed lent against the next sale, and the loan has to
  // be visible or the sale that pays nothing looks like a bug.
  await poke(`
    s.money = 0
    s.debt = 0
    s.barn.crops = {}
    s.barn.goods = {}
    s.seeds = {}
    s.pending = []
    Object.keys(s.animals).forEach(k => { s.animals[k] = 0 })
    s.plots.forEach(p => { p.cropId = null; p.tiles.forEach(t => { t.stage = d.rules.stage.empty; t.watered = 0; t.pest = 0 }) })
    s.energy = 100
  `)
  await click(522, 394, 900)                                  // END DAY on a bare, broke farm
  const seeds = await read('Object.values(s.seeds).reduce((a, b) => a + b, 0)')
  check('a broke and empty farm is given a seed', seeds > 0, `${seeds} seeds`)
  const debt = await read('s.debt')
  check('and it is a loan, not a gift', debt > 0, `debt ${debt}`)
  check('and the farm says what is owed',
    (await texts()).some(t => /loan|หนี้/i.test(t)), JSON.stringify(await texts()))

  // The loan comes off the top of the next sale.
  await poke(`s.barn.crops['${firstCrop.id}'] = 1; s.money = 0`)
  const owed = await read('s.debt')
  const moneyBefore = await read('s.money')
  await page.evaluate((id) => window.__game.registry.get('farm').sellCrop({ cropId: id, count: 1 }), firstCrop.id)
  await wait(400)
  const paidOff = owed - await read('s.debt')
  check('selling pays the loan down first', paidOff > 0, `${owed} -> ${await read('s.debt')}`)
  check('and the farmer keeps only what is left over',
    await read('s.money') - moneyBefore >= 0, `${moneyBefore} -> ${await read('s.money')}`)
  await poke('s.debt = 0')
}

/* ------------------------------------------------ getting about by keyboard */
{
  // Every screen can be reached with a key, because a game that can only be
  // played by hitting small targets with a mouse excludes anyone without one.
  const shortcuts = [
    ['Digit1', 'Plot'], ['Digit2', 'Plot'], ['Digit3', 'Plot'], ['Digit4', 'Plot'],
    ['KeyC', 'Coop'], ['KeyK', 'Workshop'], ['KeyV', 'Shop'], ['KeyM', 'Market'],
  ]
  for (const [key, want] of shortcuts) {
    // Start from the farm each time.
    while (await scene() !== 'Farm') { await page.keyboard.press('Escape'); await wait(500) }
    await page.keyboard.press(key)
    await wait(800)
    eq(`${key} opens ${want}`, await scene(), want)
  }
  while (await scene() !== 'Farm') { await page.keyboard.press('Escape'); await wait(500) }
  check('and Escape always comes home', await scene() === 'Farm')
}

/* ----------------------------------------------- the week turns, the board changes */
{
  // The board is what makes an endless game keep asking something of the
  // player. It has to actually turn over.
  const weekLength = rules.market.weekLength
  const before = await read('s.market.orders.map(o => o.cropId)')
  const weekBefore = await read('s.market.week')
  // Fill every order, so a board that did not turn would be visibly finished.
  await poke('s.market.orders.forEach(o => { o.filled = o.quota })')
  for (let i = 0; i < weekLength; i++) {
    await poke(`
      s.energy = 100
      s.plots[0].cropId = '${firstCrop.id}'
      s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed; t.watered = 1; t.pest = 0 })
    `)
    await click(522, 394, 500)
  }
  const weekAfter = await read('s.market.week')
  check('a week passes', weekAfter > weekBefore, `${weekBefore} -> ${weekAfter}`)
  const after = await read('s.market.orders')
  eq('and the board is asking again', after.filter(o => o.filled < o.quota).length, after.length)
  check('with a full set of orders', after.length === rules.market.orderCount, `${after.length} orders`)
  check('and no order asks for a crop that does not exist',
    await read('s.market.orders.every(o => d.crops.some(c => c.id === o.cropId))'), JSON.stringify(after))
  // Saturation is a week's memory, so it clears with the board.
  eq('and last week\'s glut is forgotten', await read('Object.keys(s.market.sold).length'), 0)
}

/* --------------------------------------------- choosing a seed, past the first */
{
  // The picker pages too: twelve crops will not fit on a 420px stage.
  await poke(`
    s.plots[1].cropId = null
    s.plots[1].tiles.forEach(t => { t.stage = d.rules.stage.empty })
    s.xp = d.progression.thresholdFactor * 30 * 29
    d.crops.forEach(c => { s.seeds[c.id] = 1 })
    s.energy = 100
  `)
  await page.keyboard.press('Digit2')
  await wait(800)
  check('the second field opens', await scene() === 'Plot', await scene())
  await click(45, 378, 700)                                   // the seed bag
  const page1 = await texts()
  check('the picker is open', page1.some(t => /select|choose|เลือก/i.test(t)), JSON.stringify(page1))
  check('and pages, because twelve seeds do not fit',
    page1.some(t => /^\d+ \/ \d+$/.test(t)), JSON.stringify(page1))
  // The picker's pager sits inside the picker, not where the screen's own pager
  // is, so it is found by its glyph rather than by a remembered coordinate.
  const nextPage = await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const t = sc.children.list.filter(o => o.type === 'Text' && o.text === '\u25b6')
      .sort((a, b) => b.depth - a.depth)[0]
    return t ? { x: t.x, y: t.y } : null
  })
  check('the picker has a way to the next page', !!nextPage, JSON.stringify(page1))
  if (nextPage) await click(nextPage.x, nextPage.y, 600)
  const page2 = await texts()
  check('the picker turns the page',
    JSON.stringify(page1) !== JSON.stringify(page2), 'both pages read the same')

  // And picking one of them sows the field.
  const sowed = await page.evaluate(() => {
    const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
    const rows = sc.children.list.filter(o => o.type === 'Text' && /^x\d+$/.test(o.text))
    return rows.length ? { x: rows[0].x - 120, y: rows[0].y } : null
  })
  check('the picker lists seeds to choose from', !!sowed, JSON.stringify(page2))
  if (sowed) {
    await click(sowed.x, sowed.y, 800)
    check('choosing one sows the field', !!(await read('s.plots[1].cropId')), String(await read('s.plots[1].cropId')))
  }
  await page.keyboard.press('Escape')
  await wait(600)
}

/* -------------------------------------------------------------- language */
const englishTexts = await texts()
// Find the chip rather than remembering where it sits: it shares a line with
// the sound toggle now, and both move when a caption changes width.
const chipAt = (label) => page.evaluate((want) => {
  const sc = window.__game.scene.scenes.find(x => x.scene.isActive())
  const t = sc.children.list.find(o => o.type === 'Text' && o.text === want)
  return t ? { x: t.x + t.displayWidth / 2, y: t.y } : null
}, label)
const langChip = await chipAt('EN')
check('the language chip is on screen', !!langChip)
await click(langChip.x, langChip.y, 800)                    // the language chip
const thaiTexts = await texts()
check('switching language changes what is on screen',
  thaiTexts.some(t => /[฀-๿]/.test(t)) && !englishTexts.some(t => /[฀-๿]/.test(t)))
check('the game keeps running after the switch', await scene() === 'Farm')
eq('switching language does not disturb the save', await read('s.day') > 1, true)
await shot('10-thai')
await click(566, 74, 800)                                   // back to English

/* ------------------------------------------------------------- save/load */
await poke('s.money = 4242')
await click(522, 358, 500)                                  // SAVE
// The original said so on a screen rather than in a toast that fades, and a
// save is the one thing a player needs to be sure of.
const said = await texts()
check('saving says so on a screen', said.some(x => /GAME SAVED|บันทึกแล้ว/.test(x)), JSON.stringify(said.slice(0, 6)))
check('and offers the way back', said.some(x => /CONTINUE|เล่นต่อ/.test(x)))
await press(/CONTINUE|เล่นต่อ/, 400)
check('saving writes a slot', await page.evaluate(() => !!localStorage.getItem('simfarm')))
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await wait(2200)
await click(392, 284, 700)                                  // LOAD GAME
// And it shows what it is about to open before opening it.
check('loading shows the farm it found', await press(/CONTINUE|เล่นต่อ/, 900), 'no resume screen')
check('a saved game loads', await scene() === 'Farm')
eq('the loaded game keeps its money', await read('s.money'), 4242)
await shot('11-loaded')

/* ------------------------------------------ a save older than the rule book */
// Adding or removing a crop is documented as an edit to one JSON file, and a
// saved farm outlives that edit. A field growing a crop the edit removed used
// to end the game outright: the night looked it up to age it, found nothing,
// and threw, so the day could never be ended again and the throw repeated for
// ever. This is that save, played by clicking.
{
  await poke(`s.plots[0].cropId = '${firstCrop.id}'; s.plots[0].tiles.forEach(t => { t.stage = d.rules.stage.seed })`)
  await click(522, 358, 500)                                // SAVE
  await press(/CONTINUE|BACK TO MENU/, 400)                 // dismiss the confirmation
  // Age the slot the way a deploy would: the farm still names a crop, the rule
  // book no longer has one by that name.
  const rewritten = await page.evaluate(() => {
    const slot = JSON.parse(localStorage.getItem('simfarm'))
    slot.state.plots[0].cropId = 'crop-that-was-removed'
    slot.state.seeds['crop-that-was-removed'] = 3
    slot.state.animals['animal-that-was-removed'] = 2
    localStorage.setItem('simfarm', JSON.stringify(slot))
    return slot.state.plots[0].cropId
  })
  eq('the slot now names a crop the game does not have', rewritten, 'crop-that-was-removed')

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await wait(2200)
  await click(392, 284, 900)                                // LOAD GAME
  // It shows the farm it found before opening it, so say yes to it.
  await press(/CONTINUE|เล่นต่อ/, 900)
  check('the farm still opens', await scene() === 'Farm', await scene())
  const told = await appears(/THE FARM HAS CHANGED|ไร่มีการเปลี่ยนแปลง/)
  check('and says the game changed under it rather than saying nothing',
    told.found, JSON.stringify(told.texts))
  await shot('11b-rulebook-changed')
  eq('the field is empty rather than lost', await read('s.plots[0].cropId'), null)
  eq('and the crop is gone from the bag', await read(`s.seeds['crop-that-was-removed'] ?? 0`), 0)
  eq('and the herd that was not there is gone', await read(`s.animals['animal-that-was-removed'] ?? 0`), 0)

  // The thing that used to be impossible.
  const dayBefore = await read('s.day')
  await poke('s.energy = 100')
  await click(522, 394, 1200)                               // END DAY
  eq('and the day can be ended', await read('s.day'), dayBefore + 1)

  // Put the farm back where the rest of the run expects it.
  await poke('s.money = 4242')
}

/* ------------------------------------------------------------ end of year */
// The farm is endless by default. A host game can cap it, so drive that path by
// setting a limit on the live rules and stepping onto it.
await poke('d.rules.endDay = s.day + 1')
await click(522, 394, 900)
check('a capped season ends on its last day', await scene() === 'End')
check('the final screen reports the takings', (await texts()).some(t => t.includes('4,242')))
await shot('12-end')

/* ------------------------------------------- and then playing it again */
// Phaser keeps one instance of a scene and shows it again, so everything the
// menu remembered last time is still there. The flag that stops a double tap
// opening two farms was left set by the successful one, and PLAY AGAIN took the
// player back to a menu whose buttons did nothing at all — the game became
// unstartable by finishing it, which no test walked far enough to see.
await click(300, 344, 900)                                  // PLAY AGAIN
check('the end screen goes back to the menu', await scene() === 'Menu', await scene())
await click(208, 284, 1200)                                 // NEW GAME
check('and a season that ended can be played again', await scene() === 'Farm', await scene())
await shot('13-again')

/* --------------------------------------- when there is no server to reach */
// The one failure a player can be left with before there is a game at all: the
// address this build was given answers nothing. Everywhere else a refusal is
// about one action in a farm already being played, and a second of red is the
// right weight for it — here it is the reason the only button on the screen did
// not work, and a message that has gone by the time they look up leaves them
// pressing it again wondering what is broken.
{
  const stranded = await browser.newPage()
  await stranded.setViewport({ width: 1200, height: 840 })
  // A port with nothing behind it, so the answer is a real network failure.
  await stranded.evaluateOnNewDocument(() => {
  localStorage.setItem('simfarm.server', 'http://127.0.0.1:1/')
  localStorage.setItem('simfarm.greeted', '1')
})
  await stranded.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await wait(2600)
  const b = await stranded.$eval('canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await stranded.mouse.click(b.x + b.w * (208 / W), b.y + b.h * (284 / H))
  const said = async () => stranded.evaluate(() => {
    const out = []
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      sc.children.list.forEach(o => { if (o.type === 'Text' && o.visible && o.text) out.push(o.text) })
    }
    return out
  })
  let told = false
  for (let i = 0; i < 30 && !told; i++) { await wait(200); told = (await said()).some(x => /connection|เชื่อมต่อ/i.test(x)) }
  check('a farm that cannot be reached says so', told, JSON.stringify(await said()))
  await wait(4000)
  check('and is still saying so several seconds later',
    (await said()).some(x => /connection|เชื่อมต่อ/i.test(x)), JSON.stringify(await said()))
  const menu = await stranded.evaluate(() => {
    const m = window.__game.scene.getScene('Menu')
    return { starting: m.starting, onMenu: m.scene.isActive() }
  })
  check('the player is left on the menu', menu.onMenu)
  check('with the buttons usable again', menu.starting === false)
  await stranded.close()
}

await browser.close()
check('no console errors anywhere in the run', errors.length === 0, [...new Set(errors)].join(' | '))

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
