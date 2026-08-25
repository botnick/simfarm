// Checks that every screen has the click regions it needs, without a browser.
//
// This exists because of a bug that shipped: the tile coordinates for fields
// two to four live in a different file from field one's, only one file was
// being read, and the missing regions produced no error at all — the fields
// simply drew nothing and ignored every click. A silent empty list is the
// dangerous part, so it is now an explicit failure here.
import { readFileSync, readdirSync } from 'node:fs'

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'))
const first = load('interaction-map.json')
const refined = load('interaction-map-ui.json')

/** The same union-by-role the game does, kept deliberately identical. */
export function regionsFor(frame) {
  const key = String(frame)
  const merged = new Map()
  for (const r of first.frame?.[key] ?? []) merged.set(r.role, r)
  for (const r of refined.frame?.[key] ?? []) merged.set(r.role, r)
  return [...merged.values()]
}

const TILES = Array.from({ length: 12 }, (_, i) => `tile:${i + 1}`)
const TOOLS = ['tool:pick', 'tool:water', 'tool:fertilizer', 'tool:spray', 'tool:cut']

export const REQUIRED = {
  15: ['goto:field1', 'goto:field2', 'goto:field3', 'goto:field4', 'goto:coop', 'goto:house', 'goto:village'],
  20: [...TILES, ...TOOLS, 'home', 'plant', 'sell-bin'],
  25: [...TILES, ...TOOLS, 'home', 'plant', 'sell-bin'],
  30: [...TILES, ...TOOLS, 'home', 'plant', 'sell-bin'],
  35: [...TILES, ...TOOLS, 'home', 'plant', 'sell-bin'],
  40: ['tool:feed', 'home', 'feed-chickens', 'pick-egg:1'],
  55: ['back:village'],
}

export function check() {
  const problems = []
  for (const [frame, needed] of Object.entries(REQUIRED)) {
    const have = new Set(regionsFor(frame).map(r => r.role))
    for (const role of needed) if (!have.has(role)) problems.push(`frame ${frame} is missing ${role}`)
    // A region with no size would be invisible to a click even if it is listed.
    for (const r of regionsFor(frame)) {
      if (!(r.w > 0 && r.h > 0)) problems.push(`frame ${frame} region ${r.role} has no size`)
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) problems.push(`frame ${frame} region ${r.role} has no position`)
    }
  }
  problems.push(...plates())
  return problems
}

/**
 * A plate painted into a screen's artwork has to be filled in.
 *
 * The coop's backdrop has a money plate drawn on it. The scene asked `makeHud`
 * for a frame that does not exist, so the readout was never created, and the
 * plate sat there empty — on the one screen besides the shop where money
 * actually changes, since the flock's produce is sold from it. Nothing failed;
 * it just looked like a hole in the picture, and only turned up by looking.
 *
 * So: a scene that takes its hotspots from a frame whose artwork has a slot
 * must build its readouts from a frame that has that slot too.
 */
export function plates() {
  const hud = load('interaction-map-ui.json').hudByFrame ?? {}
  const boxesFor = (frame) => {
    let boxes = hud[String(frame)]
    if (typeof boxes === 'string') boxes = hud[boxes.replace('same-as:', '')]
    return boxes ?? null
  }
  const problems = []
  const dir = new URL('../src/scenes/', import.meta.url)
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('Scene.js')) continue
    const src = readFileSync(new URL(file, dir), 'utf8')
    const asked = src.match(/makeHud\(this,\s*([^,)]+)/)?.[1]?.trim().replace(/['"]/g, '')
    if (!asked) continue
    const painted = src.match(/regions\(this,\s*(\d+)\s*\)/)?.[1]
    // A frame nobody has heard of gives back nothing at all, silently.
    if (/^\d+$/.test(asked) && !boxesFor(asked)) {
      problems.push(`${file} builds its readouts from frame ${asked}, which has no slots`)
    }
    if (!painted) continue
    const paintedSlots = (boxesFor(painted) ?? []).map(b => b.role)
    const filledSlots = (boxesFor(asked) ?? []).map(b => b.role)
    for (const slot of paintedSlots) {
      if (!filledSlots.includes(slot)) {
        problems.push(`${file} is drawn on frame ${painted}, which has a ${slot} painted on it, `
          + `but builds its readouts from ${asked} — that slot stays empty`)
      }
    }
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = check()
  for (const p of problems) console.error(`  ${p}`)
  console.log(problems.length ? `\n${problems.length} problem(s)\n` : '\nevery screen has the regions it needs\n')
  process.exit(problems.length ? 1 : 0)
}
