// What to do when the game breaks.
//
// A scene whose create() throws is left half-built: Phaser has made some of it
// and none of the rest, and the game carries on drawing whatever did get made.
// What the player sees is a screen that looks entirely normal except that
// nothing on it works, with nothing to say anything is wrong. A game that is
// broken should look broken.
//
// Two things this deliberately does NOT do, because this is meant to be embedded
// in somebody else's page:
//
//   it does not listen on window. A host's own error, from code that has nothing
//   to do with farming, would otherwise put a notice on screen blaming this;
//   it does not show what went wrong. Raw messages carry internal paths and
//   request URLs, and the player can do nothing with them anyway.
//
// Instead the boundary is put around the parts that are actually ours — the
// bootstrap, and every scene's own lifecycle — so anything it catches really did
// come from here.
import { t } from './i18n.js'

/** The sentence shown when nothing has loaded yet and there is no language. */
const PLAIN = 'Something went wrong. Reloading usually fixes it.'
const PLAIN_RELOAD = 'Reload'

/**
 * The boundary this build is using, for game code that is not a scene.
 *
 * Lifecycle methods are wrapped by name, but a button's handler is an anonymous
 * function handed to a widget, and a throw inside an async one becomes an
 * unhandled rejection: the browser logs it and the player sees a button that
 * did nothing at all. Silence is the worst answer a game can give, and it is
 * the exact fault this whole boundary was built after.
 *
 * A module-level hook rather than a global listener, deliberately. Only code
 * that reaches for it is covered, so the game never ends up apologising for a
 * fault in the page that embedded it.
 */
let active = null
export const useBoundary = (boundary) => { active = boundary }

/** Run one of our handlers and own what it throws, sync or not. */
export function owned(fn, phase) {
  if (typeof fn !== 'function') return fn
  return function handled(...args) {
    try {
      const out = fn.apply(this, args)
      if (out && typeof out.then === 'function') {
        return out.then(undefined, (err) => { active?.report(err, phase); throw err })
      }
      return out
    } catch (err) {
      active?.report(err, phase)
      throw err
    }
  }
}

export function createBoundary({ onFatal = null, fatalUI = true, document: doc = globalThis.document } = {}) {
  let done = false
  let notice = null

  const build = () => {
    if (!doc?.body) return
    notice = doc.createElement('div')
    notice.setAttribute('role', 'alert')
    notice.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'padding:14px 18px', 'background:#8f2618', 'color:#fff6d8',
      'font:14px/1.5 system-ui,sans-serif', 'text-align:center',
      'box-shadow:0 -4px 16px rgba(0,0,0,.4)',
    ].join(';')

    // Generic and localised. Never the error's own text.
    let said = PLAIN, again = PLAIN_RELOAD
    try {
      const localised = t('fatal.notice')
      if (localised && localised !== 'fatal.notice') said = localised
      const button = t('fatal.reload')
      if (button && button !== 'fatal.reload') again = button
    } catch { /* strings are not loaded yet; the plain sentence will do */ }

    notice.textContent = said
    const reload = doc.createElement('button')
    reload.textContent = again
    reload.style.cssText = 'margin-left:12px;padding:4px 14px;border:0;border-radius:6px;cursor:pointer;font:inherit'
    reload.onclick = () => globalThis.location?.reload()
    notice.appendChild(reload)
    doc.body.appendChild(notice)
  }

  const boundary = {
    /**
     * Something we own has failed.
     *
     * The host is told once and may say it has dealt with it, in which case the
     * built-in notice stays out of the way. Anything the host's own handler
     * throws is ignored: a broken error handler must not become the error.
     */
    report(error, phase) {
      if (done) return true
      done = true
      let handled = false
      if (onFatal) {
        try {
          const said = onFatal({ error, phase, reload: () => globalThis.location?.reload() })
          handled = said === true || said === 'handled'
        } catch { /* the host's handler is not our problem to fix */ }
      }
      if (!handled && fatalUI) build()
      return handled
    },

    /** Run something of ours, and own what it throws. */
    guard(fn, phase) {
      return function guarded(...args) {
        try {
          const out = fn.apply(this, args)
          // An async lifecycle method is still ours until it settles.
          if (out && typeof out.then === 'function') {
            return out.then(undefined, (err) => { boundary.report(err, phase); throw err })
          }
          return out
        } catch (err) {
          boundary.report(err, phase)
          throw err
        }
      }
    },

    /** Wrap every lifecycle method a scene class defines. */
    guardScene(SceneClass) {
      for (const name of ['init', 'preload', 'create', 'update']) {
        const fn = SceneClass.prototype?.[name]
        if (typeof fn === 'function') SceneClass.prototype[name] = boundary.guard(fn, `${SceneClass.name}.${name}`)
      }
      return SceneClass
    },

    /** Whether a notice is on screen, for a test to ask. */
    get showing() { return !!notice },

    dispose() {
      notice?.remove()
      notice = null
      done = false
    },
  }

  return boundary
}
