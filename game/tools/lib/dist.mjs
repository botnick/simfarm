import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const LOCK = join(ROOT, 'node_modules/.simfarm-build.lock')

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Build the bundle the artifact suites serve.
 *
 * `faithful` and `production` serve `dist` and used to serve whatever was in
 * it, so they tested code and art from an arbitrary earlier point — or, in a
 * fresh clone, nothing at all.
 *
 * The first attempt at this compared modification times, which does not hold
 * up: one new file under `dist` makes the whole bundle look current even when
 * it is half-written, a checkout can leave changed sources older than the
 * bundle built before them, and mtimes say nothing at all about `VITE_BASE` or
 * `VITE_SERVER_URL`, so a bundle built for a subpath deploy would be served to
 * a suite expecting a root one. The build takes well under a second, so there
 * is nothing to gain by guessing: build it.
 *
 * The lock is for concurrency, not speed. Vite empties the output directory as
 * it starts, so two suites building at once can leave one of them serving a
 * directory the other is midway through deleting.
 */
export function ensureDist({ quiet = false } = {}) {
  mkdirSync(dirname(LOCK), { recursive: true })
  let held = null
  for (let tries = 0; tries < 600; tries++) {
    try { held = openSync(LOCK, 'wx'); break } catch { wait(100) }
  }
  if (held == null) {
    // Someone died holding it. Better to take it than to refuse to run.
    try { rmSync(LOCK) } catch { /* raced */ }
    held = openSync(LOCK, 'w')
  }
  try {
    if (!quiet) console.log('  (building the bundle these checks are about to serve)')
    const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) {
      console.error(r.stdout ?? '', r.stderr ?? '')
      throw new Error('the bundle would not build, so there is nothing to test')
    }
    if (!existsSync(join(ROOT, 'dist/index.html'))) {
      throw new Error('the build reported success and produced no index.html')
    }
  } finally {
    closeSync(held)
    try { rmSync(LOCK) } catch { /* already gone */ }
  }
  return true
}
