/**
 * Reader view: renders the document and paints the active word / sentence.
 *
 * Two highlighting strategies, chosen once at construction:
 *
 *  1. CSS Custom Highlight API (Chrome 105+, Safari 17.2+). Ranges are painted
 *     without touching the DOM at all -- no reflow per word, which matters at 3x
 *     where we repaint ~8 times a second.
 *  2. Span injection fallback. Only the one paragraph that contains the active
 *     sentence is rewritten; everything else is left alone.
 *
 * Either way each paragraph holds exactly ONE text node whose content is a literal
 * slice of doc.text, so a document offset converts to a DOM offset by subtracting
 * the paragraph start. That invariant is what keeps the highlight aligned.
 */

import { findSegmentAt } from './segmenter.js'

const SUPPORTS_CSS_HIGHLIGHT =
  typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function'

export class Reader {
  /**
   * @param {HTMLElement} content  element the paragraphs are rendered into
   * @param {HTMLElement} scroller scrolling ancestor of `content`
   */
  constructor(content, scroller) {
    this.content = content
    this.scroller = scroller
    this.doc = null
    this.mode = 'both' // 'word' | 'sentence' | 'both' | 'off'
    this.autoScroll = true

    /** @type {HTMLElement[]} */
    this._paragraphEls = []
    /** paragraph index currently rewritten by the fallback renderer */
    this._dirtyParagraph = -1
    this._lastSpan = null
    this._lastSentenceIndex = -1
    this._lastScrollAt = 0

    this.useCssHighlights = SUPPORTS_CSS_HIGHLIGHT
    if (this.useCssHighlights) {
      this._wordHighlight = new Highlight()
      this._sentenceHighlight = new Highlight()
      CSS.highlights.set('tts-word', this._wordHighlight)
      CSS.highlights.set('tts-sentence', this._sentenceHighlight)
    }
  }

  /** Render a document model. Pass null to clear the view. */
  render(doc) {
    this.clearHighlight()
    this.content.textContent = ''
    this._paragraphEls = []
    this._dirtyParagraph = -1
    this.doc = doc
    if (!doc) return

    const fragment = document.createDocumentFragment()
    doc.paragraphs.forEach((para, index) => {
      const el = document.createElement('p')
      el.className = 'para'
      el.dataset.index = String(index)
      el.appendChild(document.createTextNode(doc.text.slice(para.start, para.end)))
      fragment.appendChild(el)
      this._paragraphEls.push(el)
    })
    this.content.appendChild(fragment)
    this.scroller.scrollTop = 0
  }

  setMode(mode) {
    this.mode = mode
    if (mode === 'off') this.clearHighlight()
    else this.highlight(this._lastSpan, this._lastSentenceIndex, { scroll: false })
  }

  /**
   * Paint the active span and its sentence.
   * @param {{start:number,end:number}|null} span exactly what is being spoken
   * @param {number} sentenceIndex -1 for none
   * @param {{scroll?: boolean, smooth?: boolean}} [options]
   */
  highlight(span, sentenceIndex, options = {}) {
    const { scroll = true, smooth = true } = options
    this._lastSpan = span
    this._lastSentenceIndex = sentenceIndex
    if (!this.doc || this.mode === 'off') return

    const showWord = this.mode === 'word' || this.mode === 'both'
    const showSentence = this.mode === 'sentence' || this.mode === 'both'
    const word = showWord && span && span.end > span.start ? span : null
    const sentence = showSentence && sentenceIndex >= 0 ? this.doc.sentences[sentenceIndex] : null

    if (!word && !sentence) {
      this.clearHighlight()
      return
    }

    const anchor = this.useCssHighlights
      ? this._paintWithCssHighlights(word, sentence)
      : this._paintWithSpans(word, sentence)

    if (scroll && this.autoScroll && anchor) this._scrollIntoView(anchor, smooth)
  }

  clearHighlight() {
    if (this.useCssHighlights) {
      this._wordHighlight?.clear()
      this._sentenceHighlight?.clear()
    } else {
      this._restoreParagraph()
    }
  }

  /* ------------------------------------------------------ strategy 1: CSS API */

  _paintWithCssHighlights(word, sentence) {
    this._wordHighlight.clear()
    this._sentenceHighlight.clear()
    const sentenceRange = sentence ? this._range(sentence.start, sentence.end) : null
    const wordRange = word ? this._range(word.start, word.end) : null
    if (sentenceRange) this._sentenceHighlight.add(sentenceRange)
    if (wordRange) this._wordHighlight.add(wordRange)
    return wordRange || sentenceRange
  }

  /* -------------------------------------------------- strategy 2: span fallback */

  _paintWithSpans(word, sentence) {
    const anchorOffset = word || sentence
    const paragraphIndex = this._paragraphOf(anchorOffset.start)
    if (paragraphIndex < 0) return null

    if (this._dirtyParagraph !== paragraphIndex) this._restoreParagraph()

    const para = this.doc.paragraphs[paragraphIndex]
    const el = this._paragraphEls[paragraphIndex]
    if (!el) return null

    // Clip both ranges to this paragraph and convert to local offsets.
    const clip = (r) =>
      r ? [Math.max(r.start, para.start) - para.start, Math.min(r.end, para.end) - para.start] : null
    const sentenceLocal = clip(sentence)
    const wordLocal = clip(word)
    const text = this.doc.text.slice(para.start, para.end)

    const fragment = document.createDocumentFragment()
    let wordEl = null

    const makeWord = (from, to) => {
      wordEl = document.createElement('mark')
      wordEl.className = 'hl-word'
      wordEl.textContent = text.slice(from, to)
      return wordEl
    }

    if (sentenceLocal && sentenceLocal[1] > sentenceLocal[0]) {
      const [ss, se] = sentenceLocal
      fragment.appendChild(document.createTextNode(text.slice(0, ss)))
      const sentenceEl = document.createElement('span')
      sentenceEl.className = 'hl-sentence'
      if (wordLocal && wordLocal[0] >= ss && wordLocal[1] <= se && wordLocal[1] > wordLocal[0]) {
        sentenceEl.appendChild(document.createTextNode(text.slice(ss, wordLocal[0])))
        sentenceEl.appendChild(makeWord(wordLocal[0], wordLocal[1]))
        sentenceEl.appendChild(document.createTextNode(text.slice(wordLocal[1], se)))
      } else {
        sentenceEl.textContent = text.slice(ss, se)
      }
      fragment.appendChild(sentenceEl)
      fragment.appendChild(document.createTextNode(text.slice(se)))
    } else if (wordLocal && wordLocal[1] > wordLocal[0]) {
      const [ws, we] = wordLocal
      fragment.appendChild(document.createTextNode(text.slice(0, ws)))
      fragment.appendChild(makeWord(ws, we))
      fragment.appendChild(document.createTextNode(text.slice(we)))
    } else {
      return null
    }

    el.textContent = ''
    el.appendChild(fragment)
    this._dirtyParagraph = paragraphIndex
    return wordEl || el.querySelector('.hl-sentence')
  }

  /** Put the rewritten paragraph back to a single plain text node. */
  _restoreParagraph() {
    if (this._dirtyParagraph < 0 || !this.doc) return
    const para = this.doc.paragraphs[this._dirtyParagraph]
    const el = this._paragraphEls[this._dirtyParagraph]
    if (el && para) el.textContent = this.doc.text.slice(para.start, para.end)
    this._dirtyParagraph = -1
  }

  /* ------------------------------------------------------------------ geometry */

  _paragraphOf(charIndex) {
    if (!this.doc) return -1
    const i = findSegmentAt(this.doc.paragraphs, charIndex)
    return i >= 0 ? i : -1
  }

  /**
   * Build a DOM Range for a document character range.
   * Ranges that cross a paragraph boundary are clipped to the first paragraph,
   * because there is no text node spanning the gap between two <p> elements.
   */
  _range(start, end) {
    const pIndex = this._paragraphOf(start)
    if (pIndex < 0) return null
    const para = this.doc.paragraphs[pIndex]
    const el = this._paragraphEls[pIndex]
    const node = el?.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) return null

    const length = node.textContent.length
    const from = Math.max(0, Math.min(start - para.start, length))
    const to = Math.max(from, Math.min(end - para.start, length))
    if (to === from) return null

    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    return range
  }

  /** Keep the active text inside a comfortable band of the scroll container. */
  _scrollIntoView(target, smooth) {
    const rect = target.getBoundingClientRect?.()
    if (!rect || (!rect.height && !rect.width)) return
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
    this._lastScrollAt = Date.now()
  }

  /**
   * Document character offset at a viewport point, for click-to-play.
   * @returns {number} -1 when the point is not over document text.
   */
  offsetAtPoint(x, y) {
    if (!this.doc) return -1
    let node = null
    let offset = 0

    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y)
      if (pos) {
        node = pos.offsetNode
        offset = pos.offset
      }
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y)
      if (range) {
        node = range.startContainer
        offset = range.startOffset
      }
    }
    if (!node) return -1

    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    const para = el?.closest?.('.para')
    if (!para || !this.content.contains(para)) return -1
    const index = Number(para.dataset.index)
    if (!Number.isFinite(index) || !this.doc.paragraphs[index]) return -1

    // The fallback renderer may have split this paragraph into several nodes, so
    // measure the offset by walking the text nodes that precede the click.
    let local = offset
    if (node.nodeType === Node.TEXT_NODE && node.parentElement !== para) {
      local = offsetWithinParagraph(para, node, offset)
    } else if (node === para) {
      local = offsetWithinParagraph(para, node, offset)
    }
    return this.doc.paragraphs[index].start + local
  }
}

/** Characters in `para` that come before (node, offset). */
function offsetWithinParagraph(para, node, offset) {
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
  let total = 0
  let current
  while ((current = walker.nextNode())) {
    if (current === node) return total + offset
    total += current.textContent.length
  }
  return total
}

export { SUPPORTS_CSS_HIGHLIGHT }
