// The same fingerprint the server takes of the rule book, taken in the browser.
//
// Both sides load their own copy of game.json — the server to decide with, the
// browser to draw with — and a host can deploy one without the other. The server
// still decides, so nothing is exploitable; but the game would quietly show
// prices and unlock levels that the server disagrees with, and being told one
// thing and given another is worse than being shown an error.
//
// Web Crypto is async and only available over HTTPS or on localhost, so this is
// a plain string hash rather than SHA-256: it only has to notice a difference,
// not resist anyone manufacturing one.
export function fingerprint(data) {
  const text = JSON.stringify(data)
  // FNV-1a, in two interleaved lanes so a short hex string still separates
  // documents that differ only late in a large file.
  let a = 0x811c9dc5, b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b + c, 0x85ebca6b) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'))
}
