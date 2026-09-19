import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyVoice, filterVoices, sortVoices, baseName } from '../src/lib/voices.js'
import { whiteNoise, pinkNoise, brownNoise } from '../src/lib/noise.js'
import { Checkpoints } from '../src/lib/checkpoints.js'

/* ------------------------------------------------------------------ voices */

const v = (name, lang = 'en-US', localService = true) => ({ name, lang, localService, voiceURI: name })

test('voices: Eloquence and novelty voices are recognised in any language', () => {
  assert.equal(classifyVoice(v('Samantha')), 'natural')
  assert.equal(classifyVoice(v('Aaron')), 'natural')
  assert.equal(classifyVoice(v('Daniel', 'en-GB')), 'natural')
  assert.equal(classifyVoice(v('Eddy (English (UK))')), 'eloquence')
  assert.equal(classifyVoice(v('Grandma (Français (France))', 'fr-FR')), 'eloquence')
  assert.equal(classifyVoice(v('Shelley')), 'eloquence')
  assert.equal(classifyVoice(v('Zarvox')), 'novelty')
  assert.equal(classifyVoice(v('Bad News')), 'novelty')
  assert.equal(classifyVoice(v('Trinoids')), 'novelty')
  assert.equal(baseName('Rocko (English (US))'), 'rocko')
})

test('voices: the default list hides the bad tiers, showAll brings them back', () => {
  const all = [v('Samantha'), v('Eddy (English (US))'), v('Zarvox'), v('Google US English', 'en-US', false)]
  assert.deepEqual(filterVoices(all).map((x) => x.name), ['Samantha'])
  assert.deepEqual(filterVoices(all, { showAll: true }).map((x) => x.name), ['Samantha', 'Eddy (English (US))', 'Zarvox'])
  assert.deepEqual(filterVoices(all, { localOnly: false }).map((x) => x.name), ['Samantha', 'Google US English'])
  // No local voices at all: keep the list rather than offer nothing.
  const online = [v('Cloud A', 'en-US', false)]
  assert.equal(filterVoices(online).length, 1)
})

test('voices: downloaded Premium and Enhanced voices come first in their language', () => {
  const list = [v('Samantha'), v('Ava (Premium)'), v('Evan (Enhanced)'), v('Aaron')]
  assert.deepEqual(sortVoices(list, 'en-US').map((x) => x.name), ['Ava (Premium)', 'Evan (Enhanced)', 'Aaron', 'Samantha'])
})

test('voices: sorted with the UI language first, then the same base language', () => {
  const list = [v('Tessa', 'en-ZA'), v('Amélie', 'fr-CA'), v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Aaron', 'en-US')]
  assert.deepEqual(sortVoices(list, 'en-US').map((x) => x.name), ['Aaron', 'Samantha', 'Daniel', 'Tessa', 'Amélie'])
})

/* ------------------------------------------------------------------- noise */

const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

/** Share of the signal's energy that survives a crude low-pass (running mean). */
function lowFrequencyShare(samples, window = 64) {
  let total = 0
  let low = 0
  let acc = 0
  for (let i = 0; i < samples.length; i++) {
    acc += samples[i]
    if (i >= window) acc -= samples[i - window]
    const mean = acc / Math.min(window, i + 1)
    total += samples[i] * samples[i]
    low += mean * mean
  }
  return low / total
}

test('noise: every colour is the right length, bounded, and not silent', () => {
  for (const gen of [whiteNoise, pinkNoise, brownNoise]) {
    const s = gen(20_000, seeded(7))
    assert.equal(s.length, 20_000)
    let peak = 0
    let energy = 0
    for (const x of s) {
      peak = Math.max(peak, Math.abs(x))
      energy += x * x
    }
    assert.ok(peak <= 1, `${gen.name} clips: ${peak}`)
    assert.ok(energy / s.length > 0.01, `${gen.name} is nearly silent`)
  }
})

test('noise: colours are matched by loudness, with white held quieter for comfort', () => {
  const rms = (s) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length)
  const white = rms(whiteNoise(50_000, seeded(3)))
  const pink = rms(pinkNoise(50_000, seeded(3)))
  const brown = rms(brownNoise(50_000, seeded(3)))
  assert.ok(Math.abs(pink - brown) < 0.02, `pink ${pink.toFixed(3)} vs brown ${brown.toFixed(3)}`)
  assert.ok(white < pink * 0.7, `white ${white.toFixed(3)} should be well under pink ${pink.toFixed(3)}`)
})

test('noise: brown has more low-frequency energy than pink, which has more than white', () => {
  const white = lowFrequencyShare(whiteNoise(50_000, seeded(1)))
  const pink = lowFrequencyShare(pinkNoise(50_000, seeded(1)))
  const brown = lowFrequencyShare(brownNoise(50_000, seeded(1)))
  assert.ok(white < pink && pink < brown, `expected white(${white.toFixed(3)}) < pink(${pink.toFixed(3)}) < brown(${brown.toFixed(3)})`)
})

/* ------------------------------------------------------------- checkpoints */

test('checkpoints: prompt after the interval, pause when the prompt is missed', () => {
  const log = []
  const cp = new Checkpoints({
    intervalMs: 1000,
    graceMs: 100,
    onPrompt: () => log.push('prompt'),
    onMissed: () => log.push('missed'),
    onClear: () => log.push('clear'),
  })
  cp.start(0)
  cp.tick(999)
  assert.equal(cp.state, 'armed')
  cp.tick(1000)
  assert.equal(cp.state, 'prompting')
  assert.equal(cp.remaining(1040), 60)
  cp.tick(1100)
  assert.equal(cp.state, 'idle')
  assert.deepEqual(log, ['prompt', 'clear', 'missed'])
})

test('checkpoints: acknowledging re-arms for another full interval', () => {
  const cp = new Checkpoints({ intervalMs: 1000, graceMs: 100 })
  cp.start(0)
  cp.tick(1000)
  assert.equal(cp.acknowledge(1010), true)
  assert.equal(cp.state, 'armed')
  cp.tick(2009)
  assert.equal(cp.state, 'armed')
  cp.tick(2010)
  assert.equal(cp.state, 'prompting')
  assert.equal(cp.acknowledge(2011), true)
  assert.equal(cp.acknowledge(2012), false, 'nothing to acknowledge')
})

test('checkpoints: an interval of 0 disables everything; stop clears a prompt', () => {
  let cleared = 0
  const off = new Checkpoints({ intervalMs: 0 })
  off.start(0)
  off.tick(1e9)
  assert.equal(off.state, 'idle')

  const cp = new Checkpoints({ intervalMs: 10, onClear: () => cleared++ })
  cp.start(0)
  cp.tick(10)
  cp.stop()
  assert.equal(cp.state, 'idle')
  assert.equal(cleared, 1)
})
