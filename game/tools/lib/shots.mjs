import { mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Start a screenshot directory empty, so a failed run leaves no pictures.
 *
 * A tool that dies partway leaves whatever it wrote last time exactly where it
 * was, with nothing anywhere to say the pictures are old. That is worse than no
 * pictures: the screenshot tool crashed for six hours and its output kept being
 * picked up and shown as the current game.
 *
 * `prefix` is for a tool that is run more than once to fill one directory — the
 * gallery takes a language and a device shape as arguments and is invoked for
 * each pair. Clearing everything there would mean each run threw away the last
 * one's work, so it clears only what this run is about to write.
 */
export function freshShots(dir, prefix = null) {
  if (prefix == null) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* never existed */ }
    mkdirSync(dir, { recursive: true })
    return dir
  }
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) {
      try { rmSync(join(dir, name), { force: true }) } catch { /* raced */ }
    }
  }
  return dir
}
