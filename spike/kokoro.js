/**
 * Spike: is a neural voice worth the trouble?
 *
 * Plays the same paragraph through the Mac's Web Speech voices and through
 * Kokoro-82M running locally, so the two can be compared by ear. Throwaway code
 * -- it does not touch the reader, and it deliberately does none of the work the
 * real integration would need (word timings, streaming, pipelining).
 *
 * Everything is served from this origin: the model lives in public/models and the
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
  dtype: $('dtype'), device: $('device'), speakKokoro: $('speakKokoro'),
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

let tts = null
let loadedWith = ''
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
  const q8 = els.dtype.value === 'q8'
  if (gpu && q8) {
    els.dtype.value = 'fp16'
    els.kokoroStatus.textContent = 'The 8-bit model only runs on the CPU, so this switched to 16-bit.'
  }
  els.dtype.querySelector('[value="q8"]').disabled = gpu
}
els.device.onchange = reconcileDevice
els.dtype.onchange = reconcileDevice
reconcileDevice()

async function ensureModel() {
  const want = `${els.dtype.value}:${els.device.value}`
  if (tts && loadedWith === want) return tts

  const { KokoroTTS } = await import('kokoro-js')
  els.progressWrap.hidden = false
  els.kokoroStatus.textContent = 'Loading the model…'
  const started = performance.now()

  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: els.dtype.value,
    device: els.device.value,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        els.progress.style.width = `${Math.round((p.loaded / p.total) * 100)}%`
      }
    },
  })
  loadedWith = want
  els.progressWrap.hidden = true
  els.kokoroStatus.textContent = `Model ready in ${((performance.now() - started) / 1000).toFixed(1)}s.`
  return tts
}

els.speakKokoro.onclick = async () => {
  els.speakKokoro.disabled = true
  try {
    const model = await ensureModel()
    els.kokoroStatus.textContent = 'Generating…'
    const started = performance.now()
    const result = await model.generate(els.paragraph.value, {
      voice: els.kokoroVoice.value,
      speed: +els.kokoroRate.value,
    })
    const generation = (performance.now() - started) / 1000
    const seconds = result.audio.length / result.sampling_rate
    const summary =
      `${seconds.toFixed(1)}s of speech, generated in ${generation.toFixed(1)}s ` +
      `(${(seconds / generation).toFixed(1)}× faster than real time) on ${els.device.value}, ` +
      `${els.dtype.select ? '' : els.dtype.selectedOptions[0].textContent.split('—')[0].trim()}.`
    window.__lastRun = { generation, seconds, device: els.device.value, dtype: els.dtype.value }

    audio?.pause()
    const url = URL.createObjectURL(result.toBlob())
    audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    try {
      await audio.play()
      els.kokoroStatus.textContent = summary
    } catch {
      // Generation succeeded; only playback needs a click on this page.
      els.kokoroStatus.textContent = `${summary} Click anywhere on the page, then press Speak to hear it.`
    }
  } catch (err) {
    console.error(err)
    els.kokoroStatus.textContent = `Failed: ${err?.message || err}`
    els.progressWrap.hidden = true
  } finally {
    els.speakKokoro.disabled = false
  }
}

loadParagraphs()
