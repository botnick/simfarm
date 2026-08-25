// Work that belongs to a screen only while that screen is still on it.
//
// Every scene refreshed itself the same way: `farm.sync().then(() => render())`.
// The answer can take as long as the network takes, and the player can leave in
// that time — so the callback ran against a scene that had been shut down, with
// its panels destroyed and its HUD gone. Nothing returned the promise either, so
// a rejection landed outside the fatal boundary and outside the guarded create
// that started it: a screen that failed to refresh simply did not, silently.
//
// A shutdown invalidates the token, so a late answer is dropped rather than
// drawn, and the whole thing is owned so a fault in it is the game's fault and
// says so.
import { owned } from '../core/fatal.js'

/**
 * Run `after` with the farm freshly synced, unless this screen has moved on.
 *
 * Returns the promise so a caller inside a guarded lifecycle method can hand it
 * back and let the boundary see it.
 */
export function whileHere(scene, farm, after) {
  const token = (scene.__syncToken = (scene.__syncToken ?? 0) + 1)
  const gone = () => scene.__syncToken !== token || !scene.scene?.isActive?.()
  scene.events.once('shutdown', () => { scene.__syncToken = (scene.__syncToken ?? 0) + 1 })
  return Promise.resolve(farm?.sync?.())
    .then(owned(() => { if (!gone()) after() }, `${scene.scene?.key ?? 'a screen'} refreshing`))
    .catch(() => { /* the refusal is already the farm's to report */ })
}
