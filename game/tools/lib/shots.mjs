import { mkdirSync, rmSync, readdirSync, renameSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Screenshots that are only published if the run that took them finished.
 *
 * The screenshot tool crashed for six hours and left every image from before it
 * broke exactly where it was. It exited non-zero and printed a stack, and the
 * pictures were still picked up afterwards and shown as the current game — the
 * terminal that saw the failure and the eye that read the pictures were hours
 * and several steps apart.
 *
 * Emptying the directory first was the obvious fix and it is not enough: a run
 * that dies halfway then leaves a *partial new* set, which lies exactly as
 * quietly, and worse if the picture somebody wants is among the early ones.
 *
 * So evidence is written to a staging directory and moved into place only when
 * the run says it finished, and a manifest is written last. Absence of failure
 * is not a completion signal; the manifest is.
 */
const commit = () => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

/**
 * Whether the tree had uncommitted changes when the pictures were taken.
 *
 * A commit alone claims a provenance these pictures often do not have: most of
 * tonight's screenshots were of work that was not committed yet, so naming the
 * commit and nothing else says they show something they do not.
 */
const dirty = () => {
  try { return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 } catch { return null }
}

export function beginShots(dir, { prefix = '', expect = null, ...meta } = {}) {
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, `${prefix}COMPLETE.json`)
  // The old set stops being trustworthy the moment this run starts.
  try { rmSync(marker, { force: true }) } catch { /* never existed */ }

  // Sweep staging left by runs that are no longer alive. The exit handler below
  // covers everything a process can see, and SIGKILL is not one of those — so
  // without this a hard-killed run leaves a directory that looks like a run in
  // progress for ever, and nothing ever cleans it up.
  for (const name of readdirSync(dir)) {
    const m = /^\.staging-.*-(\d+)$/.exec(name)
    if (!m) continue
    const owner = Number(m[1])
    if (owner === process.pid) continue
    let alive = false
    try { process.kill(owner, 0); alive = true } catch { alive = false }
    if (!alive) { try { rmSync(join(dir, name), { recursive: true, force: true }) } catch { /* raced */ } }
  }

  const staging = join(dir, `.staging-${prefix || 'all'}-${process.pid}`)
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* never existed */ }
  mkdirSync(staging, { recursive: true })

  const started = new Date().toISOString()
  let published = false

  // Whatever ends the run, an unpublished staging directory goes with it.
  const sweep = () => { if (!published) { try { rmSync(staging, { recursive: true, force: true }) } catch { /* gone */ } } }
  process.on('exit', sweep)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { sweep(); process.exit(1) })

  return {
    /** Where this run writes. Nothing here is visible to anyone until finish(). */
    dir: staging,
    path: (name) => join(staging, name),

    /**
     * Move this run's pictures into place and mark the set complete.
     *
     * Only the files this run actually took are replaced, so a tool invoked
     * once per language and device shape does not erase its other invocations.
     */
    /**
     * `outcome` is a separate question from completeness and is recorded as
     * one. A manifest means the run reached its publishing point and the set is
     * whole; it says nothing about whether the assertions passed. A complete
     * set of pictures of a broken game is evidence worth keeping — it just must
     * not be mistaken for a green one.
     */
    finish({ outcome = null, exitCode = null, passed = null, failed = null, failures = [] } = {}) {
      const taken = readdirSync(staging)
      if (expect != null && taken.length !== expect) {
        throw new Error(`expected ${expect} screenshots and took ${taken.length}; not publishing a partial set`)
      }
      for (const name of taken) renameSync(join(staging, name), join(dir, `${prefix}${name}`))
      published = true
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* already gone */ }
      // Last, so its presence means everything above it happened.
      writeFileSync(marker, JSON.stringify({
        complete: true,
        outcome: outcome ?? (failed == null ? 'unknown' : failed === 0 ? 'pass' : 'fail'),
        exitCode,
        passed,
        failed,
        // Names only. A stack belongs in the run's own output, not in something
        // written to disk and read later by somebody looking at pictures.
        failures: failures.slice(0, 12),
        commit: commit(),
        dirty: dirty(),
        started,
        finished: new Date().toISOString(),
        count: taken.length,
        files: taken.map(n => `${prefix}${n}`),
        ...meta,
      }, null, 2) + '\n')
      return taken.length
    },
  }
}

/**
 * Read the manifest for a set, or null. A consumer that shows these to somebody
 * should refuse a set that has none: no manifest means no run ever said it
 * finished, and the pictures are whatever happened to survive.
 */
export function shotsComplete(dir, prefix = '') {
  const marker = join(dir, `${prefix}COMPLETE.json`)
  if (!existsSync(marker)) return null
  try { return JSON.parse(readFileSync(marker, 'utf8')) } catch { return null }
}
