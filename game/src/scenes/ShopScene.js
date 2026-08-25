import Phaser from 'phaser'
import { C, art, button, fitCamera, label, money, panel, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { coins, enter, stagger } from '../ui/fx.js'
import { animalRoom, cropCount, goodCount, levelOf, unitPrice, quoteCrop } from '../core/rules.js'
import { openOrder } from '../core/market.js'
import { backdrop } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { animalIcon, cropIcon, goodIcon, supplyIcon } from '../ui/goods.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { bindKeys } from '../core/keys.js'
import { playMusic, sfx } from '../core/audio.js'
import { outcome, saidAs, takings } from '../ui/sale.js'
import { whileHere } from '../ui/while-here.js'

const PER_PAGE = 4

/** The village shop. Every row is read straight out of the data file. */
export default class ShopScene extends Phaser.Scene {
  constructor() { super('Shop') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }

  create() {
    fitCamera(this)
    enter(this)
    playMusic(this, 'village')
    setBackdrop('shop')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')
    this.tab = 'seeds'
    this.page = 0

    backdrop(this, 'scene:shop')
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x000000, 0.3).setOrigin(0)
    // The shop's money panel owns the top-left corner, so the level plaque sits
    // beside it rather than on top of it.
    this.hud = makeHud(this, 55, { day: true, dayAt: { x: 392, y: 8 }, level: true, levelAt: { x: 214, y: 6 } })

    panel(this, 14, 74, WIDTH - 28, 312, { alpha: 0.97 })
    const tabs = [['seeds', t('shop.seeds')], ['supplies', t('shop.supplies')], ['animals', t('shop.animals')], ['sell', t('shop.sell')]]
    this.tabBtns = tabs.map(([id, name], i) =>
      ({ id, btn: button(this, 88 + i * 142, 94, 132, 26, name, () => { this.tab = id; this.page = 0; this.render() }, { size: 11 }) }))

    // Rows are rebuilt on every render, so track everything and dispose explicitly.
    this.rowParts = []
    button(this, WIDTH - 86, HEIGHT - 24, 150, 30, t('shop.backFarm'), () => this.scene.start('Farm'), { tone: 'wood', size: 12 })
    // The market board lives in the village too, and it is the only place the
    // saturation and order rules are visible.
    button(this, 92, HEIGHT - 24, 140, 30, t('market.open'), () => this.scene.start('Market'), { tone: 'gold', size: 12 })
    this.render()

    bindKeys(this, { Escape: () => this.scene.start('Farm'), m: () => this.scene.start('Market') })

    // Opening a screen is the moment to make sure what is drawn is what the
    // authority actually holds.
    if (this.farm.online) whileHere(this, this.farm, () => this.render())
  }

  rows() {
    const s = this.state, d = this.data_
    const level = levelOf(s, d)
    if (this.tab === 'seeds') return d.crops.map(c => {
      // Locked crops still appear, with what it takes to reach them. Hiding
      // them would leave the player wondering where the shop went.
      const locked = (c.unlockLevel ?? 1) > level
      return {
        name: tx(c.name), price: c.seedPrice, icon: { crop: c }, locked,
        desc: locked ? t('shop.lockedHint', c.unlockLevel) : tx(c.desc),
        owned: s.seeds[c.id] || 0, ownedLabel: t('shop.inBag'),
        facts: t('shop.seedFacts', c.daysPerStage, c.harvests, money(c.sellPrice)),
        badge: locked ? t('shop.locked', c.unlockLevel) : null,
        act: () => this.farm.buySeed({ cropId: c.id }), can: !locked && s.money >= c.seedPrice,
      }
    })
    if (this.tab === 'supplies') return d.supplies.map(it => ({
      name: tx(it.name), price: it.price, desc: tx(it.desc),
      icon: { supply: it.id },
      owned: s.supplies[it.id], ownedLabel: t('shop.held'),
      facts: t('shop.perPack', it.amount),
      act: () => this.farm.buySupply({ supplyId: it.id }), can: s.money >= it.price,
    }))
    if (this.tab === 'animals') return d.animals.map(a => {
      const locked = (a.unlockLevel ?? 1) > level
      return {
        name: tx(a.name), price: a.price, icon: { animal: a }, locked,
        desc: locked ? t('shop.lockedHint', a.unlockLevel) : tx(a.desc),
        owned: s.animals[a.id], ownedLabel: t('shop.kept'),
        facts: t('shop.animalFacts', animalRoom(s, d, a), tx(d.supplies.find(x => x.id === a.feed).name), tx(d.goods.find(g => g.id === a.produces).name)),
        badge: locked ? t('shop.locked', a.unlockLevel) : null,
        act: () => this.farm.buyAnimal({ animalId: a.id }), can: !locked && s.money >= a.price && s.animals[a.id] < animalRoom(s, d, a),
      }
    })
    // The sell tab lists only what the barn actually holds.
    const out = []
    for (const c of d.crops) {
      const n = cropCount(s, c.id)
      if (!n) continue
      // Price the whole pile the way the market will actually pay for it, so
      // the button never promises more than it hands over.
      const q = quoteCrop(s, d, c.id, n)
      const now = unitPrice(s, d, c.id)
      const order = openOrder(s, c.id)
      // What the loan will take off the top, so the button's figure is never a
      // surprise when the money lands.
      const owed = Math.min(s.debt ?? 0, q.total)
      out.push({
        name: tx(c.name), price: now, total: q.total, icon: { crop: c },
        // A row with an order badge has no room for a third line, and the loan
        // is the one thing that must never be the surprise — so it rides on the
        // line that is always drawn.
        desc: owed > 0 ? `${t('shop.inBarnCount', n)}  ·  ${t('shop.loanTakes', money(owed))}` : t('shop.inBarnCount', n),
        descWarn: owed > 0,
        facts: order ? t('shop.orderPrice', money(now))
          : now < c.sellPrice ? t('shop.priceDropped') : t('shop.priceNow', money(now)),
        factsWarn: !order && now < c.sellPrice,
        badge: order ? t('shop.orderBadge') : null,
        // No corner count on a selling row: the line under the name already
        // says how many are in the barn, and "stored 5" three words from
        // "5 in the barn" is the same fact twice with nothing to tell them apart.
        selling: true,
        act: () => this.farm.sellCrop({ cropId: c.id, count: n }), can: true, verb: t('shop.sellAll', n),
      })
    }
    for (const g of d.goods) {
      const n = goodCount(s, g.id)
      const owedOnGood = Math.min(s.debt ?? 0, g.price * n)
      if (n) out.push({
        name: tx(g.name), price: g.price, total: g.price * n, icon: { good: g },
        desc: owedOnGood > 0
          ? `${t('shop.inBarnCount', n)}  ·  ${t('shop.loanTakes', money(owedOnGood))}`
          : t('shop.inBarnCount', n),
        descWarn: owedOnGood > 0,
        facts: t('shop.sellOne', money(g.price)),
        selling: true,
        act: () => this.farm.sellGood({ goodId: g.id, count: n }), can: true, verb: t('shop.sellAll', n),
      })
    }
    return out
  }

  render() {
    // Rows settle in when the list itself changes — a new tab or a new page.
    // Staggering after every buy would re-animate the whole screen each click.
    const signature = `${this.tab}:${this.page}`
    const settle = signature !== this.shown_
    this.shown_ = signature
    const before = this.rowParts.length
    this.rowParts.forEach(o => o.destroy())
    this.rowParts = []
    this.hud.update(this.state, this.data_.rules, this.data_)
    this.tabBtns.forEach(x => x.btn.setEnabled(this.tab !== x.id))

    const rows = this.rows()
    if (!rows.length) {
      this.rowParts.push(label(this, WIDTH / 2, 220, t('shop.emptyBarn'),
        { size: 14, color: C.inkSoft, align: 'center', origin: [0.5, 0.5] }))
      return
    }

    const total = Math.ceil(rows.length / PER_PAGE)
    this.page = Math.min(this.page, total - 1)

    const rows_ = []
    rows.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE).forEach((row, i) => {
      const x = 28, y = 118 + i * 60
      const g = this.add.graphics()
      g.fillStyle(C.rim, row.locked ? 0.5 : 0.85).fillRoundedRect(x - 2, y - 2, WIDTH - 52, 58, 10)
      g.fillStyle(0xe8d9b5, 1).fillRoundedRect(x, y, WIDTH - 56, 54, 8)
      g.fillStyle(row.locked ? 0xe4dccb : 0xfffaf0, 1).fillRoundedRect(x, y, WIDTH - 56, 50, 8)
      const icon = this.icon(row.icon, x + 30, y + 27)
      if (row.locked) icon.forEach(o => o.setAlpha?.(0.4))
      this.rowParts.push(g, ...icon)

      if (row.badge) {
        const bw = row.locked ? 54 : 78
        const bg = this.add.graphics()
        bg.fillStyle(row.locked ? 0x8a7f6b : C.gold, 1).fillRoundedRect(x + 58, y + 4, bw, 14, 7)
        this.rowParts.push(bg, label(this, x + 58 + bw / 2, y + 11, row.badge,
          { size: 8, display: true, color: '#ffffff', origin: [0.5, 0.5] }).setStroke('#1a1208', 2.5))
      }

      const btn = button(this, WIDTH - 92, y + 27, 104, 28, `$ ${money(row.total ?? row.price)}`, async () => {
        // Not "did the money change" — with the rescue loan outstanding a sale
        // can empty the barn, pay down the debt and leave the money exactly
        // where it was. That read as a refusal, so the shop told the player the
        // sale had failed while their crops went anyway.
        const before = takings(this.state)
        await row.act()
        const result = outcome(before, takings(this.state))
        const ok = row.selling ? result.happened : this.state.money !== before.money
        const said = row.selling ? saidAs(result) : `−$${money(row.price)}`
        // A price is short enough to sit over the button it came from. What the
        // loan did with the money is a sentence, and a sentence pinned to the
        // right-hand edge runs off it — so anything longer than a price is
        // centred over the panel instead.
        const brief = ok && said.length <= 10
        toast(this, brief ? WIDTH - 92 : WIDTH / 2, y + 4, ok ? said : t('shop.cannot'),
          ok ? (row.selling ? '#f5b301' : '#b33939') : '#b33939')
        if (ok) {
          sfx(this, row.selling ? 'money-received' : 'buy-spend')
          // Coins only when coins actually arrived; the loan taking it is not
          // money flying to the wallet.
          if (row.selling && result.kept > 0) coins(this, WIDTH - 92, y + 20, 7, { to: this.hud.walletAt })
        } else sfx(this, 'refused')
        this.render()
      }, { tone: row.can ? 'green' : 'red', size: 11 })
      btn.setEnabled(row.can)

      const written = [
        label(this, x + 58, y + (row.badge ? 26 : 14), row.name, { size: 13, display: true, color: row.locked ? '#8a7f6b' : C.ink }),
        label(this, x + 58, y + (row.badge ? 39 : 30), row.desc,
          { size: 9, color: row.descWarn ? '#b3603a' : C.inkSoft }).setWordWrapWidth(290),
        row.badge ? label(this, x + 250, y + 11, '', { size: 1 })
          : label(this, x + 58, y + 43, row.facts, { size: 9, color: row.factsWarn ? '#b3603a' : '#5d7a3f' }),
        label(this, WIDTH - 152, y + 13, row.owned ? `${row.ownedLabel} ${row.owned}` : '', { size: 9, color: C.inkSoft, origin: [1, 0.5] }),
        btn,
      ]
      this.rowParts.push(...written)
      rows_.push([g, ...icon, ...written])
    })

    if (settle && before) stagger(this, rows_)

    // The pager sits inside the panel; on the plate it straddled two colours.
    if (total > 1) {
      this.rowParts.push(
        button(this, 252, 358, 50, 24, '◀', () => { this.page = (this.page - 1 + total) % total; this.render() }, { tone: 'wood', size: 12 }),
        button(this, 348, 358, 50, 24, '▶', () => { this.page = (this.page + 1) % total; this.render() }, { tone: 'wood', size: 12 }),
        label(this, 300, 358, `${this.page + 1} / ${total}`, { size: 11, display: true, color: C.inkSoft, origin: [0.5, 0.5] }))
    }
  }

  /** Rows describe what they want drawn; this turns that into game objects. */
  icon(spec, x, y) {
    if (spec.crop) return cropIcon(this, x, y, spec.crop, 44)
    if (spec.good) return goodIcon(this, x, y, spec.good, 0.7)
    if (spec.animal) return [animalIcon(this, x, y, spec.animal, 40)]
    if (spec.supply) return [supplyIcon(this, x, y, spec.supply, 38)]
    return [art(this, x, y, spec.art, 0.34)]
  }
}
