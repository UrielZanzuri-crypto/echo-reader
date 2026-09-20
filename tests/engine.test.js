import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText } from '../src/lib/normalize.js'
import { buildDocument } from '../src/lib/segmenter.js'
import { TtsEngine } from '../src/lib/engine.js'

/* ---------------------------------------------------------------- test double */

globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text
    this.voice = null
    this.rate = 1
    this.pitch = 1
    this.volume = 1
  }
}

/**
 * A stand-in for window.speechSynthesis that reproduces the behaviours the engine
 * has to cope with. `mode` picks which kind of voice we are pretending to be:
 *   'full'     - word boundaries with charLength, like macOS in Chrome
 *   'noLength' - word boundaries without charLength, like Safari
 *   'silent'   - no boundary events at all, only start/end
 */
class FakeSynth {
  constructor(mode = 'full', stepMs = 6) {
    this.mode = mode
    this.stepMs = stepMs
    this.speaking = false
    this.pending = false
    this.paused = false
    this.spoken = [] // every string actually handed to speak()
    this._timer = null
    this._current = null
  }

  getVoices() {
    return [{ voiceURI: 'test', name: 'Test', lang: 'en-US', localService: true, default: true }]
  }

  addEventListener() {}

  speak(utterance) {
    this.spoken.push(utterance.text)
    this._current = utterance
    this.speaking = true
    const tokens = [...utterance.text.matchAll(/\S+/g)].map((m) => ({ i: m.index, len: m[0].length }))
    let k = 0
    utterance.onstart?.()
    this._timer = setInterval(() => {
      if (this.paused) return
      if (k < tokens.length) {
        if (this.mode !== 'silent') {
          const t = tokens[k]
          utterance.onboundary?.({
            name: 'word',
            charIndex: t.i,
            charLength: this.mode === 'noLength' ? undefined : t.len,
            elapsedTime: k * this.stepMs,
          })
        }
        k++
        return
      }
      this._finish()
      utterance.onend?.()
    }, this.stepMs)
  }

  _finish() {
    clearInterval(this._timer)
    this._timer = null
    this.speaking = false
    this._current = null
  }

  cancel() {
    const utterance = this._current
    this._finish()
    this.paused = false
    utterance?.onend?.() // real engines fire 'end' for the utterance they killed
  }

  pause() {
    if (this.speaking) this.paused = true
  }

  resume() {
    this.paused = false
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a condition instead of for the clock. These tests drive real timers,
 * so a fixed sleep is only as reliable as the machine is idle.
 */
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(10)
  }
  assert.fail(`timed out waiting for: ${label}`)
}

function makeDoc(text) {
  return buildDocument(normalizeText(text, { unwrap: 'never' }))
}

/** Run playback to completion (or until `ms` elapses) and collect the spans. */
async function record(engine, doc, ms) {
  const spans = []
  const off = engine.on('position', (p) => {
    if (!p.span) return
    const last = spans[spans.length - 1]
    if (last && last.start === p.span.start && last.end === p.span.end) return
    spans.push({ ...p.span, text: doc.text.slice(p.span.start, p.span.end), estimated: p.estimated })
  })
  const ended = new Promise((resolve) => engine.on('end', resolve))
  engine.play(0)
  await Promise.race([ended, wait(ms)])
  off()
  return spans
}

/* ---------------------------------------------------------------------- tests */

test('engine: highlights exactly the span the voice reports', async () => {
  const doc = makeDoc('Alpha beta gamma. Delta epsilon.')
  const synth = new FakeSynth('full')
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  const spans = await record(engine, doc, 3000)
  engine.stop()

  assert.deepEqual(
    spans.map((s) => s.text),
    ['Alpha', 'beta', 'gamma.', 'Delta', 'epsilon.']
  )
  // Positions march forward and never overlap.
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end)
})

test('engine: falls back to the word token when charLength is missing', async () => {
  const doc = makeDoc('Alpha beta gamma.')
  const engine = new TtsEngine(new FakeSynth('noLength'))
  engine.setDocument(doc)

  const spans = await record(engine, doc, 3000)
  engine.stop()

  // Without charLength the trailing period cannot be included -- word tokens only.
  assert.deepEqual(
    spans.map((s) => s.text),
    ['Alpha', 'beta', 'gamma']
  )
  assert.ok(spans.every((s) => !s.estimated))
})

test('engine: a voice with no boundary events is driven by the estimator', async () => {
  // The fake voice ticks at a lifelike pace here; the estimator assumes real
  // speech (~14.5 characters a second), so a 1ms-per-word fake would outrun it.
  const doc = makeDoc('One two three four five six seven eight nine ten eleven twelve thirteen.')
  const engine = new TtsEngine(new FakeSynth('silent', 150))
  engine.setDocument(doc)

  const spans = await record(engine, doc, 2600)
  engine.stop()

  assert.ok(spans.length > 3, `expected the estimator to move, got ${spans.length} spans`)
  // spans[0] is the seek to the start, which is a known position, not a guess.
  assert.ok(spans.slice(1).every((s) => s.estimated), 'clock-driven spans must be flagged')
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start >= spans[i - 1].start, 'estimated positions must not go backwards')
  }
})

test('engine: long text is split into chunks and all of it is spoken, in order', async () => {
  const sentence = 'This sentence is deliberately quite long so that the chunker has to divide it, '
  const doc = makeDoc(sentence.repeat(4) + 'and then it finally ends.')
  const synth = new FakeSynth('full', 1)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  await record(engine, doc, 8000)
  engine.stop()

  assert.ok(synth.spoken.length > 1, 'expected more than one utterance')
  assert.ok(synth.spoken.every((t) => t.length <= 180), 'no utterance may exceed the chunk limit')
  // Concatenating the utterances reproduces the document, modulo whitespace.
  const squash = (s) => s.replace(/\s+/g, ' ').trim()
  assert.equal(squash(synth.spoken.join(' ')), squash(doc.text))
})

test('engine: pause freezes the position and resume carries on', async () => {
  const doc = makeDoc('One two three four five six seven eight nine ten. '.repeat(8))
  const synth = new FakeSynth('full', 20)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  engine.play(0)
  await until(() => engine.charIndex > 0, 'the first word boundary')
  engine.pause()
  const frozen = engine.charIndex
  await wait(300) // a real sleep: here we are asserting that nothing happens

  assert.equal(engine.state, 'paused')
  assert.equal(synth.paused, true)
  assert.equal(engine.charIndex, frozen, 'position must not drift while paused')

  engine.resume()
  await until(() => engine.charIndex > frozen, 'progress after resuming')
  assert.equal(engine.state, 'playing')
  engine.stop()
})

test('engine: stop silences everything and emits no further positions', async () => {
  const doc = makeDoc('One two three four five six seven eight nine ten.')
  const synth = new FakeSynth('full', 20)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  engine.play(0)
  await until(() => engine.charIndex > 0, 'playback to start')
  engine.stop()

  let after = 0
  engine.on('position', () => after++)
  await wait(300)

  assert.equal(engine.state, 'idle')
  assert.equal(synth.speaking, false)
  assert.equal(engine.charIndex, 0)
  assert.equal(after, 0, 'a cancelled utterance must not keep reporting')
})

test('engine: seeking starts from the word under the requested offset', async () => {
  const doc = makeDoc('Alpha beta gamma delta epsilon.')
  const synth = new FakeSynth('full', 5)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  const target = doc.text.indexOf('gamma') + 2 // land mid-word
  engine.seek(target)
  assert.equal(engine.charIndex, doc.text.indexOf('gamma'), 'seek snaps to the word start')

  engine.play(engine.charIndex)
  await until(() => synth.spoken.length > 0, 'the first utterance')
  engine.stop()
  assert.ok(synth.spoken[0].startsWith('gamma'), `spoke "${synth.spoken[0]}"`)
})

test('engine: changing the rate mid-utterance restarts without losing the place', async () => {
  const doc = makeDoc('One two three four five six seven eight nine ten. '.repeat(8))
  const synth = new FakeSynth('full', 20)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  engine.play(0)
  await until(() => engine.charIndex > 0, 'the first word boundary')
  const before = engine.charIndex
  const spokenBefore = synth.spoken.length

  engine.update({ rate: 2.5 })
  await until(() => synth.spoken.length > spokenBefore, 'a new utterance after the rate change')

  assert.equal(engine.state, 'playing')
  assert.equal(engine.settings.rate, 2.5)
  assert.ok(engine.charIndex >= before, 'the reading position must not jump backwards')
  // The restarted utterance resumes at the word we had reached, not at the top.
  assert.ok(
    doc.text.startsWith(synth.spoken[spokenBefore], before),
    `restarted at the wrong place: "${synth.spoken[spokenBefore].slice(0, 30)}"`
  )
  engine.stop()
})

test('engine: sentence skipping moves between sentences and restarts the current one', () => {
  const doc = makeDoc('First sentence here. Second sentence here. Third sentence here.')
  const engine = new TtsEngine(new FakeSynth('full'))
  engine.setDocument(doc)

  engine.seek(doc.sentences[1].start)
  assert.equal(engine.sentenceIndex, 1)

  engine.skipSentence(1)
  assert.equal(engine.sentenceIndex, 2)

  engine.skipSentence(-1)
  assert.equal(engine.sentenceIndex, 1)

  // From the middle of a sentence, "previous" first returns to its start.
  engine.seek(doc.sentences[1].start + 10)
  engine.skipSentence(-1)
  assert.equal(engine.charIndex, doc.sentences[1].start)

  // Skipping past either end clamps instead of throwing.
  engine.skipSentence(-5)
  assert.equal(engine.sentenceIndex, 0)
  engine.skipSentence(99)
  assert.equal(engine.sentenceIndex, doc.sentences.length - 1)
  engine.stop()
})

test('engine: an empty document leaves the transport inert', () => {
  const engine = new TtsEngine(new FakeSynth('full'))
  engine.setDocument(buildDocument(''))
  engine.play()
  engine.pause()
  engine.resume()
  engine.skipSentence(1)
  assert.equal(engine.state, 'idle')
  assert.equal(engine.estimateRemaining(), 0)
  assert.equal(engine.progress, 0)
  engine.stop()
})

test('engine: chunks with no pronounceable characters are skipped', async () => {
  const doc = makeDoc('Real words here.\n\n***\n\nMore real words.')
  const synth = new FakeSynth('full', 2)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  await record(engine, doc, 4000)
  engine.stop()
  assert.ok(!synth.spoken.some((t) => t.trim() === '***'), 'a rule should never be read aloud')
  assert.ok(synth.spoken.some((t) => t.includes('More real words')))
})

test('engine: boundaries on the spoken form land on the source symbols', async () => {
  // "α + β ≤ γ" is spoken as "alpha + beta less than or equal to gamma"; a boundary
  // inside "alpha" must highlight the α in the document, not some other character.
  const doc = makeDoc('Take α + β ≤ γ and x² here.')
  const synth = new FakeSynth('full', 2)
  const engine = new TtsEngine(synth)
  engine.setDocument(doc)

  const spans = await record(engine, doc, 3000)
  engine.stop()

  const texts = spans.map((s) => s.text)
  assert.ok(synth.spoken[0].includes('alpha'), `spoke "${synth.spoken[0]}"`)
  assert.ok(synth.spoken[0].includes('squared'), 'x² should be spoken as squared')
  assert.ok(texts.includes('α'), `α never highlighted: ${texts.join(' | ')}`)
  assert.ok(texts.includes('β') && texts.includes('γ'), `β/γ never highlighted: ${texts.join(' | ')}`)
  assert.ok(texts.includes('≤'), `≤ never highlighted: ${texts.join(' | ')}`)
  assert.ok(texts.includes('x²') || texts.includes('²'), `x² never highlighted: ${texts.join(' | ')}`)
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].start, 'positions must not go backwards')
})

test('engine: readMath=false speaks the raw text', async () => {
  const doc = makeDoc('α + β.')
  const synth = new FakeSynth('full', 2)
  const engine = new TtsEngine(synth)
  engine.update({ readMath: false })
  engine.setDocument(doc)
  await record(engine, doc, 1000)
  engine.stop()
  assert.equal(synth.spoken[0], 'α + β.')
})
