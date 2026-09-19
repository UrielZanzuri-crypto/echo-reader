/**
 * Segmentation: canonical text -> paragraphs, sentences, words, speech chunks.
 *
 * Every segment is a half-open range { start, end } of character indices into the
 * canonical text produced by normalize.js. The renderer draws from these ranges and
 * the speech engine reports positions in the same coordinate space, which is what
 * makes the highlighting line up.
 */

/**
 * Words whose trailing period is not a sentence end. Lower-cased, period stripped.
 * Kept deliberately short: the "next character is lower-case" rule below catches
 * most of the long tail without a dictionary.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'msgr', 'dr', 'prof', 'rev', 'hon', 'st', 'sr', 'jr', 'esq',
  'mt', 'ft', 'rd', 'blvd', 'ave', 'dept', 'univ', 'inc', 'ltd', 'co', 'corp', 'llc',
  'vs', 'etc', 'al', 'cf', 'ca', 'approx', 'est', 'fig', 'figs', 'eq', 'ref', 'no',
  'nos', 'vol', 'vols', 'pp', 'ed', 'eds', 'trans', 'ibid', 'op', 'cit', 'sec', 'ch',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k', 'u.n', 'ph.d', 'm.d', 'b.a', 'm.a', 'd.c',
])

/** Sentence terminators, plus the closers that may trail them: He said "Stop!" */
const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？'])
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '›'])

/** Matches a word, keeping internal apostrophes and hyphens: "don't", "well-known". */
const WORD_RE = /[\p{L}\p{N}]+(?:[''’‐-―-][\p{L}\p{N}]+)*/gu

/** Longest utterance we hand to the engine. See CHUNKING note in engine.js. */
export const MAX_CHUNK_CHARS = 180
/** Below this, a chunk is merged into the next one rather than spoken alone. */
const MIN_CHUNK_CHARS = 12
/** Preferred places to break an over-long sentence, best first. */
const SOFT_BREAKS = [';', ':', '—', '–', ',', ')', ']']

/**
 * Split the text into display blocks. One block per line of canonical text;
 * blank lines become spacing rather than empty blocks.
 * @returns {{start:number,end:number}[]}
 */
export function splitParagraphs(text) {
  const out = []
  const re = /[^\n]+/g
  let m
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (text.slice(start, end).trim()) out.push({ start, end })
  }
  return out
}

/** Is the token ending at `end` (exclusive) an abbreviation rather than a sentence end? */
function endsWithAbbreviation(text, end) {
  // Walk back over the token that owns the period, allowing internal dots (e.g., "i.e").
  let i = end - 1 // index of the '.'
  let j = i
  while (j > 0 && /[\p{L}\p{N}.]/u.test(text[j - 1])) j--
  const token = text.slice(j, i).toLowerCase()
  if (!token) return false
  // Single initial: "J. R. R. Tolkien", "A. Smith".
  if (/^\p{L}$/u.test(token)) return true
  // "U.S." / "e.g." arrive here as "u.s" / "e.g".
  if (ABBREVIATIONS.has(token)) return true
  if (ABBREVIATIONS.has(token.replace(/\./g, ''))) return true
  return false
}

/**
 * Split one range of text into sentences.
 * @returns {{start:number,end:number}[]}
 */
export function splitSentences(text, start = 0, end = text.length) {
  const out = []
  let cursor = start

  for (let i = start; i < end; i++) {
    const ch = text[i]
    if (!TERMINATORS.has(ch)) continue

    // Absorb repeated terminators ("...", "?!") and any closing quotes/brackets.
    let j = i
    while (j + 1 < end && TERMINATORS.has(text[j + 1])) j++
    const lastTerminator = j
    while (j + 1 < end && CLOSERS.has(text[j + 1])) j++

    const after = j + 1
    // Must be followed by whitespace or the end of the range.
    if (after < end && !/\s/.test(text[after])) {
      // 3.14 / v1.2 / example.com -- not a sentence end.
      i = j
      continue
    }

    // Abbreviation check only applies to a lone '.', never to '!'/'?'/'...'.
    if (ch === '.' && lastTerminator === i && endsWithAbbreviation(text, i + 1)) continue

    // Look at the next non-space character: a lower-case letter means the period
    // belonged to an abbreviation we do not know about.
    let k = after
    while (k < end && /\s/.test(text[k])) k++
    if (k < end && /\p{Ll}/u.test(text[k]) && ch === '.') {
      i = j
      continue
    }

    const sentenceEnd = after
    if (text.slice(cursor, sentenceEnd).trim()) {
      out.push(trimRange(text, cursor, sentenceEnd))
    }
    cursor = sentenceEnd
    i = j
  }

  if (text.slice(cursor, end).trim()) out.push(trimRange(text, cursor, end))
  return out
}

/** Shrink a range so it does not start or end on whitespace. */
function trimRange(text, start, end) {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  return { start: s, end: e }
}

/**
 * Break a sentence that is too long for one utterance into speakable chunks,
 * preferring clause punctuation, then any whitespace, then a hard cut.
 * @returns {{start:number,end:number}[]}
 */
export function chunkSentence(text, start, end, maxChars = MAX_CHUNK_CHARS) {
  const out = []
  let cursor = start

  while (end - cursor > maxChars) {
    const limit = cursor + maxChars
    let cut = -1

    for (const punct of SOFT_BREAKS) {
      // Search only the back half of the window so chunks stay reasonably even.
      const idx = text.lastIndexOf(punct, limit - 1)
      if (idx > cursor + maxChars * 0.4 && idx < limit) {
        cut = idx + 1
        break
      }
    }
    if (cut < 0) {
      const idx = text.lastIndexOf(' ', limit - 1)
      cut = idx > cursor + maxChars * 0.3 ? idx + 1 : limit
    }

    const piece = trimRange(text, cursor, cut)
    if (piece.end > piece.start) out.push(piece)
    cursor = cut
  }

  const tail = trimRange(text, cursor, end)
  if (tail.end > tail.start) {
    // Avoid a stranded two-word chunk at the end of a sentence.
    const last = out[out.length - 1]
    if (last && tail.end - tail.start < MIN_CHUNK_CHARS) last.end = tail.end
    else out.push(tail)
  }
  return out
}

/** All word ranges in the text, used to snap engine positions onto real words. */
export function splitWords(text) {
  const out = []
  WORD_RE.lastIndex = 0
  let m
  while ((m = WORD_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Build the full document model.
 * @param {string} text canonical text from normalizeText()
 * @returns {{
 *   text: string,
 *   paragraphs: {start:number,end:number,sentences:number[]}[],
 *   sentences: {start:number,end:number,paragraph:number,firstWord:number,lastWord:number}[],
 *   words: {start:number,end:number,sentence:number}[],
 *   chunks: {start:number,end:number,sentence:number}[],
 * }}
 */
export function buildDocument(text) {
  const paragraphs = splitParagraphs(text).map((p) => ({ ...p, sentences: [] }))
  const sentences = []
  const chunks = []

  paragraphs.forEach((para, pIndex) => {
    for (const s of splitSentences(text, para.start, para.end)) {
      const sIndex = sentences.length
      sentences.push({ ...s, paragraph: pIndex, firstWord: -1, lastWord: -1 })
      para.sentences.push(sIndex)
      for (const c of chunkSentence(text, s.start, s.end)) {
        chunks.push({ ...c, sentence: sIndex })
      }
    }
  })

  // Attach each word to its sentence in one merge pass (both lists are sorted).
  const words = splitWords(text)
  let si = 0
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi]
    while (si < sentences.length - 1 && w.start >= sentences[si].end) si++
    const inside = w.start >= sentences[si].start && w.start < sentences[si].end
    w.sentence = inside ? si : -1
    if (inside) {
      if (sentences[si].firstWord < 0) sentences[si].firstWord = wi
      sentences[si].lastWord = wi
    }
  }

  return { text, paragraphs, sentences, words, chunks }
}

/**
 * Index of the last segment whose start is <= pos. Returns -1 if pos precedes all.
 * Segments must be sorted and non-overlapping.
 */
export function findSegmentAt(segments, pos) {
  let lo = 0
  let hi = segments.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= pos) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * Snap an engine-reported character position onto a word.
 * Engines are inconsistent: some point at the space before a word, some land a
 * character or two inside it. So: if pos falls inside a word take that word,
 * otherwise take the next word that starts at or after pos.
 * @returns {number} word index, or -1 past the end of the text.
 */
export function findWordAt(words, pos) {
  if (!words.length) return -1
  const i = findSegmentAt(words, pos)
  if (i >= 0 && pos < words[i].end) return i
  const next = i + 1
  return next < words.length ? next : -1
}
