// Motion.
//
// The artwork is flat, chunky cartoon, so everything here is short, snappy and
// eased out. Nothing floats, nothing lingers, and nothing waits on an animation
// to finish before the game will accept the next click — the feedback decorates
// the action, it never gates it.
import Phaser from 'phaser'
import { C, label, money } from './kit.js'
import { sfx } from '../core/audio.js'
import { RENDER_SCALE } from '../core/size.js'

/**
 * Fade a scene up as it opens, with the sound of arriving somewhere. Called
 * from create, and it costs nothing to input — the camera fades, the scene is
 * live throughout.
 */
export function enter(scene, ms = 160) {
  scene.cameras.main.fadeIn(ms, 0, 0, 0)
  sfx(scene, 'screen-change', { volume: 0.7 })
}

/**
 * A quick scale punch on something that just happened.
 *
 * The object's own scale is read at call time and restored, so this works on
 * sprites the scene has already sized and on text drawn at RENDER_SCALE alike.
 */
export function pop(scene, target, amount = 0.22, ms = 200) {
  if (!target || target.__popping) return
  const sx = target.scaleX, sy = target.scaleY
  target.__popping = true
  scene.tweens.add({
    targets: target, scaleX: sx * (1 + amount), scaleY: sy * (1 + amount),
    duration: ms * 0.35, ease: 'Quad.easeOut', yoyo: true,
    onComplete: () => { target.setScale(sx, sy); target.__popping = false },
  })
}

/** A slow breath, for something waiting to be collected. */
export function pulse(scene, target, amount = 0.06, ms = 900) {
  const sx = target.scaleX, sy = target.scaleY
  return scene.tweens.add({
    targets: target, scaleX: sx * (1 + amount), scaleY: sy * (1 + amount),
    duration: ms, ease: 'Sine.easeInOut', yoyo: true, repeat: -1,
  })
}

/**
 * Rows arriving.
 *
 * Each row fades up a beat after the one before it, which reads as the list
 * settling rather than snapping into place. Alpha only, deliberately: the rows
 * carry buttons, and moving a button's hit area while it animates is a way to
 * make a click land on nothing.
 *
 * A row is a list of anything drawable; a button handle is unwrapped to the
 * objects it owns.
 */
export function stagger(scene, rows, { ms = 200, step = 34 } = {}) {
  rows.forEach((row, i) => {
    const parts = [].concat(row).flatMap(o => (o?.objects ? o.objects : [o])).filter(o => o?.setAlpha)
    parts.forEach(o => o.setAlpha(0))
    scene.tweens.add({ targets: parts, alpha: 1, duration: ms, delay: i * step, ease: 'Cubic.easeOut' })
  })
}

/**
 * A number that rolls to its new value instead of jumping.
 *
 * Money is the one figure a player watches, and a total that simply changes
 * gives no sense of having earned anything. The tween is cancelled if the value
 * changes again mid-roll, so a fast seller never sees two counters fighting.
 */
export function countTo(scene, text, to, { ms = 420, format = money } = {}) {
  if (!text) return
  const from = text.__countValue ?? to
  text.__countValue = to
  if (from === to || !Number.isFinite(from)) { text.setText(format(to)); return }
  text.__countTween?.remove()
  const holder = { v: from }
  text.__countTween = scene.tweens.add({
    targets: holder, v: to, duration: ms, ease: 'Cubic.easeOut',
    onUpdate: () => text.setText(format(Math.round(holder.v))),
    onComplete: () => { text.setText(format(to)); text.__countTween = null },
  })
}

/**
 * Coins going into the wallet.
 *
 * They used to be thrown up and dropped back where they started, which read as
 * nothing at all once the row that paid them had been redrawn away — coins left
 * hanging in empty space. Flying them to the money panel says where the money
 * went, and they land while the counter there is still rolling.
 */
export function coins(scene, x, y, n = 7, { to, depth = 9000 } = {}) {
  const target = to ?? scene.hud?.walletAt ?? { x: 70, y: 26 }
  for (let i = 0; i < n; i++) {
    const c = scene.add.circle(x, y, 3.5, C.gold).setDepth(depth).setStrokeStyle(1.5, 0x8a5f06)
    // A scatter first, so seven coins do not travel as one dot.
    const hopX = x + Phaser.Math.Between(-26, 26)
    const hopY = y - Phaser.Math.Between(14, 34)
    scene.tweens.add({
      targets: c, x: hopX, y: hopY, duration: 180 + i * 12, ease: 'Quad.easeOut',
      onComplete: () => scene.tweens.add({
        targets: c, x: target.x, y: target.y, scale: 0.4, alpha: 0.2,
        duration: 340, delay: i * 26, ease: 'Cubic.easeIn',
        onComplete: () => c.destroy(),
      }),
    })
  }
}

/** A small ring that expands and fades, for a thing being consumed or applied. */
export function ripple(scene, x, y, colour = 0xffffff, r = 34, depth = 8000) {
  const g = scene.add.circle(x, y, 6).setStrokeStyle(3, colour, 0.9).setFillStyle().setDepth(depth)
  scene.tweens.add({
    targets: g, radius: r, alpha: 0, duration: 420, ease: 'Cubic.easeOut',
    onUpdate: () => g.setStrokeStyle(3, colour, g.alpha * 0.9),
    onComplete: () => g.destroy(),
  })
}

/**
 * A banner, for the moments the game has something to say to the player.
 *
 * Levelling, a milestone earned, a season ended: each is the game recognising
 * something, and each is allowed to take most of a second. They queue rather
 * than stack, because two congratulations printed on top of each other are one
 * illegible congratulation.
 */
/**
 * The queue lives on the game, not on the scene.
 *
 * A banner is drawn into whichever scene is open, but the fact that the game
 * owes the player one is not that scene's business. Held per-scene, walking to
 * the shop while a congratulation was waiting simply lost it — and the thing it
 * was congratulating had already been marked as told.
 */
const KEY = 'pendingBanners'

const queueOf = (scene) => {
  const q = scene.registry.get(KEY) ?? []
  scene.registry.set(KEY, q)
  return q
}

export function banner(scene, text, { tone = 'gold', sub = null, onShown = null } = {}) {
  const q = queueOf(scene)
  q.push({ text, tone, sub, onShown })
  // Only the first starts the chain; the rest are pulled through by the one in
  // front of them finishing. If the head is already on screen this does nothing,
  // which is the point of a queue.
  if (q.length === 1) drainBanners(scene)
}

/**
 * Draw whatever is owed, in this scene, until there is nothing left.
 *
 * Called from the HUD while the scene is still being built, when Phaser does not
 * yet consider it active — so the attempt is deferred to the scene's first
 * update. Without that, a banner whose scene closed mid-animation sat at the
 * head of the queue for ever and everything behind it was never seen again.
 */
export function drainBanners(scene) {
  if (!queueOf(scene).length) return
  if (scene.scene?.isActive?.()) { showNext(scene); return }
  scene.events.once('update', () => showNext(scene))
}

function showNext(scene) {
  const q = queueOf(scene)
  const next = q[0]
  if (!next) return
  // Nothing to draw into. It stays owed, and the next screen's HUD picks it up.
  if (!scene.scene?.isActive?.()) return
  // A banner already running in this scene pulls the rest through itself.
  if (next.showing) return
  next.showing = true

  // Marked as shown at the moment it is actually shown, not when it joined the
  // queue: anything else loses the item if the scene closes first.
  next.onShown?.()
  levelUp(scene, 300, next.sub ? 138 : 150, next.text, 9500, next.tone, next.sub, () => {
    q.shift()
    showNext(scene)
  })
  // If this scene closes before the banner finishes, the item is put back at the
  // head unshown so the next screen can pick it up rather than losing it.
  scene.events.once('shutdown', () => { if (q[0] === next) next.showing = false })
}

/**
 * The banner itself. It is the one moment the game congratulates the player, so
 * it is the one thing here allowed to take most of a second.
 */
export function levelUp(scene, x, y, text, depth = 9500, tone = 'gold', sub = null, onDone = null) {
  const [face, deep] = tone === 'green' ? [C.green, C.greenDeep]
    : tone === 'blue' ? [C.blue, C.blueDeep]
    : [C.gold, C.goldDeep]
  const plate = scene.add.graphics().setDepth(depth)
  const t = label(scene, x, y, text, { size: 18, display: true, color: '#fff6d8', origin: [0.5, 0.5] })
    .setDepth(depth + 1).setStroke('#3a2409', 5)
  // A second line for what the moment was actually about — the name of the
  // milestone, or what a season came to.
  const under = sub
    ? label(scene, x, y + 20, sub, { size: 11, color: '#fff6d8', origin: [0.5, 0.5] })
      .setDepth(depth + 1).setStroke('#3a2409', 4)
    : null
  const draw = (scale) => {
    const wide = Math.max(t.displayWidth, under?.displayWidth ?? 0)
    const tall = t.displayHeight + (under ? under.displayHeight + 6 : 0)
    const w = (wide + 44) * scale, h = (tall + 20) * scale
    const r = Math.min(h / 2, 16)
    plate.clear()
    plate.fillStyle(C.rim, 0.9 * t.alpha).fillRoundedRect(x - w / 2 - 3, y - h / 2 - 3 + (under ? 10 : 0), w + 6, h + 6, r + 3)
    plate.fillStyle(deep, t.alpha).fillRoundedRect(x - w / 2, y - h / 2 + (under ? 10 : 0), w, h, r)
    plate.fillStyle(face, t.alpha).fillRoundedRect(x - w / 2, y - h / 2 + (under ? 10 : 0), w, h - 4, r)
    under?.setAlpha(t.alpha)
  }
  t.setScale(t.scaleX * 0.6)
  const base = 1 / RENDER_SCALE
  scene.tweens.add({
    targets: t, scaleX: base, scaleY: base, duration: 260, ease: 'Back.easeOut',
    onUpdate: () => draw(t.scaleX * RENDER_SCALE),
    onComplete: () => scene.tweens.add({
      targets: t, alpha: 0, y: y - 24, delay: 900, duration: 380,
      onUpdate: () => { under?.setY(t.y + 20); draw(1) },
      onComplete: () => { plate.destroy(); t.destroy(); under?.destroy(); onDone?.() },
    }),
  })
  return t
}
