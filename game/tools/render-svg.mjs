// Renders extracted SVG frames to PNG so they can be eyeballed.
import puppeteer from 'puppeteer-core'
import { readFileSync, mkdirSync } from 'node:fs'
const out = process.argv[2], files = process.argv.slice(3)
mkdirSync(out, { recursive: true })
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
for (const f of files) {
  const svg = readFileSync(f, 'utf8')
  await p.setViewport({ width: 600, height: 420, deviceScaleFactor: 1 })
  await p.setContent(`<body style="margin:0;background:#fff">${svg}</body>`)
  const name = f.split('/').slice(-2).join('_').replace(/\.svg$/, '')
  await p.screenshot({ path: `${out}/${name}.png` })
  console.log(name)
}
await b.close()
