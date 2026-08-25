import Phaser from 'phaser'
import { C, art, button, fitCamera, label, panel, title, toast } from '../ui/kit.js'
import { WIDTH, HEIGHT } from '../main.js'
import { banner, enter } from '../ui/fx.js'
import { playMusic } from '../core/audio.js'
import { newGame, reconcile } from '../core/rules.js'
import { fingerprint } from '../core/data-version.js'
import { hasSave, load, loadSealed } from '../core/save.js'
import { setBackdrop } from '../ui/backdrop.js'
import { t, nextLang, setLang } from '../core/i18n.js'

/** Title screen on the original cover art: name your farm, then start. */
// The same names the HUD uses, so a refusal reads the same wherever it lands.
const REFUSALS = {
  'slow down': 'refused.tooFast',
  'no session': 'refused.session',
  'session expired': 'refused.session',
  'offline': 'refused.offline',
  'out of date': 'refused.stale',
  'reward': 'refused.reward',
  'ruleMismatch': 'refused.ruleMismatch',
}

export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu') }

  create() {
    // Phaser keeps one instance of a scene and shows it again, so everything
    // this screen remembered last time is still here. The flag that stops a
    // double tap opening two farms was left set by the successful one — so
    // after a season ended and the player pressed PLAY AGAIN, NEW GAME did
    // nothing at all, for ever. The game became unstartable by finishing it.
    this.starting = false
    // Which attempt is the current one. Anything still waiting on an answer
    // from a menu that has since been left or restarted must not act on it.
    this.attempt = (this.attempt ?? 0) + 1
    // Leaving counts as much as restarting. The buttons are locked while a farm
    // opens, but nothing stops something else stopping this scene, and a result
    // arriving after that would start a farm behind whatever replaced it.
    this.events.once('shutdown', () => { this.attempt = (this.attempt ?? 0) + 1 })
    fitCamera(this)
    enter(this)
    playMusic(this, 'farm')
    setBackdrop('menu')
    const data = this.registry.get('data')
    this.farmName = ''

    art(this, 0, 0, 'scene:menu').setOrigin(0).setDisplaySize(WIDTH, HEIGHT)
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x0d2416, 0.55).setOrigin(0)

    title(this, WIDTH / 2, 62, data.meta.title, { size: 44 })
    // The game no longer ends after a year, so it no longer says it does. The
    // capped-season wording is kept for a host that sets an end day.
    label(this, WIDTH / 2, 94, t(data.rules.endDay ? 'menu.tagline' : 'menu.taglineEndless'),
      { size: 12, color: '#eaf6d8', origin: [0.5, 0.5] })
      .setStroke('#00000088', 3)

    panel(this, WIDTH / 2 - 190, 118, 380, 196)
    label(this, WIDTH / 2 - 172, 142, t('menu.farmName'), { size: 11, display: true, color: C.inkSoft })
    this.add.rectangle(WIDTH / 2, 164, 344, 28, 0xffffff).setStrokeStyle(1.5, C.panelEdge)
      .setInteractive({ useHandCursor: true }).on('pointerup', () => this.focusName())
    this.nameText = label(this, WIDTH / 2 - 164, 164, t('menu.typeHere'), { size: 13, color: C.inkSoft })

    label(this, WIDTH / 2 - 172, 196, t(data.rules.endDay ? 'menu.yearAhead' : 'menu.whatYouGet'), { size: 11, display: true, color: C.inkSoft })
    label(this, WIDTH / 2 - 172, 224,
      data.rules.endDay
        ? t('menu.summary', data.crops.length, data.recipes.length, data.rules.plots, data.rules.endDay)
        : t('menu.summaryEndless', data.crops.length, data.recipes.length, data.rules.plots),
      { size: 11, color: C.ink })

    const newBtn = button(this, WIDTH / 2 - 92, 284, 170, 34, t('menu.newGame'), () => this.begin(newGame(data, { name: this.farmName })), { size: 14 })
    const loadBtn = button(this, WIDTH / 2 + 92, 284, 170, 34, t('menu.loadGame'), () => {
      // A sealed save belongs to the server and is handed back untouched; a
      // plain one is a farm this browser can play by itself.
      const sealed = loadSealed()
      if (sealed) return this.begin(null, sealed)
      const s = load()
      // A farm saved before somebody edited the game's data outlives that edit,
      // and a plot growing a crop the game no longer has takes the night down
      // with it every time the day ends. Bring the save back into agreement
      // with the data first, and say what that cost.
      if (s) {
        const lost = reconcile(s, data)
        const gone = lost.crops.length + lost.animals.length + lost.goods.length
          + lost.recipes.length + lost.plots + lost.orders
        // Queued after the farm has started, because starting one clears the
        // queue — a new farm must not inherit the last one's congratulations.
        this.begin(s)
        if (gone) banner(this, t('menu.saveChanged'), { tone: 'blue', sub: t('menu.saveChangedSub') })
      }
      // Nothing openable: the button is disabled in that case, so reaching here
      // would mean the slot changed under us.
    }, { tone: 'blue', size: 14 })
    // Only offer LOAD when the slot holds something this session can actually
    // open: a sealed save needs the server that sealed it, and a plain one is
    // a farm only the browser plays.
    // Online only a sealed save can be opened — the server will not take an
    // unsigned farm from a browser, and offering LOAD for one meant the button
    // silently started a new game. Offline it is the other way round: there is
    // nobody to open a sealed envelope.
    const online = !!this.registry.get('serverUrl')
    const canLoad = hasSave() && (online ? !!loadSealed() : !!load())
    loadBtn.setEnabled(canLoad)

    // Locked together while a farm is being opened, and each put back the way it
    // was rather than simply switched on — LOAD is not always meant to be.
    this.lockButtons = () => { newBtn.setEnabled(false); loadBtn.setEnabled(false); this.alsoLock?.setEnabled(false) }
    this.unlockButtons = () => { newBtn.setEnabled(true); loadBtn.setEnabled(canLoad); this.alsoLock?.setEnabled(true) }

    // Language toggle: the menu has no HUD to carry it. It restarts the scene,
    // which is the last thing that should happen while a farm is being opened.
    const langBtn = button(this, 44, 26, 60, 24, t('lang.name'), () => { setLang(nextLang()); this.scene.restart() }, { tone: 'wood', size: 11 })
    this.alsoLock = langBtn

  }

  /** Name entry rides on a hidden DOM input so mobile keyboards work. */
  focusName() {
    let el = document.getElementById('farmname')
    if (!el) {
      el = document.createElement('input')
      el.id = 'farmname'; el.maxLength = 18
      el.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:0;top:0'
      document.body.appendChild(el)
      el.addEventListener('input', () => {
        this.farmName = el.value
        this.nameText.setText(el.value || t('menu.typeHere')).setColor(el.value ? C.ink : C.inkSoft)
      })
    }
    el.focus()
  }

  /**
   * Start playing. With a server configured the farm lives there and this only
   * ever mirrors it; without one the same rules run here.
   */
  async begin(state, sealed = null) {
    // One farm at a time. Opening one is a network round trip, and both buttons
    // are one tap away from being two: a double tap asked the server for two
    // sessions, left both alive, and handed the game to whichever answer came
    // back last. Resuming the same sealed save twice was worse — the second
    // session evicts the first, and the browser could be left holding the one
    // that was evicted.
    if (this.starting) return
    this.starting = true
    this.lockButtons?.()
    // Everything below can wait on the network, and this screen can be left or
    // restarted while it does. An answer that arrives for a menu nobody is
    // looking at any more must not start a farm behind whatever replaced it.
    const attempt = this.attempt
    const stale = () => this.attempt !== attempt || !this.scene.isActive()
    // Opening a server client, building a farm and starting the next scene all
    // sit outside the network call and can all throw. Any of them throwing used
    // to leave the flag set and both buttons off, which is the same dead menu by
    // another route.
    try {
      await this.open(state, sealed, stale)
    } catch (err) {
      this.starting = false
      if (this.scene.isActive()) this.unlockButtons?.()
      throw err
    }
  }

  /** The farm-opening itself, wrapped by `begin` so nothing can strand the menu. */
  async open(state, sealed, stale) {
    const data = this.registry.get('data')

    // A farm starts with none of the previous farm's history. These live on the
    // registry so they survive changing screen, which also means they survive
    // starting a new game — and a second farm would then be silently refused
    // every congratulation the first one had already had.
    this.registry.set('announcedMilestones', new Set())
    this.registry.set('owedMilestones', new Set())
    this.registry.set('pendingBanners', [])
    this.registry.set('milestones', null)
    const server = this.registry.get('makeServer')()
    const createFarm = this.registry.get('createFarm')

    // A refusal the server sends back without a farm attached — rate limited,
    // session taken over, connection dropped — used to be silence, and a game
    // that ignores a click without saying why reads as broken.
    const onRefused = (reason) => {
      this.registry.set('refusal', { reason, at: this.time.now })
      // Every other screen carries a HUD that shows these; the menu does not.
      if (this.scene.isActive()) toast(this, WIDTH / 2, 200, t(REFUSALS[reason] ?? 'refused.other'), '#ffd6d6')
    }

    // Every way out of here that is not a farm has to give the buttons back, or
    // a player who was refused once is left looking at a menu they cannot use.
    const giveUp = (reason) => {
      this.starting = false
      if (this.scene.isActive()) this.unlockButtons?.()
      onRefused(reason)
    }

    if (server) {
      // Connecting can fail, and it used to fail into the worst possible shape:
      // an unhandled rejection left the player looking at the menu with no
      // explanation, and a refusal without a farm attached still built an online
      // farm with no session, which then explained itself one click later. Both
      // now stop here and say why.
      let started
      try {
        // A sealed save is the server's own; handing it back is what resumes the
        // farm rather than starting a new one with the old name.
        started = sealed
          ? await server.start({ save: sealed.save, signature: sealed.signature })
          : await server.start({ name: state?.name })
      } catch {
        giveUp('offline')
        return
      }
      if (stale()) return
      if (!started?.session || !started?.state) {
        giveUp(started?.error ?? 'offline')
        return
      }
      // Both sides load their own copy of the rule book — the server to decide
      // with, this to draw with — and a host can deploy one without the other.
      // The server still decides, so nothing is exploitable; the game would
      // simply show prices and unlock levels it does not agree with, which is a
      // worse thing to hand a player than an error.
      if (started.dataVersion && started.dataVersion !== fingerprint(data)) {
        giveUp('ruleMismatch')
        return
      }
      state = started.state
      const farm = createFarm({ data, state, server, onRefused, onMilestones: (m) => this.registry.set('milestones', m) })
      farm.adopt(state, started.revision ?? 0)
      // A player resuming a sealed save has already asked for their farm to be
      // kept; making them press SAVE again after every reload would lose the
      // next session's play to the first crash.
      if (sealed) farm.keepSaved({ seal: false })
      this.registry.set('farm', farm)
    } else {
      // Offline there is nobody to open a sealed save, so it is not offered:
      // LOAD GAME is only enabled when the slot holds something this browser
      // can actually play.
      if (!state) { giveUp('offline'); return }
      this.registry.set('farm', createFarm({ data, state, onMilestones: (m) => this.registry.set('milestones', m) }))
    }
    if (stale()) return
    // Kept for anything still reading the raw state directly.
    this.registry.set('state', state)
    this.scene.start('Farm')
  }
}
