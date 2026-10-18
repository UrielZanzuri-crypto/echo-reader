/**
 * Page view: the PDF drawn as it is, with the highlight painted on top.
 *
 * Each page is rendered by pdf.js onto a canvas, lazily, as it scrolls into
 * reach. The highlight is not text at all: it is a set of translucent boxes
 * positioned over the page using the geometry of the text runs captured during
 * extraction (importers.js). A run that is only partly inside the active span is
 * clipped horizontally in proportion to its characters, which is close enough
 * for a marker and needs no font metrics.
 *
 * Same interface as Reader (render / highlight / clearHighlight / setMode /
 * offsetAtPoint / autoScroll) so main.js can swap between the two.
 */

import { findSegmentAt } from './segmenter.js'

/** Widest a page is drawn at 100%, in CSS pixels; narrower windows scale down. */
const MAX_PAGE_WIDTH = 920
/** How far beyond the viewport pages are rendered ahead of time. */
const RENDER_MARGIN = '1200px 0px'
/** Zoom range, relative to the page fitting the window. */
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4
/**
 * Largest canvas drawn for one page, in device pixels. Safari refuses canvases
 * much past 16.7M pixels; beyond this a zoomed page is upscaled a little instead.
 */
const MAX_CANVAS_PIXELS = 16_000_000

export class PageView {
  /**
   * @param {HTMLElement} container element the pages are rendered into
   * @param {HTMLElement} scroller  scrolling ancestor of `container`
   */
  constructor(container, scroller) {
    this.container = container
    this.scroller = scroller
    this.mode = 'both'
    this.focusMode = 'off'
    this.autoScroll = true
    this.zoom = 1
    this._veiledRange = null

    this.doc = null
    this.layout = null
    this.pdf = null
    /**
     * `drawn` is the scale the canvas holds (0 = blank), `pending` the scale being
     * rendered; a page is re-rendered whenever its scale moves away from both.
     * @type {{el: HTMLElement, canvas: HTMLCanvasElement, marks: HTMLElement, scale: number, items: object[], drawn: number, pending: number, task: object|null}[]}
     */
    this._pages = []
    this._observer = null
    this._lastSpan = null
    this._lastSentence = -1
    this._resizeTimer = 0
    this._zoomTimer = 0

    this._onResize = () => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this.relayout(), 150)
    }
  }

  /**
   * @param {object|null} doc    document model from buildDocument()
   * @param {object|null} layout PdfLayout from importPdf()
   * @param {object|null} pdf    the pdf.js document proxy, kept open for rendering
   */
  render(doc, layout, pdf) {
    this.destroy()
    this.doc = doc
    this.layout = layout
    this.pdf = pdf
    if (!doc || !layout || !pdf) return

    window.addEventListener('resize', this._onResize)
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.page)
          if (entry.isIntersecting) this._renderPage(index)
          else this._releasePage(index)
        }
      },
      { root: this.scroller, rootMargin: RENDER_MARGIN }
    )

    const fragment = document.createDocumentFragment()
    layout.pages.forEach((page, index) => {
      const el = document.createElement('div')
      el.className = 'page'
      el.dataset.page = String(index)
      el.setAttribute('aria-label', `Page ${page.number}`)

      const canvas = document.createElement('canvas')
      const veils = document.createElement('div')
      veils.className = 'page-marks page-veils'
      const marks = document.createElement('div')
      marks.className = 'page-marks'
      el.append(canvas, veils, marks)
      fragment.appendChild(el)

      this._pages.push({ el, canvas, marks, veils, scale: 1, items: [], drawn: 0, pending: 0, task: null })
      this._observer.observe(el)
    })
    this.container.appendChild(fragment)
    this._sizePages()
    this.scroller.scrollTop = 0
    // The observer only reports once the page has had a chance to lay out, and
    // not at all in a background tab; the first pages should not wait for it.
    for (let i = 0; i < Math.min(2, this._pages.length); i++) this._renderPage(i)
  }

  destroy() {
    window.removeEventListener('resize', this._onResize)
    clearTimeout(this._zoomTimer)
    this._observer?.disconnect()
    this._observer = null
    for (const page of this._pages) page.task?.cancel?.()
    this._pages = []
    this.container.textContent = ''
    this.doc = null
    this.layout = null
    this.pdf = null
  }

  setMode(mode) {
    this.mode = mode
    if (mode === 'off') this.clearHighlight()
    else this.highlight(this._lastSpan, this._lastSentence, { scroll: false })
  }

  /** @param {'off'|'sentence'|'paragraph'} mode */
  setFocusMode(mode) {
    this.focusMode = mode
    this._veiledRange = null
    this.highlight(this._lastSpan, this._lastSentence, { scroll: false })
  }

  /* ----------------------------------------------------------- sizing */

  /** Scale every page to the available width times the zoom; on render, resize and zoom. */
  _sizePages() {
    const available = Math.min(MAX_PAGE_WIDTH, this.scroller.clientWidth - 48) * this.zoom
    this.layout.pages.forEach((page, index) => {
      const entry = this._pages[index]
      const scale = Math.max(0.2, available / page.width)
      entry.scale = scale
      entry.el.style.width = `${Math.round(page.width * scale)}px`
      entry.el.style.height = `${Math.round(page.height * scale)}px`
      // Text run boxes in CSS pixels, relative to the page's top-left corner.
      // PDF y grows upward from the bottom; a run's y is its baseline.
      entry.items = page.items.map((it) => ({
        start: it.start,
        end: it.end,
        left: it.x * scale,
        top: (page.height - it.y - it.h * 0.82) * scale,
        width: Math.max(1, it.w * scale),
        height: it.h * 1.04 * scale,
      }))
    })
  }

  /** Re-render at the new width after a resize. */
  relayout() {
    if (!this.layout) return
    this._sizePages()
    this._veiledRange = null
    this._rerenderVisible()
    this.highlight(this._lastSpan, this._lastSentence, { scroll: false })
  }

  /**
   * Zoom the pages, keeping the spot under `anchor` (viewport coordinates; the
   * middle of the view by default) where it is. The pages resize at once, the
   * stretched canvases standing in until the sharp ones are drawn a moment after
   * the zooming stops.
   * @returns {number} the zoom actually applied
   */
  setZoom(zoom, anchor = null) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    if (Math.abs(zoom - this.zoom) < 0.001) return this.zoom
    this.zoom = zoom
    if (!this.layout) return zoom

    const view = this.scroller.getBoundingClientRect()
    const x = anchor?.x ?? view.left + view.width / 2
    const y = anchor?.y ?? view.top + view.height / 2
    // The page under the anchor (or the nearest one), and where on it the anchor falls.
    let target = null
    let best = Infinity
    for (const entry of this._pages) {
      const r = entry.el.getBoundingClientRect()
      const distance = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
      if (distance < best) {
        best = distance
        target = { entry, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height }
      }
      if (distance === 0) break
    }

    this._sizePages()
    this._veiledRange = null
    this.highlight(this._lastSpan, this._lastSentence, { scroll: false })

    if (target) {
      const r = target.entry.el.getBoundingClientRect()
      this.scroller.scrollLeft += r.left + target.fx * r.width - x
      this.scroller.scrollTop += r.top + target.fy * r.height - y
    }
    clearTimeout(this._zoomTimer)
    this._zoomTimer = setTimeout(() => this._rerenderVisible(), 180)
    return zoom
  }

  /**
   * Draw pages near the viewport at their current scale -- including ones a zoom
   * just pulled into view, which the observer may not report -- and drop the
   * canvases of the rest, which the observer redraws as they come back into reach.
   */
  _rerenderVisible() {
    const view = this.scroller.getBoundingClientRect()
    const margin = parseInt(RENDER_MARGIN, 10)
    for (const [index, entry] of this._pages.entries()) {
      const r = entry.el.getBoundingClientRect()
      const near = r.bottom > view.top - margin && r.top < view.bottom + margin
      if (near) this._renderPage(index)
      else this._releasePage(index)
    }
  }

  async _renderPage(index) {
    const entry = this._pages[index]
    if (!entry || !this.pdf) return
    const scale = entry.scale
    if (entry.drawn === scale || entry.pending === scale) return
    entry.task?.cancel?.() // superseded by a newer size
    entry.task = null
    entry.pending = scale

    try {
      const page = await this.pdf.getPage(index + 1)
      if (this._pages[index] !== entry || entry.pending !== scale) return // torn down or superseded
      const base = page.getViewport({ scale })
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)))
      const viewport = page.getViewport({ scale: scale * ratio })
      // Draw off-screen and swap, so the old picture stays up until the new one is ready.
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = '100%'
      canvas.style.height = '100%'

      const context = canvas.getContext('2d', { alpha: false })
      const task = page.render({ canvasContext: context, viewport })
      entry.task = task
      await task.promise
      if (entry.task !== task) return
      entry.canvas.replaceWith(canvas)
      entry.canvas = canvas
      entry.drawn = scale
      entry.el.classList.add('is-rendered')
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('[pageview] render failed', err)
    } finally {
      if (entry.pending === scale) {
        entry.pending = 0
        entry.task = null
      }
    }
  }

  /** Free a page's canvas once it is well out of view; big zooms add up fast. */
  _releasePage(index) {
    const entry = this._pages[index]
    if (!entry || (!entry.drawn && !entry.pending)) return
    entry.task?.cancel?.()
    entry.task = null
    entry.pending = 0
    entry.drawn = 0
    entry.canvas.width = 0
    entry.canvas.height = 0
    entry.el.classList.remove('is-rendered')
  }

  /* -------------------------------------------------------- highlight */

  /**
   * @param {{start:number,end:number}|null} span
   * @param {number} sentenceIndex
   * @param {{scroll?: boolean, smooth?: boolean}} [options]
   */
  highlight(span, sentenceIndex, options = {}) {
    const { scroll = true, smooth = true } = options
    this._lastSpan = span
    this._lastSentence = sentenceIndex
    if (!this.doc || !this.layout) return

    this._clearMarks()
    this._applyVeils(sentenceIndex)
    if (this.mode === 'off') return

    const showWord = this.mode === 'word' || this.mode === 'both'
    const showSentence = this.mode === 'sentence' || this.mode === 'both'
    const sentence = showSentence && sentenceIndex >= 0 ? this.doc.sentences[sentenceIndex] : null
    const word = showWord && span && span.end > span.start ? span : null

    let anchor = null
    if (sentence) this._paint(sentence, 'mark-sentence')
    if (word) anchor = this._paint(word, 'mark-word')
    else if (sentence) anchor = this._paint(sentence, 'mark-anchor')

    if (scroll && this.autoScroll && anchor) this._scrollIntoView(anchor, smooth)
  }

  clearHighlight() {
    for (const page of this._pages) {
      page.marks.textContent = ''
      page.veils.textContent = ''
    }
    this._veiledRange = null
  }

  _clearMarks() {
    for (const page of this._pages) page.marks.textContent = ''
  }

  /**
   * Line focus on a page: veil every text run outside the active sentence or
   * paragraph. Figures are untouched because veils exist only where text is.
   * Rebuilt only when the range changes, not on every word.
   */
  _applyVeils(sentenceIndex) {
    const sentence = sentenceIndex >= 0 ? this.doc.sentences[sentenceIndex] : null
    let range = null
    if (sentence && this.focusMode === 'sentence') range = sentence
    else if (sentence && this.focusMode === 'paragraph') range = this.doc.paragraphs[sentence.paragraph]

    const key = range ? `${range.start}:${range.end}` : ''
    if (key === this._veiledRange) return
    this._veiledRange = key

    this._pages.forEach((entry) => {
      entry.veils.textContent = ''
      if (!range) return
      const fragment = document.createDocumentFragment()
      for (const it of entry.items) {
        const inside = it.end > range.start && it.start < range.end
        if (inside) continue
        const box = document.createElement('div')
        box.className = 'mark-veil'
        box.style.left = `${it.left}px`
        box.style.top = `${it.top}px`
        box.style.width = `${it.width}px`
        box.style.height = `${it.height}px`
        fragment.appendChild(box)
      }
      entry.veils.appendChild(fragment)
    })
  }

  /** Draw boxes for every text run the range touches; returns the first box. */
  _paint(range, className) {
    let first = null
    this.layout.pages.forEach((page, pageIndex) => {
      const entry = this._pages[pageIndex]
      const items = entry.items
      if (!items.length) return
      const last = page.items[page.items.length - 1]
      if (range.start >= last.end || range.end <= page.items[0].start) return

      let i = Math.max(0, findSegmentAt(page.items, range.start))
      for (; i < items.length && items[i].start < range.end; i++) {
        const it = items[i]
        if (it.end <= range.start) continue
        const length = it.end - it.start
        if (length <= 0) continue
        const from = (Math.max(range.start, it.start) - it.start) / length
        const to = (Math.min(range.end, it.end) - it.start) / length

        const box = document.createElement('div')
        box.className = className
        box.style.left = `${it.left + it.width * from}px`
        box.style.top = `${it.top}px`
        box.style.width = `${Math.max(2, it.width * (to - from))}px`
        box.style.height = `${it.height}px`
        entry.marks.appendChild(box)
        first ??= box
      }
    })
    return first
  }

  _scrollIntoView(target, smooth) {
    const rect = target.getBoundingClientRect()
    if (!rect.height) return
    const view = this.scroller.getBoundingClientRect()
    const topBand = view.top + view.height * 0.22
    const bottomBand = view.top + view.height * 0.72
    if (rect.top >= topBand && rect.bottom <= bottomBand) return

    const delta = rect.top - (view.top + view.height * 0.32)
    const jump = Math.abs(delta) > view.height * 1.5
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    this.scroller.scrollTo({
      top: this.scroller.scrollTop + delta,
      behavior: smooth && !jump && !reduceMotion ? 'smooth' : 'auto',
    })
  }

  /* ------------------------------------------------------- hit testing */

  /** Document offset of the text run under a viewport point, or -1. */
  offsetAtPoint(x, y) {
    if (!this.layout) return -1
    const el = document.elementFromPoint(x, y)?.closest?.('.page')
    if (!el || !this.container.contains(el)) return -1
    const entry = this._pages[Number(el.dataset.page)]
    if (!entry) return -1

    const rect = el.getBoundingClientRect()
    const px = x - rect.left
    const py = y - rect.top

    // Prefer a run the point is inside; otherwise the nearest run on that line.
    let best = null
    let bestDistance = Infinity
    for (const it of entry.items) {
      const insideY = py >= it.top - 2 && py <= it.top + it.height + 2
      if (!insideY) continue
      const dx = px < it.left ? it.left - px : px > it.left + it.width ? px - (it.left + it.width) : 0
      if (dx < bestDistance) {
        bestDistance = dx
        best = it
      }
    }
    if (!best || bestDistance > 40) return -1
    const ratio = Math.min(1, Math.max(0, (px - best.left) / best.width))
    return best.start + Math.floor(ratio * (best.end - best.start))
  }
}
