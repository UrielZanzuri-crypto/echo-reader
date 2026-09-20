/**
 * Neural voice engine: Kokoro-82M running locally, driving the same reader.
 *
 * Exposes exactly the TtsEngine interface (state, position events, transport,
 * settings), so main.js can swap it in behind the play button without knowing
 * which engine is speaking. What differs underneath:
 *
 *  - Speech is generated a chunk at a time in a Web Worker (kokoro-worker.js)
 *    and played through the Web Audio API. The next chunk is generated while the
 *    current one plays, so after the first chunk there is no gap.
 *  - The model reports no word boundaries. But once a chunk is generated we know
 *    its exact duration, so the highlight is driven by the audio clock: position
 *    = chunk start + (elapsed / duration) * chunk length. It re-anchors on every
 *    chunk (a sentence or less), so drift never exceeds a word or so.
 *  - Model loading (parsing ~310 MB and compiling GPU shaders) happens in the
 *    worker; the page never freezes for it. Progress is emitted as 'loading'.
 *
 * Nothing touches the network: weights are served from this origin (models/).
 */

import { TtsEngine } from './engine.js'

export const NEURAL_PREFIX = 'kokoro:'

/** The voices we ship. Grades are the model authors' own. */
export const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female', note: 'best rated' },
  { id: 'af_bella', name: 'Bella', lang: 'en-US', gender: 'female' },
  { id: 'af_nicole', name: 'Nicole', lang: 'en-US', gender: 'female', note: 'soft' },
  { id: 'am_michael', name: 'Michael', lang: 'en-US', gender: 'male' },
  { id: 'am_puck', name: 'Puck', lang: 'en-US', gender: 'male' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'en-US', gender: 'male' },
  { id: 'bf_emma', name: 'Emma', lang: 'en-GB', gender: 'female' },
  { id: 'bm_fable', name: 'Fable', lang: 'en-GB', gender: 'male' },
  { id: 'bm_george', name: 'George', lang: 'en-GB', gender: 'male' },
]

export function isNeuralVoice(voiceURI) {
  return typeof voiceURI === 'string' && voiceURI.startsWith(NEURAL_PREFIX)
}

/** Present a Kokoro voice the way speechSynthesis presents its own. */
function toVoice(v) {
  return {
    voiceURI: NEURAL_PREFIX + v.id,
    name: `${v.name} (neural)`,
    lang: v.lang,
    localService: true,
    default: v.id === 'af_heart',
    neural: true,
  }
}

/** Kokoro's speed input is only well-behaved in this range; beyond it we stretch the audio. */
const MODEL_SPEED_MAX = 2
const MODEL_SPEED_MIN = 0.5
/** Chunks generated ahead of the one playing. */
const LOOKAHEAD = 2
/** Generated audio kept around for seeks back and rate changes. */
const CACHE_LIMIT = 48
/** How often the highlight is advanced from the audio clock. */
const TICK_MS = 70

/**
 * A stand-in for window.speechSynthesis so the base class has something inert
 * to talk to. It never speaks; everything real happens in the worker.
 */
const silentSynth = {
  speaking: false,
  pending: false,
  paused: false,
  getVoices: () => KOKORO_VOICES.map(toVoice),
  addEventListener() {},
  speak() {},
  cancel() {},
  pause() {},
  resume() {},
}

export class NeuralEngine extends TtsEngine {
  /**
   * @param {{modelsUrl: string, quality?: 'fp32'|'q8'}} options
   *   modelsUrl - absolute URL of the models/ directory
   *   quality   - 'fp32' (best, GPU) or 'q8' (88 MB, CPU only)
   */
  constructor({ modelsUrl, quality = 'fp32' }) {
    super(silentSynth)
    this.modelsUrl = modelsUrl
    this.quality = quality
    this.settings.voiceURI = NEURAL_PREFIX + 'af_heart'

    /** 'cold' | 'loading' | 'ready' | 'failed' */
    this.modelState = 'cold'
    this._worker = null
    this._loading = null
    this._loadedFor = ''
    this._pending = new Map() // generation id -> {resolve, reject}
    this._nextId = 1
    this._cache = new Map() // "voice|speed|text" -> Promise<{pcm, rate}>

    this._ctx = null
    this._gain = null
    this._source = null
    this._previewSource = null
    this._chunkStartedAtAudio = 0
    this._chunkDuration = 0
  }

  /* ------------------------------------------------------------- model */

  /** Which backend a quality setting runs on. 8-bit hangs on WebGPU, so it is CPU only. */
  get device() {
    const gpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu)
    return this.quality === 'q8' || !gpu ? 'wasm' : 'webgpu'
  }

  setQuality(quality) {
    if (quality === this.quality) return
    this.quality = quality
    this._cache.clear()
    if (this.state !== 'idle') this.stop()
    this._loading = null
    this._loadedFor = ''
    this.modelState = 'cold'
  }

  /** Start loading the model now, so pressing play later does not wait. */
  preload() {
    return this._ensureModel().catch(() => {})
  }

  _ensureWorker() {
    if (this._worker) return this._worker
    this._worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' })
    this._worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        this._emit('loading', { phase: 'loading', ratio: data.total ? data.loaded / data.total : 0 })
      } else if (data.type === 'ready') {
        this.modelState = 'ready'
        this._emit('loading', { phase: 'ready', ratio: 1, ms: data.ms })
        this._pending.get('load')?.resolve()
        this._pending.delete('load')
      } else if (data.type === 'audio') {
        this._pending.get(data.id)?.resolve({ pcm: data.pcm, rate: data.samplingRate, ms: data.ms })
        this._pending.delete(data.id)
      } else if (data.type === 'error') {
        const waiter = this._pending.get(data.id) ?? this._pending.get('load')
        waiter?.reject(new Error(data.message))
        this._pending.delete(data.id)
        this._pending.delete('load')
      }
    }
    this._worker.onerror = (event) => {
      const err = new Error(event.message || 'worker crashed')
      for (const waiter of this._pending.values()) waiter.reject(err)
      this._pending.clear()
      this.modelState = 'failed'
      this._emit('loading', { phase: 'failed', ratio: 0, message: err.message })
    }
    return this._worker
  }

  _ensureModel() {
    const want = `${this.quality}:${this.device}`
    if (this._loading && this._loadedFor === want) return this._loading
    this._loadedFor = want
    this.modelState = 'loading'
    this._emit('loading', { phase: 'loading', ratio: 0 })
    const worker = this._ensureWorker()
    this._loading = new Promise((resolve, reject) => {
      this._pending.set('load', { resolve, reject })
      worker.postMessage({ type: 'load', models: this.modelsUrl, dtype: this.quality, device: this.device })
    }).catch((err) => {
      this.modelState = 'failed'
      this._loading = null
      this._emit('loading', { phase: 'failed', ratio: 0, message: err.message })
      throw err
    })
    return this._loading
  }

  /* ---------------------------------------------------------- generation */

  get _voiceId() {
    const uri = this.settings.voiceURI || ''
    const id = uri.startsWith(NEURAL_PREFIX) ? uri.slice(NEURAL_PREFIX.length) : uri
    return KOKORO_VOICES.some((v) => v.id === id) ? id : 'af_heart'
  }

  /** Model speed and the playback stretch that covers the rest of the range. */
  get _speeds() {
    const rate = this.settings.rate || 1
    const model = Math.min(MODEL_SPEED_MAX, Math.max(MODEL_SPEED_MIN, rate))
    return { model, stretch: rate / model }
  }

  _generate(text) {
    const { model } = this._speeds
    const key = `${this._voiceId}|${model}|${text}`
    if (this._cache.has(key)) return this._cache.get(key)

    const worker = this._ensureWorker()
    const id = this._nextId++
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      worker.postMessage({ type: 'generate', id, text, voice: this._voiceId, speed: model })
    }).catch((err) => {
      this._cache.delete(key)
      throw err
    })

    this._cache.set(key, promise)
    if (this._cache.size > CACHE_LIMIT) this._cache.delete(this._cache.keys().next().value)
    return promise
  }

  /** Warm the cache for the chunks after `index` without waiting on them. */
  _prefetch(index) {
    if (!this.doc) return
    for (let i = index; i < Math.min(index + LOOKAHEAD, this.doc.chunks.length); i++) {
      const chunk = this.doc.chunks[i]
      const text = this.doc.text.slice(chunk.start, chunk.end)
      if (/[\p{L}\p{N}]/u.test(text)) this._generate(text).catch(() => {})
    }
  }

  /* --------------------------------------------------------------- audio */

  _ensureContext() {
    if (this._ctx) return this._ctx
    const Ctx = window.AudioContext || window.webkitAudioContext
    this._ctx = new Ctx({ sampleRate: 24000 })
    this._gain = this._ctx.createGain()
    this._gain.gain.value = this.settings.volume
    this._gain.connect(this._ctx.destination)
    return this._ctx
  }

  _bufferFrom({ pcm, rate }) {
    const ctx = this._ensureContext()
    const buffer = ctx.createBuffer(1, pcm.length, rate)
    buffer.copyToChannel(pcm, 0)
    return buffer
  }

  _stopSource() {
    if (!this._source) return
    const source = this._source
    this._source = null
    source.onended = null
    try {
      source.stop()
      source.disconnect()
    } catch {
      /* already stopped */
    }
  }

  /* ----------------------------------------------------------- transport */

  /** Say one chunk, then the next; the base class decides what a chunk is. */
  async _speakChunk(index, offset = 0) {
    if (!this.doc) return
    if (index >= this.doc.chunks.length) {
      this._finish()
      return
    }
    const chunk = this.doc.chunks[index]
    const start = chunk.start + offset
    const text = this.doc.text.slice(start, chunk.end)
    if (!/[\p{L}\p{N}]/u.test(text)) {
      this._chunkIndex = index
      this._speakChunk(index + 1, 0)
      return
    }
    this._chunkIndex = index
    this._chunkStart = start
    const generation = this._generation

    try {
      await this._ensureModel()
      if (generation !== this._generation) return
      const cached = this._cache.has(`${this._voiceId}|${this._speeds.model}|${text}`)
      if (!cached) this._emit('status', { label: 'Generating speech…' })
      const audio = await this._generate(text)
      if (generation !== this._generation || this.state === 'idle') return
      this._emit('status', { label: '' })
      this._prefetch(index + 1)
      this._play(audio, start, chunk.end, generation, () => this._speakChunk(index + 1, 0))
    } catch (err) {
      if (generation !== this._generation) return
      console.error('[neural] generation failed', err)
      this._emit('error', { error: 'neural-failed', message: String(err?.message || err) })
      this._finish()
    }
  }

  _play(audio, start, end, generation, next) {
    const ctx = this._ensureContext()
    this._stopSource()
    const source = ctx.createBufferSource()
    source.buffer = this._bufferFrom(audio)
    source.playbackRate.value = this._speeds.stretch
    source.connect(this._gain)
    source.onended = () => {
      if (generation !== this._generation || this._source !== source) return
      this._source = null
      this._stopEstimator()
      this._report(end, 0, true, end)
      next()
    }
    this._source = source
    this._chunkStartedAtAudio = ctx.currentTime
    this._chunkDuration = source.buffer.duration / this._speeds.stretch
    this._lastEventAt = Date.now()

    // A paused context keeps the source queued; it starts when we resume.
    source.start()
    if (this.state === 'playing' && ctx.state === 'suspended') ctx.resume().catch(() => {})

    // Known duration -> the highlight can pace itself exactly across the chunk.
    const chars = end - start
    if (this._chunkDuration > 0.2) {
      const observed = chars / this._chunkDuration / (this.settings.rate || 1)
      this._charsPerSecond = this._charsPerSecond * 0.6 + observed * 0.4
    }
    this._anchorEstimate(start)
    this._startEstimator(end)
  }

  /** Drive the marker from the audio clock rather than the wall clock. */
  _startEstimator(limit) {
    this._stopEstimator()
    const start = this._estimateBaseChar
    const chars = limit - start
    this._estimateTimer = setInterval(() => {
      if (this.state !== 'playing' || !this._ctx || !this._chunkDuration) return
      const elapsed = this._ctx.currentTime - this._chunkStartedAtAudio
      const ratio = Math.min(1, Math.max(0, elapsed / this._chunkDuration))
      this._report(Math.floor(start + ratio * chars), 0, true, limit)
    }, TICK_MS)
  }

  pause() {
    if (this.state !== 'playing') return
    this._setState('paused')
    this._ctx?.suspend().catch(() => {})
  }

  resume() {
    if (this.state !== 'paused') return
    this._setState('playing')
    this._ctx?.resume().catch(() => {})
    // Paused before the first chunk was ready: nothing is queued, so start it.
    if (!this._source) this._restartFrom(this._resumePoint())
  }

  /** Cancel everything in flight without changing state. */
  _silence() {
    this._generation++
    this._stopTimers()
    this._stopSource()
    if (this._ctx?.state === 'suspended' && this.state !== 'paused') this._ctx.resume().catch(() => {})
  }

  /** The base class's Chrome keep-alive and stall watchdog have no meaning here. */
  _startTimers() {}

  update(partial) {
    if ('volume' in partial && this._gain) this._gain.gain.value = Math.min(1, Math.max(0, partial.volume))
    super.update(partial)
  }

  /** Say one sentence outside the reading flow, for the voice picker. */
  async preview(text) {
    await this._ensureModel()
    const audio = await this._generate(text)
    const ctx = this._ensureContext()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    try {
      this._previewSource?.stop()
    } catch {
      /* ignore */
    }
    const source = ctx.createBufferSource()
    source.buffer = this._bufferFrom(audio)
    source.connect(this._gain)
    source.start()
    this._previewSource = source
  }

  /** Release the worker and the audio context. */
  dispose() {
    this.stop()
    this._worker?.terminate()
    this._worker = null
    this._loading = null
    this._loadedFor = ''
    this.modelState = 'cold'
    this._ctx?.close().catch(() => {})
    this._ctx = null
  }
}
