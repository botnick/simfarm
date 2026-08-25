import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const DIST = join(ROOT, 'dist')

// What the bundle is built from. Anything newer than the bundle means the
// bundle is not what this checkout would ship.
const SOURCES = ['src', 'public', 'index.html', 'package.json', 'vite.config.js', 'vite.config.mjs']

const newestUnder = (path) => {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let newest = st.mtimeMs
  for (const name of readdirSync(path)) newest = Math.max(newest, newestUnder(join(path, name)))
  return newest
}

/**
 * Build the bundle if it is missing or older than what it is built from.
 *
 * The suites that test the production build served `dist` and never built it,
 * so they tested whatever happened to be lying there. That is not a slow test
 * — it is a test of a different program. It showed up as art added to `public`
 * 404ing under `faithful` while sitting on disk, and as `production` throwing
 * on a farm that never opened, both against a bundle from the day before.
 */
export function ensureDist({ quiet = false } = {}) {
  const built = newestUnder(DIST)
  const source = Math.max(...SOURCES.map(s => newestUnder(join(ROOT, s))))
  if (built && built >= source) return false
  if (!quiet) console.log(built ? '  (bundle is behind the source — rebuilding)' : '  (no bundle yet — building)')
  const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stdout ?? '', r.stderr ?? '')
    throw new Error('the bundle would not build, so there is nothing to test')
  }
  return true
}
