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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../generated')

// The house style, in the owner's own production wording.
//
// Three attempts guessed at this and each was wrong in a different way. The
// first copied the original Flash game's flat black outline, which is somebody
// else's idiom. The second read the supplied icons, saw shading, and produced
// gradients. The third measured the icons and produced gradients with more
// conviction.
//
// The answer was in their own toolkit all along, and it reconciles the guide
// with the pictures in five words: "flat colors, no gradients, glossy simple
// highlights". Not shading — flat colour with a gloss shape laid on top. That
// is why the icons look rendered while the guide says flat, and both are right.
//
// Their rule about resolution is taken too, and it is the same lesson learned
// the hard way here: the art is drawn large and shown small, so it has to be
// drawn to survive the shrink.
const STYLE = [
  'cute doodle cartoon game asset',
  'dark-brown outlines (#4a3222), flat warm colors, no gradients, glossy simple highlights, rounded chubby shapes',
  'top-down slightly angled view, plain pure white background',
  'leaf greens #6fb54a and #5da03f, cream #f7e7c5, warm brown #a5683c, orange #f2a541',
  'crisp clean line art, every shape sharp and fully drawn — this art is downscaled to a small in-game size later, so it must still read clearly at 80 pixels wide',
  'keep the line weight identical everywhere in the picture',
  'bold and simple: six or seven large shapes, no fine detail, no thin lines, no hatching',
  'a soft dark elliptical shadow on the ground beneath it',
  'nothing else in frame, no text, no border, no watermark, no frame',
].join(', ')

const env = Object.fromEntries(
  readFileSync(join(HERE, '../.env.local'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
// The base already carries /uapi/v1, so the paths below are relative to it.
const API = env.SNAPGEN_API?.replace(/\/$/, '')
const KEY = env.SNAPGEN_KEY
if (!API || !KEY) { console.error('SNAPGEN_API and SNAPGEN_KEY must be in .env.local'); process.exit(1) }

const wait = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * A drawing of ours to hold the style to.
 *
 * Words only get so far: three runs of the same prompt gave three different
 * outline weights and three different layouts. A picture settles it — but it
 * has to be a picture we own. Handing the model the original game's sprite and
 * asking for something like it produces a derivative of that sprite, which is
 * the exact thing this whole exercise exists to avoid.
 *
 * The owner's own finished art, out of their toolkit: a single object rather
 * than a character, which is what a crop is. It shows the treatment their
 * wording describes — flat colour with a gloss laid on top, not shading — and
 * pins down the one thing words kept failing at.
 */
const REFERENCE = join(HERE, '../generated/_style/object-anchor.png')

/**
 * Redrawing a frame from the frame itself.
 *
 * The house style as written above is for objects: white ground, a shadow
 * under it, nothing else in shot. A frame needs the opposite — it fills the
 * picture and has no background to speak of — so it gets its own wording.
 */
const SCENE_STYLE = [
  'cute doodle cartoon game art',
  'dark-brown outlines (#4a3222), flat warm colors, no gradients, no textures, no noise',
  'leaf greens #8fce5a and #6fb54a, cream #f7e7c5, warm brown #a5683c, orange #f2a541',
  'keep the line weight identical everywhere in the picture',
  'the picture fills the whole frame edge to edge, no border, no margin, no white background, no drop shadow around the picture',
  'no text, no letters, no numbers, no watermark, no logo, no signature, no UI labels',
].join(', ')

const REDRAW = () => [
  'Redraw this picture in a new art style.',
  'Keep the composition EXACTLY as it is: every object stays at the same position,',
  'the same size, and the same angle as in the reference. Do not move anything,',
  'do not add anything, do not remove anything, do not re-arrange anything.',
  'Same camera, same framing, same proportions, edge to edge.',
  'Only the drawing style changes:',
  SCENE_STYLE,
].join(' ')

async function draw(name, subject, guideOverride) {
  const body = new FormData()
  body.set('model', 'nano-banana-pro')
  // A redraw carries its own wording end to end; the object style would fight
  // it (white ground, a shadow under the subject, nothing else in frame).
  body.set('prompt', guideOverride ? subject : `${subject}. ${STYLE}`)
  const plan = name.startsWith('scene-') && name.endsWith('-full')
    ? join(HERE, `../generated/_plans/${name.slice('scene-'.length, -'-full'.length)}.png`)
    : null
  const guide = guideOverride ?? (plan && existsSync(plan) ? plan : REFERENCE)
  if (existsSync(guide)) {
    const png = readFileSync(guide)
    body.set('image', new Blob([png], { type: 'image/png' }), 'reference.png')
  }
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

/**
 * A whole scene, painted onto a plan.
 *
 * Every clickable thing in a backdrop is bound to a rectangle the game already
 * listens to, so the house cannot simply go wherever it looks best. The plan
 * drawn by tools/scene-plan.py puts a flat block at each of those rectangles;
 * this asks for the scene to be painted over it, keeping every block where it
 * is. The plan is our own drawing, so nothing about the original game's layout
 * comes along with it.
 */
const SCENE = (what) => [
  `${what}, seen from above at a slight angle`,
  // Only the ground and the scenery. Three attempts established that the model
  // will not hold a layout however firmly it is asked: told to leave every
  // block where the plan put it, it returned a lovely farm with the field
  // hotspot sitting on the cottage and the road hotspot on a field. So it is
  // asked for the part it is good at — a continuous, populated ground — and
  // everything the game needs to be in an exact place is put there afterwards.
  'THE PICTURE MUST FILL THE WHOLE RECTANGLE, edge to edge and corner to corner: no white border, no round island, no vignette, no frame',
  'NO BUILDINGS, NO TILLED FIELDS, NO PLOTS OF BARE EARTH, NO PATHS — those are added later and must not appear here',
  'just grass with small scenery scattered over it: tufts, clover, daisies, little stones, a fence along one edge, low bushes around the outside',
  'nothing large, nothing in the middle, nothing that would sit under a building',
  'even and continuous, the same kind of ground everywhere',
].join('. ')

const args = process.argv.slice(2)
const sheet = args[0] === '--sheet'
const scene = args[0] === '--scene'
const redraw = args[0] === '--redraw'
const jobs = redraw
  ? [[args[1], REDRAW(), args[2]]]
  : args[0] === '--batch'
  ? Object.entries(JSON.parse(readFileSync(args[1], 'utf8')))
  : sheet
    ? [[`${args[1]}-sheet`, SHEET(args.slice(2).join(' '))]]
    : scene
      ? [[`scene-${args[1]}-full`, SCENE(args.slice(2).join(' '))]]
      : [[args[0], args.slice(1).join(' ')]]

for (const [name, subject, guide] of jobs) {
  if (!name || !subject) { console.error('usage: generate-art.mjs <name> "<what it is>"'); process.exit(1) }
  try {
    const size = await draw(name, subject, guide)
    console.log(`  ${name.padEnd(22)} ${(size / 1024).toFixed(0)} KB`)
  } catch (err) {
    console.error(`  ${name.padEnd(22)} ${err.message}`)
  }
}
