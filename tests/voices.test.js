import test from 'node:test'
import assert from 'node:assert/strict'
import { previewSentence } from '../src/lib/voices.js'

test('voices: the preview introduces the voice by its own name', () => {
  assert.equal(previewSentence('Heart (neural)'), "Hi, I'm Heart. Does this voice sound right to you?")
  assert.equal(previewSentence('Samantha'), "Hi, I'm Samantha. Does this voice sound right to you?")
  assert.equal(previewSentence('Eddy (English (US))'), "Hi, I'm Eddy. Does this voice sound right to you?")
  assert.equal(
    previewSentence('Microsoft Aria Online (Natural) - English (United States)'),
    "Hi, I'm Aria. Does this voice sound right to you?"
  )
})

test('voices: a voice named after a language just says hi', () => {
  assert.equal(previewSentence('Google US English'), 'Hi there. Does this voice sound right to you?')
  assert.equal(previewSentence(''), 'Hi there. Does this voice sound right to you?')
})
