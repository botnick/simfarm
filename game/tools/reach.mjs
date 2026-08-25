// Can every piece of content actually be reached by playing?
//
// The data file is the game, and a thing nobody can get to is a thing nobody
// will report as broken. This walks the content rather than the code: every
// crop, animal, feed, recipe, good and milestone, and asks how a player arrives
// at it — and whether the rules will let them.
import { readFileSync } from 'node:fs'
import * as rules from '../src/core/rules.js'
import { levelFor, unlockedCropIds } from '../src/core/progression.js'

const data = JSON.parse(readFileSync(new URL('../public/data/game.json', import.meta.url), 'utf8'))

let pass = 0
const failures = []
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

console.log('\nreachable content\n')

const cropIds = new Set(data.crops.map(c => c.id))
const goodIds = new Set(data.goods.map(g => g.id))
const supplyIds = new Set(data.supplies.map(s => s.id))

/* ------------------------------------------------------------------- crops */
{
  const bad = data.crops.filter(c => !(c.seedPrice > 0) || !(c.sellPrice > 0) || !(c.daysPerStage > 0) || !(c.harvests > 0))
  ok('every crop can be bought, grown and sold', bad.length === 0, bad.map(c => c.id).join(', '))

  const unreachable = data.crops.filter(c => (c.unlockLevel ?? 1) > 1 && !Number.isFinite(levelFor(0, data) + 0))
  ok('every crop unlocks at a level the curve reaches', unreachable.length === 0, unreachable.map(c => c.id).join(', '))

  // A crop nobody can afford at the level it unlocks is unreachable in practice.
  const tooDear = data.crops.filter(c => c.seedPrice > 100000)
  ok('no crop costs more than a farm could hold', tooDear.length === 0, tooDear.map(c => c.id).join(', '))

  const artless = data.crops.filter(c => !c.art)
  ok('every crop names its art', artless.length === 0, artless.map(c => c.id).join(', '))
}

/* ----------------------------------------------------------------- animals */
{
  const bad = data.animals.filter(a => !supplyIds.has(a.feed) || !goodIds.has(a.produces) || !(a.max > 0) || !(a.price > 0))
  ok('every animal has a feed it can eat and a good it makes', bad.length === 0, bad.map(a => a.id).join(', '))

  // A feed nobody sells and nobody can craft is an animal nobody can keep.
  const craftable = new Set(data.recipes.filter(r => r.output.supply).map(r => r.output.supply))
  const buyable = new Set(data.supplies.filter(s => s.price > 0).map(s => s.id))
  const starving = data.animals.filter(a => !craftable.has(a.feed) && !buyable.has(a.feed))
  ok('and a feed that can be got hold of', starving.length === 0,
    starving.map(a => `${a.id} eats ${a.feed}`).join(', '))
}

/* ----------------------------------------------------------------- recipes */
{
  const broken = []
  for (const r of data.recipes) {
    for (const i of r.inputs) {
      if (i.crop && !cropIds.has(i.crop)) broken.push(`${r.id} wants crop ${i.crop}`)
      if (i.good && !goodIds.has(i.good)) broken.push(`${r.id} wants good ${i.good}`)
      if (i.supply && !supplyIds.has(i.supply)) broken.push(`${r.id} wants supply ${i.supply}`)
    }
    const out = r.output
    if (out.good && !goodIds.has(out.good)) broken.push(`${r.id} makes unknown good ${out.good}`)
    if (out.supply && !supplyIds.has(out.supply)) broken.push(`${r.id} makes unknown supply ${out.supply}`)
    if (!out.good && !out.supply) broken.push(`${r.id} makes nothing`)
  }
  ok('every recipe asks for and makes things that exist', broken.length === 0, broken.join('; '))

  // A recipe whose ingredients come from crops the player cannot reach is a
  // recipe they can see and never make.
  const stuck = data.recipes.filter(r => r.inputs.some(i => {
    if (!i.crop) return false
    const crop = data.crops.find(c => c.id === i.crop)
    return !crop
  }))
  ok('and none depends on a crop that does not exist', stuck.length === 0, stuck.map(r => r.id).join(', '))

  // Every good is either laid by an animal or made by a recipe. One that is
  // neither can only ever be a price in a list.
  const fromAnimals = new Set(data.animals.map(a => a.produces))
  const fromRecipes = new Set(data.recipes.filter(r => r.output.good).map(r => r.output.good))
  const orphans = data.goods.filter(g => !fromAnimals.has(g.id) && !fromRecipes.has(g.id))
  ok('every good can actually be obtained', orphans.length === 0, orphans.map(g => g.id).join(', '))
}

/* -------------------------------------------------------------- milestones */
{
  // A milestone is raised by name: the rules ask for everything with a given
  // `when` at the moment that thing happens. A milestone naming a moment the
  // rules never ask about can never be raised, and nothing else would say so.
  const RAISED = ['harvest', 'craft', 'animal', 'level', 'season']
  const orphaned = data.milestones.filter(m => !RAISED.includes(m.when))
  ok('every milestone waits for a moment the rules actually announce',
    orphaned.length === 0, orphaned.map(m => `${m.id} waits for ${m.when}`).join(', '))

  // And the two kinds that carry a threshold need one that a farm can pass.
  const unreachable = data.milestones.filter(m =>
    (m.when === 'level' && !(m.level > 0)) || (m.when === 'season' && !(m.earned > 0)))
  ok('and any threshold it names is one a farm can pass',
    unreachable.length === 0, unreachable.map(m => m.id).join(', '))

  // Every moment the rules announce should have something listening, or the
  // announcement is dead code.
  const listened = new Set(data.milestones.map(m => m.when))
  const silent = RAISED.filter(w => !listened.has(w))
  ok('and every moment the rules announce has something listening',
    silent.length === 0, silent.join(', '))
}

/* ------------------------------------------------ and it all plays through */
{
  // The strongest check: play far enough to unlock everything and confirm each
  // crop can be planted, each animal bought, each recipe started.
  const s = rules.newGame(data)
  s.money = 1e9
  s.xp = data.progression.thresholdFactor * (rules.levelOf(s, data) + 400) * 400
  const level = rules.levelOf(s, data)
  ok('a farm can reach the level the last crop needs',
    level >= Math.max(...data.crops.map(c => c.unlockLevel ?? 1)), `level ${level}`)
  ok('and the level the last animal needs',
    level >= Math.max(...data.animals.map(a => a.unlockLevel ?? 1)), `level ${level}`)

  const cannotBuy = data.crops.filter(c => !rules.buySeed(s, data, c.id))
  ok('every crop can be bought at that level', cannotBuy.length === 0, cannotBuy.map(c => c.id).join(', '))

  const cannotKeep = data.animals.filter(a => !rules.buyAnimal(s, data, a.id))
  ok('every animal can be bought', cannotKeep.length === 0, cannotKeep.map(a => a.id).join(', '))

  // Stock the barn generously and start every recipe.
  const cannotMake = []
  for (const r of data.recipes) {
    const t = rules.newGame(data)
    t.money = 1e9
    t.energy = 1e6
    t.xp = s.xp
    for (const c of data.crops) t.barn.crops[c.id] = 999
    for (const g of data.goods) t.barn.goods[g.id] = 999
    for (const sup of data.supplies) t.supplies[sup.id] = 999
    if (!rules.craft(t, data, r.id)) cannotMake.push(r.id)
  }
  ok('every recipe can be started with a full barn', cannotMake.length === 0, cannotMake.join(', '))

  // And every animal can be fed the thing it eats.
  const cannotFeed = []
  for (const a of data.animals) {
    const t = rules.newGame(data)
    t.energy = 1e6
    t.animals[a.id] = 1
    t.supplies[a.feed] = 99
    if (rules.feedAnimals(t, data, a.id) < 1) cannotFeed.push(`${a.id} on ${a.feed}`)
  }
  ok('every animal can be fed what it eats', cannotFeed.length === 0, cannotFeed.join(', '))
}

/* --------------------------------------------- and readable in both languages */
{
  // The game is played in two languages and a missing string does not throw —
  // it falls back to English, or failing that renders its own key. Both are
  // quiet, which is exactly why adding an English line and forgetting the Thai
  // one would otherwise ship.
  const { readdirSync, statSync } = await import('node:fs')
  const strings = JSON.parse(readFileSync(new URL('../public/data/strings.json', import.meta.url), 'utf8'))
  const langs = Object.keys(strings).filter(k => !k.startsWith('_'))
  ok('the game speaks more than one language', langs.length > 1, langs.join(', '))

  const every = new Set(langs.flatMap(l => Object.keys(strings[l])))
  for (const l of langs) {
    const missing = [...every].filter(k => !(k in strings[l]))
    ok(`${l} says everything the other languages say`, missing.length === 0,
      `${missing.length} missing: ${missing.slice(0, 6).join(', ')}`)
    const blank = Object.entries(strings[l]).filter(([, v]) => !String(v).trim()).map(([k]) => k)
    ok(`and none of ${l} is left blank`, blank.length === 0, blank.slice(0, 6).join(', '))
  }

  // Every line has to be reachable from the code, and every line the code asks
  // for has to exist. A key that is asked for and missing renders as its own
  // name on screen; a key that exists and is never asked for is a line somebody
  // wrote, translated, and then orphaned when the screen around it was rewritten
  // — this found forty-two of those, and three of them turned out to be things
  // the game computed and never told the player.
  //
  // Any quoted literal counts as asking, not only t('key'), because keys are
  // also reached through ternaries and lookup tables, and a scan that only
  // understood one shape would report the rest as dead.
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : []
  })
  const here = new URL('..', import.meta.url).pathname
  const sources = [...walk(`${here}src`), `${here}index.html`]
  const literals = new Set()
  const asked = new Set()
  for (const file of sources) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const m of text.matchAll(/['"`]([a-zA-Z][\w.]*)['"`]/g)) literals.add(m[1])
    for (const m of text.matchAll(/\bt\(\s*['"]([a-zA-Z][\w.]*)['"]/g)) asked.add(m[1])
  }
  ok('the code asks for lines by name in the first place', asked.size > 40, `${asked.size} found`)

  const unwritten = [...asked].filter(k => !every.has(k))
  ok('every line the code asks for has been written', unwritten.length === 0, unwritten.join(', '))

  const orphaned = [...every].filter(k => !literals.has(k))
  ok('and no line is written that nothing reaches', orphaned.length === 0, orphaned.join(', '))
}

/* ------------------------------------- and reachable in a life somebody has */
{
  // Reachable at a high enough level is not the same as reachable. This suite
  // spent a while proving the first and never asked the second, and the answer
  // was that six of sixteen things could not be got to in four months of good
  // play. tools/pace.mjs measures it properly; this keeps it from drifting back.
  const f = data.progression.thresholdFactor
  const hardest = Math.max(
    ...data.crops.map(c => c.unlockLevel ?? 1),
    ...data.animals.map(a => a.unlockLevel ?? 1))
  // A field picked once a day is a modest day's work, and the floor for what a
  // player earns. Orders and crafting pay more.
  const perDay = data.progression.xp.harvestTile * data.rules.tilesPerPlot
  const days = Math.round(f * hardest * (hardest - 1) / perDay)
  ok('the last thing the game has to offer is reachable in a season',
    days < 120, `${days} days at one field a day`)
  ok('and is not handed over in the first week either',
    days > 20, `${days} days — nothing left to look forward to`)

  // Whatever a milestone rewards has to be something a player can get to.
  const levelGates = data.milestones.filter(m => m.when === 'level').map(m => m.level)
  const beyond = levelGates.filter(l => l > hardest * 2)
  ok('no milestone waits for a level far past the last unlock', beyond.length === 0, beyond.join(', '))
}

{
  // The rule book has to hang together with itself. Every id in it that points
  // at another id — what an animal eats, what it produces, what a recipe takes
  // and makes, what a tool consumes, which seed the rescue loan hands back — is
  // a reference nothing checks while the game is running. Break one and the
  // game still starts; the break arrives later, in the night, on somebody's
  // farm, as a crash with no way back.
  const problems = rules.checkData(data)
  ok('the rule book refers only to things it contains', problems.length === 0, problems.join(' | '))

  // And the check has to be worth having, so it is shown a broken book.
  const broken = structuredClone(data)
  broken.animals[0].feed = 'no-such-supply'
  broken.recipes[0].output = { amount: 1 }
  broken.rules.rescue.cropId = 'no-such-crop'
  const found = rules.checkData(broken)
  ok('a feed that names nothing is caught', found.some(p => p.includes('no-such-supply')), found.join(' | '))
  ok('a recipe that makes nothing is caught', found.some(p => p.includes('makes nothing')), found.join(' | '))
  ok('and a rescue loan for a crop that was removed', found.some(p => p.includes('no-such-crop')), found.join(' | '))

  // The number of fields is written down in three places that must agree: the
  // rule book, the constant the rules check it against, and the screens
  // themselves. Generalising the UI without moving the constant would leave the
  // check refusing a rule book the game could now perfectly well show; moving
  // the constant without the UI would let one through that it cannot.
  const plotScene = readFileSync(new URL('../src/scenes/PlotScene.js', import.meta.url), 'utf8')
  const frames = plotScene.match(/const FRAME_OF_PLOT = \[([^\]]*)\]/)?.[1].split(',').length
  const scenes = plotScene.match(/const SCENE_OF_PLOT = \[([^\]]*)\]/)?.[1].split(',').length
  eq('there is a field screen for every field the game gives out', frames, rules.BUILT_FOR.plots)
  eq('and a backdrop for each of them', scenes, rules.BUILT_FOR.plots)
  eq('and the rule book asks for exactly that many', data.rules.plots, rules.BUILT_FOR.plots)
  eq('and a field holds the number of tiles the screens mark out',
    data.rules.tilesPerPlot, rules.BUILT_FOR.tilesPerPlot)

  const oversized = structuredClone(data)
  oversized.rules.plots = rules.BUILT_FOR.plots + 1
  ok('a rule book asking for a field the game cannot show is caught',
    rules.checkData(oversized).some(p => p.includes('screens for')))

  const twins = structuredClone(data)
  twins.crops.push({ ...twins.crops[0] })
  ok('and two crops sharing one id', rules.checkData(twins).some(p => p.includes('two things called')))

  const nameless = structuredClone(data)
  delete nameless.animals[0].name.th
  ok('and something with no name in one of the two languages',
    rules.checkData(nameless).some(p => p.includes('no th name')))

  const toolless = structuredClone(data)
  toolless.tools = toolless.tools.filter(t => t.id !== 'clear')
  ok('and a rule book with no way to clear withered ground',
    rules.checkData(toolless).some(p => p.includes('"clear" tool')))

  // The numbers the night reads on every tile, every animal and every barn.
  // Without them the server starts perfectly well and then fails every single
  // night — which, now that a failed night changes nothing, is a farm that
  // simply cannot be played rather than one that breaks loudly.
  const nightless = structuredClone(data)
  delete nightless.rules.stage
  ok('a rule book the night cannot read is caught',
    rules.checkData(nightless).some(p => p.includes('every night reads them')))
  const jumbled = structuredClone(data)
  jumbled.rules.stage.dead = jumbled.rules.stage.seed - 1
  ok('and stages that run in the wrong order',
    rules.checkData(jumbled).some(p => p.includes('out of order')))
  const wordy = structuredClone(data)
  wordy.rules.barn.spoilRate = 'a quarter'
  ok('and a number written as a word',
    rules.checkData(wordy).some(p => p.includes('not a number')))

  const empty = structuredClone(data)
  empty.crops = []
  ok('a rule book with nothing to grow is caught', rules.checkData(empty).some(p => p.includes('nothing to grow')))
  const locked = structuredClone(data)
  locked.crops = locked.crops.map(c => ({ ...c, unlockLevel: 4 }))
  ok('and one where a new farm could never plant anything',
    rules.checkData(locked).some(p => p.includes('never start')))
}

console.log(`\n${pass} passed, ${failures.length} failed\n`)
if (failures.length) { failures.forEach(f => console.error(`  ${f}`)); process.exit(1) }
