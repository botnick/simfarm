// Reading the configuration, and refusing to start on a bad one.
//
// Every setting here has a default that is right for a laptop and wrong for
// anything a player can reach. Warnings do not fix that: a warning printed at
// three in the morning during a deploy is a warning nobody reads.
//
// So there are two modes. Left alone the server starts with whatever is
// convenient and says what it is doing. With SIMFARM_STRICT=1 it refuses to
// start at all unless every one of those choices has actually been made.
const MIN_SECRET_BYTES = 32

/**
 * A number from the environment, or nothing.
 *
 * `Number(env)` gives NaN for a typo and NaN loses every comparison it is in,
 * so a mistyped ceiling silently becomes no ceiling. Anything that is not a
 * finite positive number is a mistake, and is reported as one.
 */
export function positive(name, fallback, { max = Number.MAX_SAFE_INTEGER, min = null } = {}) {
  const raw = process.env[name]
  if (raw == null || raw === '') return { value: fallback, problem: null }
  const n = Number(raw)
  // `min: 0` for the settings where nothing is a real answer — a cooldown of
  // zero means no cooldown, which is exactly what a test wants and a perfectly
  // sensible thing to ask for.
  const floor = min == null ? Number.MIN_VALUE : min
  if (!Number.isFinite(n) || n < floor || n > max) {
    const range = min === 0 ? `between 0 and ${max}` : `a positive number under ${max}`
    return { value: fallback, problem: `${name} must be ${range}; got ${JSON.stringify(raw)}` }
  }
  return { value: n, problem: null }
}

/**
 * What is wrong with this configuration.
 *
 * `blocking` is what a strict server refuses to start on; `notes` is what a
 * relaxed one says out loud. Nothing here reads a secret's value into a message.
 */
export function review(env = process.env) {
  const strict = env.SIMFARM_STRICT === '1'
  const blocking = []
  const notes = []

  const secret = env.SIMFARM_SECRET
  if (!secret) {
    (strict ? blocking : notes).push(
      'SIMFARM_SECRET is unset, so saves are signed with a key generated at boot.',
      '  Every save this process issues stops verifying when it restarts.')
  } else if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    // A short secret is worse than none: it looks deliberate, and every save the
    // server hands out is an offline guess at it.
    blocking.push(`SIMFARM_SECRET is ${Buffer.byteLength(secret)} bytes; at least ${MIN_SECRET_BYTES} are needed.`)
  }

  if (env.SIMFARM_TEST_HOOKS === '1') {
    (strict ? blocking : notes).push(
      'SIMFARM_TEST_HOOKS=1 — /test/grant will put crops and debt into any farm on request.',
      '  It exists for the end-to-end suite. Never set it anywhere else.')
  }

  if (!env.SIMFARM_LEDGER_FILE) {
    (strict ? blocking : notes).push(
      'No SIMFARM_LEDGER_FILE, so replay protection lives only in this process.',
      '  After a restart every save it ever issued can be replayed.')
  }

  if (!env.SIMFARM_ORIGIN) {
    (strict ? blocking : notes).push(
      'SIMFARM_ORIGIN is unset, so the API answers any origin.')
  } else if (env.SIMFARM_ORIGIN === '*') {
    blocking.push('SIMFARM_ORIGIN is "*", which is the same as not setting it. Name the game\'s origin.')
  }

  // Two settings decide how long a bearer credential is good for and how often
  // a day may be ended. Both were read straight off the environment, where a
  // typo becomes NaN and NaN loses every comparison it is in — so a mistyped
  // save lifetime meant saves that never expired at all.
  if (!env.SIMFARM_HOST_KEY) {
    (strict ? blocking : notes).push(
      'SIMFARM_HOST_KEY is unset, so a browser may settle its own reward events.',
      '  Set it wherever a host actually pays those rewards.')
  } else if (Buffer.byteLength(env.SIMFARM_HOST_KEY) < MIN_SECRET_BYTES) {
    blocking.push(`SIMFARM_HOST_KEY is ${Buffer.byteLength(env.SIMFARM_HOST_KEY)} bytes; at least ${MIN_SECRET_BYTES} are needed.`)
  }

  return { strict, blocking, notes }
}

/**
 * Print what is wrong, and stop if a strict server cannot honestly start.
 *
 * A relaxed server says WARNING for the things a strict one would refuse,
 * because printing REFUSED and then starting anyway is a worse habit to teach
 * than any of the settings it is complaining about.
 */
export function enforce(review_, log = console) {
  for (const line of review_.notes) log.warn(line.startsWith(' ') ? line : `NOTE:    ${line}`)
  if (!review_.blocking.length) return true

  const label = review_.strict ? 'REFUSED:' : 'WARNING:'
  const say = review_.strict ? log.error.bind(log) : log.warn.bind(log)
  for (const line of review_.blocking) say(line.startsWith(' ') ? line : `${label} ${line}`)
  if (review_.strict) {
    log.error('The server will not start with this configuration. Fix the above, or unset SIMFARM_STRICT to run anyway.')
    return false
  }
  return true
}
