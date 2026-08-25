// The random source the server owns.
//
// A stored seed is a liability: anyone who gets hold of a save can work out
// where every bug will land and which day it will rain. Instead each draw is a
// keyed hash of things the client cannot choose — a server secret, the farm's
// identity, and a counter that only ever goes up. Only the counter is saved, so
// a session can be replayed exactly for crash recovery or investigation, while
// remaining unpredictable to whoever is playing.
import { createHmac } from 'node:crypto'

export function makeRng(secret, farmId, counter = 0) {
  let n = counter >>> 0
  const draw = () => {
    const digest = createHmac('sha256', secret).update(`${farmId}|${n++}`).digest()
    // 48 bits is ample and avoids the sign and precision traps of 64.
    const value = digest.readUIntBE(0, 6) / 2 ** 48
    // Never exactly 1: callers index arrays with this.
    return value >= 1 ? 0.9999999999 : value
  }
  draw.counter = () => n
  draw.restore = (v) => { n = Number.isSafeInteger(v) && v >= 0 ? v : 0 }
  return draw
}
