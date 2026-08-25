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
  // The token names this showing of the screen, not this request. Bumping it per
  // call meant two refreshes in flight would cancel the first — and the first is
  // the one that might carry the newer farm, since answers do not come back in
  // the order they were asked for. Dropping it left the screen drawn at an older
  // revision than the farm it was drawing. Both callbacks are welcome: each one
  // renders the farm as it stands by the time it runs, and the facade already
  // refuses to adopt an older one.
  const token = (scene.__showing ??= 1)
  const gone = () => scene.__showing !== token || !scene.scene?.isActive?.()
  return Promise.resolve(farm?.sync?.())
    .then(owned(() => { if (!gone()) after() }, `${scene.scene?.key ?? 'a screen'} refreshing`))
    // Both things that can fail here have already been reported by the time they
    // get this far: a refusal from the network is the farm's to announce, and a
    // fault in the render was handed to the boundary by `owned` just above. This
    // stops the same failure arriving a second time as an unhandled rejection.
    .catch(() => {})
}

/**
 * Called when a screen opens. Anything still waiting from the last time this
 * screen was shown belongs to that showing, and is dropped when it lands.
 */
export function nowShowing(scene) {
  scene.__showing = (scene.__showing ?? 0) + 1
  scene.events.once('shutdown', () => { scene.__showing = (scene.__showing ?? 0) + 1 })
}
