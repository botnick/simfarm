import Phaser from 'phaser'
import { C, button, fitCamera, label, money, panel, title } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { enter } from '../ui/fx.js'
import { backdrop } from '../ui/stage.js'
import { clear } from '../core/save.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t } from '../core/i18n.js'

/** Day 365. The year is over — count what the farm made of it. */
export default class EndScene extends Phaser.Scene {
  constructor() { super('End') }

  create() {
    fitCamera(this)
    enter(this)
    setBackdrop('menu')
    // The farm is the authority on what was earned. The registry copy is only
    // what the game started with, which online never changes.
    const s = this.registry.get('farm')?.state ?? this.registry.get('state')
    const data = this.registry.get('data')
    backdrop(this, 'scene:menu')
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x0d1b2a, 0.62).setOrigin(0)

    title(this, WIDTH / 2, 52, t('end.title'), { size: 30 })
    label(this, WIDTH / 2, 80, s.name ? t('end.farmOf', s.name) : t('end.yourFarm'),
      { size: 13, color: '#e8f5d8', origin: [0.5, 0.5] }).setStroke('#00000088', 3)

    panel(this, WIDTH / 2 - 170, 102, 340, 176)
    const rows = [
      [t('end.money'), `$ ${money(s.money)}`],
      [t('end.earned'), `$ ${money(s.earned)}`],
      [t('end.animals'), `${Object.values(s.animals).reduce((a, b) => a + b, 0)}`],
      [t('end.goods'), `${Object.values(s.barn.goods).reduce((a, b) => a + b, 0)}`],
    ]
    rows.forEach(([k, v], i) => {
      label(this, WIDTH / 2 - 148, 130 + i * 34, k, { size: 12, color: C.inkSoft })
      label(this, WIDTH / 2 + 148, 130 + i * 34, v, { size: 15, display: true, origin: [1, 0.5] })
    })

    const grade = s.money >= 100000 ? t('end.gradeA') : s.money >= 40000 ? t('end.gradeB')
      : s.money >= 10000 ? t('end.gradeC') : t('end.gradeD')
    title(this, WIDTH / 2, 296, grade, { size: 15, color: '#ffe27a' })

    button(this, WIDTH / 2, 344, 190, 36, t('end.playAgain'), () => { clear(); this.scene.start('Menu') }, { tone: 'gold', size: 15 })
  }
}
