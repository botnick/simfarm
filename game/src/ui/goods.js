import Phaser from 'phaser'

// Most processed goods have no art in the original SWF, so they are drawn: a
// jar in the good's own colour. Better an honest shape than a recoloured
// vegetable. Anything that does have real art uses it.
export function goodIcon(scene, x, y, good, scale = 1) {
  // Real art wins: a generated sprite first, then anything lifted from the SWF.
  if (scene.textures.exists(`good:${good.id}`)) {
    const im = scene.add.image(x, y, `good:${good.id}`)
    im.setDisplaySize(46 * scale, 46 * scale)
    return [im]
  }
  if (good.art && scene.textures.exists(`art:${good.art}`)) {
    return [scene.add.image(x, y, `art:${good.art}`).setScale(scale * 0.5)]
  }
  // Drawn in the artwork's idiom: heavy dark outline, flat colour, one highlight.
  const g = scene.add.graphics()
  const w = 26 * scale, h = 32 * scale, r = 6 * scale
  const body = Phaser.Display.Color.HexStringToColor(good.color).color
  const rim = 0x1a1208
  const lidW = w + 7 * scale, lidH = 9 * scale, lidY = y - h / 2 - lidH + 2 * scale
  g.fillStyle(rim, 1).fillRoundedRect(x - lidW / 2 - 2, lidY - 2, lidW + 4, lidH + 4, 4)
  g.fillStyle(0x8b5a2b, 1).fillRoundedRect(x - lidW / 2, lidY, lidW, lidH, 3)
  g.fillStyle(rim, 1).fillRoundedRect(x - w / 2 - 2.5, y - h / 2 - 2.5, w + 5, h + 5, r + 2)
  g.fillStyle(0xf3f7ff, 1).fillRoundedRect(x - w / 2, y - h / 2, w, h, r)          // glass
  g.fillStyle(body, 1).fillRoundedRect(x - w / 2 + 2, y - h / 2 + 5 * scale, w - 4, h - 5 * scale - 2, r - 2)
  g.fillStyle(0xffffff, 0.5).fillRoundedRect(x - w / 2 + 4 * scale, y - h / 2 + 7 * scale, 4 * scale, h - 16 * scale, 2)
  return [g]
}

/**
 * An animal at a given size on screen.
 *
 * The chicken came out of the SWF and the rest were drawn to match, so their
 * source images are different shapes and resolutions. Measuring the texture
 * rather than guessing a scale is what keeps them the same size as each other.
 */
export function animalIcon(scene, x, y, animal, size = 46) {
  const key = scene.textures.exists(`animal:${animal.id}`) ? `animal:${animal.id}` : `art:${animal.art}`
  const im = scene.add.image(x, y, key)
  const tex = scene.textures.get(key).getSourceImage()
  im.setScale(size / Math.max(tex.width, tex.height))
  return im
}

// Supplies that have no art of their own borrow the SWF sack, tinted, so a new
// feed never renders as a missing-texture square.
const SUPPLY_ART = { fertilizer: 'supply_fertilizer', pesticide: 'supply_pesticide', feed: 'supply_feed' }
const SUPPLY_TINT = { grain: 0xf0c040, hay: 0xdcc27a, fodder: 0x9ab35a }

export function supplyIcon(scene, x, y, supplyId, size = 40) {
  const own = `supply:${supplyId}`
  const key = scene.textures.exists(own) ? own
    : `art:${SUPPLY_ART[supplyId] ?? 'supply_feed'}`
  const im = scene.add.image(x, y, key)
  const tex = scene.textures.get(key).getSourceImage()
  im.setScale(size / Math.max(tex.width, tex.height))
  if (!scene.textures.exists(own) && SUPPLY_TINT[supplyId]) im.setTint(SUPPLY_TINT[supplyId])
  return im
}

/**
 * A crop as a list icon.
 *
 * The plot art carries its own ground shadow, which is right on soil and a grey
 * smudge on a cream card. The icon therefore gets a plate for that shadow to
 * fall on, and is sized by measuring its texture rather than by a fixed scale —
 * the crop frames range from a squat carrot to a tall stalk of corn, so one
 * scale made some icons twice the size of others.
 */
export function cropIcon(scene, x, y, crop, size = 40) {
  const key = `crop:${crop.art}:5`
  const plate = scene.add.graphics()
  plate.fillStyle(0x1a1208, 0.16).fillCircle(x, y, size * 0.54)
  plate.fillStyle(0xe6d7b4, 1).fillCircle(x, y, size * 0.5)
  plate.fillStyle(0xf2e6c9, 1).fillCircle(x, y - size * 0.03, size * 0.46)
  const im = scene.add.image(x, y, key)
  const tex = scene.textures.get(key)?.getSourceImage()
  // The frame includes the ground shadow, which is wider than the plant, so the
  // art is sized to sit inside the plate rather than spill off it.
  if (tex) im.setScale(size * 0.84 / Math.max(tex.width, tex.height))
  if (crop.tint) im.setTint(Phaser.Display.Color.HexStringToColor(crop.tint).color)
  return [plate, im]
}
