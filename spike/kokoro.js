/**
 * Spike: is a neural voice worth the trouble?
 *
 * Plays the same paragraph through the Mac's Web Speech voices and through
 * Kokoro-82M running locally, so the two can be compared by ear. Throwaway code
 * -- it does not touch the reader, and it deliberately does none of the work the
 * real integration would need (word timings, streaming, pipelining).
 *
 * Everything is served from this origin: the model lives in models/ and the
 * one URL the library hard-codes is redirected below.
 */

import './spike.css'
import { env } from '@huggingface/transformers'

/** Where the vendored model tree sits, relative to this page. */
const MODELS = new URL('../models/', document.baseURI).href
const HF_VOICES = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/'

// Never reach for the network: load the model from our own server only.
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = MODELS
env.backends.onnx.wasm.wasmPaths = `${MODELS}ort/`

// kokoro-js hard-codes the Hugging Face URL for voice styles. Point it at ours.
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url
  if (url && url.startsWith(HF_VOICES)) {
    return nativeFetch(`${MODELS}kokoro-voices/${url.slice(HF_VOICES.length)}`, init)
  }
  return nativeFetch(input, init)
}

const $ = (id) => document.getElementById(id)
const els = {
  paragraph: $('paragraph'), source: $('source'), reload: $('reload'), stats: $('stats'),
  appleVoice: $('appleVoice'), appleRate: $('appleRate'), appleRateOut: $('appleRateOut'),
  speakApple: $('speakApple'), appleStatus: $('appleStatus'),
  kokoroVoice: $('kokoroVoice'), kokoroRate: $('kokoroRate'), kokoroRateOut: $('kokoroRateOut'),
  dtype: $('dtype'), device: $('device'), speakKokoro: $('speakKokoro'), loadModel: $('loadModel'),
  kokoroStatus: $('kokoroStatus'), progressWrap: $('progressWrap'), progress: $('progress'),
}

/* ---------------------------------------------------------------- paragraphs */

const FALLBACK = `What changes when you hear the words as you see them? Three things, roughly. First, the eye stops skipping: it is held to the line by a voice moving at 3.0 words per second rather than wandering ahead at 12. Second, the ear catches the shape of a sentence — its clauses, its hesitations, the small click of a semicolon — which the eye tends to flatten.`

/** Offer the paragraphs of whatever was last open in the reader (same origin, same storage). */
function loadParagraphs() {
  let paragraphs = []
  let title = 'the sample passage'
  try {
    const cached = JSON.parse(localStorage.getItem('tts-reader:document:v1') || 'null')
    if (cached?.text) {
      title = cached.title || 'your document'
      paragraphs = cached.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.split(/\s+/).length >= 12) // skip headings and stray lines
    }
  } catch {
    /* nothing cached */
  }
  if (!paragraphs.length) paragraphs = [FALLBACK]

  els.source.textContent = ''
  paragraphs.slice(0, 40).forEach((text, i) => {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = `${i + 1}. ${text.slice(0, 60)}…`
    els.source.appendChild(option)
  })
  els.source.onchange = () => setParagraph(paragraphs[Number(els.source.value)])
  els.reload.onclick = loadParagraphs
  setParagraph(paragraphs[0])
  els.stats.dataset.title = title
}

function setParagraph(text) {
  els.paragraph.value = text
  updateStats()
}

function updateStats() {
  const words = (els.paragraph.value.match(/\S+/g) || []).length
  els.stats.textContent = `${words} words · from ${els.stats.dataset.title || 'the sample'}`
}
els.paragraph.addEventListener('input', updateStats)

/* -------------------------------------------------------------- Apple voices */

function fillAppleVoices() {
  const voices = speechSynthesis.getVoices().filter((v) => v.localService && /^en/i.test(v.lang))
  if (!voices.length) return
  els.appleVoice.textContent = ''
  for (const v of voices) {
    const o = document.createElement('option')
    o.value = v.voiceURI
    o.textContent = `${v.name} — ${v.lang}`
    els.appleVoice.appendChild(o)
  }
  const preferred = voices.find((v) => /zoe/i.test(v.name)) || voices.find((v) => /samantha/i.test(v.name))
  if (preferred) els.appleVoice.value = preferred.voiceURI
}
fillAppleVoices()
speechSynthesis.addEventListener('voiceschanged', fillAppleVoices)

els.appleRate.oninput = () => (els.appleRateOut.textContent = `${(+els.appleRate.value).toFixed(2)}×`)
els.kokoroRate.oninput = () => (els.kokoroRateOut.textContent = `${(+els.kokoroRate.value).toFixed(2)}×`)

els.speakApple.onclick = () => {
  speechSynthesis.cancel()
  try {
    speechSynthesis.resume()
  } catch {
    /* ignore */
  }
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === els.appleVoice.value)
  const u = new SpeechSynthesisUtterance(els.paragraph.value)
  u.voice = voice
  u.lang = voice?.lang || 'en-US'
  u.rate = +els.appleRate.value
  const started = performance.now()
  u.onstart = () => (els.appleStatus.textContent = `Speaking with ${voice?.name}…`)
  u.onend = () => {
    els.appleStatus.textContent = `${voice?.name} · spoke for ${((performance.now() - started) / 1000).toFixed(1)}s · no generation wait`
  }
  u.onerror = (e) => (els.appleStatus.textContent = `Error: ${e.error}`)
  speechSynthesis.speak(u)
}

/* ------------------------------------------------------------------- Kokoro */

let worker = null
let ready = false
let readyFor = ''
let nextId = 1
const pending = new Map()
let audio = null

const KOKORO_VOICES = [
  ['af_heart', 'Heart — US female (best rated)'],
  ['af_bella', 'Bella — US female'],
  ['af_nicole', 'Nicole — US female, soft'],
  ['am_michael', 'Michael — US male'],
  ['am_puck', 'Puck — US male'],
  ['am_fenrir', 'Fenrir — US male'],
  ['bf_emma', 'Emma — UK female'],
  ['bm_fable', 'Fable — UK male'],
  ['bm_george', 'George — UK male'],
]
for (const [value, label] of KOKORO_VOICES) {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  els.kokoroVoice.appendChild(o)
}

/**
 * WebGPU cannot run the 8-bit weights -- inference hangs rather than failing --
 * so the two controls are not independent. Keep them consistent and say why.
 */
function reconcileDevice() {
  const gpu = els.device.value === 'webgpu'
  if (gpu && els.dtype.value === 'q8') {
    els.dtype.value = 'fp32'
    els.kokoroStatus.textContent = 'The 8-bit model only runs on the CPU, so this switched to full quality.'
  }
  els.dtype.querySelector('[value="q8"]').disabled = gpu
}

function invalidate() {
  ready = false
  els.loadModel.disabled = false
  els.loadModel.textContent = 'Load model'
  els.kokoroStatus.textContent = 'Model not loaded for this setting yet.'
}

els.device.onchange = () => {
  reconcileDevice()
  invalidate()
}
els.dtype.onchange = invalidate
reconcileDevice()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../src/lib/kokoro-worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      els.progressWrap.hidden = false
      els.progress.style.width = `${Math.round((data.loaded / data.total) * 100)}%`
      return
    }
    if (data.type === 'ready') {
      ready = true
      readyFor = `${els.dtype.value}:${els.device.value}`
      els.progressWrap.hidden = true
      els.loadModel.textContent = 'Model loaded'
      els.loadModel.disabled = true
      els.kokoroStatus.textContent = data.ms
        ? `Model ready in ${(data.ms / 1000).toFixed(1)}s — and the page stayed responsive throughout.`
        : 'Model ready.'
      pending.get('load')?.resolve()
      pending.delete('load')
      return
    }
    if (data.type === 'audio') {
      pending.get(data.id)?.resolve(data)
      pending.delete(data.id)
      return
    }
    if (data.type === 'error') {
      els.progressWrap.hidden = true
      const waiter = pending.get(data.id) || pending.get('load')
      waiter?.reject(new Error(data.message))
      pending.delete(data.id)
      pending.delete('load')
    }
  }
  return worker
}

function loadModel() {
  const want = `${els.dtype.value}:${els.device.value}`
  if (ready && readyFor === want) return Promise.resolve()
  ensureWorker()
  els.loadModel.disabled = true
  els.loadModel.textContent = 'Loading…'
  els.kokoroStatus.textContent = 'Loading the model in the background…'
  return new Promise((resolve, reject) => {
    pending.set('load', { resolve, reject })
    worker.postMessage({ type: 'load', models: MODELS, dtype: els.dtype.value, device: els.device.value })
  })
}

els.loadModel.onclick = () =>
  loadModel().catch((e) => {
    els.kokoroStatus.textContent = `Failed: ${e.message}`
    invalidate()
  })

els.speakKokoro.onclick = async () => {
  els.speakKokoro.disabled = true
  try {
    await loadModel()
    els.kokoroStatus.textContent = 'Generating…'
    const id = nextId++
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage({
        type: 'generate',
        id,
        text: els.paragraph.value,
        voice: els.kokoroVoice.value,
        speed: +els.kokoroRate.value,
      })
    })

    const generation = result.ms / 1000
    const seconds = result.pcm.length / result.samplingRate
    const summary =
      `${seconds.toFixed(1)}s of speech, generated in ${generation.toFixed(1)}s ` +
      `(${(seconds / generation).toFixed(1)}× faster than real time) on ${els.device.value}.`

    audio?.pause()
    const url = URL.createObjectURL(wavBlob(result.pcm, result.samplingRate))
    audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    try {
      await audio.play()
      els.kokoroStatus.textContent = summary
    } catch {
      els.kokoroStatus.textContent = `${summary} Click the page once, then press Speak to hear it.`
    }
  } catch (err) {
    console.error(err)
    els.kokoroStatus.textContent = `Failed: ${err?.message || err}`
    els.progressWrap.hidden = true
  } finally {
    els.speakKokoro.disabled = false
  }
}

/** Wrap raw samples in a WAV header so an <audio> element can play them. */
function wavBlob(pcm, rate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

loadParagraphs()
