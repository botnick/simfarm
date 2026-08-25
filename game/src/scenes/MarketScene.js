import Phaser from 'phaser'
import { C, button, fitCamera, label, money, panel, title, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { coins, enter, stagger } from '../ui/fx.js'
import { cropById, cropCount, availableCrops, quoteCrop, unitPrice } from '../core/rules.js'
import { daysLeftInWeek, saturation, weekOf } from '../core/market.js'
import { backdrop } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { cropIcon } from '../ui/goods.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { bindKeys } from '../core/keys.js'
import { playMusic, sfx } from '../core/audio.js'
import { outcome, saidAs, takings } from '../ui/sale.js'
import { nowShowing, whileHere } from '../ui/while-here.js'

const PER_PAGE = 6      // two columns of three

/**
 * The market board.
 *
 * The shop can already sell things; what it cannot do is explain why the price
 * moved. Two rules drive the whole endless economy — a crop sold over and over
 * in one week floods and pays less, and each week asks for three crops at a
 * premium — and until now both were invisible, so a falling price looked like a
 * bug rather than a decision the player had made. This screen is that board:
 * what is wanted, what everything currently pays, and how close each crop is to
 * flooding.
 */
export default class MarketScene extends Phaser.Scene {
  constructor() { super('Market') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }

  create() {
    fitCamera(this)
    nowShowing(this)
    enter(this)
    playMusic(this, 'village')
    setBackdrop('shop')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')
    this.page = 0

    backdrop(this, 'scene:village')
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x1a1208, 0.42).setOrigin(0)
    // The village is scenery, not a plate, so both readouts get their own pill.
    this.hud = makeHud(this, 'plain', { day: true, dayAt: { x: 252, y: 8 }, moneyAt: { x: 8, y: 8 } })

    title(this, WIDTH / 2, 44, t('market.title'), { size: 16 })
    panel(this, 14, 58, WIDTH - 28, 306, { alpha: 0.97 })

    this.parts = []
    button(this, 76, HEIGHT - 24, 128, 30, t('market.back'), () => this.scene.start('Shop'), { tone: 'wood', size: 12 })
    bindKeys(this, { Escape: () => this.scene.start('Shop') })

    this.render()
    if (this.farm.online) whileHere(this, this.farm, () => this.render())
  }

  /** Sell as much of a crop as the barn holds, and say what it fetched. */
  async sell(cropId, count, at) {
    if (!count) return
    const before = takings(this.state)
    await this.farm.sellCrop({ cropId, count })
    const result = outcome(before, takings(this.state))
    const said = saidAs(result)
    if (said) {
      toast(this, at.x, at.y, said, '#f5b301')
      if (result.kept > 0) coins(this, at.x, at.y + 8, 7, { to: this.hud.walletAt })
      sfx(this, 'money-received')
    }
    this.render()
  }

  render() {
    // Only a new page settles in. Re-rendering after a delivery should not
    // replay the whole board.
    const signature = String(this.page)
    const settle = signature !== this.shown_
    this.shown_ = signature
    this.rows_ = []
    this.parts.forEach(o => o.destroy())
    this.parts = []
    const s = this.state, d = this.data_
    this.hud.update(s, d.rules, d)

    this.week()
    this.orders()
    this.priceBoard()
    if (settle) stagger(this, this.rows_)
  }

  /**
   * Which week it is and how long the current board has left, on the orders
   * heading line. It used to sit in the top-right corner, where the language
   * chip already lives and the words ran off the panel.
   */
  week() {
    const s = this.state, r = this.data_.rules
    const left = daysLeftInWeek(s.day, r)
    const week = weekOf(s.day, r) + 1
    this.parts.push(label(this, WIDTH - 28, 77,
      left <= 1 ? t('market.weekLineOne', week) : t('market.weekLine', week, left),
      { size: 9, color: '#8a6b18', origin: [1, 0.5] }))
  }

  /* --------------------------------------------------------------- orders */

  orders() {
    const s = this.state, d = this.data_
    const list = s.market?.orders ?? []
    this.parts.push(label(this, 28, 76, t('market.orders'), { size: 12, display: true, color: C.ink }))

    if (!list.length) {
      this.parts.push(label(this, WIDTH / 2, 116, t('market.noOrders'), { size: 11, color: C.inkSoft, origin: [0.5, 0.5] }))
      return
    }

    const CARD_W = 178, CARD_H = 86, GAP = 12
    const startX = (WIDTH - (list.length * CARD_W + (list.length - 1) * GAP)) / 2
    list.forEach((order, i) => {
      const crop = cropById(d, order.cropId)
      if (!crop) return
      const x = startX + i * (CARD_W + GAP), y = 86
      const done = order.filled >= order.quota
      const held = cropCount(s, order.cropId)
      const want = Math.min(held, order.quota - order.filled)

      // A card the market is still waiting on is ringed in gold, so the eye lands
      // on the ones that can still be earned from.
      //
      // The gold goes INSIDE the dark edge, not outside it. Outside, three cards
      // sitting eight pixels apart had their gold rims almost touching, and the
      // row read as one gold box with cream holes punched in it rather than as
      // three cards.
      // Built like the game's other panels — shadow, heavy dark rim, lit top
      // edge — rather than as a flat rectangle, so an order slip belongs on the
      // same board as everything else.
      const g = this.add.graphics()
      g.fillStyle(0x000000, 0.22).fillRoundedRect(x + 2, y + 4, CARD_W, CARD_H, 9)
      g.fillStyle(C.rim, 0.92).fillRoundedRect(x - 3, y - 3, CARD_W + 6, CARD_H + 6, 11)
      if (!done) g.fillStyle(C.gold, 1).fillRoundedRect(x - 2, y - 2, CARD_W + 4, CARD_H + 4, 10)
      g.fillStyle(done ? 0xcfdcc0 : 0xe8d9b5, 1).fillRoundedRect(x, y, CARD_W, CARD_H, 9)
      g.fillStyle(done ? 0xdfe8d2 : 0xfffaf0, 1).fillRoundedRect(x, y, CARD_W, CARD_H - 4, 9)
      g.fillStyle(0xffffff, 0.55).fillRoundedRect(x + 7, y + 4, CARD_W - 14, 9, 4)
      const card_ = [g, ...cropIcon(this, x + 27, y + 27, crop, 42)]
      this.parts.push(...card_)

      // Two lines, not three, and using the whole width. Three left-aligned
      // lines left the right half of the card empty and the whole thing leaning.
      // The premium is what makes an order worth doing, so it sits opposite the
      // name where the eye lands rather than buried between it and the price.
      const each = Math.round(crop.sellPrice * d.rules.market.orderMultiplier)
      const premium = label(this, x + CARD_W - 10, y + 19, t('market.premium', d.rules.market.orderMultiplier),
        { size: 9, display: true, color: '#8a6b18', origin: [1, 0.5] })
      const name = label(this, x + 52, y + 19, tx(crop.name), { size: 13, display: true, color: C.ink })
      // A long crop name gives way to the premium rather than running under it.
      const room = (x + CARD_W - 14 - premium.displayWidth) - (x + 52)
      if (name.displayWidth > room) name.setScale(name.scaleX * room / name.displayWidth)

      const said = [name, premium,
        label(this, x + 52, y + 35, t('market.each', money(each)), { size: 10, color: '#2d5a1e' })]
      this.parts.push(...said)
      card_.push(...said)

      // Progress reads as a bar rather than a fraction: at a glance you want to
      // see how close the order is, not do the arithmetic.
      //
      // Thin, and with the count beside it rather than on it. Full width and
      // pill-shaped, it was the same size and shape as the button underneath and
      // the pair read as two buttons, one of which happened not to work.
      // In the same column as the name and the price, not running the full width
      // underneath the icon. Spanning the card, it lined up with nothing and an
      // empty one was a long dead tube dominating the card.
      const count = label(this, x + CARD_W - 11, y + 52, t('market.progress', order.filled, order.quota),
        { size: 9, display: true, color: done ? '#2d5a1e' : '#8a6b18', origin: [1, 0.5] })
      const bx = x + 52, by = y + 49, bw = (x + CARD_W - 15 - count.displayWidth) - bx, bh = 6
      const bar = this.add.graphics()
      bar.fillStyle(C.rim, 0.35).fillRoundedRect(bx - 1, by - 1, bw + 2, bh + 2, (bh + 2) / 2)
      bar.fillStyle(0xded2b6, 1).fillRoundedRect(bx, by, bw, bh, bh / 2)
      const f = Phaser.Math.Clamp(order.filled / order.quota, 0, 1)
      if (f > 0) {
        const w = Math.max(bh, bw * f)
        bar.fillStyle(done ? C.greenDeep : C.goldDeep, 1).fillRoundedRect(bx, by, w, bh, bh / 2)
        bar.fillStyle(done ? C.green : C.gold, 1).fillRoundedRect(bx, by, w, bh - 2, bh / 2)
      }
      const shown = [bar, count]
      this.parts.push(...shown)
      card_.push(...shown)

      const btn = button(this, x + CARD_W / 2, y + 72, CARD_W - 20, 20,
        done ? t('market.delivered') : want ? t('market.deliver', want) : t('market.noneHeld'),
        () => this.sell(order.cropId, want, { x: x + CARD_W / 2, y: y + 50 }),
        { tone: done ? 'grey' : want ? 'green' : 'grey', size: 10 })
      btn.setEnabled(!done && want > 0)
      this.parts.push(btn)
      card_.push(btn)
      this.rows_.push(card_)
    })
  }

  /* ---------------------------------------------------------- price board */

  priceBoard() {
    const s = this.state, d = this.data_
    const crops = availableCrops(s, d)
    this.parts.push(
      label(this, 28, 184, t('market.prices'), { size: 12, display: true, color: C.ink }),
      label(this, WIDTH - 28, 185, t('market.goodsNote'), { size: 8, color: C.inkSoft, origin: [1, 0.5] }))

    const total = Math.max(1, Math.ceil(crops.length / PER_PAGE))
    this.page = Phaser.Math.Clamp(this.page, 0, total - 1)
    const page = crops.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE)

    // Three zones across a narrow cell, and they must not reach into each
    // other: the icon, then name and status, then the price or the button that
    // takes it. Everything that used to overlap here was something drawn from
    // the middle outwards.
    const CELL_W = 266, CELL_H = 42, BOARD_TOP = 196, COL_GAP = 12, ROW_GAP = 8
    const NAME_X = 44, NAME_R = 160, RIGHT_L = 168

    page.forEach((crop, i) => {
      const col = i % 2, row = Math.floor(i / 2)
      const x = 24 + col * (CELL_W + COL_GAP), y = BOARD_TOP + row * (CELL_H + ROW_GAP)
      const held = cropCount(s, crop.id)
      const sat = saturation(s, d, crop.id)
      const now = unitPrice(s, d, crop.id)
      const dropped = now < crop.sellPrice
      const tone = sat.tier === 0 ? '#2d5a1e' : sat.tier === 1 ? '#8a6b18' : '#b3603a'

      const g = this.add.graphics()
      g.fillStyle(C.rim, held ? 0.8 : 0.4).fillRoundedRect(x - 2, y - 2, CELL_W + 4, CELL_H + 4, 8)
      g.fillStyle(held ? 0xfffaf0 : 0xf1e9d6, 1).fillRoundedRect(x, y, CELL_W, CELL_H, 6)
      const cell_ = [g, ...cropIcon(this, x + 23, y + 21, crop, 32)]
      this.parts.push(...cell_)

      const word = sat.tier === 0 ? t('market.fresh') : sat.tier === 1 ? t('market.falling') : t('market.flooded')
      const name = label(this, x + NAME_X, y + 12, tx(crop.name), { size: 11, display: true, color: C.ink })
      const line = label(this, x + NAME_X, y + 29, `${word}  ·  ${held ? t('market.held', held) : t('market.sold', sat.sold)}`,
        { size: 8, color: tone })
      this.parts.push(name, line)
      cell_.push(name, line)

      // One pip per tier, lit up to where this crop sits, tucked against the
      // right of the name column so it can never reach the price.
      const pipR = 4, pipGap = 11
      const px = x + NAME_R - (sat.tiers - 1) * pipGap
      for (let k = 0; k < sat.tiers; k++) {
        const colour = k === 0 ? C.green : k === 1 ? C.gold : C.red
        const pip = this.add.graphics()
        pip.fillStyle(C.rim, 0.7).fillCircle(px + k * pipGap, y + 12, pipR + 1)
        pip.fillStyle(k <= sat.tier ? colour : 0xd8cdb2, 1).fillCircle(px + k * pipGap, y + 12, pipR)
        this.parts.push(pip)
        cell_.push(pip)
      }
      // A long crop name must give way to the pips rather than run under them.
      if (name.displayWidth > px - 6 - (x + NAME_X)) name.setScale(name.scaleX * (px - 6 - (x + NAME_X)) / name.displayWidth)

      const right = held
        ? (() => {
            const q = quoteCrop(s, d, crop.id, held)
            const mid = (x + RIGHT_L + x + CELL_W - 8) / 2
            return [
              label(this, mid, y + 10, t('market.each', money(now)),
                { size: 8, color: dropped ? '#b3603a' : '#2d5a1e', origin: [0.5, 0.5] }),
              button(this, mid, y + 28, CELL_W - RIGHT_L - 12, 18, `$ ${money(q.total)}`,
                () => this.sell(crop.id, held, { x: mid, y: y + 4 }), { tone: 'green', size: 9 }),
            ]
          })()
        : [
            label(this, x + CELL_W - 10, y + 13, `$ ${money(now)}`,
              { size: 13, display: true, color: dropped ? '#b3603a' : '#2d5a1e', origin: [1, 0.5] }),
            label(this, x + CELL_W - 10, y + 29,
              sat.toNext == null ? t('market.lowest') : t('market.toNext', sat.toNext),
              { size: 8, color: C.inkSoft, origin: [1, 0.5] }),
          ]
      this.parts.push(...right)
      cell_.push(...right)
      this.rows_.push(cell_)
    })

    if (total > 1) {
      this.parts.push(
        button(this, 252, 351, 46, 22, '◀', () => { this.page = (this.page - 1 + total) % total; this.render() }, { tone: 'wood', size: 11 }),
        button(this, 348, 351, 46, 22, '▶', () => { this.page = (this.page + 1) % total; this.render() }, { tone: 'wood', size: 11 }),
        label(this, 300, 351, `${this.page + 1} / ${total}`, { size: 10, display: true, color: C.inkSoft, origin: [0.5, 0.5] }))
    }
  }

}
