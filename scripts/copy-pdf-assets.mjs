/**
 * Copy pdf.js character maps into public/ so they are served from our own origin.
 *
 * pdf.js needs cmaps to extract text from PDFs that use CID/Identity-H encodings
 * (most CJK documents, and plenty of western ones produced by LaTeX). Upstream
 * examples load them from a CDN; we vendor them instead so the app never touches
 * the network. Runs automatically on install and before dev/build.
 */
import { cp, mkdir, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const jobs = [
  ['node_modules/pdfjs-dist/cmaps', 'public/pdfjs/cmaps'],
  ['node_modules/pdfjs-dist/standard_fonts', 'public/pdfjs/standard_fonts'],
]

for (const [from, to] of jobs) {
  const src = resolve(root, from)
  const dest = resolve(root, to)
  try {
    await access(src)
  } catch {
    console.warn(`[pdf-assets] skipping missing ${from} (run npm install first)`)
    continue
  }
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
  console.log(`[pdf-assets] ${from} -> ${to}`)
}
