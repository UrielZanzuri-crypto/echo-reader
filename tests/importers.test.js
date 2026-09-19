import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText } from '../src/lib/normalize.js'
import { pageToText, extractPage, orderColumns, pickTitle, startsNewBlock, stripMarkdown, isPdf } from '../src/lib/importers.js'

/**
 * Build a fake pdf.js text item. pdf.js reports a transform matrix
 * [a, b, c, d, e, f] where e/f are the x/y of the glyph run's baseline.
 */
const item = (str, x, y, { width, height = 10 } = {}) => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width: width ?? str.length * (height * 0.5),
  height,
})

test('pdf: lines are rebuilt from baselines, top to bottom', () => {
  const content = {
    items: [
      // Deliberately out of order; the extractor must sort by y then x.
      item('second line', 72, 700),
      item('first line', 72, 720),
      item('third line', 72, 680),
    ],
  }
  assert.equal(pageToText(content), 'first line\nsecond line\nthird line')
})

test('pdf: glyph runs on one baseline are joined, with spaces only where there is a gap', () => {
  const content = {
    items: [
      item('Hello', 72, 700, { width: 30 }),
      item('world', 108, 700, { width: 30 }), // 6pt gap -> needs a space
      item('!', 138, 700, { width: 3 }), // flush against "world" -> no space
    ],
  }
  assert.equal(pageToText(content), 'Hello world!')
})

test('pdf: a wide vertical gap becomes a paragraph break, a normal one a wrap', () => {
  const content = {
    items: [
      item('One line of a paragraph', 72, 720),
      item('and its continuation.', 72, 708), // 12pt pitch -> same paragraph
      item('A new paragraph starts.', 72, 672), // 36pt gap -> new paragraph
    ],
  }
  const raw = pageToText(content)
  assert.equal(raw, 'One line of a paragraph\nand its continuation.\n\nA new paragraph starts.')
  // normalizeText('always') then folds the wrap but keeps the paragraph break.
  assert.equal(
    normalizeText(raw, { unwrap: 'always' }),
    'One line of a paragraph and its continuation.\n\nA new paragraph starts.'
  )
})

test('pdf: items at nearly the same baseline stay on one line', () => {
  const content = { items: [item('Super', 72, 700), item('script', 100, 702.5)] }
  assert.equal(pageToText(content).split('\n').length, 1)
})

test('pdf: empty pages yield empty text', () => {
  assert.equal(pageToText({ items: [] }), '')
  assert.equal(pageToText({ items: [item('   ', 72, 700)] }), '')
})

test('pdf: a dash continuing a sentence is not mistaken for a bullet', () => {
  assert.equal(startsNewBlock('— it is only faster', 'it is not obviously better'), false)
  assert.equal(startsNewBlock('— and so it began', 'The meeting ended.'), true)
  assert.equal(startsNewBlock('• a real bullet', 'anything at all'), true)
  assert.equal(startsNewBlock('2. second item', '1. first item'), false)
  assert.equal(startsNewBlock('2. second item', 'The list begins.'), true)
})

test('pdf: a metadata title that is really a filename falls back to the real filename', () => {
  assert.equal(pickTitle('A Real Title', 'file.pdf'), 'A Real Title')
  assert.equal(pickTitle('doc.html', 'The Cost of Attention.pdf'), 'The Cost of Attention.pdf')
  assert.equal(pickTitle('Untitled', 'notes.pdf'), 'notes.pdf')
  assert.equal(pickTitle('Microsoft Word - draft', 'draft.pdf'), 'draft.pdf')
  assert.equal(pickTitle('   ', 'notes.pdf'), 'notes.pdf')
  assert.equal(pickTitle(undefined, undefined), 'Document')
})

test('markdown: syntax is stripped only from .md files', () => {
  const md = '# Heading\n\nSome **bold** and _italic_ and `code` and [a link](http://x.y).\n\n> quoted'
  const out = stripMarkdown(md, 'notes.md')
  assert.equal(out, 'Heading\n\nSome bold and italic and code and a link.\n\nquoted')
  // A .txt file keeps every character, asterisks included.
  assert.equal(stripMarkdown(md, 'notes.txt'), md)
})

test('markdown: fenced code blocks and images are removed', () => {
  const md = 'Before\n\n```js\nconst x = 1\n```\n\n![alt text](pic.png) after'
  assert.equal(stripMarkdown(md, 'a.markdown').replace(/\n{2,}/g, '\n').trim(), 'Before\nalt text after')
})

test('isPdf recognises both the MIME type and the extension', () => {
  assert.equal(isPdf({ name: 'a.pdf', type: '' }), true)
  assert.equal(isPdf({ name: 'a.PDF', type: '' }), true)
  assert.equal(isPdf({ name: 'noext', type: 'application/pdf' }), true)
  assert.equal(isPdf({ name: 'a.txt', type: 'text/plain' }), false)
})

test('pdf: every text run maps to exactly its slice of the page text', () => {
  const content = {
    items: [
      item('Hello', 72, 700, { width: 30 }),
      item('world.', 108, 700, { width: 36 }),
      item('Second line of the', 72, 688),
      item('same paragraph.', 72, 676),
      item('New paragraph.', 72, 640),
    ],
  }
  const { text, items } = extractPage(content)
  assert.equal(items.length, 5)
  assert.deepEqual(
    items.map((it) => text.slice(it.start, it.end)),
    ['Hello', 'world.', 'Second line of the', 'same paragraph.', 'New paragraph.']
  )
  // Offsets are sorted, non-overlapping, and keep the geometry of the run.
  for (let i = 1; i < items.length; i++) assert.ok(items[i].start >= items[i - 1].end)
  assert.equal(items[1].x, 108)
  // The wrap between the two lines is one character, so the caller's
  // newline-to-space fold is length-preserving.
  assert.equal(text[items[2].end], '\n')
  assert.equal(items[3].start, items[2].end + 1)
})

test('pdf: de-hyphenation keeps the offsets honest', () => {
  const content = { items: [item('inter-', 72, 700, { width: 30 }), item('national trade.', 72, 688)] }
  const { text, items } = extractPage(content)
  assert.equal(text, 'international trade.')
  assert.deepEqual(items.map((it) => text.slice(it.start, it.end)), ['inter', 'national trade.'])
})

test('pdf: two columns are read column by column, even with offset baselines', () => {
  // Left column at x=72, right column at x=320; the right column's lines sit
  // half a line lower, as columns often do.
  const content = {
    items: [
      item('A heading across the whole page width here', 72, 740, { width: 400 }),
      item('left one', 72, 700, { width: 120 }),
      item('right one', 320, 694, { width: 120 }),
      item('left two', 72, 688, { width: 120 }),
      item('right two', 320, 682, { width: 120 }),
      item('left three', 72, 676, { width: 120 }),
      item('A caption across the whole page width here', 72, 640, { width: 400 }),
    ],
  }
  const text = pageToText(content).replace(/\n+/g, ' | ')
  assert.equal(
    text,
    'A heading across the whole page width here | left one | left two | left three | right one | right two | A caption across the whole page width here'
  )
})

test('pdf: single-column pages are left in top-to-bottom order', () => {
  const lines = [
    { y: 700, height: 10, parts: [{ x: 72, width: 300 }] },
    { y: 688, height: 10, parts: [{ x: 72, width: 120 }] }, // short last line
    { y: 676, height: 10, parts: [{ x: 72, width: 300 }] },
  ]
  assert.deepEqual(orderColumns(lines).map((l) => l.y), [700, 688, 676])
})
