// What the player is holding. Touch screens have no hover, so anything the game
// only reveals on pointer-over has to be shown outright instead.
//
// The check needs both halves: a headless or remote-desktop browser reports
// `(hover: none)` while having no touch digitiser at all, and would otherwise be
// mistaken for a phone.
export const isTouch = () =>
  (navigator.maxTouchPoints ?? 0) > 0 &&
  (window.matchMedia?.('(pointer: coarse)').matches ?? true)

/** Tap targets need more room than mouse targets; this is the padding to add. */
export const touchPad = () => (isTouch() ? 8 : 0)
