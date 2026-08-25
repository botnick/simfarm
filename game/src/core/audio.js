// Sound.
//
// Every cue is named in the data file and loaded by that name, so adding one is
// a line of JSON and a file — nothing in here or in any scene holds a list.
//
// Two rules the rest of the game relies on:
//   a cue that is missing is silence, never an exception, because a half-loaded
//   asset must not be able to stop a click from working;
//   the mute is remembered, because a player who turned the music off did not
//   mean "until you reload".
const MUTE_KEY = 'simfarm.muted'

let cfg = { volume: { sfx: 0.55, music: 0.22 }, sfx: [], music: {}, toolCue: {} }
let muted = false
let current = null            // { key, sound }

export function installAudio(data) {
  // Module state outlives a Phaser.Game. A game rebuilt in the same page used to
  // start holding the dead game's bed, and every later decision about the music
  // was made about a sound belonging to a scene that no longer exists.
  current = null
  cfg = { volume: { sfx: 0.55, music: 0.22 }, sfx: [], music: {}, toolCue: {}, ...(data.audio ?? {}) }
  try { muted = localStorage.getItem(MUTE_KEY) === '1' } catch { muted = false }
}

/** Every file the loader has to fetch, as [key, path] pairs. */
export const audioManifest = (data) => {
  const a = data.audio ?? {}
  return [...(a.sfx ?? []), ...Object.values(a.music ?? {})]
    .map(name => [`sfx:${name}`, `assets/sfx/${name}.mp3`])
}

export const isMuted = () => muted

export function setMuted(value, scene) {
  muted = !!value
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0') } catch { /* private mode */ }
  // Silencing needs no scene, and returning early without doing it left the bed
  // playing for anyone who muted before a scene was to hand.
  if (muted) current?.sound?.stop()
  if (!scene) return muted
  if (!muted && current) playMusic(scene, current.key, { restart: true })
  return muted
}

export const toggleMuted = (scene) => setMuted(!muted, scene)

/** A one-shot cue. Unknown names and unloaded files are silence. */
export function sfx(scene, cue, { volume = 1, rate = 1 } = {}) {
  if (muted || !cue || !scene?.sound) return
  const key = `sfx:${cue}`
  if (!scene.cache.audio.exists(key)) return
  try { scene.sound.play(key, { volume: cfg.volume.sfx * volume, rate }) } catch { /* decode failed */ }
}

/** The cue a tool makes, as the data file names it. */
export const toolSfx = (scene, toolId, opts) => sfx(scene, cfg.toolCue?.[toolId], opts)

/**
 * The bed for a place. Asking for the bed already playing does nothing, so
 * moving between two screens that share one does not restart it.
 */
export function playMusic(scene, place, { restart = false } = {}) {
  const name = cfg.music?.[place]
  if (!name) return
  if (!restart && current?.key === place && current.sound?.isPlaying) return
  const key = `sfx:${name}`
  if (!scene?.sound || !scene.cache.audio.exists(key)) return

  if (current?.sound && current.key !== place) { current.sound.stop(); current.sound.destroy() }
  current = { key: place, sound: current?.key === place ? current.sound : null }
  if (muted) return

  try {
    if (!current.sound || !current.sound.isPlaying) {
      // Muting stops the bed without destroying it, so unmuting arrives here
      // holding a stopped sound and used to leave it behind while adding a new
      // one. The sound manager keeps every sound ever added, so each trip
      // through the toggle left one more of them in it for the rest of the
      // session.
      if (current.sound) {
        // The fade-in is a tween on the sound. Muting again before it finishes
        // would leave it running against a destroyed object.
        scene.tweens?.killTweensOf?.(current.sound)
        current.sound.destroy()
        current.sound = null
      }
      const s = scene.sound.add(key, { loop: true, volume: 0 })
      s.play()
      // Fading in stops the loop from thumping in mid-phrase when a screen opens.
      scene.tweens.add({ targets: s, volume: cfg.volume.music, duration: 600 })
      current.sound = s
    }
  } catch { current = null }
}

export function stopMusic() {
  current?.sound?.stop()
  current?.sound?.destroy()
  current = null
}
