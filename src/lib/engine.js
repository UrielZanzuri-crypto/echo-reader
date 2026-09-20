/**
 * Speech engine: a reliable playback layer over window.speechSynthesis.
 *
 * The Web Speech API is implemented inconsistently, so this module works around
 * the failure modes that break naive implementations:
 *
 * CHUNKING      Chrome silently stops speaking after ~15 seconds of audio, and some
 *               engines truncate long strings. We never hand it more than ~180
 *               characters (see MAX_CHUNK_CHARS) and queue one utterance per chunk.
 * CANCEL RACE   cancel() fires 'end' on the utterance it kills, and speak() called
 *               immediately after cancel() is often dropped. Every utterance carries
 *               a generation token, and a re-speak is deferred one macrotask.
 * BOUNDARIES    Some voices never fire 'boundary', some fire only 'sentence', and
 *               charLength is missing on Safari. We treat boundary events as
 *               *anchors* and run a self-calibrating estimator that fills the gaps,
 *               so highlighting keeps moving no matter which voice is picked.
 * SPOKEN SPANS  A voice's idea of "a word" is not the reader's: macOS reports
 *               "Dr. E. M. Whitfield" and "9.30 a.m." as single units. When the
 *               event carries charLength we highlight exactly that span, so the
 *               marker always covers what is actually being said; without it we
 *               fall back to the word token under charIndex.
 * OFFSETS       boundary.charIndex is relative to the utterance, so it is rebased
 *               onto the document with the chunk's own start offset.
 * STALLS        If playback dies without firing 'end' (a known Chrome bug when the
 *               tab is throttled), a watchdog restarts from the last known position.
 *
 * All positions in the public API are character indices into doc.text.
 */

import { findSegmentAt, findWordAt } from './segmenter.js'
import { toSpoken } from './spoken.js'

/** Starting guess for speaking speed at rate 1.0; calibrated against real playback. */
const BASE_CHARS_PER_SECOND = 14.5
/** How often the position estimator ticks while it is filling in for boundaries. */
const ESTIMATE_INTERVAL_MS = 80
/** Chrome's watchdog: nudge the queue so long sessions do not stall. */
const KEEPALIVE_INTERVAL_MS = 9000
/** Silence longer than this while "playing" means the engine dropped our utterance. */
const STALL_TIMEOUT_MS = 2500
/** Give up restarting after this many consecutive stalls, to avoid a restart loop. */
const MAX_STALL_RECOVERIES = 3

export class TtsEngine {
  constructor(synth = window.speechSynthesis) {
    this.synth = synth
    /** @type {'idle'|'playing'|'paused'} */
    this.state = 'idle'
    this.doc = null

    this.settings = { voiceURI: '', rate: 1, pitch: 1, volume: 1, readMath: true }

    /** Character index where the currently spoken unit starts. */
    this.charIndex = 0
    /** Exact range being spoken right now, for the highlighter. */
    this.span = null
    this.wordIndex = -1
    this.sentenceIndex = -1

    this._listeners = new Map()
    this._generation = 0
    this._chunkIndex = 0
    this._chunkStart = 0 // document offset of the text passed to the current utterance
    this._utterance = null

    // Boundary support is unknown until a voice has actually spoken.
    this._wordBoundarySeen = false
    this._estimateTimer = null
    this._estimateBaseChar = 0
    this._estimateBaseTime = 0
    this._charsPerSecond = BASE_CHARS_PER_SECOND

    this._keepaliveTimer = null
    this._stallTimer = null
    this._lastEventAt = 0
    this._stallRecoveries = 0
    this._pauseWasFaked = false
    this._chunkStartedAt = 0

    this._voices = []
    this._bindVoices()
  }

  /* ------------------------------------------------------------------ events */

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
    return () => this._listeners.get(event).delete(handler)
  }

  _emit(event, payload) {
    const set = this._listeners.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[tts] listener for "${event}" threw`, err)
      }
    }
  }

  /* ------------------------------------------------------------------ voices */

  _bindVoices() {
    const load = () => {
      const voices = this.synth.getVoices() || []
      if (voices.length) {
        this._voices = voices
        this._emit('voices', voices)
      }
    }
    load()
    // Chrome populates the list asynchronously, sometimes more than once.
    this.synth.addEventListener?.('voiceschanged', load)
    if (!this._voices.length) {
      let tries = 0
      const poll = setInterval(() => {
        load()
        if (this._voices.length || ++tries > 20) clearInterval(poll)
      }, 200)
    }
  }

  getVoices() {
    return this._voices
  }

  _resolveVoice() {
    const { voiceURI } = this.settings
    if (!voiceURI) return null
    return this._voices.find((v) => v.voiceURI === voiceURI) || null
  }

  /* ---------------------------------------------------------------- document */

  /** Load a document model from segmenter.buildDocument(). Stops any playback. */
  setDocument(doc) {
    this.stop()
    this.doc = doc && doc.chunks.length ? doc : null
    this.charIndex = 0
    this.span = null
    this.wordIndex = -1
    this.sentenceIndex = -1
    this._emit('position', this._position(false))
    this._emit('state', { state: this.state })
  }

  /* ---------------------------------------------------------------- settings */

  /**
   * Change voice/rate/pitch/volume. While speaking, the current utterance is
   * restarted from the current word so the change is heard immediately instead of
   * at the next chunk (which could be seconds away).
   */
  update(partial) {
    const wasPlaying = this.state === 'playing'
    const changed = Object.entries(partial).some(([k, v]) => this.settings[k] !== v)
    Object.assign(this.settings, partial)
    if (!changed) return
    if ('rate' in partial) this._charsPerSecond = BASE_CHARS_PER_SECOND // recalibrate
    if (wasPlaying) this._restartFrom(this._resumePoint())
    else if (this.state === 'paused') this._pauseWasFaked = true // re-speak on resume
  }

  /* -------------------------------------------------------------- transport */

  /** Start (or restart) playback at a character index. */
  play(charIndex = this.charIndex) {
    if (!this.doc) return
    this._stallRecoveries = 0
    this._restartFrom(this._snap(charIndex))
  }

  toggle() {
    if (this.state === 'playing') this.pause()
    else if (this.state === 'paused') this.resume()
    else this.play()
  }

  pause() {
    if (this.state !== 'playing') return
    this._setState('paused')
    this._stopTimers()
    this._pauseWasFaked = false
    try {
      this.synth.pause()
    } catch {
      this._pauseWasFaked = true
    }
    // Verify: on some platforms pause() is a no-op inside an active utterance.
    setTimeout(() => {
      if (this.state !== 'paused') return
      if (this.synth.speaking && !this.synth.paused) {
        this._pauseWasFaked = true
        this._silence()
      }
    }, 350)
  }

  resume() {
    if (this.state !== 'paused') return
    this._setState('playing')
    if (this._pauseWasFaked) {
      this._pauseWasFaked = false
      this._restartFrom(this._resumePoint())
      return
    }
    try {
      this.synth.resume()
    } catch {
      /* falls through to the recovery check below */
    }
    this._startTimers()
    setTimeout(() => {
      if (this.state === 'playing' && !this.synth.speaking) {
        this._restartFrom(this._resumePoint())
      }
    }, 400)
  }

  stop() {
    this._silence()
    this._setState('idle')
    this._pauseWasFaked = false
    if (this.doc) {
      this.charIndex = 0
      this.span = null
      this.wordIndex = -1
      this.sentenceIndex = -1
      this._emit('position', this._position(false))
    }
  }

  /** Jump to a character index, keeping the current play/pause state. */
  seek(charIndex) {
    if (!this.doc) return
    const target = this._snap(charIndex)
    this._report(target, 0, false)
    if (this.state === 'playing') this._restartFrom(target)
    else if (this.state === 'paused') this._pauseWasFaked = true
  }

  /** Move by whole sentences. delta of -1 also acts as "restart this sentence". */
  skipSentence(delta) {
    if (!this.doc || !this.doc.sentences.length) return
    let index = this.sentenceIndex
    if (index < 0) index = Math.max(0, findSegmentAt(this.doc.sentences, this.charIndex))
    if (delta < 0 && this.charIndex > this.doc.sentences[index].start + 1) {
      // Mid-sentence: first press returns to the start of the current sentence.
      this.seek(this.doc.sentences[index].start)
      return
    }
    const next = Math.min(Math.max(index + delta, 0), this.doc.sentences.length - 1)
    this.seek(this.doc.sentences[next].start)
  }

  /** Seconds of audio left at the current rate, using the calibrated speed. */
  estimateRemaining() {
    if (!this.doc) return 0
    const left = Math.max(0, this.doc.text.length - this.charIndex)
    return left / (this._charsPerSecond * this.settings.rate)
  }

  get progress() {
    if (!this.doc || !this.doc.text.length) return 0
    return Math.min(1, this.charIndex / this.doc.text.length)
  }

  /* ---------------------------------------------------------------- internals */

  _setState(state) {
    if (this.state === state) return
    this.state = state
    this._emit('state', { state })
  }

  _position(estimated) {
    return {
      charIndex: this.charIndex,
      span: this.span,
      wordIndex: this.wordIndex,
      sentenceIndex: this.sentenceIndex,
      progress: this.progress,
      estimated,
    }
  }

  /** Snap a raw index onto the start of the word (or chunk) that owns it. */
  _snap(charIndex) {
    if (!this.doc) return 0
    const clamped = Math.max(0, Math.min(charIndex, this.doc.text.length))
    const wi = findWordAt(this.doc.words, clamped)
    if (wi >= 0) return this.doc.words[wi].start
    const ci = findSegmentAt(this.doc.chunks, clamped)
    return ci >= 0 ? this.doc.chunks[ci].start : 0
  }

  /**
   * Where playback should pick up again. The engine reports the word it is
   * *starting*, so resuming from exactly that word repeats at most one word --
   * much better than losing one.
   */
  _resumePoint() {
    if (this.wordIndex >= 0) return this.doc.words[this.wordIndex].start
    return this.charIndex
  }

  /** Cancel everything in flight without changing state. */
  _silence() {
    this._generation++
    this._stopTimers()
    if (this._utterance) {
      this._utterance.onboundary = null
      this._utterance.onend = null
      this._utterance.onerror = null
      this._utterance.onstart = null
      this._utterance = null
    }
    try {
      this.synth.cancel()
    } catch (err) {
      console.warn('[tts] cancel failed', err)
    }
  }

  _restartFrom(charIndex) {
    if (!this.doc) return
    this._silence()
    this._setState('playing')
    const target = Math.max(0, Math.min(charIndex, this.doc.text.length))
    this._report(target, 0, false)

    const chunkIndex = Math.max(0, findSegmentAt(this.doc.chunks, this.charIndex))
    const chunk = this.doc.chunks[chunkIndex]
    const offset = chunk ? Math.max(0, Math.min(target - chunk.start, chunk.end - chunk.start)) : 0
    const generation = this._generation

    // Chrome drops speak() calls issued in the same task as cancel().
    setTimeout(() => {
      if (generation !== this._generation) return
      this._speakChunk(chunkIndex, offset)
    }, 40)
  }

  /**
   * Speak one chunk, optionally starting partway in.
   * @param {number} index chunk index
   * @param {number} offset characters into the chunk to start at
   */
  _speakChunk(index, offset = 0) {
    if (!this.doc) return
    if (index >= this.doc.chunks.length) {
      this._finish()
      return
    }

    const chunk = this.doc.chunks[index]
    const start = chunk.start + offset
    const text = this.doc.text.slice(start, chunk.end)

    // Nothing pronounceable here (a stray bullet or rule) -- move on.
    if (!/[\p{L}\p{N}]/u.test(text)) {
      this._chunkIndex = index
      this._speakChunk(index + 1, 0)
      return
    }

    this._chunkIndex = index
    this._chunkStart = start

    // What the voice says can differ from what is shown (α -> "alpha"); every
    // reported position is mapped back through `spoken`.
    const spoken = toSpoken(text, { math: this.settings.readMath !== false })
    const utterance = new SpeechSynthesisUtterance(spoken.text)
    const voice = this._resolveVoice()
    if (voice) {
      utterance.voice = voice
      // Setting lang alongside the voice keeps Chrome from substituting another one.
      if (voice.lang) utterance.lang = voice.lang
    }
    utterance.rate = clamp(this.settings.rate, 0.1, 10)
    utterance.pitch = clamp(this.settings.pitch, 0, 2)
    utterance.volume = clamp(this.settings.volume, 0, 1)

    const generation = this._generation
    const alive = () => generation === this._generation && this.state !== 'idle'

    utterance.onstart = () => {
      if (!alive()) return
      this._lastEventAt = Date.now()
      this._chunkStartedAt = this._lastEventAt
      this._anchorEstimate(start)
      if (!this._wordBoundarySeen) this._startEstimator(chunk.end)
    }

    utterance.onboundary = (event) => {
      if (!alive()) return
      this._lastEventAt = Date.now()
      this._stallRecoveries = 0
      const name = event.name || 'word'
      if (name !== 'word' && name !== 'sentence') return

      const local = Number.isFinite(event.charIndex) ? event.charIndex : 0
      const global = Math.min(start + spoken.toSource(local), chunk.end)

      // charLength is the engine's own idea of how much it is about to say.
      const rawLength = Number.isFinite(event.charLength) ? event.charLength : 0
      const length = rawLength > 0 ? Math.max(0, spoken.toSourceEnd(local + rawLength) - spoken.toSource(local)) : 0

      if (name === 'word') {
        // A real word boundary: this voice supports them, the estimator can stand down.
        if (!this._wordBoundarySeen) {
          this._wordBoundarySeen = true
          this._stopEstimator()
        }
        this._report(global, length, false, chunk.end)
      } else {
        // Sentence-only voice: use the event as a fresh anchor for the estimator.
        this._anchorEstimate(global)
        if (!this._wordBoundarySeen) this._report(global, 0, true, chunk.end)
      }
    }

    utterance.onend = () => {
      if (!alive()) return
      this._lastEventAt = Date.now()
      this._calibrate(chunk.end - start)
      this._stopEstimator()
      this._speakChunk(index + 1, 0)
    }

    utterance.onerror = (event) => {
      if (!alive()) return
      // cancel()/stop() surface as errors on some engines; they are not failures.
      const reason = event.error || 'unknown'
      if (reason === 'canceled' || reason === 'interrupted') return
      console.warn('[tts] utterance error:', reason)
      this._emit('error', { error: reason })
      if (reason === 'synthesis-failed' || reason === 'audio-busy') {
        // Skip the offending chunk rather than dying on it.
        this._speakChunk(index + 1, 0)
      } else {
        this._finish()
      }
    }

    this._utterance = utterance
    this._lastEventAt = Date.now()
    this._startTimers()
    // A cancel() issued while paused leaves Chrome's queue paused for good, and
    // every later speak() then waits in silence. Clearing it costs nothing.
    if (this.synth.paused) {
      try {
        this.synth.resume()
      } catch {
        /* ignore */
      }
    }
    try {
      this.synth.speak(utterance)
    } catch (err) {
      console.error('[tts] speak failed', err)
      this._emit('error', { error: 'speak-failed' })
      this._finish()
    }
  }

  _finish() {
    this._silence()
    this._setState('idle')
    this._emit('end', {})
  }

  /**
   * Publish a position.
   * @param {number} charIndex where the engine says it is
   * @param {number} charLength how much it is about to speak (0 when unknown)
   * @param {boolean} estimated true when this came from the clock, not the engine
   * @param {number} [limit] end of the current chunk, so a span cannot overshoot
   */
  _report(charIndex, charLength, estimated, limit = this.doc.text.length) {
    if (!this.doc) return
    // Never move backwards inside a chunk; some engines repeat a boundary.
    if (estimated && charIndex < this.charIndex) return

    const text = this.doc.text
    let start = Math.max(0, Math.min(charIndex, text.length))
    let length = charLength

    // Some engines point at the whitespace before the word rather than at it.
    while (start < text.length && /\s/.test(text[start])) {
      start++
      if (length > 0) length--
    }

    this.charIndex = start
    this._updateIndices(start)

    let end = length > 0 ? Math.min(start + length, limit) : 0
    if (end <= start) {
      // No usable length: highlight the word token the position lands on.
      const word = this.wordIndex >= 0 ? this.doc.words[this.wordIndex] : null
      end = word ? Math.min(word.end, limit) : Math.min(start + 1, text.length)
      if (word) start = Math.max(word.start, Math.min(start, word.start))
    }
    // Trailing space would make the marker look ragged; trailing punctuation is spoken.
    while (end > start && /\s/.test(text[end - 1])) end--

    this.span = end > start ? { start, end } : null
    this._emit('position', this._position(estimated))
  }

  _updateIndices(charIndex) {
    const wi = findWordAt(this.doc.words, charIndex)
    this.wordIndex = wi
    if (wi >= 0 && this.doc.words[wi].sentence >= 0) {
      this.sentenceIndex = this.doc.words[wi].sentence
    } else {
      this.sentenceIndex = findSegmentAt(this.doc.sentences, charIndex)
    }
  }

  /* -------------------------------------------------- position estimation */

  _anchorEstimate(charIndex) {
    this._estimateBaseChar = charIndex
    this._estimateBaseTime = Date.now()
  }

  /** Drive highlighting from the clock when the voice will not report words. */
  _startEstimator(limit) {
    this._stopEstimator()
    this._estimateTimer = setInterval(() => {
      if (this.state !== 'playing') return
      const elapsed = (Date.now() - this._estimateBaseTime) / 1000
      const speed = this._charsPerSecond * this.settings.rate
      const estimated = Math.min(this._estimateBaseChar + elapsed * speed, limit)
      this._report(Math.floor(estimated), 0, true, limit)
    }, ESTIMATE_INTERVAL_MS)
  }

  _stopEstimator() {
    if (this._estimateTimer) {
      clearInterval(this._estimateTimer)
      this._estimateTimer = null
    }
  }

  /**
   * Learn the real speaking speed from a finished chunk so both the estimator and
   * the "time remaining" readout converge on this voice's actual pace.
   */
  _calibrate(chars) {
    const seconds = (Date.now() - this._chunkStartedAt) / 1000
    if (seconds < 0.4 || chars < 40) return
    const observed = chars / seconds / this.settings.rate
    if (!Number.isFinite(observed) || observed < 3 || observed > 60) return
    this._charsPerSecond = this._charsPerSecond * 0.7 + observed * 0.3
  }

  /* ------------------------------------------------------- keepalive + stalls */

  _startTimers() {
    this._stopTimers(false)
    // Chrome pauses its own queue on long sessions; resume() is a no-op otherwise.
    this._keepaliveTimer = setInterval(() => {
      if (this.state !== 'playing') return
      if (this.synth.speaking && !this.synth.paused) {
        try {
          this.synth.resume()
        } catch {
          /* ignore */
        }
      }
    }, KEEPALIVE_INTERVAL_MS)

    this._stallTimer = setInterval(() => {
      if (this.state !== 'playing') return
      const quiet = Date.now() - this._lastEventAt
      if (quiet < STALL_TIMEOUT_MS) return
      if (this.synth.speaking || this.synth.pending) {
        // Still producing audio, just a voice that fires no events. Not a stall.
        this._lastEventAt = Date.now()
        return
      }
      if (this._stallRecoveries >= MAX_STALL_RECOVERIES) {
        console.warn('[tts] giving up after repeated stalls')
        this._emit('error', { error: 'stalled' })
        this._finish()
        return
      }
      this._stallRecoveries++
      console.warn('[tts] playback stalled, restarting from', this.charIndex)
      this._restartFrom(this._resumePoint())
    }, 1000)
  }

  _stopTimers(includeEstimator = true) {
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer)
    if (this._stallTimer) clearInterval(this._stallTimer)
    this._keepaliveTimer = null
    this._stallTimer = null
    if (includeEstimator) this._stopEstimator()
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

/** True when this browser exposes the Web Speech synthesis API at all. */
export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}
