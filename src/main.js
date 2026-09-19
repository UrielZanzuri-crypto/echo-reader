/**
 * Echo Reader — application wiring.
 *
 * Owns the DOM, the settings, and the flow of events between the three parts that
 * do the real work: segmenter.js (text -> ranges), engine.js (speech + positions)
 * and reader.js (rendering + highlighting). Nothing here talks to the network.
 */

import './styles.css'
import { normalizeText } from './lib/normalize.js'
import { buildDocument } from './lib/segmenter.js'
import { TtsEngine, isSpeechSupported } from './lib/engine.js'
import { Reader } from './lib/reader.js'
import { PageView } from './lib/pageview.js'
import { importFile, isPdf } from './lib/importers.js'
import { loadSettings, saveSettings, loadDocument, saveDocument, DEFAULT_SETTINGS } from './lib/store.js'
import { SAMPLE_TEXT, SAMPLE_TITLE } from './lib/sample.js'
import { classifyVoice, filterVoices, sortVoices, PREVIEW_SENTENCE } from './lib/voices.js'
import { NoisePlayer, NOISE_COLOURS } from './lib/noise.js'
import { Checkpoints } from './lib/checkpoints.js'

const $ = (id) => document.getElementById(id)

const el = {
  app: document.querySelector('.app'),
  scroller: $('scroller'),
  content: $('content'),
  pages: $('pages'),
  btnView: $('btnView'),
  empty: $('empty'),
  docTitle: $('docTitle'),

  btnOpen: $('btnOpen'),
  btnEditor: $('btnEditor'),
  btnSettings: $('btnSettings'),
  fileInput: $('fileInput'),

  btnPlay: $('btnPlay'),
  btnStop: $('btnStop'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressKnob: $('progressKnob'),
  timeLabel: $('timeLabel'),
  statusLabel: $('statusLabel'),
  voiceSelect: $('voiceSelect'),
  btnPreview: $('btnPreview'),
  btnNoise: $('btnNoise'),
  showAllVoices: $('showAllVoices'),
  noiseColour: $('noiseColour'),
  noiseVolume: $('noiseVolume'),
  noiseVolumeValue: $('noiseVolumeValue'),
  focusMode: $('focusMode'),
  checkpointMinutes: $('checkpointMinutes'),
  pauseWhenAway: $('pauseWhenAway'),
  checkpoint: $('checkpoint'),
  rateSlider: $('rateSlider'),
  rateValue: $('rateValue'),

  editorOverlay: $('editorOverlay'),
  editorText: $('editorText'),
  editorStats: $('editorStats'),
  editorApply: $('editorApply'),
  editorClear: $('editorClear'),

  settingsOverlay: $('settingsOverlay'),
  localOnly: $('localOnly'),
  voiceHint: $('voiceHint'),
  pitchSlider: $('pitchSlider'),
  pitchValue: $('pitchValue'),
  volumeSlider: $('volumeSlider'),
  volumeValue: $('volumeValue'),
  highlightMode: $('highlightMode'),
  autoScroll: $('autoScroll'),
  themeMode: $('themeMode'),
  fontFamily: $('fontFamily'),
  fontSize: $('fontSize'),
  fontSizeValue: $('fontSizeValue'),
  lineHeight: $('lineHeight'),
  lineHeightValue: $('lineHeightValue'),
  columnWidth: $('columnWidth'),
  columnWidthValue: $('columnWidthValue'),
  btnReset: $('btnReset'),

  drop: $('drop'),
  toast: $('toast'),
  busy: $('busy'),
  busyLabel: $('busyLabel'),
  emptyPaste: $('emptyPaste'),
  emptyOpen: $('emptyOpen'),
  emptySample: $('emptySample'),
}

const settings = loadSettings()
const engine = new TtsEngine()
const reader = new Reader(el.content, el.scroller)
const pageView = new PageView(el.pages, el.scroller)
/** Whichever of the two is on screen; both share one interface. */
let view = reader

/** @type {{text: string, title: string, model: ReturnType<typeof buildDocument>, layout?: object|null, pdf?: object|null}|null} */
let current = null
let pendingPosition = null // coalesced into one paint per animation frame
let paintQueued = false
let toastTimer = null
let scrubbing = false

const noise = new NoisePlayer()
/** Where play should resume from after a missed check-in or a switch away; -1 = nowhere. */
let rewindTo = -1
let checkpoints = null
let checkpointTimer = 0
let fileDialogUntil = 0 // ignore the window blur our own file picker causes

/* ────────────────────────────────── boot ─────────────────────────────────── */

function boot() {
  applyTheme()
  applyTypography()
  bindControls()
  bindSettings()
  bindKeyboard()
  bindDragAndDrop()
  bindEngine()

  engine.update({
    voiceURI: settings.voiceURI,
    rate: settings.rate,
    pitch: settings.pitch,
    volume: settings.volume,
  })
  view.setMode(settings.highlightMode)
  view.autoScroll = settings.autoScroll
  applyFocusMode()
  setupCheckpoints()
  bindAwayGuard()
  updateNoiseButton()

  if (!isSpeechSupported()) {
    setStatus('Speech synthesis is unavailable in this browser')
    toast('This browser has no Web Speech API. Try Chrome, Edge or Safari.', 'error', 8000)
    for (const b of [el.btnPlay, el.btnStop, el.btnPrev, el.btnNext]) b.disabled = true
  }

  const cached = loadDocument()
  if (cached) {
    setDocument(cached.text, cached.title, { restore: cached.charIndex || 0, cache: false })
  } else {
    updateEmptyState()
  }
  updateTransport()
}

/* ───────────────────────────────── document ──────────────────────────────── */

/**
 * Install a new document: normalize once, segment once, render, load the engine.
 * @param {string} raw
 * @param {string} title
 * @param {{restore?: number, cache?: boolean, unwrap?: 'auto'|'always'|'never', layout?: object|null, pdf?: object|null}} [options]
 *   layout/pdf - page geometry and the open pdf.js document, for the page view.
 */
function setDocument(raw, title, options = {}) {
  const { restore = 0, cache = true, unwrap = 'auto', layout = null, pdf = null } = options
  const text = normalizeText(raw, { unwrap })

  if (!text.trim()) {
    toast('That file had no readable text in it.', 'error')
    return
  }

  const model = buildDocument(text)
  // The previous PDF, if any, can be released now.
  current?.pdf?.destroy?.().catch?.(() => {})
  current = { text, title, model, layout, pdf }

  reader.render(model)
  pageView.render(layout && pdf ? model : null, layout, pdf)
  setView(layout && pdf && settings.pdfView === 'page' ? 'page' : 'text')
  engine.setDocument(model)
  el.docTitle.textContent = title || 'Untitled'
  document.title = title ? `${title} — Echo Reader` : 'Echo Reader'

  if (restore > 0 && restore < text.length) {
    engine.seek(restore)
    // seek() does not scroll on its own, so bring the saved spot into view.
    requestAnimationFrame(() =>
      view.highlight(engine.span, engine.sentenceIndex, { scroll: true, smooth: false })
    )
  }

  if (cache) saveDocument({ text, title, charIndex: restore })
  updateEmptyState()
  updateTransport()
  updateProgress()
}

/**
 * Show the rendered pages or the plain text. Both views stay in sync with the
 * engine; only one is visible and receives the highlight.
 */
function setView(name) {
  const hasPages = Boolean(current?.layout && current?.pdf)
  const usePages = name === 'page' && hasPages
  view = usePages ? pageView : reader
  view.setMode(settings.highlightMode)
  view.setFocusMode(settings.focusMode)
  view.autoScroll = settings.autoScroll
  ;(usePages ? reader : pageView).clearHighlight()

  el.content.hidden = !current || usePages
  el.pages.hidden = !current || !usePages
  el.btnView.hidden = !hasPages
  el.btnView.setAttribute('aria-pressed', String(usePages))
  el.btnView.title = usePages ? 'Show as plain text (V)' : 'Show the PDF pages (V)'
  el.btnView.querySelector('span').textContent = usePages ? 'Plain text' : 'Pages'

  if (current) view.highlight(engine.span, engine.sentenceIndex, { scroll: true, smooth: false })
}

function toggleView() {
  if (!current?.layout) return
  settings.pdfView = view === pageView ? 'text' : 'page'
  saveSettings(settings)
  setView(settings.pdfView)
}

function updateEmptyState() {
  const hasDoc = Boolean(current)
  el.empty.hidden = hasDoc
  el.content.hidden = !hasDoc || view === pageView
  el.pages.hidden = !hasDoc || view !== pageView
  if (!hasDoc) {
    el.docTitle.textContent = 'No document'
    document.title = 'Echo Reader'
  }
}

function updateTransport() {
  const ready = Boolean(current) && isSpeechSupported()
  for (const b of [el.btnPlay, el.btnStop, el.btnPrev, el.btnNext]) b.disabled = !ready
}

/* ───────────────────────────── file + text input ─────────────────────────── */

async function openFile(file) {
  if (!file) return
  const heavy = isPdf(file)
  showBusy(heavy ? 'Reading PDF…' : 'Reading file…')
  try {
    const result = await importFile(file, (progress) => {
      if (progress.detail) showBusy(progress.detail)
    })
    engine.stop()
    // The importers already return canonical text, so do not re-wrap it here.
    setDocument(result.text, result.title, { unwrap: 'never', layout: result.layout, pdf: result.pdf })
    if (result.pdf && !result.layout) toast('Page view is unavailable for this PDF; showing text.', 'info', 4000)
    el.editorText.value = current ? current.text : ''
    updateEditorStats()
    const pages = result.pages ? ` · ${result.pages} page${result.pages === 1 ? '' : 's'}` : ''
    toast(`Loaded ${result.title}${pages}`)
  } catch (error) {
    console.error(error)
    const message = /password/i.test(String(error?.message))
      ? 'That PDF is password protected.'
      : `Could not read that file: ${error?.message || error}`
    toast(message, 'error', 6000)
  } finally {
    hideBusy()
  }
}

function applyEditorText() {
  const raw = el.editorText.value
  if (!raw.trim()) {
    toast('Nothing to read yet.', 'error')
    return
  }
  engine.stop()
  setDocument(raw, 'Pasted text')
  closeOverlays()
}

function updateEditorStats() {
  const text = el.editorText.value.trim()
  const words = text ? (text.match(/\S+/g) || []).length : 0
  const minutes = words / 180
  el.editorStats.textContent = words
    ? `${words.toLocaleString()} words · about ${formatDuration(minutes * 60)} at 1×`
    : ''
}

/* ───────────────────────────────── controls ──────────────────────────────── */

function bindControls() {
  const openPicker = () => {
    fileDialogUntil = Date.now() + 3000
    el.fileInput.click()
  }
  el.btnOpen.addEventListener('click', openPicker)
  el.emptyOpen.addEventListener('click', openPicker)
  el.fileInput.addEventListener('change', () => {
    openFile(el.fileInput.files?.[0])
    el.fileInput.value = '' // let the same file be picked again
  })

  el.btnEditor.addEventListener('click', openEditor)
  el.emptyPaste.addEventListener('click', openEditor)
  el.editorApply.addEventListener('click', applyEditorText)
  el.editorClear.addEventListener('click', () => {
    el.editorText.value = ''
    updateEditorStats()
    el.editorText.focus()
  })
  el.editorText.addEventListener('input', updateEditorStats)

  el.emptySample.addEventListener('click', () => {
    setDocument(SAMPLE_TEXT, SAMPLE_TITLE, { unwrap: 'never' })
    el.editorText.value = SAMPLE_TEXT
    updateEditorStats()
  })

  el.btnSettings.addEventListener('click', () => {
    el.settingsOverlay.hidden = false
    el.settingsOverlay.querySelector('.sheet-close')?.focus()
  })

  for (const overlay of [el.editorOverlay, el.settingsOverlay]) {
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closeOverlays()
    })
    overlay.querySelector('[data-close]')?.addEventListener('click', closeOverlays)
  }

  el.btnPlay.addEventListener('click', userToggle)
  el.btnStop.addEventListener('click', () => engine.stop())
  el.btnPrev.addEventListener('click', () => engine.skipSentence(-1))
  el.btnNext.addEventListener('click', () => engine.skipSentence(1))

  el.rateSlider.addEventListener('input', () => {
    const rate = Number(el.rateSlider.value)
    el.rateValue.textContent = `${rate.toFixed(2)}×`
    settings.rate = rate
    engine.update({ rate })
    saveSettings(settings)
    updateProgress()
  })

  el.voiceSelect.addEventListener('change', () => {
    settings.voiceURI = el.voiceSelect.value
    engine.update({ voiceURI: settings.voiceURI })
    saveSettings(settings)
    previewVoice()
  })
  el.btnPreview.addEventListener('click', previewVoice)
  el.btnNoise.addEventListener('click', cycleNoise)
  el.checkpoint.addEventListener('click', () => checkpoints?.acknowledge())

  bindProgressBar()

  // Click any word to start reading from there.
  for (const surface of [el.content, el.pages]) {
    surface.addEventListener('click', (event) => {
      if (!current) return
      if (window.getSelection()?.toString()) return // the user is selecting, not seeking
      const offset = view.offsetAtPoint(event.clientX, event.clientY)
      if (offset < 0) return
      engine.play(offset)
    })
  }
  el.btnView.addEventListener('click', toggleView)

  // Manual scrolling pauses auto-scroll until the next explicit action.
  el.scroller.addEventListener('wheel', () => markUserScroll(), { passive: true })
  el.scroller.addEventListener('touchmove', () => markUserScroll(), { passive: true })
}

let userScrollUntil = 0
function markUserScroll() {
  if (!settings.autoScroll) return
  userScrollUntil = Date.now() + 4000
  view.autoScroll = false
}

function bindProgressBar() {
  const seekTo = (clientX) => {
    if (!current) return
    const rect = el.progress.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    rewindTo = -1
    engine.seek(Math.floor(ratio * current.text.length))
    view.autoScroll = settings.autoScroll
    view.highlight(engine.span, engine.sentenceIndex, { scroll: true, smooth: false })
  }

  el.progress.addEventListener('pointerdown', (event) => {
    if (!current) return
    scrubbing = true
    el.progress.setPointerCapture(event.pointerId)
    seekTo(event.clientX)
  })
  el.progress.addEventListener('pointermove', (event) => {
    if (scrubbing) seekTo(event.clientX)
  })
  const endScrub = (event) => {
    if (!scrubbing) return
    scrubbing = false
    try {
      el.progress.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
  }
  el.progress.addEventListener('pointerup', endScrub)
  el.progress.addEventListener('pointercancel', endScrub)

  el.progress.addEventListener('keydown', (event) => {
    if (!current) return
    const step = event.shiftKey ? 0.1 : 0.02
    if (event.key === 'ArrowRight') engine.seek(engine.charIndex + current.text.length * step)
    else if (event.key === 'ArrowLeft') engine.seek(engine.charIndex - current.text.length * step)
    else if (event.key === 'Home') engine.seek(0)
    else if (event.key === 'End') engine.seek(current.text.length - 1)
    else return
    event.preventDefault()
    view.highlight(engine.span, engine.sentenceIndex, { scroll: true, smooth: false })
  })
}

function openEditor() {
  if (current && !el.editorText.value) el.editorText.value = current.text
  el.editorOverlay.hidden = false
  updateEditorStats()
  el.editorText.focus()
}

function closeOverlays() {
  el.editorOverlay.hidden = true
  el.settingsOverlay.hidden = true
}

/* ───────────────────────────────── settings ──────────────────────────────── */

function bindSettings() {
  el.localOnly.checked = settings.localVoicesOnly
  el.localOnly.addEventListener('change', () => {
    settings.localVoicesOnly = el.localOnly.checked
    saveSettings(settings)
    populateVoices(engine.getVoices())
  })
  el.showAllVoices.checked = settings.showAllVoices
  el.showAllVoices.addEventListener('change', () => {
    settings.showAllVoices = el.showAllVoices.checked
    saveSettings(settings)
    populateVoices(engine.getVoices())
  })

  bindSegmented(el.noiseColour, 'noise', (value) => setNoise(value))
  bindSlider(el.noiseVolume, el.noiseVolumeValue, 'noiseVolume', (v) => `${Math.round(v * 100)}%`, (v) =>
    noise.setVolume(v)
  )
  bindSegmented(el.focusMode, 'focusMode', applyFocusMode)
  bindSegmented(el.checkpointMinutes, 'checkpointMinutes', setupCheckpoints)
  el.pauseWhenAway.checked = settings.pauseWhenAway
  el.pauseWhenAway.addEventListener('change', () => {
    settings.pauseWhenAway = el.pauseWhenAway.checked
    saveSettings(settings)
  })

  bindSlider(el.pitchSlider, el.pitchValue, 'pitch', (v) => v.toFixed(1), (v) => engine.update({ pitch: v }))
  bindSlider(el.volumeSlider, el.volumeValue, 'volume', (v) => `${Math.round(v * 100)}%`, (v) =>
    engine.update({ volume: v })
  )

  bindSegmented(el.highlightMode, 'highlightMode', (value) => view.setMode(value))
  bindSegmented(el.themeMode, 'theme', applyTheme)
  bindSegmented(el.fontFamily, 'fontFamily', applyTypography)

  bindSlider(el.fontSize, el.fontSizeValue, 'fontSize', (v) => `${v}px`, applyTypography)
  bindSlider(el.lineHeight, el.lineHeightValue, 'lineHeight', (v) => v.toFixed(2), applyTypography)
  bindSlider(el.columnWidth, el.columnWidthValue, 'columnWidth', (v) => `${v}ch`, applyTypography)

  el.autoScroll.checked = settings.autoScroll
  el.autoScroll.addEventListener('change', () => {
    settings.autoScroll = el.autoScroll.checked
    view.autoScroll = settings.autoScroll
    saveSettings(settings)
  })

  el.btnReset.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS)
    saveSettings(settings)
    syncSettingsUi()
    applyTheme()
    applyTypography()
    view.setMode(settings.highlightMode)
    view.autoScroll = settings.autoScroll
    engine.update({ rate: settings.rate, pitch: settings.pitch, volume: settings.volume })
    populateVoices(engine.getVoices())
    setNoise(settings.noise)
    noise.setVolume(settings.noiseVolume)
    applyFocusMode()
    setupCheckpoints()
    toast('Settings reset')
  })

  syncSettingsUi()
}

function bindSlider(input, output, key, format, onChange) {
  input.value = String(settings[key])
  output.textContent = format(Number(settings[key]))
  input.addEventListener('input', () => {
    const value = Number(input.value)
    settings[key] = value
    output.textContent = format(value)
    saveSettings(settings)
    onChange?.(value)
  })
}

function bindSegmented(container, key, onChange) {
  const buttons = [...container.querySelectorAll('button')]
  const sync = () => {
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(settings[key])))
  }
  for (const button of buttons) {
    button.addEventListener('click', () => {
      settings[key] = button.dataset.value
      saveSettings(settings)
      sync()
      onChange?.(settings[key])
    })
  }
  sync()
  container._sync = sync
}

function syncSettingsUi() {
  el.localOnly.checked = settings.localVoicesOnly
  el.showAllVoices.checked = settings.showAllVoices
  el.autoScroll.checked = settings.autoScroll
  el.pauseWhenAway.checked = settings.pauseWhenAway
  el.noiseVolume.value = String(settings.noiseVolume)
  el.noiseVolumeValue.textContent = `${Math.round(settings.noiseVolume * 100)}%`
  el.rateSlider.value = String(settings.rate)
  el.rateValue.textContent = `${Number(settings.rate).toFixed(2)}×`
  el.pitchSlider.value = String(settings.pitch)
  el.pitchValue.textContent = Number(settings.pitch).toFixed(1)
  el.volumeSlider.value = String(settings.volume)
  el.volumeValue.textContent = `${Math.round(settings.volume * 100)}%`
  el.fontSize.value = String(settings.fontSize)
  el.fontSizeValue.textContent = `${settings.fontSize}px`
  el.lineHeight.value = String(settings.lineHeight)
  el.lineHeightValue.textContent = Number(settings.lineHeight).toFixed(2)
  el.columnWidth.value = String(settings.columnWidth)
  el.columnWidthValue.textContent = `${settings.columnWidth}ch`
  for (const container of [el.highlightMode, el.themeMode, el.fontFamily, el.noiseColour, el.focusMode, el.checkpointMinutes]) {
    container._sync?.()
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme
}

function applyTypography() {
  const root = document.documentElement.style
  const families = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', mono: 'var(--font-mono)' }
  root.setProperty('--reader-font', families[settings.fontFamily] || families.serif)
  root.setProperty('--reader-size', `${settings.fontSize}px`)
  root.setProperty('--reader-leading', String(settings.lineHeight))
  root.setProperty('--reader-width', `${settings.columnWidth}ch`)
}

/* ────────────────────────────────── voices ───────────────────────────────── */

function populateVoices(voices) {
  const all = voices || []
  const usable = filterVoices(all, { localOnly: settings.localVoicesOnly, showAll: settings.showAllVoices })
  const sorted = sortVoices(usable, navigator.language || 'en-US')

  el.voiceSelect.textContent = ''
  const groups = new Map()
  for (const voice of sorted) {
    const key = voice.lang || 'other'
    if (!groups.has(key)) {
      const group = document.createElement('optgroup')
      group.label = describeLanguage(key)
      groups.set(key, group)
      el.voiceSelect.appendChild(group)
    }
    const option = document.createElement('option')
    option.value = voice.voiceURI
    const kind = classifyVoice(voice)
    const tag = !voice.localService ? ' (online)' : kind === 'eloquence' ? ' (robotic)' : kind === 'novelty' ? ' (novelty)' : ''
    option.textContent = voice.name + tag
    groups.get(key).appendChild(option)
  }

  // Keep the saved voice if it still exists; otherwise pick the best match.
  const wanted = sorted.find((v) => v.voiceURI === settings.voiceURI)
  const chosen = wanted || sorted.find((v) => v.default) || sorted[0]
  if (chosen) {
    el.voiceSelect.value = chosen.voiceURI
    if (chosen.voiceURI !== settings.voiceURI) {
      settings.voiceURI = chosen.voiceURI
      engine.update({ voiceURI: chosen.voiceURI })
      saveSettings(settings)
    }
  }

  const robotic = all.filter((v) => classifyVoice(v) !== 'natural').length
  const online = all.filter((v) => !v.localService).length
  const parts = [`${sorted.length} voice${sorted.length === 1 ? '' : 's'} listed.`]
  if (!settings.showAllVoices && robotic) {
    parts.push(`${robotic} robotic and novelty voices are hidden: they were built for screen readers and for fun, not for listening to a book.`)
  }
  if (settings.localVoicesOnly && online) parts.push(`${online} online voice${online === 1 ? '' : 's'} hidden.`)
  parts.push(
    'For noticeably better voices, download the Enhanced or Premium versions in System Settings › Accessibility › Spoken Content › System Voice › Manage Voices, then restart the browser. Safari also offers the Siri voices; Chrome does not.'
  )
  el.voiceHint.textContent = all.length ? parts.join(' ') : 'No voices reported by this browser.'
  el.voiceSelect.disabled = !sorted.length
}

/** Say one sentence in the chosen voice, without touching the reading position. */
function previewVoice() {
  if (!isSpeechSupported()) return
  const voice = engine.getVoices().find((v) => v.voiceURI === settings.voiceURI)
  if (!voice) return
  if (engine.state === 'playing') engine.pause()
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(PREVIEW_SENTENCE)
  utterance.voice = voice
  utterance.lang = voice.lang || ''
  utterance.rate = settings.rate
  utterance.pitch = settings.pitch
  utterance.volume = settings.volume
  window.speechSynthesis.speak(utterance)
}

/* ─────────────────────────────── focus tools ─────────────────────────────── */

function setNoise(colour) {
  settings.noise = NOISE_COLOURS.includes(colour) ? colour : 'off'
  saveSettings(settings)
  noise.setVolume(settings.noiseVolume)
  noise.setColour(settings.noise)
  el.noiseColour._sync?.()
  updateNoiseButton()
}

function cycleNoise() {
  const next = NOISE_COLOURS[(NOISE_COLOURS.indexOf(settings.noise) + 1) % NOISE_COLOURS.length]
  setNoise(next)
  toast(next === 'off' ? 'Background noise off' : `${next[0].toUpperCase()}${next.slice(1)} noise`, 'info', 1200)
}

function updateNoiseButton() {
  el.btnNoise.dataset.colour = settings.noise
  el.btnNoise.setAttribute('aria-pressed', String(settings.noise !== 'off'))
  el.btnNoise.title = settings.noise === 'off' ? 'Background noise (N)' : `${settings.noise} noise on (N to change)`
}

function applyFocusMode() {
  reader.setFocusMode(settings.focusMode)
  pageView.setFocusMode(settings.focusMode)
}

function cycleFocusMode() {
  const modes = ['off', 'sentence', 'paragraph']
  settings.focusMode = modes[(modes.indexOf(settings.focusMode) + 1) % modes.length]
  saveSettings(settings)
  el.focusMode._sync?.()
  applyFocusMode()
  toast({ off: 'Dimming off', sentence: 'Dim all but the sentence', paragraph: 'Dim all but the paragraph' }[settings.focusMode], 'info', 1200)
}

/** Play/pause from the user, honouring a pending rewind from a missed check-in. */
function userToggle() {
  if (engine.state !== 'playing' && rewindTo >= 0 && current) {
    const target = rewindTo
    rewindTo = -1
    engine.stop()
    engine.play(target)
    return
  }
  engine.toggle()
}

/** Pause and remember the start of the current sentence for the next play. */
function pauseAndRewind(reason) {
  if (engine.state !== 'playing' || !current) return
  const sentence = engine.sentenceIndex >= 0 ? current.model.sentences[engine.sentenceIndex] : null
  const target = sentence ? sentence.start : engine.charIndex
  engine.pause()
  rewindTo = target // set after pause(): the state handler clears it on 'playing' only
  toast(reason, 'info', 5000)
}

function setupCheckpoints() {
  checkpoints?.stop()
  clearInterval(checkpointTimer)
  el.checkpoint.hidden = true
  const minutes = Number(settings.checkpointMinutes) || 0
  if (!minutes) {
    checkpoints = null
    return
  }
  checkpoints = new Checkpoints({
    intervalMs: minutes * 60_000,
    graceMs: 12_000,
    onPrompt: () => {
      el.checkpoint.hidden = false
      el.checkpoint.style.setProperty('--remaining', '1')
    },
    onClear: () => {
      el.checkpoint.hidden = true
    },
    onMissed: () => pauseAndRewind('Paused: you seemed to drift. Play resumes from the start of the sentence.'),
  })
  if (engine.state === 'playing') checkpoints.start()
  checkpointTimer = setInterval(() => {
    if (!checkpoints || engine.state !== 'playing') return
    checkpoints.tick()
    if (checkpoints.state === 'prompting') {
      el.checkpoint.style.setProperty('--remaining', String(checkpoints.remaining() / 12_000))
    }
  }, 250)
}

/** Reading to an empty room is the failure to avoid: pause when the user leaves. */
function bindAwayGuard() {
  const away = () => {
    if (!settings.pauseWhenAway || engine.state !== 'playing') return
    if (Date.now() < fileDialogUntil) return // our own file picker took focus
    if (!el.editorOverlay.hidden || !el.settingsOverlay.hidden) return
    pauseAndRewind('Paused while you were away. Play picks up from the start of the sentence.')
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) away()
  })
  window.addEventListener('blur', () => setTimeout(away, 150))
}

function describeLanguage(tag) {
  try {
    const display = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' })
    return `${display.of(tag.replace('_', '-')) || tag} — ${tag}`
  } catch {
    return tag
  }
}

/* ────────────────────────────── engine wiring ────────────────────────────── */

function bindEngine() {
  engine.on('voices', populateVoices)
  populateVoices(engine.getVoices())

  engine.on('state', ({ state }) => {
    el.app.dataset.state = state
    el.btnPlay.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play')
    setStatus(
      { playing: 'Reading aloud', paused: 'Paused', idle: current ? 'Ready' : 'No document' }[state]
    )
    if (state === 'playing') {
      view.autoScroll = settings.autoScroll
      userScrollUntil = 0
      rewindTo = -1
      checkpoints?.start()
    } else {
      checkpoints?.stop()
    }
    if (state !== 'playing') persistPosition()
  })

  engine.on('position', (position) => {
    pendingPosition = position
    if (paintQueued) return
    paintQueued = true
    requestAnimationFrame(paint)
  })

  engine.on('end', () => {
    setStatus('Finished')
    view.clearHighlight()
    persistPosition()
  })

  engine.on('error', ({ error }) => {
    // Browsers refuse to speak until the page has seen a real click or key press.
    const friendly = {
      'not-allowed': 'Press play once to let this browser start speaking.',
      stalled: 'Playback stalled and could not recover.',
      'synthesis-unavailable': 'That voice is unavailable. Try another one.',
      'voice-unavailable': 'That voice is unavailable. Try another one.',
      'language-unavailable': 'That voice cannot read this language. Try another one.',
    }[error]
    setStatus(friendly || `Speech error: ${error}`)
    if (friendly) toast(friendly, 'error', 5000)
  })
}

/** One paint per frame, no matter how fast boundary events arrive. */
function paint() {
  paintQueued = false
  const position = pendingPosition
  if (!position || !current) return

  // Resume auto-scroll a few seconds after the user last scrolled by hand.
  if (settings.autoScroll && !view.autoScroll && Date.now() > userScrollUntil) {
    view.autoScroll = true
  }

  view.highlight(position.span, position.sentenceIndex, {
    scroll: engine.state === 'playing',
    smooth: settings.rate <= 2,
  })
  updateProgress()
  throttledPersist()
}

function updateProgress() {
  const ratio = engine.progress
  el.progressFill.style.width = `${(ratio * 100).toFixed(2)}%`
  el.progressKnob.style.left = `${(ratio * 100).toFixed(2)}%`
  el.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  el.timeLabel.textContent = current ? formatDuration(engine.estimateRemaining()) + ' left' : '--:--'
}

function setStatus(text) {
  el.statusLabel.textContent = text || ''
}

let persistTimer = 0
function throttledPersist() {
  const now = Date.now()
  if (now - persistTimer < 5000) return
  persistTimer = now
  persistPosition()
}

function persistPosition() {
  if (!current) return
  saveDocument({ text: current.text, title: current.title, charIndex: engine.charIndex })
}

/* ──────────────────────────────── keyboard ───────────────────────────────── */

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

    // Cmd/Ctrl+Enter applies the pasted text without reaching for the mouse.
    if (typing) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && target === el.editorText) {
        event.preventDefault()
        applyEditorText()
      }
      if (event.key === 'Escape') closeOverlays()
      return
    }

    const overlayOpen = !el.editorOverlay.hidden || !el.settingsOverlay.hidden

    switch (event.key) {
      case ' ':
        event.preventDefault()
        if (current) userToggle()
        break
      case 'Enter':
        if (checkpoints?.acknowledge()) event.preventDefault()
        break
      case 'n':
      case 'N':
        cycleNoise()
        break
      case 'f':
      case 'F':
        cycleFocusMode()
        break
      case 'Escape':
        if (overlayOpen) closeOverlays()
        else engine.stop()
        break
      case 'ArrowLeft':
        event.preventDefault()
        engine.skipSentence(-1)
        break
      case 'ArrowRight':
        event.preventDefault()
        engine.skipSentence(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        nudgeRate(0.05)
        break
      case 'ArrowDown':
        event.preventDefault()
        nudgeRate(-0.05)
        break
      case 'o':
      case 'O':
        fileDialogUntil = Date.now() + 3000
        el.fileInput.click()
        break
      case 'e':
      case 'E':
        openEditor()
        break
      case 's':
      case 'S':
        el.settingsOverlay.hidden = !el.settingsOverlay.hidden
        break
      case 'v':
      case 'V':
        toggleView()
        break
      default:
        break
    }
  })
}

function nudgeRate(delta) {
  const rate = Math.min(3, Math.max(0.5, Number(settings.rate) + delta))
  settings.rate = Number(rate.toFixed(2))
  el.rateSlider.value = String(settings.rate)
  el.rateValue.textContent = `${settings.rate.toFixed(2)}×`
  engine.update({ rate: settings.rate })
  saveSettings(settings)
  toast(`Speed ${settings.rate.toFixed(2)}×`, 'info', 900)
}

/* ────────────────────────────── drag and drop ────────────────────────────── */

function bindDragAndDrop() {
  let depth = 0
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    depth++
    el.drop.hidden = false
  })
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
  })
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0
      el.drop.hidden = true
    }
  })
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    depth = 0
    el.drop.hidden = true
    openFile(event.dataTransfer.files[0])
  })
}

/* ──────────────────────────── small UI helpers ───────────────────────────── */

function showBusy(label) {
  el.busyLabel.textContent = label
  el.busy.hidden = false
}

function hideBusy() {
  el.busy.hidden = true
}

function toast(message, kind = 'info', duration = 3000) {
  el.toast.textContent = message
  el.toast.dataset.kind = kind
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.hidden = true
  }, duration)
}

/** Seconds -> "4:07" or "1:02:30". */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// Safari and Chrome keep speaking after the page goes away unless we cancel.
window.addEventListener('beforeunload', () => {
  persistPosition()
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
})

boot()

/**
 * Debug handle. This is a local, offline tool, so the internals are left reachable
 * from the console: `echoReader.engine.play(0)`, `echoReader.document.model`, etc.
 */
window.echoReader = {
  engine,
  reader,
  pageView,
  noise,
  get checkpoints() {
    return checkpoints
  },
  get view() {
    return view
  },
  settings,
  get document() {
    return current
  },
}
