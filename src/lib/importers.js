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
  const layout = { pages: [] }
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
  if (!raw.length) return { text: '', items: [] }

  /** @type {{y:number, height:number, parts:object[]}[]} */
  const lines = []
  for (const item of raw) {
    const [, , , scaleY, x, y] = item.transform
    const height = Math.abs(item.height || scaleY) || 10
    const part = { x, y, width: item.width || 0, height, str: item.str, script: '' }

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
  for (const line of orderColumns(lines)) {
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
  if (!rendered.length) return { text: '', items: [] }

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
  return { text: out, items }
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
export function orderColumns(lines) {
  if (lines.length < 2) return lines
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
    const segments = splitAtGutters(line)

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

/** Break a line into pieces wherever the horizontal gap is far wider than a word space. */
function splitAtGutters(line) {
  const gutter = Math.max(14, line.height * 1.8)
  const pieces = []
  let current = null
  let cursorX = null
  for (const part of line.parts) {
    if (current && cursorX !== null && part.x - cursorX > gutter) current = null
    if (!current) {
      current = { y: line.y, height: line.height, parts: [] }
      pieces.push(current)
    }
    current.parts.push(part)
    cursorX = Math.max(cursorX ?? -Infinity, part.x + part.width)
  }
  return pieces
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
