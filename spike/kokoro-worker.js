/**
 * Kokoro in a worker.
 *
 * Loading the model means parsing ~310 MB of ONNX and compiling WebGPU shaders.
 * On the main thread that freezes the page for seconds -- badly enough to lock the
 * tab. Here it costs nothing visible: the reader keeps scrolling and highlighting
 * while the model warms up, and generation for the next sentence overlaps playback
 * of the current one.
 *
 * Protocol
 *   in : {type:'load', models, dtype, device}
 *        {type:'generate', id, text, voice, speed}
 *   out: {type:'progress', loaded, total} | {type:'ready', ms} | {type:'error', message}
 *        {type:'audio', id, pcm, samplingRate, ms}   (pcm buffer is transferred)
 */

import { env } from '@huggingface/transformers'

const HF_VOICES = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/'

let tts = null
let loadedWith = ''
let modelsBase = ''

/** kokoro-js hard-codes the Hugging Face URL for voice styles; serve ours instead. */
const nativeFetch = self.fetch.bind(self)
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url
  if (url && url.startsWith(HF_VOICES)) {
    return nativeFetch(`${modelsBase}kokoro-voices/${url.slice(HF_VOICES.length)}`, init)
  }
  return nativeFetch(input, init)
}

async function load({ models, dtype, device }) {
  modelsBase = models
  const want = `${dtype}:${device}`
  if (tts && loadedWith === want) {
    self.postMessage({ type: 'ready', ms: 0 })
    return
  }

  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = models
  env.backends.onnx.wasm.wasmPaths = `${models}ort/`

  const started = performance.now()
  const { KokoroTTS } = await import('kokoro-js')
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total })
      }
    },
  })
  loadedWith = want
  self.postMessage({ type: 'ready', ms: performance.now() - started })
}

async function generate({ id, text, voice, speed }) {
  const started = performance.now()
  const result = await tts.generate(text, { voice, speed })
  // Hand the samples over rather than copying them.
  const pcm = result.audio instanceof Float32Array ? result.audio : new Float32Array(result.audio)
  self.postMessage(
    { type: 'audio', id, pcm, samplingRate: result.sampling_rate, ms: performance.now() - started },
    [pcm.buffer]
  )
}

self.onmessage = async (event) => {
  const message = event.data
  try {
    if (message.type === 'load') await load(message)
    else if (message.type === 'generate') await generate(message)
  } catch (err) {
    self.postMessage({ type: 'error', id: message.id, message: String(err?.message || err) })
  }
}
