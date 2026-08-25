// Fills the screen in either orientation.
//
// The board is a fixed landscape scene, so on an upright phone it can either sit
// in two fat letterbox bars or be turned a quarter turn and given the whole
// display. This does the latter. Phaser cannot help with that by itself: it
// measures the parent element (which a CSS rotation reports back swapped) and it
// maps pointers assuming the canvas is square to the page. So the canvas is
// sized here rather than by the scale manager, and the pointer transform is
// replaced with one that knows about the turn.
import { WIDTH, HEIGHT, RENDER_SCALE } from './size.js'

const STAGE_W = WIDTH * RENDER_SCALE
const STAGE_H = HEIGHT * RENDER_SCALE

const UPRIGHT_KEY = 'simfarm.upright'
const prefersUpright = () => localStorage.getItem(UPRIGHT_KEY) === '1'

export function installViewport(game) {
  const canvas = game.canvas
  let rotated = false

  const layout = () => {
    const vw = window.innerWidth, vh = window.innerHeight
    // Turning the board fills the screen, but some people would rather hold the
    // phone as it is and read the game the right way up, even if it is smaller.
    // That is their call, so it is a setting rather than a rule.
    rotated = vh > vw && !prefersUpright()
    // When turned, the screen's height is the board's width and vice versa.
    const availW = rotated ? vh : vw
    const availH = rotated ? vw : vh
    const scale = Math.min(availW / WIDTH, availH / HEIGHT)
    const cssW = Math.round(WIDTH * scale)
    const cssH = Math.round(HEIGHT * scale)

    Object.assign(canvas.style, {
      position: 'absolute',
      width: `${cssW}px`,
      height: `${cssH}px`,
      // Rotation happens about the centre, so centring the unrotated box also
      // centres the turned one.
      left: `${Math.round((vw - cssW) / 2)}px`,
      top: `${Math.round((vh - cssH) / 2)}px`,
      transformOrigin: 'center center',
      transform: rotated ? 'rotate(90deg)' : 'none',
    })
    document.body.classList.toggle('portrait', rotated)
  }

  // Same shape as Phaser's own transformPointer, including the smoothing, but
  // the page-to-stage mapping accounts for the quarter turn.
  game.input.transformPointer = function (pointer, pageX, pageY, wasMove) {
    const p0 = pointer.position
    const p1 = pointer.prevPosition
    p1.x = p0.x
    p1.y = p0.y

    const r = canvas.getBoundingClientRect()
    let x, y
    if (rotated) {
      // Turned clockwise: the page's vertical axis runs along the stage's x,
      // and its horizontal axis runs backwards along the stage's y.
      x = ((pageY - r.top) / r.height) * STAGE_W
      y = (1 - (pageX - r.left) / r.width) * STAGE_H
    } else {
      x = ((pageX - r.left) / r.width) * STAGE_W
      y = ((pageY - r.top) / r.height) * STAGE_H
    }

    const a = pointer.smoothFactor
    if (!wasMove || a === 0) { p0.x = x; p0.y = y }
    else { p0.x = x * a + p1.x * (1 - a); p0.y = y * a + p1.y * (1 - a) }
  }

  addEventListener('resize', layout)
  addEventListener('orientationchange', () => setTimeout(layout, 120))
  layout()

  const api = {
    layout,
    isRotated: () => rotated,
    isUpright: prefersUpright,
    toggleUpright() {
      localStorage.setItem(UPRIGHT_KEY, prefersUpright() ? '0' : '1')
      layout()
      return prefersUpright()
    },
  }
  window.__viewport = api
  return api
}
