/**
 * File import. Everything here is local: pdf.js is bundled from node_modules and
 * its worker and character maps are served from this app's own origin, so opening
 * a document never touches the network.
 */

import { normalizeText, cleanInline } from './normalize.js'

/** Extensions we accept in the file picker and on drop. */
export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.csv', '.log', '.pdf']

export function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * Read any supported file into canonical text.
 * @param {File} file
 * @param {(progress: {phase: string, ratio: number, detail?: string}) => void} [onProgress]
 * @returns {Promise<{text: string, title: string, pages?: number}>}
 */
export async function importFile(file, onProgress = () => {}) {
  if (isPdf(file)) return importPdf(file, onProgress)
  return importPlainText(file, onProgress)
}

async function importPlainText(file, onProgress) {
  onProgress({ phase: 'reading', ratio: 0.1 })
  const raw = await file.text()
  onProgress({ phase: 'reading', ratio: 1 })
  return {
    text: normalizeText(stripMarkdown(raw, file.name), { unwrap: 'auto' }),
    title: file.name,
  }
}

/**
 * Light Markdown clean-up so headings and emphasis are not read out as punctuation.
 * Only applied to .md files; plain .txt is passed through untouched.
 */
export function stripMarkdown(raw, filename) {
  if (!/\.(md|markdown)$/i.test(filename)) return raw
  return raw
    .replace(/^```[\s\S]*?^```$/gm, '') // fenced code blocks
    .replace(/^[ \t]{0,3}#{1,6} +/gm, '') // heading markers
    .replace(/^[ \t]{0,3}> ?/gm, '') // block quotes
    .replace(/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[ \t*_-]*$/gm, '') // horizontal rules
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
}

/* ------------------------------------------------------------------- PDF ---- */

let pdfjsPromise = null

/** Load pdf.js on first use and point it at our vendored worker + cmaps. */
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js 4.x uses Promise.withResolvers, missing in Safari before 17.4.
      if (typeof Promise.withResolvers !== 'function') {
        Promise.withResolvers = function withResolvers() {
          let resolve
          let reject
          const promise = new Promise((res, rej) => {
            resolve = res
            reject = rej
          })
          return { promise, resolve, reject }
        }
      }
      const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })()
  }
  return pdfjsPromise
}

/**
 * Extract reading-order text from a PDF, plus the geometry needed to paint the
 * highlight onto the rendered page.
 *
 * @param {File|Blob} file
 * @param {(progress: {phase: string, ratio: number, detail?: string}) => void} onProgress
 * @returns {Promise<{text: string, title: string, pages: number, layout: PdfLayout, pdf: object}>}
 *
 * @typedef {{pages: {number: number, width: number, height: number, rotation: number,
 *   items: {start:number, end:number, x:number, y:number, w:number, h:number}[]}[]}} PdfLayout
 *   `start`/`end` index into the returned text; x/y/w/h are PDF user-space units
 *   (origin bottom-left, y up), with y at the baseline.
 */
export async function importPdf(file, onProgress = () => {}) {
  onProgress({ phase: 'loading', ratio: 0.02, detail: 'Loading PDF engine' })
  const pdfjs = await loadPdfjs()
  const data = await file.arrayBuffer()

  const base = new URL('./pdfjs/', document.baseURI).href
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    isEvalSupported: false,
    disableAutoFetch: true,
  })

  const pdf = await task.promise
  const layout = { pages: [], fonts: {} }
  let text = ''

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    onProgress({
      phase: 'extracting',
      ratio: pageNumber / pdf.numPages,
      detail: `Page ${pageNumber} of ${pdf.numPages}`,
    })
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1 })
    const extracted = extractPage(content)

    // Pages are separated by a paragraph break; the join must be exactly two
    // characters so the item offsets below stay honest.
    const base = text ? text.length + 2 : 0
    if (extracted.text) text = text ? `${text}\n\n${extracted.text}` : extracted.text

    for (const [family, entry] of Object.entries(extracted.fonts || {})) {
      const merged = (layout.fonts[family] ??= { count: 0, samples: [], pages: [] })
      merged.count += entry.count
      if (!merged.pages.includes(pageNumber)) merged.pages.push(pageNumber)
      for (const s of entry.samples) if (merged.samples.length < 8 && !merged.samples.includes(s)) merged.samples.push(s)
    }
    layout.pages.push({
      number: pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      items: extracted.items.map((it) => ({ ...it, start: it.start + base, end: it.end + base })),
    })
    page.cleanup()
  }
  const meta = await pdf.getMetadata().catch(() => null)

  // Single line breaks are wraps: fold them to spaces, one character for one,
  // so nothing in `layout` moves. Paragraph breaks ("\n\n") are kept.
  text = text.replace(/([^\n])\n(?!\n)/g, '$1 ')

  // Everything above already produces canonical text, so this is a no-op; if it
  // is not, the geometry cannot be trusted and the caller falls back to text view.
  const canonical = normalizeText(text, { unwrap: 'never' })
  const safeLayout = canonical === text ? layout : null
  if (!safeLayout) console.warn('[pdf] extracted text was not canonical; page view disabled')

  return {
    text: canonical,
    title: pickTitle(meta?.info?.Title, file.name),
    pages: pdf.numPages,
    layout: safeLayout,
    pdf,
  }
}

const SUPERSCRIPT_DIGITS = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻' }

/** "2" -> "²" so the text view reads naturally; anything else -> "^x". */
function superscriptOf(s) {
  if ([...s].every((c) => SUPERSCRIPT_DIGITS[c])) return [...s].map((c) => SUPERSCRIPT_DIGITS[c]).join('')
  return `^${s}`
}

/** Plain-text view of a page, for tests and for callers without geometry needs. */
export function pageToText(content) {
  return extractPage(content).text
}

/**
 * Rebuild lines and paragraphs from positioned glyph runs, keeping for every run
 * the range of the page text it produced.
 *
 * pdf.js hands back text items with a transform matrix rather than lines. We
 * group items by baseline, order them left to right, insert spaces where the
 * horizontal gap is wider than the glyphs would explain, and promote a wide
 * vertical gap to a paragraph break. Single "\n" means a wrapped line, "\n\n"
 * means a new paragraph; the caller folds the wraps away.
 *
 * The output is already canonical (single spaces, no stray whitespace), so the
 * offsets survive normalizeText() untouched.
 */
export function extractPage(content) {
  const raw = content.items.filter((item) => typeof item.str === 'string')
  if (!raw.length) return { text: '', items: [], fonts: {} }
  const styles = content.styles || {}
  /** font family -> a few sample strings, so undecodable fonts can be identified */
  const fontReport = {}

  /** @type {{y:number, height:number, parts:object[]}[]} */
  const lines = []
  for (const item of raw) {
    const [, skewA, skewB, scaleY, x, y] = item.transform
    const height = Math.abs(item.height || scaleY) || 10
    const family = styles[item.fontName]?.fontFamily || ''
    const part = { x, y, width: item.width || 0, height, str: decodeSymbolic(item.str, family), script: '' }
    // Turned text (a figure's vertical axis label): its width runs up the page, not across it.
    if (Math.abs(skewA) > 0.01 || Math.abs(skewB) > 0.01) part.rotated = true
    noteFont(fontReport, family, item.str)

    // Same line if the baselines are within a third of the line's glyph height.
    // A smaller run sitting a little above or below the baseline is a super- or
    // subscript (mc², σ_x): keep it on the line, and remember which it was.
    const line = lines.find((l) => {
      const delta = Math.abs(l.y - y)
      if (delta <= Math.max(2, Math.max(l.height, height) * 0.35)) return true
      return height < l.height * 0.8 && delta <= l.height * 0.6
    })
    if (line) {
      const delta = Math.abs(line.y - y)
      // Smaller glyphs shifted off the baseline by more than a hair are scripts.
      if (height < line.height * 0.8 && delta > Math.max(1, line.height * 0.15)) {
        part.script = y > line.y ? 'super' : 'sub'
      }
      line.parts.push(part)
      if (!part.script) line.height = Math.max(line.height, height)
    } else {
      lines.push({ y, height, parts: [part] })
    }
  }
  lines.sort((a, b) => b.y - a.y) // PDF y grows upward
  for (const line of lines) line.parts.sort((a, b) => a.x - b.x)

  // Each rendered line: its text and the items that make it up, with local offsets.
  const rendered = []
  for (const line of orderColumns(lines, findGutters(lines))) {
    let text = ''
    const items = []
    let cursorX = null
    let prevEndedWithSpace = false
    for (const part of line.parts) {
      const cleaned = cleanInline(part.str)
      const trimmed = cleaned.trim()
      if (!trimmed) {
        prevEndedWithSpace = true // a whitespace-only run still separates words
        continue
      }
      // Scripts attach to the word before them: "mc" + "2" -> "mc²", "σ" + "x" -> "σ_x".
      const marker = part.script === 'super' ? superscriptOf(trimmed) : part.script === 'sub' ? `_${trimmed}` : ''
      if (text && !marker) {
        const gap = cursorX === null ? 0 : part.x - cursorX
        const needsSpace = prevEndedWithSpace || /^\s/.test(cleaned) || gap > line.height * 0.18
        if (needsSpace) text += ' '
      }
      const emitted = marker || trimmed
      items.push({ start: text.length, end: text.length + emitted.length, x: part.x, y: part.y, w: part.width, h: part.height })
      text += emitted
      cursorX = part.x + part.width
      prevEndedWithSpace = marker ? true : /\s$/.test(cleaned)
    }
    if (text) rendered.push({ text, items, y: line.y, height: line.height })
  }
  if (!rendered.length) return { text: '', items: [], fonts: fontReport }

  // Line pitch on this page. The lower quartile rather than the median, because
  // paragraph gaps are the minority but are large enough to drag a median up --
  // on a short page that would hide every paragraph break.
  const gaps = []
  for (let i = 1; i < rendered.length; i++) gaps.push(rendered[i - 1].y - rendered[i].y)
  const pitch = percentile(gaps.filter((g) => g > 0), 0.25) || rendered[0].height * 1.2

  let out = ''
  const items = []
  const append = (line, separator) => {
    const base = out.length + separator.length
    out += separator + line.text
    for (const it of line.items) items.push({ ...it, start: it.start + base, end: it.end + base })
  }

  append(rendered[0], '')
  for (let i = 1; i < rendered.length; i++) {
    const prev = rendered[i - 1]
    const line = rendered[i]
    const gap = prev.y - line.y
    // A negative gap means we jumped back up the page: the start of a new column.
    const spaced = gap < 0 || (gap > pitch * 1.5 && gap - pitch > 2)
    const newParagraph = spaced || startsNewBlock(line.text, prev.text)

    // "inter-\nnational": drop the hyphen and join the halves directly.
    const hyphenated =
      !newParagraph && /\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(line.text)
    if (hyphenated) {
      out = out.slice(0, -1)
      const last = items[items.length - 1]
      if (last && last.end > out.length) last.end = out.length
      append(line, '')
    } else {
      append(line, newParagraph ? '\n\n' : '\n')
    }
  }
  return { text: out, items, fonts: fontReport }
}

/** Keep a handful of distinctive samples per font: short strings with letters or symbols. */
function noteFont(report, family, str) {
  const key = family || '(unnamed)'
  const entry = (report[key] ??= { count: 0, samples: [] })
  entry.count++
  const sample = str.trim().slice(0, 40)
  if (sample && entry.samples.length < 6 && !entry.samples.includes(sample) && /[^\s\d.,;:()-]/.test(sample)) {
    entry.samples.push(sample)
  }
}

/**
 * Prefer the PDF's own title, but not when it is really a filename or a
 * placeholder -- exporters routinely leave "Untitled" or "report.docx" in there.
 */
export function pickTitle(metaTitle, filename) {
  const title = (metaTitle || '').trim()
  const junk = /^(untitled|microsoft word|document\d*|slide\d*)\b/i.test(title)
  const looksLikeFile = /\.(html?|docx?|pdf|pages|txt|rtf|odt|pptx?|tex)$/i.test(title)
  if (!title || junk || looksLikeFile) return filename || 'Document'
  return title
}

/**
 * Put multi-column text into reading order.
 *
 * Lines arrive top to bottom, which interleaves the columns of a two-column
 * page. Consecutive narrow lines whose horizontal extents fall into separate,
 * non-overlapping bands are treated as a block of columns, and each column is
 * emitted whole before the next. A line that spans the page (a heading, a
 * caption) or straddles two bands ends the block.
 *
 * @param {{y:number, height:number, parts:{x:number,width:number}[]}[]} lines sorted top to bottom
 * @returns {{y:number, height:number, parts:object[]}[]}
 */
export function orderColumns(lines, gutters = []) {
  if (lines.length < 2) return lines
  if (gutters.length) return orderByGutters(lines, gutters)
  const out = []

  // A line wider than most of the text area cannot be one column of several.
  const pageX0 = Math.min(...lines.map((l) => extent(l).x0))
  const pageX1 = Math.max(...lines.map((l) => extent(l).x1))
  const wide = (pageX1 - pageX0) * 0.7

  let block = null // { columns: {x0,x1}[], segments: {col, line}[] }
  const flush = () => {
    if (!block) return
    for (let c = 0; c < block.columns.length; c++) {
      for (const seg of block.segments) if (seg.col === c) out.push(seg.line)
    }
    block = null
  }

  for (const line of lines) {
    const segments = splitAtGutters(line, gutters)

    for (const seg of segments) {
      const e = extent(seg)
      if (e.x1 - e.x0 > wide) {
        flush()
        out.push(seg)
        continue
      }
      if (!block) block = { columns: [], segments: [] }

      let col = -1
      let conflict = false
      block.columns.forEach((c, i) => {
        const fits = e.x0 >= c.x0 - tolerance(c) && e.x1 <= c.x1 + tolerance(c)
        const overlaps = e.x0 < c.x1 && e.x1 > c.x0
        if (fits && col < 0) col = i
        else if (overlaps) conflict = true
      })
      if (conflict) {
        // Straddles two bands: the layout changed, start over from here.
        flush()
        block = { columns: [], segments: [] }
        col = -1
      }
      if (col < 0) {
        block.columns.push({ x0: e.x0, x1: e.x1 })
        block.columns.sort((a, b) => a.x0 - b.x0)
        // Re-map existing segments to the re-sorted column indices.
        col = block.columns.findIndex((c) => c.x0 === e.x0 && c.x1 === e.x1)
        for (const s of block.segments) s.col = block.columns.findIndex((c) => c === s.column)
      }
      const column = block.columns[col]
      column.x0 = Math.min(column.x0, e.x0)
      column.x1 = Math.max(column.x1, e.x1)
      block.segments.push({ col, column, line: seg })
    }
  }
  flush()
  return out
}

/**
 * Column order when the page's gutters are known: every run is simply left or
 * right of a gutter, whatever its width or indent. Consecutive lines accumulate
 * into a block; only a line that crosses a gutter (a title, a wide figure caption)
 * closes it, at which point each column is emitted whole, top to bottom.
 */
function orderByGutters(lines, gutters) {
  const mids = gutters.map((g) => (g.x0 + g.x1) / 2)
  const columnOf = ({ x0, x1 }) => {
    const centre = (x0 + x1) / 2
    let col = 0
    while (col < mids.length && centre > mids[col]) col++
    return col
  }
  const crosses = ({ x0, x1 }) => mids.some((m) => x0 < m - 2 && x1 > m + 2)

  const out = []
  let columns = []
  const flush = () => {
    for (const column of columns) if (column) out.push(...column)
    columns = []
  }

  for (const line of lines) {
    const segments = splitAtGutters(line, gutters)
    const wide = segments.find((seg) => crosses(extent(seg)))
    if (wide) {
      flush()
      out.push(line)
      continue
    }
    for (const seg of segments) {
      const col = columnOf(extent(seg))
      ;(columns[col] ??= []).push(seg)
    }
  }
  flush()
  return out
}

/**
 * Break a line into pieces wherever the horizontal gap is far wider than a word
 * space, or where consecutive runs sit on opposite sides of a page gutter found by
 * findGutters() -- the latter catches columns whose gutter is no wider than a
 * generous word space, which is common in two-column journals.
 */
function splitAtGutters(line, gutters = []) {
  const gutter = Math.max(14, line.height * 1.8)
  const pieces = []
  let current = null
  let cursorX = null
  const straddles = (endX, startX) =>
    gutters.some((g) => endX <= g.x1 + 1 && startX >= g.x0 - 1 && startX > endX - 1)
  for (const part of line.parts) {
    if (current && cursorX !== null && (part.x - cursorX > gutter || straddles(cursorX, part.x))) current = null
    if (!current) {
      current = { y: line.y, height: line.height, parts: [] }
      pieces.push(current)
    }
    current.parts.push(part)
    cursorX = Math.max(cursorX ?? -Infinity, part.x + part.width)
  }
  return pieces
}

/**
 * Adobe Symbol font encoding, for the codes that matter when reading: Greek,
 * operators, arrows. Codes not listed fall back to their ASCII position.
 */
const SYMBOL_FONT = {
  0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι',
  0x4a: 'ϑ', 0x4b: 'Κ', 0x4c: 'Λ', 0x4d: 'Μ', 0x4e: 'Ν', 0x4f: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ',
  0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x56: 'ς', 0x57: 'Ω', 0x58: 'Ξ', 0x59: 'Ψ', 0x5a: 'Ζ',
  0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η', 0x69: 'ι',
  0x6a: 'ϕ', 0x6b: 'κ', 0x6c: 'λ', 0x6d: 'μ', 0x6e: 'ν', 0x6f: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ',
  0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7a: 'ζ',
  0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−', 0x40: '≅', 0x5c: '∴', 0x5e: '⊥', 0x7e: '∼',
  0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→',
  0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•',
  0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘',
  0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂',
  0xcd: '⊆', 0xce: '∈', 0xcf: '∉', 0xd0: '∠', 0xd1: '∇', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬',
  0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe1: '⟨', 0xe5: '∑',
  0xf1: '⟩', 0xf2: '∫',
}

/**
 * pdf.js reports glyphs from symbolic fonts that lack a Unicode map as private-use
 * characters U+F000+code -- the boxes seen in extracted tables and equations. For
 * the Symbol font the code is the Adobe Symbol encoding (0x61 = α); for any other
 * font it is almost always plain ASCII. Anything still undecodable is dropped: it
 * has no sound and no readable shape.
 */
export function decodeSymbolic(str, fontFamily = '') {
  if (!/[\uE000-\uF8FF]/.test(str)) return str
  const symbol = /symbol/i.test(fontFamily)
  let out = ''
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    if (cp < 0xe000 || cp > 0xf8ff) {
      out += ch
      continue
    }
    const code = cp - 0xf000
    if (code < 0 || code > 0xff) continue
    if (symbol && SYMBOL_FONT[code]) out += SYMBOL_FONT[code]
    else if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code)
    else if (!symbol && code >= 0xa0) out += String.fromCharCode(code)
  }
  return out
}

/**
 * Vertical bands of the page that text almost never crosses: the gutters between
 * columns. Built from an x-coverage profile of every line. A band counts only if
 * it sits in the middle half of the text width and has real text on both sides,
 * so margins, indents and ragged right edges are not mistaken for one.
 *
 * "Almost never" is measured against the columns themselves: a figure with its
 * caption, tick labels and the running header can put a handful of lines across
 * the gutter, which is still next to nothing beside the dozens of lines that fill
 * each column. Turned text (axis labels) is left out entirely.
 * @returns {{x0:number, x1:number}[]}
 */
export function findGutters(lines) {
  const solid = lines.map((l) => l.parts.filter((p) => !p.rotated)).filter((parts) => parts.length)
  if (solid.length < 6) return []
  let pageX0 = Infinity
  let pageX1 = -Infinity
  for (const parts of solid) {
    for (const p of parts) {
      pageX0 = Math.min(pageX0, p.x)
      pageX1 = Math.max(pageX1, p.x + p.width)
    }
  }
  const width = pageX1 - pageX0
  if (!(width > 150)) return []

  const BIN = 2
  const bins = Math.ceil(width / BIN) + 1
  const coverage = new Uint16Array(bins)
  for (const parts of solid) {
    const seen = new Uint8Array(bins)
    for (const p of parts) {
      const a = Math.max(0, Math.floor((p.x - pageX0) / BIN))
      const b = Math.min(bins - 1, Math.ceil((p.x + p.width - pageX0) / BIN))
      for (let i = a; i <= b; i++) seen[i] = 1
    }
    for (let i = 0; i < bins; i++) coverage[i] += seen[i]
  }

  // Quiet: at most 8% of all lines, or a fifth of how busy the text typically is.
  const busy = percentile([...coverage], 0.5)
  const quiet = Math.max(1, Math.floor(solid.length * 0.08), Math.floor(busy * 0.2))
  const gutters = []
  let runStart = -1
  for (let i = 0; i <= bins; i++) {
    const isQuiet = i < bins && coverage[i] <= quiet
    if (isQuiet && runStart < 0) runStart = i
    if (!isQuiet && runStart >= 0) {
      const x0 = pageX0 + runStart * BIN
      const x1 = pageX0 + i * BIN
      runStart = -1
      const centre = (x0 + x1) / 2
      if (x1 - x0 < 6) continue
      if (centre < pageX0 + width * 0.25 || centre > pageX1 - width * 0.25) continue
      // Real columns: a good share of lines has text on each side of the band.
      let left = 0
      let right = 0
      for (const parts of solid) {
        if (parts.some((p) => p.x + p.width <= x0 + 1)) left++
        if (parts.some((p) => p.x >= x1 - 1)) right++
      }
      if (left >= solid.length * 0.3 && right >= solid.length * 0.3) gutters.push({ x0, x1 })
    }
  }
  return gutters
}

function extent(segment) {
  const x0 = Math.min(...segment.parts.map((p) => p.x))
  const x1 = Math.max(...segment.parts.map((p) => p.x + p.width))
  return { x0, x1 }
}

function tolerance(column) {
  return Math.max(10, (column.x1 - column.x0) * 0.15)
}

/** A bullet or a numbered item starts a new block. */
export function startsNewBlock(line, previous) {
  const finishedSentence = /[.!?:]["\u2019\u201D)\]]?$/.test(previous)
  // Unambiguous bullet glyphs, plus the ASCII stand-ins for them.
  if (/^[\u2022\u2023\u25E6\u2043\u2219*+]\s+/.test(line)) return true
  // A dash only starts a block when the previous line actually ended a sentence;
  // otherwise it is a dash continuing one: "not obviously better\n\u2014 only faster".
  if (/^[-\u2013\u2014]\s+/.test(line)) return finishedSentence
  if (/^\d{1,3}[.)]\s+/.test(line)) return finishedSentence
  return false
}

function percentile(values, q) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
}
