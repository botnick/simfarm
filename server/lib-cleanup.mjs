/**
 * Kill what a suite spawned, whatever ends the suite.
 *
 * Every suite that starts a server kills it on the last line, which covers the
 * run finishing — and nothing else. An assertion helper that throws, a hung
 * request, or the run being killed from outside all skip that line and leave a
 * server behind. They accumulate: sixteen of them were found running on this
 * machine, several orphaned to init, the oldest sixteen hours old.
 *
 * SIGKILL still cannot be caught, so this is not a guarantee — but it turns the
 * common cases, an exception and an ordinary interrupt, into a clean shutdown.
 */
const spawned = new Set()

export function killWith(child) {
  if (!child) return child
  spawned.add(child)
  child.on?.('exit', () => spawned.delete(child))
  return child
}

const reap = () => {
  for (const child of spawned) {
    try { child.kill() } catch { /* already gone */ }
  }
  spawned.clear()
}

process.on('exit', reap)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { reap(); process.exit(signal === 'SIGINT' ? 130 : 143) })
}
process.on('uncaughtException', (err) => {
  reap()
  console.error(err)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  reap()
  console.error(err)
  process.exit(1)
})
