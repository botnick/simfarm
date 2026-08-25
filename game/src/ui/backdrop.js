// Paints the area around the board with the current scene, blown up and
// blurred, so a screen that is not the board's shape still looks like the game
// rather than a letterbox. Lives in the DOM: it must sit behind the canvas and
// cover the whole window, which nothing inside the canvas can do.
let current = null

export function setBackdrop(sceneKey) {
  if (current === sceneKey) return
  current = sceneKey
  const el = document.getElementById('backdrop')
  if (el) el.style.backgroundImage = `url('assets/scenes/${sceneKey}.svg')`
}
