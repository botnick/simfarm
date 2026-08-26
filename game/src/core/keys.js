// Keyboard support. A game that can only be played by clicking small targets
// with a mouse excludes anyone who does not use one, and shortcuts are simply
// faster for everyone else.
//
// Each scene declares what its keys mean; nothing here knows about farming.
export function bindKeys(scene, map) {
  const handler = (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
    // Never steal a keystroke that is going into a text field.
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    // A panel that is waiting to be answered owns the whole screen, not just
    // the part of it the mouse can reach. Without this, a dialog blocked every
    // click and none of the shortcuts: with the day report open, Enter still
    // ended a day, the number keys still walked into fields, and Escape still
    // left the screen with the panel on it.
    if (scene.__modal) return
    const action = map[event.key] ?? map[event.key.toLowerCase()]
    if (!action) return
    event.preventDefault()
    action()
  }
  window.addEventListener('keydown', handler)
  scene.events.once('shutdown', () => window.removeEventListener('keydown', handler))
  scene.events.once('destroy', () => window.removeEventListener('keydown', handler))
}
