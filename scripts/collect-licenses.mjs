// Writes the licence texts of every package that ends up in the built web UI (frontend/dist) into one file.
// Most of them (MIT, ISC, BSD) require their copyright notice to travel with the code, and the bundler
// strips it; this file puts it back next to the app. scripts/package.ps1 runs it for the release downloads.
//
//   node scripts/collect-licenses.mjs [output file]      (default: licenses/web-ui.txt)
//
// "Ends up in the build" = every package in frontend/package-lock.json that isn't a dev dependency,
// minus type declarations (@types/*), which contain no code.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const out = path.resolve(process.argv[2] ?? path.join(root, 'licenses', 'web-ui.txt'))

const lock = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'), 'utf8'))
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

const entries = []
const missing = []
for (const [where, info] of Object.entries(lock.packages ?? {})) {
  if (!where || info.dev || info.devOptional) continue
  const name = info.name ?? where.replace(/^.*node_modules\//, '')
  if (name.startsWith('@types/')) continue
  const dir = path.join(frontend, where)
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { /* not installed */ }
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => LICENCE_FILE.test(f)).sort() : []
  const texts = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8').trim())
  const licence = info.license ?? pkg.license ?? (typeof pkg.licenses === 'object' ? JSON.stringify(pkg.licenses) : 'unknown')
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? ''
  if (!texts.length) missing.push(name)
  entries.push({ name, version: info.version ?? pkg.version ?? '', licence, repo, texts })
}
entries.sort((a, b) => a.name.localeCompare(b.name))

const line = '-'.repeat(78)
let text = `Licences of the packages bundled into the web interface (frontend/dist)\n` +
  `${entries.length} packages, from frontend/package-lock.json.\n\n` +
  entries.map(e => `${e.name} ${e.version}`.padEnd(48) + e.licence).join('\n') + '\n'
for (const e of entries) {
  text += `\n${line}\n${e.name} ${e.version} - ${e.licence}${e.repo ? `\n${e.repo.replace(/^git\+/, '')}` : ''}\n${line}\n\n`
  text += e.texts.length ? e.texts.join('\n\n') + '\n' : `(No licence file in the package; its package.json declares: ${e.licence}.)\n`
}
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, text.replace(/\r\n/g, '\n'))
console.log(`wrote ${out} (${entries.length} packages${missing.length ? `; no licence file in: ${missing.join(', ')}` : ''})`)
if (entries.length && !entries.some(e => e.texts.length)) {
  console.error('No licence texts found - run "npm ci" in frontend first.')
  process.exit(1)
}
