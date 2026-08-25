// Two languages, one source of truth each: UI chrome in strings.json, and the
// name/description of every crop, good, animal and recipe next to that thing
// in game.json. Both are plain data, so a third language is a file edit.

let strings = {}
let lang = localStorage.getItem('simfarm.lang') || 'en'

export const setStrings = (s) => { strings = s }
export const getLang = () => lang
export const languages = () => Object.keys(strings).filter(k => !k.startsWith('_'))

export function setLang(next) {
  lang = next
  localStorage.setItem('simfarm.lang', next)
}

export const nextLang = () => {
  const all = languages()
  return all[(all.indexOf(lang) + 1) % all.length]
}

/** A UI string by key. `{0}`, `{1}` … are replaced by the extra arguments. */
export function t(key, ...args) {
  const table = strings[lang] || strings.en || {}
  const raw = table[key] ?? strings.en?.[key] ?? key
  return raw.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
}

/** A name or description carried by a data entry — either a plain string or {en, th}. */
export function tx(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return value[lang] ?? value.en ?? Object.values(value)[0] ?? ''
}
