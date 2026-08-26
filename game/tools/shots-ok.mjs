// Which screenshot sets are safe to show somebody.
//
// Pictures outlive the run that took them. A tool that dies leaves whatever it
// wrote before, and nothing about a PNG says how old it is or whether the run
// finished — which is how six-hour-old screenshots ended up being shown as the
// current game. Every set now carries a manifest written last; no manifest
// means no run ever said it finished.
//
//   node tools/shots-ok.mjs            # report every set
//   node tools/shots-ok.mjs shots/e2e  # and fail if that one is not complete
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shotsComplete } from './lib/shots.mjs'

const root = 'shots'
const asked = process.argv[2] ?? null
if (!existsSync(root)) { console.log('no screenshots yet'); process.exit(0) }

const age = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

let bad = 0
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name)
  if (!statSync(dir).isDirectory()) continue
  // A directory filled by a tool run once per language and shape carries one
  // manifest per prefix, so look for all of them.
  const markers = readdirSync(dir).filter(f => f.endsWith('COMPLETE.json'))
  const shots = readdirSync(dir).filter(f => f.endsWith('.png')).length
  // Only counts as a run in progress if the process that owns it still exists;
  // otherwise it is wreckage from something that was killed outright.
  const staging = readdirSync(dir).some(f => {
    const m = /^\.staging-.*-(\d+)$/.exec(f)
    if (!m) return false
    try { process.kill(Number(m[1]), 0); return true } catch { return false }
  })
  if (!markers.length) {
    // Two different things, and worth telling apart: a run happening right now,
    // and a set nobody ever vouched for.
    const state = staging ? 'INCOMPLETE ' : 'UNVERIFIED '
    const why = staging ? 'a run is partway through' : 'no run ever said it finished'
    console.log(`  ${state} ${dir.padEnd(18)} ${shots} pictures, ${why}`)
    if (shots && !staging) bad++
    continue
  }
  for (const m of markers) {
    const info = shotsComplete(dir, m.replace('COMPLETE.json', ''))
    const label = m === 'COMPLETE.json' ? dir : `${dir}/${m.replace('COMPLETE.json', '*')}`
    // Complete is not the same as green, and saying only "ok" would blur them.
    const state = info.outcome === 'pass' ? 'VERIFIED GREEN'
      : info.outcome === 'fail' ? 'VERIFIED RED  '
        : 'VERIFIED ?    '
    // A commit alone claims a provenance most of these do not have.
    const tree = info.dirty === true ? ` ${info.commit}+uncommitted` : info.dirty === false ? ` ${info.commit}` : ` ${info.commit}?`
    // Not every tool counts assertions; the ones that do not still report an
    // outcome, and printing "null/0" for them was worse than printing nothing.
    const score = info.passed == null || info.failed == null
      ? (info.failed ? ` ${info.failed} failed` : '')
      : ` ${info.passed}/${info.passed + info.failed}`
    console.log(`  ${state} ${label.padEnd(18)} ${info.count} pictures,${tree},${score} ${age(info.finished)}`)
    if (info.outcome === 'fail') bad++
  }
}
if (asked) {
  const ok = shotsComplete(asked) ?? readdirSync(asked).some(f => f.endsWith('COMPLETE.json'))
  if (!ok) { console.error(`\n${asked} has no completion manifest — do not show these to anyone`); process.exit(1) }
}
process.exit(bad && asked ? 1 : 0)
