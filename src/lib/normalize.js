/**
 * Text normalization.
 *
 * Everything downstream (segmentation, highlighting, speech offsets) addresses
 * characters by index into ONE canonical string. So normalization happens exactly
 * once, up front, and the result is the single source of truth. Never re-clean
 * text after this point or the indices stop matching what is on screen.
 */

/** Characters that are invisible or that confuse the speech engines. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const SOFT_HYPHEN = /­/g
const WEIRD_SPACE = /[   -   　]/g

/** A line that ends a paragraph usually ends with one of these. */
const TERMINAL_END = /[.!?…:;"'”’)\]]\s*$/

/**
 * Does this look like a hard-wrapped document (a .txt wrapped at ~72 columns)?
 * Only lines that are followed by another non-blank line are considered, since a
 * paragraph's last line is short by definition and would skew the ratio.
 */
export function looksHardWrapped(text) {
  const lines = text.split('\n')
  let candidates = 0
  let wrapped = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim()
    const next = lines[i + 1].trim()
    if (!line || !next) continue // paragraph break, not a wrap point
    candidates++
    if (line.length >= 40 && line.length <= 110 && !TERMINAL_END.test(line)) wrapped++
  }
  return candidates >= 4 && wrapped / candidates >= 0.6
}

/**
 * The character-level part of normalization, for callers that must keep their
 * own offsets (the PDF extractor cleans each text run with this before it
 * measures it, so the canonical text and the page geometry stay in step).
 */
export function cleanInline(str) {
  return String(str)
    .replace(ZERO_WIDTH, '')
    .replace(SOFT_HYPHEN, '')
    .replace(WEIRD_SPACE, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * @param {string} raw
 * @param {{unwrap?: 'auto'|'always'|'never', dehyphenate?: boolean}} [options]
 *   unwrap - join the lines inside a paragraph into one flowing line.
 *            'always' for PDF extraction (we control the line breaks there),
 *            'auto' for pasted text / .txt (heuristic).
 * @returns {string} canonical text: paragraphs separated by "\n\n", no \r, no tabs.
 */
export function normalizeText(raw, options = {}) {
  const { unwrap = 'auto', dehyphenate = true } = options
  if (!raw) return ''

  let text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(SOFT_HYPHEN, '')
    .replace(WEIRD_SPACE, ' ')
    .replace(/\t/g, '    ')

  // "inter-\nnational" -> "international". Done before unwrapping, while the
  // line break that caused the hyphenation is still there to key off.
  if (dehyphenate) {
    text = text.replace(/(\p{Ll})-\n(?=\p{Ll})/gu, '$1')
  }

  // Trailing spaces would otherwise become visible gaps at the end of a line.
  text = text.replace(/[ ]+$/gm, '')

  const shouldUnwrap = unwrap === 'always' || (unwrap === 'auto' && looksHardWrapped(text))
  if (shouldUnwrap) {
    // A single newline is a wrap; two or more is a real paragraph break.
    text = text.replace(/([^\n])\n(?!\n)/g, '$1 ')
  }

  return text
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}
