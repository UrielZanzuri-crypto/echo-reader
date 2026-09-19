import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, looksHardWrapped } from '../src/lib/normalize.js'
import {
  buildDocument,
  splitSentences,
  splitWords,
  chunkSentence,
  findWordAt,
  findSegmentAt,
} from '../src/lib/segmenter.js'

const slice = (text, ranges) => ranges.map((r) => text.slice(r.start, r.end))

test('normalize: line endings, invisible characters and spacing', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb')
  assert.equal(normalizeText('a​b'), 'ab')
  assert.equal(normalizeText('a b'), 'a b')
  assert.equal(normalizeText('a   b'), 'a b')
  assert.equal(normalizeText('a\n\n\n\n\nb'), 'a\n\nb')
  assert.equal(normalizeText('  \n\nhello  \n\n  '), 'hello')
})

test('normalize: de-hyphenates words broken across lines', () => {
  assert.equal(normalizeText('inter-\nnational', { unwrap: 'never' }), 'international')
  // A real hyphenated compound followed by a capital must survive.
  assert.equal(normalizeText('well-\nKnown', { unwrap: 'never' }), 'well-\nKnown')
})

test('normalize: unwrap modes', () => {
  const wrapped = 'one\ntwo\n\nthree'
  assert.equal(normalizeText(wrapped, { unwrap: 'always' }), 'one two\n\nthree')
  assert.equal(normalizeText(wrapped, { unwrap: 'never' }), 'one\ntwo\n\nthree')
})

test('normalize: hard-wrap detection', () => {
  const hard = Array.from(
    { length: 6 },
    () => 'the quick brown fox jumps over the lazy dog and keeps running along'
  ).join('\n')
  assert.equal(looksHardWrapped(hard), true)
  assert.equal(looksHardWrapped('Short one.\nShort two.\n\nShort three.'), false)
})

test('sentences: basic terminators', () => {
  const t = 'One. Two! Three? Four.'
  assert.deepEqual(slice(t, splitSentences(t)), ['One.', 'Two!', 'Three?', 'Four.'])
})

test('sentences: abbreviations do not split', () => {
  const t = 'Dr. Smith met Mr. Jones at 4 p.m. on Tuesday. Then he left.'
  assert.deepEqual(slice(t, splitSentences(t)), [
    'Dr. Smith met Mr. Jones at 4 p.m. on Tuesday.',
    'Then he left.',
  ])
})

test('sentences: initials, decimals, urls, ellipsis', () => {
  const t1 = 'J. R. R. Tolkien wrote it. He did.'
  assert.deepEqual(slice(t1, splitSentences(t1)), ['J. R. R. Tolkien wrote it.', 'He did.'])

  const t2 = 'It costs 3.50 today. Tomorrow more.'
  assert.deepEqual(slice(t2, splitSentences(t2)), ['It costs 3.50 today.', 'Tomorrow more.'])

  const t3 = 'Visit example.com for details. Thanks.'
  assert.deepEqual(slice(t3, splitSentences(t3)), ['Visit example.com for details.', 'Thanks.'])

  const t4 = 'He paused... Then he spoke.'
  assert.deepEqual(slice(t4, splitSentences(t4)), ['He paused...', 'Then he spoke.'])
})

test('sentences: quotes and brackets stay attached', () => {
  const t = 'She said "Stop!" He froze. (He really did.) Then nothing.'
  assert.deepEqual(slice(t, splitSentences(t)), [
    'She said "Stop!"',
    'He froze.',
    '(He really did.)',
    'Then nothing.',
  ])
})

test('sentences: an unknown abbreviation before a lower-case word does not split', () => {
  const t = 'Approx. seventy people came. Nobody left.'
  assert.deepEqual(slice(t, splitSentences(t)), ['Approx. seventy people came.', 'Nobody left.'])
})

test('sentences: ranges never include surrounding whitespace', () => {
  const t = 'One.   Two.'
  for (const r of splitSentences(t)) {
    const s = t.slice(r.start, r.end)
    assert.equal(s, s.trim())
  }
})

test('chunking: long sentences break at clause punctuation and stay in bounds', () => {
  const t =
    'This is a long opening clause that runs on for a while, and then it continues past ' +
    'the limit with more words; finally it reaches an end after quite some distance indeed.'
  const chunks = chunkSentence(t, 0, t.length, 60)
  assert.ok(chunks.length > 2)
  for (const c of chunks) assert.ok(c.end - c.start <= 60, `chunk too long: ${c.end - c.start}`)
  // Chunks must tile the sentence in order, losing only whitespace.
  assert.equal(chunks[0].start, 0)
  assert.equal(chunks[chunks.length - 1].end, t.length)
  assert.equal(slice(t, chunks).join(' ').replace(/\s+/g, ' '), t.replace(/\s+/g, ' '))
})

test('chunking: short sentences are left alone', () => {
  const t = 'Short sentence.'
  assert.deepEqual(chunkSentence(t, 0, t.length), [{ start: 0, end: t.length }])
})

test('words: apostrophes and hyphens stay inside one word', () => {
  const t = "It's a well-known fact, isn't it?"
  assert.deepEqual(slice(t, splitWords(t)), ["It's", 'a', 'well-known', 'fact', "isn't", 'it'])
})

test('words: unicode letters and numbers', () => {
  const t = 'Café 42 naïve Ünicode'
  assert.deepEqual(slice(t, splitWords(t)), ['Café', '42', 'naïve', 'Ünicode'])
})

test('document: paragraphs, sentences, words and chunks all line up', () => {
  const text = normalizeText('First para. It has two sentences.\n\nSecond para here.')
  const doc = buildDocument(text)

  assert.equal(doc.paragraphs.length, 2)
  assert.deepEqual(slice(text, doc.sentences), [
    'First para.',
    'It has two sentences.',
    'Second para here.',
  ])
  assert.deepEqual(doc.paragraphs[0].sentences, [0, 1])
  assert.deepEqual(doc.paragraphs[1].sentences, [2])

  // Every word belongs to the sentence that contains it.
  for (const w of doc.words) {
    const s = doc.sentences[w.sentence]
    assert.ok(s && w.start >= s.start && w.end <= s.end)
  }
  // Every chunk lies inside its sentence, and chunks cover every sentence.
  const covered = new Set()
  for (const c of doc.chunks) {
    const s = doc.sentences[c.sentence]
    assert.ok(c.start >= s.start && c.end <= s.end)
    covered.add(c.sentence)
  }
  assert.equal(covered.size, doc.sentences.length)
  // firstWord/lastWord point at the real edges of each sentence.
  assert.equal(text.slice(doc.words[doc.sentences[1].firstWord].start), 'It has two sentences.\n\nSecond para here.')
})

test('lookup: findWordAt snaps engine positions onto words', () => {
  const text = 'Alpha beta gamma'
  const words = splitWords(text)
  assert.equal(findWordAt(words, 0), 0) // exact start
  assert.equal(findWordAt(words, 2), 0) // inside a word
  assert.equal(findWordAt(words, 5), 1) // on the space before "beta"
  assert.equal(findWordAt(words, 6), 1) // start of "beta"
  assert.equal(findWordAt(words, 15), 2) // last character
  assert.equal(findWordAt(words, 99), -1) // past the end
  assert.equal(findWordAt([], 0), -1)
})

test('lookup: findSegmentAt is a correct predecessor search', () => {
  const segs = [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
    { start: 20, end: 25 },
  ]
  assert.equal(findSegmentAt(segs, 0), 0)
  assert.equal(findSegmentAt(segs, 7), 0)
  assert.equal(findSegmentAt(segs, 10), 1)
  assert.equal(findSegmentAt(segs, 100), 2)
  assert.equal(findSegmentAt(segs, -1), -1)
})

test('document: survives odd input without throwing', () => {
  for (const input of ['', '   ', '\n\n\n', '...', '!!!', 'no terminator at all']) {
    const doc = buildDocument(normalizeText(input))
    assert.ok(Array.isArray(doc.chunks))
  }
})
