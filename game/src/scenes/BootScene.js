import Phaser from 'phaser'
import { audioManifest, installAudio } from '../core/audio.js'
import { C, fitCamera, label, panel } from '../ui/kit.js'
import { WIDTH, HEIGHT, RENDER_SCALE } from '../main.js'

/**
 * Queues exactly the art the data file asks for. Nothing here names a crop —
 * adding one to data/game.json is enough to get its art loaded.
 */
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot') }

  preload() {
    fitCamera(this)
    panel(this, WIDTH / 2 - 150, HEIGHT / 2 - 34, 300, 68)
    label(this, WIDTH / 2, HEIGHT / 2 - 12, 'SIM FARM', { size: 22, bold: true, origin: [0.5, 0.5] })
    const pct = label(this, WIDTH / 2, HEIGHT / 2 + 14, '0%', { size: 13, color: C.inkSoft, origin: [0.5, 0.5] })
    this.load.on('progress', (v) => pct.setText(`${Math.round(v * 100)}%`))

    // A single unreadable file must not strand the player on this panel.
    this.failed = []
    this.load.on('loaderror', (file) => this.failed.push(file.key))

    const data = this.registry.get('data')
    installAudio(data)
    // The eight original crops are SWF vectors; crops added since are drawn as
    // PNGs, already cut to the same box the vectors render into. Either way the
    // texture key is the same, so nothing downstream knows the difference.
    const seenArt = new Set()
    for (const c of data.crops) {
      if (seenArt.has(c.art)) continue
      seenArt.add(c.art)
      for (const s of [1, 2, 3, 4, 5, 6]) {
        if (c.artFormat === 'png') this.load.image(`crop:${c.art}:${s}`, `assets/crops/${c.art}/${s}.png`)
        else this.load.svg(`crop:${c.art}:${s}`, `assets/crops/${c.art}/${s}.svg`, { scale: 1.6 * RENDER_SCALE })
      }
    }
    // Props and tool icons that have been redrawn take their own art; the rest
    // are still the frames lifted out of the SWF, one at a time as they are
    // replaced. Named here rather than guessed at, so a missing file is a
    // missing file rather than a silent fallback to somebody else's drawing.
    const DRAWN = { pest: 'prop-pest', rain: 'prop-rain', soil: 'prop-soil' }
    for (const name of ['pest', 'egg', 'chicken', 'chicken_2', 'chicken_3', 'chicken_4', 'energy_fill',
      'supply_fertilizer', 'supply_pesticide', 'supply_feed']) {
      if (DRAWN[name]) this.load.image(`art:${name}`, `assets/goods/${DRAWN[name]}.png`)
      else this.load.svg(`art:${name}`, `assets/art/${name}.svg`, { scale: 1.6 * RENDER_SCALE })
    }
    for (const t of data.tools) this.load.image(`art:tool_${t.id}`, `assets/goods/tool-${t.id}.png`)
    // Goods that have real art declare it; the rest are drawn by the UI.
    for (const g of data.goods) if (g.image) this.load.image(`good:${g.id}`, `assets/goods/${g.image}.png`)
    // Only the chicken came out of the SWF; the rest of the livestock was drawn
    // to match it and lives alongside the product art.
    for (const a of data.animals) if (a.image) this.load.image(`animal:${a.id}`, `assets/goods/${a.image}.png`)
    for (const sp of data.supplies) if (sp.image) this.load.image(`supply:${sp.id}`, `assets/goods/${sp.image}.png`)
    // Scene plates. A frame that has been redrawn ships as a PNG at the same
    // 600x420 layout as the plate it replaces, so no hotspot or click moves.
    const REDRAWN = new Set(['farm', 'plot1', 'plot2', 'plot3', 'plot4'])
    for (const s of ['menu', 'farm', 'plot1', 'plot2', 'plot3', 'plot4', 'coop', 'village', 'shop', 'shop_animal']) {
      if (REDRAWN.has(s)) this.load.image(`scene:${s}`, `assets/scenes/${s}.png`)
      else this.load.svg(`scene:${s}`, `assets/scenes/${s}.svg`, { width: WIDTH * RENDER_SCALE, height: HEIGHT * RENDER_SCALE })
    }
    // Every cue the data file names, and nothing else.
    for (const [key, path] of audioManifest(data)) this.load.audio(key, path)
  }

  create() {
    if (this.failed.length) console.warn(`[boot] ${this.failed.length} asset(s) failed:`, this.failed)
    this.scene.start('Menu')
  }
}
