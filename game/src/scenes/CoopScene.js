import Phaser from 'phaser'
import { C, button, fitCamera, label, money, panel, title, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { coins, enter, stagger } from '../ui/fx.js'
import { animalRoom, byId, goodCount } from '../core/rules.js'
import { backdrop, centreOf, regionByRole, regions } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { animalIcon, goodIcon } from '../ui/goods.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { bindKeys } from '../core/keys.js'
import { playMusic, sfx } from '../core/audio.js'

/**
 * The yard. It once held only chickens; now every animal in the data file gets
 * a row here, so adding one is a JSON edit rather than a screen rewrite.
 */
export default class CoopScene extends Phaser.Scene {
  constructor() { super('Coop') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }

  create() {
    fitCamera(this)
    enter(this)
    playMusic(this, 'farm')
    setBackdrop('coop')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')

    backdrop(this, 'scene:coop')
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x2a1a0e, 0.35).setOrigin(0)
    this.hits = regions(this, 40)
    // Frame 40, the same frame the hotspots come from. The coop's own artwork
    // has a money plate painted into it, and asking for a frame that does not
    // exist left that plate on screen with nothing in it — on the one screen
    // besides the shop where money actually changes, since this is where the
    // flock's produce is sold.
    this.hud = makeHud(this, 40, { day: true, dayAt: { x: 252, y: 8 } })

    title(this, WIDTH / 2, 46, t('coop.flock'), { size: 16 })
    // Low enough to clear the money plate painted into the coop's own artwork:
    // its value box runs to y 72, and a panel starting at 58 cut the number in
    // half. The rows below move down with it and still finish above the buttons.
    panel(this, 14, 76, WIDTH - 28, 288, { alpha: 0.96 })

    this.rows = []
    this.parts = []

    const home = regionByRole(this.hits, 'home')
    if (home) {
      const c = centreOf(home)
      this.add.zone(c.x - 30, c.y - 34, 60, 68).setOrigin(0).setInteractive({ useHandCursor: true })
        .on('pointerup', () => this.scene.start('Farm'))
    }
    button(this, 82, HEIGHT - 24, 140, 30, t('plot.backFarm'), () => this.scene.start('Farm'), { tone: 'wood', size: 12 })
    this.sellBtn = button(this, WIDTH - 96, HEIGHT - 24, 170, 30, t('coop.sell'), () => this.sellAll(), { tone: 'gold', size: 12 })

    bindKeys(this, { Escape: () => this.scene.start('Farm'), f: () => this.feedEveryone() })
    this.render()
    if (this.farm.online) this.farm.sync().then(() => this.render())
  }

  /** Feed every species that still wants feeding, in one go. */
  async feedEveryone() {
    const before = this.fedTotal()
    for (const a of this.data_.animals) await this.farm.feed({ animalId: a.id })
    const fed = this.fedTotal() - before
    toast(this, WIDTH / 2, 120, fed ? t('coop.fedN', fed) : t('coop.nothingToFeed'), fed ? '#c8f5a8' : '#ffd6d6')
    if (fed) sfx(this, 'feed-animals')
    this.render()
  }

  fedTotal() { return Object.values(this.state.fed ?? {}).reduce((a, b) => a + b, 0) }

  async feedOne(animal) {
    const before = this.fedTotal()
    await this.farm.feed({ animalId: animal.id })
    const n = this.fedTotal() - before
    toast(this, WIDTH / 2, 120, n ? t('coop.fedN', n) : t('coop.nothingToFeed'), n ? '#c8f5a8' : '#ffd6d6')
    if (n) { sfx(this, 'feed-animals'); sfx(this, `animal-${animal.id}`, { volume: 0.8 }) }
    this.render()
  }

  /** Sell everything the animals have produced. */
  async sellAll() {
    const before = this.state.money
    for (const a of this.data_.animals) {
      const held = goodCount(this.state, a.produces)
      if (held) await this.farm.sellGood({ goodId: a.produces, count: held })
    }
    const total = this.state.money - before
    if (total) {
      toast(this, WIDTH / 2, HEIGHT - 60, `+$${money(total)}`, '#f5b301')
      coins(this, WIDTH / 2, HEIGHT - 52, 10, { to: this.hud.walletAt })
      sfx(this, 'money-received')
    }
    this.render()
  }

  render() {
    // Only the first draw settles in; re-rendering after a feed should not
    // replay the whole list.
    const settle = !this.shown_
    this.shown_ = true
    const rows_ = []
    this.parts.forEach(o => o.destroy())
    this.parts = []
    const s = this.state
    this.hud.update(s, this.data_.rules, this.data_)

    const level = this.data_.animals.length
    this.data_.animals.forEach((a, i) => {
      const y = 84 + i * 71
      const kept = s.animals[a.id] ?? 0
      const fed = s.fed[a.id] ?? 0
      const good = byId(this.data_.goods, a.produces)
      const stored = goodCount(s, a.produces)
      const locked = (a.unlockLevel ?? 1) > this.hud.level

      const row_ = []
      const g = this.add.graphics()
      g.fillStyle(C.rim, kept ? 0.85 : 0.45).fillRoundedRect(26, y - 2, WIDTH - 52, 70, 10)
      g.fillStyle(kept ? 0xfffaf0 : 0xefe6d2, 1).fillRoundedRect(28, y, WIDTH - 56, 66, 8)
      row_.push(g, animalIcon(this, 62, y + 33, a, kept ? 48 : 40).setAlpha(kept ? 1 : 0.35))
      this.parts.push(...row_)

      // Each kind eats its own feed, so the row says which and how much is left.
      // Three lines, never four: the description is only worth the space before
      // you own any, and after that what is waiting to be collected matters more.
      const feed = byId(this.data_.supplies, a.feed)
      const held = s.supplies[a.feed] ?? 0
      const lastLine = kept
        ? (stored ? `${stored} ${tx(good.name)}  ·  $${money(good.price * stored)}` : t('coop.nothingYet'))
        : tx(a.desc)
      const written = [
        label(this, 96, y + 15, tx(a.name), { size: 14, display: true, color: kept ? C.ink : '#8a7f6b' }),
        label(this, 96, y + 34, `${kept} / ${animalRoom(s, this.data_, a)}   ·   ${t('coop.info2', fed)}   ·   ${t('coop.eats', tx(feed.name), held)}`,
          { size: 9, color: held > 0 ? C.inkSoft : '#b3603a' }),
        label(this, 96, y + 50, lastLine,
          { size: 9, color: stored ? '#2d5a1e' : C.inkSoft }).setWordWrapWidth(300)]
      this.parts.push(...written)
      row_.push(...written)

      if (stored) { const gi = goodIcon(this, WIDTH - 168, y + 28, good, 0.5); this.parts.push(...gi); row_.push(...gi) }

      const canFeed = kept > 0 && fed < kept
        && s.supplies[a.feed] > 0 && s.energy >= (this.data_.rules.feedEnergy ?? 0)
      const btn = button(this, WIDTH - 84, y + 28, 104, 26, t('coop.feed'), () => this.feedOne(a), { size: 11 })
      btn.setEnabled(canFeed)
      this.parts.push(btn)
      row_.push(btn)
      rows_.push(row_)

      // A hungry flock says so directly under its own button, not floating in
      // the gap beside the produce icon where it read as a caption for that.
      if (kept > 0 && fed < 1) {
        this.parts.push(label(this, WIDTH - 84, y + 54, t('coop.hungryShort'),
          { size: 9, color: '#b3603a', origin: [0.5, 0.5] }))
      }
    })

    if (settle) stagger(this, rows_)

    const anyStored = this.data_.animals.some(a => goodCount(s, a.produces) > 0)
    this.sellBtn.setEnabled(anyStored)
  }
}
