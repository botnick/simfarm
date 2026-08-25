// Find things on screen by what they say.
//
// The alternative is what these suites used to do: keep a second copy of a
// scene's layout arithmetic and work out where the thing ought to be. A copy
// drifts. The market cards were rebuilt at a different width and gap and the
// test kept clicking a position computed from the old numbers — it still landed
// on the right card, two pixels inside the edge, entirely by luck. The whole-
// field buttons moved to make room for a third and one suite was still clicking
// where the old one had been; that one at least failed loudly.
//
// A test that asks the running game where DELIVER is cannot drift, and it fails
// for the right reason when the button stops existing.

/** Screen-reading helpers bound to one puppeteer page. */
export function onScreen(page) {
  /**
   * Where the first visible thing saying this is, in stage coordinates.
   *
   * Buttons are a label with a hit area centred on it, so the label's own
   * position is the place to click. Scenes are searched in the order Phaser
   * holds them, and only the active ones — an inactive scene keeps its objects
   * and would happily report a button nobody can press.
   */
  const find = (re) => page.evaluate((source, flags) => {
    const rx = new RegExp(source, flags)
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      for (const o of sc.children.list) {
        if (o.type !== 'Text' || !o.visible || !o.text) continue
        if (rx.test(o.text)) return { x: o.x, y: o.y, text: o.text }
      }
    }
    return null
  }, re.source, re.flags)

  /** Every visible string in the running scenes, for saying what went wrong. */
  const texts = () => page.evaluate(() => {
    const out = []
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      sc.children.list.forEach(o => { if (o.type === 'Text' && o.text) out.push(o.text) })
    }
    return out
  })

  /**
   * Where the button saying this is.
   *
   * Not every word on screen can be pressed. The market shows a bare price for
   * a crop the barn does not hold and a priced button for one it does, and both
   * read as "$ 40" — so a test that goes looking for the words alone can end up
   * clicking a label and reporting that nothing happened. A button is a label
   * sitting inside an interactive area, which is what this looks for.
   */
  const findButton = (re) => page.evaluate((source, flags) => {
    const rx = new RegExp(source, flags)
    for (const sc of window.__game.scene.scenes) {
      if (!sc.scene.isActive()) continue
      const hits = sc.children.list.filter(o => o.input?.enabled && o.width && o.height)
      for (const o of sc.children.list) {
        if (o.type !== 'Text' || !o.visible || !o.text || !rx.test(o.text)) continue
        const on = hits.some(h => Math.abs(h.x - o.x) <= h.width / 2 + 2 && Math.abs(h.y - o.y) <= h.height / 2 + 6)
        if (on) return { x: o.x, y: o.y, text: o.text }
      }
    }
    return null
  }, re.source, re.flags)

  return { find, findButton, texts }
}
