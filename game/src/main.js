import Phaser from 'phaser'
import BootScene from './scenes/BootScene.js'
import MenuScene from './scenes/MenuScene.js'
import FarmScene from './scenes/FarmScene.js'
import PlotScene from './scenes/PlotScene.js'
import ShopScene from './scenes/ShopScene.js'
import MarketScene from './scenes/MarketScene.js'
import CoopScene from './scenes/CoopScene.js'
import WorkshopScene from './scenes/WorkshopScene.js'
import EndScene from './scenes/EndScene.js'
import { setStrings } from './core/i18n.js'
import { installViewport } from './core/viewport.js'
import { createBoundary, useBoundary } from './core/fatal.js'
import { createFarm } from './core/farm.js'
import { createServerClient } from './core/server-client.js'
import { WIDTH, HEIGHT, RENDER_SCALE } from './core/size.js'

// Phaser's global is handy inside the UI kit (Geom, Display) and saves those
// helpers from importing the engine themselves.
window.Phaser = Phaser

// The original stage. Every coordinate recovered from the SWF — tiles, buttons,
// HUD panels — is in this space, so the game is built in it and scaled to fit.
// Re-exported so the scenes can keep importing them from here.
export { WIDTH, HEIGHT, RENDER_SCALE } from './core/size.js'

/**
 * Where the authoritative server is, if there is one. Left unset, the same rules
 * run in the browser and the game still works on its own.
 *
 * The slot is asked first and the build's own setting second, which is the
 * opposite of what it was. Baked in and unoverridable, a built game is bound for
 * ever to whatever address it was built with — and the address these are
 * actually served on changes every time the tunnel restarts, so the deployed
 * bundle would simply stop working with no way to point it anywhere else short
 * of building it again. It also meant the built game could not be opened against
 * a local server at all, so every suite here has only ever tested the source and
 * never the artifact.
 *
 * Setting the slot is per-browser and gives nobody anything: the server decides
 * what is true, so pointing a client at a different one only changes whose farm
 * it is playing. An empty string in the slot is a deliberate "play offline".
 */
const SERVER_URL = localStorage.getItem('simfarm.server') ?? import.meta.env?.VITE_SERVER_URL ?? ''

/**
 * What to do when the game breaks, before anything that could break runs.
 *
 * A host embedding this may take it over: set `window.SIMFARM = { onFatal }`
 * before the script loads and it is called once with { error, phase, reload };
 * return true and the built-in notice stays out of the way. `fatalUI: false`
 * turns the notice off without replacing it.
 *
 * Deliberately not a window listener. A host's own unrelated failure would
 * otherwise put a notice on screen blaming the farm.
 */
const fatal = createBoundary({
  onFatal: globalThis.SIMFARM?.onFatal ?? null,
  fatalUI: globalThis.SIMFARM?.fatalUI !== false,
})
useBoundary(fatal)
window.__simfarmFatal = fatal

// These decide what art loads and what the UI says, so they must be in hand
// before the first scene runs.
const [data, strings, hits, hitsUi] = await Promise.all([
  fetch('data/game.json').then(r => r.json()),
  fetch('data/strings.json').then(r => r.json()),
  fetch('data/interaction-map.json').then(r => r.json()),
  fetch('data/interaction-map-ui.json').then(r => r.json()),
]).catch((err) => { fatal.report(err, 'loading the game'); throw err })
setStrings(strings)


// Canvas text bakes at draw time, so the display face has to be resident before
// the first scene paints or the title screen renders in a fallback font.
// A webfont split by unicode-range only fetches the subsets the sample text
// needs, and `fonts.load(font)` samples Latin. Canvas text bakes at draw time,
// so without naming a Thai character here the Thai subset is still unloaded on
// first paint and every Thai string renders in a fallback face.
const THAI_SAMPLE = 'น้ำ'
await Promise.all([
  document.fonts.load('600 16px Mitr'),
  document.fonts.load('400 16px Mitr'),
  document.fonts.load('600 16px Mitr', THAI_SAMPLE),
  document.fonts.load('400 16px Mitr', THAI_SAMPLE),
  document.fonts.load('700 16px "Noto Sans Thai"', THAI_SAMPLE),
].map(p => p.catch(() => {})))
await document.fonts.ready

// Exposed so tools/smoke.mjs can drive a real session end to end.
window.__game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WIDTH * RENDER_SCALE,
  height: HEIGHT * RENDER_SCALE,
  backgroundColor: '#1d2b1a',
  // The canvas is sized and placed by installViewport, which also fills the
  // screen when the device is held upright. Phaser must not fight it.
  scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER, expandParent: false },
  render: { antialias: true, roundPixels: false },
  callbacks: {
    preBoot: (game) => {
      game.registry.set('data', data)
      game.registry.set('hits', hits)
      game.registry.set('hitsUi', hitsUi)
      // Where the farm actually lives. With a server configured the browser
      // only ever draws what the server agrees to; without one the same rules
      // run here so the game still works on its own.
      game.registry.set('serverUrl', SERVER_URL)
      game.registry.set('makeServer', () => (SERVER_URL ? createServerClient(SERVER_URL) : null))
      game.registry.set('createFarm', createFarm)
    },
  },
  // Guarded one by one rather than by a window listener, so anything caught
  // here really did come from the game.
  scene: [BootScene, MenuScene, FarmScene, PlotScene, ShopScene, MarketScene, CoopScene, WorkshopScene, EndScene]
    .map(s => fatal.guardScene(s)),
})

// The pre-bundle orientation script ran before the game existed. Re-run it once
// the scale manager is up, or it stays fitted to the pre-rotation box.
installViewport(window.__game)

// Exposed for tools/e2e.mjs so a test can ask the game what it expects to happen.
window.__game.__rules = await import('./core/rules.js')
window.__game.__progression = await import('./core/progression.js')

