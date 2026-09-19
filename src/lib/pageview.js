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

/** Widest a page is drawn, in CSS pixels; narrower windows scale down. */
const MAX_PAGE_WIDTH = 920
/** How far beyond the viewport pages are rendered ahead of time. */
const RENDER_MARGIN = '1200px 0px'

export class PageView {
  /**
   * @param {HTMLElement} container element the pages are rendered into
   * @param {HTMLElement} scroller  scrolling ancestor of `container`
   */
  constructor(container, scroller) {
    this.container = container
    this.scroller = scroller
    this.mode = 'both'
    this.autoScroll = true

    this.doc = null
    this.layout = null
    this.pdf = null
    /** @type {{el: HTMLElement, canvas: HTMLCanvasElement, marks: HTMLElement, scale: number, items: object[], rendered: boolean, task: object|null}[]} */
    this._pages = []
    this._observer = null
    this._lastSpan = null
    this._lastSentence = -1
    this._resizeTimer = 0

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
      const marks = document.createElement('div')
      marks.className = 'page-marks'
      el.append(canvas, marks)
      fragment.appendChild(el)

      this._pages.push({ el, canvas, marks, scale: 1, items: [], rendered: false, task: null })
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

  /* ----------------------------------------------------------- sizing */

  /** Scale every page to the available width; called on render and on resize. */
  _sizePages() {
    const available = Math.min(MAX_PAGE_WIDTH, this.scroller.clientWidth - 48)
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
    for (const [index, page] of this._pages.entries()) {
      if (!page.rendered) continue
      page.rendered = false
      this._renderPage(index)
    }
    this.highlight(this._lastSpan, this._lastSentence, { scroll: false })
  }

  async _renderPage(index) {
    const entry = this._pages[index]
    if (!entry || entry.rendered || entry.task || !this.pdf) return
    entry.rendered = true

    try {
      const page = await this.pdf.getPage(index + 1)
      if (!this._pages[index]) return // view was torn down meanwhile
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: entry.scale * dpr })
      entry.canvas.width = Math.floor(viewport.width)
      entry.canvas.height = Math.floor(viewport.height)
      entry.canvas.style.width = '100%'
      entry.canvas.style.height = '100%'

      const context = entry.canvas.getContext('2d', { alpha: false })
      entry.task = page.render({ canvasContext: context, viewport })
      await entry.task.promise
      entry.el.classList.add('is-rendered')
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('[pageview] render failed', err)
      entry.rendered = false
    } finally {
      entry.task = null
    }
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

    this.clearHighlight()
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
    for (const page of this._pages) page.marks.textContent = ''
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
