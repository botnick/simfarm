// The live numbers that the scene plates deliberately leave blank: money, day,
// supply counts, and the energy heart. Every box below is a stage-space
// rectangle recovered from the original SWF, so the text lands where the
// artwork expects it.
import { C, chip, label, money, toast } from './kit.js'
import { RENDER_SCALE } from '../core/size.js'
import { WIDTH } from '../main.js'
import { t, tx, nextLang, setLang } from '../core/i18n.js'
import { touchPad } from '../core/device.js'
import { levelProgress } from '../core/progression.js'
import { farmLimits } from '../core/rules.js'
import { banner, countTo, pop } from './fx.js'
import { isMuted, sfx, toggleMuted } from '../core/audio.js'

// What the server says, and what a player can make sense of.
const REFUSALS = {
  'slow down': 'refused.tooFast',
  'no session': 'refused.session',
  'session expired': 'refused.session',
  'offline': 'refused.offline',
  'out of date': 'refused.stale',
  'reward': 'refused.reward',
  'ruleMismatch': 'refused.ruleMismatch',
}

const boxOf = (list, role) => list.find(b => b.role === role)
const midY = (b) => b.y + b.h / 2

/**
 * @param frame the original frame number, which selects the HUD layout
 */
export function makeHud(scene, frame, { day = false, dayAt = { x: 8, y: 8 }, level = false, levelAt = { x: 6, y: 6 } } = {}) {
  const all = scene.registry.get('hitsUi')?.hudByFrame ?? {}
  let boxes = all[String(frame)]
  if (typeof boxes === 'string') boxes = all[boxes.replace('same-as:', '')]   // e.g. "same-as:20"
  boxes = boxes || []

  const parts = {}

  const moneyBox = boxOf(boxes, 'money-value')
  const dayBox = day ? boxOf(boxes, 'day-value') : null

  // The plates used to carry the words "day" and "money" in English. They have
  // been lifted out, so the caption is drawn here and follows the language.
  // Panels that stack day over money put the caption to the left of the value;
  // the single money panel puts it on the line above.
  const stacked = !!dayBox
  // The stacked panel is a wide plaque, so each caption and its number are
  // centred on it as one unit. Left-aligning them into the recovered text boxes
  // left a pool of empty blue on either side.
  const PANEL_CENTRE = 133.5     // measured off the plate, not guessed
  const PANEL_MIDDLE = 366.5
  const ROW_GAP = 26
  const GAP = 10

  const caption = (box) => label(scene, stacked ? box.x - 8 : box.x + 52, stacked ? midY(box) : box.y - 15,
    '', { size: stacked ? 15 : 12, display: true, color: '#cfe9ff', origin: stacked ? [1, 0.5] : [0, 0.5] })
    .setDepth(400).setStroke('#12365e', 3.5)
  const value = (box) => label(scene, box.x + 4, midY(box), '', { size: stacked ? 22 : 16, display: true, color: '#ffffff' })
    .setDepth(400).setStroke('#12365e', 4.5)

  if (moneyBox) { parts.moneyCaption = caption(moneyBox); parts.money = value(moneyBox) }
  if (dayBox) { parts.dayCaption = caption(dayBox); parts.day = value(dayBox) }

  // Sit the two rows either side of the plaque's middle. The recovered text
  // boxes are lower than centre, which left a band of empty blue on top.
  if (stacked && dayBox && moneyBox) {
    for (const [cap, val, y] of [
      [parts.dayCaption, parts.day, PANEL_MIDDLE - ROW_GAP / 2],
      [parts.moneyCaption, parts.money, PANEL_MIDDLE + ROW_GAP / 2],
    ]) { cap.setY(y); val.setY(y) }
  }

  /** Centre a caption/number pair on the plaque, once both know their text. */
  const balance = (cap, val) => {
    if (!stacked || !cap || !val) return
    const total = cap.displayWidth + GAP + val.displayWidth
    const left = PANEL_CENTRE - total / 2
    cap.setX(left + cap.displayWidth)
    val.setX(left + cap.displayWidth + GAP)
  }

  // The plate leaves the heart hollow. Flash filled it by masking a plain green
  // rectangle with the heart outline; here the heart is drawn directly and cut
  // off at the energy level, which avoids relying on a mask under camera zoom.
  const fillBox = boxOf(boxes, 'energy-fill')
  if (fillBox) {
    parts.energyFill = { g: scene.add.graphics().setDepth(320), box: fillBox, heart: heartPoints(fillBox) }
  }

  // Day and energy do not always have a painted slot; show them plainly instead.
  // Where the plate has no painted slot, the readout gets its own little pill,
  // sized to whatever the current language makes of the text.
  if (!dayBox && day) parts.dayChip = chip(scene, dayAt.x, dayAt.y + 11, { tone: 'blue' })
  if (!fillBox) parts.energyChip = chip(scene, WIDTH - 8, 16, { tone: 'green', align: 'right' })

  // The farm's level and how far it is through the current one, on one small
  // plaque. Loose text floated over the scenery and could not be read.
  if (level) {
    const lx = levelAt.x, ly = levelAt.y, lw = 156, lh = 36
    const R = 10
    const plate = scene.add.graphics().setDepth(398)
    plate.fillStyle(0x000000, 0.28).fillRoundedRect(lx + 2, ly + 4, lw, lh, R)      // shadow
    plate.fillStyle(C.rim, 1).fillRoundedRect(lx - 2, ly - 2, lw + 4, lh + 4, R + 2) // rim
    plate.fillStyle(C.woodDeep, 1).fillRoundedRect(lx, ly, lw, lh, R)
    plate.fillStyle(C.wood, 1).fillRoundedRect(lx, ly, lw, lh - 4, R)
    plate.fillStyle(0xffffff, 0.16).fillRoundedRect(lx + 6, ly + 4, lw - 12, 11, 5)  // gloss

    // The level itself rides a gold medal rather than sitting in the text, which
    // is what made the old plaque read as a bare progress bar with a number.
    const bx = lx + 20, by = ly + 18, br = 14
    plate.fillStyle(C.rim, 1).fillCircle(bx, by, br + 2)
    plate.fillStyle(C.goldDeep, 1).fillCircle(bx, by, br)
    plate.fillStyle(C.gold, 1).fillCircle(bx, by - 1, br - 1)
    plate.fillStyle(0xffffff, 0.35).fillEllipse(bx, by - 6, br * 1.1, br * 0.55)
    parts.levelText = label(scene, bx, by, '', { size: 15, display: true, color: '#fff8e1', origin: [0.5, 0.5] })
      .setDepth(400).setStroke('#6b4a05', 4)
    parts.levelSize = (digits) => parts.levelText.setScale((digits >= 3 ? 0.68 : digits === 2 ? 0.86 : 1) / RENDER_SCALE)

    const colX = lx + 40, colR = lx + lw - 11
    parts.levelWord = label(scene, colX, ly + 12, '', { size: 9, display: true, color: '#ffe27a' })
      .setDepth(400).setStroke('#3a2409', 3)
    parts.xpText = label(scene, colR, ly + 12, '', { size: 9, color: '#f3e3bd', origin: [1, 0.5] })
      .setDepth(400).setStroke('#3a2409', 3)

    // A rounded bar, redrawn each update so the fill keeps its cap instead of
    // being a square rectangle sliding under a rounded track.
    const barX = colX, barY = ly + 24, barW = colR - colX, barH = 9
    const track = scene.add.graphics().setDepth(399)
    track.fillStyle(C.rim, 0.85).fillRoundedRect(barX - 1, barY - 1, barW + 2, barH + 2, (barH + 2) / 2)
    track.fillStyle(0x2a1c09, 1).fillRoundedRect(barX, barY, barW, barH, barH / 2)
    const fill = scene.add.graphics().setDepth(400)
    parts.xpDraw = (fraction) => {
      fill.clear()
      const f = Phaser.Math.Clamp(fraction, 0, 1)
      if (f <= 0) return
      // A sliver of progress is still progress: below one bar-height it draws
      // as a rounded nub, so the first XP of a level is visible rather than
      // vanishing into the track.
      const w = Math.max(barH, barW * f)
      fill.fillStyle(C.goldDeep, 1).fillRoundedRect(barX, barY, w, barH, barH / 2)
      fill.fillStyle(C.gold, 1).fillRoundedRect(barX, barY, w, barH - 3, barH / 2)
      fill.fillStyle(0xffffff, 0.4).fillRoundedRect(barX + 2, barY + 1.5, Math.max(0, w - 4), 2.5, 1.25)
    }
    parts.xpDraw(0)
  }


  // Language and sound share one line in the corner. Two switches do not earn a
  // settings screen, and hiding a mute behind one puts it further away than the
  // thing it silences.
  // Where the plate paints its own energy heart there is room to breathe; where
  // the energy is a pill of ours it sits directly above, so this line is placed
  // clear of it rather than tucked under its edge.
  const cy = fillBox ? 74 : 46
  const pad = touchPad()
  const tap = (chipApi, onTap) => scene.add
    .rectangle(chipApi.left + chipApi.width / 2, cy, chipApi.width + pad * 2, 20 + pad * 2, 0x000000, 0)
    .setDepth(402).setInteractive({ useHandCursor: true })
    .on('pointerup', onTap)

  const muteChip = chip(scene, WIDTH - 8, cy, { tone: 'wood', align: 'right', size: 9 })
  const paintMute = () => muteChip.setText(isMuted() ? t('hud.soundOff') : t('hud.soundOn'))
  paintMute()
  const muteHit = tap(muteChip, () => {
    const off = toggleMuted(scene)
    paintMute()
    if (!off) sfx(scene, 'button-press')
    // The caption changes width between languages and states, so both chips are
    // laid out again rather than left where they first landed.
    place()
  })

  const langChip = chip(scene, WIDTH - 8, cy, { tone: 'wood', align: 'right', size: 9 })
  langChip.setText(t('lang.name'))
  const langHit = tap(langChip, () => { setLang(nextLang()); scene.scene.restart() })

  /** Sit the two chips side by side against the right edge. */
  const place = () => {
    muteChip.setRight(WIDTH - 8)
    langChip.setRight(muteChip.left - 6)
    for (const [c, hit] of [[muteChip, muteHit], [langChip, langHit]]) {
      hit.setPosition(c.left + c.width / 2, cy)
      hit.setSize(c.width + pad * 2, 20 + pad * 2)
      // Resizing the rectangle does not resize what the pointer tests against.
      hit.input?.hitArea?.setSize(c.width + pad * 2, 20 + pad * 2)
    }
  }
  place()

  // Refusals come from the transport, not from a scene, so the HUD listens for
  // them rather than every screen having to remember to.
  //
  // Both events, deliberately: Phaser raises `setdata` the first time a key is
  // written and `changedata` only afterwards, so listening for one of them means
  // missing either the first of these a player ever sees or all the rest.
  const onRefusal = (_p, value) => {
    if (!value) return
    toast(scene, WIDTH / 2, 96, t(REFUSALS[value.reason] ?? 'refused.other'), '#ffd6d6')
    sfx(scene, 'refused')
  }
  scene.registry.events.on('changedata-refusal', onRefusal)
  scene.registry.events.on('setdata-refusal', onRefusal)
  scene.events.once('shutdown', () => {
    scene.registry.events.off('changedata-refusal', onRefusal)
    scene.registry.events.off('setdata-refusal', onRefusal)
  })

  // A milestone can be earned anywhere — picking a crop in a field, starting a
  // batch in the workshop, buying a bird in the shop — so the announcement lives
  // where every screen already has one. Until now the game awarded them and told
  // nobody: they existed only for a host to read.
  // Kept on the registry, not on this HUD: every screen builds its own, and a
  // set that started empty each time would congratulate the player again for
  // everything they had ever done, every time they changed screen.
  const announced = scene.registry.get('announcedMilestones') ?? new Set()
  scene.registry.set('announcedMilestones', announced)
  const rulebook = scene.registry.get('data')

  const tellAbout = (list) => {
    for (const m of list ?? []) {
      const id = m.milestoneId ?? m
      if (!id || announced.has(id)) continue
      announced.add(id)
      const known = (rulebook?.milestones ?? []).find(x => x.id === id)
      // Milestones past the listed ones are generated from a rule, so their name
      // is generated too rather than being a missing string.
      const level = /^level-(\d+)$/.exec(id)
      const name = known ? tx(known.name) : level ? t('hud.levelReached', level[1]) : id
      banner(scene, t('hud.milestone'), { tone: 'gold', sub: name })
      sfx(scene, 'level-up')
    }
  }
  const onMilestone = (_p, value) => tellAbout(value)
  scene.registry.events.on('changedata-milestones', onMilestone)
  scene.registry.events.on('setdata-milestones', onMilestone)
  scene.events.once('shutdown', () => {
    scene.registry.events.off('changedata-milestones', onMilestone)
    scene.registry.events.off('setdata-milestones', onMilestone)
  })
  // Anything earned while another screen was open is still owed to the player.
  tellAbout(scene.registry.get('milestones'))

  const api = {
    level: 1,
    // Where money lands on this screen, so an effect can fly coins to it. The
    // panels differ per frame, hence asking rather than assuming a corner.
    walletAt: parts.money ? { x: parts.money.x, y: parts.money.y } : { x: 70, y: 26 },
    update(state, rules, data) {
      if (data) api.level = levelProgress(state.xp ?? 0, data).level
      if (parts.levelText && data) {
        const p = levelProgress(state.xp ?? 0, data)
        if (api.__shownLevel != null && p.level > api.__shownLevel) pop(scene, parts.levelText, 0.45, 340)
        api.__shownLevel = p.level
        // The medal is a fixed circle, so a three-digit farm shrinks to fit it
        // rather than spilling over the rim.
        const lvl = String(p.level)
        parts.levelText.setText(lvl)
        parts.levelSize(lvl.length)
        parts.levelWord.setText(t('hud.levelWord'))
        parts.xpText.setText(t('hud.xp', p.into, p.needed))
        parts.xpDraw(p.fraction)
      }
      // Money rolls to its new figure. A total that simply changes gives no
      // sense of having earned anything, and this is the number a player watches.
      countTo(scene, parts.money, state.money)
      parts.moneyCaption?.setText(t('hud.money'))
      parts.day?.setText(String(state.day))
      parts.dayCaption?.setText(t('hud.dayWord'))
      balance(parts.dayCaption, parts.day)
      balance(parts.moneyCaption, parts.money)
      parts.dayChip?.setText(rules.endDay ? t('hud.day', state.day, rules.endDay) : t('hud.dayEndless', state.day))

      // Against what this farm's day actually holds, not the number a new farm
      // starts on: the farm grows with the level, and a heart measured against
      // the old maximum would sit full all morning and tell the player nothing.
      const dayHolds = data ? farmLimits(state, data).energy : rules.startEnergy
      const frac = Phaser.Math.Clamp(state.energy / dayHolds, 0, 1)
      if (parts.energyFill) {
        const { g, box, heart } = parts.energyFill
        g.clear()
        const poly = clipBelow(heart, box.y + box.h * (1 - frac))
        if (poly.length > 2) {
          g.fillStyle(frac > 0.5 ? 0x3fca44 : frac > 0.2 ? 0xf0b21e : 0xd0402f, 1)
          g.fillPoints(poly.map(([x, y]) => ({ x, y })), true)
        }
      }
      // Out of how much, because how much is no longer a fixed number every
      // player would already know.
      parts.energyChip?.setText(t('hud.energyOf', state.energy, dayHolds))
    },
  }
  return api
}

/** The heart outline as a polygon, sized to the slot the artwork leaves for it. */
function heartPoints(box) {
  const pts = []
  for (let i = 0; i <= 72; i++) {
    const th = (i / 72) * Math.PI * 2
    const hx = 16 * Math.sin(th) ** 3
    const hy = 13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th)
    pts.push([box.x + box.w / 2 + (hx / 17) * (box.w / 2), box.y + box.h / 2 - (hy / 17) * (box.h / 2)])
  }
  return pts
}

/** Keep the part of a polygon at or below `y` — one edge of Sutherland-Hodgman. */
function clipBelow(pts, y) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const aIn = a[1] >= y, bIn = b[1] >= y
    if (aIn) out.push(a)
    if (aIn !== bIn) {
      const s = (y - a[1]) / (b[1] - a[1])
      out.push([a[0] + (b[0] - a[0]) * s, y])
    }
  }
  return out
}
