import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText } from '../src/lib/normalize.js'
import { pageToText, extractPage, orderColumns, findGutters, decodeSymbolic, pickTitle, startsNewBlock, stripMarkdown, isPdf } from '../src/lib/importers.js'

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

test('pdf: superscripts and subscripts stay on their line and attach to the word', () => {
  const content = {
    items: [
      item('E = mc', 72, 700, { width: 40, height: 10 }),
      item('2', 112, 704, { width: 4, height: 6 }), // raised, smaller: superscript
      item('and', 122, 700, { width: 18, height: 10 }),
      item('σ', 146, 700, { width: 6, height: 10 }),
      item('x', 152, 697, { width: 4, height: 6 }), // lowered, smaller: subscript
      item('here.', 162, 700, { width: 28, height: 10 }),
      item('Next line.', 72, 688, { width: 60, height: 10 }),
    ],
  }
  const { text, items } = extractPage(content)
  assert.equal(text, 'E = mc² and σ_x here.\nNext line.')
  assert.deepEqual(items.map((it) => text.slice(it.start, it.end)), ['E = mc', '²', 'and', 'σ', '_x', 'here.', 'Next line.'])
})

test('pdf: a narrow gutter between columns sharing baselines is still a gutter', () => {
  // Two justified columns, same baselines, gutter only 12pt wide at 10pt type --
  // below the per-line gap threshold, so only the page-wide profile can see it.
  const items = []
  for (let row = 0; row < 8; row++) {
    const y = 700 - row * 12
    items.push(item(`left ${row} text here`, 72, y, { width: 200, height: 10 }))
    items.push(item(`right ${row} text here`, 284, y, { width: 200, height: 10 }))
  }
  const text = pageToText({ items }).replace(/\n+/g, ' | ')
  const order = text.split(' | ').map((l) => l.slice(0, 5))
  assert.deepEqual(order.slice(0, 8), Array(8).fill('left '), text)
  assert.deepEqual(order.slice(8), Array(8).fill('right'), text)
})

test('pdf: findGutters ignores margins and needs text on both sides', () => {
  const single = []
  for (let row = 0; row < 8; row++) single.push({ y: 700 - row * 12, height: 10, parts: [{ x: 72, width: 400 }] })
  assert.deepEqual(findGutters(single), [])
  const twoCol = []
  for (let row = 0; row < 8; row++) {
    twoCol.push({ y: 700 - row * 12, height: 10, parts: [{ x: 72, width: 200 }, { x: 284, width: 200 }] })
  }
  const g = findGutters(twoCol)
  assert.equal(g.length, 1)
  assert.ok(g[0].x0 >= 270 && g[0].x1 <= 286, JSON.stringify(g))
})

test('pdf: a right column that starts higher than the left is still read column by column', () => {
  // First page of a paper: title across both columns, then metadata on the left
  // (narrow, indented) and the abstract below it, while the right column starts
  // at the top. Left must be read top to bottom, then right.
  const items = [item('Neutron diffraction: a primer', 72, 760, { width: 420, height: 24 })]
  const rightRows = ['powder, time of flight', 'techniques, all of which', 'and magnetic structures.', 'cient brilliance, neutron', 'scattering, for in situ']
  const leftRows = ['https://doi.org/x', 'Received January 2', 'published online', 'Abstract: Because of the', 'neutron diffraction may be']
  const leftWidths = [120, 140, 110, 200, 200]
  for (let r = 0; r < 5; r++) {
    const y = 700 - r * 14
    items.push(item(leftRows[r], 72, y, { width: leftWidths[r], height: 10 }))
    items.push(item(rightRows[r], 300, y, { width: 200, height: 10 }))
  }
  // A couple more right-column lines below, where the left column has nothing.
  items.push(item('pressure experiments', 300, 630, { width: 200, height: 10 }))
  items.push(item('wave-like neutron', 300, 616, { width: 200, height: 10 }))
  const lines = pageToText({ items }).split(/\n+/)
  assert.equal(lines[0], 'Neutron diffraction: a primer')
  assert.deepEqual(lines.slice(1, 6), leftRows, lines.join(' | '))
  assert.deepEqual(lines.slice(6), [...rightRows, 'pressure experiments', 'wave-like neutron'], lines.join(' | '))
})

test('pdf: private-use glyphs are decoded by font (Symbol -> Greek, otherwise ASCII)', () => {
  assert.equal(decodeSymbolic('\uF061\uF020\uF0A3\uF020\uF062', 'Symbol'), 'α ≤ β')
  assert.equal(decodeSymbolic('HERMES\uF031\uF033', 'g_d0_f7'), 'HERMES13')
  assert.equal(decodeSymbolic('jrr\uF033.jaea', 'ABCDEF+Calibri'), 'jrr3.jaea')
  assert.equal(decodeSymbolic('a\uF8FFb', 'Whatever'), 'ab') // undecodable: dropped
  assert.equal(decodeSymbolic('plain', 'Symbol'), 'plain')
  const content = {
    items: [{ str: 'x \uF0B3 \uF061', transform: [10, 0, 0, 10, 72, 700], width: 40, height: 10, fontName: 'f1' }],
    styles: { f1: { fontFamily: 'Symbol' } },
  }
  assert.equal(pageToText(content), 'x ≥ α')
})
