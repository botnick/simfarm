// Helpers for working in the original 600x420 stage space.
import { WIDTH, HEIGHT } from '../main.js'

/** Scene backgrounds are exact 600x420 plates lifted from the SWF. */
export function backdrop(scene, key) {
  return scene.add.image(0, 0, key).setOrigin(0).setDisplaySize(WIDTH, HEIGHT)
}

/**
 * The click regions recovered from the SWF.
 *
 * They arrived in two passes and neither file covers every frame: the first has
 * the coop, village, shops and ending, the refined one has all four field
 * screens. Reading only one of them left fields two to four with no tiles at
 * all — sowable, but nothing drawn and nothing clickable. So both are consulted,
 * with the refined pass winning where they overlap.
 */
export function regions(scene, frame) {
  const key = String(frame)
  const first = scene.registry.get('hits')?.frame?.[key] ?? []
  const refined = scene.registry.get('hitsUi')?.frame?.[key] ?? []
  // Union by role, not whole-file preference. The refined pass has all four
  // field screens but dropped the farmhouse; taking it wholesale lost the way
  // into the workshop. Refined wins where both describe the same thing.
  const merged = new Map()
  for (const r of first) merged.set(r.role, r)
  for (const r of refined) merged.set(r.role, r)
  return [...merged.values()]
}

export const regionByRole = (list, role) => list.find(r => r.role === role)
export const centreOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/**
 * Field tiles are isometric diamonds whose bounding boxes overlap heavily, so a
 * rectangular hit area would steal clicks from its neighbours. Test the diamond.
 */
export function diamondZone(scene, r, onClick) {
  const c = centreOf(r)
  const hw = r.w / 2, hh = r.h / 2
  const zone = scene.add.zone(c.x, c.y, r.w, r.h)
  zone.setInteractive({
    hitArea: r,
    hitAreaCallback: (_area, x, y) => Math.abs(x - hw) / hw + Math.abs(y - hh) / hh <= 1,
    useHandCursor: true,
  })
  zone.on('pointerup', onClick)
  return zone
}
