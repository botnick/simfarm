import Phaser from 'phaser'
import { C, art, button, fitCamera, label, money, panel, title, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { enter, pop, ripple } from '../ui/fx.js'
import { byId, canApply, cropById, cropCount, toolById } from '../core/rules.js'
import { backdrop, centreOf, diamondZone, regionByRole, regions } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { touchPad } from '../core/device.js'
import { bindKeys } from '../core/keys.js'
import { playMusic, sfx, toolSfx } from '../core/audio.js'
import { nowShowing, whileHere } from '../ui/while-here.js'
import { owned } from '../core/fatal.js'

// Fields 1-2 and 3-4 use two different soil layouts in the original art.
const FRAME_OF_PLOT = [20, 25, 30, 35]
const SCENE_OF_PLOT = ['plot1', 'plot2', 'plot3', 'plot4']
// The plate already draws the tool bar, so the game only adds hit zones and a
// selection ring. These centres were measured off the plate, not guessed.
const TOOL_X0 = 169.75, TOOL_DX = 69.75, TOOL_Y = 368
const HOME = { x: 547, y: 364 }, PLANT = { x: 45, y: 378 }

// What colour a tool's ring is. A tool the data file adds without one still
// works; it simply rings white.
const TOOL_COLOUR = { water: 0x63b0f0, fertilize: 0xf5b301, spray: 0x9ad14b, clear: 0xd6a06a, harvest: 0xc8f5a8 }

/** One field of twelve isometric tiles, played on the original artwork. */
export default class PlotScene extends Phaser.Scene {
  constructor() { super('Plot') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }
  init({ plotIndex = 0 }) { this.plotIndex = plotIndex }

  create() {
    fitCamera(this)
    nowShowing(this)
    enter(this)
    playMusic(this, 'farm')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')
    this.tool = 'water'

    backdrop(this, `scene:${SCENE_OF_PLOT[this.plotIndex]}`)
    setBackdrop(SCENE_OF_PLOT[this.plotIndex])
    this.hits = regions(this, FRAME_OF_PLOT[this.plotIndex])
    this.hud = makeHud(this, FRAME_OF_PLOT[this.plotIndex])

    this.buildTiles()
    this.buildTools()
    this.buildSideActions()
    this.bindShortcuts()
    this.refresh()

    // Opening a screen is the moment to make sure what is drawn is what the
    // authority actually holds.
    if (this.farm.online) whileHere(this, this.farm, () => this.refresh())
    // Leaving by any route — the home button, Escape, the game ending — has to
    // put the pointer back, or the watering can follows the player to the shop.
    this.events.once('shutdown', () => this.dropTool())
  }

  bindShortcuts() {
    const keys = {
      Escape: () => this.scene.start('Farm'),
      w: () => this.waterAll.enabled && this.waterAll.objects[2].emit('pointerup'),
      p: () => this.pickAll.enabled && this.pickAll.objects[2].emit('pointerup'),
      c: () => this.clearAll.enabled && this.clearAll.objects[2].emit('pointerup'),
      s: () => this.openSeedPicker(),
    }
    // Tools take the number keys in the order the data lists them.
    this.data_.tools.forEach((tool, i) => { keys[String(i + 1)] = () => { this.tool = tool.id; this.refresh() } })
    bindKeys(this, keys)
  }

  /* ---------------------------------------------------------------- tiles */

  buildTiles() {
    this.tiles = []
    for (let i = 0; i < this.data_.rules.tilesPerPlot; i++) {
      const r = regionByRole(this.hits, `tile:${i + 1}`)
      if (!r) { this.tiles.push(null); continue }
      const c = centreOf(r)
      // Plants stand on the tile, so they are drawn from the foot up.
      // A freshly sown tile is two small brown seeds on brown soil, which reads
      // as "nothing happened". This patch of turned earth sits under them so a
      // sown field is obviously different from a bare one.
      const sown = this.add.ellipse(c.x, c.y, r.w * 0.5, r.h * 0.5, 0x6b4a2a, 0.5).setVisible(false)
      const crop = art(this, c.x, c.y + 10, 'art:pest').setOrigin(0.5, 1).setVisible(false)
      const pest = art(this, c.x + 20, c.y - 22, 'art:pest', 0.55).setVisible(false)
      const wet = this.add.ellipse(c.x, c.y, r.w * 0.66, r.h * 0.66, 0x1f4f7a, 0.22).setVisible(false)
      const ring = this.add.graphics().setVisible(false)
      ring.lineStyle(2.5, 0xffffff, 0.95)
      ring.beginPath()
      ring.moveTo(c.x, c.y - r.h / 2); ring.lineTo(c.x + r.w / 2, c.y)
      ring.lineTo(c.x, c.y + r.h / 2); ring.lineTo(c.x - r.w / 2, c.y)
      ring.closePath(); ring.strokePath()
      const badge = label(this, c.x, c.y - 44, '', { size: 9, bold: true, color: '#ffffff', origin: [0.5, 0.5] })
      badge.setStroke('#000000aa', 3)

      diamondZone(this, r, () => this.useTool(i))
        .on('pointerover', () => { this.hover = i; this.refresh() })
        .on('pointerout', () => { if (this.hover === i) this.hover = -1; this.refresh() })

      // Depth so nearer rows overlap the ones behind them, as in the original.
      const depth = 100 + Math.round(c.y)
      crop.setDepth(depth); pest.setDepth(depth + 1); badge.setDepth(depth + 2)
      wet.setDepth(50 + Math.round(c.y)); ring.setDepth(60 + Math.round(c.y))
      sown.setDepth(55 + Math.round(c.y))

      this.tiles.push({ crop, pest, wet, ring, badge, sown, c })
    }
    this.hover = -1
  }

  /* ---------------------------------------------------------------- tools */

  buildTools() {
    this.toolBtns = this.data_.tools.map((tool, i) => {
      const x = TOOL_X0 + i * TOOL_DX
      const ring = this.add.graphics().setDepth(300)
      const dim = this.add.graphics().setDepth(299)
      const pad = touchPad()
      this.add.zone(x - 22 - pad, TOOL_Y - 22 - pad, 44 + pad * 2, 44 + pad * 2).setOrigin(0).setInteractive({ useHandCursor: true })
        .on('pointerup', () => { this.tool = tool.id; this.refresh() })
      return { tool, ring, dim, x }
    })
    this.toolName = label(this, 140, 400, '', { size: 10, bold: true, color: '#ffffff' }).setDepth(302)
    this.toolName.setStroke('#000000aa', 3)

    this.add.zone(HOME.x - 30, HOME.y - 34, 60, 68).setOrigin(0).setInteractive({ useHandCursor: true })
      .on('pointerup', () => this.scene.start('Farm'))
  }

  /* --------------------------------------------------------- side actions */

  buildSideActions() {
    const pad = touchPad()
    this.add.zone(PLANT.x - 26 - pad, PLANT.y - 26 - pad, 52 + pad * 2, 52 + pad * 2).setOrigin(0).setInteractive({ useHandCursor: true })
      .on('pointerup', () => this.openSeedPicker())
    this.plantHint = label(this, PLANT.x + 4, PLANT.y - 34, '', { size: 9, bold: true, color: '#ffe27a', origin: [0.5, 0.5] })
      .setDepth(302).setStroke('#000000cc', 4)

    // The whole-field shortcuts are ours: 48 tiles is a lot of clicking. Three
    // of them now, laid out as one row between the wallet on the left and the
    // energy heart on the right — there is no room for a fourth.
    // The plants are drawn from the foot up and sorted by row, so a tall crop
    // in the back row reaches into this strip. The whole-field controls and the
    // note beside them sit above every plant, or a chilli field hides its own
    // PICK ALL button.
    const TOP_BAR = 700
    this.waterAll = button(this, 352, 14, 96, 21, t('plot.waterAll'), async () => {
      const before = this.wateredCount()
      await this.farm.waterPlot({ plot: this.plotIndex })
    // The player can leave while this is in flight. What the server accepted
    // stands, but this screen is gone, and drawing on it is at best a lie about
    // somewhere the player is not looking.
    if (!this.scene.isActive()) return
      const n = this.wateredCount() - before
      toast(this, 352, 38, n ? t('plot.watered', n) : t('plot.nothingToWater'), n ? '#dff1ff' : '#ffd6d6')
      if (n) this.sfx('pop')
      this.refresh()
    }, { tone: 'blue', size: 10 })
    this.pickAll = button(this, 456, 14, 96, 21, t('plot.pickAll'), async () => {
      const before = this.barnCount()
      await this.farm.harvestPlot({ plot: this.plotIndex })
    // The player can leave while this is in flight. What the server accepted
    // stands, but this screen is gone, and drawing on it is at best a lie about
    // somewhere the player is not looking.
    if (!this.scene.isActive()) return
      const n = this.barnCount() - before
      toast(this, 456, 38, n ? t('plot.picked', n) : t('plot.nothingRipe'), n ? '#ffe9a8' : '#ffd6d6')
      if (n) this.sfx('chime')
      this.refresh()
    }, { tone: 'gold', size: 10 })
    // Clearing is the only way to get withered ground back, and a field cannot
    // be sown again while a single dead plant stands in it. One bad night kills
    // twelve tiles, so without this the answer is twelve clicks — or, far more
    // likely, a field abandoned because nothing explains why it will not sow.
    // Dead tiles only: `clear` on a ripe one is a legitimate choice to make
    // deliberately and a catastrophe to hand to a button.
    this.clearAll = button(this, 248, 14, 96, 21, t('plot.clearAll'), async () => {
      const before = this.deadCount()
      await this.farm.clearPlot({ plot: this.plotIndex })
    // The player can leave while this is in flight. What the server accepted
    // stands, but this screen is gone, and drawing on it is at best a lie about
    // somewhere the player is not looking.
    if (!this.scene.isActive()) return
      const n = before - this.deadCount()
      toast(this, 248, 38, n ? t('plot.cleared', n) : t('plot.nothingDead'), n ? '#d8ffd0' : '#ffd6d6')
      if (n) this.sfx('pop')
      this.refresh()
    }, { tone: 'red', size: 10 })
    this.fieldNote = label(this, 505, 42, '', { size: 10, color: '#ffffff', origin: [1, 0.5] })
      .setDepth(TOP_BAR + 1).setStroke('#000000aa', 4)
    this.waterAll.setDepth(TOP_BAR)
    this.pickAll.setDepth(TOP_BAR)
    this.clearAll.setDepth(TOP_BAR)
  }

  /* --------------------------------------------------------------- action */

  /** Counts the screen compares before and after an action, since the authority
   *  reports what happened by changing the farm rather than returning a number. */
  wateredCount() { return this.state.plots[this.plotIndex].tiles.filter(t => t.watered).length }
  deadCount() { return this.state.plots[this.plotIndex].tiles.filter(t => t.stage === this.data_.rules.stage.dead).length }
  barnCount() {
    const id = this.state.plots[this.plotIndex].cropId
    return id ? cropCount(this.state, id) : 0
  }

  async useTool(i) {
    const plot = this.state.plots[this.plotIndex]
    if (!plot.cropId) { this.openSeedPicker(); return }
    // Asked locally only to explain a refusal; the authority decides.
    if (!canApply(this.state, this.data_, this.plotIndex, i, this.tool)) { this.explain(i); return }
    const barnBefore = this.barnCount()
    // canApply above asked the local mirror, which is what the browser last
    // heard. Two quick clicks both pass it, the second is refused, and playing
    // the sound and ringing the tile anyway told the player it landed.
    const did = await this.farm.tool({ plot: this.plotIndex, tile: i, toolId: this.tool })
    if (!this.scene.isActive()) return
    if (!did) { this.refresh(); return }
    toolSfx(this, this.tool)

    // The tool lands on the tile it was aimed at. Picking punches the plant it
    // took; everything else rings the tile in the tool's own colour, which is
    // the only feedback a watered tile gives before the day turns.
    const c = this.tiles[i]?.c
    if (c) {
      const picked = this.barnCount() - barnBefore
      if (picked > 0) {
        pop(this, this.tiles[i].crop, 0.3, 260)
        toast(this, c.x, c.y - 30, `+${picked}`, '#c8f5a8')
      } else {
        ripple(this, c.x, c.y, TOOL_COLOUR[this.tool] ?? 0xffffff, 30, 70 + Math.round(c.y))
      }
    }
    this.refresh()
  }

  /** Say why a click did nothing — silence is the most annoying thing a tool can do. */
  explain(i) {
    const s = this.state
    const tile = s.plots[this.plotIndex].tiles[i]
    const tool = this.data_.tools.find(x => x.id === this.tool)
    const c = this.tiles[i].c
    let why = t('why.nothing')
    if (s.energy < tool.energy) why = t('why.tired')
    else if (tool.consumes && !(s.supplies[tool.consumes] > 0)) why = t('why.noSupply', tx(this.data_.supplies.find(x => x.id === tool.consumes).name))
    else if (this.tool === 'harvest') why = t('why.notRipe')
    else if (this.tool === 'spray') why = t('why.noBug')
    else if (this.tool === 'water') why = tile.watered ? t('why.watered') : t('why.nothingPlanted')
    else if (this.tool === 'fertilize') why = tile.fertilized ? t('why.fedToday') : t('why.nothingPlanted')
    else if (this.tool === 'clear') why = t('why.bare')
    toast(this, c.x, c.y - 20, why, '#ffd6d6')
  }

  openSeedPicker() {
    const held = Object.entries(this.state.seeds).filter(([, n]) => n > 0)
    if (this.state.plots[this.plotIndex].cropId) { toast(this, WIDTH / 2, 200, t('why.sown')); return }
    if (!held.length) { toast(this, WIDTH / 2, 200, t('why.noSeeds'), '#ffd6d6'); return }

    // Built from scene-level objects; `parts` is what closing it destroys.
    const parts = []
    const add = (...o) => { o.forEach(x => { x.setDepth?.(8000); parts.push(x) }); return o[0] }
    const close = () => parts.forEach(o => o.destroy())

    // Paged rather than stretched: twelve seeds will not fit on a 420px stage.
    const PER = 5, pages = Math.ceil(held.length / PER)
    let page = 0

    add(this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x000000, 0.6).setOrigin(0).setInteractive())
    const W = 400, H = 300, left = WIDTH / 2 - W / 2, top = HEIGHT / 2 - H / 2
    add(panel(this, left, top, W, H))
    add(title(this, WIDTH / 2, top + 24, t('plot.selectSeed'), { size: 15 }))
    add(label(this, WIDTH / 2, top + 44, t('plot.oneSeed'), { size: 10, color: C.inkSoft, origin: [0.5, 0.5] }))

    let rowParts = []
    const drawPage = () => {
      rowParts.forEach(o => o.destroy())
      rowParts = []
      held.slice(page * PER, page * PER + PER).forEach(([id, n], k) => {
        const crop = cropById(this.data_, id)
        const y = top + 68 + k * 38
        const g = this.add.graphics().setDepth(8001)
        g.fillStyle(C.rim, 0.9).fillRoundedRect(left + 12, y - 17, W - 24, 34, 9)
        g.fillStyle(0xfffaf0, 1).fillRoundedRect(left + 14, y - 15, W - 28, 30, 7)
        const zone = this.add.zone(left + 12, y - 17, W - 24, 34).setOrigin(0).setDepth(8002)
          .setInteractive({ useHandCursor: true })
        // Owned, and checked against the screen it belongs to. This is the one
        // handler in the game that is a raw zone rather than a button, so it
        // missed the wrapper every button gets — a throw here escaped the fatal
        // boundary, and the close-and-refresh could run after the field had
        // already been left.
        zone.on('pointerup', owned(async () => {
          const sown = await this.farm.plant({ plot: this.plotIndex, cropId: id })
          if (!this.scene.isActive()) return
          // A refusal leaves the picker open — closing it on the way out looked
          // exactly like sowing, and onRefused has already said why not.
          if (!sown) { this.refresh(); return }
          this.sfx('chime'); close(); this.refresh()
        }, 'choosing a seed'))
        zone.on('pointerover', () => { g.clear(); g.fillStyle(C.green, 1).fillRoundedRect(left + 12, y - 17, W - 24, 34, 9); g.fillStyle(0xfffaf0, 1).fillRoundedRect(left + 14, y - 15, W - 28, 30, 7) })
        zone.on('pointerout', () => { g.clear(); g.fillStyle(C.rim, 0.9).fillRoundedRect(left + 12, y - 17, W - 24, 34, 9); g.fillStyle(0xfffaf0, 1).fillRoundedRect(left + 14, y - 15, W - 28, 30, 7) })
        const img = art(this, left + 38, y, `crop:${crop.art}:5`, 0.28).setDepth(8003)
        if (crop.tint) img.setTint(Phaser.Display.Color.HexStringToColor(crop.tint).color)
        rowParts.push(g, zone, img,
          label(this, left + 62, y - 6, tx(crop.name), { size: 12, display: true }).setDepth(8003),
          label(this, left + 62, y + 8, t('shop.seedFacts', crop.daysPerStage, crop.harvests, money(crop.sellPrice)), { size: 9, color: C.inkSoft }).setDepth(8003),
          label(this, left + W - 26, y, `x${n}`, { size: 13, display: true, origin: [1, 0.5] }).setDepth(8003))
      })
    }
    drawPage()

    if (pages > 1) {
      const num = add(label(this, left + 68, top + H - 40, '', { size: 10, color: C.inkSoft, origin: [0.5, 0.5] }))
      const setPage = (d) => { page = (page + d + pages) % pages; drawPage(); num.setText(`${page + 1} / ${pages}`) }
      num.setText(`1 / ${pages}`)
      add(button(this, left + 40, top + H - 22, 42, 24, '\u25c0', () => setPage(-1), { tone: 'wood', size: 12 }).setDepth(8004))
      add(button(this, left + 96, top + H - 22, 42, 24, '\u25b6', () => setPage(1), { tone: 'wood', size: 12 }).setDepth(8004))
    }
    add(button(this, left + W - 66, top + H - 22, 96, 26, t('plot.cancel'), () => close(), { tone: 'red', size: 12 }).setDepth(8004))
    parts.push({ destroy: () => rowParts.forEach(o => o.destroy()) })
  }

  /**
   * The pointer becomes the tool.
   *
   * The original did this and it is most of what makes a field feel like a
   * field: you are holding a watering can, not choosing a radio button. The
   * toolbar ring says which tool is selected, but only after you look away from
   * where you are working.
   *
   * A browser refuses a cursor image over 128px and silently falls back to an
   * arrow, which is why these are their own smaller copies rather than the
   * toolbar art.
   */
  showTool() {
    const id = this.tool
    if (this.shownCursor === id) return
    this.shownCursor = id
    // The hotspot sits at the middle: these are objects being held over a tile,
    // not arrows pointing at one.
    this.input.setDefaultCursor(`url(assets/cursors/${id}.png) 22 22, pointer`)
  }

  /** Hand the arrow back, or it follows the player out of the field. */
  dropTool() {
    this.shownCursor = null
    this.input.setDefaultCursor('default')
  }

  sfx(name) { sfx(this, name) }

  /* -------------------------------------------------------------- refresh */

  refresh() {
    this.showTool()
    const s = this.state, r = this.data_.rules
    const plot = s.plots[this.plotIndex]
    const crop = plot.cropId ? cropById(this.data_, plot.cropId) : null
    this.hud.update(s, r, this.data_)

    for (const b of this.toolBtns) {
      const on = this.tool === b.tool.id
      const usable = !b.tool.consumes || s.supplies[b.tool.consumes] > 0
      b.ring.clear()
      if (on) b.ring.lineStyle(3, 0xffe27a, 1).strokeRoundedRect(b.x - 23, TOOL_Y - 23, 46, 46, 10)
      // Tools with nothing left to spend are veiled in the panel's own blue
      // rather than blacked out with a hard square.
      b.dim.clear()
      if (!usable) {
        b.dim.fillStyle(0x2a5c96, 0.62).fillRoundedRect(b.x - 21, TOOL_Y - 21, 42, 42, 9)
        b.dim.lineStyle(2, 0x1b3f68, 0.8).strokeRoundedRect(b.x - 21, TOOL_Y - 21, 42, 42, 9)
      }
    }
    // Say something about the tool actually in hand. This line used to print
    // the fertiliser and pesticide counts whatever was selected, so choosing the
    // watering can read as "Water · 0 / 0" — which looks like nothing to water.
    const active = this.data_.tools.find(x => x.id === this.tool)
    const supply = active.consumes ? byId(this.data_.supplies, active.consumes) : null
    const targets = plot.tiles.reduce((n, _, i) => n + (canApply(s, this.data_, this.plotIndex, i, this.tool) ? 1 : 0), 0)
    // The fertiliser tool and the fertiliser it spends share a name, so naming
    // both read as "Fertilizer · Fertilizer 7".
    const held = s.supplies[active.consumes] ?? 0
    this.toolName.setText(!supply ? `${tx(active.name)}   ·   ${t('plot.toolTargets', targets)}`
      : tx(supply.name) === tx(active.name) ? `${tx(active.name)}   ·   ${t('plot.toolLeft', held)}`
      : `${tx(active.name)}   ·   ${tx(supply.name)} ${held}`)

    plot.tiles.forEach((tile, i) => {
      const v = this.tiles[i]
      if (!v) return
      const planted = tile.stage > 0 && tile.stage <= r.stage.dead
      v.pest.setVisible(!!tile.pest)
      v.wet.setVisible(!!tile.watered && planted)

      if (crop && planted) {
        v.crop.setTexture(`crop:${crop.art}:${Math.min(tile.stage, r.stage.dead)}`).setVisible(true)
        // Seeds are drawn larger than the later stages so they are actually visible.
        v.crop.setScale(tile.stage === r.stage.seed ? 0.68 : 0.5)
        v.crop.setTint(tile.stage === r.stage.dead ? 0x9a8f7a
          : crop.tint ? Phaser.Display.Color.HexStringToColor(crop.tint).color : 0xffffff)
        v.sown.setVisible(tile.stage === r.stage.seed)
      } else { v.crop.setVisible(false); v.sown.setVisible(false) }

      v.badge.setText(
        !crop || !planted ? '' :
        tile.stage === r.stage.dead ? t('tile.withered') :
        tile.stage === r.stage.ripe ? t('tile.ready') : '')
      v.badge.setColor(tile.stage === r.stage.ripe ? '#ffe680' : '#ffffff')
      v.ring.setVisible(this.hover === i && canApply(s, this.data_, this.plotIndex, i, this.tool))
    })

    const ripe = plot.tiles.filter(x => x.stage === r.stage.ripe).length
    const dry = crop ? plot.tiles.filter(x => x.stage < r.stage.dead && !x.watered).length : 0
    const dead = plot.tiles.filter(x => x.stage === r.stage.dead).length
    const living = plot.tiles.filter(x => x.stage !== r.stage.dead && x.stage !== r.stage.empty).length
    // What the action costs, not merely whether there is any energy left. Every
    // tool costs one today, so asking the tool rather than assuming it is the
    // difference between this staying correct and a button that lights up and
    // does nothing the day somebody prices a tool at two.
    const affords = (id) => s.energy >= (toolById(this.data_, id)?.energy ?? 1)
    this.waterAll.setEnabled(dry > 0 && affords('water'))
    this.pickAll.setEnabled(ripe > 0 && affords('harvest'))
    this.clearAll.setEnabled(dead > 0 && affords('clear'))
    this.plantHint?.setText(crop ? '' : t('plot.sow'))
    // Withered ground is the one state that stops the field being used at all,
    // so it is what the note says while any of it is left. Clearing is only the
    // whole answer when there is nothing else alive in the field: with a crop
    // still standing, the bare patches stay unusable until it finishes, and
    // telling the player to clear before sowing would be a promise the field
    // cannot keep.
    this.fieldNote.setText(dead
      ? (living ? t('plot.deadMixed', dead) : t('plot.deadNote', dead))
      : crop
        ? `${tx(crop.name)}  ·  ${t('plot.inBarn', cropCount(s, plot.cropId))}`
        : t('plot.emptyField'))
  }
}
