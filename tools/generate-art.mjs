// Draws a sprite to order, in the game's house style.
//
// The style is the point and the drawing is not. A chunky cartoon with a heavy
// black outline, flat fills and a soft shadow is a look hundreds of games use;
// what belongs to somebody is the particular turnip. So the style is described
// here once, at length, and each sprite only says what it is — which keeps the
// set consistent and keeps every drawing new.
//
//   node tools/generate-art.mjs <name> "<what it is>"
//   node tools/generate-art.mjs --batch <file.json>
//
// Output lands in generated/<name>.png on flat white, which is what
// tools/prep-generated.py expects to cut.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../generated')

// The house style, in the terms a drawing model responds to.
const STYLE = [
  'flat 2D vector cartoon illustration, children\'s farming game art',
  'thick uniform black outline of even weight around every shape',
  'flat solid colour fill with exactly one lighter highlight shape per form, no gradients, no texture, no shading ramps',
  'bright saturated friendly palette',
  'single object centred, seen from a low three-quarter angle',
  'soft grey elliptical drop shadow on the ground beneath it',
  'pure white background, nothing else in frame, no text, no border, no watermark',
].join(', ')

const env = Object.fromEntries(
  readFileSync(join(HERE, '../.env.local'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
// The base already carries /uapi/v1, so the paths below are relative to it.
const API = env.SNAPGEN_API?.replace(/\/$/, '')
const KEY = env.SNAPGEN_KEY
if (!API || !KEY) { console.error('SNAPGEN_API and SNAPGEN_KEY must be in .env.local'); process.exit(1) }

const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function draw(name, subject) {
  const body = new FormData()
  body.set('model', 'nano-banana-pro')
  body.set('prompt', `${subject}. ${STYLE}`)
  const started = await fetch(`${API}/generate_image`, {
    method: 'POST', headers: { 'x-api-key': KEY }, body,
  }).then(r => r.json())
  const id = started?.uuid ?? started?.data?.uuid ?? started?.id
  if (!id) throw new Error(`no job came back: ${JSON.stringify(started).slice(0, 200)}`)

  for (let tries = 0; tries < 90; tries++) {
    await wait(4000)
    const job = await fetch(`${API}/history/${id}`, { headers: { 'x-api-key': KEY } }).then(r => r.json())
    const state = job?.status ?? job?.data?.status
    if (state === 2) {
      const url = (job.generated_image ?? job.data?.generated_image ?? [])[0]?.file_download_url
      if (!url) throw new Error(`finished with nothing to fetch: ${JSON.stringify(job).slice(0, 200)}`)
      const png = Buffer.from(await fetch(url).then(r => r.arrayBuffer()))
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, `${name}.png`), png)
      return png.length
    }
    if (state === 3 || state === 4) throw new Error(`the drawing failed: ${JSON.stringify(job).slice(0, 200)}`)
  }
  throw new Error('gave up waiting')
}

/**
 * A crop is six drawings that have to look like the same plant at six ages, so
 * they are drawn together on one sheet. Asking six times gives six plants.
 */
const SHEET = (plant) => [
  `Six drawings of one ${plant} at six ages, laid out in exactly two rows of three, read left to right along the top row then left to right along the bottom row`,
  'no frames, no borders, no boxes, no panel outlines, no grid lines, no numbers, no captions — just the six drawings on one sheet of plain white',
  'first: a few seeds lying on bare ground',
  'second: a tiny sprout with two small leaves',
  'third: a small young plant, a few leaves and nothing else',
  'fourth: a bigger leafy plant, clearly larger than the third, still nothing ripe on it',
  `fifth: the same plant fully grown and ripe, the ${plant} clearly ready to pick`,
  'sixth: the same plant dead and withered, brown and drooping',
  'each of the six evenly spaced with clear white space between them, each with its own small soft grey elliptical shadow directly beneath it',
  // The field tile the game draws underneath already is the soil, so a patch of
  // earth here would sit on top of it as a second, differently coloured ground.
  // The generator adds one anyway unless told several times over not to.
  'IMPORTANT: the plants sit on plain white with nothing beneath them except a plain grey shadow ellipse',
  'absolutely no soil, no dirt, no earth, no brown ground, no mound, no patch of ground, no tile, no pot, no container, no grass',
  'the seeds in the first drawing rest directly on white, not on earth',
].join('. ')

const args = process.argv.slice(2)
const sheet = args[0] === '--sheet'
const jobs = args[0] === '--batch'
  ? Object.entries(JSON.parse(readFileSync(args[1], 'utf8')))
  : sheet
    ? [[`${args[1]}-sheet`, SHEET(args.slice(2).join(' '))]]
    : [[args[0], args.slice(1).join(' ')]]

for (const [name, subject] of jobs) {
  if (!name || !subject) { console.error('usage: generate-art.mjs <name> "<what it is>"'); process.exit(1) }
  try {
    const size = await draw(name, subject)
    console.log(`  ${name.padEnd(22)} ${(size / 1024).toFixed(0)} KB`)
  } catch (err) {
    console.error(`  ${name.padEnd(22)} ${err.message}`)
  }
}
