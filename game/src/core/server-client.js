// Talks to the authoritative farm server.
//
// Deliberately thin: it adds a session header, a request id so a retry cannot
// be counted twice, and nothing else. Every decision belongs to the server.
const idFor = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

export function createServerClient(baseUrl) {
  let session = null
  // Whether this client is allowed to settle its own reward events. Wherever a
  // host actually pays them, it is not — and it is told so when it connects.
  let mayAck = true

  const send = async (path, body, method = 'POST') => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(session ? { 'x-session': session } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    const payload = await res.json().catch(() => ({}))
    if (res.status === 401) session = null
    return { status: res.status, ...payload }
  }

  return {
    get session() { return session },

    async start({ name, save, signature } = {}) {
      const res = await send('/session', { name, save, signature })
      if (res.session) {
        session = res.session
        mayAck = res.clientMayAck !== false
        // Exposed for tools/online.mjs, which compares what the browser shows
        // against what the server actually holds.
        if (typeof window !== 'undefined') window.__serverSession = session
      }
      return res
    },

    /** Whether this client should be acknowledging rewards at all. */
    get mayAck() { return mayAck },

    /** One action. The request id makes a retry idempotent. */
    intent(body) { return send('/intent', { requestId: idFor(), ...body }) },

    state() { return send('/state', null, 'GET') },
    save() { return send('/save') },
    ack(eventIds) { return send('/ack', { eventIds }) },
    end() { return send('/end') },
  }
}
