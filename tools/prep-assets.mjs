// Lifts the art the game needs out of extracted/ into game/public/assets/.
// Re-runnable and derived: nothing under game/public/assets is hand-edited.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EX = join(ROOT, 'extracted')
const OUT = join(ROOT, 'game/public/assets')
const map = JSON.parse(readFileSync(join(ROOT, 'tools/art-map.json'), 'utf8'))

const dest = (rel) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); return p }
const write = (rel, text) => writeFileSync(dest(rel), text)
const copy = (rel, src) => copyFileSync(src, dest(rel))
const spriteFrame = (id, frame) => join(EX, 'sprites', `DefineSprite_${id}`, `${frame}.svg`)

// The growing-stage frame carries the caterpillar as <use id="ulat">; the game
// decides when a tile has a pest, so it must not be painted into the plant.
const stripPest = (svg) => svg.replace(/<use\b[^>]*\bid="ulat"[^>]*\/>\s*/g, '')

// Scene plates still carry the original game's logo. Drop it — the branding is
// not ours to ship — along with anything else listed in art-map dropIds.
const dropIds = (svg) => (map.dropIds || []).reduce((out, id) =>
  out.replace(new RegExp(`<use\\b[^>]*ffdec:characterId="${id}"[^>]*/>\\s*`, 'g'), ''), svg)

let n = 0
const missing = []
for (const [crop, id] of Object.entries(map.cropMasters)) {
  for (const stage of map.cropStages) {
    const src = spriteFrame(id, stage)
    if (!existsSync(src)) { missing.push(src); continue }
    write(`crops/${crop}/${stage}.svg`, stripPest(readFileSync(src, 'utf8'))); n++
  }
}
for (const [name, [id, frame]] of Object.entries(map.spriteFrames)) {
  const src = spriteFrame(id, frame)
  if (!existsSync(src)) { missing.push(src); continue }
  copy(`art/${name}.svg`, src); n++
}
// The SWF's audio is 11 kHz MPEG that browsers refuse to decode, so re-encode
// it once here rather than shipping files the game would stall on.
// Scene plates: the original frames with their static HUD chrome intact and
// every live layer (crops, rain, cursor, dynamic numbers) already stripped.
for (const [name, frame] of Object.entries(map.scenes || {})) {
  const src = [map.scenesDir, map.scenesFallbackDir]
    .map(dir => join(EX, dir, `${frame}.svg`))
    .find(existsSync)
  if (!src) { missing.push(join(EX, map.scenesDir, `${frame}.svg`)); continue }
  write(`scenes/${name}.svg`, dropIds(readFileSync(src, 'utf8'))); n++
}

// A few scenes want the plate with no HUD chrome painted on it at all.
for (const [name, frame] of Object.entries(map.scenesFromBg || {})) {
  const src = join(EX, map.scenesFallbackDir, `${frame}.svg`)
  if (!existsSync(src)) { missing.push(src); continue }
  write(`scenes/${name}.svg`, dropIds(readFileSync(src, 'utf8'))); n++
}

// The original's own display face, so the remake reads in the game's voice.
for (const [name, file] of Object.entries(map.fonts || {})) {
  const src = join(EX, 'fonts', file)
  if (!existsSync(src)) { missing.push(src); continue }
  copy(`fonts/${name}`, src); n++
}

// Placement data the game reads at runtime: where the tiles and buttons are.
for (const f of ['interaction-map.json', 'interaction-map-ui.json', 'scene-ui-map.json']) {
  const src = join(EX, f)
  if (!existsSync(src)) { missing.push(src); continue }
  copy(`../data/${f}`, src); n++
}

for (const [name, file] of Object.entries(map.sounds)) {
  const src = join(EX, 'sounds', file)
  if (!existsSync(src)) { missing.push(src); continue }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ar', '22050', '-ac', '1', '-b:a', '64k', dest(`sfx/${name}`)])
  n++
}
console.log(`prepared ${n} assets -> game/public/assets`)
if (missing.length) { console.error(`MISSING ${missing.length}:`); missing.forEach(m => console.error('  ' + m)); process.exit(1) }
