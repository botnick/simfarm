import Phaser from 'phaser'
import { C, button, fitCamera, label, money, panel, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { banner, enter } from '../ui/fx.js'
import { playMusic, sfx } from '../core/audio.js'
import { animalRoom, cropById, farmLimits, goodCount, nextGrant, totalCrops } from '../core/rules.js'
import { backdrop, centreOf, regions } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { save } from '../core/save.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { isTouch } from '../core/device.js'
import { bindKeys } from '../core/keys.js'
import { whileHere } from '../ui/while-here.js'

/**
 * The farm as the original drew it. The house becomes the workshop, the road
 * leads to the shop, and each field patch opens its own screen.
 */
export default class FarmScene extends Phaser.Scene {
  constructor() { super('Farm') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }

  create() {
    fitCamera(this)
    enter(this)
    playMusic(this, 'farm')
    setBackdrop('farm')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')

    backdrop(this, 'scene:farm')
    this.rainLayer = this.add.container(0, 0).setDepth(500)
    this.hud = makeHud(this, 15, { day: true, level: true })

    const hits = regions(this, 15)
    this.marks = []
    for (let i = 0; i < this.data_.rules.plots; i++) {
      this.marks.push(this.hotspot(hits, `goto:field${i + 1}`, t('farm.field', i + 1),
        () => this.scene.start('Plot', { plotIndex: i }), 0.62))
    }
    this.hotspot(hits, 'goto:coop', t('farm.coop'), () => this.scene.start('Coop'))
    this.hotspot(hits, 'goto:house', t('farm.workshop'), () => this.scene.start('Workshop'))
    this.hotspot(hits, 'goto:village', t('farm.shop', this.data_.meta.shopName), () => this.toShop())

    // These sit on top of the road, which is also the way to the village, so they
    // are lifted above the scenery hotspots to win the click.
    button(this, WIDTH - 78, HEIGHT - 26, 140, 32, t('farm.endDay'), () => this.nextDay(), { tone: 'gold', size: 14 }).setDepth(600)
    button(this, WIDTH - 78, HEIGHT - 62, 140, 26, t('farm.save'), () => this.keep(), { tone: 'wood', size: 11 }).setDepth(600)

    // Thai wraps longer than English, so the panel is cut to fit the text each
    // refresh rather than being a fixed box the words spill out of.
    this.statusPanel = this.add.graphics().setDepth(398)
    this.status = label(this, 18, 250, '', { size: 9, color: '#fff4dd', origin: [0, 0] }).setDepth(400)

    bindKeys(this, {
      Enter: () => this.nextDay(),
      ' ': () => this.nextDay(),
      c: () => this.scene.start('Coop'),
      k: () => this.scene.start('Workshop'),
      v: () => this.toShop(),
      m: () => this.scene.start('Market'),
      1: () => this.scene.start('Plot', { plotIndex: 0 }),
      2: () => this.scene.start('Plot', { plotIndex: 1 }),
      3: () => this.scene.start('Plot', { plotIndex: 2 }),
      4: () => this.scene.start('Plot', { plotIndex: 3 }),
    })
    this.refresh()

    // Opening a screen is the moment to make sure what is drawn is what the
    // authority actually holds.
    if (this.farm.online) whileHere(this, this.farm, () => this.refresh())
  }

  /**
   * A place on the farm you can walk into. The original art already shows what
   * each one is, so the label only appears when the pointer is over it.
   */
  hotspot(hits, role, name, onClick, shrink = 1) {
    const full = hits.find(h => h.role === role)
    if (!full) return null
    const c = centreOf(full)
    // The four field rectangles in the original are far larger than the patches
    // they stand for and overlap each other heavily. That was invisible when
    // clicking was the only feedback, but with a hover label it means pointing
    // at open grass names a field on the other side of the path. Pulling the
    // fields in around their centres keeps the target generous while making it
    // land where you look. The coop, house and road are distinct places and
    // keep their full reach.
    const r = shrink === 1 ? full
      : { x: c.x - full.w * shrink / 2, y: c.y - full.h * shrink / 2, w: full.w * shrink, h: full.h * shrink }

    // One plaque per place, not two. It shows the status when the field wants
    // something, and the place's name while the pointer is over it.
    const plaque = this.add.graphics().setDepth(419)
    // The level badge owns the top-left corner, so a plaque that would land
    // under it is pushed clear rather than drawn over it.
    const clearsLevelBadge = c.x < 170 ? 48 : 20
    const text = label(this, c.x, Math.max(clearsLevelBadge, r.y + 26), '', { size: 10, display: true, color: '#ffe27a', origin: [0.5, 0.5] })
      .setDepth(420).setStroke('#1a1208', 3.5)
    text.homeX = c.x
    text.name_ = name

    const paint = () => {
      // Touch screens never hover, so what a mouse reveals on pointer-over is
      // simply left visible there.
      const show = text.hovered || text.urgent || isTouch()
      if (!show || !text.text) { plaque.clear(); text.setAlpha(0); return }
      text.setAlpha(1)
      text.x = Phaser.Math.Clamp(text.homeX, text.displayWidth / 2 + 8, WIDTH - text.displayWidth / 2 - 8)
      const w = text.displayWidth + 16, h = text.displayHeight + 7
      plaque.clear()
      plaque.fillStyle(0x1a1208, 0.78).fillRoundedRect(text.x - w / 2, text.y - h / 2, w, h, h / 2)
    }
    text.paint = paint

    this.add.zone(r.x, r.y, r.w, r.h).setOrigin(0).setInteractive({ useHandCursor: true })
      .on('pointerover', () => { text.hovered = true; text.setText(text.status || name); paint() })
      .on('pointerout', () => { text.hovered = false; text.setText(text.urgent ? text.status : ''); paint() })
      .on('pointerup', onClick)
    paint()
    return text
  }

  refresh() {
    const s = this.state, r = this.data_.rules
    this.hud.update(s, r, this.data_)

    for (let i = 0; i < r.plots; i++) {
      const plot = s.plots[i], mark = this.marks[i]
      if (!mark) continue
      const crop = plot.cropId ? cropById(this.data_, plot.cropId) : null
      const ripe = plot.tiles.filter(x => x.stage === r.stage.ripe).length
      const pest = plot.tiles.filter(x => x.pest).length
      const dry = crop ? plot.tiles.filter(x => x.stage < r.stage.dead && !x.watered).length : 0
      const bits = []
      if (ripe) bits.push(t('farm.ready', ripe))
      if (pest) bits.push(t('farm.bug', pest))
      if (dry) bits.push(t('farm.thirsty', dry))
      // An empty field is not a problem, so it stays quiet until you look at it.
      mark.status = crop ? (bits.join(' · ') || tx(crop.name)) : `${mark.name_} · ${t('farm.empty')}`
      mark.urgent = !!(ripe || pest)
      mark.setColor(pest ? '#ff9a9a' : ripe ? '#ffe27a' : '#e8f5d8')
      mark.setText(mark.hovered || mark.urgent || isTouch() ? mark.status : '')
      mark.paint()
    }

    const curing = s.pending.length
    // Summarise the whole farm rather than the first of everything: there are
    // three feeds and four kinds of animal now.
    const feeds = this.data_.supplies
      .filter(x => this.data_.animals.some(a => a.feed === x.id))
      .map(x => `${tx(x.name)} ${s.supplies[x.id] ?? 0}`)
      .join(' · ')
    const kept = this.data_.animals.reduce((n, a) => n + (s.animals[a.id] ?? 0), 0)
    const capacity = this.data_.animals.reduce((n, a) => n + animalRoom(s, this.data_, a), 0)
    const produce = this.data_.animals.reduce((n, a) => n + goodCount(s, a.produces), 0)
    // The rescue loan is repaid off the top of every sale, so it has to be
    // visible: a player who does not know about it sees sales that pay nothing.
    const owed = s.debt ?? 0
    // What the farm has grown into. Every unlock has a last one, so past that
    // point this line is the only thing that says the level still means
    // something.
    const grown = farmLimits(s, this.data_)
    const next = nextGrant(s, this.data_)
    this.status.setText([
      ...(owed > 0 ? [t('farm.loan', money(owed))] : []),
      ...(grown.steps > 0 ? [t('farm.grown', grown.energy, grown.barnSoftCap, grown.animalMax)] : []),
      ...(next ? [t('farm.nextGrant', next.level, [
        next.energy && t('farm.grantEnergy', next.energy),
        next.barnSoftCap && t('farm.grantBarn', next.barnSoftCap),
        next.animalMax && t('farm.grantAnimals', next.animalMax),
      ].filter(Boolean).join(' · '))] : []),
      t('farm.seedsInBag', Object.values(s.seeds).reduce((x, y) => x + y, 0)),
      // By id, not by position. This line used to take its two names from the
      // first and second entries in the supplies list while taking the numbers
      // beside them from `fertilizer` and `pesticide` — so reordering that list
      // would have gone on printing two plausible names against two counts that
      // no longer belonged to them, and nothing would have looked wrong.
      this.data_.supplies
        .filter(x => !this.data_.animals.some(a => a.feed === x.id))
        .map(x => `${tx(x.name)} ${s.supplies[x.id] ?? 0}`)
        .join(' · '),
      feeds,
      t('farm.herdLine', kept, capacity, produce),
      `${t('farm.stored', totalCrops(s))} · ${curing ? t('farm.curing', curing) : t('farm.nothingCuring')}`,
    ].join('\n'))

    const w = this.status.displayWidth + 20, h = this.status.displayHeight + 16
    const px = 8, py = this.status.y - 8
    this.statusPanel.clear()
    this.statusPanel.fillStyle(0x000000, 0.28).fillRoundedRect(px + 2, py + 3, w, h, 9)
    this.statusPanel.fillStyle(C.rim, 0.92).fillRoundedRect(px - 2, py - 2, w + 4, h + 4, 11)
    this.statusPanel.fillStyle(0x6b4526, 0.96).fillRoundedRect(px, py, w, h, 9)

    this.rainLayer.setVisible(s.raining)
    if (s.raining && this.rainLayer.length === 0) this.makeRain()
  }

  makeRain() {
    for (let i = 0; i < 70; i++) {
      const l = this.add.rectangle(Phaser.Math.Between(0, WIDTH), Phaser.Math.Between(0, HEIGHT), 1.5, 10, 0xdff1ff, 0.55)
      this.rainLayer.add(l)
      this.tweens.add({ targets: l, y: `+=${HEIGHT}`, duration: Phaser.Math.Between(500, 900), repeat: -1, delay: Phaser.Math.Between(0, 800) })
    }
  }

  async toShop() {
    const before = this.state.energy
    await this.farm.travel()
    if (this.state.energy === before) { toast(this, WIDTH / 2, 320, t('farm.tooTired'), '#ffd6d6'); return }
    this.scene.start('Shop')
  }

  /**
   * Keep the farm.
   *
   * Online the server owns it, so the save is its signed envelope, not the copy
   * this browser happens to be showing. Writing our own view produced something
   * that looked like a save and resumed nothing — LOAD GAME simply started a new
   * farm with the old name.
   */
  async keep() {
    // Online, saving also switches the envelope to keeping itself up to date.
    // The server refuses an envelope older than the farm's newest revision, so a
    // save taken once and then played past would be refused on load — which is
    // no save at all.
    const ok = this.farm.online ? await this.farm.keepSaved() : save(this.state)
    toast(this, WIDTH - 78, HEIGHT - 84, ok ? t('farm.saved') : t('farm.saveFailed'), ok ? '#ffffff' : '#ffd6d6')
  }

  async nextDay() {
    // A second press while the first is still in flight carries the same
    // revision and is refused as stale — which is correct on the server and
    // reads as a false alarm here, a refusal toast landing next to the new
    // morning. Ignore the press instead.
    if (this.farm.busy) return
    const report = await this.farm.endDay()
    if (report?.refused) {
      sfx(this, 'refused')
      toast(this, WIDTH / 2, 330, t('farm.nothingToDo'), '#ffd6d6')
      return
    }
    if (report.finished) { this.scene.start('End'); return }

    // The night's own sounds, loudest thing first, so a night with weather and
    // pests does not play four cues on top of each other.
    sfx(this, 'new-morning')
    if (report.rain) sfx(this, 'rain-overnight', { volume: 0.7 })
    if (report.pests) sfx(this, 'pest-appears', { volume: 0.8 })
    if (report.crafted.length) sfx(this, 'craft-finished')

    const news = []
    if (report.rain) news.push(t('news.rained'))
    for (const [id, n] of Object.entries(report.produced)) {
      if (n) news.push(t('news.laid', tx(this.data_.goods.find(g => g.id === id)?.name ?? id), n))
    }
    for (const name of report.crafted) news.push(t('news.ready', name))
    if (report.pests) news.push(t('news.bugs', report.pests))
    if (report.died) news.push(t('news.withered', report.died))
    for (const [id, n] of Object.entries(report.lost)) {
      news.push(t('news.lost', n, tx(this.data_.animals.find(a => a.id === id)?.name ?? id)))
    }
    // Crops rotting in an overfull barn is a real loss, and the night used to
    // take them without a word. The rules have reported it all along; nothing
    // read it.
    for (const [id, n] of Object.entries(report.spoiled ?? {})) {
      if (n) news.push(t('news.spoiled', n, tx(cropById(this.data_, id)?.name ?? id)))
    }
    // A farm that had nothing left was lent a seed. It shows in the status
    // panel afterwards, but the night it happened should say so.
    if (report.rescued) news.push(t('news.rescued'))
    // The board is what an endless game is driven by, so its turning over is
    // news — and it is the moment to go and look at what is wanted.
    if (report.newWeek) news.push(t('news.newWeek'))

    toast(this, WIDTH / 2, 330, news.length ? news.join('  ·  ') : t('farm.quietNight'), news.length ? '#ffe9a8' : '#ffffff')

    this.rainLayer.removeAll(true)
    this.refresh()

    // A season closing is the only scoreboard an endless game has, and until now
    // the rules produced it every twenty-eight days and nobody was ever told.
    if (report.seasonEnded) {
      const { earned, best } = report.seasonEnded
      sfx(this, 'money-received')
      banner(this, t('farm.seasonOver', money(earned)), {
        tone: earned > best ? 'green' : 'blue',
        sub: earned > best ? t('farm.seasonBest') : t('farm.seasonBeat', money(best)),
      })
    }
  }
}
