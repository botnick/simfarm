// The game's look. The scene plates are chunky, saturated, black-outlined
// cartoon art, so everything drawn on top of them is built to match: glossy
// panels with a heavy rim, pressed buttons, and the original's own display face.
import { RENDER_SCALE, WIDTH } from '../core/size.js'
import { sfx } from '../core/audio.js'
import { owned } from '../core/fatal.js'

export const C = {
  // Pulled off the original artwork so new chrome sits in the same palette.
  blue: 0x2f7fd4, blueDeep: 0x1b4f8f, blueLight: 0x63b0f0,
  cream: 0xfdf1d6, creamDeep: 0xe6cf9f,
  wood: 0x8b5a2b, woodDeep: 0x5a3618,
  green: 0x4faa2a, greenDeep: 0x2f6b16,
  gold: 0xf5b301, goldDeep: 0xa8730a,
  red: 0xd6462f, redDeep: 0x8f2618,
  grey: 0x9aa0a6, greyDeep: 0x6b7075,
  rim: 0x1a1208,                      // the near-black outline the art uses everywhere
  ink: '#3b2a12', inkSoft: '#7a6647',
  // legacy aliases still referenced by a few scenes
  sky: 0x7ec0ee, grass: 0x6ab04c, soil: 0x8b5a2b, soilDark: 0x6b4423,
  panel: 0xfdf1d6, panelEdge: 0x8b5a2b, night: 0x1d2b1a,
}

export const money = (n) => n.toLocaleString('en-US')

// One family for both scripts: Latin, digits and Thai are drawn to match, so
// switching language does not change the game's voice. Noto Sans Thai backs it
// up, and the generic sans is the last resort.
const DISPLAY = "'Mitr', 'Noto Sans Thai', system-ui, sans-serif"
const BODY = "'Mitr', 'Noto Sans Thai', system-ui, sans-serif"

/**
 * A panel in the artwork's own idiom: heavy dark rim, a lit top edge, and a
 * shadow underneath so it sits on the scene rather than floating over it.
 */
export function panel(scene, x, y, w, h, { tone = 'cream', radius = 12, alpha = 1 } = {}) {
  const [fill, deep] = tone === 'blue' ? [C.blue, C.blueDeep]
    : tone === 'wood' ? [C.wood, C.woodDeep]
    : [C.cream, C.creamDeep]
  const g = scene.add.graphics()
  g.fillStyle(0x000000, 0.3).fillRoundedRect(x + 3, y + 5, w, h, radius)          // shadow
  g.fillStyle(C.rim, alpha).fillRoundedRect(x - 3, y - 3, w + 6, h + 6, radius + 3) // rim
  g.fillStyle(deep, alpha).fillRoundedRect(x, y, w, h, radius)
  g.fillStyle(fill, alpha).fillRoundedRect(x, y, w, h - 4, radius)
  const gh = Math.max(6, h * 0.3)
  g.fillStyle(0xffffff, alpha * 0.2).fillRoundedRect(x + 8, y + 5, w - 16, gh, Math.min(gh / 2, radius)) // gloss
  return g
}

export function label(scene, x, y, text, { size = 18, color = C.ink, bold = false, align = 'left', origin = [0, 0.5], display = false } = {}) {
  const t = scene.add.text(x, y, text, {
    fontFamily: display ? DISPLAY : BODY,
    fontWeight: display ? 600 : 400,
    // Rendered at double size and scaled back down, so the camera zoom does not
    // soften the glyphs.
    fontSize: `${size * RENDER_SCALE}px`, color, align,

  })
  t.setOrigin(...origin)
  t.setScale(1 / RENDER_SCALE)
  const setStroke = t.setStroke.bind(t)
  t.setStroke = (col, width) => setStroke(col, width * RENDER_SCALE)
  const setWrap = t.setWordWrapWidth.bind(t)
  t.setWordWrapWidth = (w) => setWrap(w * RENDER_SCALE)
  return t
}

/** A heading in the game's own face, outlined the way the artwork outlines things. */
export function title(scene, x, y, text, { size = 20, color = '#ffffff', origin = [0.5, 0.5] } = {}) {
  return label(scene, x, y, text, { size, color, origin, display: true })
    .setStroke('#1a1208', 5).setShadow(0, 3, '#00000066', 4)
}

/** An image whose texture was rasterised at RENDER_SCALE; `s` is the scale you want on stage. */
export function art(scene, x, y, key, s = 1) {
  return scene.add.image(x, y, key).setScale(s / RENDER_SCALE)
}

/** Point a scene's camera at the stage rectangle, whatever the canvas size is. */
export function fitCamera(scene) {
  scene.cameras.main.setZoom(RENDER_SCALE)
  scene.cameras.main.centerOn(300, 210)
}

const TONES = {
  green: [C.green, C.greenDeep], gold: [C.gold, C.goldDeep], blue: [C.blue, C.blueDeep],
  red: [C.red, C.redDeep], wood: [C.wood, C.woodDeep], grey: [C.grey, C.greyDeep],
}

/**
 * A button in the artwork's idiom: dark rim, lit face, gloss across the top,
 * and a real press. Everything lives at scene level — Phaser does not apply
 * container transforms to child hit areas, so a button inside a container
 * would look right and never respond.
 */
export function button(scene, x, y, w, h, text, onClick, { tone = 'green', size = 14, fill } = {}) {
  const key = typeof fill === 'string' ? fill : tone
  const [face, deep] = TONES[key] || TONES.green
  const r = Math.min(h / 2, 14)
  const g = scene.add.graphics()
  const t = label(scene, x, y - 1, text, { size, color: '#ffffff', origin: [0.5, 0.5], display: true })
  t.setStroke('#1a1208', 3.5)
  // Thai and English disagree about how long a word is, prices grow a digit as
  // the farm does, and Thai stacks marks above and below the letters so the same
  // caption is taller in one language than the other. Fit both ways, or the
  // marks end up crowding the rim.
  const fit = () => {
    const roomW = w - 18, roomH = h - 9
    const naturalW = t.displayWidth / (t.scaleX || 1)
    const naturalH = t.displayHeight / (t.scaleY || 1)
    t.setScale(Math.min(1 / RENDER_SCALE, roomW / naturalW, roomH / naturalH))
  }
  fit()
  const setLabel = t.setText.bind(t)
  t.setText = (v) => { setLabel(v); fit(); return t }

  const draw = (lit, press) => {
    const [f, d] = lit ? [tint(face, 22), deep] : [face, deep]
    g.clear()
    g.fillStyle(0x000000, 0.3).fillRoundedRect(x - w / 2 + 1, y - h / 2 + 4, w, h, r)
    g.fillStyle(C.rim, 1).fillRoundedRect(x - w / 2 - 2.5, y - h / 2 - 2.5 + press, w + 5, h + 5, r + 2.5)
    g.fillStyle(d, 1).fillRoundedRect(x - w / 2, y - h / 2 + press, w, h, r)
    g.fillStyle(f, 1).fillRoundedRect(x - w / 2, y - h / 2 + press, w, h - 3, r)
    // A highlight inset from the ends, with a radius no bigger than its own
    // height. Given the pill's radius it wrapped around the caps instead and
    // read as a white ring drawn round the whole button.
    const gh = Math.max(4, h * 0.28)
    g.fillStyle(0xffffff, 0.22).fillRoundedRect(x - w / 2 + 9, y - h / 2 + 4 + press, w - 18, gh, gh / 2)
    t.setY(y - 1 + press)
  }
  draw(false, 0)

  const hit = scene.add.rectangle(x, y, w, h, 0x000000, 0).setInteractive({ useHandCursor: true })
  const api = { enabled: true, objects: [g, t, hit], x, y, w, h }
  hit.on('pointerover', () => api.enabled && draw(true, 0))
  hit.on('pointerout', () => api.enabled ? draw(false, 0) : drawOff())
  hit.on('pointerdown', () => api.enabled && draw(true, 2))
  // Every button in the game clicks, and a button that refuses says so, so no
  // scene has to remember to make its own noise.
  hit.on('pointerup', () => {
    if (!api.enabled) { sfx(scene, 'refused', { volume: 0.5 }); return }
    draw(true, 0)
    sfx(scene, 'button-press')
    // Owned, because a handler that throws used to leave the player with a
    // button that simply did nothing and no way to know why.
    owned(onClick, `button "${typeof text === 'string' ? text : '?'}"`)()
  })

  const drawOff = () => {
    const [f, d] = TONES.grey
    g.clear()
    g.fillStyle(C.rim, 0.7).fillRoundedRect(x - w / 2 - 2.5, y - h / 2 - 2.5, w + 5, h + 5, r + 2.5)
    g.fillStyle(d, 1).fillRoundedRect(x - w / 2, y - h / 2, w, h, r)
    g.fillStyle(f, 1).fillRoundedRect(x - w / 2, y - h / 2, w, h - 3, r)
    t.setY(y - 1)
  }

  api.setEnabled = (on) => {
    api.enabled = on
    on ? draw(false, 0) : drawOff()
    t.setAlpha(on ? 1 : 0.7)
    on ? hit.setInteractive({ useHandCursor: true }) : hit.disableInteractive()
    return api
  }
  api.setDepth = (d) => { api.objects.forEach(o => o.setDepth(d)); return api }
  api.destroy = () => api.objects.forEach(o => o.destroy())
  return api
}

const tint = (hex, amt) => Phaser.Display.Color.IntegerToColor(hex).brighten(amt).color

/**
 * A glossy readout that sizes itself to its text. Thai runs longer than English
 * for the same string, so a fixed-width pill would overflow in one language and
 * look empty in the other; this measures and redraws instead.
 */
export function chip(scene, anchorX, y, { tone = 'blue', size = 11, align = 'left', minWidth = 0 } = {}) {
  let x = anchorX
  const [face, deep] = TONES[tone] || TONES.blue
  const g = scene.add.graphics().setDepth(398)
  const t = label(scene, x, y, '', { size, display: true, color: '#ffffff', origin: [0, 0.5] }).setDepth(400)
  t.setStroke('#00000055', 3)

  const api = { graphics: g, text: t, right: x, value: '' }
  api.setText = (value) => {
    api.value = value
    t.setText(value)
    const w = Math.max(minWidth, t.displayWidth + 18)
    const h = t.displayHeight + 9
    // `align: 'right'` pins the pill's right edge to x, for corner readouts.
    const left = align === 'right' ? x - w : x
    t.setX(left + 9)
    t.setY(y)
    g.clear()
    g.fillStyle(C.rim, 0.85).fillRoundedRect(left - 2, y - h / 2 - 2, w + 4, h + 4, h / 2 + 2)
    g.fillStyle(deep, 1).fillRoundedRect(left, y - h / 2, w, h, h / 2)
    g.fillStyle(face, 1).fillRoundedRect(left, y - h / 2, w, h - 2, h / 2)
    const gh = Math.max(3, h * 0.36)
    g.fillStyle(0xffffff, 0.22).fillRoundedRect(left + 6, y - h / 2 + 2, w - 12, gh, gh / 2)
    api.left = left; api.right = left + w; api.width = w
    return api
  }
  // Chips that share a line have to be able to move after they know how wide
  // their own caption made them.
  api.setRight = (value) => { x = value; return api.setText(api.value) }
  return api
}

/** A short-lived message that floats up and fades — used for money and refusals. */
export function toast(scene, x, y, text, color = '#ffffff') {
  const t = label(scene, x, y, text, { size: 15, color, origin: [0.5, 0.5], display: true })
  t.setStroke('#1a1208', 5).setDepth(9000)
  // Toasts are placed against the thing they are about — the row that was sold,
  // the button that was pressed — which is fine for "+$40" and wrong the moment
  // the message is a sentence. "the loan took $104" hung off the right edge of
  // the screen with the amount cut off, and Thai says most things longer still.
  // So the message stays where it was asked for when it fits, and moves only as
  // far as it must to be readable.
  const MARGIN = 6
  const half = t.displayWidth / 2
  if (half * 2 + MARGIN * 2 >= WIDTH) t.setX(WIDTH / 2)
  else t.setX(Math.min(Math.max(x, half + MARGIN), WIDTH - half - MARGIN))
  // It floats up as it fades, so it also needs room above it to do that in.
  const top = Math.max(y, 40)
  t.setY(top)
  scene.tweens.add({ targets: t, y: top - 34, alpha: 0, duration: 1000, ease: 'Cubic.easeOut', onComplete: () => t.destroy() })
  return t
}
