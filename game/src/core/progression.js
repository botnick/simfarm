// Experience, levels and what they open up.
//
// This replaces "survive to day 365" as the reason to keep going. Experience is
// never spent — it is a record of what the farm has done, so a player who comes
// back to the mini-game after a week has not lost anything.
export const LEVEL_XP = (level, factor) => factor * level * (level - 1)

/** The level a given amount of experience buys. */
// A ceiling so a corrupt or hostile experience total cannot spin this loop.
export const MAX_LEVEL = 999

export function levelFor(xp, data) {
  const f = data.progression.thresholdFactor
  const safe = Number.isFinite(xp) && xp > 0 ? xp : 0
  let level = 1
  while (level < MAX_LEVEL && LEVEL_XP(level + 1, f) <= safe) level++
  return level
}

/** How far through the current level, for a progress bar. */
export function levelProgress(xp, data) {
  const f = data.progression.thresholdFactor
  const level = levelFor(xp, data)
  const from = LEVEL_XP(level, f)
  const to = LEVEL_XP(level + 1, f)
  return { level, from, to, into: xp - from, needed: to - from, fraction: (xp - from) / (to - from) }
}

export const isUnlocked = (thing, level) => (thing.unlockLevel ?? 1) <= level

export const unlockedCrops = (data, level) => data.crops.filter(c => isUnlocked(c, level))
export const unlockedCropIds = (data, level) => unlockedCrops(data, level).map(c => c.id)

/** A recipe opens up once everything it needs is available. */
export function unlockedRecipes(data, level) {
  const crops = new Set(unlockedCropIds(data, level))
  return data.recipes.filter(r => r.inputs.every(i => i.anyCrop != null || !i.crop || crops.has(i.crop)))
}
