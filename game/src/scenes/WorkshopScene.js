import Phaser from 'phaser'
import { C, art, button, fitCamera, label, money, panel, title, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { enter, stagger } from '../ui/fx.js'
import { byId, cropById, cropCount, goodCount, recipeReady, totalCrops } from '../core/rules.js'
import { backdrop } from '../ui/stage.js'
import { makeHud } from '../ui/hud.js'
import { goodIcon, supplyIcon } from '../ui/goods.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, tx } from '../core/i18n.js'
import { bindKeys } from '../core/keys.js'
import { playMusic, sfx } from '../core/audio.js'
import { nowShowing, whileHere } from '../ui/while-here.js'

const PER_PAGE = 4

/** Turn what the farm grew into something worth more. Recipes come from the data file. */
export default class WorkshopScene extends Phaser.Scene {
  constructor() { super('Workshop') }

  /** Always the farm as the authority last agreed it stands. */
  get state() { return this.farm.state }

  create() {
    fitCamera(this)
    nowShowing(this)
    enter(this)
    playMusic(this, 'farm')
    setBackdrop('shop_animal')
    this.data_ = this.registry.get('data')
    this.farm = this.registry.get('farm')
    this.page = 0

    backdrop(this, 'scene:shop_animal')
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x2a1a0e, 0.55).setOrigin(0)
    this.hud = makeHud(this, 60, { day: true, dayAt: { x: 392, y: 8 } })

    title(this, WIDTH / 2, 60, t('work.title'), { size: 18 })
    this.curing = label(this, WIDTH / 2, 80, '', { size: 10, color: '#f5e6c8', origin: [0.5, 0.5] }).setStroke('#00000099', 3)

    panel(this, 14, 94, WIDTH - 28, 292, { alpha: 0.97 })
    this.parts = []
    button(this, 82, HEIGHT - 24, 140, 30, t('plot.backFarm'), () => this.scene.start('Farm'), { tone: 'wood', size: 12 })
    this.render()

    bindKeys(this, { Escape: () => this.scene.start('Farm') })

    // Opening a screen is the moment to make sure what is drawn is what the
    // authority actually holds.
    if (this.farm.online) whileHere(this, this.farm, () => this.render())
  }

  /** Describe a recipe's inputs the way a cook would read them. */
  needText(recipe) {
    return recipe.inputs.map(inp => {
      if (inp.anyCrop != null) return t('work.anyCrops', inp.anyCrop, totalCrops(this.state))
      if (inp.crop) return `${inp.amount} ${tx(cropById(this.data_, inp.crop).name)} (${cropCount(this.state, inp.crop)})`
      return `${inp.amount} ${tx(byId(this.data_.goods, inp.good).name)} (${goodCount(this.state, inp.good)})`
    }).join('  +  ')
  }

  outText(recipe) {
    const o = recipe.output
    if (o.supply) return `${o.amount} ${tx(byId(this.data_.supplies, o.supply).name)}`
    const g = byId(this.data_.goods, o.good)
    return t('work.sellsFor', `${o.amount} ${tx(g.name)}`, money(g.price * o.amount))
  }

  /**
   * What a recipe looks like at a glance. Three recipes that all make a sack of
   * something are indistinguishable by their output, so anything with a single
   * crop ingredient is shown by that crop instead.
   */
  recipeIcon(recipe, x, y) {
    const from = recipe.inputs.find(i => i.crop)
    if (from) {
      const crop = cropById(this.data_, from.crop)
      const im = art(this, x, y, `crop:${crop.art}:5`, 0.3)
      if (crop.tint) im.setTint(Phaser.Display.Color.HexStringToColor(crop.tint).color)
      return [im]
    }
    const out = recipe.output
    if (out.good) return goodIcon(this, x, y, byId(this.data_.goods, out.good), 0.62)
    return [supplyIcon(this, x, y, out.supply, 34)]
  }

  render() {
    // Only a new page settles in; re-rendering after a craft should not replay
    // the list.
    const settle = String(this.page) !== this.shown_
    this.shown_ = String(this.page)
    const rows_ = []
    this.parts.forEach(o => o.destroy())
    this.parts = []
    const s = this.state
    this.hud.update(s, this.data_.rules, this.data_)
    this.curing.setText(s.pending.length
      ? t('work.curingNow', s.pending.map(j => `${tx(byId(this.data_.recipes, j.id).name)} (${j.daysLeft}d)`).join('  ·  '))
      : t('work.nothingCuring'))

    const recipes = this.data_.recipes
    const total = Math.ceil(recipes.length / PER_PAGE)
    this.page = Math.min(this.page, total - 1)

    recipes.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE).forEach((recipe, i) => {
      const x = 28, y = 108 + i * 58
      const ready = recipeReady(s, this.data_, recipe)
      const g = this.add.graphics()
      g.fillStyle(ready ? C.green : C.rim, ready ? 1 : 0.75).fillRoundedRect(x - 2, y - 2, WIDTH - 52, 56, 10)
      g.fillStyle(0xe8d9b5, 1).fillRoundedRect(x, y, WIDTH - 56, 52, 8)
      g.fillStyle(ready ? 0xfffaf0 : 0xefe6d2, 1).fillRoundedRect(x, y, WIDTH - 56, 48, 8)
      const row_ = [g, ...this.recipeIcon(recipe, x + 28, y + 26)]
      this.parts.push(...row_)

      const btn = button(this, WIDTH - 82, y + 26, 108, 28, recipe.days ? t('work.makeDays', recipe.days) : t('work.make'), async () => {
        const before = JSON.stringify(this.state.barn)
        await this.farm.craft({ recipeId: recipe.id })
        if (JSON.stringify(this.state.barn) !== before) {
          sfx(this, 'craft-started')
          toast(this, WIDTH - 84, y + 6, recipe.days ? t('work.curingFor', recipe.days) : t('work.done'), '#ffe9a8')
        } else toast(this, WIDTH - 84, y + 6, t('work.notEnough'), '#ffd6d6')
        this.render()
      }, { tone: ready ? 'green' : 'red', size: 11 })
      btn.setEnabled(ready)

      const written = [
        label(this, x + 54, y + 13, tx(recipe.name), { size: 14, display: true }),
        label(this, x + 54, y + 29, t('work.needs', this.needText(recipe)), { size: 9, color: C.inkSoft }).setWordWrapWidth(310),
        label(this, x + 54, y + 43, t('work.makes', this.outText(recipe)), { size: 9, color: '#2d5a1e' }).setWordWrapWidth(310),
        label(this, WIDTH - 140, y + 12, t('work.cost', recipe.energy, recipe.days ? t('work.cureDays', recipe.days) : t('work.atOnce')),
          { size: 9, color: C.inkSoft, origin: [1, 0.5] }),
        btn,
      ]
      this.parts.push(...written)
      rows_.push([...row_, ...written])
    })

    if (settle) stagger(this, rows_)

    // The pager sits inside the panel; on the plate it straddled two colours.
    if (total > 1) {
      this.parts.push(
        button(this, 252, 358, 50, 24, '◀', () => { this.page = (this.page - 1 + total) % total; this.render() }, { tone: 'wood', size: 12 }),
        button(this, 348, 358, 50, 24, '▶', () => { this.page = (this.page + 1) % total; this.render() }, { tone: 'wood', size: 12 }),
        label(this, 300, 358, `${this.page + 1} / ${total}`, { size: 11, display: true, color: C.inkSoft, origin: [0.5, 0.5] }))
    }
  }
}
