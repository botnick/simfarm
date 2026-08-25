// Checks that every screen has the click regions it needs, without a browser.
//
// This exists because of a bug that shipped: the tile coordinates for fields
// two to four live in a different file from field one's, only one file was
// being read, and the missing regions produced no error at all — the fields
// simply drew nothing and ignored every click. A silent empty list is the
// dangerous part, so it is now an explicit failure here.
import { readFileSync } from 'node:fs'

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
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = check()
  for (const p of problems) console.error(`  ${p}`)
  console.log(problems.length ? `\n${problems.length} problem(s)\n` : '\nevery screen has the regions it needs\n')
  process.exit(problems.length ? 1 : 0)
}
